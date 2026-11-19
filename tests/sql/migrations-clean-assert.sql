-- Assertions against a database created only by replaying every production migration.
DO $audit$
DECLARE
  v_table record;
  v_signature text;
  v_function regprocedure;
  v_fee numeric;
  v_fee_model text;
  v_active_count integer;
BEGIN
  -- Every public application table must have RLS enabled.
  FOR v_table IN
    SELECT c.relname, c.relrowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    IF NOT v_table.relrowsecurity THEN
      RAISE EXCEPTION 'RLS is disabled on public.%', v_table.relname;
    END IF;
    IF has_table_privilege('anon', format('public.%I', v_table.relname), 'INSERT')
      OR has_table_privilege('anon', format('public.%I', v_table.relname), 'UPDATE')
      OR has_table_privilege('anon', format('public.%I', v_table.relname), 'DELETE')
      OR has_table_privilege('anon', format('public.%I', v_table.relname), 'TRUNCATE')
      OR has_table_privilege('authenticated', format('public.%I', v_table.relname), 'INSERT')
      OR has_table_privilege('authenticated', format('public.%I', v_table.relname), 'UPDATE')
      OR has_table_privilege('authenticated', format('public.%I', v_table.relname), 'DELETE')
      OR has_table_privilege('authenticated', format('public.%I', v_table.relname), 'TRUNCATE') THEN
      RAISE EXCEPTION 'Client write privilege found on public.%', v_table.relname;
    END IF;
  END LOOP;

  -- system_locks is intentionally backend-only: RLS enabled, zero client policies.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.system_locks'::regclass) THEN
    RAISE EXCEPTION 'system_locks must have RLS enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'system_locks') THEN
    RAISE EXCEPTION 'system_locks must not have client policies';
  END IF;

  -- Backend mutation and orchestration RPCs must exist and be unavailable to clients.
  FOREACH v_signature IN ARRAY ARRAY[
    'public.begin_run(timestamptz,text,integer)',
    'public.finish_run(bigint,text,jsonb,text)',
    'public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
    'public.get_recent_candles(text[],text,integer)',
    'public.get_recent_candles_multi(text[],text[],integer)',
    'public.get_pending_sell_signals(text[])',
    'public.set_universe(jsonb)',
    'public.save_analysis(jsonb,jsonb,jsonb)',
    'public.paper_open_position(bigint,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,bigint,text,text)',
    'public.paper_close_position(bigint,numeric,numeric,numeric,numeric,text)',
    'public.paper_mark_to_market(bigint,jsonb,timestamptz)',
    'public.paper_set_status(bigint,text,text)',
    'public.paper_reset_account(bigint,numeric)',
    'public.claim_notifications(jsonb)',
    'public.complete_notifications(jsonb)',
    'public.run_retention()'
  ] LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'Expected backend RPC missing: %', v_signature;
    END IF;
    IF has_function_privilege('anon', v_function, 'EXECUTE')
      OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Backend RPC is executable by a client role: %', v_signature;
    END IF;
  END LOOP;

  -- Membership helper must remain SECURITY INVOKER after all migrations.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_app_user()'::regprocedure) THEN
    RAISE EXCEPTION 'is_app_user must be SECURITY INVOKER';
  END IF;

  -- The clean migration chain must create exactly one active paper strategy that charges
  -- the real per-pair taker fee, without starting a paper account. feePct is only the
  -- fallback, and it must match the catalog rate so a fallback can never under-charge.
  SELECT count(*), max((params->>'feePct')::numeric), max(params->>'feeModel')
    INTO v_active_count, v_fee, v_fee_model
    FROM public.strategy_configs
    WHERE is_active;
  IF v_active_count <> 1 THEN RAISE EXCEPTION 'Expected exactly one active strategy config, got %', v_active_count; END IF;
  IF v_fee IS DISTINCT FROM 0.2::numeric THEN
    RAISE EXCEPTION 'Unexpected feePct in clean migration seed: %', v_fee;
  END IF;
  IF v_fee_model IS DISTINCT FROM 'pair_taker' THEN
    RAISE EXCEPTION 'Expected feeModel pair_taker in clean migration seed, got %', v_fee_model;
  END IF;
  IF EXISTS (SELECT 1 FROM public.paper_accounts WHERE status <> 'STOPPED' OR kill_switch) THEN
    RAISE EXCEPTION 'A clean database must seed paper accounts STOPPED with kill switch off';
  END IF;
  IF EXISTS (SELECT 1 FROM public.paper_orders WHERE is_simulated IS NOT TRUE) THEN
    RAISE EXCEPTION 'Non-simulated paper order exists in clean database';
  END IF;
END
$audit$;

-- Candle integrity: the replay must install candles_low_positive, and a low <= 0 row must be rejected.
DO $low_check$
DECLARE
  v_rejected boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.candles'::regclass AND conname = 'candles_low_positive'
  ) THEN
    RAISE EXCEPTION 'candles_low_positive constraint missing after migration replay';
  END IF;

  INSERT INTO public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency)
    VALUES ('__check__', '__CHECK__', '__check___idr', 'idr', 'check')
    ON CONFLICT (id) DO NOTHING;
  BEGIN
    INSERT INTO public.candles (pair_id, timeframe, open_time, open, high, low, close)
      VALUES ('__check__', '5m', now(), 10, 11, -1, 10);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'candles row with low <= 0 was not rejected';
  END IF;
  DELETE FROM public.candles WHERE pair_id = '__check__';
  DELETE FROM public.market_pairs WHERE id = '__check__';
END
$low_check$;

-- Explicitly print the replay summary for the CI log.
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS public_policies,
  (SELECT count(*) FROM public.strategy_configs WHERE is_active) AS active_configs,
  (SELECT params->>'feePct' FROM public.strategy_configs WHERE is_active LIMIT 1) AS fee_pct;
