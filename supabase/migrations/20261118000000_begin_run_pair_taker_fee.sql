-- Expose each pair's real INDODAX taker fee to the pipeline so the paper engine can charge it
-- when strategy_configs.params.feeModel = 'pair_taker'. Non-destructive: replaces begin_run only,
-- adding one field to the per-pair context. Default fee model ('assumption') is unaffected.
-- Preserve the MTF/dynamic-universe run context while finalizing abandoned runs.
-- The watchdog runs only after this invocation successfully acquires the expired pipeline lease.
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
       set status = 'SKIPPED',
           finished_at = now(),
           error = 'pipeline lock held by another run',
           duration_ms = (extract(epoch from now() - started_at) * 1000)::int
     where id = v_run_id;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'run_id', v_run_id);
  end if;

  -- The new owner has acquired an expired lease. Any RUNNING row older than three
  -- minutes cannot still own a valid pipeline lease; finalize it with audit metadata.
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
  v_day_start := (date_trunc('day', now() at time zone 'Asia/Jakarta')) at time zone 'Asia/Jakarta';

  return jsonb_build_object(
    'ok', true,
    'run_id', v_run_id,
    'config', (select params from strategy_configs where is_active limit 1),
    'account', to_jsonb(v_account),
    -- Keep pinned pairs, current dynamic universe, and every pair with an open position.
    'pairs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'symbol', p.symbol,
        'ticker_id', p.ticker_id,
        'is_maintenance', p.is_maintenance,
        'is_tracked', p.is_tracked,
        'in_universe', p.in_universe,
        'trade_min_base_currency', p.trade_min_base_currency,
        'trade_fee_percent_taker', p.trade_fee_percent_taker,
        'covered_until', s.covered_until,
        'last_trade_time', s.last_trade_time,
        'last_trade_tid', s.last_trade_tid,
        'htf_backfilled_at', s.htf_backfilled_at
      ) order by p.id)
      from market_pairs p
      left join pair_sync_state s on s.pair_id = p.id
      where p.is_tracked
         or p.in_universe
         or exists (
           select 1
           from paper_positions pp
           where pp.pair_id = p.id
             and pp.account_id = v_account.id
             and pp.status = 'OPEN'
         )
    ), '[]'::jsonb),
    -- The full catalog drives the dynamic universe selector and maintenance filter.
    'catalog', coalesce((
      select jsonb_object_agg(id, is_maintenance) from market_pairs
    ), '{}'::jsonb),
    'open_positions', coalesce((
      select jsonb_agg(to_jsonb(pp))
      from paper_positions pp
      where pp.account_id = v_account.id and pp.status = 'OPEN'
    ), '[]'::jsonb),
    'day_start_equity', (
      select equity
      from portfolio_snapshots
      where account_id = v_account.id
        and snapshot_time >= greatest(v_day_start, v_account.reset_at)
      order by snapshot_time asc
      limit 1
    ),
    'pair_catalog_age_seconds', (
      select extract(epoch from now() - min(updated_at))::int
      from market_pairs
      where is_tracked
    )
  );
end;
$$;

revoke all on function public.begin_run(timestamptz,text,integer) from public, anon, authenticated;
grant execute on function public.begin_run(timestamptz,text,integer) to service_role;

