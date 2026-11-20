// Regression tests for the engine BUY/SELL/HOLD logic (FIX-02 .. FIX-10).
// Each block names the spec acceptance case it covers.
import { describe, expect, it } from 'vitest';
import { shouldExitOnSignal } from '../shared/paper';

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
