// Quote freshness and valuation health.
//
// A price is only usable when it is a real two-sided quote that is recent and not dated in the
// future. The pipeline used to accept any ticker with a positive bid/ask and only bounded its age
// from above, so a clock-skewed or stale quote could pass a risk check. Every consumer that decides
// whether the portfolio is healthy must go through this module, so "stale" can never be mistaken
// for "flat" or "safe".

export interface RawQuote {
  bid: number;
  ask: number;
  /** Exchange-reported quote time, unix seconds. */
  serverTimeSec: number;
}

export interface QuotePolicy {
  /** A quote older than this many seconds is stale. */
  maxAgeSec: number;
  /** A quote more than this many seconds in the future is rejected (clock skew). */
  maxClockSkewSec?: number;
}

export type QuoteRejection = 'INVALID_QUOTE' | 'STALE_QUOTE' | 'FUTURE_DATED_QUOTE' | 'MISSING_QUOTE';

export interface QuoteAssessment {
  ok: boolean;
  reason?: QuoteRejection;
  ageSec: number | null;
  /** (ask - bid) / mid, in basis points. Null when the quote is invalid. */
  spreadBps: number | null;
  mid: number | null;
}

export const DEFAULT_MAX_CLOCK_SKEW_SEC = 30;

export function spreadBpsOf(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid * 10_000 : null;
}

/**
 * Validate a quote against a freshness policy. Order matters: a crossed/invalid quote is rejected
 * before its age is considered, and a future-dated quote is reported as skew, not as staleness, so
 * the operator can tell the two failure modes apart.
 */
export function assessQuote(quote: RawQuote | null | undefined, nowSec: number, policy: QuotePolicy): QuoteAssessment {
  if (!quote) return { ok: false, reason: 'MISSING_QUOTE', ageSec: null, spreadBps: null, mid: null };
  const { bid, ask, serverTimeSec } = quote;
  if (!(bid > 0) || !(ask > 0) || ask < bid || !Number.isFinite(serverTimeSec)) {
    return { ok: false, reason: 'INVALID_QUOTE', ageSec: null, spreadBps: null, mid: null };
  }
  const mid = (bid + ask) / 2;
  const spreadBps = spreadBpsOf(bid, ask);
  if (!Number.isFinite(nowSec)) return { ok: false, reason: 'INVALID_QUOTE', ageSec: null, spreadBps, mid };
  const ageSec = nowSec - serverTimeSec;
  const skew = Number.isFinite(policy.maxClockSkewSec) ? Math.max(0, policy.maxClockSkewSec as number) : DEFAULT_MAX_CLOCK_SKEW_SEC;
  if (ageSec < -skew) return { ok: false, reason: 'FUTURE_DATED_QUOTE', ageSec, spreadBps, mid };
  if (ageSec > policy.maxAgeSec) return { ok: false, reason: 'STALE_QUOTE', ageSec, spreadBps, mid };
  return { ok: true, ageSec, spreadBps, mid };
}

export type ValuationStatus = 'KNOWN' | 'UNKNOWN';

export interface ValuationHealth {
  status: ValuationStatus;
  /** Pairs whose open position could not be valued from a fresh quote. */
  unpricedPairs: string[];
  /** True when the portfolio cannot be valued, so new entries must be blocked. */
  blockEntries: boolean;
}

/**
 * Whether the portfolio can be valued right now. A single open position without a fresh quote makes
 * the whole equity figure unverifiable, so the status is UNKNOWN and new entries must be blocked:
 * sizing against a stale mark is how an account silently over-leverages.
 */
export function valuationHealth(openPairs: readonly string[], freshQuotePairs: ReadonlySet<string>): ValuationHealth {
  const unpricedPairs = [...new Set(openPairs)].filter((pair) => !freshQuotePairs.has(pair)).sort();
  const status: ValuationStatus = unpricedPairs.length === 0 ? 'KNOWN' : 'UNKNOWN';
  return { status, unpricedPairs, blockEntries: status === 'UNKNOWN' };
}

export type KillSwitchState = 'RUNNING' | 'KILL_ARMED' | 'KILLED_NOT_FLAT' | 'KILLED_FLAT' | 'KILL_CLOSE_FAILED';

export interface KillSwitchStateInput {
  /** Account status as stored (`RUNNING` | `STOPPED` | `KILLED`). */
  status: string;
  killSwitch: boolean;
  /** Positions still open after the close attempt. */
  openPositions: number;
  /** Positions the close attempt could not close. */
  closeFailures?: number;
}

/**
 * Explicit kill-switch lifecycle. `KILLED_FLAT` is the only safe terminal state; anything with an
 * open position must be reported as not flat, and a failed close gets its own state so an operator
 * can see that the account is locked but still exposed.
 */
export function killSwitchState(i: KillSwitchStateInput): KillSwitchState {
  const open = Number.isFinite(i.openPositions) ? Math.max(0, i.openPositions) : 0;
  const failures = Number.isFinite(i.closeFailures) ? Math.max(0, i.closeFailures as number) : 0;
  const armed = i.killSwitch || i.status === 'KILLED';
  if (!armed) return i.status === 'RUNNING' ? 'RUNNING' : 'KILL_ARMED';
  if (failures > 0) return 'KILL_CLOSE_FAILED';
  return open > 0 ? 'KILLED_NOT_FLAT' : 'KILLED_FLAT';
}
