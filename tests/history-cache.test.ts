import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  alignedSlots, HISTORY_MAX_BARS_PER_REQUEST, HISTORY_SLOTS_PER_REQUEST, HISTORY_SLOT_SECONDS, isMinuteBar,
  isSlotComplete, planSlotRequests, SlotCache, slotLastClosedMinute, splitSlotBars,
} from '../scripts/history-cache';
import { aggregateCompleteMinuteHistory, HISTORY_REQUEST_START_INTERVAL_MS } from '../scripts/backtest-history';

const SLOT = HISTORY_SLOT_SECONDS; // 43200

const bar = (t: number, patch: Partial<Candle> = {}): Candle =>
  ({ t, o: 100, h: 101, l: 99, c: 100.5, v: 1, n: 0, source: 'history', ...patch });

describe('alignedSlots', () => {
  it('aligns to the UTC 12h grid instead of the window start', () => {
    // 30-day window ending at an arbitrary 5-minute mark.
    const toSec = 1_700_000_100;
    const fromSec = toSec - 30 * 86_400;
    const slots = alignedSlots(fromSec, toSec);

    expect(slots[0] % SLOT).toBe(0);
    expect(slots[0]).toBeLessThanOrEqual(fromSec);
    expect(slots[0] + SLOT).toBeGreaterThan(fromSec);
    expect(slots[slots.length - 1]).toBeLessThan(toSec);
    expect(slots.length).toBeGreaterThanOrEqual(60);
  });

  it('produces the same interior slots for two runs one day apart', () => {
    const toA = 1_700_000_100;
    const toB = toA + 86_400;
    const a = new Set(alignedSlots(toA - 30 * 86_400, toA));
    const b = alignedSlots(toB - 30 * 86_400, toB);
    // Everything but the two newest slots is shared, which is what makes the cache hit at all.
    const shared = b.filter((s) => a.has(s));
    expect(shared.length).toBe(b.length - 2);
  });

  it('returns nothing for an empty or inverted range', () => {
    expect(alignedSlots(1000, 1000)).toEqual([]);
    expect(alignedSlots(2000, 1000)).toEqual([]);
  });
});

describe('slot completeness', () => {
  it('only treats a slot that ended at or before the range end as cacheable', () => {
    expect(isSlotComplete(0, SLOT)).toBe(true);
    expect(isSlotComplete(0, SLOT - 1)).toBe(false);
  });

  it('never reads past the range end or into the future', () => {
    expect(slotLastClosedMinute(0, SLOT + 1000)).toBe(SLOT - 60);
    expect(slotLastClosedMinute(0, 600)).toBe(540);
  });
});

describe('isMinuteBar', () => {
  it('accepts a well-formed minute bar', () => {
    expect(isMinuteBar(bar(0))).toBe(true);
  });

  it('rejects non-minute, NaN and non-object values', () => {
    expect(isMinuteBar(bar(90))).toBe(false);
    expect(isMinuteBar({ ...bar(0), c: Number.NaN })).toBe(false);
    expect(isMinuteBar(null)).toBe(false);
    expect(isMinuteBar('x')).toBe(false);
  });
});

describe('SlotCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iq-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when no directory is configured', async () => {
    const cache = new SlotCache(null);
    expect(cache.enabled).toBe(false);
    await cache.write('btcidr', 0, [bar(0)]);
    expect(await cache.read('btcidr', 0)).toBeNull();
    expect(cache.counters).toEqual({ hits: 0, misses: 0, writes: 0 });
  });

  it('round-trips a slot and reports the hit', async () => {
    const cache = new SlotCache(dir);
    await cache.write('btcidr', 0, [bar(0), bar(60)]);
    expect(await cache.read('btcidr', 0)).toEqual([bar(0), bar(60)]);
    expect(cache.counters).toMatchObject({ hits: 1, writes: 1 });
  });

  it('keeps pairs and slots apart', async () => {
    const cache = new SlotCache(dir);
    await cache.write('btcidr', 0, [bar(0)]);
    await cache.write('btcidr', SLOT, [bar(SLOT)]);
    await cache.write('ethidr', 0, [bar(120)]);
    expect((await cache.read('btcidr', SLOT))![0].t).toBe(SLOT);
    expect((await cache.read('ethidr', 0))![0].t).toBe(120);
    expect(await cache.read('usdtidr', 0)).toBeNull();
  });

  it('caches an empty slot, because a quiet pair must not be refetched forever', async () => {
    const cache = new SlotCache(dir);
    await cache.write('thinidr', 0, []);
    expect(await cache.read('thinidr', 0)).toEqual([]);
    expect(cache.counters.hits).toBe(1);
  });

  it('treats a corrupt file as a miss so the caller refetches', async () => {
    const cache = new SlotCache(dir);
    await writeFile(join(dir, 'btcidr-0.json'), '{not json', 'utf8');
    expect(await cache.read('btcidr', 0)).toBeNull();
    expect(cache.counters.misses).toBe(1);
  });

  it('rejects a cached bar outside its slot, so a mis-keyed file cannot poison the range', async () => {
    const cache = new SlotCache(dir);
    await writeFile(join(dir, `btcidr-0.json`), JSON.stringify([bar(SLOT * 3)]), 'utf8');
    expect(await cache.read('btcidr', 0)).toBeNull();
  });

  it('refuses to write a malformed bar', async () => {
    const cache = new SlotCache(dir);
    await expect(cache.write('btcidr', 0, [bar(90)])).rejects.toThrow(/malformed/);
  });

  it('leaves no temp files behind', async () => {
    const cache = new SlotCache(dir);
    await cache.write('btcidr', 0, [bar(0)]);
    const files = await readdir(dir);
    expect(files).toEqual(['btcidr-0.json']);
  });
});

describe('slot-aligned fetch is equivalent to the old window-relative chunking', () => {
  // The refactor replaced `fromSec + k*12h` chunks with UTC-aligned slots. Both fetch a superset of
  // [fromSec, toSec); `aggregateCompleteMinuteHistory` trims to the range, so the 5m output must be
  // byte-identical. This is the one regression the change could plausibly introduce.
  const SLOT = HISTORY_SLOT_SECONDS;

  /** One minute bar per minute over `spanSec`, starting at `startSec`. */
  function series(startSec: number, spanSec: number): Candle[] {
    const out: Candle[] = [];
    for (let t = startSec; t < startSec + spanSec; t += 60) {
      const n = (t / 60) % 97;
      out.push({ t, o: 100 + n, h: 101 + n, l: 99 + n, c: 100.5 + n, v: 1 + (n % 5), n: 1, source: 'history' });
    }
    return out;
  }

  /** Old behaviour: chunks anchored to the sliding window start. */
  function oldChunkUnion(bars: Candle[], fromSec: number, toSec: number): Candle[] {
    const picked: Candle[] = [];
    for (let from = fromSec; from < toSec; from += SLOT) {
      const endExclusive = Math.min(from + SLOT, toSec);
      const lastClosed = endExclusive - 60;
      if (lastClosed < from) continue;
      picked.push(...bars.filter((b) => b.t >= from && b.t <= lastClosed));
    }
    return picked;
  }

  /** New behaviour: whole UTC-aligned slots. */
  function newSlotUnion(bars: Candle[], fromSec: number, toSec: number): Candle[] {
    const picked: Candle[] = [];
    for (const slotStart of alignedSlots(fromSec, toSec, SLOT)) {
      const lastClosed = slotLastClosedMinute(slotStart, toSec, SLOT);
      if (lastClosed < slotStart) continue;
      picked.push(...bars.filter((b) => b.t >= slotStart && b.t <= lastClosed));
    }
    return picked;
  }

  it('produces identical 5m bars for window ends anywhere in a slot', () => {
    const days = 2;
    for (let shift = 0; shift < SLOT; shift += 300 * 7) {
      const toSec = 1_700_000_100 + shift;
      const fromSec = toSec - days * 86_400;
      const bars = series(fromSec - 2 * SLOT, days * 86_400 + 4 * SLOT);

      const a = aggregateCompleteMinuteHistory(oldChunkUnion(bars, fromSec, toSec), fromSec, toSec);
      const b = aggregateCompleteMinuteHistory(newSlotUnion(bars, fromSec, toSec), fromSec, toSec);

      expect(b.map((c) => c.t)).toEqual(a.map((c) => c.t));
      expect(b).toEqual(a);
    }
  });

  it('keeps the first and last 5m bar inside the requested range', () => {
    const toSec = 1_700_000_100;
    const fromSec = toSec - 86_400;
    const bars = series(fromSec - SLOT, 3 * SLOT);
    const out = aggregateCompleteMinuteHistory(newSlotUnion(bars, fromSec, toSec), fromSec, toSec);

    expect(out[0].t).toBeGreaterThanOrEqual(fromSec);
    expect(out[out.length - 1].t + 300).toBeLessThanOrEqual(toSec);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('planSlotRequests', () => {
  // A 180-day window ending on a 5-minute mark that is not also a 12h boundary: 360 whole slots plus
  // the 12h slot the window ends inside.
  const TO_SEC = 1_784_995_200;

  it('plans a 180-day window into 23 requests per pair instead of 361', () => {
    const slots = alignedSlots(TO_SEC - 180 * 86_400, TO_SEC);
    expect(slots).toHaveLength(361);

    const requests = planSlotRequests(slots, TO_SEC);
    expect(requests).toHaveLength(23);
    // Nothing is dropped or duplicated by the coalescing.
    expect(requests.flatMap((r) => r.slots)).toEqual(slots);
    // Every request stays inside the measured response cap of the endpoint.
    for (const request of requests) {
      expect(request.slots.length).toBeLessThanOrEqual(HISTORY_SLOTS_PER_REQUEST);
      expect((request.toSec - request.fromSec) / 60).toBeLessThanOrEqual(HISTORY_MAX_BARS_PER_REQUEST);
    }
    expect((requests[0].toSec - requests[0].fromSec) / 60).toBe(16 * 720);
  });

  it('clamps the growing slot to the range end instead of reaching into the future', () => {
    const slots = alignedSlots(TO_SEC - 2 * SLOT, TO_SEC);
    const requests = planSlotRequests(slots, TO_SEC);
    expect(requests).toHaveLength(1);
    expect(requests[0].slots).toEqual(slots);
    // The newest slot is still growing: its request stops at the last closed minute.
    expect(requests[0].toSec).toBe(TO_SEC);
    expect(slotLastClosedMinute(slots[slots.length - 1], TO_SEC)).toBe(TO_SEC - 60);
    // The older slot still runs to its own 12h boundary.
    expect(slotLastClosedMinute(slots[0], TO_SEC)).toBe(slots[0] + SLOT - 60);
  });

  it('starts a new request after a gap, because a request is one contiguous window', () => {
    const requests = planSlotRequests([0, SLOT, 4 * SLOT], 5 * SLOT);
    expect(requests.map((r) => r.slots)).toEqual([[0, SLOT], [4 * SLOT]]);
    expect(requests[1].fromSec).toBe(4 * SLOT);
  });

  it('skips slots that start at or after the range end', () => {
    expect(planSlotRequests([0, SLOT], SLOT)).toHaveLength(1);
    expect(planSlotRequests([SLOT], SLOT)).toEqual([]);
  });

  it('never plans a request the endpoint would truncate, even for a coarser slot', () => {
    // A 24h slot is 1,440 bars, so the 12,961-bar cap allows only 9 of them per request.
    const day = 24 * 60 * 60;
    const slots = alignedSlots(TO_SEC - 30 * day, TO_SEC, day);
    const requests = planSlotRequests(slots, TO_SEC, day);
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(request.slots.length).toBeLessThanOrEqual(9);
      expect((request.toSec - request.fromSec) / 60).toBeLessThanOrEqual(HISTORY_MAX_BARS_PER_REQUEST);
    }
  });

  it('rejects nonsensical inputs', () => {
    expect(() => planSlotRequests([0], 0, 0)).toThrow('slotSeconds must be positive');
    expect(() => planSlotRequests([0], 0, SLOT, 0)).toThrow('positive integer');
    expect(() => planSlotRequests([0], Number.NaN)).toThrow('finite');
  });
});

describe('splitSlotBars', () => {
  it('partitions a coalesced response per slot and drops bars outside the request', () => {
    const request = { fromSec: 0, toSec: 2 * SLOT, slots: [0, SLOT] };
    // The endpoint floors `from` to a minute boundary and may answer one bar early.
    const bars = [bar(-60), bar(0), bar(60), bar(SLOT), bar(SLOT + 60), bar(2 * SLOT)];

    const split = splitSlotBars(bars, request);
    expect([...split.keys()]).toEqual([0, SLOT]);
    expect(split.get(0)!.map((b) => b.t)).toEqual([0, 60]);
    expect(split.get(SLOT)!.map((b) => b.t)).toEqual([SLOT, SLOT + 60]);
  });

  it('sorts a response that arrives out of order', () => {
    const split = splitSlotBars([bar(SLOT + 60), bar(SLOT)], { fromSec: SLOT, toSec: 2 * SLOT, slots: [SLOT] });
    expect(split.get(SLOT)!.map((b) => b.t)).toEqual([SLOT, SLOT + 60]);
  });

  it('feeds the slot cache so a coalesced fetch warms every complete slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iq-cache-'));
    try {
      const cache = new SlotCache(dir);
      const slots = alignedSlots(1_700_000_100 - 2 * SLOT, 1_700_000_100);
      const request = planSlotRequests(slots, 1_700_000_100)[0];
      const bars: Candle[] = [];
      for (let t = request.fromSec; t < request.toSec; t += 60) bars.push(bar(t));

      const split = splitSlotBars(bars, request);
      for (const [slot, slotBars] of split) {
        if (isSlotComplete(slot, 1_700_000_100)) await cache.write('btcidr', slot, slotBars);
      }

      for (const slot of slots) {
        const cached = await cache.read('btcidr', slot);
        if (isSlotComplete(slot, 1_700_000_100)) {
          expect(cached).not.toBeNull();
          expect(cached![0].t).toBe(slot);
          expect(cached!.every((b) => b.t >= slot && b.t < slot + SLOT)).toBe(true);
        } else {
          // A still-growing slot is never written, so it is refetched on the next run.
          expect(cached).toBeNull();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('180-day request budget', () => {
  const TO_SEC = 1_784_995_200;
  const PAIRS = 20;

  it('costs 7220 requests per-slot and 460 coalesced, at the documented quota pace', () => {
    const slots = alignedSlots(TO_SEC - 180 * 86_400, TO_SEC);
    const perSlot = slots.length * PAIRS;
    const coalesced = planSlotRequests(slots, TO_SEC).length * PAIRS;
    const seconds = (requests: number): number => Math.round(requests * HISTORY_REQUEST_START_INTERVAL_MS / 1000);

    expect(slots).toHaveLength(361);
    expect(perSlot).toBe(7_220);
    expect(coalesced).toBe(460);
    // 400 ms per start: 48 min cold one slot at a time, 3 min cold coalesced, 8 s warm.
    expect(seconds(perSlot)).toBe(2_888);
    expect(seconds(coalesced)).toBe(184);
    expect(seconds(PAIRS)).toBe(8);
    // All three stay below the documented 180 req/min quota, with the 30 req/min margin intact.
    expect(60_000 / HISTORY_REQUEST_START_INTERVAL_MS).toBe(150);
  });
});
