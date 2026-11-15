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
