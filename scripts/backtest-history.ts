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
    if (!existing || candle.source === 'trades' || existing.source !== 'trades') {
      merged.set(candle.t, candle);
    }
  }
  return [...merged.values()].sort((a, b) => a.t - b.t);
}
