// Historical quote lookup for the backtest fill model.
//
// The pipeline has always written bid/ask to `market_tickers` every minute, but the backtest ignored
// them and filled at the next candle's open. This module turns that stored history into the quote the
// audit's fill model asks for: the last quote at or before the signal time, rejected when it is
// missing, stale, or invalid. Without a usable quote the caller must fall back to a labelled
// candle-only scenario, never to a silent candle fill.

export interface QuotePoint {
  /** Quote capture time (seconds). */
  t: number;
  bid: number;
  ask: number;
}

export type QuoteRejection = 'MISSING_HISTORICAL_QUOTE' | 'STALE_HISTORICAL_QUOTE' | 'INVALID_QUOTE';

export interface QuoteLookup {
  ok: boolean;
  bid: number;
  ask: number;
  t: number;
  ageSec: number;
  spreadBps: number;
  reason?: QuoteRejection;
}

/** Spread of a quote in basis points of the mid. Null when the quote is not usable. */
export function spreadBpsOf(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid * 10_000 : null;
}

/** True when a quote can price an order at all (positive, non-crossed). */
export function isValidQuote(bid: number, ask: number): boolean {
  return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
}

/**
 * Index a pair's quote history for binary-search lookup. Quotes must be sorted by time; duplicate
 * timestamps keep the last one written, which is the one the pipeline would have read.
 */
export function indexQuotes(points: readonly QuotePoint[]): QuotePoint[] {
  const sorted = [...points].filter((q) => Number.isFinite(q.t)).sort((a, b) => a.t - b.t);
  const out: QuotePoint[] = [];
  for (const q of sorted) {
    if (out.length && out[out.length - 1].t === q.t) out[out.length - 1] = q;
    else out.push(q);
  }
  return out;
}

/**
 * The last quote at or before `atSec`, validated against the maximum acceptable age.
 *
 * A quote strictly after `atSec` is never used: doing so would price a signal with information the
 * strategy could not have had at decision time.
 */
export function lastQuoteAtOrBefore(
  quotes: readonly QuotePoint[],
  atSec: number,
  maxAgeSec: number,
): QuoteLookup {
  const fail = (reason: QuoteRejection): QuoteLookup => ({
    ok: false, bid: 0, ask: 0, t: 0, ageSec: Number.POSITIVE_INFINITY, spreadBps: 0, reason,
  });
  if (!quotes.length) return fail('MISSING_HISTORICAL_QUOTE');
  let lo = 0;
  let hi = quotes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (quotes[mid].t <= atSec) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return fail('MISSING_HISTORICAL_QUOTE');
  const q = quotes[found];
  const ageSec = atSec - q.t;
  if (!isValidQuote(q.bid, q.ask)) return fail('INVALID_QUOTE');
  if (ageSec > maxAgeSec) return { ...fail('STALE_HISTORICAL_QUOTE'), t: q.t, ageSec };
  const spread = spreadBpsOf(q.bid, q.ask);
  if (spread === null) return fail('INVALID_QUOTE');
  return { ok: true, bid: q.bid, ask: q.ask, t: q.t, ageSec, spreadBps: spread };
}

/**
 * Fill price for an order against a historical quote: pay the ask plus slippage on entry, receive the
 * bid minus slippage on exit. Both are normalized to the pair's tick size by the caller.
 */
export function quoteFillPrice(
  quote: Pick<QuotePoint, 'bid' | 'ask'>,
  side: 'BUY' | 'SELL',
  slippageBps: number,
): number {
  const slip = Math.max(0, Number.isFinite(slippageBps) ? slippageBps : 0) / 10_000;
  return side === 'BUY' ? quote.ask * (1 + slip) : quote.bid * (1 - slip);
}

/** Observed spreads (bps) from a quote series, used to build P50/P75/P90/P99 scenarios. */
export function observedSpreads(quotes: readonly QuotePoint[]): number[] {
  const out: number[] = [];
  for (const q of quotes) {
    const s = spreadBpsOf(q.bid, q.ask);
    if (s !== null) out.push(s);
  }
  return out;
}
