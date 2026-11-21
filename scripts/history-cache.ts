// On-disk cache for the official 1-minute history the backtest pulls from INDODAX.
//
// The evaluation used to spend ~12 minutes per run in the rate limiter: 20 pairs x 60 twelve-hour
// chunks, one request start every 500 ms. Almost none of that data changes between runs, so it is
// cached per UTC-aligned 12-hour slot. Slots are aligned to the clock rather than to the sliding
// 30-day window, because a window-relative chunk boundary moves every run and would never hit.
//
// A slot is written only once it lies entirely inside the requested range: the newest slot is still
// growing, and caching a partial slot would freeze half a day of missing candles.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candle } from '../shared/candles';

export const HISTORY_SLOT_SECONDS = 12 * 60 * 60;

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
