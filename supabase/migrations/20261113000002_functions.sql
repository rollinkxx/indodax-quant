-- INDODAX QUANT — RPC functions used by the Cloudflare Worker (service role only)

-- ---------------------------------------------------------------------------
-- Run lifecycle: idempotency per cron tick + concurrency lock
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
  -- Jakarta midnight (UTC+7) expressed in UTC
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
      where p.is_tracked), '[]'::jsonb),
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

create or replace function public.finish_run(
  p_run_id bigint, p_status text, p_steps jsonb, p_error text default null
) returns void
language plpgsql
set search_path = public
as $$
begin
  update execution_logs
     set status = p_status,
         steps = coalesce(p_steps, '{}'::jsonb),
         error = p_error,
         finished_at = now(),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
   where id = p_run_id;
  update system_locks set locked_until = now(), owner = null
   where name = 'pipeline' and owner = p_run_id::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Market ingestion (one round trip per run)
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

  -- Closed candles from trade data are authoritative; never overwrite them with synthetic/history rows.
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

  insert into pair_sync_state (pair_id, covered_until, last_trade_time, last_trade_tid, updated_at)
  select x.pair_id, x.covered_until, x.last_trade_time, x.last_trade_tid, now()
  from jsonb_to_recordset(p_sync) as x(pair_id text, covered_until timestamptz, last_trade_time timestamptz, last_trade_tid text)
  on conflict (pair_id) do update set
    covered_until = greatest(coalesce(excluded.covered_until, pair_sync_state.covered_until), coalesce(pair_sync_state.covered_until, excluded.covered_until)),
    last_trade_time = coalesce(excluded.last_trade_time, pair_sync_state.last_trade_time),
    last_trade_tid = coalesce(excluded.last_trade_tid, pair_sync_state.last_trade_tid),
    updated_at = now();

  return jsonb_build_object('pairs', v_pairs, 'tickers_latest', v_latest, 'tickers_history', v_hist,
                            'trades', v_trades, 'candles', v_candles);
end;
$$;

create or replace function public.get_recent_candles(
  p_pairs text[], p_timeframe text, p_limit integer default 200
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(pair_id, rows), '{}'::jsonb)
  from (
    select c.pair_id,
           jsonb_agg(jsonb_build_array(extract(epoch from c.open_time)::bigint, c.open, c.high, c.low, c.close, c.volume, c.source)
                     order by c.open_time) as rows
    from (
      select pair_id, open_time, open, high, low, close, volume, source,
             row_number() over (partition by pair_id order by open_time desc) as rn
      from candles
      where pair_id = any(p_pairs) and timeframe = p_timeframe and is_closed
    ) c
    where c.rn <= p_limit
    group by c.pair_id
  ) t;
$$;

create or replace function public.save_analysis(p_indicators jsonb, p_signals jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_signals jsonb;
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

  with ins as (
    insert into trading_signals (pair_id, timeframe, candle_time, side, price, strength, reasons, indicators, strategy)
    select x.pair_id, x.timeframe, x.candle_time, x.side, x.price, x.strength, x.reasons, x.indicators, coalesce(x.strategy, 'ema_rsi_volume')
    from jsonb_to_recordset(p_signals) as x(pair_id text, timeframe text, candle_time timestamptz, side text, price numeric,
         strength numeric, reasons jsonb, indicators jsonb, strategy text)
    on conflict (pair_id, timeframe, candle_time, side) do nothing
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_signals from ins;

  return jsonb_build_object('new_signals', v_signals);
end;
$$;

-- ---------------------------------------------------------------------------
-- Paper trading — atomic, idempotent balance mutations
-- ---------------------------------------------------------------------------
create or replace function public.paper_open_position(
  p_account_id bigint,
  p_pair_id text,
  p_qty numeric,
  p_requested_price numeric,
  p_fill_price numeric,
  p_fee numeric,
  p_slippage_bps numeric,
  p_stop_loss numeric,
  p_take_profit numeric,
  p_signal_id bigint,
  p_idempotency_key text,
  p_reason text default 'SIGNAL'
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_acc paper_accounts;
  v_cost numeric;
  v_notional numeric;
  v_pos_id bigint;
  v_order_id bigint;
begin
  if p_qty <= 0 or p_fill_price <= 0 or p_fee < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_order');
  end if;

  select * into v_acc from paper_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_not_found'); end if;
  if v_acc.status <> 'RUNNING' or v_acc.kill_switch then
    return jsonb_build_object('ok', false, 'reason', 'account_not_running');
  end if;
  if exists (select 1 from paper_orders where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;
  if exists (select 1 from paper_positions where account_id = p_account_id and pair_id = p_pair_id and status = 'OPEN') then
    return jsonb_build_object('ok', false, 'reason', 'position_already_open');
  end if;

  v_notional := round(p_qty * p_fill_price, 8);
  v_cost := v_notional + p_fee;
  if v_cost > v_acc.cash_balance then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_cash');
  end if;

  insert into paper_positions (account_id, pair_id, qty, entry_price, entry_fee, cost_basis, stop_loss, take_profit,
                               entry_signal_id, last_price)
  values (p_account_id, p_pair_id, p_qty, p_fill_price, p_fee, v_cost, p_stop_loss, p_take_profit, p_signal_id, p_fill_price)
  returning id into v_pos_id;

  insert into paper_orders (account_id, position_id, pair_id, side, reason, requested_price, fill_price, qty, notional, fee,
                            slippage_bps, signal_id, idempotency_key)
  values (p_account_id, v_pos_id, p_pair_id, 'BUY', p_reason, p_requested_price, p_fill_price, p_qty, v_notional, p_fee,
          p_slippage_bps, p_signal_id, p_idempotency_key)
  returning id into v_order_id;

  update paper_accounts
     set cash_balance = cash_balance - v_cost,
         total_fees = total_fees + p_fee,
         updated_at = now()
   where id = p_account_id;

  return jsonb_build_object('ok', true, 'position_id', v_pos_id, 'order_id', v_order_id,
                            'cost', v_cost, 'cash_after', v_acc.cash_balance - v_cost);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'duplicate');
end;
$$;

create or replace function public.paper_close_position(
  p_position_id bigint,
  p_requested_price numeric,
  p_fill_price numeric,
  p_fee numeric,
  p_slippage_bps numeric,
  p_reason text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_pos paper_positions;
  v_notional numeric;
  v_proceeds numeric;
  v_pnl numeric;
  v_order_id bigint;
begin
  if p_fill_price <= 0 or p_fee < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_order');
  end if;

  select * into v_pos from paper_positions where id = p_position_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'position_not_found'); end if;
  if v_pos.status <> 'OPEN' then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;

  perform 1 from paper_accounts where id = v_pos.account_id for update;

  v_notional := round(v_pos.qty * p_fill_price, 8);
  v_proceeds := v_notional - p_fee;
  v_pnl := v_proceeds - v_pos.cost_basis;

  insert into paper_orders (account_id, position_id, pair_id, side, reason, requested_price, fill_price, qty, notional, fee,
                            slippage_bps, realized_pnl, idempotency_key)
  values (v_pos.account_id, v_pos.id, v_pos.pair_id, 'SELL', p_reason, p_requested_price, p_fill_price, v_pos.qty, v_notional,
          p_fee, p_slippage_bps, v_pnl, 'close:' || v_pos.id)
  returning id into v_order_id;

  update paper_positions
     set status = 'CLOSED', exit_price = p_fill_price, exit_fee = p_fee, realized_pnl = v_pnl,
         exit_reason = p_reason, closed_at = now(), last_price = p_fill_price, unrealized_pnl = 0
   where id = v_pos.id;

  update paper_accounts
     set cash_balance = cash_balance + v_proceeds,
         realized_pnl = realized_pnl + v_pnl,
         total_fees = total_fees + p_fee,
         updated_at = now()
   where id = v_pos.account_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'position_id', v_pos.id, 'pair_id', v_pos.pair_id,
                            'proceeds', v_proceeds, 'realized_pnl', v_pnl);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'duplicate');
end;
$$;

-- Revalue open positions at bid, update equity/drawdown and write a snapshot for the minute
create or replace function public.paper_mark_to_market(
  p_account_id bigint, p_prices jsonb, p_snapshot_time timestamptz
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_acc paper_accounts;
  v_positions_value numeric;
  v_unrealized numeric;
  v_open int;
  v_equity numeric;
  v_peak numeric;
  v_dd numeric;
begin
  select * into v_acc from paper_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_not_found'); end if;

  update paper_positions pp
     set last_price = (p_prices ->> pp.pair_id)::numeric,
         unrealized_pnl = round(pp.qty * (p_prices ->> pp.pair_id)::numeric - pp.cost_basis, 8)
   where pp.account_id = p_account_id and pp.status = 'OPEN' and p_prices ? pp.pair_id
     and (p_prices ->> pp.pair_id)::numeric > 0;

  select coalesce(sum(qty * coalesce(last_price, entry_price)), 0),
         coalesce(sum(unrealized_pnl), 0), count(*)
    into v_positions_value, v_unrealized, v_open
    from paper_positions where account_id = p_account_id and status = 'OPEN';

  v_equity := v_acc.cash_balance + v_positions_value;
  v_peak := greatest(v_acc.peak_equity, v_equity);
  v_dd := case when v_peak > 0 then round((v_peak - v_equity) / v_peak * 100, 6) else 0 end;

  update paper_accounts
     set equity = v_equity, peak_equity = v_peak, unrealized_pnl = v_unrealized,
         max_drawdown_pct = greatest(max_drawdown_pct, v_dd), updated_at = now()
   where id = p_account_id;

  insert into portfolio_snapshots (account_id, snapshot_time, cash, positions_value, equity, realized_pnl,
                                   unrealized_pnl, drawdown_pct, open_positions)
  values (p_account_id, p_snapshot_time, v_acc.cash_balance, v_positions_value, v_equity, v_acc.realized_pnl,
          v_unrealized, v_dd, v_open)
  on conflict (account_id, snapshot_time) do update set
    cash = excluded.cash, positions_value = excluded.positions_value, equity = excluded.equity,
    realized_pnl = excluded.realized_pnl, unrealized_pnl = excluded.unrealized_pnl,
    drawdown_pct = excluded.drawdown_pct, open_positions = excluded.open_positions;

  return jsonb_build_object('ok', true, 'equity', v_equity, 'cash', v_acc.cash_balance, 'positions_value', v_positions_value,
                            'unrealized_pnl', v_unrealized, 'drawdown_pct', v_dd, 'peak_equity', v_peak,
                            'max_drawdown_pct', greatest(v_acc.max_drawdown_pct, v_dd), 'open_positions', v_open);
end;
$$;

create or replace function public.paper_set_status(
  p_account_id bigint, p_status text, p_reason text default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_acc paper_accounts;
begin
  select * into v_acc from paper_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_not_found'); end if;

  if p_status = 'RUNNING' then
    if v_acc.status = 'KILLED' or v_acc.kill_switch then
      return jsonb_build_object('ok', false, 'reason', 'kill_switch_active_reset_required');
    end if;
    update paper_accounts set status = 'RUNNING', started_at = now(), status_reason = p_reason, updated_at = now()
     where id = p_account_id;
  elsif p_status = 'STOPPED' then
    if v_acc.status = 'KILLED' then
      return jsonb_build_object('ok', false, 'reason', 'already_killed');
    end if;
    update paper_accounts set status = 'STOPPED', stopped_at = now(), status_reason = p_reason, updated_at = now()
     where id = p_account_id;
  elsif p_status = 'KILLED' then
    update paper_accounts set status = 'KILLED', kill_switch = true, stopped_at = now(), status_reason = p_reason,
                              updated_at = now()
     where id = p_account_id;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;
  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

create or replace function public.paper_reset_account(p_account_id bigint, p_initial_balance numeric default 10000000)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_acc paper_accounts;
begin
  select * into v_acc from paper_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_not_found'); end if;
  if v_acc.status = 'RUNNING' then return jsonb_build_object('ok', false, 'reason', 'stop_first'); end if;
  if exists (select 1 from paper_positions where account_id = p_account_id and status = 'OPEN') then
    return jsonb_build_object('ok', false, 'reason', 'open_positions_exist');
  end if;
  if p_initial_balance is null or p_initial_balance <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_balance');
  end if;
  update paper_accounts
     set initial_balance = p_initial_balance, cash_balance = p_initial_balance, equity = p_initial_balance,
         peak_equity = p_initial_balance, max_drawdown_pct = 0, realized_pnl = 0, unrealized_pnl = 0, total_fees = 0,
         status = 'STOPPED', kill_switch = false, status_reason = 'reset', reset_at = now(), updated_at = now()
   where id = p_account_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Notifications: claim-before-send dedupe
-- ---------------------------------------------------------------------------
create or replace function public.claim_notifications(p_items jsonb)
returns text[]
language sql
set search_path = public
as $$
  with ins as (
    insert into notification_logs (channel, event_type, dedupe_key, message, status)
    select 'telegram', x.event_type, x.dedupe_key, x.message, 'PENDING'
    from jsonb_to_recordset(p_items) as x(event_type text, dedupe_key text, message text)
    on conflict (dedupe_key) do nothing
    returning dedupe_key
  )
  select coalesce(array_agg(dedupe_key), '{}') from ins;
$$;

create or replace function public.complete_notifications(p_results jsonb)
returns void
language sql
set search_path = public
as $$
  update notification_logs n
     set status = x.status, error = x.error, sent_at = case when x.status = 'SENT' then now() else null end
    from jsonb_to_recordset(p_results) as x(dedupe_key text, status text, error text)
   where n.dedupe_key = x.dedupe_key;
$$;

-- ---------------------------------------------------------------------------
-- Retention (keeps the free tier database small)
-- ---------------------------------------------------------------------------
create or replace function public.run_retention()
returns jsonb
language plpgsql
set search_path = public
as $$
declare a int; b int; c int; d int; e int;
begin
  delete from market_trades where traded_at < now() - interval '3 days'; get diagnostics a = row_count;
  delete from market_tickers where captured_at < now() - interval '30 days'; get diagnostics b = row_count;
  delete from candles where timeframe = '1m' and open_time < now() - interval '7 days'; get diagnostics c = row_count;
  delete from execution_logs where started_at < now() - interval '14 days'; get diagnostics d = row_count;
  delete from portfolio_snapshots where snapshot_time < now() - interval '90 days'
    and extract(minute from snapshot_time) <> 0; get diagnostics e = row_count;
  return jsonb_build_object('trades', a, 'tickers', b, 'candles_1m', c, 'execution_logs', d, 'snapshots', e);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: RPCs are backend-only
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'begin_run(timestamptz,text,integer)', 'finish_run(bigint,text,jsonb,text)',
    'ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'get_recent_candles(text[],text,integer)',
    'save_analysis(jsonb,jsonb)',
    'paper_open_position(bigint,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,bigint,text,text)',
    'paper_close_position(bigint,numeric,numeric,numeric,numeric,text)',
    'paper_mark_to_market(bigint,jsonb,timestamptz)', 'paper_set_status(bigint,text,text)',
    'paper_reset_account(bigint,numeric)', 'claim_notifications(jsonb)', 'complete_notifications(jsonb)',
    'run_retention()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security: read-only for registered app users, no client writes
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'market_pairs', 'market_tickers_latest', 'market_tickers', 'market_trades', 'candles', 'pair_sync_state',
    'indicators', 'trading_signals', 'strategy_configs', 'paper_accounts', 'paper_positions', 'paper_orders',
    'portfolio_snapshots', 'execution_logs', 'notification_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists app_users_read on public.%I', t);
    execute format('create policy app_users_read on public.%I for select to authenticated using (public.is_app_user())', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

alter table public.app_users enable row level security;
drop policy if exists app_users_self on public.app_users;
create policy app_users_self on public.app_users for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
revoke insert, update, delete, truncate on public.app_users from anon, authenticated;

alter table public.system_locks enable row level security;   -- no policies: service role only
revoke all on public.system_locks from anon, authenticated;

revoke execute on function public.is_app_user() from public, anon;
grant execute on function public.is_app_user() to authenticated, service_role;
