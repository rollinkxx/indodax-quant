-- Bound the tables that grow without limit, and drop an index that duplicates the primary key.
--
-- On 2026-11-19 the database held 306 MB of a 500 MB free-tier quota, with `public` at 294 MB.
-- Nothing was failing yet (no SQLSTATE 53100 in any of 8,967 runs), but two tables had no
-- retention at all and grew forever:
--
--   candles (5m)   510,601 rows, 188 MB, +8,453 rows/day, no retention
--   indicators      35,989 rows,  10 MB, +5,787 rows/day, no retention
--
-- run_retention() already trimmed 1m candles, trades, tickers, logs and snapshots, but 5m
-- candles are the largest table in the database and nothing ever deleted a single row from them.
-- The other policies were also far more generous than any reader needs: nothing reads an
-- indicator older than the last 1,000 bars (3.5 days at 5m), and /api/market/history caps its
-- window at 10,080 minutes (7 days), so 30 days of tickers were pure waste.
--
-- 5m candles keep 45 days: a stored-only backtest needs roughly 1,000 bars for the 70/30 split,
-- and research that wants more pulls INDODAX official history in memory (BACKTEST_HISTORY_DAYS,
-- up to 180). 45 days leaves room to re-run a comparison without re-fetching.
--
-- Deletes are batched so the hourly run never holds a long lock on a large table. Steady state
-- after this settles is roughly 300 MB, and the index drop below returns 51 MB immediately.

create or replace function public.run_retention()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  a int; b int; c int; d int; e int; f int; g int;
  n int;
begin
  delete from market_trades where traded_at < now() - interval '3 days'; get diagnostics a = row_count;
  delete from market_tickers where captured_at < now() - interval '8 days'; get diagnostics b = row_count;
  delete from candles where timeframe = '1m' and open_time < now() - interval '7 days'; get diagnostics c = row_count;
  delete from execution_logs where started_at < now() - interval '7 days'; get diagnostics d = row_count;
  delete from portfolio_snapshots where snapshot_time < now() - interval '90 days'
    and extract(minute from snapshot_time) <> 0; get diagnostics e = row_count;
  delete from indicators where open_time < now() - interval '7 days'; get diagnostics f = row_count;

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
    'indicators', f, 'candles_5m', g
  );
end;
$$;

-- candles_pkey is (pair_id, timeframe, open_time); candles_lookup_idx was the same three columns
-- with a DESC suffix. A btree can be scanned backwards, so EXPLAIN shows both the ASC research
-- query and the DESC RPC using candles_pkey. The duplicate cost 51 MB and every insert wrote it
-- twice. Plain DROP INDEX: the migration runner submits each file as one implicit transaction,
-- where CONCURRENTLY is not allowed.
drop index if exists public.candles_lookup_idx;

revoke all on function public.run_retention() from public, anon, authenticated;
grant execute on function public.run_retention() to service_role;
