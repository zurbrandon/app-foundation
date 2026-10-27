-- App Foundation — AI gateway: operation registry, usage log, pricing.
--
-- The contract with an app is: the client sends an *operation name* and never
-- a provider or model. Everything about how that operation is served —
-- provider, model, what it costs, how it's charged — lives here, so swapping
-- a model is an UPDATE, not an app release going through review.
--
-- Nothing in this file is reachable from a client. The whole schema is
-- service_role only; the gateway Edge Function is the only caller.

-- ---------------------------------------------------------------------------
-- Per-app settings. One row per key keeps config in the database (where the
-- gateway already is) rather than spread across environment variables.
-- ---------------------------------------------------------------------------
create table foundation.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- How many credits one dollar of provider spend is worth. Used only for
-- metered operations, where the true cost isn't known until the call returns.
--
-- 1000 means a credit is a tenth of a cent of provider spend. With garment
-- tagging at roughly $0.0015, that lands near "1 credit ≈ 1 cheap operation",
-- which is the mental model a user can actually hold.
insert into foundation.settings (key, value)
values ('credits_per_usd', '1000'::jsonb);


-- ---------------------------------------------------------------------------
-- Operation registry.
-- ---------------------------------------------------------------------------
create type foundation.charge_mode as enum (
  'flat',    -- predictable cost: charge a fixed number of credits on success
  'metered'  -- unpredictable cost: reserve an estimate, settle on actual usage
);

create table foundation.ai_operations (
  -- Namespaced by app, e.g. 'wearwell.tag_garment', 'understory.write_chapter'.
  operation            text primary key,
  provider             text not null,
  model                text not null,
  charge_mode          foundation.charge_mode not null,

  -- Flat mode: what the user is charged, regardless of actual tokens. Keeps
  -- similar operations costing the same, which is what makes a balance
  -- predictable instead of a taxi meter.
  credits_flat         bigint,

  -- Metered mode: held up front, refunded down to actual on settle.
  credits_estimate     bigint,

  -- Provider list price, used to compute real cost for margin reporting.
  input_usd_per_mtok        numeric(12,6) not null,
  output_usd_per_mtok       numeric(12,6) not null,
  cached_input_usd_per_mtok numeric(12,6),

  max_output_tokens    integer not null default 1024,
  -- Free-form knobs passed to the provider adapter (effort, temperature, ...).
  params               jsonb not null default '{}'::jsonb,
  enabled              boolean not null default true,
  updated_at           timestamptz not null default now(),

  constraint flat_needs_credits check (
    charge_mode <> 'flat' or (credits_flat is not null and credits_flat > 0)
  ),
  constraint metered_needs_estimate check (
    charge_mode <> 'metered' or (credits_estimate is not null and credits_estimate > 0)
  )
);

comment on table foundation.ai_operations is
  'Operation -> provider/model/pricing. Changing a model is an UPDATE here.';


-- ---------------------------------------------------------------------------
-- Usage log.
--
-- Deliberately records no prompt or response text. The questions this needs to
-- answer are "what did it cost, did it work, how slow was it" — none of which
-- require keeping what the user wrote or photographed.
-- ---------------------------------------------------------------------------
create table foundation.ai_usage (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users (id) on delete set null,
  operation           text not null,
  provider            text not null,
  model               text not null,

  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cached_input_tokens integer not null default 0,

  -- What the provider actually charged us.
  cost_usd            numeric(12,6) not null default 0,
  -- What the user was charged.
  credits_charged     bigint not null default 0,

  latency_ms          integer,
  -- 'ok' | 'provider_error' | 'insufficient_credits' | 'invalid_request' | 'timeout'
  status              text not null,
  error_code          text,
  reservation_id      uuid references public.credit_reservations (id) on delete set null,
  -- Client-supplied, so a retried request is traceable to its first attempt.
  request_id          text,
  created_at          timestamptz not null default now()
);

create index ai_usage_user_idx      on foundation.ai_usage (user_id, created_at desc);
create index ai_usage_operation_idx on foundation.ai_usage (operation, created_at desc);
create index ai_usage_status_idx    on foundation.ai_usage (status, created_at desc)
  where status <> 'ok';


-- ---------------------------------------------------------------------------
-- Pricing helpers.
-- ---------------------------------------------------------------------------

-- Provider cost for a call, from token counts and the operation's list price.
create or replace function foundation.compute_cost_usd(
  p_operation            text,
  p_input_tokens         integer,
  p_output_tokens        integer,
  p_cached_input_tokens  integer default 0
)
returns numeric
language plpgsql
stable
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_op foundation.ai_operations;
begin
  select * into v_op from foundation.ai_operations where operation = p_operation;
  if not found then
    raise exception 'unknown operation %', p_operation using errcode = 'PT404';
  end if;

  return
      (greatest(p_input_tokens - coalesce(p_cached_input_tokens, 0), 0)::numeric / 1000000)
        * v_op.input_usd_per_mtok
    + (coalesce(p_cached_input_tokens, 0)::numeric / 1000000)
        * coalesce(v_op.cached_input_usd_per_mtok, v_op.input_usd_per_mtok)
    + (p_output_tokens::numeric / 1000000)
        * v_op.output_usd_per_mtok;
end;
$$;

-- Dollars -> credits. Rounds up, and never returns zero for a call that cost
-- something: a thousand free operations is a bill, not a rounding error.
create or replace function foundation.usd_to_credits(p_usd numeric)
returns bigint
language plpgsql
stable
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_rate numeric;
begin
  if p_usd is null or p_usd <= 0 then
    return 0;
  end if;

  select (value #>> '{}')::numeric into v_rate
    from foundation.settings where key = 'credits_per_usd';

  return greatest(1, ceil(p_usd * coalesce(v_rate, 1000))::bigint);
end;
$$;

-- What the gateway resolves before doing anything else. Raises rather than
-- returning null so a disabled or unknown operation can't silently fall
-- through to a default model.
create or replace function foundation.resolve_operation(p_operation text)
returns foundation.ai_operations
language plpgsql
stable
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_op foundation.ai_operations;
begin
  select * into v_op from foundation.ai_operations where operation = p_operation;

  if not found then
    raise exception 'unknown operation %', p_operation using errcode = 'PT404';
  end if;

  if not v_op.enabled then
    raise exception 'operation % is disabled', p_operation using errcode = 'PT403';
  end if;

  return v_op;
end;
$$;

-- Single place the gateway writes a usage row, so the column set can change
-- without touching the function.
create or replace function foundation.record_usage(
  p_user_id        uuid,
  p_operation      text,
  p_provider       text,
  p_model          text,
  p_status         text,
  p_input_tokens   integer default 0,
  p_output_tokens  integer default 0,
  p_cached_tokens  integer default 0,
  p_cost_usd       numeric default 0,
  p_credits        bigint default 0,
  p_latency_ms     integer default null,
  p_error_code     text default null,
  p_reservation_id uuid default null,
  p_request_id     text default null
)
returns uuid
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into foundation.ai_usage (
    user_id, operation, provider, model, status,
    input_tokens, output_tokens, cached_input_tokens,
    cost_usd, credits_charged, latency_ms, error_code, reservation_id, request_id
  ) values (
    p_user_id, p_operation, p_provider, p_model, p_status,
    coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_cached_tokens, 0),
    coalesce(p_cost_usd, 0), coalesce(p_credits, 0), p_latency_ms, p_error_code,
    p_reservation_id, p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;


-- Same boundary as the ledger: service_role only.
revoke all on all tables in schema foundation from public, anon, authenticated;
revoke all on all functions in schema foundation from public, anon, authenticated;
grant all on all tables in schema foundation to service_role;
grant execute on all functions in schema foundation to service_role;

alter default privileges in schema foundation
  revoke all on tables from public, anon, authenticated;
