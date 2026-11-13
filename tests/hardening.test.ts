import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, evaluateSignalWindow, validateParams, type IndicatorRow } from '../shared/strategy';
import { dynamicSlippageBps, exposureAllows, riskState, timeStopHit, trailingStop } from '../shared/paper';

const row = (o: Partial<IndicatorRow>): IndicatorRow => ({
  t: 0, close: 100, ema9: 100, ema21: 100, ema50: 95, rsi14: 60, macd: 0, macdSignal: 0, macdHist: 1, atr14: 2, volMa20: 10, support: 90, resistance: 120, ...o,
});

describe('hardened entry/exit rules', () => {
  const below = row({ ema9: 99, ema21: 100 });
  it('skips BUY when price is stretched above EMA21 (anti chasing)', () => {
    const stretched = row({ ema9: 103, ema21: 100, close: 103 });
    expect(evaluateSignalWindow([below, stretched], [0, 15])).toBeNull();
    expect(evaluateSignalWindow([below, stretched], [0, 15], { ...DEFAULT_PARAMS, maxEntryExtensionPct: 0 })?.side).toBe('BUY');
  });
  it('default RSI ceiling is 65', () => {
    expect(evaluateSignalWindow([below, row({ ema9: 101, ema21: 100, rsi14: 67 })], [0, 15])).toBeNull();
  });
  it('SELL fires on any fresh cross-down by default, confirmation optional', () => {
    const up = row({ ema9: 101, ema21: 100 });
    const down = row({ ema9: 99, ema21: 100, rsi14: 60 });
    expect(evaluateSignalWindow([up, down], [0, 1])?.side).toBe('SELL');
    expect(evaluateSignalWindow([up, down], [0, 1], { ...DEFAULT_PARAMS, sellRequireConfirm: true })).toBeNull();
  });
  it('validates new params and excludes gold tokens', () => {
    expect(validateParams({ trailActivationAtr: 0 })[0]).toMatch(/between/);
    expect(validateParams({ timeStopMinutes: 90.5 }).join()).toMatch(/integer/);
    expect(validateParams({ trailingStopEnabled: 'yes' })).toContain('trailingStopEnabled must be boolean');
    expect(DEFAULT_PARAMS.universeExclude).toEqual(expect.arrayContaining(['xautidr', 'paxgidr']));
  });
});

describe('strategy hardening helpers', () => {
  const T = { trailingStopEnabled: true, trailActivationAtr: 1.5, trailDistanceAtr: 1 };
  it('trailing stop arms only after activation and never moves down', () => {
    const pos = { entry_price: 100, stop_loss: 97 };
    expect(trailingStop(pos, 102, 2, T)).toBeNull(); // below entry + 1.5 ATR
    expect(trailingStop(pos, 104, 2, T)).toBe(102); // 104 - 1 ATR
    expect(trailingStop({ entry_price: 100, stop_loss: 103 }, 104, 2, T)).toBeNull();
    expect(trailingStop(pos, 110, 2, { ...T, trailingStopEnabled: false })).toBeNull();
    expect(trailingStop(pos, 110, null, T)).toBeNull();
  });
  it('time stop', () => {
    expect(timeStopHit(0, 60 * 60_000, { timeStopMinutes: 60 })).toBe(true);
    expect(timeStopHit(0, 59 * 60_000, { timeStopMinutes: 60 })).toBe(false);
    expect(timeStopHit(0, 1e12, { timeStopMinutes: 0 })).toBe(false);
    expect(timeStopHit(null, 1e12, { timeStopMinutes: 60 })).toBe(false);
  });
  it('dynamic slippage scales with illiquidity', () => {
    expect(dynamicSlippageBps(10, 5e10)).toBe(10);
    expect(dynamicSlippageBps(10, 5e9)).toBe(15);
    expect(dynamicSlippageBps(10, 1e9)).toBe(25);
    expect(dynamicSlippageBps(10, 1e8)).toBe(40);
    expect(dynamicSlippageBps(10, undefined)).toBe(40);
  });
  it('total exposure cap', () => {
    expect(exposureAllows(500_000, 100_000, 1_000_000, { maxTotalExposurePct: 60 })).toBe(true);
    expect(exposureAllows(500_000, 150_000, 1_000_000, { maxTotalExposurePct: 60 })).toBe(false);
  });
  it('riskState flags daily loss separately from kill switch', () => {
    const r = riskState({ equity: 9_650_000, peakEquity: 10_000_000, dayStartEquity: 10_000_000, params: { dailyLossLimitPct: 3, maxDrawdownPct: 15 } as never });
    expect(r.dailyLossHit).toBe(true);
    expect(r.killSwitch).toBe(false);
  });
});
