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

/** Thin pairs fill worse than the flat assumption: scale slippage by 24h IDR volume tier. */
export function dynamicSlippageBps(base: number, volIdr: number | null | undefined): number {
  if (volIdr === null || volIdr === undefined || !Number.isFinite(volIdr) || volIdr <= 0) return base * 4;
  if (volIdr < 5e8) return base * 4;
  if (volIdr < 2e9) return base * 2.5;
  if (volIdr < 1e10) return base * 1.5;
  return base;
}

export function feeFor(notional: number, feePct: number): number {
  return round(notional * feePct / 100, 2);
}

/**
 * Per-side fee (percentage points) actually charged for a pair.
 * 'assumption' always uses `feePct`. 'pair_taker' uses the pair's real INDODAX taker fee when it
 * is a valid non-negative number, otherwise falls back to `feePct`. Exit-side callers use this so a
 * missing catalog value cannot abort a close that must happen; entries use `entryFeePct`, which
 * rejects instead of falling back. A taker fee of exactly 0 is honoured (some zero-fee campaigns).
 */
export function effectiveFeePct(
  p: Pick<StrategyParams, 'feeModel' | 'feePct'>,
  pairTakerFeePct: number | null | undefined,
): number {
  if (p.feeModel !== 'pair_taker') return p.feePct;
  if (pairTakerFeePct === null || pairTakerFeePct === undefined) return p.feePct;
  const taker = Number(pairTakerFeePct);
  return Number.isFinite(taker) && taker >= 0 ? taker : p.feePct;
}

/**
 * Entry-side fee resolution. Unlike `effectiveFeePct`, a missing/invalid per-pair taker fee is a
 * hard rejection under 'pair_taker' instead of a silent fallback: falling back would under-charge
 * the round trip and let the net reward/risk gate pass trades that cannot pay for themselves.
 */
export function entryFeePct(
  p: Pick<StrategyParams, 'feeModel' | 'feePct'>,
  pairTakerFeePct: number | null | undefined,
): { pct: number } | { reason: 'missing_pair_fee' } {
  if (p.feeModel !== 'pair_taker') return { pct: p.feePct };
  if (pairTakerFeePct === null || pairTakerFeePct === undefined) return { reason: 'missing_pair_fee' };
  const taker = Number(pairTakerFeePct);
  return Number.isFinite(taker) && taker >= 0 ? { pct: taker } : { reason: 'missing_pair_fee' };
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
  exitSlippageBps?: number; // expected slippage when the stop fills (adds to the per-unit risk)
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
  const perUnitRisk = (i.entry - i.stopLoss) + i.entry * (p.feePct / 100) * 2 + i.stopLoss * ((i.exitSlippageBps ?? 0) / 10_000);
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

export interface EntryGateInput {
  bid: number;
  ask: number;
  signalPrice: number; // close of the signal candle
  stopLoss: number;
  fill: number; // expected BUY fill (ask + slippage)
}

/**
 * Execution-quality gate evaluated at entry time against the live quote. Returns a skip reason or null.
 * - wide_spread: spread (% of mid) above maxEntrySpreadPct.
 * - price_drift: ask moved more than maxEntryDriftPct above the signal candle close.
 * - stop_inside_spread: the exit side (bid) is already at/below the stop, or the spread alone would eat
 *   more than half of the stop distance -> the position would be stopped out by the quote, not by price action.
 */
export function entryGate(i: EntryGateInput, p: Pick<StrategyParams, 'maxEntrySpreadPct' | 'maxEntryDriftPct'>): string | null {
  if (!(i.bid > 0) || !(i.ask >= i.bid)) return 'bad_quote';
  const mid = (i.bid + i.ask) / 2;
  const spread = (i.ask - i.bid) / mid * 100;
  if (p.maxEntrySpreadPct > 0 && spread > p.maxEntrySpreadPct) return 'wide_spread';
  if (p.maxEntryDriftPct > 0 && i.signalPrice > 0 && (i.ask - i.signalPrice) / i.signalPrice * 100 > p.maxEntryDriftPct) return 'price_drift';
  if (i.bid <= i.stopLoss) return 'stop_inside_spread';
  const stopDist = i.fill - i.stopLoss;
  if (stopDist > 0 && (i.ask - i.bid) > stopDist * 0.5) return 'stop_inside_spread';
  return null;
}

export interface NetRewardRiskInput {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  feePct: number;
  exitSlippageBps: number;
}

/** Minimum expected net reward per unit of net stop-loss risk. */
export const MIN_NET_REWARD_RISK_RATIO = 1;

export interface NetRewardRiskDiagnostics {
  reason: string | null;
  metrics: {
    entry_price: number;
    stop_loss: number;
    take_profit: number;
    fee_pct: number;
    exit_slippage_bps: number;
    entry_cost_per_unit: number;
    stop_exit_fill: number;
    target_exit_fill: number;
    net_risk_per_unit: number;
    net_reward_per_unit: number;
    net_reward_risk_ratio: number;
    gross_stop_distance_pct: number;
    gross_target_distance_pct: number;
  };
}

/**
 * Calculates the exact economics used by the entry gate and exposes its components for
 * rejection audits. Invalid inputs return finite zero-valued derived metrics so they can
 * be safely persisted to JSONB without NaN/Infinity.
 */
export function netRewardRiskDiagnostics(i: NetRewardRiskInput): NetRewardRiskDiagnostics {
  const finite = (value: number) => Number.isFinite(value) ? value : 0;
  const metrics: NetRewardRiskDiagnostics['metrics'] = {
    entry_price: finite(i.entry),
    stop_loss: finite(i.stopLoss),
    take_profit: finite(i.takeProfit),
    fee_pct: finite(i.feePct),
    exit_slippage_bps: finite(i.exitSlippageBps),
    entry_cost_per_unit: 0,
    stop_exit_fill: 0,
    target_exit_fill: 0,
    net_risk_per_unit: 0,
    net_reward_per_unit: 0,
    net_reward_risk_ratio: 0,
    gross_stop_distance_pct: 0,
    gross_target_distance_pct: 0,
  };

  if (
    ![i.entry, i.stopLoss, i.takeProfit, i.feePct, i.exitSlippageBps].every(Number.isFinite) ||
    !(i.entry > 0) || !(i.stopLoss > 0) || i.stopLoss >= i.entry || !(i.takeProfit > i.entry) ||
    i.feePct < 0 || i.feePct >= 100 || i.exitSlippageBps < 0 || i.exitSlippageBps >= 10_000
  ) return { reason: 'invalid_reward_risk_inputs', metrics };

  // Entry is already the simulated ask + entry slippage fill. Model each possible exit at
  // its stop/target trigger less exit slippage, then deduct the fee on each side.
  const entryCost = i.entry * (1 + i.feePct / 100);
  const stopExitFill = sellFillPrice(i.stopLoss, i.exitSlippageBps);
  const targetExitFill = sellFillPrice(i.takeProfit, i.exitSlippageBps);
  const netStopProceeds = stopExitFill * (1 - i.feePct / 100);
  const netTargetProceeds = targetExitFill * (1 - i.feePct / 100);
  const netRisk = entryCost - netStopProceeds;
  const netReward = netTargetProceeds - entryCost;
  const ratio = netRisk > 0 ? netReward / netRisk : 0;

  metrics.entry_cost_per_unit = finite(entryCost);
  metrics.stop_exit_fill = finite(stopExitFill);
  metrics.target_exit_fill = finite(targetExitFill);
  metrics.net_risk_per_unit = finite(netRisk);
  metrics.net_reward_per_unit = finite(netReward);
  metrics.net_reward_risk_ratio = finite(ratio);
  metrics.gross_stop_distance_pct = finite((i.entry - i.stopLoss) / i.entry * 100);
  metrics.gross_target_distance_pct = finite((i.takeProfit - i.entry) / i.entry * 100);

  if (!(netRisk > 0) || !Number.isFinite(netRisk)) return { reason: 'invalid_reward_risk_inputs', metrics };
  if (!(netReward > 0) || !Number.isFinite(netReward)) return { reason: 'net_reward_non_positive', metrics };
  if (ratio < MIN_NET_REWARD_RISK_RATIO) return { reason: 'net_reward_risk_below_minimum', metrics };
  return { reason: null, metrics };
}

/** Blocks an entry when expected net reward does not justify net stop risk. */
export function netRewardRiskGate(i: NetRewardRiskInput): string | null {
  return netRewardRiskDiagnostics(i).reason;
}

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

/** Ratchets the stop up (never down) once price is far enough above entry. Returns the new stop or null. */
export function trailingStop(
  pos: { entry_price: number | string; stop_loss: number | string | null },
  bid: number,
  atrValue: number | null,
  p: Pick<StrategyParams, 'trailingStopEnabled' | 'trailActivationAtr' | 'trailDistanceAtr'>,
): number | null {
  if (!p.trailingStopEnabled || atrValue === null || !(atrValue > 0)) return null;
  const entry = Number(pos.entry_price);
  if (!(bid >= entry + p.trailActivationAtr * atrValue)) return null;
  const candidate = bid - p.trailDistanceAtr * atrValue;
  const current = pos.stop_loss === null ? 0 : Number(pos.stop_loss);
  return candidate > current && candidate < bid ? candidate : null;
}

/** True when the position has been open longer than the configured time stop. */
export function timeStopHit(openedAtMs: number | null, nowMs: number, p: Pick<StrategyParams, 'timeStopMinutes'>): boolean {
  if (!p.timeStopMinutes || p.timeStopMinutes <= 0 || openedAtMs === null || !Number.isFinite(openedAtMs)) return false;
  return nowMs - openedAtMs >= p.timeStopMinutes * 60_000;
}

/** Total open cost basis (plus a candidate) must stay under maxTotalExposurePct of equity. */
export function exposureAllows(openCost: number, newCost: number, equity: number, p: Pick<StrategyParams, 'maxTotalExposurePct'>): boolean {
  return equity > 0 && openCost + newCost <= equity * p.maxTotalExposurePct / 100;
}

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
  dailyLossHit: boolean;
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
  return { drawdownPct, dailyPnlPct, killSwitch, dailyLossHit: dailyBlock, blockEntries: killSwitch || dailyBlock, reasons };
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
