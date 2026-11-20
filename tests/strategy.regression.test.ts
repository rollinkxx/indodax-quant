// Regression tests for the engine BUY/SELL/HOLD logic (FIX-02 .. FIX-10).
// Each block names the spec acceptance case it covers.
import { describe, expect, it } from 'vitest';
import { shouldExitOnSignal } from '../shared/paper';
import { applyMtfToMarketAction, type TfState } from '../shared/mtf';
import { DEFAULT_PARAMS, diagnoseSellSignalWindow, evaluateMarketAction, evaluateSignalWindow, validateCrossFieldParams, type IndicatorRow, type MarketActionDecision, type SignalDecision } from '../shared/strategy';

describe('FIX-02 graded signal exit policy', () => {
  const policy = { requireProfit: true, forceStrength: 70, forceOnRiskBlock: true };
  const base = { coversCosts: false, strength: 0, riskBlocked: false, drawdownPct: 0, maxDrawdownPct: 15, policy };

  it('T6 exits a losing position on a strong SELL', () => {
    expect(shouldExitOnSignal({ ...base, strength: 80 })).toEqual({ exit: true, reason: 'strong_signal' });
  });

  it('T7 keeps withholding a weak SELL that cannot cover the round trip', () => {
    expect(shouldExitOnSignal({ ...base, strength: 55 })).toEqual({ exit: false, reason: 'below_cost' });
  });

  it('T8 exits on any SELL while entries are risk blocked', () => {
    expect(shouldExitOnSignal({ ...base, strength: 10, riskBlocked: true }))
      .toEqual({ exit: true, reason: 'risk_block' });
  });

  it('T9 exits once drawdown reaches half the limit', () => {
    expect(shouldExitOnSignal({ ...base, strength: 10, drawdownPct: 7.5 }))
      .toEqual({ exit: true, reason: 'drawdown_half' });
    expect(shouldExitOnSignal({ ...base, strength: 10, drawdownPct: 7.4 }).exit).toBe(false);
  });

  it('exits on a SELL that covers the round trip, and when the profit requirement is off', () => {
    expect(shouldExitOnSignal({ ...base, coversCosts: true, strength: 20 }))
      .toEqual({ exit: true, reason: 'covers_costs' });
    expect(shouldExitOnSignal({ ...base, strength: 20, policy: { ...policy, requireProfit: false } }))
      .toEqual({ exit: true, reason: 'policy_off' });
  });

  it('a non-finite strength never forces an exit', () => {
    expect(shouldExitOnSignal({ ...base, strength: Number.NaN }).exit).toBe(false);
  });
});

describe('FIX-03 MTF sell filter', () => {
  const tf = (name: '15m' | '1h', trend: TfState['trend']): TfState => ({
    tf: name, trend, candles: 60, lastOpenTime: 0, close: 100, emaFast: 100, emaSlow: 99, rsi: 50,
  });
  const sell = (strength: number): MarketActionDecision => ({
    action: 'SELL',
    signal: { side: 'SELL', strength, reasons: ['cross down'] } as SignalDecision,
    reason: 'sell_cross_confirmed',
  });
  const run = (strength: number, states: TfState[], opts = { filterSell: true, minSellStrength: 70 }) =>
    applyMtfToMarketAction(sell(strength), states, 'filter', opts);

  it('T10 blocks a weak SELL while 15m and 1h are both bullish', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bull')]);
    expect(out.action.action).toBe('HOLD');
    expect(out.action.reason).toBe('mtf_blocked_mtf_sell_against_uptrend');
  });

  it('T11 lets a strong SELL through the same uptrend', () => {
    const out = run(85, [tf('15m', 'bull'), tf('1h', 'bull')]);
    expect(out.action.action).toBe('SELL');
  });

  it('T12 does not block a SELL when the 1h anchor is not bullish', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bear')]);
    expect(out.action.action).toBe('SELL');
  });

  it('T13 mtfFilterSell=false restores the unfiltered SELL', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bull')], { filterSell: false, minSellStrength: 70 });
    expect(out.action.action).toBe('SELL');
  });
});

describe('FIX-04 score mode warning', () => {
  it('warns when mtfMode=score has no strength threshold', () => {
    const findings = validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'score', minSignalStrength: 0 });
    expect(findings).toContainEqual(expect.objectContaining({ level: 'warn', code: 'SCORE_MODE_WITHOUT_THRESHOLD' }));
    expect(validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'score', minSignalStrength: 60 })
      .some((f) => f.code === 'SCORE_MODE_WITHOUT_THRESHOLD')).toBe(false);
    expect(validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'filter' })
      .some((f) => f.code === 'SCORE_MODE_WITHOUT_THRESHOLD')).toBe(false);
  });
});

describe('FIX-05 SELL cross lookback', () => {
  const row = (over: Partial<IndicatorRow> = {}): IndicatorRow => ({
    t: 0, close: 100, ema9: 101, ema21: 100, ema50: 95, rsi14: 45, macd: 0, macdSignal: 0, macdHist: -1,
    atr14: 1, volMa20: 10, support: 90, resistance: 110, ...over,
  });
  const above = row();
  const confirm = { ...DEFAULT_PARAMS, sellRequireConfirm: true };

  it('T16 signals SELL one candle after the cross when the filters pass there', () => {
    const crossWeak = row({ ema9: 99, rsi14: 55 });
    const lastStrong = row({ ema9: 98, rsi14: 45 });
    const rows = [above, crossWeak, lastStrong];
    const volumes = [10, 10, 20];

    expect(diagnoseSellSignalWindow(rows, volumes, confirm)).toMatchObject({
      stage: 'ready', ready: true, crossFound: true, barsSinceCross: 1, alreadyQualified: false,
    });
    expect(evaluateSignalWindow(rows, volumes, confirm)?.side).toBe('SELL');
  });

  it('T17 ignores a cross older than sellCrossLookback', () => {
    const below = row({ ema9: 99, rsi14: 45 });
    const cross = row({ ema9: 99, rsi14: 45 });
    const rows = [above, cross, below, below, below, row({ ema9: 97, rsi14: 45 })];
    const volumes = [10, 10, 10, 10, 10, 20];
    const diag = diagnoseSellSignalWindow(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 2 });
    expect(diag.stage).toBe('no_recent_cross');
    expect(evaluateMarketAction(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 2 }).action).toBe('HOLD');
    // Widening the window finds it again.
    expect(diagnoseSellSignalWindow(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 5 }).crossFound).toBe(true);
  });

  it('T18 does not re-emit a cross whose confirmation candle already qualified', () => {
    const crossStrong = row({ ema9: 99, rsi14: 45 });
    const lastStrong = row({ ema9: 98, rsi14: 45 });
    const rows = [above, crossStrong, lastStrong];
    const volumes = [10, 20, 20];
    expect(diagnoseSellSignalWindow(rows, volumes, confirm).stage).toBe('already_qualified');
    expect(evaluateMarketAction(rows, volumes, confirm)).toMatchObject({
      action: 'HOLD', signal: null, reason: 'sell_blocked_already_qualified',
    });
  });
});
