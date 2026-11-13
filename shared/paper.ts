// Paper trading maths. Pure functions; balance mutations happen atomically in Postgres RPCs.
import type { StrategyParams } from './strategy';

export const QTY_DECIMALS = 8;

export function roundDown(x: number, decimals = QTY_DECIMALS): number {
  const f = 10 ** decimals;
  return Math.floor(x * f + 1e-9) / f;
}

export function round(x: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/** Simulated market BUY fills at the ask plus slippage. */
export function buyFillPrice(ask: number, slippageBps: number): number {
  return ask * (1 + slippageBps / 10_000);
}

/** Simulated market SELL fills at the bid minus slippage. */
export function sellFillPrice(bid: number, slippageBps: number): number {
  return bid * (1 - slippageBps / 10_000);
}

export function feeFor(notional: number, feePct: number): number {
  return round(notional * feePct / 100, 2);
}

export interface Stops {
  stopLoss: number;
  takeProfit: number;
  method: 'atr' | 'percent';
}

export function computeStops(entry: number, atrValue: number | null, p: StrategyParams): Stops {
  if (atrValue !== null && atrValue > 0) {
    const sl = entry - atrValue * p.atrStopMultiplier;
    const tp = entry + atrValue * p.atrTakeProfitMultiplier;
    // ATR stop must be meaningful but not absurd (between 0.2% and 30% away)
    const dist = (entry - sl) / entry;
    if (sl > 0 && dist >= 0.002 && dist <= 0.3) return { stopLoss: sl, takeProfit: tp, method: 'atr' };
  }
  return {
    stopLoss: entry * (1 - p.fallbackStopPct / 100),
    takeProfit: entry * (1 + p.fallbackTakeProfitPct / 100),
    method: 'percent',
  };
}

export interface SizingInput {
  equity: number;
  cash: number;
  entry: number; // expected fill price
  stopLoss: number;
  params: StrategyParams;
  minNotional?: number; // INDODAX trade_min_base_currency (IDR)
}

export interface SizingResult {
  qty: number;
  notional: number;
  fee: number;
  cost: number;
  riskAmount: number;
  reason?: string;
}

/** Fixed-fractional sizing: risk `riskPerTradePct` of equity to the stop, capped by maxPositionPct and available cash. */
export function positionSize(i: SizingInput): SizingResult {
  const p = i.params;
  const zero = (reason: string): SizingResult => ({ qty: 0, notional: 0, fee: 0, cost: 0, riskAmount: 0, reason });
  if (!(i.entry > 0) || !(i.equity > 0) || !(i.cash > 0)) return zero('invalid_inputs');
  if (!(i.stopLoss > 0) || i.stopLoss >= i.entry) return zero('invalid_stop');
  const riskAmount = i.equity * p.riskPerTradePct / 100;
  const perUnitRisk = (i.entry - i.stopLoss) + i.entry * (p.feePct / 100) * 2;
  const qtyByRisk = riskAmount / perUnitRisk;
  const maxNotional = Math.min(i.equity * p.maxPositionPct / 100, i.cash / (1 + p.feePct / 100));
  const qty = roundDown(Math.min(qtyByRisk, maxNotional / i.entry));
  const notional = round(qty * i.entry);
  const fee = feeFor(notional, p.feePct);
  const min = i.minNotional ?? 10_000;
  if (qty <= 0 || notional < min) return zero('below_min_notional');
  if (notional + fee > i.cash) return zero('insufficient_cash');
  return { qty, notional, fee, cost: notional + fee, riskAmount };
}

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

export function exitReason(pos: { stop_loss: number | string | null; take_profit: number | string | null }, bid: number): ExitReason | null {
  const sl = pos.stop_loss === null ? null : Number(pos.stop_loss);
  const tp = pos.take_profit === null ? null : Number(pos.take_profit);
  if (sl !== null && bid <= sl) return 'STOP_LOSS';
  if (tp !== null && bid >= tp) return 'TAKE_PROFIT';
  return null;
}

/** Realised PnL of a long round trip, net of both fees. Mirrors paper_close_position(). */
export function roundTripPnl(qty: number, entryFill: number, entryFee: number, exitFill: number, exitFee: number): number {
  const cost = round(qty * entryFill) + entryFee;
  const proceeds = round(qty * exitFill) - exitFee;
  return round(proceeds - cost);
}

export interface RiskInput {
  equity: number;
  peakEquity: number;
  dayStartEquity: number | null;
  params: StrategyParams;
}

export interface RiskState {
  drawdownPct: number;
  dailyPnlPct: number;
  killSwitch: boolean;
  blockEntries: boolean;
  reasons: string[];
}

export function riskState(i: RiskInput): RiskState {
  const peak = Math.max(i.peakEquity, i.equity);
  const drawdownPct = peak > 0 ? (peak - i.equity) / peak * 100 : 0;
  const start = i.dayStartEquity && i.dayStartEquity > 0 ? i.dayStartEquity : i.equity;
  const dailyPnlPct = (i.equity - start) / start * 100;
  const reasons: string[] = [];
  const killSwitch = drawdownPct >= i.params.maxDrawdownPct;
  if (killSwitch) reasons.push(`max drawdown ${drawdownPct.toFixed(2)}% >= ${i.params.maxDrawdownPct}%`);
  const dailyBlock = -dailyPnlPct >= i.params.dailyLossLimitPct;
  if (dailyBlock) reasons.push(`daily loss ${(-dailyPnlPct).toFixed(2)}% >= ${i.params.dailyLossLimitPct}%`);
  return { drawdownPct, dailyPnlPct, killSwitch, blockEntries: killSwitch || dailyBlock, reasons };
}

export interface ClosedTrade {
  realized_pnl: number | string | null;
  cost_basis: number | string;
}

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgReturnPct: number;
  profitFactor: number | null;
  best: number;
  worst: number;
}

export function computeStats(closed: ClosedTrade[]): PerformanceStats {
  const pnls = closed.map((c) => Number(c.realized_pnl ?? 0));
  const rets = closed.map((c, i) => (Number(c.cost_basis) > 0 ? pnls[i] / Number(c.cost_basis) * 100 : 0));
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  return {
    trades: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: pnls.length ? wins.length / pnls.length * 100 : 0,
    totalPnl: round(total, 2),
    avgPnl: pnls.length ? round(total / pnls.length, 2) : 0,
    avgReturnPct: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    best: pnls.length ? Math.max(...pnls) : 0,
    worst: pnls.length ? Math.min(...pnls) : 0,
  };
}
