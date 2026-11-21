// FIX-B: the minCandles guard used its own warm-up expression
// (max(emaTrend, emaSlow, 26 + 9) + 2) while the indicator code uses
// max(emaTrend, 26 + 9, rsiPeriod + 1, volumeMaPeriod). volumeMaPeriod and rsiPeriod could
// therefore exceed minCandles without any error, which puts `degraded` back in reach: one
// synthetic candle inside that window blinds the pair for up to volumeMaPeriod bars.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, computeIndicatorsTail, indicatorWarmup, validateParams } from '../shared/strategy';
import type { Candle } from '../shared/candles';

const candles = (n: number, syntheticAt: number | null = null): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_800_000_000 + i * 300,
    o: 1000, h: 1001, l: 999, c: 1000 + i * 0.1,
    v: 5, n: 3,
    source: syntheticAt === i ? 'synthetic' : 'trades',
  }));

describe('FIX-B minCandles guard covers the real warm-up', () => {
  it('rejects minCandles below volumeMaPeriod', () => {
    expect(validateParams({ volumeMaPeriod: 80, minCandles: 60 }).length).toBeGreaterThan(0);
  });

  it('rejects minCandles below rsiPeriod + 1', () => {
    // emaTrend is pulled down to 5 so the old expression (max(emaTrend, emaSlow, 35) + 2 = 37)
    // accepts minCandles 40 while RSI needs 51 bars.
    expect(validateParams({ emaTrend: 5, rsiPeriod: 50, minCandles: 40 }).length).toBeGreaterThan(0);
  });

  it('accepts minCandles just above the longest warm-up', () => {
    expect(validateParams({ volumeMaPeriod: 80, minCandles: 82 })).toEqual([]);
  });

  it('keeps the default configuration valid', () => {
    expect(indicatorWarmup(DEFAULT_PARAMS)).toBe(50);
    expect(validateParams(DEFAULT_PARAMS as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('uses one warm-up definition for the guard and for the degraded flag', () => {
    const params = { ...DEFAULT_PARAMS, volumeMaPeriod: 80, minCandles: 82 };
    // A synthetic candle 60 bars back is inside the 80-bar warm-up: the row must be degraded.
    const rows = computeIndicatorsTail(candles(120, 60), params, 1);
    expect(rows[rows.length - 1].degraded).toBe(true);

    // 90 bars back is outside it.
    const clean = computeIndicatorsTail(candles(120, 30), params, 1);
    expect(clean[clean.length - 1].degraded).toBe(false);
  });

  it('still covers emaSlow, the longest EMA span a stored config can set', () => {
    expect(indicatorWarmup({ ...DEFAULT_PARAMS, emaSlow: 200 })).toBe(200);
    expect(validateParams({ emaSlow: 200, minCandles: 60 }).length).toBeGreaterThan(0);
  });
});
