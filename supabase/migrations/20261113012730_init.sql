-- INDODAX QUANT — initial schema
-- All timestamps are stored as timestamptz (UTC). Dashboard renders Asia/Jakarta.
-- Writes happen only from the Cloudflare Worker using the Supabase service role.
-- Authenticated users listed in app_users get read-only access through RLS.

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------
create table if not exists public.app_users (
  email text primary key check (email = lower(email)),
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

create or replace function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- Market data
-- ---------------------------------------------------------------------------
create table if not exists public.market_pairs (
  id text primary key,                       -- e.g. btcidr
  symbol text not null,                      -- BTCIDR
  ticker_id text not null unique,            -- btc_idr
  base_currency text not null,               -- idr
  traded_currency text not null,             -- btc
  description text,
  price_precision numeric,
  trade_min_base_currency numeric,
  trade_fee_percent_taker numeric,
  is_maintenance boolean not null default false,
  is_tracked boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists market_pairs_tracked_idx on public.market_pairs (is_tracked) where is_tracked;

-- Latest ticker for every pair (upserted every minute)
create table if not exists public.market_tickers_latest (
  pair_id text primary key,
  ticker_id text not null,
  name text,
  last numeric not null check (last >= 0),
  bid numeric not null check (bid >= 0),
  ask numeric not null check (ask >= 0),
  high numeric,
  low numeric,
  vol_traded numeric,
  vol_idr numeric,
  price_24h numeric,
  change_24h_pct numeric,
  server_time timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Historical tickers (tracked pairs, one row per minute)
create table if not exists public.market_tickers (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  captured_at timestamptz not null,          -- minute bucket (UTC)
  last numeric not null check (last >= 0),
  bid numeric not null check (bid >= 0),
  ask numeric not null check (ask >= 0),
  high numeric,
  low numeric,
  vol_traded numeric,
  vol_idr numeric,
  change_24h_pct numeric,
  server_time timestamptz not null,
  primary key (pair_id, captured_at)
);
create index if not exists market_tickers_time_idx on public.market_tickers (captured_at desc);

-- Raw public trades (deduplicated by INDODAX trade id)
create table if not exists public.market_trades (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  tid text not null,                         -- INDODAX tid exceeds 2^53, keep as text
  traded_at timestamptz not null,
  price numeric not null check (price > 0),
  amount numeric not null check (amount >= 0),
  side text not null check (side in ('buy', 'sell')),
  primary key (pair_id, tid)
);
create index if not exists market_trades_pair_time_idx on public.market_trades (pair_id, traded_at desc);

-- Candlesticks built from trades (1m) and aggregated (5m)
create table if not exists public.candles (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  timeframe text not null check (timeframe in ('1m', '5m')),
  open_time timestamptz not null,
  open numeric not null check (open > 0),
  high numeric not null,
  low numeric not null,
  close numeric not null check (close > 0),
  volume numeric not null default 0 check (volume >= 0),
  trade_count integer not null default 0,
  is_closed boolean not null default true,
  source text not null default 'trades' check (source in ('trades', 'history', 'synthetic')),
  updated_at timestamptz not null default now(),
  primary key (pair_id, timeframe, open_time),
  check (high >= low and high >= open and high >= close and low <= open and low <= close)
);
create index if not exists candles_lookup_idx on public.candles (pair_id, timeframe, open_time desc);

-- Per-pair ingestion state used for gap detection / completeness
create table if not exists public.pair_sync_state (
  pair_id text primary key references public.market_pairs(id) on delete cascade,
  covered_until timestamptz,                 -- 1m candles complete up to (exclusive)
  last_trade_time timestamptz,
  last_trade_tid text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Analysis
-- ---------------------------------------------------------------------------
create table if not exists public.indicators (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  timeframe text not null,
  open_time timestamptz not null,
  close numeric not null,
  ema9 numeric, ema21 numeric, ema50 numeric,
  rsi14 numeric,
  macd numeric, macd_signal numeric, macd_hist numeric,
  atr14 numeric,
  vol_ma20 numeric,
  support numeric, resistance numeric,
  computed_at timestamptz not null default now(),
  primary key (pair_id, timeframe, open_time)
);

create table if not exists public.trading_signals (
  id bigint generated always as identity primary key,
  pair_id text not null references public.market_pairs(id) on delete cascade,
  timeframe text not null,
  candle_time timestamptz not null,
  side text not null check (side in ('BUY', 'SELL')),
  price numeric not null check (price > 0),
  strength numeric not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  indicators jsonb not null default '{}'::jsonb,
  strategy text not null default 'ema_rsi_volume',
  created_at timestamptz not null default now(),
  unique (pair_id, timeframe, candle_time, side)
);
create index if not exists trading_signals_time_idx on public.trading_signals (created_at desc);

-- ---------------------------------------------------------------------------
-- Strategy + paper trading
-- ---------------------------------------------------------------------------
create table if not exists public.strategy_configs (
  id bigint generated always as identity primary key,
  name text not null unique,
  is_active boolean not null default false,
  params jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
create unique index if not exists strategy_one_active_idx on public.strategy_configs (is_active) where is_active;

create table if not exists public.paper_accounts (
  id bigint generated always as identity primary key,
  name text not null unique,
  initial_balance numeric not null default 10000000 check (initial_balance > 0),
  cash_balance numeric not null default 10000000 check (cash_balance >= 0),
  equity numeric not null default 10000000,
  peak_equity numeric not null default 10000000,
  max_drawdown_pct numeric not null default 0,
  realized_pnl numeric not null default 0,
  unrealized_pnl numeric not null default 0,
  total_fees numeric not null default 0,
  status text not null default 'STOPPED' check (status in ('STOPPED', 'RUNNING', 'KILLED')),
  kill_switch boolean not null default false,
  status_reason text,
  started_at timestamptz,
  stopped_at timestamptz,
  reset_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.paper_positions (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.paper_accounts(id) on delete cascade,
  pair_id text not null references public.market_pairs(id),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  qty numeric not null check (qty > 0),
  entry_price numeric not null check (entry_price > 0),
  entry_fee numeric not null default 0 check (entry_fee >= 0),
  cost_basis numeric not null check (cost_basis > 0),     -- qty*entry + fee
  stop_loss numeric,
  take_profit numeric,
  entry_signal_id bigint references public.trading_signals(id),
  opened_at timestamptz not null default now(),
  last_price numeric,
  unrealized_pnl numeric not null default 0,
  exit_price numeric,
  exit_fee numeric,
  realized_pnl numeric,
  exit_reason text,
  closed_at timestamptz
);
-- Only one OPEN position per pair per account (prevents duplicate entries)
create unique index if not exists paper_positions_one_open_idx
  on public.paper_positions (account_id, pair_id) where status = 'OPEN';
create index if not exists paper_positions_account_idx on public.paper_positions (account_id, opened_at desc);

create table if not exists public.paper_orders (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.paper_accounts(id) on delete cascade,
  position_id bigint references public.paper_positions(id),
  pair_id text not null references public.market_pairs(id),
  side text not null check (side in ('BUY', 'SELL')),
  order_type text not null default 'MARKET',
  reason text not null check (reason in ('SIGNAL', 'STOP_LOSS', 'TAKE_PROFIT', 'MANUAL', 'KILL_SWITCH', 'MAX_DRAWDOWN')),
  requested_price numeric not null check (requested_price > 0),
  fill_price numeric not null check (fill_price > 0),
  qty numeric not null check (qty > 0),
  notional numeric not null check (notional > 0),
  fee numeric not null check (fee >= 0),
  slippage_bps numeric not null default 0,
  realized_pnl numeric,
  signal_id bigint references public.trading_signals(id),
  idempotency_key text not null unique,      -- guarantees no duplicate transaction
  status text not null default 'FILLED' check (status in ('FILLED')),
  is_simulated boolean not null default true check (is_simulated),
  created_at timestamptz not null default now()
);
create index if not exists paper_orders_account_idx on public.paper_orders (account_id, created_at desc);

create table if not exists public.portfolio_snapshots (
  account_id bigint not null references public.paper_accounts(id) on delete cascade,
  snapshot_time timestamptz not null,
  cash numeric not null,
  positions_value numeric not null,
  equity numeric not null,
  realized_pnl numeric not null,
  unrealized_pnl numeric not null,
  drawdown_pct numeric not null,
  open_positions integer not null default 0,
  primary key (account_id, snapshot_time)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------
create table if not exists public.execution_logs (
  id bigint generated always as identity primary key,
  scheduled_time timestamptz not null unique,   -- one run per cron tick (idempotency)
  trigger text not null default 'cron',
  status text not null check (status in ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  steps jsonb not null default '{}'::jsonb,
  error text
);
create index if not exists execution_logs_started_idx on public.execution_logs (started_at desc);

create table if not exists public.notification_logs (
  id bigint generated always as identity primary key,
  channel text not null default 'telegram',
  event_type text not null,
  dedupe_key text not null unique,
  message text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists notification_logs_created_idx on public.notification_logs (created_at desc);

create table if not exists public.system_locks (
  name text primary key,
  owner text,
  locked_until timestamptz not null default 'epoch'
);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
insert into public.app_users (email, role) values ('gsdrxx@gmail.com', 'admin')
  on conflict (email) do nothing;

insert into public.system_locks (name) values ('pipeline') on conflict do nothing;

insert into public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency, description, is_tracked) values
  ('btcidr', 'BTCIDR', 'btc_idr', 'idr', 'btc', 'BTC/IDR', true),
  ('ethidr', 'ETHIDR', 'eth_idr', 'idr', 'eth', 'ETH/IDR', true),
  ('xrpidr', 'XRPIDR', 'xrp_idr', 'idr', 'xrp', 'XRP/IDR', true),
  ('solidr', 'SOLIDR', 'sol_idr', 'idr', 'sol', 'SOL/IDR', true),
  ('dogeidr', 'DOGEIDR', 'doge_idr', 'idr', 'doge', 'DOGE/IDR', true)
on conflict (id) do update set is_tracked = true;

insert into public.strategy_configs (name, is_active, params) values (
  'EMA Crossover + RSI + Volume (5m)', true,
  '{
    "timeframe": "5m",
    "emaFast": 9, "emaSlow": 21, "emaTrend": 50,
    "rsiPeriod": 14, "rsiBuyMin": 50, "rsiBuyMax": 70, "rsiSellMax": 50,
    "volumeMaPeriod": 20, "volumeMultiplier": 1.2,
    "useTrendFilter": true,
    "atrPeriod": 14, "atrStopMultiplier": 1.5, "atrTakeProfitMultiplier": 3,
    "fallbackStopPct": 2, "fallbackTakeProfitPct": 4,
    "riskPerTradePct": 1, "maxPositionPct": 25, "maxOpenPositions": 3,
    "feePct": 0.3, "slippageBps": 10,
    "dailyLossLimitPct": 3, "maxDrawdownPct": 15,
    "minCandles": 60, "maxTickerAgeSeconds": 180,
    "notifySignals": true
  }'::jsonb
) on conflict (name) do nothing;

-- Paper trading is STOPPED at install time. An admin must press Start.
insert into public.paper_accounts (name, initial_balance, cash_balance, equity, peak_equity, status)
values ('default', 10000000, 10000000, 10000000, 10000000, 'STOPPED')
on conflict (name) do nothing;
