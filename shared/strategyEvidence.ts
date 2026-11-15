export interface HoldoutEvidenceMetrics {
  trades: number;
  wins: number;
  winRatePct: number;
  profitFactor: number | null;
  expectancyIdr: number;
}

export interface StrategyEvidenceRequirements {
  minHoldoutTrades: number;
  minWinRateLower95Pct: number;
  minProfitFactorExclusive: number;
  minExpectancyIdrExclusive: number;
}

export interface StrategyEvidenceDecision {
  status: 'NO_GO' | 'ELIGIBLE_FOR_MANUAL_REVIEW';
  lower95WinRatePct: number;
  requirements: StrategyEvidenceRequirements;
  checks: {
    sufficientSample: boolean;
    winRateConfidence: boolean;
    profitableFactor: boolean;
    positiveExpectancy: boolean;
  };
  reasons: string[];
}

// These are deliberately conservative release criteria, not an assertion that
// 100 trades guarantees statistical independence or future profitability.
export const DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS: StrategyEvidenceRequirements = {
  minHoldoutTrades: 100,
  minWinRateLower95Pct: 70,
  minProfitFactorExclusive: 1,
  minExpectancyIdrExclusive: 0,
};

/** Wilson score lower confidence bound for a binomial win rate. */
export function wilsonLowerBoundPct(wins: number, trials: number, z = 1.96): number {
  if (
    !Number.isInteger(wins) || !Number.isInteger(trials) ||
    trials <= 0 || wins < 0 || wins > trials ||
    !Number.isFinite(z) || z <= 0
  ) return 0;

  const n = trials;
  const p = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  return Math.max(0, (center - margin) / denominator * 100);
}

export function evaluateStrategyEvidence(
  metrics: HoldoutEvidenceMetrics,
  requirements: StrategyEvidenceRequirements = DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS,
): StrategyEvidenceDecision {
  const valid = Number.isInteger(metrics.trades) && metrics.trades >= 0 &&
    Number.isInteger(metrics.wins) && metrics.wins >= 0 && metrics.wins <= metrics.trades &&
    Number.isFinite(metrics.expectancyIdr) &&
    (metrics.profitFactor === null || Number.isFinite(metrics.profitFactor));
  const lower95WinRatePct = valid ? wilsonLowerBoundPct(metrics.wins, metrics.trades) : 0;
  const checks = {
    sufficientSample: valid && metrics.trades >= requirements.minHoldoutTrades,
    winRateConfidence: valid && lower95WinRatePct >= requirements.minWinRateLower95Pct,
    profitableFactor: valid && metrics.profitFactor !== null &&
      metrics.profitFactor > requirements.minProfitFactorExclusive,
    positiveExpectancy: valid && metrics.expectancyIdr > requirements.minExpectancyIdrExclusive,
  };
  const reasons: string[] = [];
  if (!valid) reasons.push('INVALID_HOLDOUT_METRICS');
  if (!checks.sufficientSample) reasons.push('INSUFFICIENT_HOLDOUT_SAMPLE');
  if (!checks.winRateConfidence) reasons.push('WIN_RATE_CONFIDENCE_BELOW_THRESHOLD');
  if (!checks.profitableFactor) reasons.push('PROFIT_FACTOR_NOT_ABOVE_THRESHOLD');
  if (!checks.positiveExpectancy) reasons.push('NET_EXPECTANCY_NOT_POSITIVE');

  return {
    status: Object.values(checks).every(Boolean) ? 'ELIGIBLE_FOR_MANUAL_REVIEW' : 'NO_GO',
    lower95WinRatePct: Number(lower95WinRatePct.toFixed(2)),
    requirements: { ...requirements },
    checks,
    reasons,
  };
}
