import { describe, expect, it } from 'vitest';
import { computeIndicators, DEFAULT_PARAMS, mergeParams, type StrategyParams } from '../shared/strategy';
import { createIndicatorRowsCache, signalAtBar } from '../shared/backtestSignal';
import type { Candle } from '../shared/candles';

/** Oscillating series with enough amplitude to fire EMA crossovers once indicators are seeded. */
function oscillator(n: number, periodBars: number, amp: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const price = 1000 * (1 + Math.sin((2 * Math.PI * i) / periodBars) * amp);
    const o = price * 0.9996;
    out.push({
      t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996, c: price,
      v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades',
    });
  }
  return out;
}

const PERMISSIVE: StrategyParams = mergeParams({
  ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
  useTrendFilter: false, maxEntryExtensionPct: 0, mtfMode: 'off',
});

describe('portfolio backtest signal seeding', () => {
  it('produces BUY signals on a seeded series (a window-only slice would produce none)', () => {
    const candles = oscillator(900, 60, 0.03);
    const rowsFor = createIndicatorRowsCache();
    let buys = 0;
    for (let i = 250; i < candles.length; i++) {
      if (signalAtBar('xidr', candles, i, PERMISSIVE, rowsFor) === 'BUY') buys++;
    }
    expect(buys).toBeGreaterThan(0);
  });

  it('signalAtBar agrees with indicators computed over the whole series', () => {
    const candles = oscillator(900, 60, 0.03);
    const rowsFor = createIndicatorRowsCache();
    const full = computeIndicators(candles, PERMISSIVE);
    const whole = (pair: string) => () => full;
    for (let i = 250; i < candles.length; i += 17) {
      expect(signalAtBar('xidr', candles, i, PERMISSIVE, rowsFor))
        .toBe(signalAtBar('xidr', candles, i, PERMISSIVE, whole('xidr')));
    }
  });

  it('returns HOLD before enough bars exist for the decision window', () => {
    const candles = oscillator(900, 60, 0.03);
    const rowsFor = createIndicatorRowsCache();
    expect(signalAtBar('xidr', candles, 0, PERMISSIVE, rowsFor)).toBe('HOLD');
    expect(signalAtBar('xidr', candles, 1, PERMISSIVE, rowsFor)).toBe('HOLD');
  });

  it('caches rows per pair instead of recomputing on every call', () => {
    const candles = oscillator(900, 60, 0.03);
    const rowsFor = createIndicatorRowsCache();
    const first = rowsFor('xidr', candles, PERMISSIVE);
    expect(rowsFor('xidr', candles, PERMISSIVE)).toBe(first);
    expect(rowsFor('otheridr', candles, PERMISSIVE)).not.toBe(first);
  });
});
