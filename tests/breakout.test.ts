// F6: "Breaking resistance/support" could never fire because S/R included the signal candle itself.
import { describe, expect, it } from 'vitest';
import { supportResistance } from '../shared/indicators';
import { computeIndicators, DEFAULT_PARAMS, evaluateSignal, type IndicatorRow } from '../shared/strategy';
import type { Candle } from '../shared/candles';

const candle = (i: number, c: number, h = c + 1, l = c - 1): Candle => ({ t: i * 300, o: c, h, l, c, v: 10, n: 1, source: 'history' });
const flat = (n: number) => Array.from({ length: n }, (_, i) => candle(i, 100));

describe('supportResistance property (why the slice must exclude the signal candle)', () => {
  it('on a slice that includes the last candle, resistance >= close and support <= close', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 200; k++) {
      const cs = Array.from({ length: 60 }, (_, i) => { const c = 100 + rnd() * 20; return candle(i, c, c + rnd() * 3, c - rnd() * 3); });
      const sr = supportResistance(cs, 50);
      const close = cs[cs.length - 1].c;
      expect(sr.resistance!).toBeGreaterThanOrEqual(close);
      expect(sr.support!).toBeLessThanOrEqual(close);
    }
  });
});

describe('computeIndicators levels', () => {
  it('a bullish breakout candle closes above the previous resistance', () => {
    const rows = computeIndicators([...flat(70), candle(70, 105, 106, 100)], DEFAULT_PARAMS);
    const last = rows.at(-1)!;
    expect(last.resistance).toBe(101);
    expect(last.close).toBeGreaterThan(last.resistance!);
  });
  it('a bearish breakdown candle closes below the previous support', () => {
    const last = computeIndicators([...flat(70), candle(70, 95, 100, 94)], DEFAULT_PARAMS).at(-1)!;
    expect(last.support).toBe(99);
    expect(last.close).toBeLessThan(last.support!);
  });
  it('a flat series never reports a breakout', () => {
    for (const r of computeIndicators(flat(80), DEFAULT_PARAMS).slice(1)) {
      expect(r.close).toBeLessThanOrEqual(r.resistance!);
      expect(r.close).toBeGreaterThanOrEqual(r.support!);
    }
  });
  it('the first candle has no levels', () => {
    expect(computeIndicators(flat(3), DEFAULT_PARAMS)[0]).toMatchObject({ support: null, resistance: null });
  });
});

describe('breakout strength bonus', () => {
  const row = (o: Partial<IndicatorRow>): IndicatorRow => ({
    t: 0, close: 100, ema9: 100, ema21: 100, ema50: 95, rsi14: 60, macd: 0, macdSignal: 0, macdHist: 1, atr14: 2, volMa20: 10, support: 90, resistance: 120, ...o,
  });
  it('adds +10 and a reason on a BUY that breaks resistance, not otherwise', () => {
    const prev = row({ ema9: 99, ema21: 100 });
    const plain = evaluateSignal(row({ ema9: 101, ema21: 100 }), prev, 15)!;
    const broke = evaluateSignal(row({ ema9: 101, ema21: 100, resistance: 99 }), prev, 15)!;
    expect(broke.strength).toBe(plain.strength + 10);
    expect(broke.reasons).toContain('Breaking resistance');
    expect(plain.reasons).not.toContain('Breaking resistance');
  });
  it('adds +10 and a reason on a SELL that breaks support', () => {
    const prev = row({ ema9: 101, ema21: 100 });
    const base = { ema9: 99, ema21: 100, rsi14: 40, macdHist: -1 };
    const plain = evaluateSignal(row(base), prev, 25)!;
    const broke = evaluateSignal(row({ ...base, support: 101 }), prev, 25)!;
    expect(broke.strength).toBe(plain.strength + 10);
    expect(broke.reasons).toContain('Breaking support');
  });
});
