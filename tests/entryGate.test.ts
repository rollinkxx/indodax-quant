import { describe, expect, it } from 'vitest';
import { buyFillPrice, computeStops, entryGate, netRewardRiskGate, positionSize } from '../shared/paper';
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
