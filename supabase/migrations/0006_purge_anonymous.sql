-- Housekeeping for anonymous users.
--
-- Supabase has no automatic cleanup for them: "Automatic cleanup of anonymous
-- users is currently not available." An anonymous user cannot sign back in
-- after clearing data or switching devices, so every abandoned install leaves
-- a row that nobody will ever use again — plus its credit_balances row, which
-- cascades from auth.users.
--
-- What this deliberately will NOT delete:
--
--   * anyone who has secured their account (is_anonymous = false)
--   * anyone holding paid credits. Purchases are meant to be impossible while
--     anonymous, so paid credits on an anonymous user means something went
--     wrong upstream. That is evidence of money changing hands and a bug to
--     investigate, not a row to quietly drop.
--   * anyone with recorded AI usage inside the window, so an active user is
--     never removed out from under themselves.
--
-- Scheduling is left to the operator. With pg_cron:
--   select cron.schedule('purge-anonymous', '0 4 * * *',
--                        $$select foundation.purge_abandoned_anonymous()$$);

create or replace function foundation.purge_abandoned_anonymous(
  p_older_than interval default '30 days'
)
returns integer
language plpgsql
security definer
set search_path = foundation, public, auth, pg_temp
as $$
declare
  v_deleted integer;
begin
  if p_older_than < interval '1 day' then
    raise exception 'refusing to purge anonymous users younger than a day'
      using errcode = 'PT400';
  end if;

  with doomed as (
    select u.id
      from auth.users u
      left join public.credit_balances b on b.user_id = u.id
     where u.is_anonymous
       and u.created_at < now() - p_older_than
       and coalesce(b.paid, 0) = 0
       and not exists (
         select 1 from foundation.ai_usage a
          where a.user_id = u.id
            and a.created_at >= now() - p_older_than
       )
  )
  delete from auth.users
   where id in (select id from doomed);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function foundation.purge_abandoned_anonymous(interval) from public, anon, authenticated;
grant execute on function foundation.purge_abandoned_anonymous(interval) to service_role;
