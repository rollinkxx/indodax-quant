-- Rollback for 20261120160000_pipeline_phase.sql (FIX-07).
--
-- The signature is unchanged, so the order does not matter: the previous Worker never reads `phase`
-- or `signals_due`, and this restores begin_run to the exact 3-argument body from
-- 20261120090000_pipeline_lease_fencing.sql. Dropping execution_logs.phase also removes the cadence
-- memory, so the next deployment re-evaluates signals every tick (the pre-FIX-07 behaviour).

alter table public.execution_logs drop column if exists phase;

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
  v_token bigint;
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

  -- Acquire the expired lease and bump the fence in one statement, so the returned token is the one
  -- that now guards every later renewal and release.
  update system_locks
     set owner = v_run_id::text,
         locked_until = now() + make_interval(secs => p_lock_ttl_seconds),
         fence_token = fence_token + 1
   where name = 'pipeline' and locked_until < now()
   returning fence_token into v_token;
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
    'fence_token', v_token,
    'lease_expires_at', (now() + make_interval(secs => p_lock_ttl_seconds)),
    'config', (select params from strategy_configs where is_active limit 1),
    'account', to_jsonb(v_account),
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
        'price_precision', p.price_precision,
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
