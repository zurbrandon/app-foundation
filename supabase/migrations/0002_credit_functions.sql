-- App Foundation — credit mutations.
--
-- Every function here is SECURITY DEFINER with a pinned search_path, and
-- executable only by `service_role`. An app client calling these directly gets
-- a permission error; all credit movement happens in an Edge Function.
--
-- `insufficient_credits` is raised as SQLSTATE 'PT402' so a caller can
-- distinguish "they can't afford it" (a normal, expected outcome worth showing
-- in the UI) from a genuine fault.

-- Internal: lock the caller's balance row, creating it on first touch.
-- Every mutation goes through this, so concurrent requests for one user
-- serialise on that row and cannot interleave a read with a write.
create or replace function foundation.lock_balance(p_user uuid)
returns public.credit_balances
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_balance public.credit_balances;
begin
  insert into public.credit_balances (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select * into v_balance
    from public.credit_balances
   where user_id = p_user
     for update;

  return v_balance;
end;
$$;


-- ---------------------------------------------------------------------------
-- grant_credits — a purchase, a free allowance, a promo, a goodwill top-up.
--
-- Idempotent on p_idempotency_key: a RevenueCat webhook delivered three times
-- grants once. Returns the balance after the grant (or the unchanged balance
-- if this key was already applied).
-- ---------------------------------------------------------------------------
create or replace function foundation.grant_credits(
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
    raise exception 'grant amount must be positive, got %', p_amount
      using errcode = 'PT400';
  end if;

  v_balance := foundation.lock_balance(p_user);

  -- Already applied? Return the current balance untouched.
  if exists (
    select 1 from public.credit_entries
     where idempotency_key = p_idempotency_key and bucket = p_bucket
  ) then
    return v_balance;
  end if;

  insert into public.credit_entries
    (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
  values
    (p_user, p_amount, p_kind, p_bucket, p_reason, p_ref_type, p_ref_id, p_idempotency_key);

  update public.credit_balances
     set free       = free + case when p_bucket = 'free' then p_amount else 0 end,
         paid       = paid + case when p_bucket = 'paid' then p_amount else 0 end,
         updated_at = now()
   where user_id = p_user
  returning * into v_balance;

  return v_balance;
end;
$$;


-- ---------------------------------------------------------------------------
-- spend_credits — deduct a known amount. For cheap operations where the cost
-- is predictable, skip the reservation dance and charge directly.
--
-- Spends free credits before paid ones. A spend that crosses the boundary
-- writes one entry per bucket, both under the same idempotency key.
-- ---------------------------------------------------------------------------
create or replace function foundation.spend_credits(
  p_user            uuid,
  p_amount          bigint,
  p_operation       text,
  p_idempotency_key text,
  p_ref_type        text default 'ai_usage',
  p_ref_id          text default null
)
returns public.credit_balances
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_balance   public.credit_balances;
  v_from_free bigint;
  v_from_paid bigint;
begin
  if p_amount <= 0 then
    raise exception 'spend amount must be positive, got %', p_amount
      using errcode = 'PT400';
  end if;

  v_balance := foundation.lock_balance(p_user);

  if exists (
    select 1 from public.credit_entries where idempotency_key = p_idempotency_key
  ) then
    return v_balance;
  end if;

  if v_balance.free + v_balance.paid < p_amount then
    raise exception 'insufficient_credits: need %, have %',
      p_amount, v_balance.free + v_balance.paid
      using errcode = 'PT402';
  end if;

  v_from_free := least(v_balance.free, p_amount);
  v_from_paid := p_amount - v_from_free;

  if v_from_free > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_user, -v_from_free, 'spend', 'free', p_operation, p_ref_type, p_ref_id, p_idempotency_key);
  end if;

  if v_from_paid > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_user, -v_from_paid, 'spend', 'paid', p_operation, p_ref_type, p_ref_id, p_idempotency_key);
  end if;

  update public.credit_balances
     set free = free - v_from_free,
         paid = paid - v_from_paid,
         updated_at = now()
   where user_id = p_user
  returning * into v_balance;

  return v_balance;
end;
$$;


-- ---------------------------------------------------------------------------
-- reserve_credits — hold an estimate for an operation of unknown cost.
-- Credits leave the balance now; settle refunds whatever wasn't used.
-- ---------------------------------------------------------------------------
create or replace function foundation.reserve_credits(
  p_user            uuid,
  p_amount          bigint,
  p_operation       text,
  p_idempotency_key text,
  p_ttl             interval default interval '15 minutes'
)
returns public.credit_reservations
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_balance     public.credit_balances;
  v_reservation public.credit_reservations;
  v_from_free   bigint;
  v_from_paid   bigint;
begin
  if p_amount <= 0 then
    raise exception 'reservation amount must be positive, got %', p_amount
      using errcode = 'PT400';
  end if;

  v_balance := foundation.lock_balance(p_user);

  select * into v_reservation
    from public.credit_reservations
   where idempotency_key = p_idempotency_key;
  if found then
    return v_reservation;
  end if;

  if v_balance.free + v_balance.paid < p_amount then
    raise exception 'insufficient_credits: need %, have %',
      p_amount, v_balance.free + v_balance.paid
      using errcode = 'PT402';
  end if;

  v_from_free := least(v_balance.free, p_amount);
  v_from_paid := p_amount - v_from_free;

  insert into public.credit_reservations
    (user_id, amount, from_free, from_paid, operation, idempotency_key, expires_at)
  values
    (p_user, p_amount, v_from_free, v_from_paid, p_operation, p_idempotency_key, now() + p_ttl)
  returning * into v_reservation;

  if v_from_free > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_user, -v_from_free, 'spend', 'free', p_operation, 'reservation',
       v_reservation.id::text, p_idempotency_key);
  end if;

  if v_from_paid > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_user, -v_from_paid, 'spend', 'paid', p_operation, 'reservation',
       v_reservation.id::text, p_idempotency_key);
  end if;

  update public.credit_balances
     set free = free - v_from_free,
         paid = paid - v_from_paid,
         updated_at = now()
   where user_id = p_user;

  return v_reservation;
end;
$$;


-- Internal: return `p_amount` of a reservation to the buckets it came from,
-- paid first so a partial refund restores the scarcer currency. Used by both
-- settle and release.
create or replace function foundation.refund_reservation(
  p_reservation public.credit_reservations,
  p_amount      bigint,
  p_kind        foundation.credit_kind,
  p_reason      text,
  p_key_suffix  text
)
returns void
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_to_paid bigint;
  v_to_free bigint;
begin
  if p_amount <= 0 then
    return;
  end if;

  v_to_paid := least(p_reservation.from_paid, p_amount);
  v_to_free := p_amount - v_to_paid;

  if v_to_paid > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_reservation.user_id, v_to_paid, p_kind, 'paid', p_reason, 'reservation',
       p_reservation.id::text, p_reservation.idempotency_key || p_key_suffix);
  end if;

  if v_to_free > 0 then
    insert into public.credit_entries
      (user_id, delta, kind, bucket, reason, ref_type, ref_id, idempotency_key)
    values
      (p_reservation.user_id, v_to_free, p_kind, 'free', p_reason, 'reservation',
       p_reservation.id::text, p_reservation.idempotency_key || p_key_suffix);
  end if;

  update public.credit_balances
     set free = free + v_to_free,
         paid = paid + v_to_paid,
         updated_at = now()
   where user_id = p_reservation.user_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- settle_reservation — the operation finished; charge what it actually cost.
--
-- Under-use refunds the difference. Over-use is capped at the reserved amount:
-- the estimate was the user's exposure, and silently charging more than was
-- held could overdraw an account that has since been spent down elsewhere.
-- The shortfall is absorbed and visible in ai_usage for estimate tuning.
-- ---------------------------------------------------------------------------
create or replace function foundation.settle_reservation(
  p_reservation_id uuid,
  p_actual_amount  bigint
)
returns public.credit_balances
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_reservation public.credit_reservations;
  v_balance     public.credit_balances;
  v_charged     bigint;
begin
  select * into v_reservation
    from public.credit_reservations
   where id = p_reservation_id
     for update;

  if not found then
    raise exception 'reservation % not found', p_reservation_id using errcode = 'PT404';
  end if;

  if v_reservation.status <> 'open' then
    -- Already settled or released: idempotent no-op.
    return foundation.lock_balance(v_reservation.user_id);
  end if;

  v_balance := foundation.lock_balance(v_reservation.user_id);

  v_charged := greatest(p_actual_amount, 0);
  v_charged := least(v_charged, v_reservation.amount);

  perform foundation.refund_reservation(
    v_reservation,
    v_reservation.amount - v_charged,
    'release',
    'unused reservation',
    ':settle'
  );

  update public.credit_reservations
     set status = 'settled', settled_at = now(), settled_amount = v_charged
   where id = p_reservation_id;

  select * into v_balance from public.credit_balances
   where user_id = v_reservation.user_id;

  return v_balance;
end;
$$;


-- ---------------------------------------------------------------------------
-- release_reservation — the operation failed or was abandoned. Return it all.
-- ---------------------------------------------------------------------------
create or replace function foundation.release_reservation(
  p_reservation_id uuid,
  p_reason         text default 'operation failed'
)
returns public.credit_balances
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_reservation public.credit_reservations;
  v_balance     public.credit_balances;
begin
  select * into v_reservation
    from public.credit_reservations
   where id = p_reservation_id
     for update;

  if not found then
    raise exception 'reservation % not found', p_reservation_id using errcode = 'PT404';
  end if;

  if v_reservation.status <> 'open' then
    return foundation.lock_balance(v_reservation.user_id);
  end if;

  v_balance := foundation.lock_balance(v_reservation.user_id);

  perform foundation.refund_reservation(
    v_reservation, v_reservation.amount, 'release', p_reason, ':release'
  );

  update public.credit_reservations
     set status = 'released', settled_at = now(), settled_amount = 0
   where id = p_reservation_id;

  select * into v_balance from public.credit_balances
   where user_id = v_reservation.user_id;

  return v_balance;
end;
$$;


-- ---------------------------------------------------------------------------
-- expire_reservations — swept by cron. A crashed Edge Function or a phone
-- that lost signal mid-operation must not strand a user's credits.
-- ---------------------------------------------------------------------------
create or replace function foundation.expire_reservations()
returns integer
language plpgsql
security definer
set search_path = foundation, public, pg_temp
as $$
declare
  v_reservation public.credit_reservations;
  v_count       integer := 0;
begin
  for v_reservation in
    select * from public.credit_reservations
     where status = 'open' and expires_at < now()
     for update skip locked
  loop
    perform foundation.refund_reservation(
      v_reservation, v_reservation.amount, 'release', 'reservation expired', ':expire'
    );

    update public.credit_reservations
       set status = 'expired', settled_at = now(), settled_amount = 0
     where id = v_reservation.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


-- ---------------------------------------------------------------------------
-- The security boundary. Without this, any signed-in client could call
-- grant_credits and mint itself a balance.
-- ---------------------------------------------------------------------------
revoke all on schema foundation from public, anon, authenticated;
grant usage on schema foundation to service_role;

revoke all on all functions in schema foundation from public, anon, authenticated;
grant execute on all functions in schema foundation to service_role;

-- Same for anything added later by a future migration.
alter default privileges in schema foundation
  revoke all on functions from public, anon, authenticated;
