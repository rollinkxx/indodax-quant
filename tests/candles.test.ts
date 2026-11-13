import { describe, expect, it } from 'vitest';
import { aggregateCandles, compareTid, dedupeTrades, fillGaps, floorTo, isValidCandle, tradesToCandles, type Trade } from '../shared/candles';

const T0 = 1_763_000_000 - (1_763_000_000 % 300); // aligned to 5m
const tr = (tid: string, ts: number, price: number, amount = 1, side: 'buy' | 'sell' = 'buy'): Trade => ({ tid, ts, price, amount, side });

describe('trades -> candles', () => {
  it('builds OHLCV per minute in trade order', () => {
    const trades = [tr('3', T0 + 30, 105, 2), tr('1', T0 + 1, 100), tr('2', T0 + 10, 110), tr('4', T0 + 61, 90, 0.5)];
    const cs = tradesToCandles(trades, 60, T0, T0 + 120);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ t: T0, o: 100, h: 110, l: 100, c: 105, v: 4, n: 3, source: 'trades' });
    expect(cs[1]).toMatchObject({ t: T0 + 60, o: 90, c: 90, v: 0.5, n: 1 });
  });
  it('deduplicates by tid and respects the [from, to) window', () => {
    const trades = [tr('1', T0, 100), tr('1', T0, 100), tr('2', T0 + 60, 101)];
    expect(dedupeTrades(trades)).toHaveLength(2);
    const cs = tradesToCandles(trades, 60, T0, T0 + 60);
    expect(cs).toHaveLength(1);
    expect(cs[0].n).toBe(1);
  });
  it('compares tids beyond Number.MAX_SAFE_INTEGER', () => {
    expect(compareTid('90071992547409931', '90071992547409930')).toBe(1);
    expect(compareTid('5', '5')).toBe(0);
  });
});

describe('aggregation and gaps', () => {
  it('aggregates 1m into 5m', () => {
    const ones = [0, 1, 2, 3, 4, 5].map((i) => ({ t: T0 + i * 60, o: 100 + i, h: 110 + i, l: 90 + i, c: 101 + i, v: 1, n: 2, source: 'trades' as const }));
    const five = aggregateCandles(ones, 300, T0, T0 + 600);
    expect(five).toHaveLength(2);
    expect(five[0]).toMatchObject({ t: T0, o: 100, h: 114, l: 90, c: 105, v: 5, n: 10 });
    expect(five[1]).toMatchObject({ t: T0 + 300, o: 105, c: 106 });
  });
  it('fills missing buckets with flat synthetic candles and extends to lastOpenTime', () => {
    const cs = [{ t: T0, o: 1, h: 2, l: 1, c: 2, v: 1, n: 1, source: 'trades' as const }, { t: T0 + 900, o: 3, h: 3, l: 3, c: 3, v: 1, n: 1, source: 'trades' as const }];
    const out = fillGaps(cs, 300, T0 + 1500);
    expect(out.map((c) => c.t)).toEqual([T0, T0 + 300, T0 + 600, T0 + 900, T0 + 1200, T0 + 1500]);
    expect(out[1]).toMatchObject({ o: 2, c: 2, v: 0, source: 'synthetic' });
    expect(out[5]).toMatchObject({ c: 3, source: 'synthetic' });
  });
  it('floorTo aligns to the interval', () => {
    expect(floorTo(T0 + 299, 300)).toBe(T0);
  });
  it('validates candles', () => {
    expect(isValidCandle({ t: 0, o: 1, h: 2, l: 0.5, c: 1.5, v: 0, n: 0, source: 'trades' })).toBe(true);
    expect(isValidCandle({ t: 0, o: 1, h: 0.9, l: 0.5, c: 1.5, v: 0, n: 0, source: 'trades' })).toBe(false);
    expect(isValidCandle({ t: 0, o: 1, h: 2, l: 0.5, c: NaN, v: 0, n: 0, source: 'trades' })).toBe(false);
  });
});
