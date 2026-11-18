import { describe, expect, it } from 'vitest';
import { computeIndicators, DEFAULT_PARAMS, mergeParams } from '../shared/strategy';
import type { Candle } from '../shared/candles';

// scripts/backtest.ts fails fast on missing Supabase env at import time; the simulation
// itself is pure and never touches the network, so dummy values are enough here.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-key';
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

/** A parameter set that fires many trades on the oscillator (loosest possible BUY gate). */
// mtfMode is pinned off here so this suite isolates the 5m crossover engine; MTF gating
// parity is covered by tests/backtest-mtf-parity.test.ts.
const LOOSE = mergeParams({
  ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
  useTrendFilter: false, maxEntryExtensionPct: 0, mtfMode: 'off',
});

describe('backtest causality (no lookahead)', () => {
  it('indicators for a prefix equal the prefix of the full-series indicators', () => {
    const candles = oscillator(1200, 60, 0.03);
    const full = computeIndicators(candles, LOOSE);
    // A causal indicator only ever reads candles up to its own index. Recomputing on a
    // prefix must therefore reproduce exactly the same rows, byte for byte.
    for (const k of [80, 200, 500, 900]) {
      const prefix = computeIndicators(candles.slice(0, k), LOOSE);
      expect(prefix).toEqual(full.slice(0, k));
    }
  });

  it('adding future candles never changes past trades', () => {
    const candles = oscillator(4000, 60, 0.03);
    const full = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(full.length).toBeGreaterThan(5);

    for (const k of [1500, 2500, 3200]) {
      const cutTime = candles[k].t;
      // Every trade the full run closed at or before the cut must be reproduced identically
      // when the simulation is run on data that ends at the cut.
      const expected = full.filter((t) => t.exitTime <= cutTime);
      const prefixRun = simulate('xidr', candles.slice(0, k + 1), LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2);
      // The prefix run's only legitimate extra trade is the forced close of a position that
      // is still open at the cut; that END_OF_DATA trade must not appear in the full run.
      const actual = prefixRun.filter((t) => t.reason !== 'END_OF_DATA');

      expect(actual).toEqual(expected);
    }
  });

  it('a trade entered after the cut never appears before it', () => {
    const candles = oscillator(4000, 60, 0.03);
    const cutIdx = 2000;
    const cutTime = candles[cutIdx].t;
    const prefixRun = simulate('xidr', candles.slice(0, cutIdx + 1), LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2);
    // A decision made at the cut can only fill on the next candle, so no trade may be
    // entered on or after the final available candle of a truncated series.
    for (const t of prefixRun) {
      if (t.reason === 'END_OF_DATA') continue;
      expect(t.entryTime).toBeLessThan(cutTime);
      expect(t.exitTime).toBeLessThanOrEqual(cutTime);
    }
  });
});
