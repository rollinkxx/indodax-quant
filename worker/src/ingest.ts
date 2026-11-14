// Pure ingestion planning: detects every uncovered minute and validates official OHLC backfill.
import { aggregateCandles, ceilTo, compareTid, floorTo, tradesToCandles, type Candle, type Trade } from '../../shared/candles';

/** If INDODAX returns at least this many trades we assume the list is truncated (the oldest minute may be partial). */
export const TRUNCATION_THRESHOLD = 100;
export const BOOTSTRAP_SECONDS = 24 * 3600;

export interface CoveragePlan {
  nowMin: number;
  coverageStart: number; // first minute fully represented by the fetched trades
  historyRange: { from: number; to: number } | null; // one bounded range of 1m OHLC history to retrieve
}

export function planCoverage(trades: Trade[], coveredUntil: number | null, nowSec: number): CoveragePlan {
  const nowMin = floorTo(nowSec, 60);
  let coverageStart: number;
  if (trades.length === 0) {
    coverageStart = coveredUntil ?? nowMin;
  } else {
    const oldest = trades.reduce((m, t) => (t.ts < m ? t.ts : m), trades[0].ts);
    const truncated = trades.length >= TRUNCATION_THRESHOLD;
    coverageStart = truncated ? floorTo(oldest, 60) + 60 : floorTo(oldest, 60);
  }
  coverageStart = Math.min(coverageStart, nowMin);

  const floor = nowMin - BOOTSTRAP_SECONDS;
  const tradeMinutes = new Set(tradesToCandles(trades, 60, coverageStart, nowMin).map((c) => c.t));
  // Scan the whole bootstrap window on first sync, any saved gap, or the live
  // trade suffix. Only request OHLC when at least one minute is actually missing.
  const scanStart = coveredUntil === null ? floor : Math.max(coveredUntil, floor);
  let firstMissing: number | null = null;
  for (let t = scanStart; t < nowMin; t += 60) {
    if (!tradeMinutes.has(t)) {
      firstMissing = t;
      break;
    }
  }

  // Start on a 5m boundary so the first recovered 5m candle can be complete.
  const from = firstMissing === null ? null : floorTo(Math.max(firstMissing, floor), 300);
  const historyRange = from !== null && from < nowMin ? { from, to: nowMin } : null;
  return { nowMin, coverageStart, historyRange };
}


/**
 * Detect whether the persisted 5m series has enough uninterrupted, observed
 * bars for strategy warm-up. This also repairs legacy holes even when the old
 * covered_until cursor was incorrectly advanced past them.
 *
 * Returns the first 5m bucket that needs OHLC re-backfill, or null if the
 * latest completed candle is current and at least minCandles are contiguous.
 */
export function findCoverageRecoveryStart(candles: Candle[], nowSec: number, minCandles = 60): number | null {
  const expectedLast = floorTo(nowSec, 300) - 300;
  const rows = candles
    .filter((c) => c.t <= expectedLast)
    .slice()
    .sort((a, b) => a.t - b.t);
  if (rows.length === 0) {
    return floorTo(Math.max(nowSec - BOOTSTRAP_SECONDS, expectedLast - (minCandles + 12) * 300), 300);
  }

  const last = rows[rows.length - 1];
  let suffixStart = rows.length - 1;
  if (last.source === 'synthetic') {
    suffixStart = rows.length; // the latest bar is not an observed market candle
  } else {
    while (suffixStart > 0) {
      const current = rows[suffixStart];
      const previous = rows[suffixStart - 1];
      if (current.t - previous.t !== 300 || previous.source === 'synthetic') break;
      suffixStart--;
    }
  }

  const contiguous = rows.length - suffixStart;
  if (contiguous < minCandles) {
    if (suffixStart > 0) {
      const boundary = rows[suffixStart - 1];
      return floorTo(boundary.source === 'synthetic' ? boundary.t : boundary.t + 300, 300);
    }
    const missingBars = Math.max(1, minCandles - contiguous + 2);
    return floorTo(Math.max(nowSec - BOOTSTRAP_SECONDS, expectedLast - missingBars * 300), 300);
  }

  // A healthy historical suffix is still unusable if its tail stopped before the
  // latest completed 5m bucket (for example, an all-quiet pair).
  if (last.t < expectedLast) return floorTo(last.t + 300, 300);
  return null;
}

export interface PairBuild {
  m1: Candle[];
  m5: Candle[];
  newCoveredUntil: number | null;
  backfilled: number;
  historyComplete: boolean;
  missingMinutes: number;
}

/**
 * history === null means a requested backfill failed. The minute-indexed union
 * accepts a minute only when a direct trade candle or a valid official OHLC row
 * exists; missing rows never become fabricated flat/synthetic candles here.
 */
export function buildPairCandles(trades: Trade[], plan: CoveragePlan, coveredUntil: number | null, history: Candle[] | null): PairBuild {
  const m1Trades = tradesToCandles(trades, 60, plan.coverageStart, plan.nowMin);
  const historyM1 = plan.historyRange && history
    ? history.filter((c) => c.t >= plan.historyRange!.from && c.t < plan.historyRange!.to && c.t % 60 === 0)
    : [];

  const byMinute = new Map<number, Candle>();
  for (const c of historyM1) byMinute.set(c.t, c);
  // Actual trade-derived OHLCV is authoritative when the history endpoint overlaps.
  for (const c of m1Trades) byMinute.set(c.t, c);
  const m1 = [...byMinute.values()].sort((a, b) => a.t - b.t);

  let missingMinutes = 0;
  if (plan.historyRange) {
    for (let t = plan.historyRange.from; t < plan.historyRange.to; t += 60) {
      if (!byMinute.has(t)) missingMinutes++;
    }
  }
  const historyComplete = !plan.historyRange || (history !== null && missingMinutes === 0);
  const newCoveredUntil = historyComplete ? Math.max(coveredUntil ?? plan.nowMin, plan.nowMin) : coveredUntil;
  const aggregateStart = plan.historyRange && historyComplete
    ? plan.historyRange.from
    : ceilTo(plan.coverageStart, 300);
  const m5 = newCoveredUntil === null
    ? []
    : aggregateCandles(m1, 300, aggregateStart, floorTo(newCoveredUntil, 300));

  const tradeMinutes = new Set(m1Trades.map((c) => c.t));
  const backfilled = historyM1.filter((c) => !tradeMinutes.has(c.t)).length;
  return { m1, m5, newCoveredUntil, backfilled, historyComplete, missingMinutes };
}

/** Trades strictly newer than the last stored tid (dedupe before sending to the DB). */
export function newTradesSince(trades: Trade[], lastTid: string | null): Trade[] {
  if (!lastTid) return trades;
  return trades.filter((t) => compareTid(t.tid, lastTid) > 0);
}

export function newestTrade(trades: Trade[]): Trade | null {
  let best: Trade | null = null;
  for (const t of trades) if (!best || compareTid(t.tid, best.tid) > 0) best = t;
  return best;
}
