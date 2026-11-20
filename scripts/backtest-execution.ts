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
  /** Quoted spread at the final candle; the forced exit crosses the book like any other exit. */
  spreadPct = 0,
): FinalizedBacktestTrade {
  if (
    !pair ||
    !Number.isFinite(position.qty) || position.qty <= 0 ||
    !Number.isFinite(position.entry) || position.entry <= 0 ||
    !Number.isFinite(position.cost) || position.cost <= 0 ||
    !Number.isFinite(position.entryTime) ||
    candle.source === 'synthetic' ||
    candle.v <= 0 ||
    !isValidCandle(candle) ||
    candle.t < position.entryTime ||
    !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10_000 ||
    !Number.isFinite(feePct) || feePct < 0 ||
    !Number.isFinite(spreadPct) || spreadPct < 0
  ) {
    throw new Error('Invalid end-of-data trade inputs');
  }

  const exit = sellFillPrice(candle.c, slippageBps) * (1 - spreadPct / 200);
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


export interface ProtectiveExit {
  price: number;
  reason: 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';
  /**
   * True when the bar touched both the stop and the target, so the intrabar path is unknown and
   * the stop-first rule below decided the outcome. Callers must count these: a strategy whose
   * results depend on how many ambiguous bars it produced is not measurable from 5m OHLC, and
   * silently treating them as ordinary losses hides that.
   */
  ambiguous?: boolean;
}

/**
 * Resolve stop/target touches using conservative OHLC ordering.
 * A gap beyond a level fills at the candle open; if both levels are touched,
 * stop-loss wins because candle data cannot reveal the intrabar path. The `ambiguous` flag marks
 * exactly that case so the caller can report it instead of counting it as a normal stop.
 */
export function resolveProtectiveExit(
  stopLoss: number,
  takeProfit: number,
  candle: Candle,
  entry?: number,
): ProtectiveExit | null {
  if (
    !Number.isFinite(stopLoss) || stopLoss <= 0 ||
    !Number.isFinite(takeProfit) || takeProfit <= 0 || stopLoss >= takeProfit ||
    candle.source === 'synthetic' || candle.v <= 0 || !isValidCandle(candle)
  ) throw new Error('Invalid protective exit inputs');

  if (candle.l <= stopLoss) {
    // A stop ratcheted above entry is attributed to the trailing stop, not the original stop.
    const trailed = entry !== undefined && Number.isFinite(entry) && stopLoss > entry;
    const exit: ProtectiveExit = {
      price: candle.o < stopLoss ? candle.o : stopLoss,
      reason: trailed ? 'TRAILING_STOP' : 'STOP_LOSS',
    };
    if (candle.h >= takeProfit) exit.ambiguous = true;
    return exit;
  }
  if (candle.h >= takeProfit) {
    return { price: candle.o > takeProfit ? candle.o : takeProfit, reason: 'TAKE_PROFIT' };
  }
  return null;
}
