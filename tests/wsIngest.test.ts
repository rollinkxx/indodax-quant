import { describe, expect, it } from 'vitest';
import { feedIsStale, nextReconnectDelay, TradeBatcher, type IngestTrade } from '../shared/wsIngest';

const trade = (tid: number, ts: number, pair = 'btcidr'): IngestTrade =>
  ({ pair_id: pair, tid, ts, price: 1000 + tid, amount: 1, side: 'buy' });

describe('nextReconnectDelay', () => {
  it('grows exponentially from the base', () => {
    expect(nextReconnectDelay(0, 1000, 60_000, () => 0)).toBe(1000);
    expect(nextReconnectDelay(1, 1000, 60_000, () => 0)).toBe(2000);
    expect(nextReconnectDelay(3, 1000, 60_000, () => 0)).toBe(8000);
  });

  it('caps the delay so a long outage retries at a steady pace', () => {
    expect(nextReconnectDelay(20, 1000, 60_000, () => 0)).toBe(60_000);
  });

  it('adds jitter of at most 25% and never exceeds the cap', () => {
    expect(nextReconnectDelay(0, 1000, 60_000, () => 1)).toBe(1250);
    expect(nextReconnectDelay(10, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('treats a negative or fractional attempt as the first retry', () => {
    expect(nextReconnectDelay(-5, 1000, 60_000, () => 0)).toBe(1000);
    expect(nextReconnectDelay(1.9, 1000, 60_000, () => 0)).toBe(2000);
  });
});

describe('feedIsStale', () => {
  it('treats a feed that never delivered a message as stale', () => {
    expect(feedIsStale(1_000_000, null)).toBe(true);
  });

  it('is fresh inside the threshold and stale beyond it', () => {
    expect(feedIsStale(1_000_000, 1_000_000 - 179_000)).toBe(false);
    expect(feedIsStale(1_000_000, 1_000_000 - 181_000)).toBe(true);
  });
});

describe('TradeBatcher', () => {
  it('accepts trades in order and drains them once', () => {
    const b = new TradeBatcher('btcidr');
    expect(b.add(trade(1, 100))).toBe(true);
    expect(b.add(trade(2, 200))).toBe(true);
    expect(b.size).toBe(2);
    expect(b.drain().map((t) => t.tid)).toEqual([1, 2]);
    expect(b.size).toBe(0);
    expect(b.drain()).toEqual([]);
  });

  it('rejects a replayed trade id, which is what a reconnect sends', () => {
    const b = new TradeBatcher('btcidr');
    b.add(trade(1, 100));
    b.drain();
    expect(b.add(trade(1, 100))).toBe(false);
    expect(b.size).toBe(0);
  });

  it('rejects a trade older than the watermark so a reconnect cannot rewind the stream', () => {
    const b = new TradeBatcher('btcidr');
    b.add(trade(5, 500));
    expect(b.add(trade(6, 400))).toBe(false);
    expect(b.add(trade(7, 600))).toBe(true);
  });

  it('ignores trades for another pair and malformed rows', () => {
    const b = new TradeBatcher('btcidr');
    expect(b.add(trade(1, 100, 'ethidr'))).toBe(false);
    expect(b.add({ ...trade(2, 200), price: Number.NaN })).toBe(false);
    expect(b.size).toBe(0);
  });

  it('reports itself full at the buffer limit so the caller flushes instead of growing memory', () => {
    const b = new TradeBatcher('btcidr', 3);
    b.add(trade(1, 100));
    b.add(trade(2, 200));
    expect(b.full).toBe(false);
    b.add(trade(3, 300));
    expect(b.full).toBe(true);
    b.drain();
    expect(b.full).toBe(false);
  });
});
