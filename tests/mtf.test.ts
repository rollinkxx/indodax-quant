import { describe, expect, it } from 'vitest';
import { aggregateComplete, applyMtf, buildHigherSeries, lastCompleteBucket, trendState, type TfState } from '../shared/mtf';
import { DEFAULT_PARAMS, type SignalDecision } from '../shared/strategy';
import type { Candle } from '../shared/candles';

const c = (t: number, close: number, o = close, v = 1, source: Candle['source'] = 'trades'): Candle =>
  ({ t, o, h: Math.max(o, close) + 1, l: Math.min(o, close) - 1, c: close, v, n: v > 0 ? 1 : 0, source });

/** contiguous 5m series of `n` candles starting at t0 with closes from fn(i) */
const series5m = (t0: number, n: number, fn: (i: number) => number) => Array.from({ length: n }, (_, i) => c(t0 + i * 300, fn(i)));

const P = { ...DEFAULT_PARAMS, mtfEmaFast: 3, mtfEmaSlow: 6, mtfMinCandles: 10 };
const buy: SignalDecision = { side: 'BUY', strength: 60, reasons: ['EMA9 crossed above EMA21'] };
const sell: SignalDecision = { side: 'SELL', strength: 60, reasons: ['EMA9 crossed below EMA21'] };
const st = (tf: '15m' | '1h', trend: TfState['trend']): TfState => ({ tf, trend, candles: 50, lastOpenTime: 0, close: 1, emaFast: 1, emaSlow: 1, rsi: 50 });

describe('higher-timeframe aggregation', () => {
  it('lastCompleteBucket only counts buckets fully covered by closed 5m candles', () => {
    // last closed 5m candle opens 10:55 -> 10:45 15m bucket and 10:00 1h bucket are complete
    const t1055 = 36000 + 55 * 60;
    expect(lastCompleteBucket(t1055, 900)).toBe(36000 + 45 * 60);
    expect(lastCompleteBucket(t1055, 3600)).toBe(36000);
    // last closed 5m candle opens 10:50 -> 11:00 not reached, 10:30 is the last complete 15m bucket
    expect(lastCompleteBucket(36000 + 50 * 60, 900)).toBe(36000 + 30 * 60);
    expect(lastCompleteBucket(36000 + 50 * 60, 3600)).toBe(32400);
  });

  it('aggregates exact OHLCV and skips partial buckets at both ends', () => {
    // starts at 00:05 (partial first 15m bucket), ends at 00:50 (bucket 00:45 incomplete)
    const s = series5m(300, 10, (i) => 100 + i);
    const m15 = aggregateComplete(s, 900);
    expect(m15.map((k) => k.t)).toEqual([900, 1800]);
    expect(m15[0]).toMatchObject({ o: 102, c: 104, v: 3, n: 3, source: 'trades' });
    expect(m15[0].h).toBe(105);
    expect(m15[0].l).toBe(101);
  });

  it('marks all-synthetic buckets synthetic and history-backed ones history', () => {
    const s = [c(0, 1, 1, 0, 'synthetic'), c(300, 1, 1, 0, 'synthetic'), c(600, 1, 1, 0, 'synthetic'), c(900, 2, 2, 1, 'history'), c(1200, 2), c(1500, 2)];
    const m15 = aggregateComplete(s, 900);
    expect(m15.map((k) => k.source)).toEqual(['synthetic', 'history']);
  });

  it('buildHigherSeries merges stored history with aggregates (aggregates win) and drops forming candles', () => {
    const stored = [c(0, 10), c(3600, 11), c(7200, 12), c(10800, 99)];
    const agg = [c(7200, 13)];
    const out = buildHigherSeries(stored, agg, 3600, 7200);
    expect(out.map((k) => [k.t, k.c])).toEqual([[0, 10], [3600, 11], [7200, 13]]);
  });

  it('buildHigherSeries fills gaps up to the last complete bucket', () => {
    const out = buildHigherSeries([c(0, 10)], [], 3600, 3 * 3600);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ t: 3 * 3600, c: 10, source: 'synthetic' });
  });
});

describe('trendState', () => {
  const up = Array.from({ length: 20 }, (_, i) => c(i * 900, 100 + i * 2));
  const down = Array.from({ length: 20 }, (_, i) => c(i * 900, 200 - i * 2));
  const last = 19 * 900;

  it('bull / bear / unknown', () => {
    expect(trendState('15m', up, last, P).trend).toBe('bull');
    expect(trendState('15m', down, last, P).trend).toBe('bear');
    expect(trendState('15m', up.slice(0, 5), 4 * 900, P)).toMatchObject({ trend: 'unknown' });
    expect(trendState('15m', up.slice(0, 5), 4 * 900, P).reason).toContain('warming_up');
  });

  it('refuses a stale last candle', () => {
    expect(trendState('15m', up, last + 900, P)).toMatchObject({ trend: 'unknown', reason: 'stale_last_candle' });
  });

  it('neutral when price and EMAs disagree', () => {
    const chop = [...up.slice(0, 19), c(last, 120)]; // sharp drop below slow EMA while fast EMA still above
    const s = trendState('15m', chop, last, P);
    expect(['neutral', 'bear']).toContain(s.trend);
    expect(s.trend).not.toBe('bull');
  });
});

describe('applyMtf', () => {
  it('off leaves the decision untouched', () => {
    expect(applyMtf(buy, [st('15m', 'bear'), st('1h', 'bear')], 'off').decision).toEqual(buy);
  });

  it('filter: BUY passes when aligned and gains strength', () => {
    const r = applyMtf(buy, [st('15m', 'bull'), st('1h', 'bull')], 'filter');
    expect(r.decision?.strength).toBe(80);
    expect(r.decision?.reasons.at(-1)).toContain('searah');
    expect(r.summary['1h'].trend).toBe('bull');
  });

  it('filter: BUY blocked when 1h not bullish, any TF bearish, or data warming up', () => {
    expect(applyMtf(buy, [st('15m', 'bull'), st('1h', 'neutral')], 'filter')).toMatchObject({ decision: null, blocked: 'mtf_anchor_not_bullish' });
    expect(applyMtf(buy, [st('15m', 'bear'), st('1h', 'bull')], 'filter')).toMatchObject({ decision: null, blocked: 'mtf_against_trend' });
    expect(applyMtf(buy, [st('15m', 'bull'), st('1h', 'unknown')], 'filter')).toMatchObject({ decision: null, blocked: 'mtf_warming_up' });
  });

  it('filter: BUY with 15m neutral and 1h bullish passes with +10', () => {
    expect(applyMtf(buy, [st('15m', 'neutral'), st('1h', 'bull')], 'filter').decision?.strength).toBe(70);
  });

  it('SELL (exit) is never blocked, only scored', () => {
    const r = applyMtf(sell, [st('15m', 'bull'), st('1h', 'bull')], 'filter');
    expect(r.decision?.side).toBe('SELL');
    expect(r.decision?.strength).toBe(30);
  });

  it('score mode never blocks and clamps to 0..100', () => {
    const r = applyMtf(buy, [st('15m', 'bear'), st('1h', 'bear')], 'score');
    expect(r.decision?.strength).toBe(30);
    expect(applyMtf({ ...buy, strength: 95 }, [st('15m', 'bull'), st('1h', 'bull')], 'score').decision?.strength).toBe(100);
  });

  it('no decision stays null', () => {
    expect(applyMtf(null, [st('1h', 'bull')], 'filter').decision).toBeNull();
  });
});
