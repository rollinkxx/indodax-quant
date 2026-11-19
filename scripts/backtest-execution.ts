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
    candle.v <= 0 ||
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


export interface ProtectiveExit {
  price: number;
  reason: 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';
}

/**
 * Fraction of the stop distance the fill is expected to overshoot the trigger.
 *
 * The paper engine does not rest a stop order at the exchange: it samples the bid once per run
 * (every minute) and closes at whatever bid it observes. A bar whose low pierces the stop
 * therefore fills below the trigger by an amount the OHLC cannot reveal. Filling at the stop
 * itself — the previous behaviour — was optimistic by construction and is the single largest
 * source of divergence from live results.
 *
 * Measured on production paper_positions (13 trades of the active config): 11 of 13 exits
 * pierced the stop, overshooting by 0.454% of the stop price on average, which accounted for
 * Rp122,148 of a Rp238,042 loss. Applied as a percentage of price, matching how it was measured.
 */
export const DEFAULT_STOP_OVERSHOOT_PCT = 0.45;

/** Fill price for a stop that has been pierced: the trigger less the overshoot, floored at the bar low. */
function stopFillPrice(stopLoss: number, candle: Candle, overshootPct: number): number {
  // A gap through the level fills at the open, which is already worse than the trigger.
  if (candle.o <= stopLoss) return candle.o;
  const pierced = stopLoss * (1 - overshootPct / 100);
  // Never assume a fill worse than the bar demonstrably traded at.
  return Math.max(pierced, candle.l);
}

/**
 * Resolve stop/target touches using conservative OHLC ordering.
 * A gap beyond a level fills at the candle open; if both levels are touched,
 * stop-loss wins because candle data cannot reveal the intrabar path.
 *
 * `stopOvershootPct` models the paper engine's once-per-run bid sampling (see
 * DEFAULT_STOP_OVERSHOOT_PCT). Set it to 0 for the old optimistic fill-at-trigger behaviour.
 */
export function resolveProtectiveExit(
  stopLoss: number,
  takeProfit: number,
  candle: Candle,
  entry?: number,
  stopOvershootPct: number = DEFAULT_STOP_OVERSHOOT_PCT,
): ProtectiveExit | null {
  if (
    !Number.isFinite(stopLoss) || stopLoss <= 0 ||
    !Number.isFinite(takeProfit) || takeProfit <= 0 || stopLoss >= takeProfit ||
    candle.source === 'synthetic' || candle.v <= 0 || !isValidCandle(candle) ||
    !Number.isFinite(stopOvershootPct) || stopOvershootPct < 0
  ) throw new Error('Invalid protective exit inputs');

  if (candle.l <= stopLoss) {
    // A stop ratcheted above entry is attributed to the trailing stop, not the original stop.
    const trailed = entry !== undefined && Number.isFinite(entry) && stopLoss > entry;
    return {
      price: stopFillPrice(stopLoss, candle, stopOvershootPct),
      reason: trailed ? 'TRAILING_STOP' : 'STOP_LOSS',
    };
  }
  if (candle.h >= takeProfit) {
    // A target is a resting limit: it fills at the level or better, never worse.
    return { price: candle.o > takeProfit ? candle.o : takeProfit, reason: 'TAKE_PROFIT' };
  }
  return null;
}
