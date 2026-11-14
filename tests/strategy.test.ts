import { describe, expect, it } from 'vitest';
import { checkDataQuality, computeIndicatorsTail, DEFAULT_PARAMS, evaluateSignal, evaluateSignalWindow, mergeParams, validateParams, type IndicatorRow } from '../shared/strategy';
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

describe('evaluateSignalWindow (crossLookback)', () => {
  const below = row({ ema9: 99, ema21: 100 });
  const above = (o: Partial<IndicatorRow> = {}) => row({ ema9: 101, ema21: 100, ...o });
  const weakVol = 5; // < 1.2 x volMa20 (10)
  const goodVol = 15;

  it('fires on the cross candle itself (same as legacy)', () => {
    const d = evaluateSignalWindow([below, above()], [0, goodVol]);
    expect(d?.side).toBe('BUY');
    expect(d!.reasons[0]).toBe('EMA9 crossed above EMA21');
  });
  it('fires 2 candles after the cross when filters only line up later', () => {
    const d = evaluateSignalWindow([below, above(), above(), above()], [0, weakVol, weakVol, goodVol], { ...DEFAULT_PARAMS, crossLookback: 3 });
    expect(d?.side).toBe('BUY');
    expect(d!.reasons[0]).toContain('2 candle(s) ago');
    expect(d!.strength).toBe(65); // 60 - 2*5 + 15 (MACD)
  });
  it('does not fire when the cross is older than the window', () => {
    const rows = [below, above(), above(), above(), above()];
    expect(evaluateSignalWindow(rows, [0, weakVol, weakVol, weakVol, goodVol])).toBeNull();
    expect(evaluateSignalWindow(rows, [0, weakVol, weakVol, weakVol, goodVol], { ...DEFAULT_PARAMS, crossLookback: 4 })?.side).toBe('BUY');
  });
  it('emits only one BUY per cross (no repeat on later candles)', () => {
    expect(evaluateSignalWindow([below, above(), above()], [0, goodVol, goodVol])).toBeNull();
    expect(evaluateSignalWindow([below, above({ rsi14: 75 }), above()], [0, goodVol, goodVol])?.side).toBe('BUY');
  });
  it('ignores a cross if EMA fast dipped back below inside the window', () => {
    expect(evaluateSignalWindow([below, above(), below, above()], [0, weakVol, weakVol, goodVol])?.reasons[0]).toBe('EMA9 crossed above EMA21');
    expect(evaluateSignalWindow([below, above(), row({ ema9: 99.5, ema21: 100 }), row({ ema9: 99.8, ema21: 100 })], [0, weakVol, weakVol, goodVol])).toBeNull();
  });
  it('crossLookback = 1 keeps the strict fresh-cross behaviour', () => {
    expect(evaluateSignalWindow([below, above(), above()], [0, weakVol, goodVol], { ...DEFAULT_PARAMS, crossLookback: 1 })).toBeNull();
  });
  it('still applies RSI / trend / volume filters on the signal candle', () => {
    expect(evaluateSignalWindow([below, above(), above({ rsi14: 75 })], [0, weakVol, goodVol])).toBeNull();
    expect(evaluateSignalWindow([below, above(), above({ ema50: 110 })], [0, weakVol, goodVol])).toBeNull();
    expect(evaluateSignalWindow([below, above(), above()], [0, weakVol, weakVol])).toBeNull();
  });
  it('validates crossLookback', () => {
    expect(validateParams({ crossLookback: 0 })[0]).toMatch(/between/);
    expect(validateParams({ crossLookback: 2.5 }).join()).toMatch(/integer/);
    expect(mergeParams({}).crossLookback).toBe(2);
  });
});

describe('synthetic candle indicator isolation', () => {
  const candle = (t: number, close: number, source: Candle['source'] = 'trades'): Candle => ({
    t, o: close, h: close + 1, l: close - 1, c: close, v: source === 'synthetic' ? 0 : 10,
    n: source === 'synthetic' ? 0 : 1, source,
  });

  it('restarts the latest indicator window after an internal synthetic gap', () => {
    const beforeGap = Array.from({ length: 80 }, (_, i) => candle(i * 300, 100 + i));
    const afterGap = Array.from({ length: 80 }, (_, i) => candle((81 + i) * 300, 500 - i * 0.7));
    const withGap = [...beforeGap, candle(80 * 300, 179, 'synthetic'), ...afterGap];

    const actual = computeIndicatorsTail(withGap, DEFAULT_PARAMS, 3);
    const expected = computeIndicatorsTail(afterGap, DEFAULT_PARAMS, 3);
    const comparable = (rows: typeof actual) => rows.map(({ t: _t, ...row }) => row);

    expect(comparable(actual)).toEqual(comparable(expected));
  });

  it('returns unready indicators for a synthetic latest candle', () => {
    const real = Array.from({ length: 80 }, (_, i) => candle(i * 300, 100 + i));
    const synthetic = candle(80 * 300, 179, 'synthetic');
    const rows = computeIndicatorsTail([...real, synthetic], DEFAULT_PARAMS, 3);
    expect(rows.at(-1)).toMatchObject({
      t: synthetic.t, close: synthetic.c,
      ema9: null, ema21: null, ema50: null, rsi14: null, macd: null, macdSignal: null,
      macdHist: null, atr14: null, volMa20: null, support: null, resistance: null,
    });
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

  it('rejects a recent synthetic gap until minCandles real candles have accumulated after it', () => {
    const s = series(60);
    s[20] = { ...s[20], v: 0, n: 0, source: 'synthetic' };
    expect(checkDataQuality({ ...base, candles: s })).toMatchObject({
      ok: false, reason: 'insufficient_contiguous_candles (39/60)',
    });
  });

  it('accepts an older synthetic gap once the latest real-candle suffix is fully warmed up', () => {
    const s = series(120);
    s[10] = { ...s[10], v: 0, n: 0, source: 'synthetic' };
    expect(checkDataQuality({ ...base, candles: s })).toEqual({ ok: true });
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
