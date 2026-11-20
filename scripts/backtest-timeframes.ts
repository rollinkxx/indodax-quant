// Read-only timeframe comparison. Places no orders and never writes to strategy_configs.
//
// The audit asks for 5m vs 1h vs 4h to be compared on net expectancy, not win rate. This script
// resamples the stored 5m series up with `resampleCandles` (contract-tested: only complete buckets,
// never a synthetic bucket) and runs the SAME portfolio-chronology engine on each base timeframe, so
// the only variable is the bar size. 4h and 1h are RESEARCH_ONLY (see shared/timeframes.ts).
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run backtest:timeframes [-- --pairs=btcidr,ethidr]
import { computeIndicators, evaluateMarketAction, evaluateSignalWindow, mergeParams, type StrategyParams } from '../shared/strategy';
import { fillGaps, isValidCandle, type Candle } from '../shared/candles';
import { hasBacktestDataQuality } from '../shared/backtestScope';
import { DEFAULT_FILL_MODEL, simulatePortfolio, type PortfolioFillModel } from '../shared/portfolioBacktest';
import { TIMEFRAME_SPECS, resampleCandles, timeframeSpec, type BaseTimeframe } from '../shared/timeframes';
import { clusterBootstrap, tradeStats, type TradeObservation } from '../shared/walkForward';

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
interface StoredPair { id: string; is_tracked: boolean; in_universe: boolean; trade_fee_percent_taker: number | null; trade_min_base_currency: number | null }

const TIMEFRAMES: BaseTimeframe[] = ['5m', '1h', '4h'];
const INITIAL_CASH = Number(process.env.BACKTEST_CASH ?? 10_000_000);
const SPREAD_SCENARIOS_BPS = [0, 10, 25, 50, 100];

function parsePairs(argv: string[]): string[] | null {
  const arg = argv.find((a) => a.startsWith('--pairs='));
  if (!arg) return null;
  return arg.slice('--pairs='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function load5m(pair: string): Promise<Candle[]> {
  const rows: Row[] = [];
  const base = `candles?select=open_time,open,high,low,close,volume,trade_count,source&pair_id=eq.${pair}&timeframe=eq.5m&is_closed=eq.true&order=open_time.asc`;
  for (let offset = 0; offset < 10_000; offset += 1_000) {
    const page = await get<Row[]>(`${base}&limit=1000&offset=${offset}`);
    rows.push(...page);
    if (page.length < 1_000) break;
  }
  return rows.map((r): Candle => {
    const source: Candle['source'] = r.source === 'trades' || r.source === 'history' || r.source === 'synthetic' ? r.source : 'synthetic';
    const candle: Candle = {
      t: Math.floor(Date.parse(r.open_time) / 1000), o: +r.open, h: +r.high, l: +r.low, c: +r.close,
      v: +r.volume, n: Number.isFinite(+r.trade_count) ? +r.trade_count : 0, source,
    };
    return isValidCandle(candle) ? candle : { ...candle, source: 'synthetic', v: 0, n: 0 };
  }).filter((c) => Number.isFinite(c.t) && c.t % 300 === 0);
}

/**
 * Signal function shared by every timeframe. It only ever looks at bars `<= index` and requires the
 * signal bar itself to be observed data, so a resampled bucket that swallowed a gap filler is skipped.
 */
function makeSignal(p: StrategyParams, intervalSec: number) {
  return (pair: string, candles: Candle[], index: number): 'BUY' | 'SELL' | 'HOLD' => {
    const win = Math.max(3, p.crossLookback + 1);
    const from = index - win + 1;
    if (from < 0) return 'HOLD';
    if (!hasBacktestDataQuality(candles, index, p.minCandles, intervalSec)) return 'HOLD';
    const window = candles.slice(from, index + 1);
    const rows = computeIndicators(window, p);
    if (rows.length !== window.length) return 'HOLD';
    const action = evaluateMarketAction(rows, window.map((c) => c.v), p);
    if (action.signal) return action.signal.side;
    return evaluateSignalWindow(rows, window.map((c) => c.v), p)?.side ?? 'HOLD';
  };
}

async function main(): Promise<void> {
  const cfg = await get<{ params: unknown }[]>('strategy_configs?select=params&is_active=eq.true&limit=1');
  if (!cfg.length) throw new Error('no active strategy_configs row');
  const p = mergeParams(cfg[0].params);

  const only = parsePairs(process.argv.slice(2));
  const stored = await get<StoredPair[]>('market_pairs?select=id,is_tracked,in_universe,trade_fee_percent_taker,trade_min_base_currency&is_tracked=eq.true');
  const selected = stored.filter((s) => (only ? only.includes(s.id) : s.in_universe));

  const series5m = new Map<string, Candle[]>();
  for (const s of selected) {
    const c = await load5m(s.id);
    if (c.length) series5m.set(s.id, c);
  }
  const evaluated = selected.filter((s) => series5m.has(s.id));
  if (!evaluated.length) throw new Error('no stored 5m candles for the selected pairs');

  const results: unknown[] = [];
  for (const tf of TIMEFRAMES) {
    const spec = timeframeSpec(tf);
    const baseCandles = new Map<string, Candle[]>();
    for (const s of evaluated) {
      const raw = series5m.get(s.id)!;
      const resampled = tf === '5m' ? raw : resampleCandles(fillGaps(raw, 300), spec.baseSeconds, 300);
      baseCandles.set(s.id, resampled);
    }
    for (const spreadBps of SPREAD_SCENARIOS_BPS) {
      const fillModel: PortfolioFillModel = { ...DEFAULT_FILL_MODEL, spreadBps, participationRate: 1, latencyBps: 0 };
      const pairs = evaluated.map((s) => ({
        pair: s.id,
        candles: baseCandles.get(s.id)!,
        volIdr: null as number | null,
        pairTakerFeePct: s.trade_fee_percent_taker,
        minNotional: s.trade_min_base_currency,
        inUniverse: s.in_universe,
      }));
      const signal = makeSignal(p, spec.baseSeconds);
      const run = simulatePortfolio(pairs, p, { initialCash: INITIAL_CASH, fillModel, signal });
      const obs: TradeObservation[] = run.trades.map((t) => ({
        pnl: t.pnl, costBasis: t.cost, pair: t.pair, entryTime: t.entryTime, exitTime: t.exitTime, reason: t.reason,
      }));
      const stats = tradeStats(obs);
      const boot = clusterBootstrap(obs, 'pair', { resamples: 2000, seed: 7 });
      const report = {
        timeframe: tf,
        status: spec.status,
        spreadBps,
        label: spreadBps === 0 ? 'CANDLE_ONLY_OPTIMISTIC' : 'SPREAD_SCENARIO',
        trades: stats.trades,
        winRatePct: Number(stats.winRatePct.toFixed(2)),
        profitFactor: stats.profitFactor,
        netPnlIdr: Math.round(stats.netPnl),
        expectancyIdr: Math.round(stats.expectancyIdr),
        bootstrapLower95ExpectancyIdr: Math.round(boot.lower95Idr),
        maxDrawdownPct: Number(run.maxDrawdownPct.toFixed(2)),
        maxConcurrentPositions: run.maxConcurrentPositions,
        turnoverIdr: Math.round(run.turnoverIdr),
        forcedEodExits: run.forcedEodExits,
        partialFills: run.partialFills,
        rejectedOrders: run.rejectedOrders,
        killSwitchTripped: run.killSwitchTripped,
        finalEquity: Math.round(run.finalEquity),
      };
      results.push(report);
    }
  }

  // Ranking is on net expectancy at a conservative spread, never on win rate.
  const conservative = results.filter((r) => (r as { spreadBps: number }).spreadBps === 50) as {
    timeframe: BaseTimeframe; expectancyIdr: number; bootstrapLower95ExpectancyIdr: number;
    profitFactor: number | null; maxDrawdownPct: number; label: string; quoteFills: number;
  }[];
  const ranking = [...conservative]
    .sort((a, b) => b.bootstrapLower95ExpectancyIdr - a.bootstrapLower95ExpectancyIdr)
    .map((r, i) => ({ rank: i + 1, ...r }));

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    initialCash: INITIAL_CASH,
    pairsEvaluated: evaluated.map((s) => s.id),
    timeframeSpecs: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, TIMEFRAME_SPECS[tf]])),
    note: 'Runs without stored bid/ask are CANDLE_ONLY_OPTIMISTIC upper bounds and are never promotion-eligible. 1h/4h are RESEARCH_ONLY until the production pipeline emits those bars.',
    rankingAtP50Bps: ranking,
    results,
  }, null, 2));
}

if (process.argv[1]?.endsWith('backtest-timeframes.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
