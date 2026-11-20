// Dynamic universe: which INDODAX IDR pairs are monitored and analysed, chosen from the /api/summaries
// payload that the pipeline already fetches every minute (no extra API calls).
// Manually tracked pairs ("pinned") are always included; the remaining slots go to the most liquid pairs
// that pass the volume and spread filters. Hysteresis (buffer) and a cap on new entries per update keep churn
// and bootstrap cost (one OHLC backfill call per new pair) low.
import type { StrategyParams } from './strategy';

export interface UniverseTicker {
  pair_id: string;
  bid: number;
  ask: number;
  vol_idr: number | null;
  server_time: number;
}

export interface UniverseInput {
  tickers: UniverseTicker[];
  known: Set<string>; // pairs present in market_pairs (catalog), required by foreign keys
  maintenance: Set<string>;
  pinned: Set<string>; // is_tracked (manual)
  current: Set<string>; // current dynamic members (in_universe)
  nowSec: number;
  params: Pick<StrategyParams, 'universeMode' | 'universeSize' | 'universeMinVolumeIdr' | 'universeMaxSpreadPct' | 'universeBuffer' | 'universeMaxNewPerUpdate' | 'universeExclude'>;
  maxTickerAgeSec?: number;
}

export interface RankedPair {
  pair_id: string;
  rank: number; // 1 = highest 24h IDR volume among eligible, non-pinned pairs
  vol_idr: number;
  spread_pct: number;
}

export interface UniverseResult {
  members: RankedPair[]; // dynamic members (excluding pinned), best first
  added: string[];
  removed: string[];
  eligible: number;
  rejected: Record<string, number>;
}

export function spreadPct(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  return mid > 0 ? (ask - bid) / mid * 100 : Infinity;
}

export function selectUniverse(u: UniverseInput): UniverseResult {
  const p = u.params;
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  if (p.universeMode !== 'dynamic') {
    return { members: [], added: [], removed: [...u.current].sort(), eligible: 0, rejected };
  }
  const exclude = new Set(p.universeExclude);
  const maxAge = u.maxTickerAgeSec ?? 600;
  const eligible: Omit<RankedPair, 'rank'>[] = [];
  for (const t of u.tickers) {
    if (u.pinned.has(t.pair_id)) continue;
    if (!/^[a-z0-9]+idr$/.test(t.pair_id)) { reject('not_idr'); continue; }
    if (!u.known.has(t.pair_id)) { reject('not_in_catalog'); continue; }
    if (exclude.has(t.pair_id)) { reject('excluded'); continue; }
    if (u.maintenance.has(t.pair_id)) { reject('maintenance'); continue; }
    if (u.nowSec - t.server_time > maxAge) { reject('stale_ticker'); continue; }
    if (!(t.bid > 0) || !(t.ask >= t.bid)) { reject('bad_quote'); continue; }
    const vol = Number(t.vol_idr ?? 0);
    if (!(vol >= p.universeMinVolumeIdr)) { reject('low_volume'); continue; }
    const sp = spreadPct(t.bid, t.ask);
    if (sp > p.universeMaxSpreadPct) { reject('wide_spread'); continue; }
    eligible.push({ pair_id: t.pair_id, vol_idr: vol, spread_pct: sp });
  }
  const ranked: RankedPair[] = eligible
    .sort((a, b) => b.vol_idr - a.vol_idr || a.pair_id.localeCompare(b.pair_id))
    .map((e, i) => ({ ...e, rank: i + 1 }));

  const slots = Math.max(0, p.universeSize - u.pinned.size);
  // Hysteresis: current members stay while they rank within slots + buffer.
  const kept = ranked.filter((r) => u.current.has(r.pair_id) && r.rank <= slots + p.universeBuffer).slice(0, slots);
  const keptIds = new Set(kept.map((r) => r.pair_id));
  const fresh = ranked
    .filter((r) => !keptIds.has(r.pair_id))
    .slice(0, Math.max(0, Math.min(slots - kept.length, p.universeMaxNewPerUpdate)));
  const members = [...kept, ...fresh].sort((a, b) => a.rank - b.rank);
  const memberIds = new Set(members.map((m) => m.pair_id));
  return {
    members,
    added: fresh.map((r) => r.pair_id).sort(),
    removed: [...u.current].filter((id) => !memberIds.has(id)).sort(),
    eligible: ranked.length,
    rejected,
  };
}

/** Universe is re-evaluated every 15 minutes (and immediately when dynamic mode has no members yet). */
export function universeDue(nowSec: number, currentCount: number, mode: StrategyParams['universeMode'], everySec = 900): boolean {
  if (mode === 'manual') return currentCount > 0; // clear leftover members once after switching to manual
  if (currentCount === 0) return true;
  return Math.floor(nowSec / 60) * 60 % everySec === 0;
}

/** A universe membership interval in seconds: a pair is a member while `from <= t < to`. */
export interface UniverseInterval {
  from: number;
  /** Null = still a member at the end of the data. */
  to: number | null;
}

/**
 * Membership lookup for a timestamped universe.
 *
 * The backtest used to apply today's `in_universe` flag to the entire history, so a pair that became
 * liquid last week was tradable months earlier. With intervals the question becomes "was this pair a
 * member at time T?", which is the only answer that does not leak the future.
 */
export function memberAt(intervals: readonly UniverseInterval[] | undefined, t: number): boolean {
  if (!intervals || !intervals.length) return false;
  for (const iv of intervals) {
    if (t >= iv.from && (iv.to === null || t < iv.to)) return true;
  }
  return false;
}

/**
 * Normalize interval rows into sorted, merged, half-open ranges.
 *
 * Overlapping rows are merged rather than treated as an error: membership is a boolean, so two
 * overlapping intervals mean the same thing as their union. Rows with `from >= to` are dropped.
 */
export function normalizeIntervals(rows: readonly { from: number; to: number | null }[]): UniverseInterval[] {
  const clean = rows
    .filter((r) => Number.isFinite(r.from) && (r.to === null || Number.isFinite(r.to)))
    .filter((r) => r.to === null || r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const out: UniverseInterval[] = [];
  for (const r of clean) {
    const last = out[out.length - 1];
    if (last && (last.to === null || r.from <= last.to)) {
      if (last.to === null || r.to === null) last.to = null;
      else last.to = Math.max(last.to, r.to);
    } else {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}
