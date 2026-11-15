import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import { aggregateCompleteMinuteHistory, createBacktestHistoryRange, filterBacktestCandlesToRange, mergeBacktestCandles, summarizeMinuteHistoryQuality, createRequestStartLimiter } from '../scripts/backtest-history';

const minute = (t: number, patch: Partial<Candle> = {}): Candle => ({
  t, o: 100 + t / 60, h: 102 + t / 60, l: 99 + t / 60,
  c: 101 + t / 60, v: 1, n: 0, source: 'history', ...patch,
});

describe('aggregateCompleteMinuteHistory', () => {
  it('aggregates only complete five-minute groups with correct OHLCV', () => {
    const oneMinute = Array.from({ length: 10 }, (_, i) =>
      minute(i * 60, { o: 100 + i, h: 105 + i, l: 98 + i, c: 101 + i, v: i + 1 }),
    );
    const result = aggregateCompleteMinuteHistory(oneMinute, 0, 600);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      t: 0, o: 100, h: 109, l: 98, c: 105, v: 15, source: 'history',
    });
    expect(result[1]).toMatchObject({
      t: 300, o: 105, h: 114, l: 103, c: 110, v: 40, source: 'history',
    });
  });

  it('drops partial buckets when one or more 1m bars are missing', () => {
    const bars = [0, 60, 180, 240, 300, 360, 420, 480, 540].map((t) => minute(t));
    const result = aggregateCompleteMinuteHistory(bars, 0, 600);

    expect(result.map((c) => c.t)).toEqual([300]);
  });

  it('excludes synthetic, invalid, unaligned, and not-yet-closed minute bars', () => {
    const bars = Array.from({ length: 5 }, (_, i) => minute(i * 60));
    bars[2] = minute(120, { source: 'synthetic', v: 0 });
    const result = aggregateCompleteMinuteHistory(
      [...bars, minute(300), minute(361)],
      0,
      300,
    );
    expect(result).toEqual([]);
  });

  it('does not construct a bar for a bucket outside the requested range', () => {
    const bars = Array.from({ length: 10 }, (_, i) => minute(i * 60));
    expect(aggregateCompleteMinuteHistory(bars, 300, 600).map((c) => c.t)).toEqual([300]);
  });
});

describe('mergeBacktestCandles', () => {
  it('prefers trade-built bars over history at the same timestamp', () => {
    const history = minute(0, { t: 0, o: 100, c: 101 });
    const trade: Candle = { ...history, o: 102, h: 104, c: 103, source: 'trades' };
    const result = mergeBacktestCandles([history], [trade]);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('trades');
    expect(result[0].o).toBe(102);
  });

  it('prefers newly validated complete history over older persisted history', () => {
    const current: Candle = { ...minute(0), o: 100, c: 101, source: 'history' };
    const older: Candle = { ...minute(0), o: 110, c: 111, source: 'history' };
    const result = mergeBacktestCandles([current], [older]);
    expect(result[0].o).toBe(100);
    expect(result[0].c).toBe(101);
  });

  it('uses history for missing timestamps and ignores synthetic rows', () => {
    const old = minute(0);
    const synthetic: Candle = { ...minute(300), source: 'synthetic', v: 0 };
    const recent: Candle = { ...minute(600), source: 'trades' };
    const result = mergeBacktestCandles([old], [synthetic, recent]);
    expect(result.map((c) => c.t)).toEqual([0, 600]);
    expect(result.every((c) => c.source !== 'synthetic')).toBe(true);
  });
});


describe('filterBacktestCandlesToRange', () => {
  it('keeps only observed candles inside the half-open evaluation window', () => {
    const candles = [
      minute(0),
      minute(300, { source: 'trades' }),
      minute(600),
      minute(900),
      minute(1200, { source: 'synthetic', v: 0 }),
    ];
    const result = filterBacktestCandlesToRange(candles, 300, 900);
    expect(result.map((c) => c.t)).toEqual([300, 600]);
    expect(result[0].source).toBe('trades');
  });

  it('rejects invalid time ranges', () => {
    expect(() => filterBacktestCandlesToRange([], 600, 300)).toThrow('Invalid backtest candle range');
  });
});


describe('createBacktestHistoryRange', () => {
  it('anchors an exact, 5-minute-aligned interval once for every pair in the run', () => {
    const nowMs = Date.parse('2026-11-15T15:22:59.999Z');
    const range = createBacktestHistoryRange(30, nowMs);
    const expectedToSec = Math.floor(Math.floor(nowMs / 1000) / 300) * 300;

    expect(range).toEqual({
      days: 30,
      fromSec: expectedToSec - 30 * 86_400,
      toSec: expectedToSec,
    });
    expect(range.toSec % 300).toBe(0);
    expect(range.toSec - range.fromSec).toBe(30 * 86_400);
  });

  it('rejects invalid day counts and timestamps', () => {
    expect(() => createBacktestHistoryRange(0, Date.now())).toThrow('Invalid backtest history range inputs');
    expect(() => createBacktestHistoryRange(181, Date.now())).toThrow('Invalid backtest history range inputs');
    expect(() => createBacktestHistoryRange(30, Number.NaN)).toThrow('Invalid backtest history range inputs');
  });
});


describe('summarizeMinuteHistoryQuality', () => {
  it('separates full OHLC availability from actual positive-volume trading bars', () => {
    const oneMinute = Array.from({ length: 10 }, (_, i) =>
      minute(i * 60, { v: i < 5 ? 0 : 2 }),
    );
    const complete5m = aggregateCompleteMinuteHistory(oneMinute, 0, 600);
    const report = summarizeMinuteHistoryQuality(
      [...oneMinute, oneMinute[0]], // exact duplicate timestamp is counted, never double-counted
      0,
      600,
      complete5m,
    );

    expect(complete5m).toHaveLength(2);
    expect(report).toMatchObject({
      receivedMinuteBars: 11,
      expectedMinuteBars: 10,
      uniqueValidMinuteBars: 10,
      duplicateMinuteBars: 1,
      missingMinuteBars: 0,
      zeroVolumeMinuteBars: 5,
      zeroVolume5mBars: 1,
      activeVolume5mBars: 1,
      expected5mBars: 2,
      activeVolumeCoveragePct: 50,
    });
  });

  it('rejects invalid ranges', () => {
    expect(() => summarizeMinuteHistoryQuality([], 600, 300, [])).toThrow('Invalid minute history quality range');
  });
});


describe('createRequestStartLimiter', () => {
  it('spaces concurrent request starts using one shared clock', async () => {
    let clock = 1_000;
    const limiter = createRequestStartLimiter(
      500,
      () => clock,
      async (ms) => { clock += ms; },
    );

    const starts = await Promise.all(
      Array.from({ length: 4 }, () => limiter()),
    );
    expect(starts.sort((a, b) => a - b)).toEqual([1_000, 1_500, 2_000, 2_500]);
  });

  it('rejects invalid intervals', () => {
    expect(() => createRequestStartLimiter(0)).toThrow('positive finite number');
    expect(() => createRequestStartLimiter(Number.NaN)).toThrow('positive finite number');
  });

  it('releases the queue if the injected sleep fails', async () => {
    let fail = true;
    const limiter = createRequestStartLimiter(
      500,
      () => 1_000,
      async () => {
        if (fail) {
          fail = false;
          throw new Error('simulated sleep failure');
        }
      },
    );

    await limiter();
    await expect(limiter()).rejects.toThrow('simulated sleep failure');
    await expect(limiter()).resolves.toBe(1_000);
  });
});
