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

/**
 * Legacy release gate, kept exported so existing call sites and reports keep working.
 *
 * It requires a Wilson 95% lower bound of 70% on the win rate. That threshold cannot be met by a
 * genuinely profitable mean-reversion or trend-following system: at a 50% win rate with a 1.25
 * profit factor (the actual shape of a good edge) the Wilson lower bound sits near 43%, so this
 * gate rejects real edges while admitting bracket-geometry artefacts whose win rate is high only
 * because the target is closer than the stop. Use evaluateExpectancyEvidence instead.
 */
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

// ---------------------------------------------------------------------------------------------
// Expectancy-based release evidence (WP1a)
//
// Win rate is a *geometry* property, not an edge: a bracket with a 1:3 target:stop wins ~75% of
// the time on a pure random walk. The release question is whether the mean *net* return per trade
// is positive after real costs, and whether that positive mean survives the two ways a backtest
// lies: a handful of lucky trades and a handful of lucky weeks. Every check below therefore looks
// at the distribution of net returns, not at the win rate, and the win-rate check is a floor
// (>= 40%) rather than a target.
// ---------------------------------------------------------------------------------------------

/** A single closed trade, in the shape the evidence gate needs. */
export interface EvidenceTrade {
  /** Net return as a fraction of the position's cost basis (0.01 = +1%), costs included. */
  netReturn: number;
  /** Epoch seconds of the trade's close; used to form calendar-week blocks. */
  exitTime: number;
  /** Pair id, used to detect concentration in one market. */
  pair: string;
  /** Chronological fold index, assigned by the caller from its own time split. */
  fold?: number;
}

export interface ExpectancyEvidenceRequirements {
  minHoldoutTrades: number;
  bootstrapResamples: number;
  bootstrapSeed: number;
  bootstrapLowerQuantile: number;
  minProfitFactor: number;
  minWilsonWinRateLowerPct: number;
  /** The edge must survive deleting this many of the best trades. */
  outlierTradesToRemove: number;
  maxSinglePairProfitSharePct: number;
  minFolds: number;
  minTradesPerFold: number;
  minPositiveFoldSharePct: number;
  maxDrawdownPct: number;
}

export const DEFAULT_EXPECTANCY_EVIDENCE_REQUIREMENTS: ExpectancyEvidenceRequirements = {
  minHoldoutTrades: 100,
  bootstrapResamples: 10_000,
  bootstrapSeed: 20261119,
  bootstrapLowerQuantile: 0.05,
  minProfitFactor: 1.15,
  minWilsonWinRateLowerPct: 40,
  outlierTradesToRemove: 5,
  maxSinglePairProfitSharePct: 30,
  minFolds: 5,
  minTradesPerFold: 15,
  minPositiveFoldSharePct: 60,
  maxDrawdownPct: 15,
};

export interface ExpectancyEvidenceDecision {
  status: 'NO_GO' | 'ELIGIBLE_FOR_MANUAL_REVIEW';
  trades: number;
  winRatePct: number;
  wilsonLower95WinRatePct: number;
  profitFactor: number | null;
  meanNetReturnPct: number;
  /** Lower bound of the 95% week-block bootstrap CI on the mean net return per trade, in %. */
  meanNetReturnLower95Pct: number | null;
  /** Mean net return with the best N trades removed, in %. */
  meanNetReturnWithoutBestPct: number | null;
  maxSinglePairProfitSharePct: number;
  positiveFoldSharePct: number;
  maxDrawdownPct: number;
  requirements: ExpectancyEvidenceRequirements;
  checks: {
    sufficientSample: boolean;
    positiveExpectancyLowerBound: boolean;
    profitableFactor: boolean;
    winRateFloor: boolean;
    survivesOutlierRemoval: boolean;
    notPairConcentrated: boolean;
    consistentAcrossFolds: boolean;
    drawdownWithinLimit: boolean;
  };
  reasons: string[];
}

/** Mulberry32: small, fast, deterministic. Fixed seed keeps the gate reproducible across runs. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lower bound of the week-block bootstrap CI on the mean net return per trade.
 *
 * Trades are resampled in calendar-week blocks, never individually: every pair in the universe
 * moves with the same market, so individual trades are strongly cross-correlated and resampling
 * them would produce an absurdly narrow CI. Whole weeks keep the within-week correlation intact.
 * Returns null when there are fewer than two blocks (a CI needs at least two clusters).
 */
export function weekBlockBootstrapMeanLowerBound(
  trades: EvidenceTrade[],
  resamples: number,
  seed: number,
  quantile: number,
): number | null {
  if (trades.length === 0) return null;
  const blocks = new Map<number, number[]>();
  for (const t of trades) {
    const week = Math.floor(t.exitTime / (7 * 86400));
    const bucket = blocks.get(week);
    if (bucket) bucket.push(t.netReturn);
    else blocks.set(week, [t.netReturn]);
  }
  const keys = [...blocks.keys()];
  if (keys.length < 2) return null;
  const sums = keys.map((k) => blocks.get(k)!.reduce((a, b) => a + b, 0));
  const counts = keys.map((k) => blocks.get(k)!.length);
  const rand = seededRandom(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
      const pick = Math.floor(rand() * keys.length);
      sum += sums[pick];
      n += counts[pick];
    }
    if (n > 0) means.push(sum / n);
  }
  if (means.length === 0) return null;
  means.sort((a, b) => a - b);
  const index = Math.min(means.length - 1, Math.max(0, Math.floor(quantile * means.length)));
  return means[index];
}

/** Max drawdown of the cumulative net-return curve, in percent, using the trade ordering given. */
export function maxDrawdownPctOfReturns(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/**
 * Release evidence based on net expectancy rather than win rate. Never promotes automatically:
 * the only positive status is ELIGIBLE_FOR_MANUAL_REVIEW.
 */
export function evaluateExpectancyEvidence(
  trades: EvidenceTrade[],
  requirements: ExpectancyEvidenceRequirements = DEFAULT_EXPECTANCY_EVIDENCE_REQUIREMENTS,
): ExpectancyEvidenceDecision {
  const n = trades.length;
  const returns = trades.map((t) => t.netReturn);
  const valid = returns.every((r) => Number.isFinite(r)) &&
    trades.every((t) => Number.isFinite(t.exitTime) && typeof t.pair === 'string' && t.pair.length > 0);

  const mean = n > 0 ? returns.reduce((a, b) => a + b, 0) / n : 0;
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : 0);
  const winRatePct = n > 0 ? wins.length / n * 100 : 0;
  const wilsonLower = n > 0 ? wilsonLowerBoundPct(wins.length, n) : 0;

  const lower95 = weekBlockBootstrapMeanLowerBound(
    trades, requirements.bootstrapResamples, requirements.bootstrapSeed, requirements.bootstrapLowerQuantile,
  );

  // A positive mean carried by a few outsized winners is not an edge; drop the best N and re-measure.
  const withoutBest = n > requirements.outlierTradesToRemove
    ? [...returns].sort((a, b) => b - a).slice(requirements.outlierTradesToRemove)
    : [];
  const meanWithoutBest = withoutBest.length > 0
    ? withoutBest.reduce((a, b) => a + b, 0) / withoutBest.length
    : null;

  // Concentration: what share of *net* profit comes from the single best pair?
  const profitByPair = new Map<string, number>();
  for (const t of trades) {
    if (t.netReturn > 0) profitByPair.set(t.pair, (profitByPair.get(t.pair) ?? 0) + t.netReturn);
  }
  const totalProfit = [...profitByPair.values()].reduce((a, b) => a + b, 0);
  const topPair = Math.max(0, ...profitByPair.values());
  const topPairShare = totalProfit > 0 ? topPair / totalProfit * 100 : 100;

  // Fold consistency: only folds the caller actually supplied and that meet the minimum size count.
  const byFold = new Map<number, number[]>();
  for (const t of trades) {
    if (t.fold === undefined || !Number.isFinite(t.fold)) continue;
    const bucket = byFold.get(t.fold);
    if (bucket) bucket.push(t.netReturn);
    else byFold.set(t.fold, [t.netReturn]);
  }
  const usableFolds = [...byFold.values()].filter((rs) => rs.length >= requirements.minTradesPerFold);
  const positiveFolds = usableFolds.filter((rs) => rs.reduce((a, b) => a + b, 0) > 0).length;
  const positiveFoldShare = usableFolds.length > 0 ? positiveFolds / usableFolds.length * 100 : 0;

  // Drawdown is a path property: it must follow exit chronology, not the caller's array order.
  // The gate compared trades in whatever order they were handed over, so the same sample could
  // pass or fail depending on iteration order.
  const chronological = trades.every((t) => Number.isFinite(t.exitTime))
    ? [...trades].sort((a, b) => a.exitTime - b.exitTime)
    : trades;
  const drawdown = maxDrawdownPctOfReturns(chronological.map((t) => t.netReturn));

  const checks = {
    sufficientSample: valid && n >= requirements.minHoldoutTrades,
    positiveExpectancyLowerBound: valid && lower95 !== null && lower95 > 0,
    profitableFactor: valid && profitFactor !== null && profitFactor >= requirements.minProfitFactor,
    winRateFloor: valid && wilsonLower >= requirements.minWilsonWinRateLowerPct,
    survivesOutlierRemoval: valid && meanWithoutBest !== null && meanWithoutBest > 0,
    notPairConcentrated: valid && topPairShare <= requirements.maxSinglePairProfitSharePct,
    consistentAcrossFolds: valid && usableFolds.length >= requirements.minFolds &&
      positiveFoldShare >= requirements.minPositiveFoldSharePct,
    drawdownWithinLimit: valid && drawdown <= requirements.maxDrawdownPct,
  };

  const reasons: string[] = [];
  if (!valid) reasons.push('INVALID_EVIDENCE_INPUTS');
  if (!checks.sufficientSample) reasons.push('INSUFFICIENT_HOLDOUT_SAMPLE');
  if (!checks.positiveExpectancyLowerBound) reasons.push('EXPECTANCY_LOWER_BOUND_NOT_POSITIVE');
  if (!checks.profitableFactor) reasons.push('PROFIT_FACTOR_BELOW_THRESHOLD');
  if (!checks.winRateFloor) reasons.push('WIN_RATE_FLOOR_NOT_MET');
  if (!checks.survivesOutlierRemoval) reasons.push('EDGE_DEPENDS_ON_TOP_TRADES');
  if (!checks.notPairConcentrated) reasons.push('PROFIT_CONCENTRATED_IN_ONE_PAIR');
  if (!checks.consistentAcrossFolds) reasons.push('INCONSISTENT_ACROSS_FOLDS');
  if (!checks.drawdownWithinLimit) reasons.push('DRAWDOWN_EXCEEDS_LIMIT');

  return {
    status: Object.values(checks).every(Boolean) ? 'ELIGIBLE_FOR_MANUAL_REVIEW' : 'NO_GO',
    trades: n,
    winRatePct: Number(winRatePct.toFixed(2)),
    wilsonLower95WinRatePct: Number(wilsonLower.toFixed(2)),
    profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(4)),
    meanNetReturnPct: Number((mean * 100).toFixed(4)),
    meanNetReturnLower95Pct: lower95 === null ? null : Number((lower95 * 100).toFixed(4)),
    meanNetReturnWithoutBestPct: meanWithoutBest === null ? null : Number((meanWithoutBest * 100).toFixed(4)),
    maxSinglePairProfitSharePct: Number(topPairShare.toFixed(2)),
    positiveFoldSharePct: Number(positiveFoldShare.toFixed(2)),
    maxDrawdownPct: Number(drawdown.toFixed(2)),
    requirements: { ...requirements },
    checks,
    reasons,
  };
}

export interface NullModelRequirements {
  /** Permutation draws. 2,000 gives a stable 95th percentile at negligible cost. */
  resamples: number;
  seed: number;
}

export const DEFAULT_NULL_MODEL_REQUIREMENTS: NullModelRequirements = { resamples: 2_000, seed: 20261119 };

export interface NullModelDecision {
  status: 'PASS' | 'FAIL' | 'INSUFFICIENT_SAMPLE';
  trades: number;
  observedMeanNetReturnPct: number;
  /** 95th percentile of the null distribution of the mean net return, in %. */
  nullMeanP95Pct: number | null;
  /** Share of null draws whose mean met or beat the observed mean, in %. This is the p-value. */
  pValuePct: number | null;
  requirements: NullModelRequirements;
  reasons: string[];
}

/**
 * Sign-flip permutation null: is the mean return distinguishable from a coin flip?
 *
 * The null hypothesis is "this strategy has no directional skill": every trade's outcome is as
 * likely to have gone the other way, while the *magnitude* of each outcome is fixed by the bracket,
 * the fees and the market's volatility. Each draw multiplies every trade's return by an independent
 * +/-1, which keeps the loss/win magnitudes, the cost drag and the fat tails intact but destroys the
 * direction. The observed mean must clear the 95th percentile of the resulting null means.
 *
 * This is deliberately not a bootstrap of the sample: resampling the same returns with replacement
 * produces a distribution centred on the observed mean, so it can never reject — it would be a test
 * that always "passes" a positive mean. Sign flipping centres the null on zero, which is what "no
 * edge" actually means. A random-entry null on real prices lives in the backtest, where candles are
 * available; this check is the cheap, always-available guard.
 */
export function evaluateNullModel(
  trades: EvidenceTrade[],
  requirements: NullModelRequirements = DEFAULT_NULL_MODEL_REQUIREMENTS,
  minTrades = 100,
): NullModelDecision {
  const n = trades.length;
  if (n < minTrades) {
    return {
      status: 'INSUFFICIENT_SAMPLE',
      trades: n,
      observedMeanNetReturnPct: 0,
      nullMeanP95Pct: null,
      pValuePct: null,
      requirements,
      reasons: ['NULL_MODEL_INSUFFICIENT_SAMPLE'],
    };
  }
  const returns = trades.map((t) => t.netReturn);
  const observedMean = returns.reduce((a, b) => a + b, 0) / n;
  const rnd = seededRandom(requirements.seed);
  const nullMeans: number[] = [];
  for (let s = 0; s < requirements.resamples; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += returns[i] * (rnd() < 0.5 ? -1 : 1);
    nullMeans.push(sum / n);
  }
  nullMeans.sort((a, b) => a - b);
  const p95 = nullMeans[Math.min(nullMeans.length - 1, Math.floor(nullMeans.length * 0.95))];
  const atOrAbove = nullMeans.filter((m) => m >= observedMean).length;
  const pValuePct = atOrAbove / nullMeans.length * 100;
  const passed = observedMean > p95;
  return {
    status: passed ? 'PASS' : 'FAIL',
    trades: n,
    observedMeanNetReturnPct: observedMean * 100,
    nullMeanP95Pct: p95 * 100,
    pValuePct,
    requirements,
    reasons: passed ? [] : ['NULL_MODEL_NOT_BEATEN'],
  };
}
