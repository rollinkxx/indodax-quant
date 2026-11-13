// Pure ingestion planning: decides which minutes are fully covered by trade data,
// which gaps need backfilling from the official OHLC history endpoint, and which candles to write.
import { aggregateCandles, ceilTo, compareTid, floorTo, tradesToCandles, type Candle, type Trade } from '../../shared/candles';

/** If INDODAX returns at least this many trades we assume the list is truncated (the oldest minute may be partial). */
export const TRUNCATION_THRESHOLD = 100;
export const BOOTSTRAP_SECONDS = 24 * 3600;

export interface CoveragePlan {
  nowMin: number;
  coverageStart: number; // first minute fully represented by the fetched trades
  gap: { from: number; to: number } | null; // minutes needing history backfill
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
  let gap: CoveragePlan['gap'] = null;
  if (coveredUntil === null) {
    gap = { from: floor, to: coverageStart };
  } else if (coveredUntil < coverageStart) {
    gap = { from: Math.max(coveredUntil, floor), to: coverageStart };
  }
  if (gap && gap.from >= gap.to) gap = null;
  return { nowMin, coverageStart, gap };
}

export interface PairBuild {
  m1: Candle[];
  m5: Candle[];
  newCoveredUntil: number | null;
  backfilled: number;
}

/**
 * history === null means the backfill was needed but failed: coverage does not advance,
 * so no 5m candle across the gap is treated as complete (and no signal can be produced from it).
 */
export function buildPairCandles(trades: Trade[], plan: CoveragePlan, coveredUntil: number | null, history: Candle[] | null): PairBuild {
  const m1Trades = tradesToCandles(trades, 60, plan.coverageStart, plan.nowMin);
  const backfillOk = plan.gap === null || history !== null;
  const historyM1 = plan.gap && history ? history.filter((c) => c.t >= plan.gap!.from && c.t < plan.gap!.to) : [];
  const newCoveredUntil = backfillOk ? plan.nowMin : coveredUntil;
  const memStart = plan.gap && backfillOk ? plan.gap.from : plan.coverageStart;
  const m1 = [...historyM1, ...m1Trades].sort((a, b) => a.t - b.t);
  const m5 = newCoveredUntil === null ? [] : aggregateCandles(m1, 300, ceilTo(memStart, 300), floorTo(newCoveredUntil, 300));
  return { m1, m5, newCoveredUntil, backfilled: historyM1.length };
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
