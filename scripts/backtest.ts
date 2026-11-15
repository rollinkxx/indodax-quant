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

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number; source: string }

async function loadCandles(pair: string): Promise<Candle[]> {
  const rows: Row[] = [];
  const base = `candles?select=open_time,open,high,low,close,volume,trade_count,source&pair_id=eq.${pair}&timeframe=eq.5m&is_closed=eq.true&order=open_time.asc`;
  // Respect PostgREST max_rows settings instead of silently accepting a truncated first page.
  for (let offset = 0; offset < 10_000; offset += 1_000) {
    const page = await get<Row[]>(`${base}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  const parsed = rows.map((r): Candle => {
    const source: Candle['source'] = r.source === 'trades' || r.source === 'history' || r.source === 'synthetic'
      ? r.source : 'synthetic';
    const candle: Candle = {
      t: Math.floor(Date.parse(r.open_time) / 1000), o: +r.open, h: +r.high, l: +r.low, c: +r.close,
      v: +r.volume, n: Number.isFinite(+r.trade_count) ? +r.trade_count : 0, source,
    };
    return isValidCandle(candle) ? candle : { ...candle, source: 'synthetic', v: 0, n: 0 };
  });
  const aligned = parsed.filter((c) => Number.isFinite(c.t) && c.t % 300 === 0);
  return fillGaps(aligned, 300);
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
    if (c.source === 'synthetic' || !isValidCandle(c)) continue;

    if (pos) {
      // Conservative intrabar ordering: stop loss takes precedence if both levels are touched.
      let exit: number | null = null;
      let reason = '';
      if (c.l <= pos.sl) { exit = c.o < pos.sl ? c.o : pos.sl; reason = 'STOP_LOSS'; }
      else if (c.h >= pos.tp) { exit = c.o > pos.tp ? c.o : pos.tp; reason = 'TAKE_PROFIT'; }
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
    i += 1;
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
}

function measure(trades: SimTrade[]): Metrics {
  const stats = computeStats(trades.map((t) => ({ realized_pnl: t.pnl, cost_basis: t.cost })));
  const winning = trades.filter((t) => t.pnl > 0);
  const losing = trades.filter((t) => t.pnl <= 0);
  const avgWinPct = winning.length
    ? winning.reduce((sum, t) => sum + t.pnl / t.cost * 100, 0) / winning.length : 0;
  const avgLossPct = losing.length
    ? losing.reduce((sum, t) => sum + t.pnl / t.cost * 100, 0) / losing.length : 0;
  let equity = 10_000_000;
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
  const cfg = await get<{ params: unknown }[]>('strategy_configs?select=params&is_active=eq.true&limit=1');
  const live = mergeParams(cfg[0]?.params);
  for (const warning of backtestScopeWarnings(live)) console.warn(`[BACKTEST SCOPE] ${warning}`);

  const params2: StrategyParams = { ...live, crossLookback: 2 };
  const params4: StrategyParams = { ...params2, crossLookback: 4 };
  assertControlledPair(params2, params4);

  const cliPairs: string[] = process.argv.slice(2);
  const defaultPairs = cliPairs.length
    ? []
    : await get<{ id: string; is_tracked: boolean; in_universe: boolean }[]>(
      'market_pairs?select=id,is_tracked,in_universe&is_maintenance=eq.false&limit=1000',
    );
  // Compare only the active production scan universe, not unrelated high-volume IDR pairs.
  const pairs: string[] = cliPairs.length
    ? cliPairs
    : defaultPairs.filter((row) => row.is_tracked || row.in_universe).map((row) => String(row.id));
  const volRows = await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const row of volRows) vols[String(row.pair_id)] = Number(row.vol_idr);

  const summary: Record<string, unknown> = {};
  let usablePairs = 0;
  for (const pair of [...new Set<string>(pairs)]) {
    const candles = await loadCandles(pair);
    const observed = candles.filter((c) => c.source !== 'synthetic');
    if (candles.length < live.minCandles + 20) {
      console.warn(`[SKIP] ${pair}: only ${candles.length} timeline bars / ${observed.length} observed bars`);
      continue;
    }
    const splitIndex = Math.floor(candles.length * 0.7);
    if (candles.length - splitIndex < live.minCandles + 5) {
      console.warn(`[SKIP] ${pair}: holdout too short after 70/30 split`);
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
      syntheticGapBars: candles.length - observed.length,
      from: new Date(candles[0].t * 1000).toISOString(),
      to: new Date(candles[candles.length - 1].t * 1000).toISOString(),
      holdoutFrom: new Date(candles[splitIndex].t * 1000).toISOString(),
      variants: {},
    };
    const variantResults = pairResult.variants as Record<string, unknown>;
    for (const variant of variants) {
      const full = simulate(pair, candles, variant.params, 10_000_000, vols[pair] ?? null, variant.mode, 0);
      const holdout = simulate(pair, candles, variant.params, 10_000_000, vols[pair] ?? null, variant.mode, splitIndex);
      variantResults[variant.key] = {
        fullPeriod: measure(full),
        outOfSampleLast30Pct: measure(holdout),
      };
    }
    summary[pair] = pairResult;
  }

  if (usablePairs === 0) {
    throw new Error('Backtest stopped: no pairs had sufficient closed 5m candle history for the 70/30 split. No experiment results were produced.');
  }

  console.log(JSON.stringify({
    experiment: {
      control: 'crossLookback=2',
      variant: 'crossLookback=4',
      controlledParameterDifferences: ['crossLookback'],
      shadowVariant: 'EMA21 pullback-reclaim in EMA9>EMA21>EMA50 uptrend; not sent to paper execution',
      split: 'first 70% for indicator warm-up/context; last 30% is chronological holdout; no entries before holdout',
      pairSelection: cliPairs.length ? 'explicit CLI pairs' : 'active tracked + dynamic universe (maintenance excluded)',
      pairsRequested: pairs.length,
      pairsEvaluated: usablePairs,
      initialEquityPerPairIdr: 10_000_000,
      sharedPortfolio: false,
    },
    scopeWarnings: backtestScopeWarnings(live),
    results: summary,
  }, null, 2));
}

if (process.argv[1]?.endsWith('backtest.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
