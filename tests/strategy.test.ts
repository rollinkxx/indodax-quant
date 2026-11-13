import { describe, expect, it } from 'vitest';
import { checkDataQuality, DEFAULT_PARAMS, evaluateSignal, mergeParams, validateParams, type IndicatorRow } from '../shared/strategy';
import type { Candle } from '../shared/candles';

const row = (o: Partial<IndicatorRow>): IndicatorRow => ({
  t: 0, close: 100, ema9: 100, ema21: 100, ema50: 95, rsi14: 60, macd: 0, macdSignal: 0, macdHist: 1, atr14: 2, volMa20: 10, support: 90, resistance: 120, ...o,
});

describe('evaluateSignal', () => {
  it('BUY on EMA cross up + RSI in range + volume + trend', () => {
    const d = evaluateSignal(row({ ema9: 101, ema21: 100 }), row({ ema9: 99, ema21: 100 }), 15);
    expect(d?.side).toBe('BUY');
    expect(d!.strength).toBeGreaterThanOrEqual(60);
    expect(d!.reasons.join(' ')).toContain('EMA9 crossed above EMA21');
  });
  it('no BUY without volume confirmation', () => {
    expect(evaluateSignal(row({ ema9: 101, ema21: 100 }), row({ ema9: 99, ema21: 100 }), 11)).toBeNull();
  });
  it('no BUY when RSI out of range', () => {
    expect(evaluateSignal(row({ ema9: 101, ema21: 100, rsi14: 75 }), row({ ema9: 99, ema21: 100 }), 15)).toBeNull();
    expect(evaluateSignal(row({ ema9: 101, ema21: 100, rsi14: 45 }), row({ ema9: 99, ema21: 100 }), 15)).toBeNull();
  });
  it('trend filter blocks BUY below EMA50 unless disabled', () => {
    const last = row({ ema9: 101, ema21: 100, ema50: 110 });
    const prev = row({ ema9: 99, ema21: 100 });
    expect(evaluateSignal(last, prev, 15)).toBeNull();
    expect(evaluateSignal(last, prev, 15, { ...DEFAULT_PARAMS, useTrendFilter: false })?.side).toBe('BUY');
  });
  it('SELL on EMA cross down + RSI <= 50 + volume', () => {
    const d = evaluateSignal(row({ ema9: 99, ema21: 100, rsi14: 40, macdHist: -1 }), row({ ema9: 101, ema21: 100 }), 25);
    expect(d?.side).toBe('SELL');
    expect(d!.strength).toBe(90);
  });
  it('no signal without a crossover', () => {
    expect(evaluateSignal(row({ ema9: 102, ema21: 100 }), row({ ema9: 101, ema21: 100 }), 50)).toBeNull();
  });
  it('returns null when indicators are not warmed up', () => {
    expect(evaluateSignal(row({ rsi14: null }), row({}), 50)).toBeNull();
  });
});

describe('checkDataQuality', () => {
  const now = 1_763_000_000 - (1_763_000_000 % 300) + 30; // 30 s into a bucket
  const expectedLast = now - 30 - 300;
  const series = (n: number, lastPatch: Partial<Candle> = {}): Candle[] => Array.from({ length: n }, (_, i) => ({
    t: expectedLast - (n - 1 - i) * 300, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, source: 'trades' as const, ...(i === n - 1 ? lastPatch : {}),
  }));
  const base = { nowSec: now, intervalSec: 300, coveredUntilSec: expectedLast + 300, minCandles: 60 };
  it('accepts complete fresh data', () => {
    expect(checkDataQuality({ ...base, candles: series(60) })).toEqual({ ok: true });
  });
  it('rejects warm-up, stale, incomplete coverage and synthetic last candle', () => {
    expect(checkDataQuality({ ...base, candles: series(30) }).reason).toMatch(/warming_up/);
    expect(checkDataQuality({ ...base, candles: series(60), nowSec: now + 300 }).reason).toBe('stale_last_candle');
    expect(checkDataQuality({ ...base, candles: series(60), coveredUntilSec: expectedLast + 100 }).reason).toBe('incomplete_trade_coverage');
    expect(checkDataQuality({ ...base, candles: series(60), coveredUntilSec: null }).reason).toBe('incomplete_trade_coverage');
    expect(checkDataQuality({ ...base, candles: series(60, { source: 'synthetic', n: 0 }) }).reason).toBe('no_trades_in_signal_candle');
  });
  it('rejects non-contiguous series', () => {
    const s = series(61);
    s.splice(10, 1);
    expect(checkDataQuality({ ...base, candles: s }).reason).toBe('non_contiguous_series');
  });
});

describe('params validation', () => {
  it('defaults are valid', () => {
    expect(validateParams(DEFAULT_PARAMS as unknown as Record<string, unknown>)).toEqual([]);
  });
  it('rejects unknown keys, wrong types, out-of-range and inconsistent values', () => {
    expect(validateParams({ foo: 1 })).toContain('unknown parameter: foo');
    expect(validateParams({ emaFast: 'x' })).toContain('emaFast must be a number');
    expect(validateParams({ maxDrawdownPct: 95 })[0]).toMatch(/between/);
    expect(validateParams({ emaFast: 30, emaSlow: 20 })).toContain('emaFast must be smaller than emaSlow');
    expect(validateParams({ emaFast: 9.5 }).join()).toMatch(/integer/);
    expect(validateParams({ timeframe: '1m' })).toContain('timeframe must be "5m"');
  });
  it('mergeParams ignores invalid stored values', () => {
    const p = mergeParams({ emaFast: 'bad', feePct: 0.2, unknown: 1 });
    expect(p.emaFast).toBe(9);
    expect(p.feePct).toBe(0.2);
    expect(mergeParams(null)).toEqual(DEFAULT_PARAMS);
  });
});
