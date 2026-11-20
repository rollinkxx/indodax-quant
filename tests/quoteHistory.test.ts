import { describe, expect, it } from 'vitest';
import {
  indexQuotes, isValidQuote, lastQuoteAtOrBefore, observedSpreads, quoteFillPrice, spreadBpsOf,
  type QuotePoint,
} from '../shared/quoteHistory';

const T = 1_800_000_000;
const q = (t: number, bid: number, ask: number): QuotePoint => ({ t, bid, ask });

describe('quote validity', () => {
  it('accepts a normal two-sided quote', () => {
    expect(isValidQuote(100, 100.2)).toBe(true);
  });
  it('rejects crossed, zero and non-finite quotes', () => {
    expect(isValidQuote(101, 100)).toBe(false);
    expect(isValidQuote(0, 100)).toBe(false);
    expect(isValidQuote(100, 0)).toBe(false);
    expect(isValidQuote(Number.NaN, 100)).toBe(false);
  });
  it('computes spread in bps of the mid', () => {
    expect(spreadBpsOf(100, 100.2)).toBeCloseTo(0.2 / 100.1 * 10_000, 6);
    expect(spreadBpsOf(0, 100)).toBeNull();
  });
});

describe('quote history indexing', () => {
  it('sorts by time and keeps the last write for a duplicate timestamp', () => {
    const idx = indexQuotes([q(T + 60, 1, 2), q(T, 10, 11), q(T, 12, 13)]);
    expect(idx.map((x) => x.t)).toEqual([T, T + 60]);
    expect(idx[0]).toMatchObject({ bid: 12, ask: 13 });
  });
});

describe('lastQuoteAtOrBefore', () => {
  const series = indexQuotes([q(T, 100, 100.2), q(T + 60, 101, 101.2), q(T + 120, 102, 102.2)]);

  it('picks the most recent quote at or before the signal time', () => {
    const r = lastQuoteAtOrBefore(series, T + 90, 180);
    expect(r).toMatchObject({ ok: true, bid: 101, ask: 101.2, t: T + 60, ageSec: 30 });
  });

  it('uses a quote exactly at the signal time', () => {
    expect(lastQuoteAtOrBefore(series, T + 60, 180)).toMatchObject({ ok: true, t: T + 60, ageSec: 0 });
  });

  it('never looks forward to a later quote', () => {
    const r = lastQuoteAtOrBefore(series, T + 30, 180);
    expect(r.t).toBe(T);
  });

  it('rejects when no quote precedes the signal time', () => {
    expect(lastQuoteAtOrBefore(series, T - 1, 180)).toMatchObject({ ok: false, reason: 'MISSING_HISTORICAL_QUOTE' });
  });

  it('rejects a stale quote past the maximum age', () => {
    expect(lastQuoteAtOrBefore(series, T + 1000, 180)).toMatchObject({ ok: false, reason: 'STALE_HISTORICAL_QUOTE' });
  });

  it('rejects an invalid stored quote', () => {
    const bad = indexQuotes([q(T, 101, 100)]);
    expect(lastQuoteAtOrBefore(bad, T, 180)).toMatchObject({ ok: false, reason: 'INVALID_QUOTE' });
  });

  it('rejects an empty history', () => {
    expect(lastQuoteAtOrBefore([], T, 180)).toMatchObject({ ok: false, reason: 'MISSING_HISTORICAL_QUOTE' });
  });
});

describe('quote fills', () => {
  it('buys at the ask plus slippage and sells at the bid minus slippage', () => {
    expect(quoteFillPrice({ bid: 100, ask: 100.2 }, 'BUY', 10)).toBeCloseTo(100.2 * 1.001, 8);
    expect(quoteFillPrice({ bid: 100, ask: 100.2 }, 'SELL', 10)).toBeCloseTo(100 * 0.999, 8);
  });
  it('treats a negative slippage as zero rather than a discount', () => {
    expect(quoteFillPrice({ bid: 100, ask: 100.2 }, 'BUY', -50)).toBeCloseTo(100.2, 8);
  });
});

describe('observed spreads', () => {
  it('collects only valid quotes', () => {
    const s = observedSpreads([q(T, 100, 100.2), q(T + 60, 0, 5), q(T + 120, 200, 200)]);
    expect(s).toHaveLength(2);
    expect(s[1]).toBe(0);
  });
});
