// Controlled, read-only strategy experiments. No live or paper orders are submitted.
// Compare the production setup (crossLookback=2) against only one changed variable (4),
// plus a separately labelled EMA21 pullback-reclaim continuation shadow variant.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run backtest [pairId ...]
import {
  computeIndicators, diagnoseTrendContinuationWindow, evaluateSignalWindow,
  mergeParams, type StrategyParams,
} from '../shared/strategy';
import {
  buyFillPrice, computeStats, computeStops, dynamicSlippageBps, feeFor,
  netRewardRiskGate, positionSize, sellFillPrice, trailingStop,
} from '../shared/paper';
import { fillGaps, isValidCandle, type Candle } from '../shared/candles';
import { backtestScopeWarnings, hasBacktestDataQuality } from '../shared/backtestScope';
import { evaluateStrategyEvidence } from '../shared/strategyEvidence';
import { IndodaxClient } from '../worker/src/indodax';
import { withIndodaxRelay } from '../worker/src/relay';
import { aggregateCompleteMinuteHistory, createBacktestHistoryRange, createRequestStartLimiter, filterBacktestCandlesToRange, mergeBacktestCandles, summarizeMinuteHistoryQuality, type BacktestHistoryRange } from './backtest-history';
import { finalizeEndOfDataTrade, resolveProtectiveExit } from './backtest-execution';

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
const indodax = new IndodaxClient(withIndodaxRelay(rateLimitedFetch, proxyUrl), { timeoutMs: 8_000, retries: 2 });
const HISTORY_CHUNK_SECONDS = 12 * 60 * 60;

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number; source: string }
interface StoredPair { id: string; symbol: string; is_tracked: boolean; in_universe: boolean }
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
    const rows = await indodax.getHistory(symbol.toUpperCase(), '1', from, lastClosedMinute);
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
  return fillGaps(scoped, 300);
}

export type ExperimentMode = 'crossover' | 'trend_continuation';
export interface SimTrade {
  pair: string;
  entry: number;
  exit: number;
  pnl: number;
  cost: number;
  reason: string;
  entryTime: number;
  exitTime: number;
}

/**
 * Per-pair candle-only simulation. Indicators use only current/past bars; entries fill on
 * the next observed candle open. startIndex makes a chronological holdout possible while
 * retaining pre-holdout indicator warm-up. It deliberately does not model MTF or shared cash.
 */
export function simulate(
  pair: string,
  candles: Candle[],
  p: StrategyParams,
  equity0: number,
  volIdr: number | null,
  mode: ExperimentMode = 'crossover',
  startIndex = 0,
): SimTrade[] {
  const series = fillGaps(candles, 300);
  const rows = computeIndicators(series, p);
  const trades: SimTrade[] = [];
  const slip = p.dynamicSlippage ? dynamicSlippageBps(p.slippageBps, volIdr) : p.slippageBps;
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
      const protectiveExit = resolveProtectiveExit(pos.sl, pos.tp, c);
      let exit: number | null = protectiveExit?.price ?? null;
      let reason = protectiveExit?.reason ?? '';
      if (exit === null) {
        const nsl = trailingStop({ entry_price: pos.entry, stop_loss: pos.sl }, c.c, rows[i].atr14, p);
        if (nsl !== null) pos.sl = nsl;
        if (p.timeStopMinutes > 0 && (i - pos.openedIdx) * 5 >= p.timeStopMinutes) {
          exit = c.c; reason = 'TIME_STOP';
        }
      }
      if (exit === null && hasBacktestDataQuality(series, i, p.minCandles)) {
        const sell = evaluateSignalWindow(
          rows.slice(i - win + 1, i + 1), series.slice(i - win + 1, i + 1).map((x) => x.v), p,
        );
        if (sell?.side === 'SELL') { exit = c.c; reason = 'SIGNAL'; }
      }
      if (exit !== null) {
        const fill = sellFillPrice(exit, slip);
        const fee = feeFor(pos.qty * fill, p.feePct);
        const pnl = pos.qty * fill - fee - pos.cost;
        equity += pnl;
        trades.push({
          pair, entry: pos.entry, exit: fill, pnl, cost: pos.cost, reason,
          entryTime: pos.entryTime, exitTime: c.t,
        });
        pos = null;
      }
      continue;
    }

    if (!hasBacktestDataQuality(series, i, p.minCandles) || i + 1 >= series.length) continue;
    const windowRows = rows.slice(i - win + 1, i + 1);
    const windowVolumes = series.slice(i - win + 1, i + 1).map((x) => x.v);
    const isBuy = mode === 'crossover'
      ? evaluateSignalWindow(windowRows, windowVolumes, p)?.side === 'BUY'
      : diagnoseTrendContinuationWindow(windowRows, windowVolumes, p).ready;
    if (!isBuy) continue;

    const next = series[i + 1];
    if (next.source === 'synthetic' || !isValidCandle(next) || next.v <= 0) continue;
    const fill = buyFillPrice(next.o, slip);
    const stops = computeStops(fill, rows[i].atr14, p);
    if (netRewardRiskGate({
      entry: fill, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
      feePct: p.feePct, exitSlippageBps: slip,
    })) continue;
    const size = positionSize({
      equity, cash: equity, entry: fill, stopLoss: stops.stopLoss,
      exitSlippageBps: slip, params: p,
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
    trades.push(finalizeEndOfDataTrade(pair, pos, lastObserved, slip, p.feePct));
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
  for (const warning of backtestScopeWarnings(live)) console.warn(`[BACKTEST SCOPE] ${warning}`);

  const params2: StrategyParams = { ...live, crossLookback: 2 };
  const params4: StrategyParams = { ...params2, crossLookback: 4 };
  assertControlledPair(params2, params4);

  const cliPairs: string[] = process.argv.slice(2);
  const marketPairs = await get<StoredPair[]>(
    'market_pairs?select=id,symbol,is_tracked,in_universe&is_maintenance=eq.false&limit=1000',
  );
  const marketById = new Map(marketPairs.map((row) => [row.id, row]));
  // Compare only the active production scan universe, not unrelated high-volume IDR pairs.
  const selectedPairs = cliPairs.length
    ? [...new Set(cliPairs)].map((id) => marketById.get(id) ?? { id, symbol: id.toUpperCase(), is_tracked: false, in_universe: false })
    : marketPairs.filter((row) => row.is_tracked || row.in_universe);
  const volRows = await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const row of volRows) vols[String(row.pair_id)] = Number(row.vol_idr);

  // Pull history outside the loop with a bounded pair concurrency; each pair is chunked
  // into 12h calls to remain below the public history endpoint's likely response cap.
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
      const full = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, 0);
      const holdout = simulate(pair.id, candles, variant.params, 10_000_000, vols[pair.id] ?? null, variant.mode, splitIndex);
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
          feeUnit: 'percentage points; 0.00555 means 0.00555% per side',
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
          crossLookback: live.crossLookback,
          universeMode: live.universeMode,
          universeSize: live.universeSize,
          universeMinVolumeIdr: live.universeMinVolumeIdr,
          universeMaxSpreadPct: live.universeMaxSpreadPct,
        },
      },
      control: 'crossLookback=2',
      variant: 'crossLookback=4',
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
    scopeWarnings: backtestScopeWarnings(live),
    aggregateOutOfSampleIndependentPairAccounts: aggregateOutOfSample,
    evidenceGateByVariant,
    evidenceGatePolicy: 'NO_GO unless holdout has >=100 trades, Wilson 95% lower win-rate bound >=70%, profit factor >1 and net expectancy >0; eligible results require human review and are never auto-promoted',
    aggregateAccountMeaning: 'sum of independent per-pair simulations; each evaluated pair starts with its own IDR 10,000,000; not a shared-cash portfolio',
    results: summary,
  }, null, 2));
}

if (process.argv[1]?.endsWith('backtest.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
