import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, mergeParams } from '../shared/strategy';
import type { Candle } from '../shared/candles';

const { simulate } = await import('../scripts/backtest');

/** Oscillating series that forces repeated EMA9/EMA21 crossovers so entries actually fire. */
function oscillator(n: number, periodBars: number, amp: number, seed = 1): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((2 * Math.PI * i) / periodBars) * amp;
    const price = 1000 * (1 + wave) * (1 + (rnd() - 0.5) * 0.001);
    const o = price * (1 - 0.0004);
    out.push({
      t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996,
      c: price, v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades',
    });
  }
  return out;
}

describe('simulate fee parity', () => {
  it('sizes positions with the effective per-pair fee, not params.feePct', () => {
    const base = mergeParams({
      ...DEFAULT_PARAMS, feeModel: 'pair_taker', feePct: 0.00555,
      rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0, useTrendFilter: false, maxEntryExtensionPct: 0,
      mtfMode: 'off',
    });
    const candles = oscillator(3000, 60, 0.03);
    const PAIR_FEE = 0.2;

    // Under 'pair_taker' the charged fee comes from PAIR_FEE. Changing the assumption feePct must
    // not change sizing; if it does, simulate() is sizing with the wrong fee (production-parity bug).
    const a = simulate('xidr', candles, base, 10_000_000, 5e9, 'crossover', 0, PAIR_FEE);
    const b = simulate('xidr', candles, { ...base, feePct: 2 }, 10_000_000, 5e9, 'crossover', 0, PAIR_FEE);

    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    const costA = a.reduce((sum, t) => sum + t.cost, 0);
    const costB = b.reduce((sum, t) => sum + t.cost, 0);
    expect(costA).toBeCloseTo(costB, 6);
  });

  it('charges the pair fee on exit as well as entry', () => {
    const p = mergeParams({ ...DEFAULT_PARAMS, feeModel: 'pair_taker', mtfMode: 'off' });
    const candles = oscillator(3000, 60, 0.03);
    const cheap = simulate('xidr', candles, p, 10_000_000, 5e9, 'crossover', 0, 0.00555);
    const dear = simulate('xidr', candles, p, 10_000_000, 5e9, 'crossover', 0, 2);
    const netCheap = cheap.reduce((sum, t) => sum + t.pnl, 0);
    const netDear = dear.reduce((sum, t) => sum + t.pnl, 0);
    // Higher fees must not improve net PnL.
    expect(netDear).toBeLessThanOrEqual(netCheap + 1e-6);
  });
});

describe('minNotional parity with live positionSize', () => {
  // Live passes the pair's trade_min_base_currency to positionSize; the backtest used to rely on
  // the 10,000 default. A pair whose catalog minimum is higher must lose those entries here too.
  const candles = oscillator(3000, 60, 0.03);
  const LOOSE = mergeParams({
    ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
    useTrendFilter: false, maxEntryExtensionPct: 0, mtfMode: 'off',
  });

  it('takes the trade when the notional clears the pair minimum', () => {
    const trades = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, null, 10_000);
    expect(trades.length).toBeGreaterThan(0);
  });

  it('rejects every entry when the pair minimum exceeds the sized notional', () => {
    // 1e9 IDR minimum cannot be met by a 10M equity account at riskPerTradePct, so nothing opens.
    const trades = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, null, 1e9);
    expect(trades).toEqual([]);
  });

  it('falls back to the 10,000 default when the catalog value is absent', () => {
    const withNull = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, null, null);
    const withDefault = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, null, 10_000);
    expect(withNull).toEqual(withDefault);
  });
});
