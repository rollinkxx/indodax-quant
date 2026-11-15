import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS,
  evaluateStrategyEvidence,
  wilsonLowerBoundPct,
} from '../shared/strategyEvidence';

describe('wilsonLowerBoundPct', () => {
  it('returns a conservative lower confidence bound below the observed rate', () => {
    expect(wilsonLowerBoundPct(80, 100)).toBeLessThan(80);
    expect(wilsonLowerBoundPct(80, 100)).toBeGreaterThan(70);
  });

  it('rejects invalid sample inputs safely', () => {
    expect(wilsonLowerBoundPct(2, 0)).toBe(0);
    expect(wilsonLowerBoundPct(5, 4)).toBe(0);
  });
});

describe('evaluateStrategyEvidence', () => {
  it('requires adequate sample, confidence, profit factor and positive net expectancy', () => {
    const accepted = evaluateStrategyEvidence({
      trades: 200,
      wins: 190,
      winRatePct: 95,
      profitFactor: 2,
      expectancyIdr: 1000,
    });
    expect(accepted.status).toBe('ELIGIBLE_FOR_MANUAL_REVIEW');
    expect(accepted.reasons).toEqual([]);
    expect(accepted.lower95WinRatePct).toBeGreaterThanOrEqual(DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS.minWinRateLower95Pct);
  });

  it('rejects a tiny perfect sample despite a 100% observed win rate', () => {
    const rejected = evaluateStrategyEvidence({
      trades: 5, wins: 5, winRatePct: 100, profitFactor: 10, expectancyIdr: 1,
    });
    expect(rejected.status).toBe('NO_GO');
    expect(rejected.reasons).toContain('INSUFFICIENT_HOLDOUT_SAMPLE');
  });

  it('rejects negative net expectancy even when the other checks pass', () => {
    const rejected = evaluateStrategyEvidence({
      trades: 200, wins: 190, winRatePct: 95, profitFactor: 2, expectancyIdr: -1,
    });
    expect(rejected.status).toBe('NO_GO');
    expect(rejected.reasons).toContain('NET_EXPECTANCY_NOT_POSITIVE');
  });
});
