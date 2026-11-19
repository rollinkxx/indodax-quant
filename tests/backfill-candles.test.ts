import { describe, expect, it } from 'vitest';
import { chunkWindows, normalizeSeries } from '../scripts/backfill-candles';
import type { Candle } from '../shared/candles';

function candle(t: number, opts: Partial<Candle> = {}): Candle {
  return { t, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history', ...opts };
}

describe('chunkWindows', () => {
  it('covers [from, to) exactly once with no overlap', () => {
    const ws = chunkWindows(0, 1000, 300);
    expect(ws).toEqual([{ from: 0, to: 300 }, { from: 300, to: 600 }, { from: 600, to: 900 }, { from: 900, to: 1000 }]);
    expect(ws[0].from).toBe(0);
    expect(ws[ws.length - 1].to).toBe(1000);
  });

  it('produces no windows for an empty or inverted range', () => {
    expect(chunkWindows(100, 100, 60)).toEqual([]);
    expect(chunkWindows(200, 100, 60)).toEqual([]);
  });

  it('rejects a non-positive chunk size', () => {
    expect(chunkWindows(0, 100, 0)).toEqual([]);
    expect(chunkWindows(0, 100, -5)).toEqual([]);
  });
});

describe('normalizeSeries', () => {
  const now = 10_000;

  it('drops a still-forming tail bar', () => {
    const out = normalizeSeries([candle(300), candle(600), candle(9900)], 300, now);
    expect(out.map((c) => c.t)).toEqual([300, 600]);
  });

  it('drops unaligned, synthetic and invalid bars', () => {
    const out = normalizeSeries([
      candle(300),
      candle(450), // not 300-aligned
      candle(600, { source: 'synthetic' }),
      candle(900, { l: 0 }), // invalid (low must be > 0)
      candle(1200),
    ], 300, now);
    expect(out.map((c) => c.t)).toEqual([300, 1200]);
  });

  it('de-duplicates on time, keeping the last value, and sorts ascending', () => {
    const out = normalizeSeries([candle(600, { c: 100 }), candle(300, { c: 100 }), candle(600, { c: 101 })], 300, now);
    expect(out.map((c) => c.t)).toEqual([300, 600]);
    expect(out[1].c).toBe(101);
  });

  it('returns an empty list when nothing is usable', () => {
    expect(normalizeSeries([candle(1)], 300, now)).toEqual([]);
  });
});
