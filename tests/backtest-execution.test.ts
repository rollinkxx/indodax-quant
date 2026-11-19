import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  finalizeEndOfDataTrade,
  resolveProtectiveExit,
} from '../scripts/backtest-execution';

const finalCandle = (patch: Partial<Candle> = {}): Candle => ({
  t: 300, o: 108, h: 112, l: 107, c: 110, v: 12, n: 7, source: 'history', ...patch,
});

describe('finalizeEndOfDataTrade', () => {
  it('marks an open position out with exit slippage and exit fee included', () => {
    const trade = finalizeEndOfDataTrade(
      'btcidr',
      { qty: 2, entry: 100, cost: 202, entryTime: 300 },
      finalCandle(),
      100,
      0.1,
    );

    expect(trade).toMatchObject({
      pair: 'btcidr',
      entry: 100,
      exit: 108.9,
      cost: 202,
      reason: 'END_OF_DATA',
      entryTime: 300,
      exitTime: 300,
    });
    expect(trade.pnl).toBeCloseTo(15.58, 8);
  });

  it('rejects zero-volume candles for end-of-data execution marks', () => {
    const position = { qty: 1, entry: 100, cost: 101, entryTime: 300 };
    expect(() => finalizeEndOfDataTrade(
      'btcidr', position, finalCandle({ v: 0 }), 0, 0.1,
    )).toThrow('Invalid end-of-data trade inputs');
  });

  it('rejects synthetic or pre-entry final candles rather than fabricating an exit', () => {
    const position = { qty: 1, entry: 100, cost: 101, entryTime: 300 };
    expect(() => finalizeEndOfDataTrade(
      'btcidr', position, finalCandle({ source: 'synthetic' }), 0, 0.1,
    )).toThrow('Invalid end-of-data trade inputs');
    expect(() => finalizeEndOfDataTrade(
      'btcidr', position, finalCandle({ t: 240 }), 0, 0.1,
    )).toThrow('Invalid end-of-data trade inputs');
  });
});

describe('resolveProtectiveExit', () => {
  it('uses stop-loss first when one candle touches both stop and target', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 106, l: 94, c: 101 }), undefined, 0);
    expect(result).toEqual({ price: 95, reason: 'STOP_LOSS' });
  });

  it('fills below the trigger when the stop is pierced, modelling once-per-run bid sampling', () => {
    // 0.45% of 95 is 0.4275, so the fill is 94.5725 rather than the optimistic 95.
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 106, l: 94, c: 101 }), undefined, 0.45);
    expect(result).toEqual({ price: 94.5725, reason: 'STOP_LOSS' });
  });

  it('never assumes a fill worse than the bar low', () => {
    // The bar only reached 94.8, so a 0.45% overshoot past 95 (94.5725) is not attainable.
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 106, l: 94.8, c: 95.5 }), undefined, 0.45);
    expect(result!.price).toBe(94.8);
  });

  it('defaults to the measured overshoot rather than filling at the trigger', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 106, l: 94, c: 101 }));
    expect(result!.price).toBeLessThan(95);
    expect(result!.reason).toBe('STOP_LOSS');
  });

  it('fills a target at the level or better, never worse, despite the stop overshoot', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 108, l: 99, c: 107 }), undefined, 0.45);
    expect(result).toEqual({ price: 105, reason: 'TAKE_PROFIT' });
  });

  it('fills at the candle open when price gaps through the stop', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 92, h: 98, l: 90, c: 94 }), undefined, 0.45);
    expect(result).toEqual({ price: 92, reason: 'STOP_LOSS' });
  });

  it('fills at target when target is touched and stop is not', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 108, l: 99, c: 107 }), undefined, 0.45);
    expect(result).toEqual({ price: 105, reason: 'TAKE_PROFIT' });
  });

  it('rejects zero-volume candles as executable protective exits', () => {
    expect(() => resolveProtectiveExit(95, 105, finalCandle({ v: 0 })))
      .toThrow('Invalid protective exit inputs');
  });

  it('rejects synthetic candles', () => {
    expect(() => resolveProtectiveExit(95, 105, finalCandle({ source: 'synthetic' })))
      .toThrow('Invalid protective exit inputs');
  });
});

describe('resolveProtectiveExit trailing stop attribution', () => {
  it('reports a stop ratcheted above entry as TRAILING_STOP', () => {
    const result = resolveProtectiveExit(102, 120, finalCandle({ o: 104, h: 105, l: 101, c: 103 }), 100, 0);
    expect(result).toEqual({ price: 102, reason: 'TRAILING_STOP' });
  });

  it('keeps a stop at or below entry as STOP_LOSS', () => {
    expect(resolveProtectiveExit(95, 120, finalCandle({ o: 96, h: 99, l: 94, c: 97 }), 100, 0))
      .toEqual({ price: 95, reason: 'STOP_LOSS' });
  });

  it('defaults to STOP_LOSS when no entry is supplied', () => {
    expect(resolveProtectiveExit(95, 120, finalCandle({ o: 96, h: 99, l: 94, c: 97 }), undefined, 0))
      .toEqual({ price: 95, reason: 'STOP_LOSS' });
  });
});
