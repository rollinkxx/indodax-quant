import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, evaluateSignalWindow, validateParams, type IndicatorRow } from '../shared/strategy';
import { dynamicSlippageBps, exposureAllows, riskState, roundTripCostPct, timeStopHit, trailingStop } from '../shared/paper';

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

  it('never ratchets the stop below break-even, where the round trip is already lost', () => {
    const pos = { entry_price: 100, stop_loss: 97 };
    const tight = { trailingStopEnabled: true, trailActivationAtr: 1.5, trailDistanceAtr: 1 };
    // Armed at 100.75 (entry + 1.5 x 0.5 ATR) and trails to 100.25, below the 100.4 break-even.
    expect(trailingStop(pos, 100.75, 0.5, tight, 0.4)).toBeNull();
    // At 101 the trail sits exactly on the break-even price, so it may be set.
    expect(trailingStop(pos, 101, 0.5, tight, 0.4)).toBeCloseTo(100.5, 10);
    // Without a cost the same quote trails to the old level.
    expect(trailingStop(pos, 100.75, 0.5, tight)).toBeCloseTo(100.25, 10);
  });

  it('charges the quoted spread in the round-trip cost, so the break-even floor rises with it', () => {
    // fees 0.2 x 2 + slippage 10bps x 2 = 0.6pp; a 2% spread is the dominant term.
    expect(roundTripCostPct(0.2, 10)).toBeCloseTo(0.6, 10);
    expect(roundTripCostPct(0.2, 10, 2)).toBeCloseTo(2.6, 10);
    expect(roundTripCostPct(0.2, 10, 0)).toBeCloseTo(0.6, 10);
    // A missing/negative spread must not lower the cost below the fee+slippage floor.
    expect(roundTripCostPct(0.2, 10, Number.NaN)).toBeCloseTo(0.6, 10);
    expect(roundTripCostPct(0.2, 10, -1)).toBeCloseTo(0.6, 10);

    // The floor tracks it: on a 2% spread the trail may not sit under entry x 1.026.
    const pos = { entry_price: 100, stop_loss: 97 };
    const tight = { trailingStopEnabled: true, trailActivationAtr: 1.5, trailDistanceAtr: 1 };
    const wide = roundTripCostPct(0.2, 10, 2);
    expect(trailingStop(pos, 103, 1, tight, wide)).toBeNull(); // 102 < 102.6 break-even
    expect(trailingStop(pos, 104, 1, tight, wide)).toBeCloseTo(103, 10);
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
