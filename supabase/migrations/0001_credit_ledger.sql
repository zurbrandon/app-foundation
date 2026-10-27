-- App Foundation — credit ledger
--
-- Design rules, in order of importance:
--
--   1. The ledger is append-only. `credit_entries` is never updated or deleted;
--      a correction is a new compensating entry. The entry history is the
--      audit trail, and `credit_balances` is a cache of it that must always
--      reconcile.
--
--   2. Clients never write. Every mutation goes through a SECURITY DEFINER
--      function in the `foundation` schema, and those are executable only by
--      `service_role` — i.e. only from an Edge Function, never from an app.
--      Tables live in `public` with select-own RLS so a client can *read* its
--      own balance.
--
--   3. The database refuses to go wrong. A non-negative CHECK on balances is
--      the real defence against double-spend: even with a logic bug, the
--      transaction aborts rather than handing out credits that don't exist.
--
--   4. Every mutation is idempotent. A duplicate webhook or a retried request
--      carrying the same key is absorbed, not double-applied.
--
-- Credits are integers. No floats anywhere near a balance.

create schema if not exists foundation;

-- Bucket matters because free and purchased credits have different rules:
-- purchased credits never expire and are refundable; free ones are neither.
-- Spending always draws free first so the user's paid balance lasts.
create type foundation.credit_bucket as enum ('free', 'paid');

create type foundation.credit_kind as enum (
  'purchase',    -- verified payment (RevenueCat / Stripe)
  'grant',       -- free allowance, promo, goodwill
  'spend',       -- consumed by an operation
  'refund',      -- payment reversed or chargeback
  'release',     -- unused part of a reservation returned
  'adjustment'   -- manual correction, always with a reason
);

create type foundation.reservation_status as enum ('open', 'settled', 'released', 'expired');


-- ---------------------------------------------------------------------------
-- Balances: a cache of sum(credit_entries), maintained under a row lock.
-- ---------------------------------------------------------------------------
create table public.credit_balances (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  free       bigint not null default 0,
  paid       bigint not null default 0,
  updated_at timestamptz not null default now(),

  -- The backstop. Nothing may drive a balance below zero, whatever the caller
  -- believes it is doing.
  constraint credit_balances_non_negative check (free >= 0 and paid >= 0)
);

comment on table public.credit_balances is
  'Materialised balance per user. Always reconcilable against credit_entries.';


-- ---------------------------------------------------------------------------
-- Entries: the append-only ledger.
-- ---------------------------------------------------------------------------
create table public.credit_entries (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Positive adds, negative spends. Never zero.
  delta           bigint not null check (delta <> 0),
  kind            foundation.credit_kind not null,
  bucket          foundation.credit_bucket not null,
  reason          text,
  -- Where this came from: 'revenuecat', 'stripe', 'ai_usage', 'admin', ...
  ref_type        text,
  ref_id          text,
  idempotency_key text not null,
  created_at      timestamptz not null default now()
);

-- A single logical operation may touch both buckets (spending the last of the
-- free balance and dipping into paid), producing two entries that share a key.
-- Uniqueness is therefore per (key, bucket), which still makes a replayed
-- webhook or retried request a no-op.
create unique index credit_entries_idempotency_idx
  on public.credit_entries (idempotency_key, bucket);

create index credit_entries_user_idx on public.credit_entries (user_id, created_at desc);
create index credit_entries_ref_idx  on public.credit_entries (ref_type, ref_id);


-- ---------------------------------------------------------------------------
-- Reservations: hold credits for an operation whose true cost isn't known yet.
--
-- Credits are deducted at reserve time, not at settle time. That keeps the
-- balance honest at every instant — "available" is just the balance, with no
-- separate held-amount to subtract — and keeps the non-negative CHECK
-- meaningful. Settling refunds the unused remainder.
--
-- The bucket split is recorded so a release returns credits to the buckets
-- they came from, rather than quietly converting free credits into paid ones.
-- ---------------------------------------------------------------------------
create table public.credit_reservations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  amount          bigint not null check (amount > 0),
  from_free       bigint not null check (from_free >= 0),
  from_paid       bigint not null check (from_paid >= 0),
  status          foundation.reservation_status not null default 'open',
  operation       text not null,
  idempotency_key text not null unique,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  settled_at      timestamptz,
  settled_amount  bigint,

  constraint reservation_split_matches check (from_free + from_paid = amount)
);

create index credit_reservations_open_idx
  on public.credit_reservations (status, expires_at)
  where status = 'open';


-- ---------------------------------------------------------------------------
-- RLS: read your own rows, write nothing.
--
-- No INSERT/UPDATE/DELETE policy exists for any role, so writes are impossible
-- through the API regardless of what a client sends. `service_role` bypasses
-- RLS entirely, which is how the Edge Functions write.
-- ---------------------------------------------------------------------------
alter table public.credit_balances     enable row level security;
alter table public.credit_entries      enable row level security;
alter table public.credit_reservations enable row level security;

create policy "read own balance" on public.credit_balances
  for select to authenticated using (auth.uid() = user_id);

create policy "read own entries" on public.credit_entries
  for select to authenticated using (auth.uid() = user_id);

create policy "read own reservations" on public.credit_reservations
  for select to authenticated using (auth.uid() = user_id);

-- Defence in depth. Supabase's default privileges hand `anon` and
-- `authenticated` full write access to every table in `public`, leaving RLS as
-- the only thing between a client and its own balance. RLS does hold — but it
-- fails *silently* for UPDATE and DELETE (zero rows matched, no error), and one
-- over-permissive policy added later would be enough to open a write path.
--
-- Taking the grants away means there is nothing to exercise even if a policy is
-- misconfigured, and misuse fails loudly instead of looking like it worked.
revoke insert, update, delete, truncate on public.credit_balances     from anon, authenticated;
revoke insert, update, delete, truncate on public.credit_entries      from anon, authenticated;
revoke insert, update, delete, truncate on public.credit_reservations from anon, authenticated;
