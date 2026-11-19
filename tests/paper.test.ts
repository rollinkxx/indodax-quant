import { describe, expect, it } from 'vitest';
import { buyFillPrice, computeStats, computeStops, effectiveFeePct, entryFeePct, exitReason, feeFor, netRewardRiskDiagnostics, positionSize, riskState, round, roundDown, roundTripPnl, sellFillPrice } from '../shared/paper';
import { DEFAULT_PARAMS } from '../shared/strategy';

const P = DEFAULT_PARAMS;

describe('effective per-pair fee', () => {
  it('assumption model always charges the configured feePct', () => {
    expect(effectiveFeePct({ feeModel: 'assumption', feePct: 0.00555 }, 0.2)).toBe(0.00555);
    expect(effectiveFeePct({ feeModel: 'assumption', feePct: 0.00555 }, null)).toBe(0.00555);
  });
  it('pair_taker model charges the pair fee and falls back on missing/invalid values', () => {
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, 0.2)).toBe(0.2);
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, 0.06)).toBe(0.06);
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, 0)).toBe(0); // honoured zero-fee
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, null)).toBe(0.00555);
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, undefined)).toBe(0.00555);
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, -1)).toBe(0.00555);
    expect(effectiveFeePct({ feeModel: 'pair_taker', feePct: 0.00555 }, NaN)).toBe(0.00555);
  });
  it('a real taker fee makes an otherwise-approved setup fail the net reward/risk gate', () => {
    const stops = computeStops(1001, 3, P);
    const assumption = netRewardRiskDiagnostics({ entry: 1001, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, feePct: 0.00555, exitSlippageBps: 10 });
    const taker = netRewardRiskDiagnostics({ entry: 1001, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, feePct: 0.2, exitSlippageBps: 10 });
    expect(assumption.reason).toBeNull();
    expect(taker.reason).toBe('net_reward_risk_below_minimum');
  });
});

describe('strict entry fee', () => {
  it('rejects an entry under pair_taker when the pair fee is missing or invalid', () => {
    for (const bad of [null, undefined, -1, NaN]) {
      expect(entryFeePct({ feeModel: 'pair_taker', feePct: 0.2 }, bad)).toEqual({ reason: 'missing_pair_fee' });
    }
  });
  it('charges the pair taker fee, honours zero, and only falls back under assumption', () => {
    expect(entryFeePct({ feeModel: 'pair_taker', feePct: 0.2 }, 0.06)).toEqual({ pct: 0.06 });
    expect(entryFeePct({ feeModel: 'pair_taker', feePct: 0.2 }, 0)).toEqual({ pct: 0 });
    expect(entryFeePct({ feeModel: 'assumption', feePct: 0.2 }, null)).toEqual({ pct: 0.2 });
  });
});

describe('fills, fees, slippage', () => {
  it('BUY fills above ask and SELL below bid by slippage bps', () => {
    expect(buyFillPrice(1_000_000, 10)).toBeCloseTo(1_001_000, 6);
    expect(sellFillPrice(1_000_000, 10)).toBeCloseTo(999_000, 6);
  });
  it('charges the fee assumption as percentage points and rounds to 2 decimals', () => {
    expect(feeFor(1_234_567, 0.2)).toBe(2469.13);
    expect(feeFor(1_234_567, 0.00555)).toBe(68.52);
  });
  it('defaults to the real taker fee model, never a 36x-cheap assumption', () => {
    // A fail-open default silently under-charged 9 live paper trades in Nov 2026: the fee was
    // 0.00555%/side instead of 0.2%, which defeated the net reward/risk entry gate.
    expect(P.feeModel).toBe('pair_taker');
    expect(P.feePct).toBeGreaterThanOrEqual(0.2);
  });
  it('roundDown never rounds up', () => {
    expect(roundDown(0.123456789)).toBe(0.12345678);
  });
});

describe('stops', () => {
  it('ATR based stops', () => {
    const s = computeStops(100, 2, P);
    expect(s).toEqual({ stopLoss: 97, takeProfit: 106, method: 'atr' });
  });
  it('falls back to percent stops when ATR missing or unreasonable', () => {
    expect(computeStops(100, null, P)).toMatchObject({ stopLoss: 98, takeProfit: 104, method: 'percent' });
    expect(computeStops(100, 0.01, P).method).toBe('percent'); // 0.015% away -> too tight
    expect(computeStops(100, 50, P).method).toBe('percent'); // 75% away -> absurd
  });
});

describe('position sizing', () => {
  it('risks 1% of equity to the stop, capped at 25% of equity', () => {
    const r = positionSize({ equity: 10_000_000, cash: 10_000_000, entry: 1_000_000, stopLoss: 985_000, params: P });
    // risk 100k / (15k stop + round-trip fee + exit slippage) is far above the 25% cap (2.5M) = 2.5 units
    expect(r.qty).toBe(2.5);
    expect(r.notional).toBe(2_500_000);
    expect(r.fee).toBe(round(2_500_000 * P.feePct / 100));
    expect(r.cost).toBe(2_500_000 + r.fee);
  });
  it('risk-limited when the stop is wide', () => {
    const r = positionSize({ equity: 10_000_000, cash: 10_000_000, entry: 100, stopLoss: 80, params: P });
    const perUnitRisk = 20 + 100 * (P.feePct / 100) * 2; // no exitSlippageBps passed
    expect(r.qty).toBe(roundDown(100_000 / perUnitRisk));
    expect(r.cost).toBeLessThanOrEqual(10_000_000);
  });
  it('never spends more cash than available', () => {
    const r = positionSize({ equity: 10_000_000, cash: 50_000, entry: 1000, stopLoss: 990, params: P });
    expect(r.cost).toBeLessThanOrEqual(50_000);
    expect(r.qty).toBeGreaterThan(0);
  });
  it('rejects invalid stop, tiny orders and zero cash', () => {
    expect(positionSize({ equity: 1e7, cash: 1e7, entry: 100, stopLoss: 101, params: P }).reason).toBe('invalid_stop');
    expect(positionSize({ equity: 1e7, cash: 5000, entry: 100, stopLoss: 99, params: P }).reason).toBe('below_min_notional');
    expect(positionSize({ equity: 1e7, cash: 0, entry: 100, stopLoss: 99, params: P }).reason).toBe('invalid_inputs');
  });
});

describe('exits and PnL', () => {
  it('stop loss and take profit triggers on bid', () => {
    const pos = { stop_loss: '97', take_profit: '106' };
    expect(exitReason(pos, 96.9)).toBe('STOP_LOSS');
    expect(exitReason(pos, 97)).toBe('STOP_LOSS');
    expect(exitReason(pos, 106.5)).toBe('TAKE_PROFIT');
    expect(exitReason(pos, 100)).toBeNull();
    expect(exitReason({ stop_loss: null, take_profit: null }, 1)).toBeNull();
  });
  it('round-trip PnL nets both fees', () => {
    // buy 2 @ 1001 fee 6.01, sell 2 @ 1099 fee 6.59 -> (2198 - 6.59) - (2002 + 6.01) = 183.4
    expect(roundTripPnl(2, 1001, 6.01, 1099, 6.59)).toBeCloseTo(183.4, 6);
  });
  it('a flat round trip loses fees + slippage', () => {
    const entry = buyFillPrice(1000, 10), exit = sellFillPrice(1000, 10);
    const pnl = roundTripPnl(1, entry, feeFor(entry, 0.3), exit, feeFor(exit, 0.3));
    expect(pnl).toBeLessThan(0);
    expect(pnl).toBeCloseTo(-(2 + 3.003 + 2.997), 2);
  });
});

describe('risk management', () => {
  it('max drawdown triggers kill switch', () => {
    const r = riskState({ equity: 8_400_000, peakEquity: 10_000_000, dayStartEquity: 8_400_000, params: P });
    expect(r.drawdownPct).toBeCloseTo(16, 6);
    expect(r.killSwitch).toBe(true);
    expect(r.blockEntries).toBe(true);
  });
  it('daily loss limit blocks entries without kill switch', () => {
    const r = riskState({ equity: 9_650_000, peakEquity: 10_000_000, dayStartEquity: 10_000_000, params: P });
    expect(r.killSwitch).toBe(false);
    expect(r.blockEntries).toBe(true);
  });
  it('healthy account allows entries', () => {
    expect(riskState({ equity: 10_100_000, peakEquity: 10_000_000, dayStartEquity: 10_000_000, params: P }).blockEntries).toBe(false);
  });
  it('stats', () => {
    const s = computeStats([{ realized_pnl: 100, cost_basis: 1000 }, { realized_pnl: -50, cost_basis: 1000 }, { realized_pnl: '50', cost_basis: '1000' }]);
    expect(s).toMatchObject({ trades: 3, wins: 2, losses: 1, totalPnl: 100, profitFactor: 3, best: 100, worst: -50 });
    expect(s.winRate).toBeCloseTo(66.67, 1);
    expect(computeStats([]).trades).toBe(0);
  });
});
