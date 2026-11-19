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
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 106, l: 94, c: 101 }));
    expect(result).toEqual({ price: 95, reason: 'STOP_LOSS' });
  });

  it('fills at the candle open when price gaps through the stop', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 92, h: 98, l: 90, c: 94 }));
    expect(result).toEqual({ price: 92, reason: 'STOP_LOSS' });
  });

  it('fills at target when target is touched and stop is not', () => {
    const result = resolveProtectiveExit(95, 105, finalCandle({ o: 100, h: 108, l: 99, c: 107 }));
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
    const result = resolveProtectiveExit(102, 120, finalCandle({ o: 104, h: 105, l: 101, c: 103 }), 100);
    expect(result).toEqual({ price: 102, reason: 'TRAILING_STOP' });
  });

  it('keeps a stop at or below entry as STOP_LOSS', () => {
    expect(resolveProtectiveExit(95, 120, finalCandle({ o: 96, h: 99, l: 94, c: 97 }), 100))
      .toEqual({ price: 95, reason: 'STOP_LOSS' });
  });

  it('defaults to STOP_LOSS when no entry is supplied', () => {
    expect(resolveProtectiveExit(95, 120, finalCandle({ o: 96, h: 99, l: 94, c: 97 })))
      .toEqual({ price: 95, reason: 'STOP_LOSS' });
  });
});

describe('finalizeEndOfDataTrade: quoted spread', () => {
  const pos = { qty: 10, entry: 100, cost: 1000, entryTime: 1_000 };
  const candle = { t: 2_000, o: 110, h: 111, l: 109, c: 110, v: 500, n: 3, source: 'trades' as const };

  it('crosses the book on the forced exit so the spread is not silently forgiven', () => {
    const tight = finalizeEndOfDataTrade('xidr', pos, candle, 0, 0);
    const wide = finalizeEndOfDataTrade('xidr', pos, candle, 0, 0, 2);
    expect(wide.exit).toBeCloseTo(tight.exit * (1 - 2 / 200), 10);
    expect(wide.pnl).toBeLessThan(tight.pnl);
  });

  it('defaults to a tight book when no spread is supplied', () => {
    expect(finalizeEndOfDataTrade('xidr', pos, candle, 0, 0).exit).toBe(110);
  });
});
