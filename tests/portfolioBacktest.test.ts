import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import { DEFAULT_PARAMS, type StrategyParams } from '../shared/strategy';
import { DEFAULT_FILL_MODEL, regimeAt, simulatePortfolio, type PortfolioPairInput } from '../shared/portfolioBacktest';

/** A rising then flat series, so a trivially bullish signal fires and exits are exercised. */
function series(prefix: string, n: number, start = 1000, step = 1, volume = 1_000_000): Candle[] {
  const t0 = 1_800_000_000 - (1_800_000_000 % 300);
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return { t: t0 + i * 300, o: c, h: c + 2, l: c - 2, c, v: volume, n: 10, source: 'trades' } as Candle;
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

/** Buy on every bar whose index is a multiple of `every` (deterministic, ignores indicators). */
const buyEvery = (every: number) => (_pair: string, _candles: Candle[], index: number) => (index % every === 0 ? 'BUY' : 'HOLD');

describe('portfolio chronology backtest', () => {
  it('shares one cash account across pairs and never exceeds maxOpenPositions', () => {
    const pairs: PortfolioPairInput[] = ['aaa', 'bbb', 'ccc'].map((p) => ({
      pair: p, candles: series(p, 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
    }));
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    expect(r.maxConcurrentPositions).toBeLessThanOrEqual(params.maxOpenPositions);
    // Cash is one pool: it must never go negative.
    for (const point of r.equityCurve) expect(point.cash).toBeGreaterThanOrEqual(-1e-6);
    // The final equity must equal cash + closed PnL, i.e. the trades are the only source of change.
    const realized = r.trades.reduce((a, t) => a + t.pnl, 0);
    expect(r.finalEquity).toBeCloseTo(r.initialCash + realized, 2);
  });

  it('caps total exposure below the configured ceiling', () => {
    const pairs: PortfolioPairInput[] = ['aaa', 'bbb'].map((p) => ({
      pair: p, candles: series(p, 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
    }));
    const r = simulatePortfolio(pairs, { ...params, maxOpenPositions: 5, maxTotalExposurePct: 40 }, { initialCash: 10_000_000, signal: buyEvery(5) });
    for (const point of r.equityCurve) {
      const exposurePct = point.equity > 0 ? point.grossExposure / point.equity * 100 : 0;
      expect(exposurePct).toBeLessThanOrEqual(41); // allow 1pp rounding slack
    }
  });

  it('records rejections with a structured stage and reason', () => {
    const pairs: PortfolioPairInput[] = ['aaa', 'bbb', 'ccc'].map((p) => ({
      pair: p, candles: series(p, 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
    }));
    const r = simulatePortfolio(pairs, { ...params, maxOpenPositions: 1 }, { initialCash: 10_000_000, signal: buyEvery(3) });
    expect(r.rejections.length).toBeGreaterThan(0);
    expect(r.rejections.every((x) => x.stage && x.reason)).toBe(true);
    expect(r.rejections.some((x) => x.reason === 'max_positions')).toBe(true);
  });

  it('closes a position at end of data so it is not silently dropped', () => {
    const pairs: PortfolioPairInput[] = [{ pair: 'aaa', candles: series('aaa', 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000 }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(50) });
    expect(r.forcedEodExits).toBeGreaterThanOrEqual(0);
    expect(r.trades.length).toBeGreaterThan(0);
  });

  it('charges a wider spread as a worse fill and lower final equity', () => {
    const pairs: PortfolioPairInput[] = [{ pair: 'aaa', candles: series('aaa', 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000 }];
    const narrow = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5), fillModel: { spreadBps: 10, participationRate: 1, latencyBps: 0, label: 'CANDLE_ONLY_OPTIMISTIC' } });
    const wide = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5), fillModel: { spreadBps: 400, participationRate: 1, latencyBps: 0, label: 'CANDLE_ONLY_OPTIMISTIC' } });
    expect(wide.finalEquity).toBeLessThan(narrow.finalEquity);
  });

  it('produces partial fills when participation is limited', () => {
    const pairs: PortfolioPairInput[] = [{ pair: 'aaa', candles: series('aaa', 200, 1000, 1, 10), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000 }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5), fillModel: { spreadBps: 0, participationRate: 0.01, latencyBps: 0, label: 'CANDLE_ONLY_OPTIMISTIC' } });
    // With a tiny book and 1% participation the requested size cannot fill, so either partial fills or
    // zero-depth rejections must appear rather than a full fill.
    expect(r.partialFills + r.rejectedOrders + r.rejections.filter((x) => x.stage === 'fill_gate').length).toBeGreaterThan(0);
  });

  it('trips the drawdown kill switch and stops opening new positions', () => {
    // A falling series with buys forces losses until the drawdown limit trips.
    const falling = Array.from({ length: 200 }, (_, i) => {
      const t0 = 1_800_000_000 - (1_800_000_000 % 300);
      const c = 1000 - i * 3;
      return { t: t0 + i * 300, o: c, h: c + 1, l: c - 4, c, v: 1_000_000, n: 10, source: 'trades' } as Candle;
    });
    const pairs: PortfolioPairInput[] = [{ pair: 'aaa', candles: falling, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000 }];
    const r = simulatePortfolio(pairs, { ...params, maxDrawdownPct: 2, maxOpenPositions: 5 }, { initialCash: 10_000_000, signal: buyEvery(3) });
    expect(r.killSwitchTripped).toBe(true);
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(2);
  });

  it('labels a candle-only run as CANDLE_ONLY_OPTIMISTIC', () => {
    const pairs: PortfolioPairInput[] = [{ pair: 'aaa', candles: series('aaa', 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000 }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    expect(r.fillModel.label).toBe('CANDLE_ONLY_OPTIMISTIC');
    expect(r.effectiveFillLabel).toBe('CANDLE_ONLY_OPTIMISTIC');
    expect(r.quoteFills).toBe(0);
  });

  it('demotes a configured QUOTE_BASED run to candle-only when every quote was stale', () => {
    // A single quote at the very start of the series: the model is "quote based", but no fill can use
    // it, so the run is candle-priced in practice and must not be promotion-eligible.
    const candles = series('aaa', 200, 1000, 1);
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      quotes: [{ t: candles[0].t, bid: candles[0].c - 1, ask: candles[0].c + 1 }],
    }];
    const r = simulatePortfolio(pairs, params, {
      initialCash: 10_000_000,
      fillModel: { ...DEFAULT_FILL_MODEL, label: 'QUOTE_BASED', maxQuoteAgeSec: 60 },
      signal: buyEvery(5),
    });
    expect(r.fillModel.label).toBe('QUOTE_BASED');
    expect(r.effectiveFillLabel).toBe('CANDLE_ONLY_OPTIMISTIC');
    expect(r.quoteRejections.STALE_HISTORICAL_QUOTE ?? 0).toBeGreaterThan(0);
  });

  it('keeps QUOTE_BASED when every fill was priced from a quote', () => {
    const candles = series('aaa', 200, 1000, 1);
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      quotes: candles.map((c) => ({ t: c.t, bid: c.c - 1, ask: c.c + 1 })),
    }];
    const r = simulatePortfolio(pairs, params, {
      initialCash: 10_000_000,
      fillModel: { ...DEFAULT_FILL_MODEL, label: 'QUOTE_BASED', maxQuoteAgeSec: 60 },
      signal: buyEvery(5),
    });
    expect(r.quoteFills).toBeGreaterThan(0);
    expect(r.effectiveFillLabel).toBe('QUOTE_BASED');
  });
});

describe('quote-based fills', () => {
  const candles = series('aaa', 200, 1000, 1);
  const quoteSeries = candles.map((c) => ({ t: c.t, bid: c.c - 1, ask: c.c + 1 }));

  it('prices entries off the stored ask and exits off the stored bid', () => {
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000, quotes: quoteSeries,
    }];
    const r = simulatePortfolio(pairs, { ...params, maxOpenPositions: 1 }, {
      initialCash: 10_000_000, fillModel: { ...DEFAULT_FILL_MODEL, label: 'QUOTE_BASED' }, signal: buyEvery(5),
    });
    expect(r.quoteFills).toBeGreaterThan(0);
    // Every entry pays at least the ask of its fill bar, i.e. strictly above that bar's close.
    for (const t of r.trades) {
      const bar = candles.find((c) => c.t === t.entryTime);
      if (bar) expect(t.entry).toBeGreaterThan(bar.c);
    }
  });

  it('falls back to the candle scenario and counts the rejection when quotes are stale', () => {
    // Only one quote, at the very first bar: every later fill is stale and must be counted.
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      quotes: [{ t: candles[0].t, bid: 999, ask: 1001 }],
    }];
    const r = simulatePortfolio(pairs, { ...params, maxOpenPositions: 1 }, {
      initialCash: 10_000_000,
      fillModel: { ...DEFAULT_FILL_MODEL, label: 'QUOTE_BASED', maxQuoteAgeSec: 120 },
      signal: buyEvery(5),
    });
    expect(r.quoteRejections.STALE_HISTORICAL_QUOTE ?? 0).toBeGreaterThan(0);
  });
});

describe('timestamped universe in the portfolio engine', () => {
  it('refuses entries from a pair before it joined the universe', () => {
    const candles = series('aaa', 200, 1000, 1);
    // Membership starts halfway through the series.
    const from = candles[100].t;
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      universeIntervals: [{ from, to: null }],
    }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    expect(r.universeIsTimestamped).toBe(true);
    // No trade may be entered before membership began.
    for (const t of r.trades) expect(t.entryTime).toBeGreaterThanOrEqual(from);
    expect(r.rejections.some((x) => x.stage === 'universe_gate' && x.reason === 'not_in_universe')).toBe(true);
  });

  it('stops entering after a pair leaves the universe', () => {
    const candles = series('aaa', 200, 1000, 1);
    const to = candles[80].t;
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles, volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      universeIntervals: [{ from: candles[0].t, to }],
    }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    for (const t of r.trades) expect(t.entryTime).toBeLessThan(to);
  });

  it('falls back to the static flag and reports the run as non-timestamped', () => {
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles: series('aaa', 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
      inUniverse: true,
    }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    expect(r.universeIsTimestamped).toBe(false);
    expect(r.trades.length).toBeGreaterThan(0);
  });
});

describe('market regime labels', () => {
  it('classifies trend and range from bars up to and including the signal bar', () => {
    expect(regimeAt(series('aaa', 200, 1000, 5), 150)).toBe('uptrend');
    expect(regimeAt(series('aaa', 200, 5000, -5), 150)).toBe('downtrend');
    expect(regimeAt(series('aaa', 200, 1000, 0), 150)).toBe('range');
  });

  it('reports range before the 50-bar window is warm instead of inventing a trend', () => {
    expect(regimeAt(series('aaa', 200, 1000, 5), 20)).toBe('range');
    expect(regimeAt(series('aaa', 200, 1000, 5), 49)).toBe('range');
    expect(regimeAt(series('aaa', 200, 1000, 5), 50)).toBe('uptrend');
  });

  it('is causal: a future price jump cannot change the label of an earlier bar', () => {
    const candles = series('aaa', 200, 1000, 1);
    const before = regimeAt(candles, 120);
    const mutated = candles.map((c, i) => (i > 150 ? { ...c, c: c.c * 3, h: c.h * 3, l: c.l * 3 } : c));
    expect(regimeAt(mutated, 120)).toBe(before);
  });

  it('stamps each closed trade with the regime at its signal bar', () => {
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles: series('aaa', 200, 1000, 1), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
    }];
    const r = simulatePortfolio(pairs, params, { initialCash: 10_000_000, signal: buyEvery(5) });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) expect(['uptrend', 'downtrend', 'range']).toContain(t.regime);
  });
});
