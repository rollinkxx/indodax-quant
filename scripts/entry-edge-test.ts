/**
 * Entry edge test: is the BUY signal better than a coin flip?
 *
 * The bracket sweep found no geometry above break-even, and the realised hit rate tracked the
 * break-even rate of each bracket rather than beating it, which is what a driftless series does.
 * That points at the entry rather than the geometry, so the entry is tested in isolation here:
 * raw forward returns after each BUY, with no stop, no target and no costs.
 *
 * This measures raw forward returns after each BUY signal, with no stop, no target and no
 * costs, at several horizons. A directional edge shows up as a mean forward return that is
 * reliably positive and as a hit rate above 50%. A random walk gives a mean near zero and a
 * hit rate near 50% at every horizon.
 */
import { createClient } from '@supabase/supabase-js';

import { computeIndicators, mergeParams, evaluateMarketAction, type StrategyParams } from '../shared/strategy';
import { hasBacktestDataQuality } from '../shared/backtestScope';
import { fillGaps, type Candle } from '../shared/candles';
import { inferIntervalSec } from './backtest';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const HORIZONS = [1, 3, 6, 12, 24, 48];

async function loadPairCandles(pairId: string): Promise<Candle[]> {
  const rows: { open_time: string; open: number; high: number; low: number; close: number; volume: number; source: string }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('candles')
      .select('open_time,open,high,low,close,volume,source')
      .eq('pair_id', pairId).eq('timeframe', '5m').eq('is_closed', true)
      .order('open_time', { ascending: true }).range(offset, offset + 999);
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

async function main() {
  const { data: cfg } = await db.from('strategy_configs').select('params').eq('is_active', true).limit(1);
  if (!cfg?.[0]) throw new Error('No active strategy config');
  const p: StrategyParams = mergeParams(cfg[0].params);

  const { data: pairsData } = await db.from('market_pairs')
    .select('id,is_tracked,in_universe').eq('is_maintenance', false).limit(1000);
  const pairs = ((pairsData ?? []) as { id: string; is_tracked: boolean; in_universe: boolean }[])
    .filter((r) => r.is_tracked || r.in_universe);

  // Accumulate per-horizon forward returns across every pair, plus a same-pair baseline of
  // returns from randomly chosen bars so the signal can be compared with the drift of the asset.
  const signalReturns: Record<number, number[]> = {};
  // Per-signal conditioning variables, aligned with signalReturns insertion order.
  const buckets: Record<string, (number | null)[]> = {
    rsi14: [], volumeRatio: [], extensionPct: [], atrPct: [], trendGapPct: [], strength: [],
  };
  const baselineReturns: Record<number, number[]> = {};
  for (const h of HORIZONS) { signalReturns[h] = []; baselineReturns[h] = []; }
  let signals = 0, bars = 0;

  for (const pair of pairs) {
    const raw = await loadPairCandles(pair.id);
    if (raw.length < p.minCandles + 60) continue;
    const series = fillGaps(raw, inferIntervalSec(raw));
    const rows = computeIndicators(series, p);
    const win = Math.max(3, p.crossLookback + 1);
    bars += series.length;

    for (let i = p.minCandles; i < series.length; i++) {
      const c = series[i];
      if (c.source === 'synthetic' || c.v <= 0) continue;
      const entry = series[i + 1]?.o;
      if (!entry || entry <= 0) continue;
      for (const h of HORIZONS) {
        const exitIdx = i + 1 + h;
        if (exitIdx >= series.length) continue;
        const exit = series[exitIdx].c;
        if (!(exit > 0)) continue;
        // Baseline: every valid bar, so it captures the asset's own drift over the same sample.
        baselineReturns[h].push((exit - entry) / entry * 100);
      }
      if (!hasBacktestDataQuality(series, i, p.minCandles, inferIntervalSec(series))) continue;
      const action = evaluateMarketAction(rows.slice(i - win + 1, i + 1),
        series.slice(i - win + 1, i + 1).map((x) => x.v), p);
      if (action.signal?.side !== 'BUY') continue;
      signals++;
      const lastRow = rows[i];
      buckets.rsi14.push(lastRow.rsi14);
      buckets.volumeRatio.push(lastRow.volMa20 && lastRow.volMa20 > 0 ? series[i].v / lastRow.volMa20 : null);
      buckets.extensionPct.push(lastRow.ema21 && lastRow.ema21 > 0 ? (lastRow.close - lastRow.ema21) / lastRow.ema21 * 100 : null);
      buckets.atrPct.push(lastRow.atr14 && lastRow.close > 0 ? lastRow.atr14 / lastRow.close * 100 : null);
      buckets.trendGapPct.push(lastRow.ema50 && lastRow.ema50 > 0 ? (lastRow.close - lastRow.ema50) / lastRow.ema50 * 100 : null);
      buckets.strength.push(action.signal.strength);
      for (const h of HORIZONS) {
        const exitIdx = i + 1 + h;
        if (exitIdx >= series.length) continue;
        signalReturns[h].push((series[exitIdx].c - entry) / entry * 100);
      }
    }
  }

  const stat = (xs: number[]) => {
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
    const se = sd / Math.sqrt(xs.length);
    return {
      n: xs.length,
      meanPct: Number(mean.toFixed(4)),
      medianPct: Number([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(4)),
      hitRatePct: Number((100 * xs.filter((x) => x > 0).length / xs.length).toFixed(2)),
      tStat: Number((mean / se).toFixed(2)),
    };
  };

  // Selectivity test: if any conditioning variable separates good signals from bad ones, taking
  // only the top bucket can lift the mean forward return above round-trip cost. Buckets are
  // thirds of the observed distribution, measured at the horizon that showed the largest excess.
  const H = 24;
  const conditioned: Record<string, Record<string, ReturnType<typeof stat>>> = {};
  for (const [name, values] of Object.entries(buckets)) {
    const valid = values.map((v, i) => ({ v, r: signalReturns[H][i] }))
      .filter((x) => x.v !== null && Number.isFinite(x.v) && Number.isFinite(x.r));
    if (valid.length < 30) continue;
    valid.sort((a, b) => (a.v as number) - (b.v as number));
    const third = Math.floor(valid.length / 3);
    conditioned[name] = {
      low: stat(valid.slice(0, third).map((x) => x.r)),
      mid: stat(valid.slice(third, third * 2).map((x) => x.r)),
      high: stat(valid.slice(third * 2).map((x) => x.r)),
    };
  }

  console.log(JSON.stringify({
    pairs: pairs.length, bars, signals,
    interpretation: 'tStat beyond +/-2 means the signal differs from zero at ~95% confidence',
    signal: Object.fromEntries(HORIZONS.map((h) => [h, stat(signalReturns[h])])),
    baseline: Object.fromEntries(HORIZONS.map((h) => [h, stat(baselineReturns[h])])),
    selectivityAt24Bars: conditioned,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
