\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE public.execution_logs (
  id bigserial PRIMARY KEY,
  scheduled_time timestamptz NOT NULL UNIQUE,
  trigger text NOT NULL DEFAULT 'cron',
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  finished_at timestamptz,
  duration_ms integer
);
CREATE TABLE public.system_locks (
  name text PRIMARY KEY,
  owner text,
  locked_until timestamptz NOT NULL
);
CREATE TABLE public.paper_accounts (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  kill_switch boolean NOT NULL,
  cash_balance numeric NOT NULL,
  equity numeric NOT NULL,
  peak_equity numeric NOT NULL,
  max_drawdown_pct numeric NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE TABLE public.strategy_configs (is_active boolean NOT NULL, params jsonb NOT NULL);
CREATE TABLE public.market_pairs (
  id text PRIMARY KEY, symbol text NOT NULL, ticker_id text NOT NULL,
  is_maintenance boolean NOT NULL, trade_min_base_currency numeric, is_tracked boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pair_sync_state (
  pair_id text PRIMARY KEY, covered_until timestamptz,
  last_trade_time timestamptz, last_trade_tid text, htf_backfilled_at timestamptz
);
CREATE TABLE public.paper_positions (id bigint PRIMARY KEY, account_id bigint NOT NULL, status text NOT NULL);
CREATE TABLE public.portfolio_snapshots (
  account_id bigint NOT NULL, snapshot_time timestamptz NOT NULL, equity numeric NOT NULL
);

INSERT INTO public.system_locks(name, owner, locked_until)
VALUES ('pipeline', NULL, now() - interval '1 second');
INSERT INTO public.paper_accounts
  (id,name,status,kill_switch,cash_balance,equity,peak_equity,max_drawdown_pct,reset_at)
VALUES (1,'default','RUNNING',false,10000000,10000000,10000000,0,now()-interval '1 day');
INSERT INTO public.strategy_configs(is_active,params) VALUES (true,'{}'::jsonb);
INSERT INTO public.market_pairs(id,symbol,ticker_id,is_maintenance,trade_min_base_currency,is_tracked)
VALUES ('btcidr','BTCIDR','btc_idr',false,10000,true);
INSERT INTO public.pair_sync_state(pair_id) VALUES ('btcidr');
INSERT INTO public.paper_positions(id,account_id,status) VALUES (1,1,'OPEN');
INSERT INTO public.portfolio_snapshots(account_id,snapshot_time,equity) VALUES (1,now()-interval '1 day',10000000);
INSERT INTO public.execution_logs(scheduled_time,status,started_at)
VALUES (now()-interval '10 minutes','RUNNING',now()-interval '10 minutes');
INSERT INTO public.execution_logs(scheduled_time,status,started_at)
VALUES (now()-interval '1 minute','RUNNING',now()-interval '1 minute');

\i supabase/migrations/20261115150000_finalize_orphaned_runs.sql

DO $assert$
DECLARE
  v_result jsonb;
  v_new_run_id bigint;
  v_stale_run_id bigint;
  v_recent_run_id bigint;
  v_status text;
  v_owner text;
  v_steps jsonb;
BEGIN
  SELECT id INTO v_stale_run_id FROM public.execution_logs ORDER BY id LIMIT 1;
  SELECT id INTO v_recent_run_id FROM public.execution_logs ORDER BY id DESC LIMIT 1;

  v_result := public.begin_run(now() + interval '1 minute','manual',55);
  IF coalesce((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION 'begin_run did not acquire the expired lock: %', v_result;
  END IF;
  v_new_run_id := (v_result->>'run_id')::bigint;

  SELECT status,steps INTO v_status,v_steps FROM public.execution_logs WHERE id=v_stale_run_id;
  IF v_status <> 'FAILED' OR v_steps->'watchdog'->>'reason' <> 'stale_run_without_lease' THEN
    RAISE EXCEPTION 'orphaned run was not finalized with watchdog metadata: %, %', v_status, v_steps;
  END IF;

  SELECT status INTO v_status FROM public.execution_logs WHERE id=v_recent_run_id;
  IF v_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'recent run was incorrectly finalized: %', v_status;
  END IF;

  SELECT owner INTO v_owner FROM public.system_locks WHERE name='pipeline';
  IF v_owner <> v_new_run_id::text THEN
    RAISE EXCEPTION 'new run does not own the lock: %', v_owner;
  END IF;

  PERFORM public.finish_run(v_new_run_id,'SUCCESS','{"test":true}'::jsonb,NULL);
  SELECT status INTO v_status FROM public.execution_logs WHERE id=v_new_run_id;
  IF v_status <> 'SUCCESS' THEN
    RAISE EXCEPTION 'finish_run did not persist successful status: %', v_status;
  END IF;

  SELECT owner INTO v_owner FROM public.system_locks WHERE name='pipeline';
  IF v_owner IS NOT NULL THEN
    RAISE EXCEPTION 'finish_run did not clear the lock owner: %', v_owner;
  END IF;

  PERFORM public.finish_run(v_stale_run_id,'SUCCESS','{"late_finish":true}'::jsonb,NULL);
  SELECT status INTO v_status FROM public.execution_logs WHERE id=v_stale_run_id;
  IF v_status <> 'FAILED' THEN
    RAISE EXCEPTION 'late finish overwrote a watchdog-finalized run: %', v_status;
  END IF;
END;
$assert$;

ROLLBACK;
