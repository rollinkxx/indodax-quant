// Read-only fee-sensitivity report (audit finding F1).
//
// The paper engine charges the real per-pair taker fee (feeModel 'pair_taker'); INDODAX's public
// pair catalog reports trade_fee_percent_taker = 0.2% per side for 438/438 IDR pairs. The retired
// 0.00555% assumption under-charged by ~36x, so this script replays the stored 5m candles under
// both models and prints the difference, quantifying what the mismatch was costing.
//
// It is strictly read-only: it loads candles and the active config, runs the in-memory simulation,
// and prints a JSON report. It submits no orders and writes nothing to the database.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run fee:sensitivity [pairId ...]
import { mergeParams, type StrategyParams } from '../shared/strategy';
import { computeStats } from '../shared/paper';
import { isValidCandle, type Candle } from '../shared/candles';
import { simulate, type SimTrade } from './backtest';

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
interface StoredPair { id: string; symbol: string; is_tracked: boolean; in_universe: boolean; trade_fee_percent_taker: number | null }

async function loadStoredCandles(pair: string): Promise<Candle[]> {
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

function summarize(trades: SimTrade[]) {
  const stats = computeStats(trades.map((t) => ({ realized_pnl: t.pnl, cost_basis: t.cost })));
  return {
    trades: stats.trades,
    winRatePct: Number(stats.winRate.toFixed(2)),
    profitFactor: stats.profitFactor === null ? null : Number(stats.profitFactor.toFixed(3)),
    netPnlIdr: Number(stats.totalPnl.toFixed(2)),
    expectancyIdr: stats.trades ? Number((stats.totalPnl / stats.trades).toFixed(2)) : 0,
  };
}

async function main() {
  const cfg = await get<{ name: string; params: unknown; updated_at: string }[]>('strategy_configs?select=name,params,updated_at&is_active=eq.true&limit=1');
  if (!cfg[0]) throw new Error('Active strategy config not found; refusing to report with code defaults.');
  const live = mergeParams(cfg[0].params);

  const cliPairs: string[] = process.argv.slice(2);
  const marketPairs = await get<StoredPair[]>('market_pairs?select=id,symbol,is_tracked,in_universe,trade_fee_percent_taker&is_maintenance=eq.false&limit=1000');
  const marketById = new Map(marketPairs.map((row) => [row.id, row]));
  const selectedPairs = cliPairs.length
    ? [...new Set(cliPairs)].map((id) => marketById.get(id) ?? { id, symbol: id.toUpperCase(), is_tracked: false, in_universe: false, trade_fee_percent_taker: null })
    : marketPairs.filter((row) => row.is_tracked || row.in_universe);

  const volRows = await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const row of volRows) vols[String(row.pair_id)] = Number(row.vol_idr);

  // Scenario A: the active assumption (feePct for every pair). Scenario B: the real per-pair taker fee.
  const paramsAssumption: StrategyParams = { ...live, feeModel: 'assumption' };
  const paramsPairTaker: StrategyParams = { ...live, feeModel: 'pair_taker' };

  const perPair: Record<string, unknown> = {};
  const allA: SimTrade[] = [];
  const allB: SimTrade[] = [];
  let evaluated = 0;
  for (const pair of selectedPairs) {
    const candles = await loadStoredCandles(pair.id);
    if (candles.length < live.minCandles + 20) continue;
    evaluated++;
    const taker = pair.trade_fee_percent_taker;
    const a = simulate(pair.id, candles, paramsAssumption, 10_000_000, vols[pair.id] ?? null, 'crossover', 0, taker);
    const b = simulate(pair.id, candles, paramsPairTaker, 10_000_000, vols[pair.id] ?? null, 'crossover', 0, taker);
    allA.push(...a);
    allB.push(...b);
    perPair[pair.id] = {
      candles: candles.length,
      pairTakerFeePct: taker,
      assumption: summarize(a),
      pairTaker: summarize(b),
      netPnlDeltaIdr: Number((summarize(b).netPnlIdr - summarize(a).netPnlIdr).toFixed(2)),
    };
  }

  const sumA = summarize(allA);
  const sumB = summarize(allB);
  console.log(JSON.stringify({
    report: 'fee-sensitivity (F1)',
    readOnly: true,
    generatedAt: new Date().toISOString(),
    activeConfigUpdatedAt: cfg[0].updated_at,
    assumptionFeePct: live.feePct,
    assumptionFeeUnit: 'percentage points; e.g. 0.2 means 0.2% per side',
    note: 'Per-pair taker fees come from market_pairs.trade_fee_percent_taker (INDODAX /api/pairs). The active paper config is NOT modified by this report.',
    pairsEvaluated: evaluated,
    perPairIdr10mIndependentAccounts: {
      assumption: sumA,
      pairTaker: sumB,
      netPnlDeltaIdr: Number((sumB.netPnlIdr - sumA.netPnlIdr).toFixed(2)),
      tradeCountDelta: sumB.trades - sumA.trades,
    },
    scopeWarning: 'Stored 5m candles only, independent per-pair accounts, no shared portfolio, no historical quotes. Not a production P&L forecast.',
    pairs: perPair,
  }, null, 2));
}

if (process.argv[1]?.endsWith('fee-sensitivity.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
