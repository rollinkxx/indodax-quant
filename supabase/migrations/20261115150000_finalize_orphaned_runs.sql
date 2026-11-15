-- Finalize abandoned cron runs only after a new run has acquired the expired pipeline lease.
-- A 3-minute age threshold is intentionally much longer than the 55-second lock TTL.
create or replace function public.begin_run(
  p_scheduled timestamptz,
  p_trigger text default 'cron',
  p_lock_ttl_seconds integer default 55
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run_id bigint;
  v_locked int;
  v_account public.paper_accounts;
  v_day_start timestamptz;
begin
  insert into execution_logs (scheduled_time, trigger, status)
  values (p_scheduled, p_trigger, 'RUNNING')
  on conflict (scheduled_time) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_tick');
  end if;

  update system_locks
     set owner = v_run_id::text,
         locked_until = now() + make_interval(secs => p_lock_ttl_seconds)
   where name = 'pipeline' and locked_until < now();
  get diagnostics v_locked = row_count;

  if v_locked = 0 then
    update execution_logs
       set status = 'SKIPPED', finished_at = now(), error = 'pipeline lock held by another run',
           duration_ms = (extract(epoch from now() - started_at) * 1000)::int
     where id = v_run_id;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'run_id', v_run_id);
  end if;

  -- The lock has expired and is now owned by this run. Old RUNNING rows no longer
  -- represent a valid lease. Preserve their original steps and attach explicit
  -- watchdog evidence rather than leaving dashboard history permanently RUNNING.
  update execution_logs
     set status = 'FAILED',
         steps = coalesce(steps, '{}'::jsonb) || jsonb_build_object(
           'watchdog', jsonb_build_object(
             'ok', false,
             'reason', 'stale_run_without_lease',
             'finalized_at', now(),
             'stale_after_seconds', 180
           )
         ),
         error = concat_ws(E'\n', nullif(error, ''),
           'watchdog: stale RUNNING record finalized after its pipeline lease expired'),
         finished_at = now(),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
   where status = 'RUNNING'
     and id <> v_run_id
     and started_at < now() - interval '3 minutes';

  select * into v_account from paper_accounts where name = 'default';
  -- Jakarta midnight (UTC+7) expressed in UTC.
  v_day_start := (date_trunc('day', now() at time zone 'Asia/Jakarta')) at time zone 'Asia/Jakarta';

  return jsonb_build_object(
    'ok', true,
    'run_id', v_run_id,
    'config', (select params from strategy_configs where is_active limit 1),
    'account', to_jsonb(v_account),
    'pairs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'symbol', p.symbol, 'ticker_id', p.ticker_id,
        'is_maintenance', p.is_maintenance,
        'trade_min_base_currency', p.trade_min_base_currency,
        'covered_until', s.covered_until,
        'last_trade_time', s.last_trade_time,
        'last_trade_tid', s.last_trade_tid
      ) order by p.id)
      from market_pairs p left join pair_sync_state s on s.pair_id = p.id
      where p.is_tracked
    ), '[]'::jsonb),
    'open_positions', coalesce((
      select jsonb_agg(to_jsonb(pp)) from paper_positions pp
      where pp.account_id = v_account.id and pp.status = 'OPEN'
    ), '[]'::jsonb),
    'day_start_equity', (
      select equity from portfolio_snapshots
      where account_id = v_account.id and snapshot_time >= greatest(v_day_start, v_account.reset_at)
      order by snapshot_time asc limit 1
    ),
    'pair_catalog_age_seconds', (
      select extract(epoch from now() - min(updated_at))::int from market_pairs where is_tracked
    )
  );
end;
$$;

create or replace function public.finish_run(
  p_run_id bigint, p_status text, p_steps jsonb, p_error text default null
) returns void
language plpgsql
set search_path = public
as $$
begin
  -- Do not let a late worker completion overwrite a watchdog-finalized run.
  update execution_logs
     set status = p_status,
         steps = coalesce(p_steps, '{}'::jsonb),
         error = p_error,
         finished_at = now(),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
   where id = p_run_id and status = 'RUNNING';

  if found then
    update system_locks set locked_until = now() - interval '1 second', owner = null
     where name = 'pipeline' and owner = p_run_id::text;
  end if;
end;
$$;

revoke all on function public.begin_run(timestamptz,text,integer) from public, anon, authenticated;
grant execute on function public.begin_run(timestamptz,text,integer) to service_role;
revoke all on function public.finish_run(bigint,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.finish_run(bigint,text,jsonb,text) to service_role;
