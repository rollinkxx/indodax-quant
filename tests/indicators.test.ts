import { describe, expect, it } from 'vitest';
import { atr, ema, macd, rsi, sma, supportResistance, type OHLCV } from '../shared/indicators';

// Wilder's classic RSI example (closes from "New Concepts in Technical Trading Systems" / StockCharts).
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];

describe('sma / ema', () => {
  it('sma aligns with input and has leading nulls', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('ema is seeded with the sma', () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[1]).toBeNull();
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3, 10);
    expect(e[4]).toBeCloseTo(4, 10);
  });
  it('ema returns all nulls when too short', () => {
    expect(ema([1, 2], 5).every((x) => x === null)).toBe(true);
  });
});

describe('rsi (Wilder)', () => {
  it('matches the exact Wilder value 70.46 at index 14 (StockCharts shows 70.53 from rounded averages)', () => {
    const r = rsi(WILDER, 14);
    expect(r[13]).toBeNull();
    expect(r[14]).toBeCloseTo(70.464, 2);
    expect(r[15]).toBeCloseTo(66.25, 0);
    expect(r[15]!).toBeLessThan(r[14]!);
  });
  it('is 100 for a strictly rising series and 50 when flat', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3)[4]).toBe(50);
  });
  it('stays within [0, 100]', () => {
    const xs = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.1);
    for (const v of rsi(xs, 14)) if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });
});

describe('macd', () => {
  it('hist = macd - signal and first value appears after slow + signal warm-up', () => {
    const xs = Array.from({ length: 80 }, (_, i) => 100 + i + Math.sin(i) * 3);
    const m = macd(xs);
    expect(m.macd[24]).toBeNull();
    expect(m.macd[25]).not.toBeNull();
    expect(m.signal[25 + 7]).toBeNull();
    expect(m.signal[25 + 8]).not.toBeNull();
    for (let i = 0; i < xs.length; i++) {
      if (m.hist[i] !== null) expect(m.hist[i]!).toBeCloseTo(m.macd[i]! - m.signal[i]!, 10);
    }
  });
  it('is positive in a steady uptrend', () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 * 1.01 ** i);
    expect(macd(xs).macd[59]!).toBeGreaterThan(0);
  });
});

describe('atr', () => {
  it('constant range gives constant ATR', () => {
    const cs: OHLCV[] = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 105, l: 95, c: 100, v: 1 }));
    const a = atr(cs, 14);
    expect(a[12]).toBeNull();
    expect(a[13]).toBe(10);
    expect(a[19]).toBe(10);
  });
  it('uses previous close for gaps (true range)', () => {
    const cs: OHLCV[] = [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 1 }, { t: 1, o: 110, h: 111, l: 109, c: 110, v: 1 }];
    expect(atr(cs, 2)[1]).toBe((2 + 11) / 2);
  });
});

describe('support / resistance', () => {
  it('finds pivot low below and pivot high above the close', () => {
    const prices = [100, 98, 95, 98, 100, 104, 108, 104, 101, 99, 101, 103];
    const cs: OHLCV[] = prices.map((p, i) => ({ t: i, o: p, h: p + 1, l: p - 1, c: p, v: 1 }));
    const sr = supportResistance(cs, 50, 2);
    expect(sr.support).toBe(98); // highest pivot low below the close (pivot lows: 94, 98)
    expect(sr.resistance).toBe(109);
  });
  it('handles empty input', () => {
    expect(supportResistance([])).toEqual({ support: null, resistance: null });
  });
});
