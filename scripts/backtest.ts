// Controlled, read-only strategy experiments. No live or paper orders are submitted.
// Compare the production setup (crossLookback=2) against only one changed variable (4),
// plus a separately labelled EMA21 pullback-reclaim continuation shadow variant.
// Exit-parameter sweeps are supported read-only via --overrides='{"trailDistanceAtr":2}'.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run backtest [--overrides=<json>] [pairId ...]
import {
  computeIndicators, diagnoseTrendContinuationWindow, evaluateMarketAction, evaluateSignalWindow,
  mergeParams, type StrategyParams,
} from '../shared/strategy';
import {
  aggregateComplete, applyMtfToMarketAction, buildHigherSeries, HIGHER_TFS, lastCompleteBucket,
  MTF_WINDOW, trendState, type TfState,
} from '../shared/mtf';
import { applyBacktestOverrides, parseBacktestOverrides } from '../shared/backtestOverrides';
import {
  buyFillPrice, computeStats, computeStops, dynamicSlippageBps, effectiveFeePct, entryGate, feeFor,
  netRewardRiskGate, positionSize, roundTripCostPct, sellFillPrice, signalExitCoversCosts, trailingStop,
} from '../shared/paper';
import { fillGaps, isValidCandle, type Candle } from '../shared/candles';
import { backtestScopeWarnings, hasBacktestDataQuality } from '../shared/backtestScope';
import { evaluateStrategyEvidence, evaluateExpectancyEvidence, evaluateNullModel, type EvidenceTrade } from '../shared/strategyEvidence';
import { IndodaxClient } from '../worker/src/indodax';
import { withIndodaxRelay } from '../worker/src/relay';
import { aggregateCompleteMinuteHistory, createBacktestHistoryRange, createRequestStartLimiter, filterBacktestCandlesToRange, mergeBacktestCandles, summarizeMinuteHistoryQuality, type BacktestHistoryRange } from './backtest-history';
import { finalizeEndOfDataTrade, resolveProtectiveExit } from './backtest-execution';

const HISTORY_CHUNK_SECONDS = 12 * 60 * 60;

// Nothing below runs on import. `scripts/backtest.ts` is imported by tests and by other scripts, and
// it used to call process.exit(1) from module scope when Supabase env was absent — so merely
// importing the pure simulation helpers killed the process.
interface SupabaseAccess {
  url: string;
  key: string;
  headers: Record<string, string>;
}

function supabaseAccess(): SupabaseAccess {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  const headers: Record<string, string> = { apikey: key, accept: 'application/json' };
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;
  return { url, key, headers };
}

async function get<T>(path: string): Promise<T> {
  const { url, headers } = supabaseAccess();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

function historyDaysRequested(): number {
  const days = Number(process.env.BACKTEST_HISTORY_DAYS ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 180) {
    throw new Error('BACKTEST_HISTORY_DAYS must be an integer from 0 to 180');
  }
  return days;
}

let indodaxClient: IndodaxClient | null = null;

function indodax(): IndodaxClient {
  if (indodaxClient) return indodaxClient;
  const { url, key } = supabaseAccess();
  const proxyUrl = process.env.INDODAX_PROXY_URL?.trim() || `${url}/functions/v1/indodax-proxy`;
  // INDODAX public endpoints document a 180 requests/minute quota. Share one 500ms start interval
  // across every pair and retry, leaving headroom for the Worker.
  const acquireSlot = createRequestStartLimiter(500);
  const rateLimitedFetch: typeof fetch = async (input, init) => {
    await acquireSlot();
    return fetch(input, init);
  };
  indodaxClient = new IndodaxClient(withIndodaxRelay(rateLimitedFetch, proxyUrl, key), { timeoutMs: 8_000, retries: 2 });
  return indodaxClient;
}

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number; source: string }
interface StoredPair {
  id: string; symbol: string; is_tracked: boolean; in_universe: boolean;
  trade_fee_percent_taker: number | null;
  /** INDODAX trade_min_base_currency (IDR). Live rejects a smaller order; the backtest must too. */
  trade_min_base_currency: number | null;
}
interface OfficialHistoryResult {
  candles: Candle[];
  metrics: {
    daysRequested: number;
    apiChunks: number;
    minuteBarsReceived: number;
    complete5mBars: number;
    expected5mBars: number;
    historyCoveragePct: number;
    receivedMinuteBars: number;
    expectedMinuteBars: number;
    uniqueValidMinuteBars: number;
    duplicateMinuteBars: number;
    missingMinuteBars: number;
    zeroVolumeMinuteBars: number;
    zeroVolume5mBars: number;
    activeVolume5mBars: number;
    activeVolumeCoveragePct: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    fromSec: number;
    toSec: number;
    from: string;
    to: string;
  };
}

async function loadStoredCandles(pair: string): Promise<Candle[]> {
  const rows: Row[] = [];
  const base = `candles?select=open_time,open,high,low,close,volume,trade_count,source&pair_id=eq.${pair}&timeframe=eq.5m&is_closed=eq.true&order=open_time.asc`;
  // Respect PostgREST max_rows settings instead of silently accepting a truncated first page.
  for (let offset = 0; offset < 10_000; offset += 1_000) {
    const page = await get<Row[]>(`${base}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  return rows.map((r): Candle => {
    const source: Candle['source'] = r.source === 'trades' || r.source === 'history' || r.source === 'synthetic'
      ? r.source : 'synthetic';
    const candle: Candle = {
      t: Math.floor(Date.parse(r.open_time) / 1000), o: +r.open, h: +r.high, l: +r.low, c: +r.close,
      v: +r.volume, n: Number.isFinite(+r.trade_count) ? +r.trade_count : 0, source,
    };
    return isValidCandle(candle) ? candle : { ...candle, source: 'synthetic', v: 0, n: 0 };
  }).filter((c) => Number.isFinite(c.t) && c.t % 300 === 0);
}

/** Pulls official 1m OHLC in 12h windows and aggregates only complete 5m buckets. */
async function loadOfficialHistory(symbol: string, range: BacktestHistoryRange): Promise<OfficialHistoryResult> {
  const { days, fromSec, toSec } = range;
  const oneMinute: Candle[] = [];
  let apiChunks = 0;

  for (let from = fromSec; from < toSec; from += HISTORY_CHUNK_SECONDS) {
    const endExclusive = Math.min(from + HISTORY_CHUNK_SECONDS, toSec);
    const lastClosedMinute = endExclusive - 60;
    if (lastClosedMinute < from) continue;
    const rows = await indodax().getHistory(symbol.toUpperCase(), '1', from, lastClosedMinute);
    oneMinute.push(...rows);
    apiChunks++;
  }

  const complete5m = aggregateCompleteMinuteHistory(oneMinute, fromSec, toSec);
  const quality = summarizeMinuteHistoryQuality(oneMinute, fromSec, toSec, complete5m);
  const expected5mBars = quality.expected5mBars;
  const historyCoveragePct = expected5mBars > 0
    ? Number((complete5m.length / expected5mBars * 100).toFixed(2)) : 0;
  return {
    candles: complete5m,
    metrics: {
      daysRequested: days,
      apiChunks,
      minuteBarsReceived: oneMinute.length,
      complete5mBars: complete5m.length,
      historyCoveragePct,
      ...quality,
      firstObservedAt: complete5m.length ? new Date(complete5m[0].t * 1000).toISOString() : null,
      lastObservedAt: complete5m.length ? new Date(complete5m[complete5m.length - 1].t * 1000).toISOString() : null,
      fromSec,
      toSec,
      from: new Date(fromSec * 1000).toISOString(),
      to: new Date(toSec * 1000).toISOString(),
    },
  };
}

async function loadCandles(pair: string, officialHistory?: OfficialHistoryResult): Promise<Candle[]> {
  const stored = await loadStoredCandles(pair);
  const history = officialHistory?.candles ?? [];
  const merged = mergeBacktestCandles(history, stored);
  // The requested evaluation window is a hard boundary. Persisted tail candles
  // outside it must not silently lengthen the sample or shift the 70/30 split.
  const scoped = officialHistory
    ? filterBacktestCandlesToRange(merged, officialHistory.metrics.fromSec, officialHistory.metrics.toSec)
    : merged;
  return fillGaps(scoped, inferIntervalSec(scoped));
}

async function loadQuotes5m(pair: string): Promise<QuoteRow[]> {
  const rows: QuoteRow[] = [];
  const base = `market_quotes_5m?select=open_time,spread_pct&pair_id=eq.${pair}&order=open_time.asc`;
  for (let offset = 0; offset < 400_000; offset += 1_000) {
    const page = await get<QuoteRow[]>(`${base}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  return rows;
}

export type ExperimentMode = 'crossover' | 'trend_continuation';

export interface QuoteRow { open_time: string; spread_pct: string | number }

/**
 * Build a lookup of recorded 5m spread by bucket start, for one pair.
 *
 * Returns null when the pair has no recorded quotes at all, which tells `simulate` to keep the
 * legacy mid-plus-slippage pricing rather than charge an invented spread. Missing individual
 * buckets are filled from the nearest earlier recorded bucket so a sparse minute still gets a
 * realistic (not zero) cost, but only within `QUOTE_MAX_AGE_SEC`: a quote captured days before the
 * bar says nothing about the book that bar traded against, and charging it would be an invention.
 */
export function buildSpreadLookup(rows: QuoteRow[]): ((t: number) => number | null) | null {
  if (!rows.length) return null;
  const points = rows
    .map((r) => ({ t: Math.floor(Date.parse(r.open_time) / 1000), s: Number(r.spread_pct) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.s) && r.s >= 0)
    .sort((a, b) => a.t - b.t);
  if (!points.length) return null;
  return (t: number): number | null => {
    // Binary search for the last bucket at or before t.
    let lo = 0;
    let hi = points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (found < 0) return null;
    return t - points[found].t <= QUOTE_MAX_AGE_SEC ? points[found].s : null;
  };
}

/** A recorded quote older than this is not evidence about the book at time `t`. */
export const QUOTE_MAX_AGE_SEC = 3600;

/**
 * Median gap between consecutive candle opens, snapped to a standard bar size.
 *
 * Research runs are not all 5m: the 4h cache and any aggregated series carry their own
 * interval, and treating them as 5m corrupts gap filling, MTF buckets and the time stop.
 */
export function inferIntervalSec(candles: { t: number }[]): number {
  if (candles.length < 3) return 300;
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].t - candles[i - 1].t;
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return 300;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const standard = [60, 180, 300, 600, 900, 1800, 3600, 7200, 14400, 86400];
  let best = standard[0];
  for (const s of standard) if (Math.abs(s - median) < Math.abs(best - median)) best = s;
  return best;
}

export interface SimTrade {
  pair: string;
  entry: number;
  exit: number;
  pnl: number;
  cost: number;
  reason: string;
  entryTime: number;
  exitTime: number;
  /** The exit bar touched both the stop and the target; stop-first was assumed. */
  ambiguousExit?: boolean;
}

/**
 * Per-pair candle-only simulation. Indicators use only current/past bars; entries fill on
 * the next observed candle open. startIndex makes a chronological holdout possible while
 * retaining pre-holdout indicator warm-up. MTF (15m/1h) gating/scoring is applied causally,
 * mirroring the pipeline; shared cross-pair cash/exposure is still not modelled.
 */
export function simulate(
  pair: string,
  candles: Candle[],
  p: StrategyParams,
  equity0: number,
  volIdr: number | null,
  mode: ExperimentMode = 'crossover',
  startIndex = 0,
  pairTakerFeePct: number | null = null,
  // WP1c: half-spread (%) at a bar's open time, from the recorded 5m quote series. When null the
  // series has no quote for that bucket and the fill falls back to mid + slippage, exactly as
  // before, so a pair with no quote history is priced no worse than the legacy model.
  spreadPctAt: ((t: number) => number | null) | null = null,
  // Live rejects an order below the pair's `trade_min_base_currency`. Defaulting here instead of
  // reading the catalog let the backtest take trades production would refuse once a pair's
  // minimum differs from 10,000 IDR.
  minNotional: number | null = null,
): SimTrade[] {
  // Infer the bar interval from the data instead of assuming 5m. The gap filler, the MTF bucket
  // aggregation, and the time stop all scale with it, so hardcoding 300 silently injected 11
  // synthetic bars between every real 1h candle and made every higher-timeframe run trade nothing.
  const intervalSec = inferIntervalSec(candles);
  const series = fillGaps(candles, intervalSec);
  // Charge the pair's real taker fee when feeModel='pair_taker', mirroring the paper pipeline.
  const feePct = effectiveFeePct(p, pairTakerFeePct);
  const rows = computeIndicators(series, p);
  const trades: SimTrade[] = [];
  const slip = p.dynamicSlippage ? dynamicSlippageBps(p.slippageBps, volIdr) : p.slippageBps;
  // Crossing the book costs half the quoted spread on entry (buy at ask) and on exit (sell at bid).
  // Candles are mid-based OHLC, so this is the only place the recorded spread can be charged.
  const halfSpreadPct = (t: number): number => {
    const s = spreadPctAt?.(t);
    return s !== null && s !== undefined && Number.isFinite(s) && s > 0 ? s / 2 : 0;
  };

  // Multi-timeframe parity with the paper pipeline (shared/mtf.ts), applied causally: the MTF state at
  // signal bar i aggregates only completed 15m/1h buckets ending at or before bar i. Higher-timeframe
  // candles are aggregated once from the full 5m series (the whole sample is present here, so the stored
  // HTF backfill the pipeline uses for older history is unnecessary), then each bar's state is served
  // from a cache keyed by bucket boundary, so cost stays ~O(bars) instead of recomputing per bar.
  // MTF confirmation only makes sense when the base series is finer than the bucket. A 4h or 1h
  // series cannot be aggregated down to 15m, so MTF is disabled rather than fed a meaningless
  // one-bar-per-bucket series.
  const mtfOn = p.mtfMode !== 'off' && intervalSec < Math.min(...HIGHER_TFS.map((h) => h.sec));
  const htfAggregated = mtfOn
    ? HIGHER_TFS.filter((h) => h.sec > intervalSec).map((h) => ({ tf: h.tf, sec: h.sec, candles: aggregateComplete(series, h.sec) }))
    : [];
  const tfStateCache = new Map<string, TfState>();
  const mtfStatesAt = (idx: number): TfState[] => htfAggregated.map((h) => {
    const lastComplete = lastCompleteBucket(series[idx].t, h.sec);
    const key = `${h.sec}:${lastComplete}`;
    const cached = tfStateCache.get(key);
    if (cached) return cached;
    const hs = buildHigherSeries([], h.candles, h.sec, lastComplete, MTF_WINDOW);
    const st = trendState(h.tf, hs, lastComplete, p);
    tfStateCache.set(key, st);
    return st;
  });
  let pos: {
    qty: number; entry: number; cost: number; sl: number; tp: number;
    openedIdx: number; entryTime: number;
  } | null = null;
  let equity = equity0;
  const win = Math.max(3, p.crossLookback + 1);
  const firstIndex = Math.max(p.minCandles, win, Math.floor(startIndex));
  for (let i = firstIndex; i < series.length; i++) {
    const c = series[i];
    // A zero-volume OHLC row has a price but no demonstrated executable trade.
    // It cannot trigger a simulated fill, protective exit, trailing stop or timer exit.
    if (c.source === 'synthetic' || c.v <= 0 || !isValidCandle(c)) continue;

    if (pos) {
      // The entry candle is deliberately processed on the next loop iteration;
      // if both protective levels are touched, stop loss takes precedence.
      // Candles are mid-based but the live engine reasons entirely in bid space: it compares the
      // best bid against the stop/take-profit and passes that same bid to sellFillPrice. Comparing
      // a mid low against a bid-derived stop would trigger stops late on wide pairs, so the whole
      // bar is converted to bid space here and the spread is charged exactly once, inside that.
      const bidAdj = 1 - halfSpreadPct(c.t) / 100;
      const bidCandle: Candle = {
        ...c, o: c.o * bidAdj, h: c.h * bidAdj, l: c.l * bidAdj, c: c.c * bidAdj,
      };
      const protectiveExit = resolveProtectiveExit(pos.sl, pos.tp, bidCandle, pos.entry);
      let exit: number | null = protectiveExit?.price ?? null;
      let reason = protectiveExit?.reason ?? '';
      if (exit === null) {
        // Include the bar's quoted spread in the break-even floor, matching the live pipeline, which
        // passes the pair's spread into roundTripCostPct. Without it the backtest ratchets to a stop
        // that is above fees+slippage but still below the bid-side break-even on a wide pair.
        const nsl = trailingStop({ entry_price: pos.entry, stop_loss: pos.sl }, bidCandle.c, rows[i].atr14, p, roundTripCostPct(feePct, slip, spreadPctAt?.(c.t) ?? 0));
        if (nsl !== null) pos.sl = nsl;
        if (p.timeStopMinutes > 0 && (i - pos.openedIdx) * (intervalSec / 60) >= p.timeStopMinutes) {
          exit = bidCandle.c; reason = 'TIME_STOP';
        }
      }
      if (exit === null && hasBacktestDataQuality(series, i, p.minCandles, intervalSec)) {
        const sell = evaluateSignalWindow(
          rows.slice(i - win + 1, i + 1), series.slice(i - win + 1, i + 1).map((x) => x.v), p,
        );
        if (sell?.side === 'SELL' && signalExitCoversCosts({
          entryPrice: pos.entry, qty: pos.qty, costBasis: pos.cost, bid: bidCandle.c, feePct, slippageBps: slip,
        })) { exit = bidCandle.c; reason = 'SIGNAL'; }
      }
      if (exit !== null) {
        const fill = sellFillPrice(exit, slip);
        const fee = feeFor(pos.qty * fill, feePct);
        const pnl = pos.qty * fill - fee - pos.cost;
        equity += pnl;
        trades.push({
          pair, entry: pos.entry, exit: fill, pnl, cost: pos.cost, reason,
          entryTime: pos.entryTime, exitTime: c.t,
          ...(protectiveExit?.ambiguous ? { ambiguousExit: true } : {}),
        });
        pos = null;
      }
      continue;
    }

    if (!hasBacktestDataQuality(series, i, p.minCandles, intervalSec) || i + 1 >= series.length) continue;
    const windowRows = rows.slice(i - win + 1, i + 1);
    const windowVolumes = series.slice(i - win + 1, i + 1).map((x) => x.v);
    let isBuy: boolean;
    if (mode === 'crossover') {
      // Mirror the pipeline: raw 5m three-state decision, then MTF gating/scoring, then act on the
      // resulting signal. SELL is never blocked by MTF (it is an exit, handled above).
      const action = evaluateMarketAction(windowRows, windowVolumes, p);
      const finalAction = mtfOn ? applyMtfToMarketAction(action, mtfStatesAt(i), p.mtfMode).action : action;
      isBuy = finalAction.signal?.side === 'BUY';
    } else {
      isBuy = diagnoseTrendContinuationWindow(windowRows, windowVolumes, p).ready;
    }
    if (!isBuy) continue;

    const next = series[i + 1];
    if (next.source === 'synthetic' || !isValidCandle(next) || next.v <= 0) continue;
    // Live calls buyFillPrice(t.ask, slip); applying the half-spread to the mid first then slippage
    // keeps the same order of operations instead of compounding them in the other direction.
    const fill = buyFillPrice(next.o * (1 + halfSpreadPct(next.t) / 100), slip);
    const stops = computeStops(fill, rows[i].atr14, p);
    if (stops.method === 'rejected') continue;
    // Production applies entryGate against the live quote and skips wide_spread / price_drift /
    // stop_inside_spread entries; the backtest used to skip it entirely, so it opened trades the live
    // engine would have refused. Candles carry no bid/ask, so the book is rebuilt from the recorded
    // spread around the next bar's open, with the signal bar's close as the price the engine decided
    // on. Bars without a recorded quote keep the legacy behaviour (tight book) rather than inventing one.
    const entrySpreadPct = spreadPctAt?.(next.t) ?? null;
    if (entrySpreadPct !== null && entrySpreadPct > 0) {
      const halfPct = entrySpreadPct / 200;
      if (entryGate(
        { bid: next.o * (1 - halfPct), ask: next.o * (1 + halfPct), signalPrice: c.c, stopLoss: stops.stopLoss, fill },
        { maxEntrySpreadPct: p.maxEntrySpreadPct, maxEntryDriftPct: p.maxEntryDriftPct },
      )) continue;
    }
    if (netRewardRiskGate({
      entry: fill, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
      feePct, exitSlippageBps: slip, minRatio: p.minNetRewardRiskRatio,
    })) continue;
    // Size with the fee actually charged for this pair (effectiveFeePct), matching the live
    // pipeline. Passing `p` directly would size against `p.feePct` and, under feeModel
    // 'pair_taker', overstate position size and net reward/risk versus production.
    const size = positionSize({
      equity, cash: equity, entry: fill, stopLoss: stops.stopLoss,
      exitSlippageBps: slip, params: { ...p, feePct },
      ...(minNotional !== null && Number.isFinite(minNotional) && minNotional > 0 ? { minNotional } : {}),
    });
    if (size.qty <= 0) continue;
    pos = {
      qty: size.qty, entry: fill, cost: size.cost, sl: stops.stopLoss,
      tp: stops.takeProfit, openedIdx: i + 1, entryTime: next.t,
    };
    // Do not skip `next`: the next loop iteration must evaluate the entry candle's
    // high/low for same-candle stop-loss or take-profit execution.
  }

  // Close any remaining position at the final observed candle close. Without this,
  // an unfinished trade would disappear from win rate, PnL, expectancy, and drawdown.
  if (pos) {
    let lastObserved: Candle | null = null;
    for (let index = series.length - 1; index >= pos.openedIdx; index--) {
      const candidate = series[index];
      if (candidate.source !== 'synthetic' && candidate.v > 0 && isValidCandle(candidate)) {
        lastObserved = candidate;
        break;
      }
    }
    if (!lastObserved) throw new Error(`Open position for ${pair} has no final observed candle`);
    trades.push(finalizeEndOfDataTrade(pair, pos, lastObserved, slip, feePct, spreadPctAt?.(lastObserved.t) ?? 0));
  }

  return trades;
}

interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnlIdr: number;
  expectancyIdr: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  ambiguousExits: number;
  endOfDataExits: number;
  exitReasons: Record<string, number>;
}

function measure(trades: SimTrade[], initialEquity = 10_000_000): Metrics {
  const stats = computeStats(trades.map((t) => ({ realized_pnl: t.pnl, cost_basis: t.cost })));
  const winning = trades.filter((t) => t.pnl > 0);
  const losing = trades.filter((t) => t.pnl <= 0);
  const avgWinPct = winning.length
    ? winning.reduce((sum, t) => sum + t.pnl / t.cost * 100, 0) / winning.length : 0;
  const avgLossPct = losing.length
    ? losing.reduce((sum, t) => sum + t.pnl / t.cost * 100, 0) / losing.length : 0;
  let equity = initialEquity;
  let peak = equity;
  let maxDrawdownPct = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  return {
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRatePct: Number(stats.winRate.toFixed(2)),
    profitFactor: stats.profitFactor === null ? null : Number(stats.profitFactor.toFixed(3)),
    netPnlIdr: Number(stats.totalPnl.toFixed(2)),
    expectancyIdr: stats.trades ? Number((stats.totalPnl / stats.trades).toFixed(2)) : 0,
    avgWinPct: Number(avgWinPct.toFixed(3)),
    avgLossPct: Number(avgLossPct.toFixed(3)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(3)),
    ambiguousExits: trades.filter((trade) => trade.ambiguousExit === true).length,
    endOfDataExits: trades.filter((trade) => trade.reason === 'END_OF_DATA').length,
    exitReasons: trades.reduce<Record<string, number>>((counts, trade) => {
      counts[trade.reason] = (counts[trade.reason] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

function assertControlledPair(a: StrategyParams, b: StrategyParams): void {
  const changed = Object.keys(a).filter((key) =>
    JSON.stringify((a as unknown as Record<string, unknown>)[key]) !==
    JSON.stringify((b as unknown as Record<string, unknown>)[key]),
  );
  if (changed.length !== 1 || changed[0] !== 'crossLookback') {
    throw new Error(`Uncontrolled crossLookback experiment; unexpected differences: ${changed.join(', ')}`);
  }
}

async function main() {
  const cfg = await get<{ name: string; params: unknown; updated_at: string }[]>('strategy_configs?select=name,params,updated_at&is_active=eq.true&limit=1');
  if (!cfg[0]) throw new Error('Active strategy config not found; refusing to backtest with code defaults.');
  const live = mergeParams(cfg[0].params);

  // --overrides=<json> applies read-only StrategyParams changes on top of the active config.
  const argv: string[] = process.argv.slice(2);
  const overrideArg = argv.find((a) => a.startsWith('--overrides='));
  const overrides = overrideArg ? parseBacktestOverrides(overrideArg.slice('--overrides='.length), live) : {};
  const base = applyBacktestOverrides(live, overrides);
  for (const warning of backtestScopeWarnings(base)) console.warn(`[BACKTEST SCOPE] ${warning}`);
  const overrideKeys = Object.keys(overrides);

  const params2: StrategyParams = { ...base, crossLookback: 2 };
  const params4: StrategyParams = { ...params2, crossLookback: 4 };
  assertControlledPair(params2, params4);

  const cliPairs: string[] = argv.filter((a) => !a.startsWith('--'));
  const marketPairs = await get<StoredPair[]>(
    'market_pairs?select=id,symbol,is_tracked,in_universe,trade_fee_percent_taker,trade_min_base_currency&is_maintenance=eq.false&limit=1000',
  );
  const marketById = new Map(marketPairs.map((row) => [row.id, row]));
  // Compare only the active production scan universe, not unrelated high-volume IDR pairs.
  const selectedPairs = cliPairs.length
    ? [...new Set(cliPairs)].map((id) => marketById.get(id) ?? { id, symbol: id.toUpperCase(), is_tracked: false, in_universe: false, trade_fee_percent_taker: null, trade_min_base_currency: null })
    : marketPairs.filter((row) => row.is_tracked || row.in_universe);
  const volRows = await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const row of volRows) vols[String(row.pair_id)] = Number(row.vol_idr);

  // Pull history outside the loop with a bounded pair concurrency; each pair is chunked
  // into 12h calls to remain below the public history endpoint's likely response cap.
  // Anchor one identical historical interval before any network calls. Every pair
  // in every concurrency batch then uses exactly the same from/to boundaries.
  const historyDays = historyDaysRequested();
  const historyRange = historyDays > 0 ? createBacktestHistoryRange(historyDays, Date.now()) : null;
  const officialHistory = new Map<string, OfficialHistoryResult>();
  if (historyRange) {
    const pairConcurrency = 3;
    for (let offset = 0; offset < selectedPairs.length; offset += pairConcurrency) {
      const batch = selectedPairs.slice(offset, offset + pairConcurrency);
      const fetched = await Promise.all(batch.map(async (pair) => {
        const result = await loadOfficialHistory(pair.symbol, historyRange);
        console.error(
          `[HISTORY] ${pair.id}: chunks=${result.metrics.apiChunks}, 1m=${result.metrics.minuteBarsReceived}, complete 5m=${result.metrics.complete5mBars}/${result.metrics.expected5mBars} (${result.metrics.historyCoveragePct}% OHLC), active 5m=${result.metrics.activeVolume5mBars} (${result.metrics.activeVolumeCoveragePct}%), zero-volume 1m=${result.metrics.zeroVolumeMinuteBars}`,
        );
        return [pair.id, result] as const;
      }));
      for (const [id, result] of fetched) officialHistory.set(id, result);
    }
  }

  const summary: Record<string, unknown> = {};
  const holdoutTradesByVariant: Record<string, SimTrade[]> = {
    cross_lookback_2: [],
    cross_lookback_4: [],
    ema21_continuation_shadow: [],
  };
  let usablePairs = 0;
  for (const pair of selectedPairs) {
    const history = officialHistory.get(pair.id);
    const candles = await loadCandles(pair.id, history);
    const observed = candles.filter((c) => c.source !== 'synthetic');
    if (candles.length < live.minCandles + 20) {
      console.warn(`[SKIP] ${pair.id}: only ${candles.length} timeline bars / ${observed.length} observed bars`);
      continue;
    }
    const splitIndex = Math.floor(candles.length * 0.7);
    if (candles.length - splitIndex < live.minCandles + 5) {
      console.warn(`[SKIP] ${pair.id}: holdout too short after 70/30 split`);
      continue;
    }
    usablePairs++;
    // Recorded spreads are optional: a pair with no quote history keeps the legacy pricing, and the
    // gap is reported so an operator can see which pairs were priced without a real spread.
    const quoteRows = await loadQuotes5m(pair.id);
    const spreadAt = buildSpreadLookup(quoteRows);
    const variants = [
      { key: 'cross_lookback_2', params: params2, mode: 'crossover' as const },
      { key: 'cross_lookback_4', params: params4, mode: 'crossover' as const },
      { key: 'ema21_continuation_shadow', params: params2, mode: 'trend_continuation' as const },
    ];
    const pairResult: Record<string, unknown> = {
      candles: candles.length,
      observedCandles: observed.length,
      activeVolumeCandles: observed.filter((c) => c.v > 0).length,
      zeroVolumeCandles: observed.filter((c) => c.v <= 0).length,
      syntheticGapBars: candles.length - observed.length,
      officialHistory: history?.metrics ?? null,
      quoteBuckets: quoteRows.length,
      spreadPriced: spreadAt !== null,
      from: new Date(candles[0].t * 1000).toISOString(),
      to: new Date(candles[candles.length - 1].t * 1000).toISOString(),
      holdoutFrom: new Date(candles[splitIndex].t * 1000).toISOString(),
      variants: {},
    };
    const variantResults = pairResult.variants as Record<string, unknown>;
    for (const variant of variants) {
      const full = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, 0, pair.trade_fee_percent_taker, spreadAt, pair.trade_min_base_currency);
      const holdout = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, splitIndex, pair.trade_fee_percent_taker, spreadAt, pair.trade_min_base_currency);
      holdoutTradesByVariant[variant.key].push(...holdout);
      variantResults[variant.key] = {
        fullPeriod: measure(full),
        outOfSampleLast30Pct: measure(holdout),
      };
    }
    summary[pair.id] = pairResult;
  }

  if (usablePairs === 0) {
    throw new Error('Backtest stopped: no pairs had sufficient closed 5m candle history for the 70/30 split. No experiment results were produced.');
  }

  const officialMetrics = [...officialHistory.values()].map((item) => item.metrics);
  const officialExpected5mBars = officialMetrics.reduce((sum, item) => sum + item.expected5mBars, 0);
  const officialComplete5mBars = officialMetrics.reduce((sum, item) => sum + item.complete5mBars, 0);
  const officialZeroVolume5mBars = officialMetrics.reduce((sum, item) => sum + item.zeroVolume5mBars, 0);
  const officialActiveVolume5mBars = officialMetrics.reduce((sum, item) => sum + item.activeVolume5mBars, 0);
  const officialZeroVolumeMinuteBars = officialMetrics.reduce((sum, item) => sum + item.zeroVolumeMinuteBars, 0);
  const officialActiveVolumeCoveragePct = officialExpected5mBars > 0
    ? Number((officialActiveVolume5mBars / officialExpected5mBars * 100).toFixed(2)) : 0;
  const aggregateOutOfSample = Object.fromEntries(
    Object.entries(holdoutTradesByVariant).map(([key, trades]) => [
      key,
      measure(trades, 10_000_000 * usablePairs),
    ]),
  );
  // This is a release gate for manual review only. It never changes active strategy settings.
  const evidenceGateByVariant = Object.fromEntries(
    Object.entries(aggregateOutOfSample).map(([key, metrics]) => [key, evaluateStrategyEvidence(metrics)]),
  );

  // WP1a: expectancy-based evidence on the pooled holdout trades. Win rate is a geometry property;
  // the release question is whether the mean *net* return per trade is positive after real costs and
  // survives outlier removal, week-block resampling and pair concentration. Trades are folded
  // chronologically into contiguous time blocks so "consistent across folds" means across time, not
  // across pairs. Both gates are reported; only the expectancy gate can ever say ELIGIBLE.
  const FOLD_COUNT = 6;
  const expectancyGateByVariant = Object.fromEntries(
    Object.entries(holdoutTradesByVariant).map(([key, trades]) => {
      if (trades.length === 0) return [key, evaluateExpectancyEvidence([])];
      const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
      const t0 = sorted[0].exitTime;
      const t1 = sorted[sorted.length - 1].exitTime;
      const span = Math.max(1, t1 - t0);
      const evidence: EvidenceTrade[] = sorted.map((t) => ({
        netReturn: t.cost > 0 ? t.pnl / t.cost : 0,
        exitTime: t.exitTime,
        pair: t.pair,
        fold: Math.min(FOLD_COUNT - 1, Math.floor((t.exitTime - t0) / span * FOLD_COUNT)),
      }));
      return [key, evaluateExpectancyEvidence(evidence)];
    }),
  );
  // WP1f: the expectancy gate says "the sample is internally consistent"; this says "the mean is not
  // a coin flip". Reported alongside, never a substitute: a strategy must clear both.
  const nullModelByVariant = Object.fromEntries(
    Object.entries(holdoutTradesByVariant).map(([key, trades]) => [key, evaluateNullModel(
      trades.map((t) => ({
        netReturn: t.cost > 0 ? t.pnl / t.cost : 0,
        exitTime: t.exitTime,
        pair: t.pair,
      })),
    )]),
  );

  console.log(JSON.stringify({
    experiment: {
      activeConfigSnapshot: {
        source: 'public.strategy_configs (is_active=true)',
        name: cfg[0].name,
        updatedAt: cfg[0].updated_at,
        capturedAt: new Date().toISOString(),
        parameters: {
          timeframe: live.timeframe,
          feePct: live.feePct,
          feeUnit: 'percentage points; e.g. 0.2 means 0.2% per side',
          slippageBps: live.slippageBps,
          dynamicSlippage: live.dynamicSlippage,
          mtfMode: live.mtfMode,
          riskPerTradePct: live.riskPerTradePct,
          maxPositionPct: live.maxPositionPct,
          maxOpenPositions: live.maxOpenPositions,
          maxTotalExposurePct: live.maxTotalExposurePct,
          maxEntrySpreadPct: live.maxEntrySpreadPct,
          maxEntryDriftPct: live.maxEntryDriftPct,
          atrStopMultiplier: live.atrStopMultiplier,
          atrTakeProfitMultiplier: live.atrTakeProfitMultiplier,
          trailActivationAtr: live.trailActivationAtr,
          trailDistanceAtr: live.trailDistanceAtr,
          trailingStopEnabled: live.trailingStopEnabled,
          timeStopMinutes: live.timeStopMinutes,
          feeModel: live.feeModel,
          crossLookback: live.crossLookback,
          universeMode: live.universeMode,
          universeSize: live.universeSize,
          universeMinVolumeIdr: live.universeMinVolumeIdr,
          universeMaxSpreadPct: live.universeMaxSpreadPct,
        },
      },
      parameterOverrides: overrides,
      parameterOverridesNote: overrideKeys.length
        ? `The active config is NOT modified; these overrides apply only to this in-memory run: ${overrideKeys.join(', ')}`
        : null,
      control: 'crossLookback=2',
      variant: 'crossLookback=4',
      mtf: live.mtfMode === 'off'
        ? 'disabled (mtfMode=off)'
        : `applied causally to BUY entries (mtfMode=${live.mtfMode}, shared/mtf.ts); 15m/1h aggregated from the 5m series`,
      controlledParameterDifferences: ['crossLookback'],
      shadowVariant: 'EMA21 pullback-reclaim in EMA9>EMA21>EMA50 uptrend; not sent to paper execution',
      split: 'first 70% for indicator warm-up/context; last 30% is chronological holdout; no entries before holdout',
      pairSelection: cliPairs.length ? 'explicit CLI pairs' : 'active tracked + dynamic universe (maintenance excluded)',
      officialHistorySource: historyDays > 0 ? 'INDODAX public tradingview/history_v2 tf=1, aggregated to complete 5m buckets; in-memory only' : 'stored 5m candles only',
      officialHistoryDaysRequested: historyDays,
      officialHistoryRange: historyRange ? {
        from: new Date(historyRange.fromSec * 1000).toISOString(),
        to: new Date(historyRange.toSec * 1000).toISOString(),
      } : null,
      officialHistoryPairsWithBars: [...officialHistory.values()].filter((h) => h.metrics.complete5mBars > 0).length,
      officialHistoryMinuteBarsReceived: [...officialHistory.values()].reduce((sum, h) => sum + h.metrics.minuteBarsReceived, 0),
      officialHistoryComplete5mBars: officialComplete5mBars,
      officialHistoryExpected5mBars: officialExpected5mBars,
      officialHistoryCoveragePct: officialExpected5mBars > 0
        ? Number((officialComplete5mBars / officialExpected5mBars * 100).toFixed(2)) : 0,
      officialHistoryZeroVolume5mBars: officialZeroVolume5mBars,
      officialHistoryActiveVolume5mBars: officialActiveVolume5mBars,
      officialHistoryZeroVolume1mBars: officialZeroVolumeMinuteBars,
      officialHistoryActiveVolumeCoveragePct: officialActiveVolumeCoveragePct,
      pairsRequested: selectedPairs.length,
      pairsEvaluated: usablePairs,
      initialEquityPerPairIdr: 10_000_000,
      sharedPortfolio: false,
    },
    scopeWarnings: backtestScopeWarnings(base),
    aggregateOutOfSampleIndependentPairAccounts: aggregateOutOfSample,
    evidenceGateByVariant,
    evidenceGatePolicy: 'NO_GO unless holdout has >=100 trades, Wilson 95% lower win-rate bound >=70%, profit factor >1 and net expectancy >0; eligible results require human review and are never auto-promoted',
    expectancyEvidenceByVariant: expectancyGateByVariant,
    nullModelByVariant,
    nullModelPolicy: 'sign-flip permutation null; PASS only when the observed mean net return beats the 95th percentile of 2,000 direction-randomised samples; INSUFFICIENT_SAMPLE below 100 trades',
    expectancyEvidencePolicy: 'NO_GO unless holdout has >=100 trades, the week-block bootstrap 95% lower bound of mean net return per trade is >0, profit factor >=1.15, Wilson 95% lower win rate >=40%, the edge survives removing the 5 best trades, no pair supplies >30% of net profit, >=60% of >=5 chronological folds are positive, and max drawdown <=15%; ELIGIBLE_FOR_MANUAL_REVIEW only, never auto-promoted',
    aggregateAccountMeaning: 'sum of independent per-pair simulations; each evaluated pair starts with its own IDR 10,000,000; not a shared-cash portfolio',
    results: summary,
  }, null, 2));
}

if (process.argv[1]?.endsWith('backtest.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
