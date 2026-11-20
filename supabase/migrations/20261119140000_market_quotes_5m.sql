-- WP1c: a long-lived 5m bid/ask quote series.
--
-- The backtest never charged the quoted spread because the only spread source, `market_tickers`,
-- is deleted after 8 days by run_retention(). A 60-day backtest therefore priced every entry at
-- the mid plus slippage, which understates cost exactly on the illiquid pairs where spread is the
-- dominant cost. This table keeps one row per pair per closed 5m bucket — the last observed quote
-- in that bucket — for at least 400 days.
--
-- Volume is tiny: ~28 universe pairs x 288 buckets/day = ~8k rows/day, ~3.2M rows/year.
-- Non-destructive: it only creates a new table and adds a retention rule for it.

create table if not exists public.market_quotes_5m (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  open_time timestamptz not null,                 -- start of the closed 5m bucket (UTC)
  bid_close numeric not null check (bid_close >= 0),
  ask_close numeric not null check (ask_close >= 0),
  spread_pct numeric not null check (spread_pct >= 0),
  captured_at timestamptz not null default now(),
  primary key (pair_id, open_time)
);

comment on table public.market_quotes_5m is
  'One bid/ask snapshot per pair per closed 5m bucket (the last quote observed in the bucket). Feeds quote-aware backtests; retained >= 400 days.';

-- Research reads scan by pair over long ranges; the primary key already covers (pair_id, open_time).
create index if not exists market_quotes_5m_open_time_idx
  on public.market_quotes_5m (open_time);

alter table public.market_quotes_5m enable row level security;

-- Backend-only: the Worker writes with the service role, which bypasses RLS. No client policy is
-- intentional, matching market_tickers.
revoke all on public.market_quotes_5m from anon, authenticated;

-- Upsert helper. A closed 5m bucket keeps the LAST observed quote in that bucket: the worker ticks
-- every minute, so a bucket is written up to five times and only the final write should survive.
-- Guarding on `captured_at` makes the row order-independent, which matters because a retried tick
-- can arrive after a newer one.
create or replace function public.ingest_quotes_5m(p_quotes jsonb default '[]')
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_rows int := 0;
begin
  insert into market_quotes_5m (pair_id, open_time, bid_close, ask_close, spread_pct, captured_at)
  select x.pair_id, x.open_time, x.bid_close, x.ask_close, x.spread_pct, coalesce(x.captured_at, now())
  from jsonb_to_recordset(p_quotes) as x(pair_id text, open_time timestamptz, bid_close numeric,
       ask_close numeric, spread_pct numeric, captured_at timestamptz)
  where exists (select 1 from market_pairs p where p.id = x.pair_id)
    and x.bid_close > 0 and x.ask_close > 0 and x.ask_close >= x.bid_close
  on conflict (pair_id, open_time) do update set
    bid_close = excluded.bid_close, ask_close = excluded.ask_close,
    spread_pct = excluded.spread_pct, captured_at = excluded.captured_at
  where excluded.captured_at >= market_quotes_5m.captured_at;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('quotes_5m', v_rows);
end;
$$;

-- Backend-only writer, matching every other RPC in this schema.
revoke all on function public.ingest_quotes_5m(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_quotes_5m(jsonb) to service_role;

-- Extend the existing retention routine so the quote history is bounded at 400 days. The routine is
-- recreated in full because a PostgreSQL function body cannot be patched in place. Everything
-- before the new quotes line is byte-identical to 20261119130000, including the batch size, the
-- row-count semantics of `g` and the JSON key names, so this migration only adds a rule.
create or replace function public.run_retention()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  a int; b int; c int; d int; e int; f int; g int;
  n int;
  h int;
begin
  delete from market_trades where traded_at < now() - interval '3 days'; get diagnostics a = row_count;
  delete from market_tickers where captured_at < now() - interval '8 days'; get diagnostics b = row_count;
  delete from candles where timeframe = '1m' and open_time < now() - interval '7 days'; get diagnostics c = row_count;
  delete from execution_logs where started_at < now() - interval '7 days'; get diagnostics d = row_count;
  delete from portfolio_snapshots where snapshot_time < now() - interval '90 days'
    and extract(minute from snapshot_time) <> 0; get diagnostics e = row_count;
  delete from indicators where open_time < now() - interval '7 days'; get diagnostics f = row_count;
  delete from market_quotes_5m where open_time < now() - interval '400 days'; get diagnostics h = row_count;

  -- 5m candles are the big one: clear in bounded batches so the first run after this migration
  -- cannot lock the table for the whole delete.
  g := 0;
  loop
    delete from candles
    where ctid in (
      select ctid from candles
      where timeframe = '5m' and open_time < now() - interval '45 days'
      limit 50000
    );
    get diagnostics n = row_count;
    g := g + n;
    exit when n = 0;
  end loop;

  return jsonb_build_object(
    'trades', a, 'tickers', b, 'candles_1m', c, 'execution_logs', d, 'snapshots', e,
    'indicators', f, 'candles_5m', g, 'market_quotes_5m', h
  );
end;
$$;
