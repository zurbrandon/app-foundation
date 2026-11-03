-- Turning a verified payment into credits.
--
-- The ledger has always been shaped to receive this: a separate `paid` bucket
-- with its own rules, `purchase` and `refund` entry kinds, and idempotency on
-- every mutation. What was missing is the thing that says "this person paid".
--
-- Deliberately provider-agnostic. familiar on iOS must use Apple IAP for
-- digital credits; Understory on macOS outside the Mac App Store would use
-- Stripe. Both end up here, and nothing below knows or cares which.

-- What a product is worth, in credits.
--
-- Same reasoning as foundation.ai_operations: the app names a product, never
-- an amount. Repricing is an UPDATE and takes effect for the next purchase, no
-- release required — and a client cannot ask to be given more than it bought.
create table foundation.products (
  product_id  text primary key,
  credits     bigint not null check (credits > 0),
  description text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

/**
 * Every payment event we were told about, including the ones we refused.
 *
 * The ledger records what happened to someone's balance. This records what the
 * provider claimed, which is a different question and the one that matters in
 * a dispute. It also captures events that produced no ledger entry at all — an
 * unknown product, a user who no longer exists — which would otherwise vanish
 * silently.
 */
create table foundation.purchase_events (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  -- The provider's own id for this event. Unique per provider, and what makes
  -- a retried webhook a no-op: providers retry on any non-2xx, and some retry
  -- on success too.
  event_id    text not null,
  event_type  text not null,
  -- Deliberately no foreign key. This records what the provider claimed, and
  -- a claim about a user who does not exist is exactly the kind of event
  -- worth keeping. A constraint here would reject the insert before the check
  -- that diagnoses it could run.
  user_id     uuid,
  product_id  text,
  credits     bigint not null default 0,
  status      text not null,
  -- Set when a refund could not take back everything it gave, because the
  -- credits were already spent. Worth knowing: buy, spend, refund, repeat is
  -- what fraud looks like.
  shortfall   bigint not null default 0,
  note        text,
  payload     jsonb,
  received_at timestamptz not null default now(),

  constraint purchase_events_unique_per_provider unique (provider, event_id)
);

create index purchase_events_user_idx on foundation.purchase_events (user_id, received_at desc);

alter table foundation.products enable row level security;
alter table foundation.purchase_events enable row level security;

/**
 * Take credits away.
 *
 * The mirror of grant_credits, and separate from it on purpose: that function
 * refuses a non-positive amount, which is a good rule for grants and makes a
 * refund impossible to express. A debit says how much to remove and is checked
 * the same way — idempotent, locked, and still subject to the non-negative
 * constraint on the balance, so a caller that miscalculates gets an error
 * rather than a negative balance.
 */
create or replace function foundation.debit_credits(
  p_user            uuid,
  p_amount          bigint,
  p_bucket          foundation.credit_bucket,
  p_kind            foundation.credit_kind,
  p_idempotency_key text,
  p_reason          text default null,
  p_ref_type        text default null,
  p_ref_id          text default null
)
returns public.credit_balances
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_balance public.credit_balances;
begin
  if p_amount <= 0 then
    raise exception 'debit amount must be positive, got %', p_amount using errcode = 'PT400';
  end if;

  v_balance := foundation.lock_balance(p_user);

  if exists (
    select 1 from public.credit_entries
     where idempotency_key = p_idempotency_key and bucket = p_bucket
  ) then
    return v_balance;
  end if;

  insert into public.credit_entries
    (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
  values
    (p_user, -p_amount, p_kind, p_bucket, p_reason, p_ref_type, p_ref_id, p_idempotency_key);

  update public.credit_balances
     set free       = free - case when p_bucket = 'free' then p_amount else 0 end,
         paid       = paid - case when p_bucket = 'paid' then p_amount else 0 end,
         updated_at = now()
   where user_id = p_user
  returning * into v_balance;

  return v_balance;
end;
$$;

/**
 * Mark a claimed event as refused, and say so.
 *
 * Refusals return rather than raise. An exception would roll back the very row
 * that records the refusal, so the table's whole purpose — keeping the events
 * we did not act on — would quietly not work. It also lets the webhook answer
 * 200 for "this will never succeed, stop retrying", which is the correct reply
 * to an unknown product.
 */
create or replace function foundation.reject_event(
  p_provider text,
  p_event_id text,
  p_note     text
)
returns jsonb
language plpgsql
security definer
set search_path = foundation, pg_temp
as $$
begin
  update foundation.purchase_events
     set status = 'rejected', note = p_note
   where provider = p_provider and event_id = p_event_id;

  return jsonb_build_object('applied', false, 'status', 'rejected',
                            'credits', 0, 'note', p_note);
end;
$$;

/**
 * Credit a verified purchase.
 *
 * Idempotent twice over: once on (provider, event_id) here, and again on the
 * idempotency key handed to grant_credits. Either alone would do; both means a
 * replay cannot slip through a gap between the two inserts.
 *
 * Returns a verdict: `applied` says whether this call is what moved the
 * balance, `status` distinguishes credited from duplicate from rejected.
 * Callers answer the provider 200 for all three — a retry is not an error, and
 * an unknown product will not become known by retrying.
 */
create or replace function foundation.record_purchase(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_user       uuid,
  p_product_id text,
  p_payload    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = foundation, public, auth, pg_temp
as $$
declare
  v_credits bigint;
  v_enabled boolean;
  v_anon    boolean;
begin
  if p_provider is null or p_event_id is null then
    raise exception 'provider and event_id are required' using errcode = 'PT400';
  end if;

  -- Claim the event first. Losing the race means somebody else already did
  -- this work, which is the answer we want, not an error.
  begin
    insert into foundation.purchase_events (provider, event_id, event_type, user_id,
                                            product_id, status, payload)
    values (p_provider, p_event_id, p_event_type, p_user, p_product_id, 'processing', p_payload);
  exception when unique_violation then
    -- Already handled. Report what happened the first time rather than
    -- pretending this delivery did the work.
    return (select jsonb_build_object('applied', false, 'status', 'duplicate',
                                      'credits', credits, 'note', note)
              from foundation.purchase_events
             where provider = p_provider and event_id = p_event_id);
  end;

  select credits, enabled into v_credits, v_enabled
    from foundation.products where product_id = p_product_id;

  if v_credits is null then
    return foundation.reject_event(p_provider, p_event_id,
             'unknown product: ' || coalesce(p_product_id, '(null)'));
  end if;

  if not v_enabled then
    return foundation.reject_event(p_provider, p_event_id, 'product is disabled');
  end if;

  if p_user is null or not exists (select 1 from auth.users where id = p_user) then
    return foundation.reject_event(p_provider, p_event_id, 'unknown user');
  end if;

  -- Credit them regardless, and flag it. By the time a webhook arrives the
  -- money has already changed hands, so refusing would mean taking payment and
  -- giving nothing — worse than the problem. The real guard is the app not
  -- offering a purchase to an anonymous account in the first place, because
  -- those credits leave with the install.
  select is_anonymous into v_anon from auth.users where id = p_user;

  perform foundation.grant_credits(
    p_user, v_credits, 'paid'::foundation.credit_bucket, 'purchase'::foundation.credit_kind,
    p_provider || ':' || p_event_id, 'purchase: ' || p_product_id, p_provider, p_event_id
  );

  update foundation.purchase_events
     set status = 'credited',
         credits = v_credits,
         note = case when v_anon then 'credited an anonymous account — unrecoverable on reinstall'
                     else null end
   where provider = p_provider and event_id = p_event_id;

  return jsonb_build_object('applied', true, 'status', 'credited',
                            'credits', v_credits, 'anonymous', v_anon);
end;
$$;

/**
 * Take credits back after a refund or chargeback.
 *
 * Clamped at zero rather than allowed to go negative. The non-negative check
 * on credit_balances is the real defence against double-spend, and weakening
 * it so refunds can run would trade a guarantee for a corner case. If the
 * credits are already spent they are gone — the shortfall is recorded instead,
 * because repeated buy-spend-refund is a pattern worth being able to see.
 */
create or replace function foundation.record_refund(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_user       uuid,
  p_product_id text,
  p_payload    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = foundation, public, auth, pg_temp
as $$
declare
  v_owed      bigint;
  v_available bigint;
  v_clawback  bigint;
begin
  begin
    insert into foundation.purchase_events (provider, event_id, event_type, user_id,
                                            product_id, status, payload)
    values (p_provider, p_event_id, p_event_type, p_user, p_product_id, 'processing', p_payload);
  exception when unique_violation then
    return (select jsonb_build_object('applied', false, 'status', 'duplicate',
                                      'credits', credits, 'note', note)
              from foundation.purchase_events
             where provider = p_provider and event_id = p_event_id);
  end;

  select credits into v_owed from foundation.products where product_id = p_product_id;

  if v_owed is null or p_user is null then
    return foundation.reject_event(p_provider, p_event_id, 'unknown product or user');
  end if;

  -- Lock the row so a concurrent spend cannot slip between reading the
  -- balance and writing the reversal.
  v_available := coalesce((foundation.lock_balance(p_user)).paid, 0);
  v_clawback := least(v_owed, v_available);

  if v_clawback > 0 then
    perform foundation.debit_credits(
      p_user, v_clawback, 'paid'::foundation.credit_bucket, 'refund'::foundation.credit_kind,
      p_provider || ':' || p_event_id, 'refund: ' || p_product_id, p_provider, p_event_id
    );
  end if;

  update foundation.purchase_events
     set status = case when v_clawback = v_owed then 'reversed' else 'reversed_partial' end,
         credits = -v_clawback,
         shortfall = v_owed - v_clawback,
         note = case when v_clawback < v_owed
                     then (v_owed - v_clawback)::text || ' credits were already spent'
                     else null end
   where provider = p_provider and event_id = p_event_id;

  return jsonb_build_object('applied', true,
                            'status', case when v_clawback = v_owed then 'reversed'
                                           else 'reversed_partial' end,
                            'credits', -v_clawback,
                            'shortfall', v_owed - v_clawback);
end;
$$;

revoke all on foundation.products from public, anon, authenticated;
revoke all on foundation.purchase_events from public, anon, authenticated;
revoke all on function foundation.debit_credits(uuid, bigint, foundation.credit_bucket,
  foundation.credit_kind, text, text, text, text) from public, anon, authenticated;
grant execute on function foundation.debit_credits(uuid, bigint, foundation.credit_bucket,
  foundation.credit_kind, text, text, text, text) to service_role;

revoke all on function foundation.reject_event(text, text, text) from public, anon, authenticated;

revoke all on function foundation.record_purchase(text, text, text, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function foundation.record_refund(text, text, text, uuid, text, jsonb)
  from public, anon, authenticated;

grant execute on function foundation.record_purchase(text, text, text, uuid, text, jsonb) to service_role;
grant execute on function foundation.record_refund(text, text, text, uuid, text, jsonb) to service_role;
grant select on foundation.products to service_role;
grant select on foundation.purchase_events to service_role;
