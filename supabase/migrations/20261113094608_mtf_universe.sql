-- INDODAX QUANT — Multi-timeframe (MTF) analysis + dynamic pair universe.
-- Non-destructive: adds columns, widens the candle timeframe check, replaces RPCs. Existing data is kept.

-- ---------------------------------------------------------------------------
-- Candles: allow higher timeframes (15m / 1h)
-- ---------------------------------------------------------------------------
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.candles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%timeframe%'
  loop
    execute format('alter table public.candles drop constraint %I', c);
  end loop;
end $$;
alter table public.candles
  add constraint candles_timeframe_check check (timeframe in ('1m', '5m', '15m', '1h'));

-- ---------------------------------------------------------------------------
-- Dynamic universe state + higher-timeframe backfill marker
-- ---------------------------------------------------------------------------
alter table public.market_pairs add column if not exists in_universe boolean not null default false;
alter table public.market_pairs add column if not exists universe_rank integer;
alter table public.market_pairs add column if not exists universe_since timestamptz;
create index if not exists market_pairs_universe_idx on public.market_pairs (in_universe) where in_universe;

alter table public.pair_sync_state add column if not exists htf_backfilled_at timestamptz;

-- ---------------------------------------------------------------------------
-- begin_run: analyse pinned (is_tracked) + dynamic universe + any pair with an open position
-- ---------------------------------------------------------------------------
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
       set status = 'SKIPPED', finished_at = now(), error = 'pipeline lock held by another run'
     where id = v_run_id;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'run_id', v_run_id);
  end if;

  select * into v_account from paper_accounts where name = 'default';
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
        'is_tracked', p.is_tracked,
        'in_universe', p.in_universe,
        'trade_min_base_currency', p.trade_min_base_currency,
        'covered_until', s.covered_until,
        'last_trade_time', s.last_trade_time,
        'last_trade_tid', s.last_trade_tid,
        'htf_backfilled_at', s.htf_backfilled_at
      ) order by p.id)
      from market_pairs p left join pair_sync_state s on s.pair_id = p.id
      where p.is_tracked or p.in_universe
         or exists (select 1 from paper_positions pp
                    where pp.pair_id = p.id and pp.account_id = v_account.id and pp.status = 'OPEN')), '[]'::jsonb),
    'catalog', coalesce((select jsonb_object_agg(id, is_maintenance) from market_pairs), '{}'::jsonb),
    'open_positions', coalesce((
      select jsonb_agg(to_jsonb(pp)) from paper_positions pp
      where pp.account_id = v_account.id and pp.status = 'OPEN'), '[]'::jsonb),
    'day_start_equity', (
      select equity from portfolio_snapshots
      where account_id = v_account.id and snapshot_time >= greatest(v_day_start, v_account.reset_at)
      order by snapshot_time asc limit 1),
    'pair_catalog_age_seconds', (
      select extract(epoch from now() - min(updated_at))::int from market_pairs where is_tracked)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- set_universe: replace the dynamic member list atomically
-- p_members = [{ "id": "pepeidr", "rank": 1 }, ...]
-- ---------------------------------------------------------------------------
create or replace function public.set_universe(p_members jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare v_off int; v_on int;
begin
  update market_pairs p
     set in_universe = false, universe_rank = null, universe_since = null
   where p.in_universe
     and not exists (select 1 from jsonb_to_recordset(p_members) as x(id text, rank int) where x.id = p.id);
  get diagnostics v_off = row_count;

  update market_pairs p
     set universe_rank = x.rank,
         universe_since = case when p.in_universe then coalesce(p.universe_since, now()) else now() end,
         in_universe = true
    from jsonb_to_recordset(p_members) as x(id text, rank int)
   where p.id = x.id;
  get diagnostics v_on = row_count;

  return jsonb_build_object('removed', v_off, 'members', v_on);
end;
$$;

-- ---------------------------------------------------------------------------
-- Several timeframes in one round trip: { "15m": { pair: rows }, "1h": { pair: rows } }
-- ---------------------------------------------------------------------------
create or replace function public.get_recent_candles_multi(
  p_pairs text[], p_timeframes text[], p_limit integer default 120
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(tf, public.get_recent_candles(p_pairs, tf, p_limit)), '{}'::jsonb)
  from unnest(p_timeframes) as tf;
$$;

-- ---------------------------------------------------------------------------
-- ingest_market: sync rows may carry htf_backfilled_at
-- ---------------------------------------------------------------------------
create or replace function public.ingest_market(
  p_pairs jsonb default '[]',
  p_tickers_latest jsonb default '[]',
  p_tickers_history jsonb default '[]',
  p_trades jsonb default '[]',
  p_candles jsonb default '[]',
  p_sync jsonb default '[]'
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_pairs int := 0; v_latest int := 0; v_hist int := 0; v_trades int := 0; v_candles int := 0;
begin
  insert into market_pairs (id, symbol, ticker_id, base_currency, traded_currency, description,
                            price_precision, trade_min_base_currency, trade_fee_percent_taker, is_maintenance, updated_at)
  select x.id, x.symbol, x.ticker_id, x.base_currency, x.traded_currency, x.description,
         x.price_precision, x.trade_min_base_currency, x.trade_fee_percent_taker, coalesce(x.is_maintenance, false), now()
  from jsonb_to_recordset(p_pairs) as x(id text, symbol text, ticker_id text, base_currency text, traded_currency text,
       description text, price_precision numeric, trade_min_base_currency numeric, trade_fee_percent_taker numeric, is_maintenance boolean)
  on conflict (id) do update set
    symbol = excluded.symbol, ticker_id = excluded.ticker_id, description = excluded.description,
    price_precision = excluded.price_precision, trade_min_base_currency = excluded.trade_min_base_currency,
    trade_fee_percent_taker = excluded.trade_fee_percent_taker, is_maintenance = excluded.is_maintenance,
    updated_at = now();
  get diagnostics v_pairs = row_count;

  insert into market_tickers_latest (pair_id, ticker_id, name, last, bid, ask, high, low, vol_traded, vol_idr,
                                     price_24h, change_24h_pct, server_time, updated_at)
  select x.pair_id, x.ticker_id, x.name, x.last, x.bid, x.ask, x.high, x.low, x.vol_traded, x.vol_idr,
         x.price_24h, x.change_24h_pct, x.server_time, now()
  from jsonb_to_recordset(p_tickers_latest) as x(pair_id text, ticker_id text, name text, last numeric, bid numeric,
       ask numeric, high numeric, low numeric, vol_traded numeric, vol_idr numeric, price_24h numeric,
       change_24h_pct numeric, server_time timestamptz)
  on conflict (pair_id) do update set
    ticker_id = excluded.ticker_id, name = excluded.name, last = excluded.last, bid = excluded.bid, ask = excluded.ask,
    high = excluded.high, low = excluded.low, vol_traded = excluded.vol_traded, vol_idr = excluded.vol_idr,
    price_24h = excluded.price_24h, change_24h_pct = excluded.change_24h_pct,
    server_time = excluded.server_time, updated_at = now()
  where excluded.server_time >= market_tickers_latest.server_time;
  get diagnostics v_latest = row_count;

  insert into market_tickers (pair_id, captured_at, last, bid, ask, high, low, vol_traded, vol_idr, change_24h_pct, server_time)
  select x.pair_id, x.captured_at, x.last, x.bid, x.ask, x.high, x.low, x.vol_traded, x.vol_idr, x.change_24h_pct, x.server_time
  from jsonb_to_recordset(p_tickers_history) as x(pair_id text, captured_at timestamptz, last numeric, bid numeric, ask numeric,
       high numeric, low numeric, vol_traded numeric, vol_idr numeric, change_24h_pct numeric, server_time timestamptz)
  where exists (select 1 from market_pairs p where p.id = x.pair_id)
  on conflict (pair_id, captured_at) do nothing;
  get diagnostics v_hist = row_count;

  insert into market_trades (pair_id, tid, traded_at, price, amount, side)
  select x.pair_id, x.tid, x.traded_at, x.price, x.amount, x.side
  from jsonb_to_recordset(p_trades) as x(pair_id text, tid text, traded_at timestamptz, price numeric, amount numeric, side text)
  on conflict (pair_id, tid) do nothing;
  get diagnostics v_trades = row_count;

  insert into candles (pair_id, timeframe, open_time, open, high, low, close, volume, trade_count, is_closed, source, updated_at)
  select x.pair_id, x.timeframe, x.open_time, x.open, x.high, x.low, x.close, x.volume, x.trade_count, x.is_closed, x.source, now()
  from jsonb_to_recordset(p_candles) as x(pair_id text, timeframe text, open_time timestamptz, open numeric, high numeric,
       low numeric, close numeric, volume numeric, trade_count int, is_closed boolean, source text)
  on conflict (pair_id, timeframe, open_time) do update set
    open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
    volume = excluded.volume, trade_count = excluded.trade_count, is_closed = excluded.is_closed,
    source = excluded.source, updated_at = now()
  where not candles.is_closed
     or (candles.source <> 'trades' and excluded.source = 'trades')
     or (candles.source = excluded.source and excluded.trade_count >= candles.trade_count);
  get diagnostics v_candles = row_count;

  insert into pair_sync_state (pair_id, covered_until, last_trade_time, last_trade_tid, htf_backfilled_at, updated_at)
  select x.pair_id, x.covered_until, x.last_trade_time, x.last_trade_tid, x.htf_backfilled_at, now()
  from jsonb_to_recordset(p_sync) as x(pair_id text, covered_until timestamptz, last_trade_time timestamptz, last_trade_tid text,
       htf_backfilled_at timestamptz)
  where exists (select 1 from market_pairs p where p.id = x.pair_id)
  on conflict (pair_id) do update set
    covered_until = greatest(coalesce(excluded.covered_until, pair_sync_state.covered_until), coalesce(pair_sync_state.covered_until, excluded.covered_until)),
    last_trade_time = coalesce(excluded.last_trade_time, pair_sync_state.last_trade_time),
    last_trade_tid = coalesce(excluded.last_trade_tid, pair_sync_state.last_trade_tid),
    htf_backfilled_at = coalesce(excluded.htf_backfilled_at, pair_sync_state.htf_backfilled_at),
    updated_at = now();

  return jsonb_build_object('pairs', v_pairs, 'tickers_latest', v_latest, 'tickers_history', v_hist,
                            'trades', v_trades, 'candles', v_candles);
end;
$$;

-- ---------------------------------------------------------------------------
-- save_analysis: also persists higher-timeframe candles aggregated from 5m (optional 3rd argument).
-- The old 2-argument version is dropped so PostgREST resolves calls unambiguously; callers that send
-- only p_indicators + p_signals keep working through the default.
-- ---------------------------------------------------------------------------
drop function if exists public.save_analysis(jsonb, jsonb);
create or replace function public.save_analysis(p_indicators jsonb, p_signals jsonb, p_candles jsonb default '[]')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_signals jsonb;
  v_candles int := 0;
begin
  insert into indicators (pair_id, timeframe, open_time, close, ema9, ema21, ema50, rsi14, macd, macd_signal, macd_hist,
                          atr14, vol_ma20, support, resistance, computed_at)
  select x.pair_id, x.timeframe, x.open_time, x.close, x.ema9, x.ema21, x.ema50, x.rsi14, x.macd, x.macd_signal, x.macd_hist,
         x.atr14, x.vol_ma20, x.support, x.resistance, now()
  from jsonb_to_recordset(p_indicators) as x(pair_id text, timeframe text, open_time timestamptz, close numeric,
       ema9 numeric, ema21 numeric, ema50 numeric, rsi14 numeric, macd numeric, macd_signal numeric, macd_hist numeric,
       atr14 numeric, vol_ma20 numeric, support numeric, resistance numeric)
  on conflict (pair_id, timeframe, open_time) do update set
    close = excluded.close, ema9 = excluded.ema9, ema21 = excluded.ema21, ema50 = excluded.ema50, rsi14 = excluded.rsi14,
    macd = excluded.macd, macd_signal = excluded.macd_signal, macd_hist = excluded.macd_hist, atr14 = excluded.atr14,
    vol_ma20 = excluded.vol_ma20, support = excluded.support, resistance = excluded.resistance, computed_at = now();

  insert into candles (pair_id, timeframe, open_time, open, high, low, close, volume, trade_count, is_closed, source, updated_at)
  select x.pair_id, x.timeframe, x.open_time, x.open, x.high, x.low, x.close, x.volume, x.trade_count, true, x.source, now()
  from jsonb_to_recordset(coalesce(p_candles, '[]'::jsonb)) as x(pair_id text, timeframe text, open_time timestamptz, open numeric,
       high numeric, low numeric, close numeric, volume numeric, trade_count int, source text)
  where x.timeframe in ('15m', '1h')
  on conflict (pair_id, timeframe, open_time) do update set
    open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
    volume = excluded.volume, trade_count = excluded.trade_count, is_closed = true,
    source = excluded.source, updated_at = now()
  where not candles.is_closed
     or (candles.source <> 'trades' and excluded.source = 'trades')
     or (candles.source = excluded.source and excluded.trade_count >= candles.trade_count);
  get diagnostics v_candles = row_count;

  with ins as (
    insert into trading_signals (pair_id, timeframe, candle_time, side, price, strength, reasons, indicators, strategy)
    select x.pair_id, x.timeframe, x.candle_time, x.side, x.price, x.strength, x.reasons, x.indicators, coalesce(x.strategy, 'ema_rsi_volume')
    from jsonb_to_recordset(p_signals) as x(pair_id text, timeframe text, candle_time timestamptz, side text, price numeric,
         strength numeric, reasons jsonb, indicators jsonb, strategy text)
    on conflict (pair_id, timeframe, candle_time, side) do nothing
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_signals from ins;

  return jsonb_build_object('new_signals', v_signals, 'htf_candles', v_candles);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: backend-only RPCs
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'begin_run(timestamptz,text,integer)', 'set_universe(jsonb)',
    'get_recent_candles_multi(text[],text[],integer)',
    'ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'save_analysis(jsonb,jsonb,jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
