// On-disk cache for the official 1-minute history the backtest pulls from INDODAX.
//
// Almost none of that data changes between runs, so it is cached per UTC-aligned 12-hour slot. Slots
// are aligned to the clock rather than to the sliding window, because a window-relative chunk boundary
// moves every run and would never hit.
//
// A slot is written only once it lies entirely inside the requested range: the newest slot is still
// growing, and caching a partial slot would freeze half a day of missing candles.
//
// Cost model this module is built around (measured against the public endpoint, 2026-11-21):
//   - one 12-hour slot = 720 one-minute bars, ~81 KB, 0.38-1.45 s round trip (median ~0.9 s);
//   - 180 days = 361 slots per pair (360 complete + the growing one), i.e. 7220 requests for 20
//     pairs, which at the 400 ms pace in backtest-history.ts is ~48 minutes of a cold run;
//   - the endpoint answers at most HISTORY_MAX_BARS_PER_REQUEST bars per call and silently returns
//     only the newest ones inside a wider window, so `planSlotRequests` coalesces whole slots into
//     requests that stay under that cap: 16 slots (192 h) per request, 23 requests per pair.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candle } from '../shared/candles';

export const HISTORY_SLOT_SECONDS = 12 * 60 * 60;

/**
 * Measured response cap of `/tradingview/history_v2?tf=1`: 12,961 one-minute bars (~9 days).
 * A wider request is not an error - the endpoint returns only the newest 12,961 bars that fall
 * inside the window, so a caller asking for more silently loses the oldest part of its range.
 */
export const HISTORY_MAX_BARS_PER_REQUEST = 12_961;

/**
 * Whole slots fetched per request: 16 x 12 h = 11,520 bars, ~89% of the measured cap, leaving room
 * for the extra bar the endpoint can return when it floors `from` to a minute boundary.
 */
export const HISTORY_SLOTS_PER_REQUEST = 16;

/** UTC-aligned slot starts covering [fromSec, toSec). */
export function alignedSlots(fromSec: number, toSec: number, slotSeconds = HISTORY_SLOT_SECONDS): number[] {
  if (!(slotSeconds > 0)) throw new Error('slotSeconds must be positive');
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) return [];
  const first = Math.floor(fromSec / slotSeconds) * slotSeconds;
  const slots: number[] = [];
  for (let s = first; s < toSec; s += slotSeconds) slots.push(s);
  return slots;
}

/** Only a slot that ended at or before the range end is immutable and therefore cacheable. */
export function isSlotComplete(slotStart: number, toSec: number, slotSeconds = HISTORY_SLOT_SECONDS): boolean {
  return slotStart + slotSeconds <= toSec;
}

/** The last minute a slot can contain that is closed by `toSec` (never the future). */
export function slotLastClosedMinute(slotStart: number, toSec: number, slotSeconds = HISTORY_SLOT_SECONDS): number {
  return Math.min(slotStart + slotSeconds, toSec) - 60;
}

/** One HTTP request covering one or more contiguous whole slots. */
export interface SlotRequest {
  fromSec: number;
  toSec: number;
  slots: number[];
}

/**
 * Group contiguous UTC-aligned slots into as few requests as the endpoint's response cap allows.
 *
 * The cache stays keyed by 12-hour slot; only the fetch is coalesced. `toSec` is the range end, so
 * the newest slot - still growing - gets a request that stops at the last closed minute instead of
 * reaching into the future. A gap in `slots` starts a new request, because a request can only
 * describe one contiguous window.
 */
export function planSlotRequests(
  slots: number[],
  toSec: number,
  slotSeconds = HISTORY_SLOT_SECONDS,
  maxSlotsPerRequest = HISTORY_SLOTS_PER_REQUEST,
): SlotRequest[] {
  if (!(slotSeconds > 0)) throw new Error('slotSeconds must be positive');
  if (!Number.isInteger(maxSlotsPerRequest) || maxSlotsPerRequest < 1) {
    throw new Error('maxSlotsPerRequest must be a positive integer');
  }
  if (!Number.isFinite(toSec)) throw new Error('toSec must be a finite number');

  // Never plan a request the endpoint would silently truncate.
  const capSlots = Math.max(1, Math.floor(HISTORY_MAX_BARS_PER_REQUEST / (slotSeconds / 60)));
  const perRequest = Math.min(maxSlotsPerRequest, capSlots);

  const requests: SlotRequest[] = [];
  let current: SlotRequest | null = null;

  for (const slot of slots) {
    const end = Math.min(slot + slotSeconds, toSec);
    if (!(end > slot)) continue;
    const previous: number | undefined = current ? current.slots[current.slots.length - 1] : undefined;
    const extendsCurrent = current !== null
      && previous !== undefined
      && slot === previous + slotSeconds
      && current.slots.length < perRequest;
    if (extendsCurrent) {
      current!.slots.push(slot);
      current!.toSec = end;
    } else {
      current = { fromSec: slot, toSec: end, slots: [slot] };
      requests.push(current);
    }
  }

  return requests;
}

/**
 * Partition a coalesced response into per-slot bar arrays. Bars outside the requested slots are
 * dropped: the endpoint floors `from` to a minute boundary and can answer with one bar before it.
 * `SlotCache.write` remains the validator, so a malformed bar is still an error rather than a
 * silent gap.
 */
export function splitSlotBars(
  bars: Candle[],
  request: SlotRequest,
  slotSeconds = HISTORY_SLOT_SECONDS,
): Map<number, Candle[]> {
  if (!(slotSeconds > 0)) throw new Error('slotSeconds must be positive');
  const bySlot = new Map<number, Candle[]>();
  for (const slot of request.slots) bySlot.set(slot, []);
  for (const bar of bars) {
    const slot = Math.floor(bar.t / slotSeconds) * slotSeconds;
    const bucket = bySlot.get(slot);
    if (!bucket || bar.t < request.fromSec || bar.t >= request.toSec) continue;
    bucket.push(bar);
  }
  for (const bucket of bySlot.values()) bucket.sort((a, b) => a.t - b.t);
  return bySlot;
}

export function isMinuteBar(value: unknown): value is Candle {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  const numeric = ['t', 'o', 'h', 'l', 'c', 'v'] as const;
  for (const key of numeric) {
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key] as number)) return false;
  }
  if ((b.t as number) % 60 !== 0) return false;
  if (b.n !== undefined && (typeof b.n !== 'number' || !Number.isFinite(b.n))) return false;
  if (b.source !== undefined && typeof b.source !== 'string') return false;
  return true;
}

export interface SlotCacheStats { hits: number; misses: number; writes: number }

export class SlotCache {
  private readonly stats: SlotCacheStats = { hits: 0, misses: 0, writes: 0 };

  constructor(private readonly dir: string | null) {}

  get enabled(): boolean {
    return this.dir !== null;
  }

  get counters(): SlotCacheStats {
    return { ...this.stats };
  }

  private path(symbol: string, slotStart: number): string {
    return join(this.dir!, `${symbol.toLowerCase()}-${slotStart}.json`);
  }

  /** Returns the cached bars for a slot, or null when absent or unusable (a miss simply refetches). */
  async read(symbol: string, slotStart: number, slotSeconds = HISTORY_SLOT_SECONDS): Promise<Candle[] | null> {
    if (!this.dir) return null;
    let raw: string;
    try {
      raw = await readFile(this.path(symbol, slotStart), 'utf8');
    } catch {
      this.stats.misses++;
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.stats.misses++;
      return null;
    }
    if (!Array.isArray(parsed)) { this.stats.misses++; return null; }
    const bars: Candle[] = [];
    for (const item of parsed) {
      if (!isMinuteBar(item)) { this.stats.misses++; return null; }
      const t = item.t;
      if (t < slotStart || t >= slotStart + slotSeconds) { this.stats.misses++; return null; }
      bars.push(item);
    }
    this.stats.hits++;
    return bars;
  }

  async write(symbol: string, slotStart: number, bars: Candle[]): Promise<void> {
    if (!this.dir) return;
    if (bars.some((b) => !isMinuteBar(b))) throw new Error('refusing to cache a malformed minute bar');
    await mkdir(this.dir, { recursive: true });
    const target = this.path(symbol, slotStart);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(bars), 'utf8');
    await rename(tmp, target);
    this.stats.writes++;
  }
}

export type TruncationReason = 'request_over_cap' | 'response_over_cap' | 'head_missing';

/**
 * Why a response cannot be a complete answer to its request, or null when it can.
 *
 * The endpoint never reports an over-wide window: it answers with the newest
 * `HISTORY_MAX_BARS_PER_REQUEST` bars inside it and drops the oldest part of the range. The dropped
 * head is what identifies that, and it is the only reliable signal - an illiquid pair legitimately
 * answers with fewer bars than the window has minutes (zero-volume minutes are still rows, but a
 * newly listed pair has none before its first trade), so a short count on its own is not truncation.
 *
 * A response is therefore complete only when it starts at the requested start (the endpoint floors
 * `from` to a minute and may answer one bar early, hence the 60 s tolerance) and stays under the cap.
 */
export function truncationReason(
  bars: Candle[],
  request: SlotRequest,
  slotSeconds = HISTORY_SLOT_SECONDS,
): TruncationReason | null {
  if (!(slotSeconds > 0)) throw new Error('slotSeconds must be positive');
  if (Math.round((request.toSec - request.fromSec) / 60) > HISTORY_MAX_BARS_PER_REQUEST) {
    return 'request_over_cap';
  }
  if (bars.length > HISTORY_MAX_BARS_PER_REQUEST) return 'response_over_cap';
  if (bars.length === 0) return null;
  let first = Number.POSITIVE_INFINITY;
  for (const bar of bars) if (bar.t < first) first = bar.t;
  return first > request.fromSec + 60 ? 'head_missing' : null;
}

/** Fetches one contiguous window of minute bars for `symbol`. Throws on transport failure. */
export type HistoryBarFetcher = (symbol: string, fromSec: number, toSec: number) => Promise<Candle[]>;

export interface SlotHistoryStats {
  /** HTTP requests issued, i.e. coalesced requests rather than slots. */
  requests: number;
  cacheHits: number;
  cacheWrites: number;
  /** Responses that dropped the head of their window (or breached the cap). */
  truncatedRequests: number;
  /** Slots that were fetched but deliberately not cached: growing, or not covered by the response. */
  uncachedSlots: number;
}

export interface FetchSlotHistoryOptions {
  symbol: string;
  /** UTC-aligned slot starts to cover, as returned by `alignedSlots`. */
  slots: number[];
  /** Range end: the newest slot stops here instead of reaching into the future. */
  toSec: number;
  cache: SlotCache;
  fetchBars: HistoryBarFetcher;
  slotSeconds?: number;
  onWarning?: (message: string) => void;
}

export interface SlotHistoryResult {
  bars: Candle[];
  stats: SlotHistoryStats;
}

/**
 * Read every slot from the cache, fetch the misses coalesced into as few requests as the endpoint's
 * response cap allows, and cache only slots the response provably covers in full.
 *
 * Coalescing changes nothing about the cache: the unit stays the 12-hour slot, a growing slot is still
 * never written, and a truncated response is treated as a partial fill - the slots it does not reach
 * from their first minute are left uncached so the next run refetches them instead of inheriting a
 * frozen hole. `planSlotRequests` keeps every request under the measured cap, so that path should not
 * trigger at all; when it does, `truncatedRequests` and the coverage metric surface it in the run log.
 */
export async function fetchSlotHistory(options: FetchSlotHistoryOptions): Promise<SlotHistoryResult> {
  const slotSeconds = options.slotSeconds ?? HISTORY_SLOT_SECONDS;
  const { symbol, toSec, cache, fetchBars, onWarning } = options;
  const bars: Candle[] = [];
  const stats: SlotHistoryStats = {
    requests: 0, cacheHits: 0, cacheWrites: 0, truncatedRequests: 0, uncachedSlots: 0,
  };

  for (const plan of planSlotRequests(options.slots, toSec, slotSeconds)) {
    const missing: number[] = [];
    for (const slot of plan.slots) {
      const cached = await cache.read(symbol, slot, slotSeconds);
      if (cached) {
        bars.push(...cached);
        stats.cacheHits++;
      } else {
        missing.push(slot);
      }
    }

    // A partly warm plan shrinks to the slots that actually missed: re-planning the misses keeps the
    // cap per request and starts a new request after a cached slot instead of refetching across it.
    for (const request of planSlotRequests(missing, toSec, slotSeconds)) {
      const fetched = await fetchBars(symbol, request.fromSec, request.toSec);
      stats.requests++;

      const reason = truncationReason(fetched, request, slotSeconds);
      if (reason) {
        stats.truncatedRequests++;
        onWarning?.(
          `${symbol} ${new Date(request.fromSec * 1000).toISOString()}..` +
          `${new Date(request.toSec * 1000).toISOString()}: ${reason}, got ${fetched.length} bars for ` +
          `${Math.round((request.toSec - request.fromSec) / 60)} requested minutes; using what arrived and ` +
          'refusing to cache the slots it does not cover',
        );
      }
      const capBreach = reason === 'request_over_cap' || reason === 'response_over_cap';
      const split = splitSlotBars(fetched, request, slotSeconds);
      let firstReturned = Number.POSITIVE_INFINITY;
      for (const bar of fetched) if (bar.t < firstReturned) firstReturned = bar.t;

      for (const slot of request.slots) {
        const slotBars = split.get(slot) ?? [];
        bars.push(...slotBars);
        const covered = !capBreach && (fetched.length === 0 || firstReturned <= slot);
        if (!isSlotComplete(slot, toSec, slotSeconds) || !covered) {
          stats.uncachedSlots++;
          continue;
        }
        if (!cache.enabled) continue;
        try {
          await cache.write(symbol, slot, slotBars);
          stats.cacheWrites++;
        } catch (e) {
          onWarning?.(`[HISTORY CACHE] ${symbol} ${slot}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  bars.sort((a, b) => a.t - b.t);
  return { bars, stats };
}
