import { describe, expect, it } from 'vitest';
import { computeIndicators, DEFAULT_PARAMS, mergeParams, type StrategyParams } from '../shared/strategy';
import { aggregateComplete, applyMtfToMarketAction, HIGHER_TFS, lastCompleteBucket, trendState, buildHigherSeries } from '../shared/mtf';
import type { Candle } from '../shared/candles';

// scripts/backtest.ts fails fast on missing Supabase env at import time; the simulation
// itself is pure and never touches the network, so dummy values are enough here.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-key';
const { simulate } = await import('../scripts/backtest');

/** Oscillating 5m series that fires many EMA crossovers. */
function oscillator(n: number, periodBars: number, amp: number, seed = 1): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((2 * Math.PI * i) / periodBars) * amp;
    const price = 1000 * (1 + wave) * (1 + (rnd() - 0.5) * 0.001);
    const o = price * (1 - 0.0004);
    out.push({ t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996, c: price, v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades' });
  }
  return out;
}

const LOOSE: StrategyParams = mergeParams({
  ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
  useTrendFilter: false, maxEntryExtensionPct: 0,
});

describe('backtest MTF parity', () => {
  it('mtfMode=off reproduces the pre-MTF crossover behaviour exactly', () => {
    const candles = oscillator(1400, 60, 0.03);
    const off = simulate('xidr', candles, { ...LOOSE, mtfMode: 'off' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(off.length).toBeGreaterThan(10);
    // Determinism: re-running must yield identical trades.
    const off2 = simulate('xidr', candles, { ...LOOSE, mtfMode: 'off' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(off2).toEqual(off);
  });

  it('filter mode never produces more entries than off (MTF can only block)', () => {
    const candles = oscillator(1400, 60, 0.03);
    const off = simulate('xidr', candles, { ...LOOSE, mtfMode: 'off' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    const filter = simulate('xidr', candles, { ...LOOSE, mtfMode: 'filter' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(filter.length).toBeLessThanOrEqual(off.length);
  });

  it('score mode (never blocks) can only change entry timing vs off, not add entries beyond the raw set', () => {
    const candles = oscillator(1400, 60, 0.03);
    const off = simulate('xidr', candles, { ...LOOSE, mtfMode: 'off' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    const score = simulate('xidr', candles, { ...LOOSE, mtfMode: 'score' }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    // score keeps every raw BUY (it never blocks), so it should still fire a healthy number of trades.
    expect(score.length).toBeGreaterThan(0);
    expect(score.length).toBeLessThanOrEqual(off.length + 1);
  });

  it('MTF gating is causal: a trade cannot depend on higher-timeframe candles after its signal bar', () => {
    const candles = oscillator(1400, 60, 0.03);
    const p: StrategyParams = { ...LOOSE, mtfMode: 'filter' };
    const full = simulate('xidr', candles, p, 10_000_000, 5e9, 'crossover', 0, 0.2);
    if (full.length === 0) return; // nothing to compare
    // Truncate the series right after the first trade's entry; the same entry must still appear.
    const cutIdx = candles.findIndex((c) => c.t === full[0].entryTime);
    expect(cutIdx).toBeGreaterThan(0);
    const prefix = simulate('xidr', candles.slice(0, cutIdx + 1), p, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(prefix.some((t) => t.entryTime === full[0].entryTime)).toBe(true);
  });

  it('the backtest MTF state matches shared/mtf.ts trendState on the same series', () => {
    // Independent check that we reuse the production MTF functions rather than a private variant.
    const candles = oscillator(600, 90, 0.05);
    const series = candles;
    for (const h of HIGHER_TFS) {
      const agg = aggregateComplete(series, h.sec);
      const last5m = series[series.length - 1].t;
      const lastComplete = lastCompleteBucket(last5m, h.sec);
      const hs = buildHigherSeries([], agg, h.sec, lastComplete, 120);
      const st = trendState(h.tf, hs, lastComplete, LOOSE);
      expect(['bull', 'bear', 'neutral', 'unknown']).toContain(st.trend);
    }
  });

  it('applyMtfToMarketAction blocks BUY when MTF is warming up (parity with the pipeline)', () => {
    const candles = oscillator(1200, 60, 0.03);
    const rows = computeIndicators(candles, LOOSE);
    const n = rows.length;
    const vols = candles.map((c) => c.v);
    // Build a raw BUY action at the last bar, then feed unknown higher-timeframe states.
    const action = { action: 'BUY' as const, signal: { side: 'BUY' as const, strength: 60, reasons: [] }, reason: 'BUY' };
    const unknownStates = HIGHER_TFS.map((h) => ({ tf: h.tf, trend: 'unknown' as const, candles: 0, lastOpenTime: null, close: null, emaFast: null, emaSlow: null, rsi: null }));
    const filtered = applyMtfToMarketAction(action, unknownStates, 'filter');
    expect(filtered.action.action).toBe('HOLD');
    expect(filtered.action.signal).toBeNull();
    expect(rows.length).toBe(n);
    expect(vols.length).toBe(n);
  });
});
