import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  BASE_TIMEFRAMES, TIMEFRAME_SPECS, isTradableTimeframe, maxHoldingSeconds, resampleCandles, timeframeSpec,
  usableHigherTimeframes, validateTimeframeSpec,
} from '../shared/timeframes';

describe('timeframe contract', () => {
  it('defines a spec for every supported base timeframe', () => {
    for (const tf of BASE_TIMEFRAMES) expect(TIMEFRAME_SPECS[tf]).toBeDefined();
    expect(BASE_TIMEFRAMES).toEqual(['5m', '1h', '4h']);
  });

  it('every shipped spec satisfies the contract', () => {
    for (const tf of BASE_TIMEFRAMES) {
      expect(validateTimeframeSpec(timeframeSpec(tf))).toEqual([]);
    }
  });

  it('5m is production; 1h and 4h are research-only until the pipeline supports them', () => {
    expect(timeframeSpec('5m').status).toBe('PRODUCTION');
    expect(isTradableTimeframe(timeframeSpec('5m'))).toBe(true);
    expect(isTradableTimeframe(timeframeSpec('1h'))).toBe(false);
    expect(isTradableTimeframe(timeframeSpec('4h'))).toBe(false);
  });

  it('rejects a higher timeframe that is not a multiple of the base', () => {
    const bad = { ...timeframeSpec('5m'), higherTimeframes: [900, 1000] };
    expect(validateTimeframeSpec(bad)).toContain('higher timeframe 1000s is not a multiple of base 300s');
  });

  it('rejects a higher timeframe smaller than the base', () => {
    const bad = { ...timeframeSpec('1h'), higherTimeframes: [1800] };
    expect(validateTimeframeSpec(bad).join()).toMatch(/must exceed base/);
  });

  it('rejects a signal interval that differs from the base', () => {
    expect(validateTimeframeSpec({ ...timeframeSpec('5m'), signalSeconds: 60 })).toContain('signalSeconds must equal baseSeconds');
  });

  it('only exposes higher timeframes usable against the base', () => {
    expect(usableHigherTimeframes(timeframeSpec('5m'))).toEqual([900, 3600]);
    expect(usableHigherTimeframes(timeframeSpec('1h'))).toEqual([14_400]);
    expect(usableHigherTimeframes(timeframeSpec('4h'))).toEqual([]);
    // With a 1h base series, the 5m spec's 15m/1h buckets are not larger than the base.
    expect(usableHigherTimeframes(timeframeSpec('5m'), 3600)).toEqual([]);
  });

  it('scales the time stop with the timeframe', () => {
    expect(maxHoldingSeconds(timeframeSpec('5m'))).toBe(288 * 300);
    expect(maxHoldingSeconds(timeframeSpec('1h'))).toBe(120 * 3600);
    expect(maxHoldingSeconds(timeframeSpec('4h'))).toBe(90 * 14_400);
  });
});

describe('resample contract', () => {
  const bar = (t: number, c: number, v = 100, source: 'trades' | 'history' | 'synthetic' = 'trades'): Candle => ({
    t, o: c, h: c + 1, l: c - 1, c, v, n: v > 0 ? 5 : 0, source,
  });
  const series = (n: number, start = 1_800_000_000 - (1_800_000_000 % 3600), step = 300): Candle[] =>
    Array.from({ length: n }, (_, i) => bar(start + i * step, 1000 + i));

  it('aggregates 5m bars into complete 1h buckets', () => {
    const out = resampleCandles(series(24), 3600, 300);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: 1_800_000_000 - (1_800_000_000 % 3600), o: 1000, c: 1011 });
    expect(out[0].v).toBe(12 * 100);
  });

  it('drops a trailing incomplete bucket so no partial bar can signal', () => {
    const out = resampleCandles(series(18), 3600, 300);
    expect(out).toHaveLength(1);
  });

  it('never emits a bucket that ends after the last observed bar', () => {
    const s = series(24);
    for (const bucket of resampleCandles(s, 3600, 300)) {
      expect(bucket.t + 3600).toBeLessThanOrEqual(s[s.length - 1].t + 300);
    }
  });

  it('marks a bucket containing a gap filler as synthetic with zero volume', () => {
    const s = series(12);
    s[3] = { ...s[3], v: 0, n: 0, source: 'synthetic' };
    const [bucket] = resampleCandles(s, 3600, 300);
    expect(bucket.source).toBe('synthetic');
    expect(bucket.v).toBe(0);
    expect(bucket.n).toBe(0);
  });

  it('refuses to resample down to a finer interval', () => {
    expect(() => resampleCandles(series(12), 60, 300)).toThrow(/cannot resample/);
  });

  it('refuses a target that is not an exact multiple of the base', () => {
    expect(() => resampleCandles(series(12), 1000, 300)).toThrow(/not a multiple/);
  });

  it('preserves OHLC ordering across the bucket', () => {
    const s = series(12);
    s[5] = { ...s[5], h: 5000, l: 1 };
    const [bucket] = resampleCandles(s, 3600, 300);
    expect(bucket.h).toBe(5000);
    expect(bucket.l).toBe(1);
    expect(bucket.h).toBeGreaterThanOrEqual(bucket.o);
    expect(bucket.l).toBeLessThanOrEqual(bucket.c);
  });
});
