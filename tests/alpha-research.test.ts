import { describe, expect, it } from 'vitest';
import {
  contiguousSegments, evaluateHypothesis, forwardReturns, holdoutStartIndex, meanForwardVector,
  pctChange, quantileCuts, type AlphaSample,
} from '../shared/alphaResearch';
import type { Candle } from '../shared/candles';

function candle(t: number, c: number, opts: Partial<Candle> = {}): Candle {
  return { t, o: c, h: c + 1, l: Math.max(0.5, c - 1), c, v: 10, n: 1, source: 'history', ...opts };
}

describe('pctChange', () => {
  it('computes percentage change and guards a zero base', () => {
    expect(pctChange(110, 100)).toBeCloseTo(10, 10);
    expect(pctChange(90, 100)).toBeCloseTo(-10, 10);
    expect(pctChange(5, 0)).toBe(0);
  });
});

describe('contiguousSegments', () => {
  it('keeps a fully contiguous run as one segment', () => {
    const segs = contiguousSegments([candle(0, 1), candle(300, 1), candle(600, 1)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveLength(3);
  });

  it('breaks on a time gap and does not carry candles across it', () => {
    const segs = contiguousSegments([candle(0, 1), candle(300, 1), candle(900, 1), candle(1200, 1)]);
    expect(segs.map((s) => s.length)).toEqual([2, 2]);
  });

  it('breaks on synthetic, zero-volume and invalid bars', () => {
    const segs = contiguousSegments([
      candle(0, 1), candle(300, 1, { source: 'synthetic' }), candle(600, 1),
      candle(900, 1, { v: 0 }), candle(1200, 1), candle(1500, 1),
    ]);
    // synthetic + zero-volume bars are dropped and each side becomes its own run
    expect(segs.map((s) => s.length)).toEqual([1, 1, 2]);
  });

  it('drops an invalid OHLCV bar without emitting an empty segment', () => {
    const segs = contiguousSegments([candle(0, 1, { h: 0.5 }), candle(300, 1)]);
    expect(segs).toEqual([[candle(300, 1)]]);
  });
});

describe('forwardReturns', () => {
  const seg = [candle(0, 100), candle(300, 110), candle(600, 90), candle(900, 120)];

  it('returns the requested horizon returns', () => {
    expect(forwardReturns(seg, 0, [1, 3])).toEqual([10, 20]);
  });

  it('returns null when the series does not extend far enough', () => {
    expect(forwardReturns(seg, 1, [1, 5])).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    expect(forwardReturns(seg, 9, [1])).toBeNull();
  });
});

describe('holdoutStartIndex', () => {
  it('splits off the final 30% by default', () => {
    expect(holdoutStartIndex(100)).toBe(70);
  });

  it('handles empty and tiny series', () => {
    expect(holdoutStartIndex(0)).toBe(0);
    expect(holdoutStartIndex(1)).toBe(0);
  });
});

function sample(forward: number[], isHoldout: boolean, feature: number): AlphaSample {
  return { pair: 'x', isHoldout, close: 1, forward, features: { f: feature } };
}

describe('meanForwardVector', () => {
  it('averages each horizon independently', () => {
    const out = meanForwardVector([sample([1, 2], false, 0), sample([3, 4], false, 0)], 2);
    expect(out).toEqual([2, 3]);
  });

  it('returns zeros for an empty set', () => {
    expect(meanForwardVector([], 3)).toEqual([0, 0, 0]);
  });
});

describe('quantileCuts', () => {
  it('produces bucket-1 cut points', () => {
    expect(quantileCuts([1, 2, 3, 4, 5], 5)).toHaveLength(4);
  });

  it('returns nothing for degenerate input', () => {
    expect(quantileCuts([], 5)).toEqual([]);
    expect(quantileCuts([1, 2], 1)).toEqual([]);
  });
});

describe('evaluateHypothesis', () => {
  const opts = { feeRoundTripPct: 0.4, minHoldout: 2 };

  it('flags CANDIDATE when the rule beats baseline on both splits and clears cost on holdout', () => {
    const samples: AlphaSample[] = [
      sample([0], false, 0), sample([0], false, 0), sample([5], false, 1), sample([5], false, 1),
      sample([0], true, 0), sample([0], true, 0), sample([5], true, 1), sample([5], true, 1),
    ];
    const r = evaluateHypothesis(samples, (f) => f.f === 1, 0, 1, opts);
    expect(r.trainCount).toBe(2);
    expect(r.holdoutCount).toBe(2);
    expect(r.edgeTrainPp).toBeCloseTo(2.5, 10);
    expect(r.netHoldoutPct).toBeCloseTo(4.6, 10);
    expect(r.verdict).toBe('CANDIDATE');
  });

  it('rejects when the edge does not clear the round-trip cost', () => {
    const samples: AlphaSample[] = [
      sample([0], false, 0), sample([0.2], false, 1),
      sample([0], true, 0), sample([0.2], true, 1),
    ];
    const r = evaluateHypothesis(samples, (f) => f.f === 1, 0, 1, { feeRoundTripPct: 0.4, minHoldout: 1 });
    expect(r.verdict).toBe('no');
    expect(r.netHoldoutPct).toBeLessThan(0);
  });

  it('rejects a rule that only looks good relative to a negative baseline (regime artefact)', () => {
    // Downtrend regime: everything falls, but the rule falls less. Net-negative on BOTH splits.
    const samples: AlphaSample[] = [
      sample([-5], false, 0), sample([-5], false, 0), sample([-2], false, 1), sample([-2], false, 1),
      sample([-5], true, 0), sample([-5], true, 0), sample([-2], true, 1), sample([-2], true, 1),
    ];
    const r = evaluateHypothesis(samples, (f) => f.f === 1, 0, 1, opts);
    expect(r.edgeTrainPp).toBeGreaterThan(0); // beats baseline
    expect(r.netTrainPct).toBeLessThan(0); // but is still net-negative in absolute terms
    expect(r.netHoldoutPct).toBeLessThan(0);
    expect(r.verdict).toBe('no');
  });

  it('marks a rule thin when the holdout sample is too small', () => {
    const samples: AlphaSample[] = [
      sample([0], false, 0), sample([9], false, 1),
      sample([0], true, 0), sample([9], true, 1),
    ];
    const r = evaluateHypothesis(samples, (f) => f.f === 1, 0, 1, { feeRoundTripPct: 0.4, minHoldout: 5 });
    expect(r.verdict).toBe('thin');
  });
});
