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
  buyFillPrice, computeStats, computeStops, dynamicSlippageBps, effectiveFeePct, feeFor,
  netRewardRiskGate, positionSize, roundTripCostPct, sellFillPrice, signalExitCoversCosts, targetFeasibility, trailingStop,
} from '../shared/paper';
import { fillGaps, isValidCandle, type Candle } from '../shared/candles';
import { backtestScopeWarnings, hasBacktestDataQuality } from '../shared/backtestScope';
import { evaluateStrategyEvidence } from '../shared/strategyEvidence';
import { DEFAULT_FILL_MODEL, simulatePortfolio, type PortfolioFillModel } from '../shared/portfolioBacktest';
import {
  buildWalkForwardFolds, clusterBootstrap, DEFAULT_PROMOTION_CRITERIA, embargoSeconds, evaluatePromotion,
  maxPairContributionSharePct, maxRegimeContributionSharePct, netPnlExcludingTopTrades, walkForwardReport,
  type TradeObservation,
} from '../shared/walkForward';
import { percentile, scenarioSpreadBps, SPREAD_SCENARIOS } from '../shared/fillModel';
import { indexQuotes, observedSpreads as observedSpreadsOf, type QuotePoint } from '../shared/quoteHistory';
import { normalizeIntervals, type UniverseInterval } from '../shared/universe';
import { TIMEFRAME_SPECS } from '../shared/timeframes';
import { IndodaxClient } from '../worker/src/indodax';
import { withIndodaxRelay } from '../worker/src/relay';
import { aggregateCompleteMinuteHistory, createBacktestHistoryRange, createRequestStartLimiter, filterBacktestCandlesToRange, mergeBacktestCandles, summarizeMinuteHistoryQuality, type BacktestHistoryRange } from './backtest-history';
import { finalizeEndOfDataTrade, resolveProtectiveExit } from './backtest-execution';
import { createIndicatorRowsCache, signalAtBar } from '../shared/backtestSignal';
import { alignedSlots, fetchSlotHistory, HISTORY_SLOT_SECONDS, SlotCache } from './history-cache';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const headers: Record<string, string> = { apikey: KEY, accept: 'application/json' };
if (!KEY.startsWith('sb_')) headers.authorization = `Bearer ${KEY}`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const historyDays = Number(process.env.BACKTEST_HISTORY_DAYS ?? 0);
if (!Number.isInteger(historyDays) || historyDays < 0 || historyDays > 180) {
  throw new Error('BACKTEST_HISTORY_DAYS must be an integer from 0 to 180');
}
const proxyUrl = process.env.INDODAX_PROXY_URL?.trim() || `${URL_}/functions/v1/indodax-proxy`;
// INDODAX public endpoints document a 180 requests/minute quota. Share one
// 500ms start interval across every pair and retry, leaving headroom for the Worker.
const acquireHistoryRequestSlot = createRequestStartLimiter(500);
const rateLimitedFetch: typeof fetch = async (input, init) => {
  await acquireHistoryRequestSlot();
  return fetch(input, init);
};
const indodax = new IndodaxClient(withIndodaxRelay(rateLimitedFetch, proxyUrl, KEY), { timeoutMs: 8_000, retries: 2 });
// Optional on-disk cache of past 12h slots. Unset = always refetch, so local runs behave as before.
const historyCache = new SlotCache(process.env.BACKTEST_HISTORY_CACHE?.trim() || null);

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number; source: string }
interface StoredPair {
  id: string; symbol: string; is_tracked: boolean; in_universe: boolean;
  trade_fee_percent_taker: number | null; trade_min_base_currency?: number | null;
}
interface OfficialHistoryResult {
  candles: Candle[];
  metrics: {
    daysRequested: number;
    apiChunks: number;
    cacheHits: number;
    truncatedRequests: number;
    uncachedSlots: number;
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
  // The cap must exceed the full stored history: an ascending scan bounded at 10k rows silently
  // dropped the most recent ~3k bars of a 13k-bar pair, so the sample ended before the window
  // where `market_universe_history` begins and every timestamped-universe entry was rejected.
  for (let offset = 0; offset < 50_000; offset += 1_000) {
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

/** Pulls official 1m OHLC over UTC-aligned 12h slots and aggregates only complete 5m buckets. */
async function loadOfficialHistory(symbol: string, range: BacktestHistoryRange): Promise<OfficialHistoryResult> {
  const { days, fromSec, toSec } = range;

  // Slots are aligned to the UTC 12h grid, not to the sliding window: a window-relative boundary
  // moves every run, so nothing would ever hit the cache. Whole slots are fetched (the extra leading
  // minutes are trimmed by the range filter below), which is what makes an interior slot stable.
  // They are coalesced into as few requests as the endpoint's response cap allows - 16 slots (192 h)
  // per request instead of one per slot - which is what makes a cold 180-day window fit the job.
  const { bars: oneMinute, stats } = await fetchSlotHistory({
    symbol,
    slots: alignedSlots(fromSec, toSec, HISTORY_SLOT_SECONDS),
    toSec,
    cache: historyCache,
    fetchBars: (sym, from, to) => indodax.getHistory(sym.toUpperCase(), '1', from, to),
    onWarning: (message) => console.error(`[HISTORY] ${message}`),
  });

  const complete5m = aggregateCompleteMinuteHistory(oneMinute, fromSec, toSec);
  const quality = summarizeMinuteHistoryQuality(oneMinute, fromSec, toSec, complete5m);
  const expected5mBars = quality.expected5mBars;
  const historyCoveragePct = expected5mBars > 0
    ? Number((complete5m.length / expected5mBars * 100).toFixed(2)) : 0;
  return {
    candles: complete5m,
    metrics: {
      daysRequested: days,
      apiChunks: stats.requests,
      cacheHits: stats.cacheHits,
      truncatedRequests: stats.truncatedRequests,
      uncachedSlots: stats.uncachedSlots,
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

export type ExperimentMode = 'crossover' | 'trend_continuation';

/**
 * Timestamped universe membership for one pair, as half-open `[from, to)` second ranges.
 *
 * Returns undefined when the table is empty or unreachable, which makes the caller fall back to the
 * static `in_universe` flag and report the run as non-timestamped rather than silently pretending
 * the universe was known historically.
 */
async function loadUniverseIntervals(pair: string): Promise<UniverseInterval[] | undefined> {
  try {
    const rows = await get<{ effective_from: string; effective_to: string | null }[]>(
      `market_universe_history?select=effective_from,effective_to&pair_id=eq.${pair}&order=effective_from.asc`,
    );
    if (!rows.length) return undefined;
    return normalizeIntervals(rows.map((r) => ({
      from: Math.floor(Date.parse(r.effective_from) / 1000),
      to: r.effective_to === null ? null : Math.floor(Date.parse(r.effective_to) / 1000),
    })));
  } catch (e) {
    console.warn(`[UNIVERSE] ${pair}: ${(e as Error).message}; falling back to current membership flags`);
    return undefined;
  }
}

/**
 * Stored bid/ask captures for a pair. This is the quote history the pipeline already writes, so a
 * backtest can price fills against what was actually available instead of the candle open.
 *
 * `market_tickers` is retained for 8 days, so a longer window is quote-covered only at its tail; the
 * caller labels the run CANDLE_ONLY_OPTIMISTIC unless every pair had quotes.
 */
async function loadQuotes(pair: string, fromSec?: number, toSec?: number): Promise<QuotePoint[]> {
  const rows: { captured_at: string; bid: number; ask: number }[] = [];
  const filters = [`pair_id=eq.${pair}`];
  if (fromSec !== undefined) filters.push(`captured_at=gte.${new Date(fromSec * 1000).toISOString()}`);
  if (toSec !== undefined) filters.push(`captured_at=lte.${new Date(toSec * 1000).toISOString()}`);
  const base = `market_tickers?select=captured_at,bid,ask&${filters.join('&')}&order=captured_at.asc`;
  const MAX_ROWS = 20_000;
  for (let offset = 0; offset < MAX_ROWS; offset += 1_000) {
    const page = await get<typeof rows>(`${base}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  if (rows.length >= MAX_ROWS) console.warn(`[QUOTES] ${pair}: truncated at ${MAX_ROWS} rows`);
  return indexQuotes(rows.map((r) => ({ t: Math.floor(Date.parse(r.captured_at) / 1000), bid: +r.bid, ask: +r.ask })));
}

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
  /** Max favourable excursion above the entry fill over the holding period, in percent (>= 0). */
  mfePct: number;
  /** Max adverse excursion below the entry fill over the holding period, in percent (>= 0, magnitude). */
  maePct: number;
  /** This trade's own take-profit distance: (takeProfit - entry) / entry * 100. */
  tpDistancePct: number;
  /** True when mfePct reached tpDistancePct, i.e. price tagged the target while the position was open. */
  reachedTakeProfit: boolean;
}

/**
 * Fold one observed bar into an open long's running excursions.
 *
 * Excursions are measured on the same observed bars the simulation walks, from the entry fill
 * (the entry bar's open) to the bar the trade exits on, inclusive. OHLC cannot order a bar's
 * high/low against the exit inside that bar, so a stop-out bar's high still counts as a
 * favourable excursion: the numbers bound how far price ran, they do not prove the intrabar path.
 */
function trackExcursion(pos: { entry: number; mfePct: number; maePct: number }, candle: Candle): void {
  pos.mfePct = Math.max(pos.mfePct, (candle.h - pos.entry) / pos.entry * 100);
  pos.maePct = Math.max(pos.maePct, (pos.entry - candle.l) / pos.entry * 100);
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
    mfePct: number; maePct: number; tpDistancePct: number;
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
      trackExcursion(pos, c);
      // The entry candle is deliberately processed on the next loop iteration;
      // if both protective levels are touched, stop loss takes precedence.
      const protectiveExit = resolveProtectiveExit(pos.sl, pos.tp, c, pos.entry);
      let exit: number | null = protectiveExit?.price ?? null;
      let reason = protectiveExit?.reason ?? '';
      if (exit === null) {
        const nsl = trailingStop({ entry_price: pos.entry, stop_loss: pos.sl, take_profit: pos.tp }, c.c, rows[i].atr14, p, roundTripCostPct(feePct, slip));
        if (nsl !== null) pos.sl = nsl;
        if (p.timeStopMinutes > 0 && (i - pos.openedIdx) * (intervalSec / 60) >= p.timeStopMinutes) {
          exit = c.c; reason = 'TIME_STOP';
        }
      }
      if (exit === null && hasBacktestDataQuality(series, i, p.minCandles, intervalSec)) {
        const sell = evaluateSignalWindow(
          rows.slice(i - win + 1, i + 1), series.slice(i - win + 1, i + 1).map((x) => x.v), p,
        );
        if (sell?.side === 'SELL' && signalExitCoversCosts({
          entryPrice: pos.entry, qty: pos.qty, costBasis: pos.cost, bid: c.c, feePct, slippageBps: slip,
        })) { exit = c.c; reason = 'SIGNAL'; }
      }
      if (exit !== null) {
        const fill = sellFillPrice(exit, slip);
        const fee = feeFor(pos.qty * fill, feePct);
        const pnl = pos.qty * fill - fee - pos.cost;
        equity += pnl;
        trades.push({
          pair, entry: pos.entry, exit: fill, pnl, cost: pos.cost, reason,
          entryTime: pos.entryTime, exitTime: c.t,
          mfePct: pos.mfePct, maePct: pos.maePct,
          tpDistancePct: pos.tpDistancePct, reachedTakeProfit: pos.mfePct >= pos.tpDistancePct,
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
    const fill = buyFillPrice(next.o, slip);
    const stops = computeStops(fill, rows[i].atr14, p);
    if (targetFeasibility({
      entry: fill, takeProfit: stops.takeProfit, feePct, slippageBps: slip, minNetTargetPct: p.minNetTargetPct,
    }).reason) continue;
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
    });
    if (size.qty <= 0) continue;
    pos = {
      qty: size.qty, entry: fill, cost: size.cost, sl: stops.stopLoss,
      tp: stops.takeProfit, openedIdx: i + 1, entryTime: next.t,
      mfePct: 0, maePct: 0, tpDistancePct: (stops.takeProfit - fill) / fill * 100,
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
    trades.push({
      ...finalizeEndOfDataTrade(pair, pos, lastObserved, slip, feePct),
      mfePct: pos.mfePct, maePct: pos.maePct,
      tpDistancePct: pos.tpDistancePct, reachedTakeProfit: pos.mfePct >= pos.tpDistancePct,
    });
  }

  return trades;
}

export interface ExcursionPercentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

/**
 * p50/p75/p90/p95 of an excursion sample, rounded to 3dp like the other percent metrics.
 * Linear interpolation (shared/fillModel.percentile); an empty sample reports 0.
 */
export function excursionPercentiles(values: readonly number[]): ExcursionPercentiles {
  const at = (pct: number) => Number(percentile(values, pct).toFixed(3));
  return { p50: at(50), p75: at(75), p90: at(90), p95: at(95) };
}

export interface Metrics {
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
  mfePct: ExcursionPercentiles;
  maePct: ExcursionPercentiles;
  takeProfitReached: number;
  takeProfitReachPct: number;
  endOfDataExits: number;
  exitReasons: Record<string, number>;
}

export function measure(trades: SimTrade[], initialEquity = 10_000_000): Metrics {
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
  const reachedTakeProfit = trades.filter((t) => t.reachedTakeProfit).length;
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
    mfePct: excursionPercentiles(trades.map((t) => t.mfePct)),
    maePct: excursionPercentiles(trades.map((t) => t.maePct)),
    takeProfitReached: reachedTakeProfit,
    takeProfitReachPct: trades.length ? Number((reachedTakeProfit / trades.length * 100).toFixed(2)) : 0,
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
    ? [...new Set(cliPairs)].map((id) => marketById.get(id) ?? { id, symbol: id.toUpperCase(), is_tracked: false, in_universe: false, trade_fee_percent_taker: null })
    : marketPairs.filter((row) => row.is_tracked || row.in_universe);
  const volRows = await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const row of volRows) vols[String(row.pair_id)] = Number(row.vol_idr);

  // Pull history outside the loop with a bounded pair concurrency. Each pair walks UTC-aligned 12h
  // slots, coalesced into requests that stay below the history endpoint's measured response cap.
  // Anchor one identical historical interval before any network calls. Every pair
  // in every concurrency batch then uses exactly the same from/to boundaries.
  const historyRange = historyDays > 0 ? createBacktestHistoryRange(historyDays, Date.now()) : null;
  const officialHistory = new Map<string, OfficialHistoryResult>();
  if (historyRange) {
    const pairConcurrency = 3;
    for (let offset = 0; offset < selectedPairs.length; offset += pairConcurrency) {
      const batch = selectedPairs.slice(offset, offset + pairConcurrency);
      const fetched = await Promise.all(batch.map(async (pair) => {
        const result = await loadOfficialHistory(pair.symbol, historyRange);
        console.error(
          `[HISTORY] ${pair.id}: requests=${result.metrics.apiChunks}, cached=${result.metrics.cacheHits}, truncated=${result.metrics.truncatedRequests}, uncached=${result.metrics.uncachedSlots}, 1m=${result.metrics.minuteBarsReceived}, complete 5m=${result.metrics.complete5mBars}/${result.metrics.expected5mBars} (${result.metrics.historyCoveragePct}% OHLC), active 5m=${result.metrics.activeVolume5mBars} (${result.metrics.activeVolumeCoveragePct}%), zero-volume 1m=${result.metrics.zeroVolumeMinuteBars}`,
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
  // Retained for the shared-cash portfolio run and the walk-forward folds below.
  const portfolioInputs: { pair: string; candles: Candle[]; volIdr: number | null; pairTakerFeePct: number | null; minNotional: number | null; inUniverse: boolean; universeIntervals?: UniverseInterval[]; quotes?: QuotePoint[] }[] = [];
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
    const quotes = await loadQuotes(pair.id, history?.metrics.fromSec, history?.metrics.toSec).catch((e) => {
      console.warn(`[QUOTES] ${pair.id}: ${(e as Error).message}; falling back to candle-only fills`);
      return [] as QuotePoint[];
    });
    const universeIntervals = await loadUniverseIntervals(pair.id);
    portfolioInputs.push({
      pair: pair.id, candles, volIdr: vols[pair.id] ?? null,
      pairTakerFeePct: pair.trade_fee_percent_taker,
      minNotional: pair.trade_min_base_currency ?? null,
      inUniverse: pair.in_universe,
      ...(universeIntervals ? { universeIntervals } : {}),
      ...(quotes.length ? { quotes } : {}),
    });
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
      from: new Date(candles[0].t * 1000).toISOString(),
      to: new Date(candles[candles.length - 1].t * 1000).toISOString(),
      holdoutFrom: new Date(candles[splitIndex].t * 1000).toISOString(),
      variants: {},
    };
    const variantResults = pairResult.variants as Record<string, unknown>;
    for (const variant of variants) {
      const full = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, 0, pair.trade_fee_percent_taker);
      const holdout = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, splitIndex, pair.trade_fee_percent_taker);
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

  // ---- Shared-cash portfolio chronology + walk-forward + spread scenarios (audit §2, §3, §10) ----
  // The per-pair `simulate()` above gives every pair its own IDR 10,000,000, which hides the shared
  // cash pool, the concurrency cap, the exposure ceiling and the daily-loss/kill-switch interaction.
  // This run uses ONE account across all pairs on a single timeline.
  // Indicators are recursive (EMA/RSI/ATR/volume MA), so they must be seeded from full history and
  // then indexed at the signal bar. Computing them per call over a sliding window is both wrong (an
  // unseeded window yields no signal) and O(bars x window); caching the full-series rows per pair is
  // exact and O(bars). The per-pair `simulate()` above already does this.
  const rowsFor = createIndicatorRowsCache();
  const portfolioSignal = (p: StrategyParams) => (pair: string, candles: Candle[], index: number): 'BUY' | 'SELL' | 'HOLD' => {
    if (!hasBacktestDataQuality(candles, index, p.minCandles, inferIntervalSec(candles))) return 'HOLD';
    return signalAtBar(pair, candles, index, p, rowsFor);
  };

  // Spread scenarios: without historical bid/ask depth the spread is a scenario, not a measurement,
  // so every row is labelled and the promotion gate is evaluated at the conservative scenario only.
  // The sample combines every stored quote with the latest tickers; the floor keeps a scenario from
  // collapsing to zero when the sample is empty, which would make P99 as optimistic as P50.
  const latestTickerSpreads = await get<{ pair_id: string; bid: number; ask: number }[]>(
    'market_tickers_latest?select=pair_id,bid,ask',
  ).then((rows) => rows.map((r) => {
    const bid = Number(r.bid), ask = Number(r.ask);
    const mid = (bid + ask) / 2;
    return mid > 0 && ask >= bid ? (ask - bid) / mid * 10_000 : null;
  }).filter((v): v is number => v !== null)).catch(() => [] as number[]);
  const spreadSample = [...latestTickerSpreads, ...portfolioInputs.flatMap((p) => observedSpreadsOf(p.quotes ?? []))];
  const spreadFloorBps = Math.max(1, live.slippageBps);

  const portfolioByScenario: Record<string, unknown> = {};
  const portfolioTradesByScenario: Record<string, TradeObservation[]> = {};
  // False when any pair in any scenario lacked membership intervals, i.e. the run fell back to
  // today's flags applied to the whole history.
  let universeTimestamped = true;
  for (const scenario of SPREAD_SCENARIOS) {
    const spreadBps = scenarioSpreadBps(spreadSample, scenario, spreadFloorBps);
    const quotePairs = portfolioInputs.filter((p) => p.quotes?.length).length;
    const fillModel: PortfolioFillModel = {
      ...DEFAULT_FILL_MODEL,
      spreadBps,
      // A run is only QUOTE_BASED when every evaluated pair had quote history to price against.
      label: quotePairs > 0 && quotePairs === portfolioInputs.length ? 'QUOTE_BASED' : 'CANDLE_ONLY_OPTIMISTIC',
      maxQuoteAgeSec: 120,
    };
    const run = simulatePortfolio(portfolioInputs, params2, {
      initialCash: 10_000_000, fillModel, signal: portfolioSignal(params2),
    });
    universeTimestamped = universeTimestamped && run.universeIsTimestamped;
    const obs: TradeObservation[] = run.trades.map((t) => ({
      pnl: t.pnl, costBasis: t.cost, pair: t.pair, entryTime: t.entryTime, exitTime: t.exitTime, reason: t.reason,
      regime: t.regime,
    }));
    portfolioTradesByScenario[scenario] = obs;
    const perPair: Record<string, number> = {};
    for (const t of run.trades) perPair[t.pair] = (perPair[t.pair] ?? 0) + t.pnl;
    portfolioByScenario[scenario] = {
      spreadBps: Number(spreadBps.toFixed(2)),
      label: run.effectiveFillLabel,
      universeIsTimestamped: run.universeIsTimestamped,
      quoteFills: run.quoteFills,
      quoteRejections: run.quoteRejections,
      trades: run.trades.length,
      netPnlIdr: Math.round(run.finalEquity - run.initialCash),
      finalEquity: Math.round(run.finalEquity),
      maxDrawdownPct: Number(run.maxDrawdownPct.toFixed(2)),
      maxConcurrentPositions: run.maxConcurrentPositions,
      turnoverIdr: Math.round(run.turnoverIdr),
      forcedEodExits: run.forcedEodExits,
      partialFills: run.partialFills,
      rejectedOrders: run.rejectedOrders,
      killSwitchTripped: run.killSwitchTripped,
      dailyLossFlattens: run.dailyLossFlattens,
      timeUnderWaterBars: run.timeUnderWaterBars,
      topPairContributionSharePct: (() => {
        const total = Object.values(perPair).reduce((a, b) => a + Math.abs(b), 0);
        const top = Object.values(perPair).reduce((a, b) => Math.max(a, Math.abs(b)), 0);
        return total > 0 ? Number((top / total * 100).toFixed(2)) : 0;
      })(),
      perPairContributionIdr: Object.fromEntries(Object.entries(perPair).map(([k, v]) => [k, Math.round(v)])),
      perRegimeContributionIdr: Object.fromEntries(Object.entries(
        run.trades.reduce<Record<string, number>>((acc, t) => {
          acc[t.regime] = (acc[t.regime] ?? 0) + t.pnl;
          return acc;
        }, {}),
      ).map(([k, v]) => [k, Math.round(v)])),
      rejectionsByReason: run.rejections.reduce<Record<string, number>>((acc, r) => {
        const key = `${r.stage}:${r.reason}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  // Walk-forward: 6 chronological folds with an embargo covering holding + indicator + HTF lookback.
  // Bounds are folded rather than spread: `Math.min(...allTimes)` overflows the stack once the pooled
  // 5m series across every pair runs into the hundreds of thousands of bars.
  const wfBounds = portfolioInputs.reduce(
    (acc, p) => {
      for (const c of p.candles) {
        if (c.source === 'synthetic') continue;
        if (c.t < acc.start) acc.start = c.t;
        if (c.t > acc.last) acc.last = c.t;
      }
      return acc;
    },
    { start: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY },
  );
  const hasBars = Number.isFinite(wfBounds.start) && Number.isFinite(wfBounds.last);
  const wfStart = hasBars ? wfBounds.start : 0;
  const wfEnd = hasBars ? wfBounds.last + 300 : 0;
  const spec5m = TIMEFRAME_SPECS['5m'];
  const embargoSec = embargoSeconds({
    maxHoldingSeconds: spec5m.maxHoldingBars * spec5m.baseSeconds,
    indicatorLookbackBars: live.minCandles,
    higherTimeframeLookbackBars: 120 * 12, // MTF_WINDOW 1h buckets expressed in 5m bars
    barSeconds: spec5m.baseSeconds,
  });
  const folds = buildWalkForwardFolds({ startSec: wfStart, endSec: wfEnd, folds: 7, embargoSec });
  const wfTrades = portfolioTradesByScenario.P50 ?? [];
  const wf = walkForwardReport({ trades: wfTrades, folds, minFoldTrades: 10, bootstrap: { key: 'pair', resamples: 2000, seed: 11 } });
  const p50 = portfolioByScenario.P50 as { maxDrawdownPct: number; label: 'CANDLE_ONLY_OPTIMISTIC' | 'QUOTE_BASED' };
  const promotion = evaluatePromotion(wf, Number(p50.maxDrawdownPct), DEFAULT_PROMOTION_CRITERIA, {
    maxSinglePairContributionSharePct: maxPairContributionSharePct(wfTrades),
    maxSingleRegimeContributionSharePct: maxRegimeContributionSharePct(wfTrades),
    exTopTradeNetPnlIdr: netPnlExcludingTopTrades(wfTrades, DEFAULT_PROMOTION_CRITERIA.topTradeCount),
    // Parameters come from the active row and are not re-tuned inside this run.
    configFrozen: overrideKeys.length === 0,
    fillModelLabel: p50.label,
    portfolioConstraintsActive: true,
    universeIsTimestamped: universeTimestamped,
  });
  const bootstrapByCluster = {
    pair: clusterBootstrap(wfTrades, 'pair', { resamples: 2000, seed: 11 }),
    day: clusterBootstrap(wfTrades, 'day', { resamples: 2000, seed: 11 }),
    regime: clusterBootstrap(wfTrades, 'regime', { resamples: 2000, seed: 11 }),
  };
  const portfolioChronology = {
    note: 'One shared IDR 10,000,000 account across all pairs on a single timeline; exits precede entries, then daily-loss and drawdown kill switch, then ranked entries capped by maxOpenPositions and maxTotalExposurePct.',
    initialCashIdr: 10_000_000,
    observedSpreadSampleCount: spreadSample.length,
    universeIsTimestamped: universeTimestamped,
    spreadFloorBps,
    spreadIsScenarioNotMeasurement: true,
    embargoSeconds: embargoSec,
    folds,
    walkForward: wf,
    bootstrapByCluster,
    promotionDecision: promotion,
    promotionPolicy: 'NO_GO unless >=4 material folds, majority positive, no materially negative fold, PF>1, bootstrap lower-95 expectancy >0, drawdown within budget, no single pair >60% or single regime >80% of gross PnL, quote-based fills, timestamped universe, frozen config. Human review required; never auto-promoted.',
    byScenario: portfolioByScenario,
  };

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
      sharedPortfolio: true,
    },
    scopeWarnings: backtestScopeWarnings(base),
    aggregateOutOfSampleIndependentPairAccounts: aggregateOutOfSample,
    evidenceGateByVariant,
    evidenceGatePolicy: 'NO_GO unless holdout has >=100 trades, profit factor >1 and net expectancy >0; the Wilson 95% win-rate floor (70%) is reported but advisory, not blocking; eligible results require human review and are never auto-promoted',
    aggregateAccountMeaning: 'sum of independent per-pair simulations; each evaluated pair starts with its own IDR 10,000,000. See portfolioChronology for the shared-cash account and the promotion decision.',
    portfolioChronology,
    results: summary,
  }, null, 2));
}

if (process.argv[1]?.endsWith('backtest.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
