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
  const scanStart = coveredUntil === null
    ? floor
    : coveredUntil < coverageStart
      ? Math.max(coveredUntil, floor)
      : Math.max(coverageStart, floor);
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
  const newCoveredUntil = historyComplete ? plan.nowMin : coveredUntil;
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
