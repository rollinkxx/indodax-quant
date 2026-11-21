import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  alignedSlots, fetchSlotHistory, HISTORY_MAX_BARS_PER_REQUEST, HISTORY_SLOTS_PER_REQUEST,
  HISTORY_SLOT_SECONDS, isSlotComplete, SlotCache, slotLastClosedMinute, truncationReason,
  type SlotRequest,
} from '../scripts/history-cache';
import { aggregateCompleteMinuteHistory } from '../scripts/backtest-history';

const SLOT = HISTORY_SLOT_SECONDS;

const bar = (t: number): Candle =>
  ({ t, o: 100, h: 101, l: 99, c: 100.5, v: 1, n: 0, source: 'history' });

interface ExchangeCall { symbol: string; fromSec: number; toSec: number }

/**
 * Serves one bar per minute of every requested window and records the calls. `to` is inclusive, as the
 * public endpoint's is (verified: a request ending at T answers with a bar at T). `keepNewest`
 * reproduces the measured silent truncation - the newest 12,961 bars of a wider window, head dropped.
 */
function exchange(options: { keepNewest?: number } = {}) {
  const calls: ExchangeCall[] = [];
  const fetchBars = async (symbol: string, fromSec: number, toSec: number): Promise<Candle[]> => {
    calls.push({ symbol, fromSec, toSec });
    const bars: Candle[] = [];
    for (let t = fromSec; t <= toSec; t += 60) bars.push(bar(t));
    return options.keepNewest === undefined ? bars : bars.slice(-options.keepNewest);
  };
  return { calls, fetchBars };
}

let dir: string;
let cache: SlotCache;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iq-coalesce-'));
  cache = new SlotCache(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('truncationReason', () => {
  const request: SlotRequest = { fromSec: 0, toSec: 2 * SLOT, slots: [0, SLOT] };

  it('accepts a response that starts at the requested start', () => {
    expect(truncationReason([bar(0), bar(60)], request)).toBeNull();
    // The endpoint floors `from` to a minute and may answer one bar early.
    expect(truncationReason([bar(-60), bar(0)], request)).toBeNull();
  });

  it('flags a newest-suffix response, which is what a silent truncation looks like', () => {
    expect(truncationReason([bar(60 * 600), bar(60 * 601)], request)).toBe('head_missing');
  });

  it('does not call a quiet pair truncated, because its head is present', () => {
    expect(truncationReason([bar(0), bar(2 * SLOT - 60)], request)).toBeNull();
    expect(truncationReason([], request)).toBeNull();
  });

  it('flags a request or a response beyond the measured cap', () => {
    const wide: SlotRequest = { fromSec: 0, toSec: HISTORY_MAX_BARS_PER_REQUEST * 60 + 60, slots: [0] };
    expect(truncationReason([bar(0)], wide)).toBe('request_over_cap');

    const full = Array.from({ length: HISTORY_MAX_BARS_PER_REQUEST + 1 }, (_, i) => bar(i * 60));
    expect(truncationReason(full, request)).toBe('response_over_cap');
  });

  it('rejects a nonsensical slot length', () => {
    expect(() => truncationReason([], request, 0)).toThrow('slotSeconds must be positive');
  });
});

describe('fetchSlotHistory', () => {
  it('covers a 180-day window in 23 requests per pair instead of 361', async () => {
    const toSec = 1_784_995_200;
    const slots = alignedSlots(toSec - 180 * 86_400, toSec);
    expect(slots).toHaveLength(361);

    const market = exchange();
    const { bars, stats } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache: new SlotCache(null), fetchBars: market.fetchBars,
    });

    expect(stats.requests).toBe(23);
    expect(market.calls).toHaveLength(23);
    for (const call of market.calls) {
      expect((call.toSec - call.fromSec) / 60).toBeLessThanOrEqual(HISTORY_MAX_BARS_PER_REQUEST);
      expect((call.toSec - call.fromSec) / SLOT).toBeLessThanOrEqual(HISTORY_SLOTS_PER_REQUEST);
    }
    // Coalescing loses nothing: every minute of the covered range arrives exactly once, in order.
    const expectedBars = (toSec - slots[0]) / 60;
    expect(bars).toHaveLength(expectedBars);
    expect(new Set(bars.map((b) => b.t)).size).toBe(expectedBars);
    expect(bars[0].t).toBe(slots[0]);
    expect(bars[bars.length - 1].t).toBe(toSec - 60);
  });

  it('warms every complete slot and refetches only the growing one on the next run', async () => {
    const toSec = 1_700_000_100; // inside a slot, so the newest slot is still growing
    const slots = alignedSlots(toSec - 2 * 86_400, toSec);
    const growing = slots[slots.length - 1];
    expect(isSlotComplete(growing, toSec)).toBe(false);

    const first = exchange();
    const run1 = await fetchSlotHistory({ symbol: 'btcidr', slots, toSec, cache, fetchBars: first.fetchBars });
    expect(run1.stats.requests).toBe(1);
    expect(run1.stats.cacheWrites).toBe(slots.length - 1);
    expect(await cache.read('btcidr', growing)).toBeNull();

    const second = exchange();
    const run2 = await fetchSlotHistory({ symbol: 'btcidr', slots, toSec, cache, fetchBars: second.fetchBars });
    expect(run2.stats.cacheHits).toBe(slots.length - 1);
    expect(second.calls).toEqual([{ symbol: 'btcidr', fromSec: growing, toSec }]);
    expect(run2.bars.map((b) => b.t)).toEqual(run1.bars.map((b) => b.t));
  });

  it('fetches only the slots that missed, splitting the request around a cached slot', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * 86_400, toSec);
    const [s0, s1, s2] = slots;
    await cache.write('btcidr', s1, [bar(s1), bar(s1 + 60)]);

    const market = exchange();
    const { stats } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache, fetchBars: market.fetchBars,
    });

    expect(stats.cacheHits).toBe(1);
    expect(market.calls).toEqual([
      { symbol: 'btcidr', fromSec: s0, toSec: s0 + SLOT },
      { symbol: 'btcidr', fromSec: s2, toSec },
    ]);
  });

  it('treats a silently truncated response as a partial fill and caches none of the dropped slots', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 4 * 86_400, toSec);
    // Enough to cover the tail of the window, so the cut lands inside an interior slot.
    const keep = 3_000;
    const market = exchange({ keepNewest: keep });
    const warnings: string[] = [];

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache, fetchBars: market.fetchBars,
      onWarning: (message) => warnings.push(message),
    });

    // One coalesced request, recognised as truncated, and the bars it did return are still used.
    expect(stats.requests).toBe(1);
    expect(stats.truncatedRequests).toBe(1);
    expect(warnings[0]).toContain('head_missing');
    // The newest bar of the truncated response sits on the inclusive request end, so it is out of
    // range and dropped: `keep` returned, `keep - 1` usable.
    expect(bars).toHaveLength(keep - 1);
    const cut = bars[0].t;
    expect(cut).toBe(toSec - (keep - 1) * 60);

    // The slots the response never reached from their first minute are left uncached, so the next run
    // refetches them instead of inheriting a frozen hole; the slots it did cover are cached.
    let cached = 0;
    for (const slot of slots) {
      const stored = await cache.read('btcidr', slot);
      if (isSlotComplete(slot, toSec) && slot >= cut) {
        expect(stored).not.toBeNull();
        expect(stored![0].t).toBe(slot);
        cached++;
      } else {
        expect(stored).toBeNull();
      }
    }
    expect(cached).toBeGreaterThan(0);
    expect(stats.uncachedSlots).toBe(slots.length - cached);
  });

  it('caches nothing when the truncation leaves less than a single slot', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 86_400, toSec);
    const market = exchange({ keepNewest: 500 });
    const warnings: string[] = [];

    const { bars, stats } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache, fetchBars: market.fetchBars,
      onWarning: (message) => warnings.push(message),
    });

    expect(bars).toHaveLength(499);
    expect(stats.truncatedRequests).toBe(1);
    expect(stats.cacheWrites).toBe(0);
    expect(warnings).toHaveLength(1);
    for (const slot of slots) expect(await cache.read('btcidr', slot)).toBeNull();
  });

  it('aggregates to the same 5m candles as fetching one slot at a time', async () => {
    const toSec = 1_700_000_100;
    const fromSec = toSec - 3 * 86_400;
    const slots = alignedSlots(fromSec, toSec);

    const coalesced = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache: new SlotCache(null), fetchBars: exchange().fetchBars,
    });

    // The pre-coalescing loop: one request per slot, ending at that slot's last closed minute.
    const perSlot: Candle[] = [];
    const reference = exchange();
    for (const slot of slots) {
      const lastClosed = slotLastClosedMinute(slot, toSec);
      if (lastClosed < slot) continue;
      perSlot.push(...await reference.fetchBars('btcidr', slot, lastClosed));
    }

    expect(reference.calls).toHaveLength(slots.length);
    const expected = aggregateCompleteMinuteHistory(perSlot, fromSec, toSec);
    expect(aggregateCompleteMinuteHistory(coalesced.bars, fromSec, toSec)).toEqual(expected);
    // The window is fully covered: every 5m bucket of [fromSec, toSec) is complete.
    expect(expected).toHaveLength(Math.floor((toSec - fromSec) / 300));
  });

  it('caches an empty response for a quiet pair', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * SLOT, toSec);
    const quiet = async (): Promise<Candle[]> => [];

    const { stats } = await fetchSlotHistory({ symbol: 'thinidr', slots, toSec, cache, fetchBars: quiet });
    expect(stats.truncatedRequests).toBe(0);
    expect(await cache.read('thinidr', slots[0])).toEqual([]);
  });

  it('refetches a slot whose cache file is corrupt or mis-keyed', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 86_400, toSec);
    const [s0, s1] = slots;
    await writeFile(join(dir, `btcidr-${s0}.json`), '{not json', 'utf8');
    await writeFile(join(dir, `btcidr-${s1}.json`), JSON.stringify([bar(s1 + 3 * SLOT)]), 'utf8');

    const market = exchange();
    const { stats } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache, fetchBars: market.fetchBars,
    });

    expect(market.calls[0]).toEqual({ symbol: 'btcidr', fromSec: s0, toSec });
    expect(stats.cacheHits).toBe(0);
    // Both files were replaced with the refetched slot, so the corruption does not survive.
    expect((await cache.read('btcidr', s0))![0].t).toBe(s0);
    expect((await cache.read('btcidr', s1))![0].t).toBe(s1);
  });

  it('keeps the run going when a cache write fails', async () => {
    const toSec = 1_700_000_100;
    const slots = alignedSlots(toSec - 2 * SLOT, toSec);
    const failing = new SlotCache(dir);
    failing.write = async () => { throw new Error('disk full'); };
    const warnings: string[] = [];
    const market = exchange();

    const { bars } = await fetchSlotHistory({
      symbol: 'btcidr', slots, toSec, cache: failing, fetchBars: market.fetchBars,
      onWarning: (message) => warnings.push(message),
    });

    expect(bars).toHaveLength((toSec - slots[0]) / 60);
    expect(warnings.some((w) => w.includes('disk full'))).toBe(true);
  });
});
