-- Keep sandbox purchases out of the real ledger by default.
--
-- TestFlight purchases are sandbox purchases. Without this, any tester can buy
-- the same pack repeatedly — Apple charges them nothing — and receive real
-- credits each time. That is not a fraud scenario requiring a determined
-- attacker; it is what happens when you hand a build to someone and ask them
-- to try the purchase flow.
--
-- Recorded either way, so the audit trail shows exactly what the provider said
-- and what we did about it. Flip the setting to true while testing the flow
-- end to end, and back to false before anyone else has the build.

alter table foundation.purchase_events
  add column if not exists environment text not null default 'unknown';

insert into foundation.settings (key, value)
values ('credit_sandbox_purchases', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function foundation.record_purchase(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_user       uuid,
  p_product_id text,
  p_payload    jsonb default null,
  p_sandbox    boolean default true
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

  begin
    insert into foundation.purchase_events (provider, event_id, event_type, user_id,
                                            product_id, status, payload, environment)
    values (p_provider, p_event_id, p_event_type, p_user, p_product_id, 'processing',
            p_payload, case when p_sandbox then 'sandbox' else 'production' end);
  exception when unique_violation then
    return (select jsonb_build_object('applied', false, 'status', 'duplicate',
                                      'credits', credits, 'note', note)
              from foundation.purchase_events
             where provider = p_provider and event_id = p_event_id);
  end;

  -- Before anything else: a purchase that cost nobody anything buys nothing,
  -- unless this deployment has deliberately opted in for testing.
  if p_sandbox and not coalesce(
       (select (value #>> '{}')::boolean from foundation.settings
         where key = 'credit_sandbox_purchases'), false) then
    return foundation.reject_event(p_provider, p_event_id,
             'sandbox purchase, not credited (credit_sandbox_purchases is off)');
  end if;

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
                            'credits', v_credits, 'anonymous', v_anon,
                            'sandbox', p_sandbox);
end;
$$;

-- A refund of something never credited still gets recorded; the clamp at zero
-- already makes taking back nothing a no-op, so sandbox needs no special case
-- beyond knowing which environment it came from.
create or replace function foundation.record_refund(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_user       uuid,
  p_product_id text,
  p_payload    jsonb default null,
  p_sandbox    boolean default true
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
                                            product_id, status, payload, environment)
    values (p_provider, p_event_id, p_event_type, p_user, p_product_id, 'processing',
            p_payload, case when p_sandbox then 'sandbox' else 'production' end);
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

revoke all on function foundation.record_purchase(text, text, text, uuid, text, jsonb, boolean)
  from public, anon, authenticated;
revoke all on function foundation.record_refund(text, text, text, uuid, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function foundation.record_purchase(text, text, text, uuid, text, jsonb, boolean) to service_role;
grant execute on function foundation.record_refund(text, text, text, uuid, text, jsonb, boolean) to service_role;

-- The old six-argument versions would otherwise still be callable, and would
-- credit a sandbox purchase without checking.
drop function if exists foundation.record_purchase(text, text, text, uuid, text, jsonb);
drop function if exists foundation.record_refund(text, text, text, uuid, text, jsonb);
