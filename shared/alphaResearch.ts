// Pure helpers for the read-only alpha research harness (scripts/alpha-research.ts).
// No I/O here: everything is a deterministic function of candles/samples so it can be unit-tested.
import { isValidCandle, type Candle } from './candles';

export interface AlphaSample {
  pair: string;
  isHoldout: boolean;
  /** Chronological block index within the pair, used for walk-forward folds. */
  fold: number;
  close: number;
  /** Forward percentage returns, one entry per configured horizon. */
  forward: number[];
  features: Record<string, number | string>;
}

export function pctChange(newValue: number, oldValue: number): number {
  return oldValue === 0 ? 0 : ((newValue - oldValue) / oldValue) * 100;
}

/**
 * Split a candle series into contiguous runs of real, tradable candles.
 * A gap (t - prev.t !== intervalSec), a synthetic bar, a zero-volume bar or an invalid OHLCV
 * all break the run, so indicators and forward returns never span an unobserved stretch.
 */
export function contiguousSegments(candles: Candle[], intervalSec = 300): Candle[][] {
  const segments: Candle[][] = [];
  let current: Candle[] = [];
  for (const c of candles) {
    const usable = c.source !== 'synthetic' && c.v > 0 && isValidCandle(c);
    const contiguous = current.length === 0 || c.t - current[current.length - 1].t === intervalSec;
    if (!usable || !contiguous) {
      if (current.length) segments.push(current);
      current = [];
      if (!usable) continue;
    }
    current.push(c);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Forward percentage returns at `index`, or null when the series does not extend far enough. */
export function forwardReturns(seg: Candle[], index: number, horizons: readonly number[]): number[] | null {
  const base = seg[index]?.c;
  if (base === undefined || base === 0) return null;
  const out: number[] = [];
  for (const h of horizons) {
    const future = seg[index + h];
    if (!future) return null;
    out.push(pctChange(future.c, base));
  }
  return out;
}

/** Index at which the chronological holdout begins (everything before it is train). */
export function holdoutStartIndex(length: number, holdoutFraction = 0.3): number {
  if (length <= 0) return 0;
  return Math.floor(length * (1 - holdoutFraction));
}

export function meanForward(samples: readonly AlphaSample[], horizonIndex: number): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const s of samples) sum += s.forward[horizonIndex] ?? 0;
  return sum / samples.length;
}

export function meanForwardVector(samples: readonly AlphaSample[], horizonCount: number): number[] {
  const out = new Array(horizonCount).fill(0);
  if (!samples.length) return out;
  for (const s of samples) for (let k = 0; k < horizonCount; k++) out[k] += s.forward[k] ?? 0;
  return out.map((v) => v / samples.length);
}

/** Cut points that divide sorted values into `buckets` equal-count groups (returns buckets-1 cuts). */
export function quantileCuts(values: readonly number[], buckets = 5): number[] {
  if (values.length === 0 || buckets < 2) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const cuts: number[] = [];
  for (let i = 1; i < buckets; i++) {
    cuts.push(sorted[Math.min(sorted.length - 1, Math.floor((i / buckets) * sorted.length))]);
  }
  return cuts;
}

/**
 * Chronological block index for a sample at `index` of a series of `length`.
 * Folds are equal-width, time-ordered blocks; used for walk-forward validation.
 */
export function foldOfIndex(index: number, length: number, folds = 5): number {
  if (length <= 0 || folds < 2) return 0;
  return Math.min(folds - 1, Math.floor((index / length) * folds));
}

export interface WalkForwardFold {
  fold: number;
  trainCount: number;
  testCount: number;
  netTrainPct: number;
  netTestPct: number;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  positiveTestFolds: number;
  totalTestFolds: number;
  meanNetTestPct: number;
  verdict: HypothesisVerdict;
}

/**
 * Walk-forward check: split the samples into `folds` chronological blocks and, for each block
 * after the first, train on everything before it and score the block itself. A rule only earns
 * CANDIDATE when the net-of-cost mean is positive in EVERY test block (and each block has enough
 * samples). This is stricter than one 70/30 split: a rule that only worked in one regime fails.
 */
export function evaluateHypothesisWalkForward(
  samples: readonly AlphaSample[],
  predicate: (features: Record<string, number | string>) => boolean,
  horizonIndex: number,
  horizonCount: number,
  folds: number,
  opts: { feeRoundTripPct: number; minHoldout: number },
): WalkForwardResult {
  const results: WalkForwardFold[] = [];
  for (let k = 1; k < folds; k++) {
    const train = samples.filter((s) => s.fold < k && predicate(s.features));
    const test = samples.filter((s) => s.fold === k && predicate(s.features));
    results.push({
      fold: k,
      trainCount: train.length,
      testCount: test.length,
      netTrainPct: (meanForwardVector(train, horizonCount)[horizonIndex] ?? 0) - opts.feeRoundTripPct,
      netTestPct: (meanForwardVector(test, horizonCount)[horizonIndex] ?? 0) - opts.feeRoundTripPct,
    });
  }
  const positiveTestFolds = results.filter((f) => f.netTestPct > 0).length;
  const meanNetTestPct = results.length
    ? results.reduce((sum, f) => sum + f.netTestPct, 0) / results.length
    : 0;
  let verdict: HypothesisVerdict = 'no';
  if (!results.length || results.some((f) => f.testCount < opts.minHoldout)) verdict = 'thin';
  else if (positiveTestFolds === results.length && meanNetTestPct > 0) verdict = 'CANDIDATE';
  return { folds: results, positiveTestFolds, totalTestFolds: results.length, meanNetTestPct, verdict };
}

export type HypothesisVerdict = 'CANDIDATE' | 'no' | 'thin';

export interface HypothesisResult {
  trainCount: number;
  holdoutCount: number;
  trainMean: number[];
  holdoutMean: number[];
  edgeTrainPp: number;
  edgeHoldoutPp: number;
  netTrainPct: number;
  netHoldoutPct: number;
  verdict: HypothesisVerdict;
}

/**
 * Score a candidate feature rule. A rule only earns CANDIDATE when the holdout has enough samples
 * AND the mean forward return clears the round-trip cost on BOTH splits independently. Requiring the
 * train split to be net-positive too prevents the common trap where a feature only looks good
 * relative to a strongly negative baseline (a regime artefact), not in absolute terms.
 * `horizonIndex` is the horizon used for the cost/verdict.
 */
export function evaluateHypothesis(
  samples: readonly AlphaSample[],
  predicate: (features: Record<string, number | string>) => boolean,
  horizonIndex: number,
  horizonCount: number,
  opts: { feeRoundTripPct: number; minHoldout: number },
): HypothesisResult {
  const train = samples.filter((s) => !s.isHoldout);
  const holdout = samples.filter((s) => s.isHoldout);
  const hitTrain = train.filter((s) => predicate(s.features));
  const hitHoldout = holdout.filter((s) => predicate(s.features));

  const baseTrain = meanForwardVector(train, horizonCount)[horizonIndex] ?? 0;
  const baseHoldout = meanForwardVector(holdout, horizonCount)[horizonIndex] ?? 0;
  const trainMean = meanForwardVector(hitTrain, horizonCount);
  const holdoutMean = meanForwardVector(hitHoldout, horizonCount);
  const edgeTrainPp = (trainMean[horizonIndex] ?? 0) - baseTrain;
  const edgeHoldoutPp = (holdoutMean[horizonIndex] ?? 0) - baseHoldout;
  const netTrainPct = (trainMean[horizonIndex] ?? 0) - opts.feeRoundTripPct;
  const netHoldoutPct = (holdoutMean[horizonIndex] ?? 0) - opts.feeRoundTripPct;

  let verdict: HypothesisVerdict = 'no';
  if (hitHoldout.length < opts.minHoldout) verdict = 'thin';
  else if (netTrainPct > 0 && netHoldoutPct > 0) verdict = 'CANDIDATE';

  return {
    trainCount: hitTrain.length,
    holdoutCount: hitHoldout.length,
    trainMean,
    holdoutMean,
    edgeTrainPp,
    edgeHoldoutPp,
    netTrainPct,
    netHoldoutPct,
    verdict,
  };
}
