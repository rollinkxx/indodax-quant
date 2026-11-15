import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import { finalizeEndOfDataTrade } from '../scripts/backtest-execution';

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
