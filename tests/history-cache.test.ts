import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  alignedSlots, HISTORY_SLOT_SECONDS, isMinuteBar, isSlotComplete, SlotCache, slotLastClosedMinute,
} from '../scripts/history-cache';
import { aggregateCompleteMinuteHistory } from '../scripts/backtest-history';

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
