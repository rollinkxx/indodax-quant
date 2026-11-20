import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY_EVIDENCE_REQUIREMENTS, evaluateStrategyEvidence, wilsonLowerBoundPct } from '../shared/strategyEvidence';

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

// ---------------------------------------------------------------------------------------------
// WP1a: expectancy-based evidence gate
// ---------------------------------------------------------------------------------------------
import {
  DEFAULT_EXPECTANCY_EVIDENCE_REQUIREMENTS,
  evaluateExpectancyEvidence,
  evaluateNullModel,
  maxDrawdownPctOfReturns,
  seededRandom,
  weekBlockBootstrapMeanLowerBound,
  type EvidenceTrade,
} from '../shared/strategyEvidence';

const WEEK = 7 * 86400;

/**
 * Build `n` trades with an EXACT win count and fixed payoff, spread evenly through the sequence so
 * fold consistency and drawdown are not artefacts of a random draw. Using a random draw here would
 * make the test assert on sampling noise (a 50% target realised 45%, changing PF from 1.25 to 1.02).
 */
function buildTrades(opts: {
  n: number;
  winRate: number;
  winReturn: number;
  lossReturn: number;
  weeks?: number;
  pairs?: number;
  folds?: number;
}): EvidenceTrade[] {
  const { n, winReturn, lossReturn } = opts;
  const weeks = opts.weeks ?? 30;
  const pairs = opts.pairs ?? 8;
  const folds = opts.folds ?? 6;
  const winCount = Math.round(n * opts.winRate);
  const trades: EvidenceTrade[] = [];
  // Bresenham-style interleave: yields exactly `winCount` wins, evenly spaced.
  for (let i = 0; i < n; i++) {
    const isWin = Math.floor((i + 1) * winCount / n) > Math.floor(i * winCount / n);
    trades.push({
      netReturn: isWin ? winReturn : lossReturn,
      exitTime: Math.floor(i / n * weeks) * WEEK + 3600,
      pair: `pair${i % pairs}`,
      fold: Math.floor(i / n * folds),
    });
  }
  return trades;
}

describe('seededRandom', () => {
  it('is deterministic for a fixed seed and uniform in [0,1)', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a()];
    const second = [b(), b(), b()];
    expect(first).toEqual(second);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('weekBlockBootstrapMeanLowerBound', () => {
  it('needs at least two week blocks to form a CI', () => {
    const single = [{ netReturn: 0.01, exitTime: 1000, pair: 'a' }];
    expect(weekBlockBootstrapMeanLowerBound(single, 100, 1, 0.05)).toBeNull();
  });

  it('brackets the observed mean for a symmetric sample', () => {
    const trades = buildTrades({ n: 200, winRate: 0.5, winReturn: 0.02, lossReturn: -0.01 });
    const observed = trades.reduce((a, t) => a + t.netReturn, 0) / trades.length;
    const lower = weekBlockBootstrapMeanLowerBound(trades, 2000, 20261119, 0.05)!;
    expect(lower).toBeLessThan(observed);
    expect(lower).toBeGreaterThan(observed - 0.02);
  });
});

describe('maxDrawdownPctOfReturns', () => {
  it('reports zero for a monotonically rising curve and a real value for a dip', () => {
    expect(maxDrawdownPctOfReturns([0.01, 0.01, 0.01])).toBe(0);
    expect(maxDrawdownPctOfReturns([0.1, -0.5])).toBeCloseTo(50, 5);
  });

  it('evaluateExpectancyEvidence computes drawdown in exit-time order', () => {
    // Same three trades in two array orders. Chronological exit order is win -> loss -> loss,
    // which draws down far more than loss -> loss -> win.
    const win = { netReturn: 1.0, exitTime: 300, pair: 'btcidr' };
    const lossA = { netReturn: -0.5, exitTime: 100, pair: 'ethidr' };
    const lossB = { netReturn: -0.5, exitTime: 200, pair: 'xrpidr' };
    const a = evaluateExpectancyEvidence([win, lossB, lossA]);
    const b = evaluateExpectancyEvidence([lossA, lossB, win]);
    expect(a.maxDrawdownPct).toBe(b.maxDrawdownPct);
    // Sanity: the order really matters for the underlying path function.
    expect(maxDrawdownPctOfReturns([-0.5, 1.0, -0.5]))
      .not.toBeCloseTo(maxDrawdownPctOfReturns([1.0, -0.5, -0.5]), 5);
  });
});

describe('evaluateExpectancyEvidence (WP1a)', () => {
  it('ACCEPTS a genuine 50%-win / PF ~1.25 / n=300 edge that the legacy 70% gate rejects', () => {
    // 50% at +1.25R / -1R gives PF ~1.25 and a small positive mean — the shape of a real edge.
    const trades = buildTrades({ n: 300, winRate: 0.5, winReturn: 0.0125, lossReturn: -0.01 });
    const decision = evaluateExpectancyEvidence(trades);
    expect(decision.status).toBe('ELIGIBLE_FOR_MANUAL_REVIEW');
    expect(decision.reasons).toEqual([]);
    expect(decision.winRatePct).toBeGreaterThan(45);
    expect(decision.winRatePct).toBeLessThan(55);
    expect(decision.profitFactor).toBeGreaterThanOrEqual(1.15);
    // The legacy gate would have rejected this same sample outright.
    expect(evaluateStrategyEvidence({
      trades: 300, wins: 150, winRatePct: 50, profitFactor: 1.25, expectancyIdr: 100,
    }).status).toBe('NO_GO');
  });

  it('REJECTS an 80%-win geometry artefact whose profit factor is 0.6', () => {
    // A close target and a far stop win often and still lose money: geometry, not edge.
    // 80% at +0.3% / 20% at -2% gives gross win 0.24% against gross loss 0.40%, i.e. PF 0.6.
    const trades = buildTrades({ n: 300, winRate: 0.8, winReturn: 0.003, lossReturn: -0.02 });
    const decision = evaluateExpectancyEvidence(trades);
    expect(decision.status).toBe('NO_GO');
    expect(decision.profitFactor).toBeCloseTo(0.6, 2);
    expect(decision.winRatePct).toBeGreaterThan(75);
    expect(decision.reasons).toContain('EXPECTANCY_LOWER_BOUND_NOT_POSITIVE');
    expect(decision.reasons).toContain('PROFIT_FACTOR_BELOW_THRESHOLD');
  });

  it('REJECTS a sample carried by a single +95% outlier trade', () => {
    // A near-flat strategy that only looks positive because one trade returned +95%.
    const trades = buildTrades({ n: 300, winRate: 0.5, winReturn: 0.001, lossReturn: -0.0012 });
    trades[17] = { ...trades[17], netReturn: 0.95 };
    const decision = evaluateExpectancyEvidence(trades);
    expect(decision.status).toBe('NO_GO');
    expect(decision.reasons).toContain('EDGE_DEPENDS_ON_TOP_TRADES');
    expect(decision.meanNetReturnWithoutBestPct).toBeLessThan(0);
  });

  it('REJECTS a small sample and a sample concentrated in one pair', () => {
    const small = evaluateExpectancyEvidence(
      buildTrades({ n: 40, winRate: 0.6, winReturn: 0.02, lossReturn: -0.01 }),
    );
    expect(small.status).toBe('NO_GO');
    expect(small.reasons).toContain('INSUFFICIENT_HOLDOUT_SAMPLE');

    // Most trades land on one pair, so that pair supplies the bulk of net profit.
    const concentrated: EvidenceTrade[] = Array.from({ length: 200 }, (_, i) => ({
      netReturn: i % 2 === 0 ? 0.02 : -0.01,
      exitTime: Math.floor(i / 10) * WEEK + 3600,
      pair: i % 10 === 0 ? `p${i % 7}` : 'whale',
      fold: Math.floor(i / 40),
    }));
    const decision = evaluateExpectancyEvidence(concentrated);
    expect(decision.status).toBe('NO_GO');
    expect(decision.reasons).toContain('PROFIT_CONCENTRATED_IN_ONE_PAIR');
  });

  it('never returns anything but NO_GO or ELIGIBLE_FOR_MANUAL_REVIEW', () => {
    const decision = evaluateExpectancyEvidence(
      buildTrades({ n: 300, winRate: 0.5, winReturn: 0.0125, lossReturn: -0.01 }),
    );
    expect(['NO_GO', 'ELIGIBLE_FOR_MANUAL_REVIEW']).toContain(decision.status);
    expect(decision.requirements.minHoldoutTrades).toBe(DEFAULT_EXPECTANCY_EVIDENCE_REQUIREMENTS.minHoldoutTrades);
  });
});

describe('evaluateNullModel (WP1f: is the mean distinguishable from noise?)', () => {
  it('is deterministic for a fixed seed', () => {
    const trades = buildTrades({ n: 300, winRate: 0.6, winReturn: 0.01, lossReturn: -0.008 });
    const a = evaluateNullModel(trades);
    const b = evaluateNullModel(trades);
    expect(a).toEqual(b);
    expect(a.nullMeanP95Pct).not.toBeNull();
  });

  it('FAILS a pure-noise sample whose mean sits inside its own resampled distribution', () => {
    // Symmetric zero-mean noise: every resample of it is the same population, so the observed mean
    // cannot beat the 95th percentile of the null. This is the guard against "positive mean" being
    // read as "edge" when the sample is just a draw from a coin flip.
    const rnd = seededRandom(424242);
    const trades: EvidenceTrade[] = Array.from({ length: 400 }, (_, i) => ({
      netReturn: (rnd() - 0.5) * 0.04,
      exitTime: 1_700_000_000 + i * 3600,
      pair: `p${i % 5}idr`,
    }));
    const decision = evaluateNullModel(trades);
    expect(decision.status).toBe('FAIL');
    expect(decision.reasons).toContain('NULL_MODEL_NOT_BEATEN');
    expect(decision.pValuePct).toBeGreaterThan(5);
  });

  it('PASSES a sample whose mean clears the null 95th percentile', () => {
    // A genuine upward shift: mean well above zero relative to the noise band.
    const rnd = seededRandom(99);
    const trades: EvidenceTrade[] = Array.from({ length: 400 }, (_, i) => ({
      netReturn: 0.01 + (rnd() - 0.5) * 0.004,
      exitTime: 1_700_000_000 + i * 3600,
      pair: `p${i % 5}idr`,
    }));
    const decision = evaluateNullModel(trades);
    expect(decision.status).toBe('PASS');
    expect(decision.observedMeanNetReturnPct).toBeGreaterThan(decision.nullMeanP95Pct!);
  });

  it('refuses to judge a sample below the minimum size', () => {
    const decision = evaluateNullModel(buildTrades({ n: 10, winRate: 0.9, winReturn: 0.05, lossReturn: -0.01 }));
    expect(decision.status).toBe('INSUFFICIENT_SAMPLE');
    expect(decision.reasons).toContain('NULL_MODEL_INSUFFICIENT_SAMPLE');
  });
});
