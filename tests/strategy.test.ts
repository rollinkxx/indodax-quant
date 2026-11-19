import { describe, expect, it } from 'vitest';
import { checkDataQuality, computeIndicatorsTail, DEFAULT_PARAMS, diagnoseBuySignalWindow, diagnoseTrendContinuationWindow, evaluateSignal, evaluateSignalWindow, evaluateMarketAction, mergeParams, validateBracketEconomics, validateParams, type IndicatorRow } from '../shared/strategy';
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

describe('diagnoseBuySignalWindow', () => {
  const below = row({ ema9: 99, ema21: 100 });
  const above = (o: Partial<IndicatorRow> = {}) => row({ ema9: 101, ema21: 100, ...o });

  it('reports a ready candidate using the same gate as evaluateSignalWindow', () => {
    const rows = [below, above()];
    const volumes = [0, 15];
    const diagnostic = diagnoseBuySignalWindow(rows, volumes);
    expect(diagnostic).toMatchObject({
      stage: 'ready', ready: true, crossFound: true, barsSinceCross: 0,
      trendOk: true, rsiOk: true, volumeOk: true, extensionOk: true,
      alreadyQualified: false,
    });
    expect(evaluateSignalWindow(rows, volumes)?.side).toBe('BUY');
  });

  it('recognizes the production ASTERIDR BUY candidate reproduced from 06:50 UTC data', () => {
    const prev = row({
      t: 1, close: 9712, ema9: 9663.486437764435, ema21: 9672.05305338471,
      ema50: 9682.747069586632, rsi14: 53.42769231790498,
      volMa20: 98.95084675950133,
    });
    const last = row({
      t: 2, close: 9809, ema9: 9692.589150211548, ema21: 9684.502775804282,
      ema50: 9687.69816489696, rsi14: 61.18504855576645,
      volMa20: 102.90340480200132,
    });
    const volume = 245.90443671;
    const diagnostic = diagnoseBuySignalWindow([prev, last], [340.84563833, volume]);
    expect(diagnostic).toMatchObject({
      stage: 'ready', ready: true, crossFound: true, barsSinceCross: 0,
      trendOk: true, rsiOk: true, volumeOk: true, extensionOk: true,
    });
    expect(diagnostic.volumeRatio).toBeCloseTo(2.39, 2);
    expect(diagnostic.extensionPct).toBeCloseTo(1.29, 2);
    expect(evaluateSignalWindow([prev, last], [340.84563833, volume])?.side).toBe('BUY');
  });

  it('identifies the exact failing 5m filter without losing the other checks', () => {
    expect(diagnoseBuySignalWindow([below, above({ ema50: 110 })], [0, 15]).stage).toBe('trend_filter');
    expect(diagnoseBuySignalWindow([below, above({ rsi14: 75 })], [0, 15]).stage).toBe('rsi_filter');
    expect(diagnoseBuySignalWindow([below, above()], [0, 11]).stage).toBe('volume_filter');
    expect(diagnoseBuySignalWindow([below, above({ close: 102 })], [0, 15]).stage).toBe('entry_extension');
  });

  it('distinguishes no recent cross, an already-qualified cross, and unready indicators', () => {
    expect(diagnoseBuySignalWindow([above(), above()], [15, 15]).stage).toBe('no_recent_cross');
    expect(diagnoseBuySignalWindow([below, above(), above()], [0, 15, 15]).stage).toBe('already_qualified');
    expect(diagnoseBuySignalWindow([below, row({ rsi14: null })], [0, 15]).stage).toBe('indicators_not_ready');
  });

  it('does not mark a trend filter as failed when that filter is disabled', () => {
    const diagnostic = diagnoseBuySignalWindow(
      [below, above({ ema50: 110 })], [0, 15], { ...DEFAULT_PARAMS, useTrendFilter: false },
    );
    expect(diagnostic).toMatchObject({ stage: 'ready', trendOk: true, ready: true });
  });
});

describe('trend continuation shadow diagnostics', () => {
  const prev = row({ close: 99, ema9: 102, ema21: 100, ema50: 95, rsi14: 58, volMa20: 10 });
  const reclaimed = row({ close: 101, ema9: 103, ema21: 100, ema50: 96, rsi14: 60, volMa20: 10 });

  it('recognizes a pullback reclaim in a stacked uptrend without emitting a crossover BUY', () => {
    const rows = [prev, reclaimed];
    const volumes = [12, 15];
    expect(diagnoseTrendContinuationWindow(rows, volumes)).toMatchObject({
      stage: 'ready', ready: true, pullbackReclaimed: true, recentCross: false,
      trendOk: true, rsiOk: true, volumeOk: true, extensionOk: true,
    });
    expect(evaluateSignalWindow(rows, volumes)).toBeNull();
  });

  it('does not duplicate a fresh crossover as a continuation candidate', () => {
    const beforeCross = row({ close: 99, ema9: 99, ema21: 100, ema50: 95 });
    expect(diagnoseTrendContinuationWindow([beforeCross, reclaimed], [12, 15]).stage).toBe('recent_cross');
  });

  it('requires a reclaim, stacked trend, and the same risk filters', () => {
    expect(diagnoseTrendContinuationWindow([reclaimed, reclaimed], [12, 15]).stage).toBe('no_pullback_reclaim');
    expect(diagnoseTrendContinuationWindow([prev, row({ ...reclaimed, ema21: 94 })], [12, 15]).stage).toBe('ema_slow_not_above_trend');
    expect(diagnoseTrendContinuationWindow([prev, row({ ...reclaimed, rsi14: 75 })], [12, 15]).stage).toBe('rsi_filter');
    expect(diagnoseTrendContinuationWindow([prev, reclaimed], [12, 11]).stage).toBe('volume_filter');
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

  it('rejects a zero-volume official history candle as the signal candle', () => {
    expect(checkDataQuality({
      ...base,
      candles: series(60, { source: 'history', n: 0, v: 0 }),
    })).toEqual({ ok: false, reason: 'no_trades_in_signal_candle' });
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
    expect(validateParams({ feeModel: 'taker' })[0]).toMatch(/feeModel must be one of/);
    expect(validateParams({ feeModel: 'pair_taker' })).toEqual([]);
  });
  it('mergeParams ignores invalid stored values', () => {
    const p = mergeParams({ emaFast: 'bad', feePct: 0.2, unknown: 1 });
    expect(p.emaFast).toBe(9);
    expect(p.feePct).toBe(0.2);
    expect(mergeParams(null)).toEqual(DEFAULT_PARAMS);
  });

  it('rejects a bracket whose gross reward/risk cannot clear the net minimum', () => {
    // Costs only lower reward/risk, so a gross ratio under minNetRewardRiskRatio rejects every
    // entry as net_reward_risk_below_minimum and the engine silently stops trading.
    expect(validateBracketEconomics(mergeParams({
      atrStopMultiplier: 9, atrTakeProfitMultiplier: 5, minNetRewardRiskRatio: 0.8,
    })).join()).toMatch(/no entry can pass the net reward\/risk gate/);
    // The live 9/5 bracket against its 0.4 floor is permissible, if marginal.
    expect(validateBracketEconomics(mergeParams({
      atrStopMultiplier: 9, atrTakeProfitMultiplier: 5, minNetRewardRiskRatio: 0.4,
    }))).toEqual([]);
    expect(validateBracketEconomics(DEFAULT_PARAMS)).toEqual([]);
    // mergeParams must keep accepting the bracket so a stored config is never reset wholesale.
    expect(mergeParams({ atrStopMultiplier: 9, atrTakeProfitMultiplier: 5, minNetRewardRiskRatio: 0.8 }).atrStopMultiplier).toBe(9);
  });
});


describe('explicit BUY / SELL / HOLD decisions', () => {
  const below = row({ ema9: 99, ema21: 100 });
  const above = row({ ema9: 101, ema21: 100 });

  it('returns BUY only when the crossover and entry filters pass', () => {
    const result = evaluateMarketAction([below, above], [0, 15]);
    expect(result.action).toBe('BUY');
    expect(result.signal?.side).toBe('BUY');
    expect(result.reason).toBe('buy_setup_confirmed');
  });

  it('returns SELL on a fresh cross down without allowing entry filters to suppress exits by default', () => {
    const result = evaluateMarketAction([above, row({ ema9: 99, ema21: 100, rsi14: 65 })], [15, 5]);
    expect(result.action).toBe('SELL');
    expect(result.signal?.side).toBe('SELL');
    expect(result.reason).toBe('sell_cross_confirmed');
  });

  it('returns an auditable HOLD when there is no fresh setup', () => {
    const result = evaluateMarketAction([above, above], [15, 15]);
    expect(result).toEqual({ action: 'HOLD', signal: null, reason: 'no_fresh_setup' });
  });

  it('returns HOLD rather than a false signal for misaligned or unready inputs', () => {
    expect(evaluateMarketAction([below], [0])).toMatchObject({ action: 'HOLD', reason: 'insufficient_aligned_rows' });
    expect(evaluateMarketAction([below, row({ rsi14: null })], [0, 15])).toMatchObject({ action: 'HOLD', reason: 'indicators_not_ready' });
    expect(evaluateMarketAction([below, above], [0])).toMatchObject({ action: 'HOLD', reason: 'insufficient_aligned_rows' });
  });

  it('keeps a confirmed exit as HOLD only when optional SELL confirmations are explicitly enabled', () => {
    const result = evaluateMarketAction(
      [above, row({ ema9: 99, ema21: 100, rsi14: 65 })], [15, 5],
      { ...DEFAULT_PARAMS, sellRequireConfirm: true },
    );
    expect(result).toMatchObject({ action: 'HOLD', signal: null, reason: 'sell_blocked_rsi_confirmation' });
  });

  it('fails closed with an explicit HOLD reason for NaN, infinite, negative-volume and invalid-RSI inputs', () => {
    const cases: [IndicatorRow[], number[]][] = [
      [[below, row({ ema9: 101, ema21: 100, close: Number.NaN })], [0, 15]],
      [[below, row({ ema9: 101, ema21: 100, ema50: Number.POSITIVE_INFINITY })], [0, 15]],
      [[below, above], [0, Number.NaN]],
      [[below, above], [0, -1]],
      [[below, row({ ema9: 101, ema21: 100, rsi14: 101 })], [0, 15]],
    ];
    for (const [rows, volumes] of cases) {
      expect(evaluateMarketAction(rows, volumes)).toMatchObject({
        action: 'HOLD', signal: null, reason: 'invalid_market_data',
      });
      expect(evaluateSignalWindow(rows, volumes)).toBeNull();
    }
  });

  it('allows null warm-up indicators but never turns them into BUY or SELL', () => {
    const result = evaluateMarketAction([below, row({ ema9: null })], [0, 15]);
    expect(result).toMatchObject({ action: 'HOLD', signal: null, reason: 'indicators_not_ready' });
  });
});

describe('diagnoseTrendContinuationWindow input validation (parity with BUY gate)', () => {
  const prev = row({ close: 99, ema9: 102, ema21: 100, ema50: 95, rsi14: 58, volMa20: 10 });
  const reclaimed = row({ close: 101, ema9: 103, ema21: 100, ema50: 96, rsi14: 60, volMa20: 10 });

  it('is ready on a valid pullback reclaim (baseline)', () => {
    expect(diagnoseTrendContinuationWindow([prev, reclaimed], [12, 15]).ready).toBe(true);
  });

  it('fails closed with invalid_market_data on non-finite / invalid inputs, never a ready candidate', () => {
    const cases: [IndicatorRow[], number[]][] = [
      [[prev, { ...reclaimed, ema9: Number.POSITIVE_INFINITY }], [12, 15]],
      [[prev, { ...reclaimed, ema21: Number.POSITIVE_INFINITY }], [12, 15]],
      [[prev, { ...reclaimed, ema50: Number.POSITIVE_INFINITY }], [12, 15]],
      [[prev, { ...reclaimed, close: Number.NaN }], [12, 15]],
      [[prev, { ...reclaimed, rsi14: 101 }], [12, 15]],
      [[prev, { ...reclaimed, volMa20: Number.NaN }], [12, 15]],
      [[prev, reclaimed], [12, Number.POSITIVE_INFINITY]],
      [[prev, reclaimed], [12, -1]],
    ];
    for (const [rows, volumes] of cases) {
      const d = diagnoseTrendContinuationWindow(rows, volumes);
      expect(d.ready).toBe(false);
      expect(d.stage).toBe('invalid_market_data');
      expect(diagnoseBuySignalWindow(rows, volumes).ready).toBe(false);
    }
  });
});
