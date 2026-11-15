import { feeFor, sellFillPrice } from '../shared/paper';
import { isValidCandle, type Candle } from '../shared/candles';

export interface OpenBacktestPosition {
  qty: number;
  entry: number;
  cost: number;
  entryTime: number;
}

export interface FinalizedBacktestTrade {
  pair: string;
  entry: number;
  exit: number;
  pnl: number;
  cost: number;
  reason: 'END_OF_DATA';
  entryTime: number;
  exitTime: number;
}

/**
 * Realize an unfinished position at the final observed candle close.
 * Both exit slippage and exit fee are charged; this prevents silent omission
 * of positions that remain open when the historical sample ends.
 */
export function finalizeEndOfDataTrade(
  pair: string,
  position: OpenBacktestPosition,
  candle: Candle,
  slippageBps: number,
  feePct: number,
): FinalizedBacktestTrade {
  if (
    !pair ||
    !Number.isFinite(position.qty) || position.qty <= 0 ||
    !Number.isFinite(position.entry) || position.entry <= 0 ||
    !Number.isFinite(position.cost) || position.cost <= 0 ||
    !Number.isFinite(position.entryTime) ||
    candle.source === 'synthetic' ||
    !isValidCandle(candle) ||
    candle.t < position.entryTime ||
    !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10_000 ||
    !Number.isFinite(feePct) || feePct < 0
  ) {
    throw new Error('Invalid end-of-data trade inputs');
  }

  const exit = sellFillPrice(candle.c, slippageBps);
  const exitFee = feeFor(position.qty * exit, feePct);
  const pnl = position.qty * exit - exitFee - position.cost;
  return {
    pair,
    entry: position.entry,
    exit,
    pnl,
    cost: position.cost,
    reason: 'END_OF_DATA',
    entryTime: position.entryTime,
    exitTime: candle.t,
  };
}
