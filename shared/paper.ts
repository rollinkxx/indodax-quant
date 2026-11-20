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

/**
 * Thin pairs fill worse than the flat assumption: scale slippage by 24h IDR volume tier.
 *
 * `maxMultiplier` caps the penalty. Exits pass a lower cap than entries: when the volume is unknown
 * the tier alone would apply the worst case, and marking every stop out at 4x slippage made the paper
 * PnL worse than the market could deliver, which is just as misleading as being too optimistic.
 */
export function dynamicSlippageBps(
  base: number,
  volIdr: number | null | undefined,
  opts: { maxMultiplier?: number } = {},
): number {
  const cap = Number.isFinite(opts.maxMultiplier) && (opts.maxMultiplier as number) > 0 ? (opts.maxMultiplier as number) : 4;
  const tier = (() => {
    if (volIdr === null || volIdr === undefined || !Number.isFinite(volIdr) || volIdr <= 0) return 4;
    if (volIdr < 5e8) return 4;
    if (volIdr < 2e9) return 2.5;
    if (volIdr < 1e10) return 1.5;
    return 1;
  })();
  return base * Math.min(tier, cap);
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

/**
 * Whether a signal-driven exit would at least break even after the round trip.
 *
 * A SELL signal is a discretionary exit, unlike the stop-loss which defines the risk budget. When
 * the position is already underwater, paying another 0.2% fee and 10 bps of slippage to leave
 * converts a recoverable drawdown into a booked loss, and on 5m candles those exits averaged
 * -0.97% net against a 4.2% win rate. Withholding the exit leaves the stop in control.
 */
export function signalExitCoversCosts(input: {
  entryPrice: number;
  qty: number;
  costBasis: number;
  bid: number;
  feePct: number;
  slippageBps: number;
}): boolean {
  const { entryPrice, qty, costBasis, bid } = input;
  if (!(entryPrice > 0) || !(qty > 0) || !(bid > 0) || !Number.isFinite(costBasis)) return false;
  const fill = sellFillPrice(bid, input.slippageBps);
  const proceeds = qty * fill - feeFor(qty * fill, input.feePct);
  return proceeds >= costBasis;
}

/**
 * Round-trip cost in percentage points: both fees, expected slippage on each side, and the
 * quoted spread.
 *
 * The spread is a real round-trip cost, not a modelling nicety: entries fill at the ask and
 * exits at the bid, so a position must gain the full spread before it breaks even. Leaving it
 * out understated the break-even price on wide pairs, which let the trailing stop ratchet to a
 * level that still settled net negative. Callers without a live quote (the candle-only
 * backtest) pass 0 and keep the previous behaviour.
 */
export function roundTripCostPct(feePct: number, slippageBps: number, spreadPct = 0): number {
  const fee = Number.isFinite(feePct) && feePct > 0 ? feePct : 0;
  const slip = Number.isFinite(slippageBps) && slippageBps > 0 ? slippageBps / 100 : 0;
  const spread = Number.isFinite(spreadPct) && spreadPct > 0 ? spreadPct : 0;
  return fee * 2 + slip * 2 + spread;
}

/**
 * Whether a SELL signal should close an open position.
 *
 * A SELL is the only exit the engine can take before a stop or target is touched, so gating it on
 * "already profitable after costs" turns every adverse move into a wait for the stop: on 5m candles
 * the exits that did fire averaged -0.97% net against a 4.2% win rate. Costs still matter for the
 * *marginal* exit (a weak signal on a position that would book a loss), so the gate is graded
 * instead of binary:
 * - a risk block (kill switch / daily loss) exits regardless: protecting capital beats a fee;
 * - a drawdown at half the limit exits regardless: the position is the reason for the block;
 * - a strong signal exits regardless: it is the setup the strategy was built to obey;
 * - otherwise the configured policy decides, and by default a SELL that cannot cover the round trip
 *   is still withheld so the stop keeps control.
 */
export type SignalExitPolicy = {
  requireProfit: boolean;
  forceStrength: number;
  forceOnRiskBlock: boolean;
};

export function shouldExitOnSignal(input: {
  coversCosts: boolean;
  strength: number;
  riskBlocked: boolean;
  drawdownPct: number;
  maxDrawdownPct: number;
  policy: SignalExitPolicy;
}): { exit: boolean; reason: string } {
  const { coversCosts, strength, riskBlocked, drawdownPct, maxDrawdownPct, policy } = input;
  if (policy.forceOnRiskBlock && riskBlocked) return { exit: true, reason: 'risk_block' };
  if (maxDrawdownPct > 0 && drawdownPct >= maxDrawdownPct * 0.5) return { exit: true, reason: 'drawdown_half' };
  if (Number.isFinite(strength) && strength >= policy.forceStrength) return { exit: true, reason: 'strong_signal' };
  if (!policy.requireProfit) return { exit: true, reason: 'policy_off' };
  if (coversCosts) return { exit: true, reason: 'covers_costs' };
  return { exit: false, reason: 'below_cost' };
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
  // Risk per unit is the stop distance plus what the round trip actually costs: the entry fee on the
  // entry notional, the exit fee on the (lower) stop notional, and the exit slippage at the stop.
  const feePct = p.feePct / 100;
  const exitSlip = (i.exitSlippageBps ?? 0) / 10_000;
  const perUnitRisk =
    (i.entry - i.stopLoss)
    + i.entry * feePct
    + i.stopLoss * feePct
    + i.stopLoss * exitSlip;
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
  /** Minimum net reward per unit of net risk. Defaults to MIN_NET_REWARD_RISK_RATIO. */
  minRatio?: number;
}

/**
 * Default minimum expected net reward per unit of net stop-loss risk.
 *
 * This ratio decides the shape of the win/loss distribution. In a driftless market the probability
 * of touching the target before the stop is stopDistance / (stopDistance + targetDistance), so a
 * ratio of 1 caps the achievable hit rate at 50% before costs and far below that after them.
 * Lower ratios buy a higher hit rate at a lower payoff; raise it for the opposite. Override per
 * config with `minNetRewardRiskRatio` in StrategyParams.
 */
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
  const minRatio = Number.isFinite(i.minRatio) ? (i.minRatio as number) : MIN_NET_REWARD_RISK_RATIO;
  if (ratio < minRatio) return { reason: 'net_reward_risk_below_minimum', metrics };
  return { reason: null, metrics };
}

/** Blocks an entry when expected net reward does not justify net stop risk. */
export function netRewardRiskGate(i: NetRewardRiskInput): string | null {
  return netRewardRiskDiagnostics(i).reason;
}

export type ExitReason = 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT';

/** Ratchets the stop up (never down) once price is far enough above entry. Returns the new stop or null. */
export function trailingStop(
  pos: { entry_price: number | string; stop_loss: number | string | null },
  bid: number,
  atrValue: number | null,
  p: Pick<StrategyParams, 'trailingStopEnabled' | 'trailActivationAtr' | 'trailDistanceAtr'>,
  /** Round-trip cost in percent; the ratchet never sets a stop that would still lose after it. */
  costPct = 0,
): number | null {
  if (!p.trailingStopEnabled || atrValue === null || !(atrValue > 0)) return null;
  const entry = Number(pos.entry_price);
  if (!(bid >= entry + p.trailActivationAtr * atrValue)) return null;
  const candidate = bid - p.trailDistanceAtr * atrValue;
  // A stop below the break-even price locks in a loss the round trip has already decided.
  // On 5m candles 1x ATR is often ~0.2%, i.e. half the 0.4% taker round trip, so trailing
  // unguarded produced exits with a positive gross move that still settled net negative.
  const breakEven = entry * (1 + (Number.isFinite(costPct) && costPct > 0 ? costPct / 100 : 0));
  const floor = Math.max(entry, breakEven);
  const current = pos.stop_loss === null ? 0 : Number(pos.stop_loss);
  if (candidate <= Math.max(current, floor)) return null;
  return candidate < bid ? candidate : null;
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

/**
 * Protective exit for the current quote. A stop that has been ratcheted above entry by the
 * trailing stop is reported as TRAILING_STOP, not STOP_LOSS, so the exit is attributed to the
 * trail rather than to the original stop. This is an attribution fix, not a win/loss claim:
 * the stop sits above entry, but fees and slippage can still leave the trade net negative.
 * TAKE_PROFIT is checked first so a gap through both levels is attributed to the target.
 */
/**
 * Which bracket the bid touched, if any.
 *
 * `prevBid` is the bid from the previous run's snapshot. When the market gapped over both the stop
 * and the target between two runs, the observed bid alone cannot say which was hit first; the
 * pessimistic assumption (stop first) is the only one that does not book a fill the market never
 * offered. Without a previous bid the check is skipped and the old ordering applies.
 */
export function exitReason(
  pos: { entry_price?: number | string; stop_loss: number | string | null; take_profit: number | string | null },
  bid: number,
  prevBid: number | null = null,
): ExitReason | null {
  const sl = pos.stop_loss === null || pos.stop_loss === undefined ? null : Number(pos.stop_loss);
  const tp = pos.take_profit === null || pos.take_profit === undefined ? null : Number(pos.take_profit);
  const entry = pos.entry_price === undefined ? null : Number(pos.entry_price);
  if (sl !== null && tp !== null && prevBid !== null && Number.isFinite(prevBid) && prevBid < sl && bid > tp) {
    return entry !== null && Number.isFinite(entry) && sl > entry ? 'TRAILING_STOP' : 'STOP_LOSS';
  }
  if (tp !== null && bid >= tp) return 'TAKE_PROFIT';
  if (sl !== null && bid <= sl) {
    return entry !== null && Number.isFinite(entry) && sl > entry ? 'TRAILING_STOP' : 'STOP_LOSS';
  }
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
    best: pnls.length ? pnls.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY) : 0,
    worst: pnls.length ? pnls.reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY) : 0,
  };
}
