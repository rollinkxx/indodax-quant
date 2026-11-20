// Execution fill model: quote-based fills with latency, participation, partial fills and depth.
//
// The candle-only backtest filled every order at the next candle open with no notion of how much
// size the book could absorb. That silently assumed infinite depth, zero latency and a full fill.
// This module makes each of those assumptions explicit and testable, so a run can report partial
// fills, rejected orders and a realistic spread instead of a best-case price.

import { normalizeOrder, type PairRules } from './orderNormalize';
import { assessQuote, spreadBpsOf, type QuotePolicy, type QuoteRejection } from './quote';

export interface BookQuote {
  bid: number;
  ask: number;
  /** Base-currency size resting at the touch (best bid / best ask). */
  bidDepth: number;
  askDepth: number;
  serverTimeSec: number;
}

export interface FillRequest {
  side: 'BUY' | 'SELL';
  quote: BookQuote | null | undefined;
  requestedQty: number;
  /** Fraction of resting depth we allow ourselves to consume (0–1). */
  participationRate: number;
  /** Adverse price move applied per side, in basis points. */
  slippageBps: number;
  /** Extra adverse drift per second of latency, in basis points (market moves while we send). */
  adversePerSecondBps?: number;
  latencySec?: number;
  /** When set, a fill below this notional is rejected (exchange minimum). */
  minNotional?: number | null;
  rules?: PairRules;
}

export type FillRejection = QuoteRejection | 'BELOW_MIN_NOTIONAL' | 'ZERO_DEPTH' | 'ZERO_QTY';

export interface FillResult {
  filledQty: number;
  price: number;
  notional: number;
  partial: boolean;
  rejected: boolean;
  reason?: FillRejection;
  /** Fraction of the requested quantity that actually filled (0–1). */
  fillRatio: number;
}

const reject = (reason: FillRejection, price = 0): FillResult => ({
  filledQty: 0, price, notional: 0, partial: false, rejected: true, reason, fillRatio: 0,
});

/**
 * Simulate a market order against one quote.
 *
 * - The quote must be fresh and two-sided (see `assessQuote`); otherwise the order is rejected.
 * - Latency moves the price against us before the fill.
 * - The fill is capped at `participationRate` of the resting depth, so a thin book returns a partial fill.
 * - The resulting quantity is normalized to the pair's step and minimum notional.
 */
export function simulateFill(req: FillRequest, nowSec: number, policy: QuotePolicy): FillResult {
  const assessment = assessQuote(req.quote ?? null, nowSec, policy);
  if (!assessment.ok) return reject(assessment.reason ?? 'INVALID_QUOTE');
  const quote = req.quote as BookQuote;

  const depth = req.side === 'BUY' ? quote.askDepth : quote.bidDepth;
  if (!(depth > 0)) return reject('ZERO_DEPTH');
  const participation = Number.isFinite(req.participationRate) && req.participationRate > 0 ? Math.min(1, req.participationRate) : 1;
  const capacity = depth * participation;
  const fillQty = Math.min(req.requestedQty, capacity);
  if (!(fillQty > 0)) return reject('ZERO_QTY');

  const latencySec = Number.isFinite(req.latencySec) && (req.latencySec as number) > 0 ? (req.latencySec as number) : 0;
  const driftBps = (Number.isFinite(req.adversePerSecondBps) ? (req.adversePerSecondBps as number) : 0) * latencySec;
  const touch = req.side === 'BUY' ? quote.ask : quote.bid;
  // BUY pays up, SELL gives up: both moves are adverse by construction.
  const direction = req.side === 'BUY' ? 1 : -1;
  const totalBps = (Number.isFinite(req.slippageBps) ? req.slippageBps : 0) + driftBps;
  const rawPrice = touch * (1 + direction * totalBps / 10_000);

  const rules: PairRules = req.rules ?? { pricePrecision: null, minNotional: req.minNotional ?? null };
  const minNotional = req.minNotional !== undefined ? req.minNotional : rules.minNotional;
  const normalized = normalizeOrder({ qty: fillQty, price: rawPrice, rules: { ...rules, minNotional: minNotional ?? null } });
  if (!normalized.ok) return reject(normalized.reason === 'below_min_notional' ? 'BELOW_MIN_NOTIONAL' : 'ZERO_QTY', rawPrice);

  const partial = normalized.qty < req.requestedQty - 1e-9;
  return {
    filledQty: normalized.qty,
    price: normalized.price,
    notional: normalized.notional,
    partial,
    rejected: false,
    fillRatio: req.requestedQty > 0 ? normalized.qty / req.requestedQty : 0,
  };
}

/**
 * Fill price when a protective stop gaps through: the exit fills at the quote touch (or worse), never
 * at the stop level itself, so a gap-through-stop loss is not understated.
 */
export function gapThroughStopFill(stopPrice: number, quote: BookQuote, side: 'BUY' | 'SELL', slippageBps = 0): number {
  if (!(stopPrice > 0)) return 0;
  const touch = side === 'SELL' ? quote.bid : quote.ask;
  if (!(touch > 0)) return stopPrice;
  const slipped = touch * (1 + (side === 'BUY' ? 1 : -1) * slippageBps / 10_000);
  // SELL: if the bid has fallen through the stop, fill at the worse (lower) bid.
  if (side === 'SELL') return Math.min(stopPrice, slipped);
  return Math.max(stopPrice, slipped);
}

/** Spread in bps for a quote, or null when the quote is not two-sided. */
export function quoteSpreadBps(quote: Pick<BookQuote, 'bid' | 'ask'> | null | undefined): number | null {
  if (!quote) return null;
  return spreadBpsOf(quote.bid, quote.ask);
}

export type SpreadScenario = 'P50' | 'P75' | 'P90' | 'P99';
export const SPREAD_SCENARIOS: SpreadScenario[] = ['P50', 'P75', 'P90', 'P99'];

/** Percentile (linear interpolation) of a numeric sample; 0 when the sample is empty. */
export function percentile(values: readonly number[], pct: number): number {
  if (!values.length) return 0;
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const clamped = Math.min(100, Math.max(0, pct));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export const SCENARIO_PERCENTILE: Record<SpreadScenario, number> = { P50: 50, P75: 75, P90: 90, P99: 99 };

/** Conservative spread (bps) for a scenario from observed spreads; falls back to a floor. */
export function scenarioSpreadBps(observed: readonly number[], scenario: SpreadScenario, floorBps = 0): number {
  const p = percentile(observed, SCENARIO_PERCENTILE[scenario]);
  return Math.max(floorBps, p);
}

/**
 * When no historical quote exists, derive a two-sided synthetic quote from a candle close and a
 * spread assumption. This is the CANDLE_ONLY_OPTIMISTIC path: it is labelled as such by callers.
 */
export function syntheticQuoteFromCandle(close: number, spreadBps: number, serverTimeSec: number, depth: number): BookQuote | null {
  if (!(close > 0) || !Number.isFinite(close)) return null;
  const half = Math.max(0, spreadBps) / 10_000 / 2;
  return {
    bid: close * (1 - half),
    ask: close * (1 + half),
    bidDepth: depth,
    askDepth: depth,
    serverTimeSec,
  };
}
