/**
 * Market-regime gate experiment.
 *
 * Long-only entries lose in a broad downtrend no matter how the bracket is shaped: every pair
 * in the sample fell 20-96% while the strategy was live. A regime gate refuses new longs unless
 * the market itself is rising, which is a structural filter rather than a curve-fitted one.
 *
 * The gate is evaluated on a reference pair (BTC by default) using only information available at
 * the signal bar. For each candidate gate (reference close vs its EMA over N bars, plus an
 * optional minimum slope), the same production simulate() is run and the results compared with
 * the ungated baseline.
 *
 * Usage: tsx scripts/regime-gate-test.ts [--ref=btcidr] [--trend=50,100,200]
 */
import { createClient } from '@supabase/supabase-js';
import { computeStats } from '../shared/paper';
import { computeIndicators, mergeParams, type StrategyParams } from '../shared/strategy';
import { fillGaps, type Candle } from '../shared/candles';
import { inferIntervalSec, simulate, type SimTrade } from './backtest';

const argv = process.argv.slice(2);
const arg = (n: string) => argv.find((a: string) => a.startsWith(`--${n}=`))?.split('=')[1];
const refPair = arg('ref') ?? 'btcidr';
const trendGrid = (arg('trend') ?? '50,100,200').split(',').map(Number);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

async function load(pairId: string): Promise<Candle[]> {
  const rows: { open_time: string; open: number; high: number; low: number; close: number; volume: number; source: string }[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from('candles')
      .select('open_time,open,high,low,close,volume,source')
      .eq('pair_id', pairId).eq('timeframe', '5m').eq('is_closed', true)
      .order('open_time', { ascending: true }).range(off, off + 999);
    if (error) throw new Error(`${pairId}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < 1000) break;
  }
  return rows.map((r) => ({
    t: Math.floor(new Date(r.open_time).getTime() / 1000),
    o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume),
    source: r.source === 'synthetic' ? 'synthetic' : 'official',
  })) as Candle[];
}

interface GateResult {
  emaTrend: number;
  trades: number;
  winRatePct: number;
  profitFactor: number | null;
  netPnl: number;
  expectancy: number;
  avgWinPct: number;
  avgLossPct: number;
}

function summarize(trades: SimTrade[], emaTrend: number): GateResult {
  const s = computeStats(trades.map((t) => ({ realized_pnl: t.pnl, cost_basis: t.cost })));
  const w = trades.filter((t) => t.pnl > 0), l = trades.filter((t) => t.pnl <= 0);
  const avgWin = w.length ? w.reduce((a, t) => a + t.pnl / t.cost * 100, 0) / w.length : 0;
  const avgLoss = l.length ? l.reduce((a, t) => a + t.pnl / t.cost * 100, 0) / l.length : 0;
  return {
    emaTrend,
    trades: s.trades,
    winRatePct: Number(s.winRate.toFixed(2)),
    profitFactor: s.profitFactor === null ? null : Number(s.profitFactor.toFixed(3)),
    netPnl: Number(s.totalPnl.toFixed(0)),
    expectancy: s.trades ? Number((s.totalPnl / s.trades).toFixed(0)) : 0,
    avgWinPct: Number(avgWin.toFixed(3)),
    avgLossPct: Number(avgLoss.toFixed(3)),
  };
}

async function main() {
  const { data: cfg } = await db.from('strategy_configs').select('params').eq('is_active', true).limit(1);
  if (!cfg?.[0]) throw new Error('No active strategy config');
  const p: StrategyParams = mergeParams(cfg[0].params);

  const { data: pairsData } = await db.from('market_pairs')
    .select('id,symbol,is_tracked,in_universe,trade_fee_percent_taker').eq('is_maintenance', false).limit(1000);
  const pairs = ((pairsData ?? []) as { id: string; symbol: string; is_tracked: boolean; in_universe: boolean; trade_fee_percent_taker: number | null }[])
    .filter((r) => r.is_tracked || r.in_universe);

  const { data: volData } = await db.from('market_tickers_latest').select('pair_id,vol_idr');
  const vols: Record<string, number> = {};
  for (const v of (volData ?? []) as { pair_id: string; vol_idr: number }[]) vols[v.pair_id] = Number(v.vol_idr);

  const refCandles = await load(refPair);
  if (!refCandles.length) throw new Error(`reference pair ${refPair} has no candles`);

  // Bullish bar timestamps per candidate EMA length, derived causally from the reference pair.
  const gateByTrend: Record<number, Set<number>> = {};
  for (const n of trendGrid) {
    const refRows = computeIndicators(refCandles, { ...p, emaTrend: n });
    const bullish = new Set<number>();
    for (let i = 0; i < refCandles.length; i++) {
      const row = refRows[i];
      if (row?.ema50 === null || row?.ema50 === undefined) continue;
      if (row.close > row.ema50) bullish.add(refCandles[i].t);
    }
    gateByTrend[n] = bullish;
  }

  const results: Record<string, unknown> = {};
  for (const n of trendGrid) {
    const bullish = gateByTrend[n];
    const gated: SimTrade[] = [];
    const ungated: SimTrade[] = [];
    for (const pair of pairs) {
      const raw = await load(pair.id);
      if (raw.length < p.minCandles + 60) continue;
      const series = fillGaps(raw, inferIntervalSec(raw));
      const all = simulate(pair.id, series, p, 10_000_000, vols[pair.id] ?? null,
        'crossover', 0, pair.trade_fee_percent_taker);
      ungated.push(...all);
      // Keep only trades whose ENTRY bar was in a bullish reference regime.
      for (const t of all) {
        const entryBar = series.find((c) => c.t === t.entryTime);
        if (entryBar && bullish.has(entryBar.t)) gated.push(t);
      }
    }
    results[`ema${n}`] = {
      ungated: summarize(ungated, n),
      gated: summarize(gated, n),
    };
  }

  // Breadth gate: long-only is only viable when the market as a whole is rising. For every bar
  // timestamp, compute the fraction of the tracked universe trading above its own EMA(N); allow a
  // new long only when that fraction clears a threshold. This is regime detection, not curve
  // fitting: it makes the engine stand aside in a broad downtrend instead of buying every bounce.
  const breadthResults: Record<string, unknown> = {};
  const perPairRows = new Map<string, Map<number, boolean>>();
  for (const pair of pairs) {
    const raw = await load(pair.id);
    if (raw.length < p.minCandles + 60) continue;
    for (const n of trendGrid) {
      const rows = computeIndicators(raw, { ...p, emaTrend: n });
      const m = new Map<number, boolean>();
      for (let i = 0; i < raw.length; i++) {
        const row = rows[i];
        if (row?.ema50 === null || row?.ema50 === undefined) continue;
        m.set(raw[i].t, row.close > row.ema50);
      }
      perPairRows.set(`${pair.id}:${n}`, m);
    }
  }
  for (const n of trendGrid) {
    for (const threshold of [0.4, 0.5, 0.6, 0.7]) {
      const gated: SimTrade[] = [];
      let ungated: SimTrade[] = [];
      for (const pair of pairs) {
        const raw = await load(pair.id);
        if (raw.length < p.minCandles + 60) continue;
        const series = fillGaps(raw, inferIntervalSec(raw));
        const all = simulate(pair.id, series, p, 10_000_000, vols[pair.id] ?? null,
          'crossover', 0, pair.trade_fee_percent_taker);
        ungated = ungated.concat(all);
        for (const t of all) {
          let bullishCount = 0, total = 0;
          for (const other of pairs) {
            const m = perPairRows.get(`${other.id}:${n}`);
            const v = m?.get(t.entryTime);
            if (v === undefined) continue;
            total++;
            if (v) bullishCount++;
          }
          if (total > 0 && bullishCount / total >= threshold) gated.push(t);
        }
      }
      breadthResults[`ema${n}_breadth${threshold}`] = {
        ungated: summarize(ungated, n),
        gated: summarize(gated, n),
      };
    }
  }

  console.log(JSON.stringify({
    referencePair: refPair,
    gate: 'reference close > its own EMA(N) at the entry bar',
    results,
    breadthGate: 'fraction of universe above its own EMA(N) at the entry bar >= threshold',
    breadthResults,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
