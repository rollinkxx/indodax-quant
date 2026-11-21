// Primitives for a WebSocket trade ingestor.
//
// INDODAX's only public-reachable WS host (ws3.indodax.com/ws/) accepts the upgrade and then closes
// with code 3003 unless the connection carries a token from `/tapi/ws_token`, which is the private
// trade API and answers `sign_not_found` without an API key signature. This project is paper-trading
// and holds no exchange keys, so the socket cannot be opened here. What is shipped instead is the
// part that does not depend on the wire format: reconnect pacing, duplicate/ordering handling, and
// feed-staleness detection. The transport itself stays unimplemented on purpose - a client written
// against a protocol nobody could observe would be a guess, not an ingestor.

/** A trade as the pipeline stores it (see `market_trades`). */
export interface IngestTrade {
  pair_id: string;
  tid: number;
  ts: number;
  price: number;
  amount: number;
  side: 'buy' | 'sell';
}

/**
 * Exponential backoff with jitter.
 *
 * Jitter is not decoration: when the exchange restarts its WS cluster every client reconnects at once,
 * and a synchronised retry storm keeps the reconnect failing. Spreading by up to 25% of the delay
 * breaks the convoy. `rand` is injectable so the schedule is testable.
 */
export function nextReconnectDelay(
  attempt: number,
  baseMs = 1000,
  capMs = 60_000,
  rand: () => number = Math.random,
): number {
  const n = Math.max(0, Math.floor(attempt));
  const raw = baseMs * 2 ** Math.min(n, 30);
  const capped = Math.min(capMs, raw);
  const jitter = capped * 0.25 * Math.max(0, Math.min(1, rand()));
  return Math.round(Math.min(capMs, capped + jitter));
}

/** A feed that has sent nothing for longer than `thresholdMs` is treated as dead, not as quiet. */
export function feedIsStale(nowMs: number, lastMessageMs: number | null, thresholdMs = 180_000): boolean {
  if (lastMessageMs === null) return true;
  return nowMs - lastMessageMs > thresholdMs;
}

/**
 * Buffers trades between flushes.
 *
 * Two rules matter for a live feed: a trade id is never accepted twice (a reconnect replays the tail
 * of the stream), and a trade older than the newest one already accepted is dropped (Socket.IO gives
 * no ordering guarantee across a reconnect). Both are silent in the exchange's data, so they are
 * enforced here rather than downstream.
 */
export class TradeBatcher {
  private readonly buffer: IngestTrade[] = [];
  private readonly seen = new Set<number>();
  private watermark = 0;

  constructor(
    private readonly pairId: string,
    private readonly maxBuffer = 5_000,
  ) {}

  /** Returns false when the trade was a duplicate or older than the accepted watermark. */
  add(trade: IngestTrade): boolean {
    if (trade.pair_id !== this.pairId) return false;
    if (!Number.isFinite(trade.tid) || !Number.isFinite(trade.ts) || !Number.isFinite(trade.price)) return false;
    if (this.seen.has(trade.tid)) return false;
    if (trade.ts < this.watermark) return false;
    this.seen.add(trade.tid);
    this.watermark = trade.ts;
    this.buffer.push(trade);
    return true;
  }

  /** Returns the buffered trades in arrival order and empties the buffer. */
  drain(): IngestTrade[] {
    const out = this.buffer.splice(0, this.buffer.length);
    return out;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** True when the buffer must be flushed before accepting more, so memory cannot grow unbounded. */
  get full(): boolean {
    return this.buffer.length >= this.maxBuffer;
  }
}
