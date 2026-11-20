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

describe('win-rate floor is advisory, not blocking', () => {
  // 55% win rate on 200 trades: clears sample/PF/expectancy but fails a 70% floor.
  const lowWinRate = { trades: 200, wins: 110, winRatePct: 55, profitFactor: 1.8, expectancyIdr: 2_500 };

  it('lets a profitable low-win-rate strategy through to human review by default', () => {
    const d = evaluateStrategyEvidence(lowWinRate);
    expect(d.checks.winRateConfidence).toBe(false);
    expect(d.winRateFloorEnforced).toBe(false);
    expect(d.status).toBe('ELIGIBLE_FOR_MANUAL_REVIEW');
    expect(d.reasons).toEqual([]);
  });

  it('still blocks on the win-rate floor when it is explicitly enforced', () => {
    const d = evaluateStrategyEvidence(lowWinRate, {
      ...DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS,
      enforceWinRateFloor: true,
    });
    expect(d.winRateFloorEnforced).toBe(true);
    expect(d.status).toBe('NO_GO');
    expect(d.reasons).toContain('WIN_RATE_CONFIDENCE_BELOW_THRESHOLD');
  });

  it('keeps the expectancy and sample-size gates hard in both modes', () => {
    for (const enforceWinRateFloor of [false, true]) {
      const d = evaluateStrategyEvidence(
        { ...lowWinRate, expectancyIdr: -1 },
        { ...DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS, enforceWinRateFloor },
      );
      expect(d.status).toBe('NO_GO');
      expect(d.reasons).toContain('NET_EXPECTANCY_NOT_POSITIVE');
    }
  });
});

describe('invalid evidence requirements', () => {
  const metrics = { trades: 400, wins: 380, winRatePct: 95, profitFactor: 1.8, expectancyIdr: 5_000 };

  it('flags a requirement set that can never be met instead of blaming the strategy', () => {
    const d = evaluateStrategyEvidence(metrics, { ...DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS, minHoldoutTrades: 0 });
    expect(d.status).toBe('NO_GO');
    expect(d.reasons).toContainEqual(expect.stringContaining('INVALID_HOLDOUT_SIZE'));
    // The strategy's own metrics were fine; the configuration is what failed.
    expect(d.reasons).not.toContain('INSUFFICIENT_HOLDOUT_SAMPLE');
  });

  it('rejects an out-of-range win-rate threshold', () => {
    const d = evaluateStrategyEvidence(metrics, { ...DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS, minWinRateLower95Pct: 120 });
    expect(d.reasons).toContainEqual(expect.stringContaining('INVALID_WIN_RATE_THRESHOLD'));
  });

  it('rejects a negative profit-factor threshold', () => {
    const d = evaluateStrategyEvidence(metrics, { ...DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS, minProfitFactorExclusive: -1 });
    expect(d.reasons).toContainEqual(expect.stringContaining('INVALID_PROFIT_FACTOR_THRESHOLD'));
  });

  it('leaves a valid requirement set unaffected', () => {
    expect(evaluateStrategyEvidence(metrics).status).toBe('ELIGIBLE_FOR_MANUAL_REVIEW');
  });
});
