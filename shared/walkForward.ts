// Walk-forward validation and cluster bootstrap for strategy evidence.
//
// A single 70/30 split is one sample of one regime. A strategy can look profitable on it and still be
// structurally negative. This module builds several chronological folds (train → validation → embargo
// → test), freezes the configuration before each test, and resamples trades by cluster (pair, day or
// regime) so a run of correlated trades is never counted as independent evidence.

export interface TradeObservation {
  /** Realised PnL in IDR (net of fees/slippage). */
  pnl: number;
  costBasis: number;
  pair: string;
  entryTime: number;
  exitTime: number;
  reason: string;
  /** Optional market-regime label for cluster resampling. */
  regime?: string;
}

export interface FoldWindow {
  fold: number;
  trainStart: number;
  trainEnd: number;
  validationStart: number;
  validationEnd: number;
  testStart: number;
  testEnd: number;
}

export interface EmbargoInput {
  maxHoldingSeconds: number;
  indicatorLookbackBars: number;
  higherTimeframeLookbackBars: number;
  barSeconds: number;
}

/** Embargo = the longest time a position or indicator can still be influenced by the boundary. */
export function embargoSeconds(i: EmbargoInput): number {
  const holding = Math.max(0, i.maxHoldingSeconds);
  const bars = Math.max(0, i.indicatorLookbackBars) + Math.max(0, i.higherTimeframeLookbackBars);
  return holding + bars * Math.max(1, i.barSeconds);
}

/**
 * Build chronological folds over [startSec, endSec). Each fold's test window is preceded by a
 * validation window and an embargo gap, so the test never touches the data used to pick parameters.
 * Returns fewer folds when the window is too short for `folds` usable test blocks.
 */
export function buildWalkForwardFolds(input: {
  startSec: number;
  endSec: number;
  folds: number;
  embargoSec: number;
  /** Fraction of each fold's span used for validation (the rest is train). */
  validationFraction?: number;
}): FoldWindow[] {
  const { startSec, endSec } = input;
  const folds = Math.max(2, Math.floor(input.folds));
  const span = endSec - startSec;
  if (!(span > 0)) return [];
  const foldSpan = span / folds;
  const validationFraction = Math.min(0.5, Math.max(0.1, input.validationFraction ?? 0.2));
  const out: FoldWindow[] = [];
  for (let k = 1; k < folds; k++) {
    const trainStart = startSec;
    const testStart = startSec + k * foldSpan;
    const testEnd = k === folds - 1 ? endSec : startSec + (k + 1) * foldSpan;
    const validationEnd = testStart - input.embargoSec;
    const validationStart = validationEnd - foldSpan * validationFraction;
    const trainEnd = validationStart - input.embargoSec;
    if (trainEnd <= trainStart || validationEnd <= validationStart || testEnd <= testStart) continue;
    out.push({ fold: k, trainStart, trainEnd, validationStart, validationEnd, testStart, testEnd });
  }
  return out;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  netPnl: number;
  expectancyIdr: number;
  expectancyR: number;
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number | null;
  tailLossIdr: number;
}

export function tradeStats(trades: readonly TradeObservation[]): TradeStats {
  const n = trades.length;
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const net = pnls.reduce((a, b) => a + b, 0);
  const rs = trades.map((t) => (t.costBasis > 0 ? t.pnl / t.costBasis : 0));
  const rWins = rs.filter((r) => r > 0);
  const rLosses = rs.filter((r) => r <= 0);
  const avgWinR = rWins.length ? rWins.reduce((a, b) => a + b, 0) / rWins.length : 0;
  const avgLossR = rLosses.length ? Math.abs(rLosses.reduce((a, b) => a + b, 0) / rLosses.length) : 0;
  const worst = n ? Math.min(...pnls) : 0;
  const sorted = [...pnls].sort((a, b) => a - b);
  // 5th-percentile tail loss, or the single worst trade for small samples.
  const tailIdx = Math.floor(sorted.length * 0.05);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n ? wins.length / n * 100 : 0,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    netPnl: net,
    expectancyIdr: n ? net / n : 0,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    avgWinPct: rWins.length ? avgWinR * 100 : 0,
    avgLossPct: rLosses.length ? avgLossR * 100 : 0,
    payoffRatio: avgLossR > 0 ? avgWinR / avgLossR : null,
    tailLossIdr: sorted.length ? sorted[Math.max(0, tailIdx)] ?? worst : 0,
  };
}

export interface FoldResult {
  fold: number;
  test: TradeStats;
  /** Whether the fold is material enough to count (fewer trades than this is reported, not scored). */
  material: boolean;
}

export interface WalkForwardReport {
  folds: FoldResult[];
  materialFolds: number;
  positiveFolds: number;
  negativeFolds: number;
  worstFoldExpectancyIdr: number;
  pooledTest: TradeStats;
  /** Lower bound of a cluster-bootstrap 95% CI on the test-set mean PnL. */
  bootstrapLower95ExpectancyIdr: number;
  /** Fraction of resamples whose mean PnL was <= 0. */
  bootstrapPValue: number;
}

/** Assign each trade to the fold whose test window contains its exit time. */
export function splitTradesByFold(trades: readonly TradeObservation[], folds: readonly FoldWindow[]): Map<number, TradeObservation[]> {
  const out = new Map<number, TradeObservation[]>();
  for (const f of folds) out.set(f.fold, []);
  for (const t of trades) {
    for (const f of folds) {
      if (t.exitTime >= f.testStart && t.exitTime < f.testEnd) { out.get(f.fold)!.push(t); break; }
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so bootstrap results are reproducible in tests and CI. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ClusterKey = 'pair' | 'day' | 'regime';

function clusterOf(t: TradeObservation, key: ClusterKey): string {
  if (key === 'pair') return t.pair;
  if (key === 'regime') return t.regime ?? 'unknown';
  return String(Math.floor(t.exitTime / 86_400));
}

export interface BootstrapResult {
  meanIdr: number;
  lower95Idr: number;
  upper95Idr: number;
  pValue: number;
  resamples: number;
}

/**
 * Cluster bootstrap of the mean PnL. Resampling clusters (not individual trades) keeps correlated
 * trades together: 100 trades on one pair on one day are one observation of that day, not 100.
 */
export function clusterBootstrap(trades: readonly TradeObservation[], key: ClusterKey, opts: { resamples?: number; seed?: number; alpha?: number } = {}): BootstrapResult {
  const resamples = Math.max(1, Math.floor(opts.resamples ?? 2000));
  const alpha = opts.alpha ?? 0.05;
  if (!trades.length) return { meanIdr: 0, lower95Idr: 0, upper95Idr: 0, pValue: 1, resamples };
  const clusters = new Map<string, number[]>();
  for (const t of trades) {
    const k = clusterOf(t, key);
    const list = clusters.get(k) ?? [];
    list.push(t.pnl);
    clusters.set(k, list);
  }
  const ids = [...clusters.keys()];
  const rng = seededRandom(opts.seed ?? 12345);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      const pick = ids[Math.floor(rng() * ids.length)];
      const pnls = clusters.get(pick)!;
      for (const v of pnls) { sum += v; count++; }
    }
    means.push(count ? sum / count : 0);
  }
  means.sort((a, b) => a - b);
  const observedMean = trades.reduce((a, b) => a + b.pnl, 0) / trades.length;
  const lower = means[Math.floor((alpha / 2) * means.length)] ?? means[0];
  const upper = means[Math.min(means.length - 1, Math.floor((1 - alpha / 2) * means.length))] ?? means[means.length - 1];
  const nonPositive = means.filter((m) => m <= 0).length;
  return { meanIdr: observedMean, lower95Idr: lower, upper95Idr: upper, pValue: nonPositive / means.length, resamples };
}

/**
 * Full walk-forward report. A fold is `material` only when it clears `minFoldTrades`; a material fold
 * with negative expectancy is counted separately so a single bad regime cannot be averaged away.
 */
export function walkForwardReport(input: {
  trades: readonly TradeObservation[];
  folds: readonly FoldWindow[];
  minFoldTrades?: number;
  bootstrap?: { resamples?: number; seed?: number; key?: ClusterKey };
}): WalkForwardReport {
  const minFoldTrades = Math.max(1, Math.floor(input.minFoldTrades ?? 10));
  const byFold = splitTradesByFold(input.trades, input.folds);
  const foldResults: FoldResult[] = [];
  const pooled: TradeObservation[] = [];
  for (const f of input.folds) {
    const test = byFold.get(f.fold) ?? [];
    const stats = tradeStats(test);
    foldResults.push({ fold: f.fold, test: stats, material: stats.trades >= minFoldTrades });
    if (stats.trades >= minFoldTrades) pooled.push(...test);
  }
  const material = foldResults.filter((f) => f.material);
  const positive = material.filter((f) => f.test.expectancyIdr > 0).length;
  const negative = material.filter((f) => f.test.expectancyIdr < 0).length;
  const worst = material.length ? Math.min(...material.map((f) => f.test.expectancyIdr)) : 0;
  const boot = clusterBootstrap(pooled, input.bootstrap?.key ?? 'day', { resamples: input.bootstrap?.resamples, seed: input.bootstrap?.seed });
  return {
    folds: foldResults,
    materialFolds: material.length,
    positiveFolds: positive,
    negativeFolds: negative,
    worstFoldExpectancyIdr: worst,
    pooledTest: tradeStats(pooled),
    bootstrapLower95ExpectancyIdr: boot.lower95Idr,
    bootstrapPValue: boot.pValue,
  };
}

export interface PromotionCriteria {
  minMaterialFolds: number;
  /** A fold whose expectancy is worse than this (IDR) is "materially negative". */
  maxNegativeFoldExpectancyIdr: number;
  minProfitFactor: number;
  minBootstrapLower95ExpectancyIdr: number;
  maxDrawdownPct: number;
  /** No single pair may contribute more than this share of gross absolute PnL. */
  maxSinglePairContributionSharePct: number;
  /** Same concentration limit applied to market regimes, so one bull run cannot carry the result. */
  maxSingleRegimeContributionSharePct: number;
  /** Net PnL must survive removing the best `topTradeCount` trades. */
  topTradeCount: number;
  /** A config must be frozen before the test fold is read. */
  requireFrozenConfig: boolean;
  /** Candle-only fills are an optimistic upper bound and can never be promoted. */
  requireRealisticFillModel: boolean;
  /** Current universe flags applied to the whole history are not historical evidence. */
  requireTimestampedUniverse: boolean;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minMaterialFolds: 4,
  maxNegativeFoldExpectancyIdr: -1,
  minProfitFactor: 1,
  minBootstrapLower95ExpectancyIdr: 0,
  maxDrawdownPct: 20,
  maxSinglePairContributionSharePct: 60,
  maxSingleRegimeContributionSharePct: 80,
  topTradeCount: 5,
  requireFrozenConfig: true,
  requireRealisticFillModel: true,
  requireTimestampedUniverse: true,
};

export interface PromotionDecision {
  eligible: boolean;
  checks: Record<string, boolean>;
  reasons: string[];
}

/**
 * Promotion gate for paper-forward. Every criterion must hold; a single failing check blocks.
 * This is a filter for human review, never an automatic promotion.
 *
 * Beyond the fold/bootstrap statistics this also rejects results that hinge on one pair, on a
 * handful of lucky trades, on a candle-only fill model, or on parameters tuned after the fact.
 */
export function evaluatePromotion(
  report: WalkForwardReport,
  drawdownPct: number,
  criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
  robustness: PromotionRobustness = {},
): PromotionDecision {
  const checks = {
    enoughFolds: report.materialFolds >= criteria.minMaterialFolds,
    majorityPositive: report.positiveFolds > report.negativeFolds,
    noMateriallyNegativeFold: report.worstFoldExpectancyIdr >= criteria.maxNegativeFoldExpectancyIdr,
    // A null profit factor with gross wins and no losses is an infinite ratio, which clears the floor.
    profitFactorAboveOne: report.pooledTest.profitFactor === null
      ? report.pooledTest.grossWin > 0
      : report.pooledTest.profitFactor > criteria.minProfitFactor,
    bootstrapLower95Positive: report.bootstrapLower95ExpectancyIdr > criteria.minBootstrapLower95ExpectancyIdr,
    drawdownWithinBudget: drawdownPct <= criteria.maxDrawdownPct,
    notSinglePairDependent: (robustness.maxSinglePairContributionSharePct ?? 0) <= criteria.maxSinglePairContributionSharePct,
    notSingleRegimeDependent: (robustness.maxSingleRegimeContributionSharePct ?? 0) <= criteria.maxSingleRegimeContributionSharePct,
    notTopTradeDependent: robustness.exTopTradeNetPnlIdr === undefined || robustness.exTopTradeNetPnlIdr > 0,
    configFrozen: !criteria.requireFrozenConfig || robustness.configFrozen === true,
    realisticFillModel: !criteria.requireRealisticFillModel || robustness.fillModelLabel === 'QUOTE_BASED',
    portfolioConstraintsActive: robustness.portfolioConstraintsActive !== false,
    // A run that applied today's membership to the whole history traded pairs that were not yet
    // listed or liquid, so its statistics are not evidence about the strategy.
    timestampedUniverse: !criteria.requireTimestampedUniverse || robustness.universeIsTimestamped !== false,
  };
  const reasons: string[] = [];
  if (!checks.enoughFolds) reasons.push('INSUFFICIENT_MATERIAL_FOLDS');
  if (!checks.majorityPositive) reasons.push('MAJORITY_OF_FOLDS_NOT_POSITIVE');
  if (!checks.noMateriallyNegativeFold) reasons.push('MATERIALLY_NEGATIVE_FOLD');
  if (!checks.profitFactorAboveOne) reasons.push('PROFIT_FACTOR_NOT_ABOVE_ONE');
  if (!checks.bootstrapLower95Positive) reasons.push('BOOTSTRAP_LOWER_BOUND_NOT_POSITIVE');
  if (!checks.drawdownWithinBudget) reasons.push('DRAWDOWN_OVER_BUDGET');
  if (!checks.notSinglePairDependent) reasons.push('SINGLE_PAIR_DEPENDENT');
  if (!checks.notSingleRegimeDependent) reasons.push('SINGLE_REGIME_DEPENDENT');
  if (!checks.notTopTradeDependent) reasons.push('TOP_TRADE_DEPENDENT');
  if (!checks.configFrozen) reasons.push('CONFIG_NOT_FROZEN');
  if (!checks.realisticFillModel) reasons.push('FILL_MODEL_IS_CANDLE_ONLY');
  if (!checks.portfolioConstraintsActive) reasons.push('PORTFOLIO_CONSTRAINTS_INACTIVE');
  if (!checks.timestampedUniverse) reasons.push('UNIVERSE_NOT_TIMESTAMPED');
  return { eligible: Object.values(checks).every(Boolean), checks, reasons };
}

export interface PromotionRobustness {
  maxSinglePairContributionSharePct?: number;
  maxSingleRegimeContributionSharePct?: number;
  /** Net PnL after dropping the best `topTradeCount` trades. */
  exTopTradeNetPnlIdr?: number;
  configFrozen?: boolean;
  fillModelLabel?: 'CANDLE_ONLY_OPTIMISTIC' | 'QUOTE_BASED';
  portfolioConstraintsActive?: boolean;
  /** False when the run used current membership flags for all history. Omitted = unknown. */
  universeIsTimestamped?: boolean;
}

/** Net PnL with the best `n` trades removed — a result that only survives on outliers is fragile. */
export function netPnlExcludingTopTrades(trades: readonly TradeObservation[], n: number): number {
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  return sorted.slice(Math.max(0, Math.floor(n))).reduce((a, t) => a + t.pnl, 0);
}

/** Largest single-pair share of gross absolute PnL, in percent (0 when there is no PnL). */
export function maxPairContributionSharePct(trades: readonly TradeObservation[]): number {
  return maxClusterContributionSharePct(trades, (t) => t.pair);
}

/**
 * Largest single-regime share of gross absolute PnL, in percent.
 *
 * Trades without a regime label all collapse into one bucket, so a run whose labels are missing is
 * treated as fully concentrated rather than as perfectly diversified.
 */
export function maxRegimeContributionSharePct(trades: readonly TradeObservation[]): number {
  return maxClusterContributionSharePct(trades, (t) => t.regime ?? 'unknown');
}

function maxClusterContributionSharePct(trades: readonly TradeObservation[], key: (t: TradeObservation) => string): number {
  const byKey = new Map<string, number>();
  for (const t of trades) byKey.set(key(t), (byKey.get(key(t)) ?? 0) + t.pnl);
  let total = 0;
  let top = 0;
  for (const v of byKey.values()) {
    total += Math.abs(v);
    top = Math.max(top, Math.abs(v));
  }
  return total > 0 ? top / total * 100 : 0;
}
