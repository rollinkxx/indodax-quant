// Timeframe adapter: a single description of how a base bar size drives aggregation, warm-up and
// holding limits.
//
// Switching 5m → 1h → 4h by editing numbers is unsafe: MTF buckets must divide the base interval,
// higher timeframes must be exact multiples of it, warm-up and the time stop scale with the bar, and
// an unsupported timeframe must be flagged RESEARCH_ONLY instead of silently trading. This module is
// the only place those relationships are expressed, so a bad combination fails a contract test
// rather than corrupting a run.

import type { Candle } from './candles';

export type BaseTimeframe = '5m' | '1h' | '4h';

export interface TimeframeSpec {
  baseSeconds: number;
  signalSeconds: number;
  /** Higher-timeframe bucket sizes in seconds (must be exact multiples of baseSeconds). */
  higherTimeframes: number[];
  warmupBars: number;
  maxHoldingBars: number;
  entryDelayBars: number;
  /** RESEARCH_ONLY timeframes are backtest-only until the production pipeline supports them. */
  status: 'PRODUCTION' | 'RESEARCH_ONLY';
}

export const TIMEFRAME_SPECS: Record<BaseTimeframe, TimeframeSpec> = {
  '5m': {
    baseSeconds: 300,
    signalSeconds: 300,
    higherTimeframes: [900, 3600],
    warmupBars: 250,
    maxHoldingBars: 288,
    entryDelayBars: 1,
    status: 'PRODUCTION',
  },
  '1h': {
    baseSeconds: 3600,
    signalSeconds: 3600,
    higherTimeframes: [14_400],
    warmupBars: 250,
    maxHoldingBars: 120,
    entryDelayBars: 1,
    status: 'RESEARCH_ONLY',
  },
  '4h': {
    baseSeconds: 14_400,
    signalSeconds: 14_400,
    higherTimeframes: [],
    warmupBars: 250,
    maxHoldingBars: 90,
    entryDelayBars: 1,
    status: 'RESEARCH_ONLY',
  },
};

export const BASE_TIMEFRAMES: BaseTimeframe[] = ['5m', '1h', '4h'];

export function timeframeSpec(tf: BaseTimeframe): TimeframeSpec {
  return TIMEFRAME_SPECS[tf];
}

/**
 * Contract validation for a timeframe spec. Returns a list of violations (empty = valid):
 * - a higher timeframe must be strictly larger than the base and an exact multiple of it;
 * - the signal interval must equal the base interval (no partial-bar signals);
 * - warm-up and holding limits must be positive, and the entry must be delayed at least one bar.
 */
export function validateTimeframeSpec(spec: TimeframeSpec): string[] {
  const errors: string[] = [];
  if (!(spec.baseSeconds > 0)) errors.push('baseSeconds must be positive');
  if (spec.signalSeconds !== spec.baseSeconds) errors.push('signalSeconds must equal baseSeconds');
  for (const htf of spec.higherTimeframes) {
    if (!(htf > spec.baseSeconds)) errors.push(`higher timeframe ${htf}s must exceed base ${spec.baseSeconds}s`);
    else if (htf % spec.baseSeconds !== 0) errors.push(`higher timeframe ${htf}s is not a multiple of base ${spec.baseSeconds}s`);
  }
  if (!(spec.warmupBars > 0)) errors.push('warmupBars must be positive');
  if (!(spec.maxHoldingBars > 0)) errors.push('maxHoldingBars must be positive');
  if (!(spec.entryDelayBars >= 1)) errors.push('entryDelayBars must be at least 1');
  return errors;
}

/**
 * A timeframe may only be used for a live-style run when its spec is valid and its status is
 * PRODUCTION. A RESEARCH_ONLY timeframe is backtest-only.
 */
export function isTradableTimeframe(spec: TimeframeSpec): boolean {
  return spec.status === 'PRODUCTION' && validateTimeframeSpec(spec).length === 0;
}

/** Which higher timeframes of a spec are usable against a given base bar interval. */
export function usableHigherTimeframes(spec: TimeframeSpec, baseSeconds = spec.baseSeconds): number[] {
  return spec.higherTimeframes.filter((h) => h > baseSeconds && h % baseSeconds === 0);
}

/** Time stop expressed in bars, so it scales with the timeframe instead of a fixed minute count. */
export function maxHoldingSeconds(spec: TimeframeSpec): number {
  return spec.maxHoldingBars * spec.signalSeconds;
}

/**
 * Aggregate a finer candle series up to `targetSeconds`, keeping only buckets that are complete.
 *
 * A bucket is complete when every base bar in it is present and observed (not a gap filler). Only
 * closed buckets are emitted, and the bucket's close time never exceeds the last observed bar, so a
 * signal taken from this series cannot see the future. Aggregating up must never be used to produce a
 * series finer than the base; that is rejected instead of inventing bars.
 */
export function resampleCandles(candles: readonly Candle[], targetSeconds: number, baseSeconds: number): Candle[] {
  if (!(targetSeconds > 0) || !(baseSeconds > 0)) return [];
  if (targetSeconds < baseSeconds) throw new Error(`cannot resample ${baseSeconds}s bars up to ${targetSeconds}s`);
  if (targetSeconds % baseSeconds !== 0) throw new Error(`${targetSeconds}s is not a multiple of ${baseSeconds}s`);
  const barsPerBucket = targetSeconds / baseSeconds;
  const out: Candle[] = [];
  let bucketStart: number | null = null;
  let count = 0;
  let synthetic = false;
  let agg: Candle | null = null;
  const flush = () => {
    if (!agg || count !== barsPerBucket) return;
    // A bucket that swallowed a gap filler is not fully observed. Mark it synthetic with zero volume so
    // no downstream signal, fill or protective exit can be derived from it.
    if (synthetic) out.push({ ...agg, v: 0, n: 0, source: 'synthetic' });
    else out.push(agg);
  };
  for (const c of candles) {
    const start = Math.floor(c.t / targetSeconds) * targetSeconds;
    if (start !== bucketStart) {
      flush();
      bucketStart = start;
      count = 0;
      synthetic = false;
      agg = null;
    }
    count++;
    const gapFiller = c.source === 'synthetic' || !(c.v > 0);
    if (gapFiller) synthetic = true;
    if (!agg) {
      agg = { t: start, o: c.o, h: c.h, l: c.l, c: c.c, v: gapFiller ? 0 : c.v, n: gapFiller ? 0 : c.n, source: gapFiller ? 'synthetic' : c.source };
    } else {
      agg.h = Math.max(agg.h, c.h);
      agg.l = Math.min(agg.l, c.l);
      agg.c = c.c;
      if (!gapFiller) { agg.v += c.v; agg.n += c.n; if (agg.source === 'synthetic') agg.source = c.source; }
    }
  }
  flush();
  return out;
}
