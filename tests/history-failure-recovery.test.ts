import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import { HttpError } from '../worker/src/http';
import {
  alignedSlots, classifyHistoryFailure, fetchSlotHistory, HISTORY_REQUEST_ATTEMPTS,
  HISTORY_SLOT_SECONDS, isSlotComplete, SlotCache,
} from '../scripts/history-cache';

const SLOT = HISTORY_SLOT_SECONDS;

const bar = (t: number): Candle =>
  ({ t, o: 100, h: 101, l: 99, c: 100.5, v: 1, n: 0, source: 'history' });

/** One bar per minute, `to` inclusive, exactly like the endpoint. */
function full(fromSec: number, toSec: number): Candle[] {
  const bars: Candle[] = [];
  for (let t = fromSec; t <= toSec; t += 60) bars.push(bar(t));
  return bars;
}

const http400 = (body = ''): HttpError => new HttpError('HTTP 400 for history_v2', 400, body);
const outOfBounds = (): HttpError => http400('{"error":"history_range_out_of_bounds"}');

let dir: string;
let cache: SlotCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iq-history-fail-'));
  cache = new SlotCache(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('classifyHistoryFailure', () => {
  it('separates a transient 4xx from an out-of-bounds window and from a fatal error', () => {
    expect(classifyHistoryFailure(outOfBounds())).toBe('out_of_bounds');
    expect(classifyHistoryFailure(http400('{"error":"upstream_hiccup"}'))).toBe('transient');
    expect(classifyHistoryFailure(http400())).toBe('transient');
    expect(classifyHistoryFailure(new HttpError('HTTP 429 for history_v2', 429))).toBe('transient');
    expect(classifyHistoryFailure(new HttpError('HTTP 502 for history_v2', 502))).toBe('transient');
    expect(classifyHistoryFailure(new HttpError('Timeout after 8000ms', 408))).toBe('transient');
    expect(classifyHistoryFailure(new TypeError('fetch failed'))).toBe('transient');

    // Retrying cannot fix these, and skipping the slot would report a pair as having no history.
    expect(classifyHistoryFailure(new HttpError('HTTP 401 for history_v2', 401))).toBe('fatal');
    expect(classifyHistoryFailure(new HttpError('HTTP 403 for history_v2', 403))).toBe('fatal');
    expect(classifyHistoryFailure(new Error('Invalid history payload for ETHIDR'))).toBe('fatal');
    expect(classifyHistoryFailure(new Error('invalid symbol ethidr'))).toBe('fatal');
  });
});

describe('fetchSlotHistory failure recovery', () => {
  it('retries a 400 that then succeeds, and caches the slots it eventually gets', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * 86_400, toSec);
    let calls = 0;
    const fetchBars = async (_symbol: string, fromSec: number, toSec2: number): Promise<Candle[]> => {
      calls++;
      // The exact shape the 90-day CI run died on, minus the transient part.
      if (calls === 1) throw http400('{"error":"history_range_out_of_bounds"}');
      return full(fromSec, toSec2);
    };
    const warnings: string[] = [];

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'ethidr', slots, toSec, cache, fetchBars,
      sleep: async () => {}, onWarning: (message) => warnings.push(message),
    });

    expect(calls).toBe(2);
    expect(stats.requests).toBe(2);
    expect(stats.retriedRequests).toBe(1);
    expect(stats.failedRequests).toBe(0);
    expect(stats.outOfBoundsSlots).toBe(0);
    expect(warnings[0]).toContain('retry 1/2');
    // The full window arrived and every complete slot was cached; only the growing slot is left.
    expect(bars).toHaveLength((toSec - slots[0]) / 60);
    expect(stats.cacheWrites).toBe(slots.length - 1);
    expect(stats.uncachedSlots).toBe(1);
    for (const slot of slots) {
      const stored = await cache.read('ethidr', slot);
      if (isSlotComplete(slot, toSec)) expect(stored).not.toBeNull();
      else expect(stored).toBeNull();
    }
  });

  it('completes as a partial fill when a request never succeeds, inventing and caching nothing', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * 86_400, toSec);
    let calls = 0;
    const fetchBars = async (): Promise<Candle[]> => {
      calls++;
      throw http400('{"error":"upstream_hiccup"}');
    };
    const warnings: string[] = [];

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'ethidr', slots, toSec, cache, fetchBars,
      sleep: async () => {}, onWarning: (message) => warnings.push(message),
    });

    // Bounded retries, then a partial fill: the run finishes instead of aborting.
    expect(calls).toBe(HISTORY_REQUEST_ATTEMPTS);
    expect(stats.requests).toBe(HISTORY_REQUEST_ATTEMPTS);
    expect(stats.retriedRequests).toBe(HISTORY_REQUEST_ATTEMPTS - 1);
    expect(stats.failedRequests).toBe(1);
    expect(stats.outOfBoundsSlots).toBe(0);
    expect(bars).toEqual([]);
    expect(stats.cacheWrites).toBe(0);
    expect(stats.uncachedSlots).toBe(slots.length);
    expect(warnings[warnings.length - 1]).toContain('partial fill');
    for (const slot of slots) expect(await cache.read('ethidr', slot)).toBeNull();
  });

  it('keeps the slots it could fetch and leaves only the failed request uncached', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * 86_400, toSec);
    const [s0, s1, s2] = slots;
    // Warm the middle slot so the plan splits into a failing head run and a healthy tail run.
    await cache.write('ethidr', s1, [bar(s1), bar(s1 + 60)]);

    const fetchBars = async (_symbol: string, fromSec: number, toSec2: number): Promise<Candle[]> => {
      if (fromSec === s0) throw http400('{"error":"upstream_hiccup"}');
      return full(fromSec, toSec2);
    };

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'ethidr', slots, toSec, cache, fetchBars,
      attempts: 2, sleep: async () => {},
    });

    expect(stats.failedRequests).toBe(1);
    expect(stats.cacheHits).toBe(1);
    // The cached slot and the healthy tail survive; the failed head is not cached.
    expect((await cache.read('ethidr', s1))![0].t).toBe(s1);
    expect(await cache.read('ethidr', s0)).toBeNull();
    expect(await cache.read('ethidr', s2)).not.toBeNull();
    expect(bars.map((b) => b.t)).not.toContain(s0);
    expect(bars.map((b) => b.t)).toContain(s2);
  });

  it('treats history_range_out_of_bounds as "no data this far back", not as an error', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - SLOT, toSec);
    const fetchBars = async (): Promise<Candle[]> => { throw outOfBounds(); };
    const warnings: string[] = [];

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'newidr', slots, toSec, cache, fetchBars,
      sleep: async () => {}, onWarning: (message) => warnings.push(message),
    });

    expect(bars).toEqual([]);
    expect(stats.failedRequests).toBe(0);
    expect(stats.outOfBoundsSlots).toBe(slots.length);
    expect(stats.cacheWrites).toBe(0);
    expect(warnings.join(' ')).toContain('no data this far back');
    for (const slot of slots) expect(await cache.read('newidr', slot)).toBeNull();
  });

  it('finds where a late-listed pair starts and caches every slot after it', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 4 * 86_400, toSec);
    const listedAt = slots[4];
    const calls: { fromSec: number; toSec: number }[] = [];
    const fetchBars = async (_symbol: string, fromSec: number, toSec2: number): Promise<Candle[]> => {
      calls.push({ fromSec, toSec: toSec2 });
      if (fromSec < listedAt) throw outOfBounds();
      return full(fromSec, toSec2);
    };

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'newidr', slots, toSec, cache, fetchBars, sleep: async () => {},
    });

    // Nothing before the listing, everything after it, and no invented bars in between.
    expect(bars[0].t).toBe(listedAt);
    expect(stats.failedRequests).toBe(0);
    expect(stats.outOfBoundsSlots).toBe(4);
    for (const slot of slots) {
      const stored = await cache.read('newidr', slot);
      if (slot >= listedAt && isSlotComplete(slot, toSec)) expect(stored).not.toBeNull();
      else expect(stored).toBeNull();
    }
    // The region with data is fetched in coalesced requests, not slot by slot.
    expect(calls.filter((call) => call.fromSec >= listedAt)).toHaveLength(2);
  });

  it('still fails the run when the relay is unauthorised', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - SLOT, toSec);
    const fetchBars = async (): Promise<Candle[]> => {
      throw new HttpError('HTTP 401 for history_v2', 401, 'unauthorized');
    };

    await expect(fetchSlotHistory({
      symbol: 'ethidr', slots, toSec, cache, fetchBars, sleep: async () => {},
    })).rejects.toThrow(/401/);
  });

  it('still fails the run when the payload is not OHLC at all', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - SLOT, toSec);
    const fetchBars = async (): Promise<Candle[]> => {
      throw new Error('Invalid history payload for ETHIDR');
    };

    await expect(fetchSlotHistory({
      symbol: 'ethidr', slots, toSec, cache, fetchBars, sleep: async () => {},
    })).rejects.toThrow(/Invalid history payload/);
  });
});
