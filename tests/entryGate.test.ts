import { describe, expect, it } from 'vitest';
import { buyFillPrice, computeStops, entryGate, netRewardRiskDiagnostics, netRewardRiskGate, positionSize, signalExitCoversCosts } from '../shared/paper';
import { DEFAULT_PARAMS, mergeParams, validateParams } from '../shared/strategy';

const P = DEFAULT_PARAMS;

describe('entryGate', () => {
  it('replays the live anoaidr incident: 1.2% spread, bid below the stop -> blocked', () => {
    const ask = 233397, bid = 230633;
    const fill = buyFillPrice(ask, 40);
    const stops = computeStops(fill, 2187, P); // stop ~231.0k, above the bid
    expect(stops.stopLoss).toBeGreaterThan(bid);
    expect(entryGate({ bid, ask, signalPrice: 232430, stopLoss: stops.stopLoss, fill }, P)).toBe('wide_spread');
  });
  it('flags stop_inside_spread even when the spread cap is disabled', () => {
    expect(entryGate({ bid: 99, ask: 101, signalPrice: 100, stopLoss: 99.5, fill: 101 }, { ...P, maxEntrySpreadPct: 0, maxEntryDriftPct: 0 })).toBe('stop_inside_spread');
    // spread eats more than half of the stop distance
    expect(entryGate({ bid: 99.2, ask: 100, signalPrice: 100, stopLoss: 98.6, fill: 100 }, { ...P, maxEntrySpreadPct: 0, maxEntryDriftPct: 0 })).toBe('stop_inside_spread');
  });
  it('blocks a late entry when ask drifted above the signal close', () => {
    expect(entryGate({ bid: 100.9, ask: 101, signalPrice: 100, stopLoss: 97, fill: 101 }, P)).toBe('price_drift');
  });
  it('passes a liquid pair with a tight spread', () => {
    expect(entryGate({ bid: 99.95, ask: 100, signalPrice: 100, stopLoss: 97, fill: 100.1 }, P)).toBeNull();
  });
  it('rejects crossed or empty quotes and can be disabled', () => {
    expect(entryGate({ bid: 0, ask: 100, signalPrice: 100, stopLoss: 97, fill: 100 }, P)).toBe('bad_quote');
    expect(entryGate({ bid: 99, ask: 101, signalPrice: 100, stopLoss: 90, fill: 101 }, { ...P, maxEntrySpreadPct: 0, maxEntryDriftPct: 0 })).toBeNull();
  });
});

describe('net reward/risk gate', () => {
  it('returns auditable net reward/risk values while preserving the exact gate decision', () => {
    const input = {
      entry: 100,
      stopLoss: 99.57,
      takeProfit: 100.86,
      feePct: 0.3,
      exitSlippageBps: 15,
    };
    const diagnostics = netRewardRiskDiagnostics(input);
    expect(diagnostics.reason).toBe('net_reward_risk_below_minimum');
    expect(netRewardRiskGate(input)).toBe(diagnostics.reason);
    expect(diagnostics.metrics.entry_cost_per_unit).toBeCloseTo(100.3, 8);
    expect(diagnostics.metrics.stop_exit_fill).toBeCloseTo(99.420645, 8);
    expect(diagnostics.metrics.target_exit_fill).toBeCloseTo(100.70871, 8);
    expect(diagnostics.metrics.net_risk_per_unit).toBeGreaterThan(0);
    expect(diagnostics.metrics.net_reward_per_unit).toBeGreaterThan(0);
    expect(diagnostics.metrics.net_reward_risk_ratio).toBeLessThan(1);
  });

  it('blocks a low-ATR setup whose take-profit barely covers costs but stop risk is much larger', () => {
    expect(netRewardRiskGate({
      entry: 100,
      stopLoss: 99.57,
      takeProfit: 100.86,
      feePct: 0.3,
      exitSlippageBps: 15,
    })).toBe('net_reward_risk_below_minimum');
  });

  it('passes a setup with at least 1:1 net reward/risk after both fees and exit slippage', () => {
    expect(netRewardRiskGate({
      entry: 100,
      stopLoss: 97,
      takeProfit: 106,
      feePct: 0.3,
      exitSlippageBps: 10,
    })).toBeNull();
  });

  it('admits a nearer target only when the caller lowers the minimum ratio', () => {
    const setup = { entry: 100, stopLoss: 97, takeProfit: 101.5, feePct: 0.2, exitSlippageBps: 10 };
    const ratio = netRewardRiskDiagnostics(setup).metrics.net_reward_risk_ratio;

    // The default 1:1 floor rejects a target nearer than the stop.
    expect(netRewardRiskGate(setup)).toBe('net_reward_risk_below_minimum');
    // A floor just under this trade's own ratio admits it.
    expect(netRewardRiskGate({ ...setup, minRatio: ratio - 0.01 })).toBeNull();
    // A floor just above it rejects the same trade.
    expect(netRewardRiskGate({ ...setup, minRatio: ratio + 0.01 })).toBe('net_reward_risk_below_minimum');
  });

  it('blocks a take-profit that cannot cover round-trip fees and slippage', () => {
    expect(netRewardRiskGate({
      entry: 100,
      stopLoss: 99,
      takeProfit: 100.2,
      feePct: 0.3,
      exitSlippageBps: 15,
    })).toBe('net_reward_non_positive');
  });
});

describe('sizing with exit slippage', () => {
  it('smaller qty when stop-fill slippage is included, unchanged when omitted', () => {
    const base = { equity: 10_000_000, cash: 10_000_000, entry: 1000, stopLoss: 950, params: { ...P, maxPositionPct: 100 } };
    const a = positionSize(base);
    const b = positionSize({ ...base, exitSlippageBps: 40 });
    expect(b.qty).toBeLessThan(a.qty);
  });
});

describe('params', () => {
  it('new params validate and merge with defaults for an older stored config', () => {
    expect(validateParams({ maxEntrySpreadPct: 0.4, maxEntryDriftPct: 0.3 })).toEqual([]);
    expect(validateParams({ maxEntrySpreadPct: -1 }).length).toBe(1);
    const merged = mergeParams({ emaFast: 9 });
    expect(merged.maxEntrySpreadPct).toBe(0.6);
    expect(merged.maxEntryDriftPct).toBe(0.5);
  });
});

describe('signal exit cost guard', () => {
  const base = { entryPrice: 1000, qty: 10, costBasis: 10_020, feePct: 0.2, slippageBps: 10 };

  it('withholds a SELL exit that would book a loss after fees and slippage', () => {
    // Flat price: the 0.2% exit fee plus slippage alone turns this into a loss.
    expect(signalExitCoversCosts({ ...base, bid: 1000 })).toBe(false);
    expect(signalExitCoversCosts({ ...base, bid: 995 })).toBe(false);
  });

  it('allows the same exit once the bid clears the round trip', () => {
    expect(signalExitCoversCosts({ ...base, bid: 1010 })).toBe(true);
    expect(signalExitCoversCosts({ ...base, bid: 2000 })).toBe(true);
  });

  it('rejects malformed inputs instead of silently allowing an exit', () => {
    expect(signalExitCoversCosts({ ...base, bid: 0 })).toBe(false);
    expect(signalExitCoversCosts({ ...base, qty: 0, bid: 2000 })).toBe(false);
    expect(signalExitCoversCosts({ ...base, costBasis: Number.NaN, bid: 2000 })).toBe(false);
  });
});
