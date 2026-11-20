import { describe, expect, it } from 'vitest';
import {
  gapThroughStopFill, percentile, scenarioSpreadBps, simulateFill, syntheticQuoteFromCandle, quoteSpreadBps,
  type BookQuote,
} from '../shared/fillModel';

const NOW = 1_800_000_000;
const policy = { maxAgeSec: 180, maxClockSkewSec: 30 };
const quote = (over: Partial<BookQuote> = {}): BookQuote => ({ bid: 100, ask: 100.2, bidDepth: 1000, askDepth: 1000, serverTimeSec: NOW - 2, ...over });

describe('simulateFill', () => {
  it('fills a BUY at the ask plus slippage', () => {
    const r = simulateFill({ side: 'BUY', quote: quote(), requestedQty: 10, participationRate: 1, slippageBps: 10 }, NOW, policy);
    expect(r.rejected).toBe(false);
    expect(r.partial).toBe(false);
    expect(r.price).toBeCloseTo(100.2 * 1.001, 6);
    expect(r.filledQty).toBe(10);
  });

  it('fills a SELL at the bid minus slippage', () => {
    const r = simulateFill({ side: 'SELL', quote: quote(), requestedQty: 10, participationRate: 1, slippageBps: 10 }, NOW, policy);
    expect(r.price).toBeCloseTo(100 * 0.999, 6);
  });

  it('returns a partial fill capped by participation rate × depth', () => {
    const r = simulateFill({ side: 'BUY', quote: quote({ askDepth: 100 }), requestedQty: 500, participationRate: 0.5, slippageBps: 0 }, NOW, policy);
    expect(r.partial).toBe(true);
    expect(r.filledQty).toBe(50);
    expect(r.fillRatio).toBeCloseTo(0.1, 6);
  });

  it('rejects a stale quote', () => {
    const r = simulateFill({ side: 'BUY', quote: quote({ serverTimeSec: NOW - 500 }), requestedQty: 10, participationRate: 1, slippageBps: 0 }, NOW, policy);
    expect(r).toMatchObject({ rejected: true, reason: 'STALE_QUOTE' });
  });

  it('rejects a zero-depth book', () => {
    const r = simulateFill({ side: 'BUY', quote: quote({ askDepth: 0 }), requestedQty: 10, participationRate: 1, slippageBps: 0 }, NOW, policy);
    expect(r).toMatchObject({ rejected: true, reason: 'ZERO_DEPTH' });
  });

  it('rejects an order below the pair minimum notional', () => {
    const r = simulateFill({ side: 'BUY', quote: quote(), requestedQty: 1, participationRate: 1, slippageBps: 0, minNotional: 10_000 }, NOW, policy);
    expect(r).toMatchObject({ rejected: true, reason: 'BELOW_MIN_NOTIONAL' });
  });

  it('applies latency as an extra adverse move', () => {
    const noLatency = simulateFill({ side: 'BUY', quote: quote(), requestedQty: 10, participationRate: 1, slippageBps: 0 }, NOW, policy);
    const latency = simulateFill({ side: 'BUY', quote: quote(), requestedQty: 10, participationRate: 1, slippageBps: 0, latencySec: 2, adversePerSecondBps: 5 }, NOW, policy);
    expect(latency.price).toBeGreaterThan(noLatency.price);
  });
});

describe('gap-through-stop', () => {
  it('fills a SELL stop at the worse (lower) bid when it gaps below the stop', () => {
    expect(gapThroughStopFill(100, { bid: 95, ask: 95.2, bidDepth: 1, askDepth: 1, serverTimeSec: NOW }, 'SELL')).toBe(95);
  });
  it('never fills a SELL above the stop when the bid is better', () => {
    expect(gapThroughStopFill(100, { bid: 101, ask: 101.2, bidDepth: 1, askDepth: 1, serverTimeSec: NOW }, 'SELL')).toBe(100);
  });
});

describe('spread scenarios', () => {
  it('computes percentiles with linear interpolation', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([], 90)).toBe(0);
  });

  it('orders scenario spreads monotonically P50 ≤ P75 ≤ P90 ≤ P99', () => {
    const observed = Array.from({ length: 100 }, (_, i) => i + 1);
    const p50 = scenarioSpreadBps(observed, 'P50');
    const p75 = scenarioSpreadBps(observed, 'P75');
    const p90 = scenarioSpreadBps(observed, 'P90');
    const p99 = scenarioSpreadBps(observed, 'P99');
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p99);
  });

  it('applies a floor to the scenario spread', () => {
    expect(scenarioSpreadBps([], 'P99', 25)).toBe(25);
  });
});

describe('synthetic quote', () => {
  it('builds a two-sided quote around the close', () => {
    const q = syntheticQuoteFromCandle(100, 40, NOW, 500);
    expect(q).not.toBeNull();
    expect(quoteSpreadBps(q)).toBeCloseTo(40, 6);
    expect((q!.bid + q!.ask) / 2).toBeCloseTo(100, 8);
  });
  it('returns null for a non-positive close', () => {
    expect(syntheticQuoteFromCandle(0, 40, NOW, 500)).toBeNull();
  });
});
