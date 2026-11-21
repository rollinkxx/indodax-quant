-- Outage alarm: the Worker needs to know when the pipeline last produced a SUCCESS run.
--
-- Between 2026-11-19 14:00Z and 2026-11-20 09:03Z 1.011 runs died on `stale_run_without_lease`
-- (88% of slots produced no analysis) and not one notification was sent, because every alert the
-- Worker emits lives inside the run — and a run that cannot take the pipeline lock returns before
-- any of them execute. The Worker now calls this before `begin_run` and pages the operator after
-- 15 minutes without a SUCCESS.
--
-- EXPAND step only: one new read-only function plus an index, nothing existing changes. A Worker
-- that does not call it is unaffected.
--
-- Rollback: supabase/migrations/rollback/20261121050000_last_success_at.rollback.sql

create or replace function public.last_success_at(p_account_id bigint default null)
returns timestamptz
language sql
stable
security definer
set search_path to 'public'
as $$
  -- execution_logs carries no account_id: the pipeline is single-account (paper_accounts.name =
  -- 'default'), so p_account_id is accepted for future multi-account support and ignored today.
  select max(scheduled_time) from public.execution_logs where status = 'SUCCESS';
$$;

-- The alarm runs on every cron tick, so keep the max() off a growing table scan.
create index if not exists execution_logs_success_scheduled_idx
  on public.execution_logs (scheduled_time desc)
  where status = 'SUCCESS';

revoke all on function public.last_success_at(bigint) from public, anon, authenticated;
grant execute on function public.last_success_at(bigint) to service_role;
