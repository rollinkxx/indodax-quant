-- WP1c: market_quotes_5m accepts well-formed quotes, rejects impossible ones, keeps the last
-- observation per bucket, and is bounded by run_retention().
\set ON_ERROR_STOP on
do $$
declare
  v_after_first jsonb;
  v_after_second jsonb;
  v_bid numeric;
  v_rows int;
begin
  insert into public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency)
    values ('__q__', '__Q__', '__q___idr', 'idr', 'q') on conflict (id) do nothing;

  -- First write in a bucket.
  v_after_first := public.ingest_quotes_5m(jsonb_build_array(jsonb_build_object(
    'pair_id', '__q__', 'open_time', '2026-01-01T00:05:00Z',
    'bid_close', 99, 'ask_close', 101, 'spread_pct', 2, 'captured_at', '2026-01-01T00:05:10Z')));

  -- A later observation in the same bucket must win.
  v_after_second := public.ingest_quotes_5m(jsonb_build_array(jsonb_build_object(
    'pair_id', '__q__', 'open_time', '2026-01-01T00:05:00Z',
    'bid_close', 100, 'ask_close', 102, 'spread_pct', 1.98, 'captured_at', '2026-01-01T00:05:50Z')));
  select bid_close into v_bid from public.market_quotes_5m
    where pair_id = '__q__' and open_time = '2026-01-01T00:05:00Z';
  if v_bid <> 100 then
    raise exception 'last quote in a bucket did not win: bid_close=%', v_bid;
  end if;

  -- A stale retry must NOT overwrite the newer observation.
  perform public.ingest_quotes_5m(jsonb_build_array(jsonb_build_object(
    'pair_id', '__q__', 'open_time', '2026-01-01T00:05:00Z',
    'bid_close', 50, 'ask_close', 51, 'spread_pct', 1, 'captured_at', '2026-01-01T00:05:01Z')));
  select bid_close into v_bid from public.market_quotes_5m
    where pair_id = '__q__' and open_time = '2026-01-01T00:05:00Z';
  if v_bid <> 100 then
    raise exception 'a stale retry overwrote a newer quote: bid_close=%', v_bid;
  end if;

  -- Crossed books and non-positive prices are rejected by the filter, not stored.
  perform public.ingest_quotes_5m(jsonb_build_array(
    jsonb_build_object('pair_id', '__q__', 'open_time', '2026-01-01T00:10:00Z',
      'bid_close', 101, 'ask_close', 100, 'spread_pct', 1),
    jsonb_build_object('pair_id', '__q__', 'open_time', '2026-01-01T00:15:00Z',
      'bid_close', 0, 'ask_close', 1, 'spread_pct', 1)));
  select count(*) into v_rows from public.market_quotes_5m where pair_id = '__q__';
  if v_rows <> 1 then
    raise exception 'invalid quotes were stored: % row(s)', v_rows;
  end if;

  -- An unknown pair is ignored rather than violating the FK.
  perform public.ingest_quotes_5m(jsonb_build_array(jsonb_build_object(
    'pair_id', '__nope__', 'open_time', '2026-01-01T00:05:00Z',
    'bid_close', 1, 'ask_close', 2, 'spread_pct', 1)));

  -- Retention removes quotes older than 400 days and keeps recent ones.
  insert into public.market_quotes_5m (pair_id, open_time, bid_close, ask_close, spread_pct, captured_at)
    values ('__q__', now() - interval '401 days', 1, 2, 1, now() - interval '401 days');
  perform public.run_retention();
  select count(*) into v_rows from public.market_quotes_5m
    where pair_id = '__q__' and open_time < now() - interval '400 days';
  if v_rows <> 0 then
    raise exception 'retention left % stale quote row(s)', v_rows;
  end if;
  select count(*) into v_rows from public.market_quotes_5m where pair_id = '__q__';
  if v_rows < 1 then
    raise exception 'retention deleted recent quotes';
  end if;

  delete from public.market_quotes_5m where pair_id = '__q__';
  delete from public.market_pairs where id = '__q__';
  raise notice 'market_quotes_5m: ok';
end
$$;
