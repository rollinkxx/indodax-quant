import { describe, expect, it } from 'vitest';
import { assessQuote, killSwitchState, spreadBpsOf, valuationHealth } from '../shared/quote';

const NOW = 1_800_000_000;

describe('quote freshness', () => {
  it('accepts a fresh two-sided quote and reports its age and spread', () => {
    const a = assessQuote({ bid: 100, ask: 101, serverTimeSec: NOW - 5 }, NOW, { maxAgeSec: 180 });
    expect(a.ok).toBe(true);
    expect(a.ageSec).toBe(5);
    expect(a.spreadBps).toBeCloseTo((1 / 100.5) * 10_000, 6);
  });

  it('rejects a stale quote', () => {
    const a = assessQuote({ bid: 100, ask: 101, serverTimeSec: NOW - 500 }, NOW, { maxAgeSec: 180 });
    expect(a).toMatchObject({ ok: false, reason: 'STALE_QUOTE', ageSec: 500 });
  });

  it('rejects a future-dated quote beyond the clock skew as skew, not staleness', () => {
    const a = assessQuote({ bid: 100, ask: 101, serverTimeSec: NOW + 120 }, NOW, { maxAgeSec: 180, maxClockSkewSec: 30 });
    expect(a).toMatchObject({ ok: false, reason: 'FUTURE_DATED_QUOTE' });
  });

  it('tolerates a small future skew inside the allowance', () => {
    const a = assessQuote({ bid: 100, ask: 101, serverTimeSec: NOW + 10 }, NOW, { maxAgeSec: 180, maxClockSkewSec: 30 });
    expect(a.ok).toBe(true);
  });

  it('rejects crossed and non-positive quotes', () => {
    expect(assessQuote({ bid: 101, ask: 100, serverTimeSec: NOW }, NOW, { maxAgeSec: 180 }).reason).toBe('INVALID_QUOTE');
    expect(assessQuote({ bid: 0, ask: 100, serverTimeSec: NOW }, NOW, { maxAgeSec: 180 }).reason).toBe('INVALID_QUOTE');
    expect(assessQuote(null, NOW, { maxAgeSec: 180 }).reason).toBe('MISSING_QUOTE');
  });

  it('spreadBpsOf is null for an invalid quote', () => {
    expect(spreadBpsOf(101, 100)).toBeNull();
    expect(spreadBpsOf(100, 100)).toBe(0);
  });
});

describe('valuation health', () => {
  it('is KNOWN only when every open position has a fresh quote', () => {
    expect(valuationHealth(['btcidr'], new Set(['btcidr']))).toEqual({ status: 'KNOWN', unpricedPairs: [], blockEntries: false });
    expect(valuationHealth(['btcidr', 'ethidr'], new Set(['btcidr']))).toEqual({ status: 'UNKNOWN', unpricedPairs: ['ethidr'], blockEntries: true });
  });

  it('is KNOWN for a flat book', () => {
    expect(valuationHealth([], new Set())).toEqual({ status: 'KNOWN', unpricedPairs: [], blockEntries: false });
  });
});

describe('kill-switch state machine', () => {
  it('is RUNNING when the account is live and not armed', () => {
    expect(killSwitchState({ status: 'RUNNING', killSwitch: false, openPositions: 0 })).toBe('RUNNING');
  });
  it('is KILL_ARMED when the account is stopped but not killed', () => {
    expect(killSwitchState({ status: 'STOPPED', killSwitch: false, openPositions: 2 })).toBe('KILL_ARMED');
  });
  it('reports KILLED_FLAT only when nothing remains open', () => {
    expect(killSwitchState({ status: 'KILLED', killSwitch: true, openPositions: 0 })).toBe('KILLED_FLAT');
  });
  it('reports KILLED_NOT_FLAT when positions remain after the close attempt', () => {
    expect(killSwitchState({ status: 'KILLED', killSwitch: true, openPositions: 2 })).toBe('KILLED_NOT_FLAT');
  });
  it('reports KILL_CLOSE_FAILED when a close attempt failed', () => {
    expect(killSwitchState({ status: 'KILLED', killSwitch: true, openPositions: 1, closeFailures: 1 })).toBe('KILL_CLOSE_FAILED');
  });
});
