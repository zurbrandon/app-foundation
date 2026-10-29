-- Free credits for a new user, with a ceiling on the whole programme.
--
-- Two settings rather than one, because a single per-user number cannot do
-- both jobs it gets asked to do:
--
--   * enough to genuinely try the thing (a trial)
--   * enough to finish onboarding (a whole wardrobe, ~150 garments)
--
-- Sizing the grant for the second hands every passer-by a wardrobe's worth of
-- provider spend. Sizing it for the first means a real user hits a wall
-- halfway through setting up, which is the worst possible moment. So the grant
-- is a trial, and anyone who needs more is topped up deliberately.
--
-- `welcome_daily_cap` is the part that actually bounds the risk. Anonymous
-- sign-in is open by design — that is what spares people a sign-up screen —
-- and Supabase's default rate limit still allows 30 per hour per IP. Without a
-- ceiling the free programme is an unbounded liability; with one the worst
-- case is a number you chose in advance.
--
-- Tuning either is an UPDATE against foundation.settings. No deploy, and it
-- takes effect for the next user who signs up.

-- 100 credits is 33 garments at the current flat rate: a real trial, and not
-- worth anybody's trouble to farm.
insert into foundation.settings (key, value)
values ('welcome_credits', '100'::jsonb)
on conflict (key) do nothing;

-- 5000 credits is $5 of provider spend a day, so roughly 50 new users daily
-- before the tap closes. Far above honest use, far below a problem.
insert into foundation.settings (key, value)
values ('welcome_daily_cap', '5000'::jsonb)
on conflict (key) do nothing;

create or replace function foundation.setting_number(p_key text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = foundation, pg_temp
as $$
  select coalesce((select (value #>> '{}')::numeric from foundation.settings where key = p_key),
                  p_default);
$$;

/**
 * Credits granted under the welcome programme in the last 24 hours.
 *
 * Reads the ledger rather than a counter, so it cannot drift out of step with
 * what was actually given away.
 */
create or replace function foundation.welcome_granted_today()
returns bigint
language sql
stable
security definer
set search_path = foundation, public, pg_temp
as $$
  select coalesce(sum(delta), 0)::bigint
    from public.credit_entries
   where ref_type = 'welcome'
     and created_at > now() - interval '24 hours';
$$;

create or replace function foundation.grant_welcome_credits()
returns trigger
language plpgsql
security definer
set search_path = foundation, public, auth, pg_temp
as $$
declare
  v_amount bigint;
  v_cap    bigint;
begin
  v_amount := foundation.setting_number('welcome_credits', 0)::bigint;
  if v_amount <= 0 then
    return new;
  end if;

  v_cap := foundation.setting_number('welcome_daily_cap', 0)::bigint;
  if v_cap > 0 and foundation.welcome_granted_today() + v_amount > v_cap then
    -- Quietly skip rather than fail. The account is still created and the app
    -- still works; they simply start at zero, which the gateway already
    -- handles by refusing with insufficient_credits.
    raise warning 'welcome grant skipped for %: daily cap of % credits reached', new.id, v_cap;
    return new;
  end if;

  perform foundation.grant_credits(
    new.id, v_amount, 'free'::foundation.credit_bucket, 'grant'::foundation.credit_kind,
    'welcome:' || new.id::text, 'welcome grant', 'welcome', new.id::text
  );

  return new;
exception when others then
  -- This trigger runs inside the transaction that creates the account. Letting
  -- it raise would mean a bug in the grant stops anyone signing in at all —
  -- trading a recoverable problem (no free credits, top them up later) for an
  -- unrecoverable one (the app cannot start). Never worth it.
  raise warning 'welcome grant failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists grant_welcome_credits on auth.users;

create trigger grant_welcome_credits
  after insert on auth.users
  for each row
  execute function foundation.grant_welcome_credits();

revoke all on function foundation.setting_number(text, numeric) from public, anon, authenticated;
revoke all on function foundation.welcome_granted_today() from public, anon, authenticated;
revoke all on function foundation.grant_welcome_credits() from public, anon, authenticated;
grant execute on function foundation.setting_number(text, numeric) to service_role;
grant execute on function foundation.welcome_granted_today() to service_role;
