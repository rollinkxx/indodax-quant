import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMOTION_CRITERIA, buildWalkForwardFolds, clusterBootstrap, embargoSeconds, evaluatePromotion,
  maxPairContributionSharePct, maxRegimeContributionSharePct, netPnlExcludingTopTrades, seededRandom, tradeStats, walkForwardReport,
  type TradeObservation,
} from '../shared/walkForward';

const DAY = 86_400;

function trade(over: Partial<TradeObservation> = {}): TradeObservation {
  return { pnl: 1000, costBasis: 1_000_000, pair: 'btcidr', entryTime: 0, exitTime: 0, reason: 'TAKE_PROFIT', ...over };
}

describe('embargo', () => {
  it('covers the holding period plus indicator and higher-timeframe lookback', () => {
    const s = embargoSeconds({ maxHoldingSeconds: 7200, indicatorLookbackBars: 250, higherTimeframeLookbackBars: 120, barSeconds: 300 });
    expect(s).toBe(7200 + (250 + 120) * 300);
  });
});

describe('walk-forward folds', () => {
  it('builds chronological folds whose test windows never overlap the train/validation data', () => {
    const folds = buildWalkForwardFolds({ startSec: 0, endSec: 10 * DAY, folds: 6, embargoSec: 3600 });
    expect(folds.length).toBeGreaterThanOrEqual(5);
    for (const f of folds) {
      expect(f.trainEnd).toBeLessThanOrEqual(f.validationStart);
      expect(f.validationEnd).toBeLessThanOrEqual(f.testStart);
      expect(f.trainStart).toBe(0);
    }
    // Test windows are ordered and non-overlapping.
    for (let i = 1; i < folds.length; i++) expect(folds[i].testStart).toBeGreaterThanOrEqual(folds[i - 1].testEnd);
  });

  it('returns nothing for a zero-length window', () => {
    expect(buildWalkForwardFolds({ startSec: 5, endSec: 5, folds: 6, embargoSec: 0 })).toEqual([]);
  });
});

describe('trade stats', () => {
  it('computes profit factor, expectancy and payoff ratio', () => {
    const stats = tradeStats([
      trade({ pnl: 2000 }), trade({ pnl: -1000 }), trade({ pnl: 3000 }), trade({ pnl: -500 }),
    ]);
    expect(stats.trades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.profitFactor).toBeCloseTo(5000 / 1500, 6);
    expect(stats.netPnl).toBe(3500);
    expect(stats.expectancyIdr).toBe(875);
  });

  it('reports a null profit factor when there are no losses but some wins', () => {
    expect(tradeStats([trade({ pnl: 100 })]).profitFactor).toBeNull();
  });
});

describe('cluster bootstrap', () => {
  it('is deterministic for a fixed seed', () => {
    const trades = Array.from({ length: 40 }, (_, i) => trade({ pnl: i % 3 === 0 ? -500 : 800, pair: `p${i % 4}`, exitTime: i * DAY }));
    const a = clusterBootstrap(trades, 'day', { resamples: 500, seed: 7 });
    const b = clusterBootstrap(trades, 'day', { resamples: 500, seed: 7 });
    expect(a).toEqual(b);
  });

  it('gives a positive lower bound for a strongly positive edge and a non-positive one for a losing edge', () => {
    const winners = Array.from({ length: 30 }, (_, i) => trade({ pnl: 1000, pair: `p${i % 5}`, exitTime: i * DAY }));
    expect(clusterBootstrap(winners, 'pair', { resamples: 400, seed: 1 }).lower95Idr).toBeGreaterThan(0);
    const losers = Array.from({ length: 30 }, (_, i) => trade({ pnl: -1000, pair: `p${i % 5}`, exitTime: i * DAY }));
    expect(clusterBootstrap(losers, 'pair', { resamples: 400, seed: 1 }).lower95Idr).toBeLessThanOrEqual(0);
  });

  it('seededRandom stays within [0, 1)', () => {
    const rng = seededRandom(42);
    for (let i = 0; i < 100; i++) { const v = rng(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe('walk-forward report + promotion gate', () => {
  const folds = buildWalkForwardFolds({ startSec: 0, endSec: 6 * DAY, folds: 6, embargoSec: 600 });

  function tradesInFolds(pnlFn: (foldIdx: number, j: number) => number): TradeObservation[] {
    const out: TradeObservation[] = [];
    for (const f of folds) {
      for (let j = 0; j < 12; j++) {
        out.push(trade({ pnl: pnlFn(f.fold, j), pair: `p${j % 3}`, exitTime: f.testStart + j * 60 }));
      }
    }
    return out;
  }

  it('rejects a strategy with a materially negative fold even if pooled is positive', () => {
    const trades = tradesInFolds((fold) => (fold === 2 ? -2000 : 1000));
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5 });
    expect(report.negativeFolds).toBeGreaterThanOrEqual(1);
    const decision = evaluatePromotion(report, 5);
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('MATERIALLY_NEGATIVE_FOLD');
  });

  it('passes a strategy that is positive in every fold with a strong bootstrap lower bound', () => {
    const trades = tradesInFolds(() => 1500);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    const decision = evaluatePromotion(report, 5, DEFAULT_PROMOTION_CRITERIA, {
      configFrozen: true, fillModelLabel: 'QUOTE_BASED', maxSinglePairContributionSharePct: 40,
      exTopTradeNetPnlIdr: 1000, portfolioConstraintsActive: true, universeIsTimestamped: true,
    });
    expect(decision.checks.majorityPositive).toBe(true);
    expect(decision.checks.noMateriallyNegativeFold).toBe(true);
    expect(decision.eligible).toBe(true);
  });

  it('blocks a run whose universe membership was not timestamped', () => {
    const trades = tradesInFolds(() => 1500);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    const decision = evaluatePromotion(report, 5, DEFAULT_PROMOTION_CRITERIA, {
      configFrozen: true, fillModelLabel: 'QUOTE_BASED', maxSinglePairContributionSharePct: 40,
      exTopTradeNetPnlIdr: 1000, portfolioConstraintsActive: true, universeIsTimestamped: false,
    });
    expect(decision.checks.timestampedUniverse).toBe(false);
    expect(decision.reasons).toContain('UNIVERSE_NOT_TIMESTAMPED');
    expect(decision.eligible).toBe(false);
  });

  it('blocks a candle-only fill model, an unfrozen config and a single-pair result', () => {
    const trades = tradesInFolds(() => 1500);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    const decision = evaluatePromotion(report, 5, DEFAULT_PROMOTION_CRITERIA, {
      configFrozen: false, fillModelLabel: 'CANDLE_ONLY_OPTIMISTIC', maxSinglePairContributionSharePct: 95,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('CONFIG_NOT_FROZEN');
    expect(decision.reasons).toContain('FILL_MODEL_IS_CANDLE_ONLY');
    expect(decision.reasons).toContain('SINGLE_PAIR_DEPENDENT');
  });

  it('blocks a result that only survives on its best few trades', () => {
    const trades = tradesInFolds(() => 1500);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    const decision = evaluatePromotion(report, 5, DEFAULT_PROMOTION_CRITERIA, {
      configFrozen: true, fillModelLabel: 'QUOTE_BASED', exTopTradeNetPnlIdr: -1,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('TOP_TRADE_DEPENDENT');
  });

  it('fails the promotion gate when drawdown exceeds the budget', () => {
    const trades = tradesInFolds(() => 1500);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    expect(evaluatePromotion(report, DEFAULT_PROMOTION_CRITERIA.maxDrawdownPct + 1).eligible).toBe(false);
  });

  it('fails when there are too few material folds', () => {
    const trades = tradesInFolds(() => 1500).slice(0, 5);
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5 });
    expect(evaluatePromotion(report, 5).checks.enoughFolds).toBe(false);
  });
});

describe('promotion robustness helpers', () => {
  const t = (pnl: number, pair: string): TradeObservation => ({
    pnl, costBasis: 100_000, pair, entryTime: 0, exitTime: 0, reason: 'TP',
  });

  it('netPnlExcludingTopTrades drops the best trades and can flip the sign', () => {
    const trades = [t(5_000, 'a'), t(300, 'b'), t(200, 'c'), t(-400, 'd')];
    expect(netPnlExcludingTopTrades(trades, 0)).toBe(5_100);
    expect(netPnlExcludingTopTrades(trades, 1)).toBe(100);
    expect(netPnlExcludingTopTrades(trades, 2)).toBe(-200);
  });

  it('maxPairContributionSharePct reports the dominant pair share', () => {
    expect(maxPairContributionSharePct([t(9_000, 'a'), t(1_000, 'b')])).toBeCloseTo(90, 6);
    expect(maxPairContributionSharePct([])).toBe(0);
  });
});

describe('regime concentration', () => {
  const t = (pnl: number, regime: string): TradeObservation => ({
    pnl, costBasis: 100_000, pair: 'a', entryTime: 0, exitTime: 0, reason: 'TP', regime,
  });

  it('reports the dominant regime share', () => {
    expect(maxRegimeContributionSharePct([t(9_000, 'uptrend'), t(1_000, 'range')])).toBeCloseTo(90, 6);
  });

  it('treats unlabelled trades as one concentrated bucket, not as diversified', () => {
    expect(maxRegimeContributionSharePct([t(1_000, undefined as unknown as string), t(1_000, undefined as unknown as string)])).toBe(100);
  });

  it('blocks a result that only makes money in one regime', () => {
    const folds = buildWalkForwardFolds({ startSec: 0, endSec: 6 * DAY, folds: 6, embargoSec: 600 });
    const trades: TradeObservation[] = [];
    for (const f of folds) {
      for (let j = 0; j < 12; j++) {
        trades.push(trade({ pnl: 1500, pair: `p${j % 3}`, exitTime: f.testStart + j * 60, regime: j === 0 ? 'range' : 'uptrend' }));
      }
    }
    const report = walkForwardReport({ trades, folds, minFoldTrades: 5, bootstrap: { resamples: 400, seed: 3 } });
    const decision = evaluatePromotion(report, 5, DEFAULT_PROMOTION_CRITERIA, {
      configFrozen: true, fillModelLabel: 'QUOTE_BASED', maxSinglePairContributionSharePct: 40,
      maxSingleRegimeContributionSharePct: maxRegimeContributionSharePct(trades),
      exTopTradeNetPnlIdr: 1000, portfolioConstraintsActive: true, universeIsTimestamped: true,
    });
    expect(decision.checks.notSingleRegimeDependent).toBe(false);
    expect(decision.reasons).toContain('SINGLE_REGIME_DEPENDENT');
  });
});
