/**
 * Bracket geometry research.
 *
 * Question: which stop/target pair keeps the strategy profitable at a ~50% win rate?
 *
 * The live config uses a 9x ATR stop against a 5x ATR target (reward:risk 0.56:1), which needs a
 * ~64% hit rate to clear costs. The measured hit rate on that geometry is ~68%, so it is the only
 * bracket tested that came close to breaking even (profit factor 0.893) — every wider-ratio bracket
 * scored lower because its realised hit rate fell faster than its break-even rate. This harness
 * sweeps the ATR multipliers and reports, for each combination, the realised win rate, profit
 * factor, expectancy and break-even win rate, so the two rates can be compared directly.
 *
 * Runs entirely on stored candles through the production simulate() so the numbers are
 * comparable to the release backtest. Usage:
 *   tsx scripts/bracket-research.ts [--history=<days>] [--min-bars=<n>] [--pairs=<csv>]
 */
import { createClient } from '@supabase/supabase-js';
import { computeStats } from '../shared/paper';
import { mergeParams, type StrategyParams } from '../shared/strategy';
import { fillGaps, type Candle } from '../shared/candles';
import { inferIntervalSec, simulate, type SimTrade } from './backtest';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => argv.find((a: string) => a.startsWith(`--${name}=`))?.split('=')[1];
const minBars = Number(arg('min-bars') ?? 1000);
const zeroCost = argv.includes('--zero-cost');
const noOvershoot = argv.includes('--no-overshoot');
const trendArg = arg('trend'); // comma-separated emaTrend values to sweep
const trail = argv.includes('--trail'); // enable trailing stop in the sweep
const tpGridArg = arg('tp-grid');
const cliPairs = arg('pairs')?.split(',').filter(Boolean);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

interface CandleRow {
  pair_id: string;
  open_time: string;
  open: number; high: number; low: number; close: number; volume: number;
  is_closed: boolean; source: string;
}

async function loadPairCandles(pairId: string): Promise<Candle[]> {
  const rows: CandleRow[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await db
      .from('candles')
      .select('pair_id,open_time,open,high,low,close,volume,is_closed,source')
      .eq('pair_id', pairId)
      .eq('timeframe', '5m')
      .eq('is_closed', true)
      .order('open_time', { ascending: true })
      .range(offset, offset + page - 1);
    if (error) throw new Error(`${pairId}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as CandleRow[]));
    if (data.length < page) break;
  }
  return rows.map((r) => ({
    t: Math.floor(new Date(r.open_time).getTime() / 1000),
    o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close),
    v: Number(r.volume), source: r.source === 'synthetic' ? 'synthetic' : 'official',
  })) as Candle[];
}

interface VariantResult {
  stopAtr: number;
  tpAtr: number;
  emaTrend: number;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnl: number;
  expectancy: number;
  avgWinPct: number;
  avgLossPct: number;
  breakEvenWinRatePct: number;
  maxDrawdownPct: number;
}

function measureVariant(trades: SimTrade[], stopAtr: number, tpAtr: number, emaTrend: number): VariantResult {
  const stats = computeStats(trades.map((t) => ({ realized_pnl: t.pnl, cost_basis: t.cost })));
  const winning = trades.filter((t) => t.pnl > 0);
  const losing = trades.filter((t) => t.pnl <= 0);
  const avgWinPct = winning.length ? winning.reduce((s, t) => s + t.pnl / t.cost * 100, 0) / winning.length : 0;
  const avgLossPct = losing.length ? losing.reduce((s, t) => s + t.pnl / t.cost * 100, 0) / losing.length : 0;
  let equity = 10_000_000, peak = equity, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) dd = Math.max(dd, (peak - equity) / peak * 100);
  }
  // Win rate at which gross profit exactly covers gross loss, from the realised payoff ratio.
  const payoff = avgLossPct !== 0 ? Math.abs(avgWinPct / avgLossPct) : 0;
  const breakEvenWinRatePct = payoff > 0 ? 100 / (1 + payoff) : 100;
  return {
    stopAtr, tpAtr, emaTrend,
    trades: stats.trades,
    winRatePct: Number(stats.winRate.toFixed(2)),
    profitFactor: stats.profitFactor === null ? null : Number(stats.profitFactor.toFixed(3)),
    netPnl: Number(stats.totalPnl.toFixed(0)),
    expectancy: stats.trades ? Number((stats.totalPnl / stats.trades).toFixed(0)) : 0,
    avgWinPct: Number(avgWinPct.toFixed(3)),
    avgLossPct: Number(avgLossPct.toFixed(3)),
    breakEvenWinRatePct: Number(breakEvenWinRatePct.toFixed(1)),
    maxDrawdownPct: Number(dd.toFixed(2)),
  };
}

async function main() {
  const { data: cfg, error: cfgErr } = await db
    .from('strategy_configs').select('params').eq('is_active', true).limit(1);
  if (cfgErr) throw new Error(cfgErr.message);
  if (!cfg?.[0]) throw new Error('No active strategy config');
  const live: StrategyParams = mergeParams(cfg[0].params);

  const { data: pairsData, error: pairErr } = await db
    .from('market_pairs').select('id,symbol,is_tracked,in_universe,trade_fee_percent_taker').eq('is_maintenance', false).limit(1000);
  if (pairErr) throw new Error(pairErr.message);
  const rows = (pairsData ?? []) as { id: string; symbol: string; is_tracked: boolean; in_universe: boolean; trade_fee_percent_taker: number | null }[];
  const selected = cliPairs
    ? rows.filter((r) => cliPairs.includes(r.id))
    : rows.filter((r) => r.is_tracked || r.in_universe);

  const { data: volData } = await db.from('market_tickers_latest').select('pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const v of (volData ?? []) as { pair_id: string; vol_idr: number }[]) vols[v.pair_id] = Number(v.vol_idr);

  console.error(`[research] loading ${selected.length} pairs (min-bars=${minBars})`);
  const loaded: { pair: (typeof selected)[number]; candles: Candle[] }[] = [];
  for (const pair of selected) {
    const raw = await loadPairCandles(pair.id);
    if (raw.length < minBars) { console.error(`[skip] ${pair.id}: ${raw.length} bars`); continue; }
    loaded.push({ pair, candles: fillGaps(raw, inferIntervalSec(raw)) });
  }
  console.error(`[research] usable pairs: ${loaded.length}, bars: ${loaded.reduce((s, l) => s + l.candles.length, 0)}`);

  const stopGrid = [1, 1.5, 2, 3, 4, 6, 9];
  const tpGrid = tpGridArg ? tpGridArg.split(',').map(Number) : [1, 1.5, 2, 3, 4, 5, 6, 8, 12];
  const trendGrid = trendArg ? trendArg.split(',').map(Number) : [live.emaTrend];
  const results: VariantResult[] = [];

  for (const emaTrend of trendGrid) {
  for (const stopAtr of stopGrid) {
    for (const tpAtr of tpGrid) {
      const params: StrategyParams = {
        ...live,
        atrStopMultiplier: stopAtr,
        atrTakeProfitMultiplier: tpAtr,
        // Test the geometry on its own: the gate must not veto a candidate before it is measured.
        minNetRewardRiskRatio: 0,
        emaTrend,
        useTrendFilter: true,
        ...(trail ? { trailingStopEnabled: true, trailActivationAtr: 1.5, trailDistanceAtr: 1 } : {}),
        // Zero-cost runs isolate whether the ENTRY has any directional edge at all; if profit
        // factor still sits at 1.0 across every geometry, the entry is a random walk.
        ...(zeroCost ? { feePct: 0, slippageBps: 0, dynamicSlippage: false } : {}),
      };
      const trades: SimTrade[] = [];
      for (const { pair, candles } of loaded) {
        try {
          trades.push(...simulate(pair.id, candles, params, 10_000_000, vols[pair.id] ?? null,
            'crossover', 0, pair.trade_fee_percent_taker, noOvershoot ? 0 : undefined));
        } catch { /* one bad pair must not abort the sweep */ }
      }
      results.push(measureVariant(trades, stopAtr, tpAtr, emaTrend));
    }
  }
  }

  results.sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0));
  console.log(JSON.stringify({
    zeroCost, noOvershoot, trail,
    pairs: loaded.length,
    bars: loaded.reduce((s, l) => s + l.candles.length, 0),
    note: 'profitFactor/expectancy computed on pooled trades across independent per-pair accounts',
    top: results.slice(0, 12),
    all: results,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
