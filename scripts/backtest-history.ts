import { isValidCandle, type Candle } from '../shared/candles';

/**
 * Convert official INDODAX 1m OHLC into complete 5m candles.
 * A 5m bucket is accepted only when all five minute bars are present and valid;
 * partially populated buckets are omitted rather than fabricated.
 */
export function aggregateCompleteMinuteHistory(
  minuteCandles: Candle[],
  fromSec: number,
  toSec: number,
): Candle[] {
  const minutes = new Map<number, Candle>();
  for (const candle of minuteCandles) {
    if (
      candle.source === 'synthetic' ||
      !isValidCandle(candle) ||
      candle.t % 60 !== 0 ||
      candle.t < fromSec ||
      candle.t + 60 > toSec
    ) continue;
    minutes.set(candle.t, candle);
  }

  const bucketStarts = new Set(
    [...minutes.keys()].map((time) => Math.floor(time / 300) * 300),
  );
  const result: Candle[] = [];
  for (const start of [...bucketStarts].sort((a, b) => a - b)) {
    const five = Array.from({ length: 5 }, (_, i) => minutes.get(start + i * 60));
    if (five.some((c) => !c)) continue;

    const bars = five as Candle[];
    result.push({
      t: start,
      o: bars[0].o,
      h: Math.max(...bars.map((c) => c.h)),
      l: Math.min(...bars.map((c) => c.l)),
      c: bars[4].c,
      v: bars.reduce((sum, c) => sum + c.v, 0),
      n: 0,
      source: 'history',
    });
  }
  return result;
}

/**
 * Merge history with stored 5m observations. Trade-built candles take precedence
 * over OHLC history at the same timestamp; synthetic candles are never retained.
 */
export function mergeBacktestCandles(history: Candle[], stored: Candle[]): Candle[] {
  const merged = new Map<number, Candle>();
  for (const candle of history) {
    if (candle.source !== 'synthetic' && isValidCandle(candle)) merged.set(candle.t, candle);
  }
  for (const candle of stored) {
    if (candle.source === 'synthetic' || !isValidCandle(candle)) continue;
    const existing = merged.get(candle.t);
    // Raw trade-built bars outrank official OHLC; validated new OHLC outranks
    // older persisted history which may have been formed from partial recovery data.
    if (candle.source === 'trades' || !existing) merged.set(candle.t, candle);
  }
  return [...merged.values()].sort((a, b) => a.t - b.t);
}


/**
 * Keep persisted trade/history bars inside the exact requested half-open interval.
 * This prevents a database tail candle before/after the official history window
 * from changing the test duration or chronological train/holdout boundary.
 */
export function filterBacktestCandlesToRange(
  candles: Candle[],
  fromSec: number,
  toSec: number,
): Candle[] {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || fromSec >= toSec) {
    throw new Error('Invalid backtest candle range');
  }
  return candles
    .filter((candle) =>
      candle.t >= fromSec &&
      candle.t < toSec &&
      candle.source !== 'synthetic' &&
      isValidCandle(candle),
    )
    .sort((a, b) => a.t - b.t);
}


export interface BacktestHistoryRange {
  days: number;
  fromSec: number;
  toSec: number;
}

/**
 * Anchor a historical test to one common, closed 5-minute boundary.
 * The 5-minute alignment and exact 24h-day duration ensure every market in a
 * multi-pair experiment is evaluated over the same half-open [from,to) interval.
 */
export function createBacktestHistoryRange(days: number, nowMs: number): BacktestHistoryRange {
  if (!Number.isInteger(days) || days < 1 || days > 180 || !Number.isFinite(nowMs) || nowMs <= 0) {
    throw new Error('Invalid backtest history range inputs');
  }
  const nowSec = Math.floor(nowMs / 1000);
  const toSec = Math.floor(nowSec / 300) * 300;
  const fromSec = toSec - days * 86_400;
  return { days, fromSec, toSec };
}


export interface MinuteHistoryQuality {
  receivedMinuteBars: number;
  expectedMinuteBars: number;
  uniqueValidMinuteBars: number;
  duplicateMinuteBars: number;
  missingMinuteBars: number;
  zeroVolumeMinuteBars: number;
  zeroVolume5mBars: number;
  activeVolume5mBars: number;
  expected5mBars: number;
  activeVolumeCoveragePct: number;
}

/**
 * Distinguish structurally complete OHLC coverage from candles that actually
 * contain trading volume. INDODAX can return valid OHLC rows with Volume=0.
 */
export function summarizeMinuteHistoryQuality(
  minuteCandles: Candle[],
  fromSec: number,
  toSec: number,
  complete5m: Candle[],
): MinuteHistoryQuality {
  if (
    !Number.isFinite(fromSec) || !Number.isFinite(toSec) ||
    fromSec >= toSec || fromSec % 60 !== 0 || toSec % 60 !== 0
  ) throw new Error('Invalid minute history quality range');

  const validMinutes = minuteCandles.filter((candle) =>
    candle.source !== 'synthetic' &&
    isValidCandle(candle) &&
    candle.t % 60 === 0 &&
    candle.t >= fromSec &&
    candle.t + 60 <= toSec
  );
  const uniqueMinutes = new Map<number, Candle>();
  for (const candle of validMinutes) uniqueMinutes.set(candle.t, candle);

  const expectedMinuteBars = Math.floor((toSec - fromSec) / 60);
  const expected5mBars = Math.floor((toSec - fromSec) / 300);
  const zeroVolume5mBars = complete5m.filter((candle) => candle.v <= 0).length;
  const activeVolume5mBars = complete5m.length - zeroVolume5mBars;

  return {
    receivedMinuteBars: minuteCandles.length,
    expectedMinuteBars,
    uniqueValidMinuteBars: uniqueMinutes.size,
    duplicateMinuteBars: Math.max(0, validMinutes.length - uniqueMinutes.size),
    missingMinuteBars: Math.max(0, expectedMinuteBars - uniqueMinutes.size),
    zeroVolumeMinuteBars: [...uniqueMinutes.values()].filter((candle) => candle.v <= 0).length,
    zeroVolume5mBars,
    activeVolume5mBars,
    expected5mBars,
    activeVolumeCoveragePct: expected5mBars > 0
      ? Number((activeVolume5mBars / expected5mBars * 100).toFixed(2)) : 0,
  };
}


export type RequestStartLimiter = (() => Promise<number>) & { readonly intervalMs: number };

/**
 * Documented quota for INDODAX's public endpoints: 180 requests per minute. The history endpoint,
 * the Worker's polling and the relay that proxies these calls all draw on that one quota.
 */
export const INDODAX_PUBLIC_REQUESTS_PER_MINUTE = 180;

/**
 * Start interval this module paces at: 400 ms = 150 requests/minute, i.e. 30 requests/minute (17%)
 * of the documented quota left for the Worker and the relay. 400 ms is the same pace the candle
 * backfill already uses; the backtest used to pass 500 ms (120 req/min) at its call site, which spent
 * only two thirds of the quota on the one job that needs the headroom and made a cold 180-day fetch
 * 60 minutes long.
 */
export const HISTORY_REQUEST_START_INTERVAL_MS = 400;

/**
 * Create a process-wide minimum-start-interval gate for concurrent HTTP requests.
 * The queue controls request start times, not response completion, so slow requests
 * may remain in flight concurrently while their starts stay within the API quota.
 *
 * The pace is owned by this module because it is a property of the exchange, not of the caller: a
 * caller can never start requests faster than the quota-safe interval, and a caller asking to be
 * slower than it (the backtest's legacy 500 ms) is no longer obeyed, because that is a throughput
 * bug rather than a safety margin. `legacyIntervalMs` is accepted so existing call sites keep
 * working; a different value is reported once so the override is visible in the run log.
 */
export function createRequestStartLimiter(
  legacyIntervalMs?: number,
  now: () => number = () => Date.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): RequestStartLimiter {
  if (legacyIntervalMs !== undefined && (!Number.isFinite(legacyIntervalMs) || legacyIntervalMs <= 0)) {
    throw new Error('Request start interval must be a positive finite number');
  }

  const intervalMs = HISTORY_REQUEST_START_INTERVAL_MS;
  if (legacyIntervalMs !== undefined && legacyIntervalMs !== intervalMs) {
    console.warn(
      `[HISTORY] pacing at ${intervalMs} ms (${Math.round(60_000 / intervalMs)} req/min, ` +
      `quota ${INDODAX_PUBLIC_REQUESTS_PER_MINUTE}/min); ignoring caller interval ${legacyIntervalMs} ms`,
    );
  }

  let nextAllowedAt = 0;
  let queue: Promise<void> = Promise.resolve();

  const acquire = async (): Promise<number> => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      while (true) {
        const current = now();
        if (!Number.isFinite(current)) throw new Error('Request limiter clock must be finite');
        const remaining = nextAllowedAt - current;
        if (remaining <= 0) break;
        await sleep(remaining);
      }

      const startedAt = now();
      if (!Number.isFinite(startedAt)) throw new Error('Request limiter clock must be finite');
      nextAllowedAt = startedAt + intervalMs;
      return startedAt;
    } finally {
      // Always release the queue, including when the clock or injected sleep fails.
      release();
    }
  };

  return Object.assign(acquire, { intervalMs });
}

export type InFlightLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Bound how many requests are in flight at once.
 *
 * The start gate alone is not enough to shorten a cold run: measured against the public history
 * endpoint, a 12-hour one-minute slot (720 bars, ~81 KB) takes 0.38-1.45 s (median ~0.9 s) while the
 * gate spaces starts by 400 ms. A loop that awaits each response before starting the next is
 * therefore latency-bound: at the backtest's pair concurrency of 3 the offered rate is
 * ~3 / 0.9 s = 200 req/min, which the 400 ms gate then trims to 150 req/min. Overlapping the waits
 * with this limiter keeps every *start* on the gate while several responses are still in flight,
 * which is what lets the gate, and not the round trip, set the pace of the run.
 */
export function createInFlightLimiter(maxInFlight: number): InFlightLimiter {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error('maxInFlight must be a positive integer');
  }

  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (active < maxInFlight) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => { active++; resolve(); });
    });
  };

  const release = (): void => {
    active--;
    waiting.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
