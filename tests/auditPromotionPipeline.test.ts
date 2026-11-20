import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import { DEFAULT_PARAMS, type StrategyParams } from '../shared/strategy';
import { DEFAULT_FILL_MODEL, simulatePortfolio, type PortfolioPairInput } from '../shared/portfolioBacktest';
import {
  DEFAULT_PROMOTION_CRITERIA, buildWalkForwardFolds, clusterBootstrap, embargoSeconds, evaluatePromotion,
  maxPairContributionSharePct, netPnlExcludingTopTrades, walkForwardReport, type TradeObservation,
} from '../shared/walkForward';
import { TIMEFRAME_SPECS } from '../shared/timeframes';

/**
 * End-to-end composition of the audit's §3 (portfolio chronology) → §10 (walk-forward) → §11
 * (promotion) chain, on synthetic data. This is the same sequence `scripts/backtest.ts` runs, so a
 * regression in the wiring fails here rather than in a production research run.
 */
const T0 = 1_790_000_000 - (1_790_000_000 % 300);

function series(n: number, opts: { drift?: number; volume?: number } = {}): Candle[] {
  const drift = opts.drift ?? 1;
  return Array.from({ length: n }, (_, i) => {
    const c = 1000 + i * drift;
    return { t: T0 + i * 300, o: c, h: c + 3, l: c - 3, c, v: opts.volume ?? 1_000_000, n: 10, source: 'trades' } as Candle;
  });
}

const params: StrategyParams = {
  ...DEFAULT_PARAMS,
  minCandles: 30,
  maxOpenPositions: 2,
  maxTotalExposurePct: 60,
  riskPerTradePct: 1,
  maxPositionPct: 25,
  feeModel: 'pair_taker',
  feePct: 0.2,
  timeStopMinutes: 0,
  trailingStopEnabled: false,
};

const buyEvery = (every: number) => (_p: string, _c: Candle[], index: number) => (index % every === 0 ? 'BUY' : 'HOLD');

describe('portfolio → walk-forward → promotion chain', () => {
  const pairs: PortfolioPairInput[] = ['aaa', 'bbb', 'ccc'].map((p) => ({
    pair: p, candles: series(400, { drift: 1 }), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
  }));
  const run = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(6) });
  const obs: TradeObservation[] = run.trades.map((t) => ({
    pnl: t.pnl, costBasis: t.cost, pair: t.pair, entryTime: t.entryTime, exitTime: t.exitTime, reason: t.reason,
  }));

  it('produces trades with a structured exit reason for every position', () => {
    expect(obs.length).toBeGreaterThan(0);
    for (const t of obs) expect(t.reason.length).toBeGreaterThan(0);
    expect(run.finalEquity).toBeCloseTo(run.initialCash + obs.reduce((a, t) => a + t.pnl, 0), 2);
  });

  it('derives folds whose embargo covers holding plus indicator plus higher-timeframe lookback', () => {
    const spec = TIMEFRAME_SPECS['5m'];
    const embargoSec = embargoSeconds({
      maxHoldingSeconds: spec.maxHoldingBars * spec.baseSeconds,
      indicatorLookbackBars: params.minCandles,
      higherTimeframeLookbackBars: 120 * 12,
      barSeconds: spec.baseSeconds,
    });
    expect(embargoSec).toBeGreaterThan(spec.maxHoldingBars * spec.baseSeconds);
    // The window must be long enough that the embargo does not swallow every fold.
    const endSec = T0 + 60 * 24 * 12 * 300;
    const folds = buildWalkForwardFolds({ startSec: T0, endSec, folds: 7, embargoSec });
    expect(folds.length).toBeGreaterThanOrEqual(4);
    for (const f of folds) {
      expect(f.trainEnd).toBeLessThanOrEqual(f.validationStart);
      expect(f.validationEnd).toBeLessThanOrEqual(f.testStart);
      expect(f.testStart).toBeLessThan(f.testEnd);
      expect(f.testStart - f.validationEnd).toBeGreaterThanOrEqual(embargoSec);
    }
  });

  it('yields no folds when the window is shorter than the embargo, which fails the gate closed', () => {
    const shortEnd = T0 + 400 * 300;
    const folds = buildWalkForwardFolds({ startSec: T0, endSec: shortEnd, folds: 7, embargoSec: 5 * 86_400 });
    expect(folds).toEqual([]);
    const report = walkForwardReport({ trades: obs, folds, minFoldTrades: 1 });
    expect(evaluatePromotion(report, 0).checks.enoughFolds).toBe(false);
  });

  it('never promotes a candle-only run, however good the numbers look', () => {
    const folds = buildWalkForwardFolds({ startSec: T0, endSec: T0 + 400 * 300, folds: 7, embargoSec: 3600 });
    const report = walkForwardReport({ trades: obs, folds, minFoldTrades: 1, bootstrap: { resamples: 200, seed: 5 } });
    const decision = evaluatePromotion(report, run.maxDrawdownPct, DEFAULT_PROMOTION_CRITERIA, {
      maxSinglePairContributionSharePct: maxPairContributionSharePct(obs),
      exTopTradeNetPnlIdr: netPnlExcludingTopTrades(obs, 5),
      configFrozen: true,
      fillModelLabel: run.fillModel.label,
      portfolioConstraintsActive: true,
    });
    expect(run.fillModel.label).toBe('CANDLE_ONLY_OPTIMISTIC');
    expect(decision.checks.realisticFillModel).toBe(false);
    expect(decision.reasons).toContain('FILL_MODEL_IS_CANDLE_ONLY');
    expect(decision.eligible).toBe(false);
  });

  it('reports bootstrap lower bounds for pair, day and regime clusters', () => {
    for (const key of ['pair', 'day', 'regime'] as const) {
      const b = clusterBootstrap(obs, key, { resamples: 200, seed: 3 });
      expect(Number.isFinite(b.lower95Idr)).toBe(true);
      expect(b.lower95Idr).toBeLessThanOrEqual(b.upper95Idr);
    }
  });

  it('counts quote rejections instead of silently pricing from candles', () => {
    const quoted = simulatePortfolio(
      [{ ...pairs[0], quotes: [{ t: T0, bid: 999, ask: 1001 }] }],
      params,
      { initialCash: 10_000_000, fillModel: { ...DEFAULT_FILL_MODEL, label: 'QUOTE_BASED', maxQuoteAgeSec: 60 }, signal: buyEvery(6) },
    );
    const rejections = Object.values(quoted.quoteRejections).reduce((a, b) => a + b, 0);
    expect(rejections).toBeGreaterThan(0);
  });
});
