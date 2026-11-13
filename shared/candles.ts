// Candlestick construction from raw INDODAX public trades.
import type { OHLCV } from './indicators';

export type CandleSource = 'trades' | 'history' | 'synthetic';

export interface Trade {
  tid: string;
  ts: number; // unix seconds
  price: number;
  amount: number;
  side: 'buy' | 'sell';
}

export interface Candle extends OHLCV {
  n: number; // trade count
  source: CandleSource;
}

export const MINUTE = 60;
export const FIVE_MINUTES = 300;

export function floorTo(tsSec: number, intervalSec: number): number {
  return Math.floor(tsSec / intervalSec) * intervalSec;
}

export function ceilTo(tsSec: number, intervalSec: number): number {
  return Math.ceil(tsSec / intervalSec) * intervalSec;
}

/** Compare INDODAX trade ids (they exceed Number.MAX_SAFE_INTEGER). */
export function compareTid(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sortTrades(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => a.ts - b.ts || compareTid(a.tid, b.tid));
}

/** Deduplicate by tid (keeps first). */
export function dedupeTrades(trades: Trade[]): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const t of trades) {
    if (seen.has(t.tid)) continue;
    seen.add(t.tid);
    out.push(t);
  }
  return out;
}

/** Build candles of `intervalSec` from trades whose timestamp is in [fromSec, toSec). Buckets without trades are omitted. */
export function tradesToCandles(trades: Trade[], intervalSec: number, fromSec: number, toSec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const tr of sortTrades(dedupeTrades(trades))) {
    if (tr.ts < fromSec || tr.ts >= toSec) continue;
    const t = floorTo(tr.ts, intervalSec);
    const c = buckets.get(t);
    if (!c) {
      buckets.set(t, { t, o: tr.price, h: tr.price, l: tr.price, c: tr.price, v: tr.amount, n: 1, source: 'trades' });
    } else {
      c.h = Math.max(c.h, tr.price);
      c.l = Math.min(c.l, tr.price);
      c.c = tr.price;
      c.v += tr.amount;
      c.n += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/** Aggregate lower-timeframe candles into `intervalSec` buckets within [fromSec, toSec). Empty buckets are omitted. */
export function aggregateCandles(candles: Candle[], intervalSec: number, fromSec: number, toSec: number): Candle[] {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out = new Map<number, Candle>();
  for (const k of sorted) {
    if (k.t < fromSec || k.t >= toSec) continue;
    const t = floorTo(k.t, intervalSec);
    const c = out.get(t);
    if (!c) {
      out.set(t, { t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, n: k.n, source: k.source });
    } else {
      c.h = Math.max(c.h, k.h);
      c.l = Math.min(c.l, k.l);
      c.c = k.c;
      c.v += k.v;
      c.n += k.n;
      if (k.source === 'history') c.source = 'history';
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * Fill missing buckets with flat synthetic candles (no trades in that bucket => price unchanged, volume 0).
 * If `lastOpenTime` is given, the series is extended up to that bucket.
 */
export function fillGaps(candles: Candle[], intervalSec: number, lastOpenTime?: number): Candle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out: Candle[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    for (let t = prev.t + intervalSec; t < sorted[i].t; t += intervalSec) {
      out.push(flat(t, out[out.length - 1].c));
    }
    out.push(sorted[i]);
  }
  if (lastOpenTime !== undefined) {
    for (let t = out[out.length - 1].t + intervalSec; t <= lastOpenTime; t += intervalSec) {
      out.push(flat(t, out[out.length - 1].c));
    }
  }
  return out;
}

function flat(t: number, price: number): Candle {
  return { t, o: price, h: price, l: price, c: price, v: 0, n: 0, source: 'synthetic' };
}

export function isValidCandle(c: Candle): boolean {
  return (
    [c.o, c.h, c.l, c.c, c.v].every((x) => Number.isFinite(x)) &&
    c.o > 0 && c.c > 0 && c.l > 0 && c.v >= 0 &&
    c.h >= c.l && c.h >= c.o && c.h >= c.c && c.l <= c.o && c.l <= c.c
  );
}
