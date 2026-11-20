-- pending_entries (FIX-01): the BUY retry queue must upsert on (account, pair, candle), bump
-- `attempts` instead of duplicating, hide expired claims, delete by signal id and stay backend-only.
DO $pending_entries$
DECLARE
  v_account bigint;
  v_signal bigint;
  v_candle timestamptz := date_trunc('minute', now());
  v_n int;
  v_attempts int;
  v_stored timestamptz;
BEGIN
  INSERT INTO public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency)
    VALUES ('__pending__', '__PENDING__', '__pending___idr', 'idr', 'pending')
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.paper_accounts (name) VALUES ('__pending_account__')
    ON CONFLICT (name) DO NOTHING;
  SELECT id INTO v_account FROM public.paper_accounts WHERE name = '__pending_account__';
  INSERT INTO public.trading_signals (pair_id, timeframe, candle_time, side, price, strength)
    VALUES ('__pending__', '5m', v_candle, 'BUY', 100, 80)
    ON CONFLICT (pair_id, timeframe, candle_time, side) DO UPDATE SET price = excluded.price
    RETURNING id INTO v_signal;

  -- First queue: one row, expiry stored as given.
  v_n := public.upsert_pending_entries(v_account, jsonb_build_array(jsonb_build_object(
    'pair_id', '__pending__', 'signal_id', v_signal, 'candle_time', v_candle,
    'expires_at', v_candle + interval '15 minutes', 'strength', 80, 'price', 100,
    'indicators', jsonb_build_object('atr14', 1.5))));
  IF v_n <> 1 THEN RAISE EXCEPTION 'first upsert inserted % rows, expected 1', v_n; END IF;

  -- Re-queueing the same signal refreshes the expiry and bumps attempts; it must not duplicate.
  v_n := public.upsert_pending_entries(v_account, jsonb_build_array(jsonb_build_object(
    'pair_id', '__pending__', 'signal_id', v_signal, 'candle_time', v_candle,
    'expires_at', v_candle + interval '10 minutes', 'strength', 80, 'price', 100)));
  IF v_n <> 1 THEN RAISE EXCEPTION 'second upsert touched % rows, expected 1', v_n; END IF;
  SELECT attempts, expires_at INTO v_attempts, v_stored
    FROM public.pending_entries WHERE account_id = v_account AND pair_id = '__pending__';
  IF v_attempts <> 1 THEN RAISE EXCEPTION 'attempts = %, expected 1', v_attempts; END IF;
  IF v_stored <> v_candle + interval '10 minutes' THEN
    RAISE EXCEPTION 'expires_at was not refreshed: %', v_stored;
  END IF;

  -- A live claim is returned; an expired one is not.
  SELECT count(*) INTO v_n FROM public.get_pending_entries(v_account, ARRAY['__pending__'], v_candle + interval '1 minute');
  IF v_n <> 1 THEN RAISE EXCEPTION 'live claim not returned (got %)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.get_pending_entries(v_account, ARRAY['__pending__'], v_candle + interval '11 minutes');
  IF v_n <> 0 THEN RAISE EXCEPTION 'expired claim was returned (got %)', v_n; END IF;

  -- Delete is scoped to the account and keyed on the stored signal id.
  v_n := public.delete_pending_entries(v_account, ARRAY[v_signal]);
  IF v_n <> 1 THEN RAISE EXCEPTION 'delete removed % rows, expected 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.pending_entries WHERE account_id = v_account;
  IF v_n <> 0 THEN RAISE EXCEPTION 'queue not empty after delete (% rows)', v_n; END IF;

  -- Backend-only: no client role may call the queue RPCs, and the table has no client grants.
  IF has_function_privilege('anon', 'public.get_pending_entries(bigint,text[],timestamptz)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.upsert_pending_entries(bigint,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.delete_pending_entries(bigint,bigint[])', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.prune_pending_entries()', 'EXECUTE') THEN
    RAISE EXCEPTION 'pending entry RPC is executable by a client role';
  END IF;
  IF has_table_privilege('anon', 'public.pending_entries', 'SELECT')
    OR has_table_privilege('authenticated', 'public.pending_entries', 'INSERT') THEN
    RAISE EXCEPTION 'pending_entries has client table privileges';
  END IF;

  DELETE FROM public.pending_entries WHERE account_id = v_account;
  DELETE FROM public.trading_signals WHERE id = v_signal;
  DELETE FROM public.paper_accounts WHERE id = v_account;
  DELETE FROM public.market_pairs WHERE id = '__pending__';
END
$pending_entries$;
