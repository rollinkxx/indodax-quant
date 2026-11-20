// Portfolio-chronology backtest: one global cash account across every pair.
//
// The per-pair `simulate()` gives each market its own starting balance, so pooled results hide the
// real constraints: a shared cash pool, a cap on concurrent positions, a total exposure ceiling, a
// daily-loss flatten and a drawdown kill switch. This engine walks a single timeline instead: at each
// timestamp it marks every pair, processes exits, applies risk, then ranks and sizes entries against
// the SAME cash balance. It reuses the production gates (`shared/paper.ts`) so fills, fees, stops and
// reward/risk stay in parity with the live paper engine.

import type { Candle } from './candles';
import { lastQuoteAtOrBefore, quoteFillPrice, type QuotePoint } from './quoteHistory';
import {
  computeStops, dynamicSlippageBps, effectiveFeePct, entryGate, exitReason, exposureAllows, feeFor,
  netRewardRiskDiagnostics, positionSize, roundTripCostPct, sellFillPrice, buyFillPrice,
  shouldExitOnSignal, signalExitCoversCosts, timeStopHit, trailingStop,
} from './paper';
import type { StrategyParams } from './strategy';
import { memberAt, type UniverseInterval } from './universe';

export interface PortfolioFillModel {
  /** Spread in bps charged on top of the candle price when no historical quote exists. */
  spreadBps: number;
  /** Fraction of a bar's volume we allow ourselves to trade (0–1). 1 = no participation limit. */
  participationRate: number;
  /** Extra adverse move per bar of latency, in bps. */
  latencyBps: number;
  /** Label shown in reports; `CANDLE_ONLY_OPTIMISTIC` when no historical bid/ask is available. */
  label: 'CANDLE_ONLY_OPTIMISTIC' | 'QUOTE_BASED';
  /** Oldest historical quote still usable to price an order, in seconds. */
  maxQuoteAgeSec?: number;
}

export const DEFAULT_FILL_MODEL: PortfolioFillModel = {
  spreadBps: 0,
  participationRate: 1,
  latencyBps: 0,
  label: 'CANDLE_ONLY_OPTIMISTIC',
};

export interface PortfolioPairInput {
  pair: string;
  candles: Candle[];
  /** 24h IDR volume proxy for dynamic slippage (historical tiers are unavailable). */
  volIdr: number | null;
  /** Pair taker fee for `feeModel='pair_taker'`; null = unknown. */
  pairTakerFeePct: number | null;
  /** Pair minimum order notional (IDR). */
  minNotional: number | null;
  /**
   * Timestamped universe membership. When supplied, a pair is only eligible for a NEW entry while
   * `effective_from <= t < effective_to`. Without it the run falls back to `inUniverse`, which applies
   * today's membership to the whole history and is reported as `universeIsTimestamped: false`.
   */
  universeIntervals?: readonly UniverseInterval[];
  /** Whether this pair was in the universe for the whole window (only used without intervals). */
  inUniverse?: boolean;
  /** Historical bid/ask captured by the pipeline, sorted or unsorted. Enables QUOTE_BASED fills. */
  quotes?: readonly QuotePoint[];
}

export interface PortfolioPosition {
  pair: string;
  qty: number;
  entry: number;
  cost: number;
  sl: number;
  tp: number;
  openedAtSec: number;
  entryBarT: number;
  regime: MarketRegime;
}

export interface PortfolioTrade {
  pair: string;
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  cost: number;
  reason: string;
  entryTime: number;
  exitTime: number;
  /**
   * Market regime at the signal bar, from a causal trend proxy. Without it the regime cluster
   * bootstrap collapses every trade into one 'unknown' bucket and reports a false precision.
   */
  regime: MarketRegime;
}

export type MarketRegime = 'uptrend' | 'downtrend' | 'range';

export interface PortfolioEquityPoint {
  t: number;
  equity: number;
  cash: number;
  grossExposure: number;
  openPositions: number;
}

export interface PortfolioRejection {
  pair: string;
  t: number;
  stage: string;
  reason: string;
}

export interface PortfolioResult {
  trades: PortfolioTrade[];
  equityCurve: PortfolioEquityPoint[];
  rejections: PortfolioRejection[];
  initialCash: number;
  finalEquity: number;
  peakEquity: number;
  maxDrawdownPct: number;
  maxConcurrentPositions: number;
  turnoverIdr: number;
  forcedEodExits: number;
  partialFills: number;
  rejectedOrders: number;
  killSwitchTripped: boolean;
  dailyLossFlattens: number;
  /** Time (bars) the equity curve spent below its running peak. */
  timeUnderWaterBars: number;
  fillModel: PortfolioFillModel;
  /**
   * Label actually earned by the run: `QUOTE_BASED` only when at least one fill was priced from a
   * stored quote and no fill silently fell back to a candle. A configured `QUOTE_BASED` model whose
   * quotes all turned out stale is still candle-only in practice, and must not be promoted.
   */
  effectiveFillLabel: 'CANDLE_ONLY_OPTIMISTIC' | 'QUOTE_BASED';
  /** True only when every pair carried membership intervals rather than a static flag. */
  universeIsTimestamped: boolean;
  /** Fills priced from a stored quote instead of a candle, and why the rest fell back. */
  quoteFills: number;
  quoteRejections: Record<string, number>;
}

interface Bar {
  t: number;
  pair: string;
  candle: Candle;
}

/**
 * Apply the fill model to a candle-based price. Without a real quote the spread and latency are the
 * only adverse components we can model, so they are added in the direction that hurts the order.
 */
function modelFill(price: number, side: 'BUY' | 'SELL', slippageBps: number, model: PortfolioFillModel): number {
  const halfSpreadBps = model.spreadBps / 2;
  const totalBps = slippageBps + model.latencyBps + halfSpreadBps;
  return side === 'BUY' ? buyFillPrice(price, totalBps) : sellFillPrice(price, totalBps);
}

/**
 * Run one shared-cash portfolio simulation across all pairs.
 *
 * Chronology per timestamp: mark-to-market → exits (stop/target/trail/time/signal) → daily-loss flatten
 * → drawdown kill switch → ranked entries against remaining cash/exposure. Signals are read from the
 * previous completed bar and fills occur at the next bar, mirroring `simulate()`.
 */
export function simulatePortfolio(
  pairs: PortfolioPairInput[],
  p: StrategyParams,
  opts: {
    initialCash: number;
    fillModel?: PortfolioFillModel;
    /** Signal function: (pair, candles, index) => 'BUY' | 'SELL' | 'HOLD'. */
    signal: (pair: string, candles: Candle[], index: number) => 'BUY' | 'SELL' | 'HOLD';
    startIndex?: number;
  },
): PortfolioResult {
  const fillModel = opts.fillModel ?? DEFAULT_FILL_MODEL;
  const initialCash = opts.initialCash;
  let cash = initialCash;
  const startIndex = Math.max(0, Math.floor(opts.startIndex ?? 0));

  // Build one merged, time-ordered timeline. Each entry remembers the pair's own bar index so the
  // signal function can look back within that pair without crossing into another market.
  const timeline: (Bar & { index: number })[] = [];
  const candlesByPair = new Map<string, Candle[]>();
  const volByPair = new Map<string, number | null>();
  const feeByPair = new Map<string, number>();
  const minNotionalByPair = new Map<string, number | null>();
  const slipByPair = new Map<string, number>();
  const intervalsByPair = new Map<string, UniverseInterval[]>();
  const universeFallback = new Map<string, boolean>();
  let universeIsTimestamped = true;
  for (const input of pairs) {
    const candles = input.candles;
    candlesByPair.set(input.pair, candles);
    volByPair.set(input.pair, input.volIdr);
    feeByPair.set(input.pair, effectiveFeePct(p, input.pairTakerFeePct));
    minNotionalByPair.set(input.pair, input.minNotional);
    slipByPair.set(input.pair, p.dynamicSlippage ? dynamicSlippageBps(p.slippageBps, input.volIdr) : p.slippageBps);
    if (input.universeIntervals?.length) intervalsByPair.set(input.pair, [...input.universeIntervals]);
    else {
      // No intervals for this pair: fall back to the static flag, but the run is no longer timestamped.
      universeIsTimestamped = false;
      universeFallback.set(input.pair, input.inUniverse ?? true);
    }
    for (let i = startIndex; i < candles.length; i++) {
      const c = candles[i];
      if (c.source === 'synthetic' || c.v <= 0) continue;
      timeline.push({ t: c.t, pair: input.pair, candle: c, index: i });
    }
  }
  timeline.sort((a, b) => a.t - b.t || a.pair.localeCompare(b.pair));

  const positions = new Map<string, PortfolioPosition>();
  const trades: PortfolioTrade[] = [];
  const rejections: PortfolioRejection[] = [];
  const equityCurve: PortfolioEquityPoint[] = [];
  let quoteFills = 0;
  const quoteRejections: Record<string, number> = {};
  const quoteIndex = new Map<string, QuotePoint[]>();
  for (const input of pairs) {
    if (!input.quotes?.length) continue;
    // Quotes arrive from PostgREST newest-first; index them once so lookup is a binary search.
    quoteIndex.set(input.pair, [...input.quotes].sort((a, b) => a.t - b.t));
  }
  const maxQuoteAgeSec = fillModel.maxQuoteAgeSec ?? 120;

  /**
   * Price an order. With stored bid/ask the fill uses the last quote at or before the fill time and a
   * rejected/stale quote falls back to the candle scenario (counted, never silently). Without any
   * stored quote the whole run is candle-only and already labelled as such.
   */
  const resolveFill = (
    pair: string, candlePrice: number, atSec: number, side: 'BUY' | 'SELL', slippageBps: number,
  ): number => {
    const quotes = quoteIndex.get(pair);
    if (!quotes) return modelFill(candlePrice, side, slippageBps, fillModel);
    const q = lastQuoteAtOrBefore(quotes, atSec, maxQuoteAgeSec);
    if (!q.ok) {
      quoteRejections[q.reason!] = (quoteRejections[q.reason!] ?? 0) + 1;
      return modelFill(candlePrice, side, slippageBps, fillModel);
    }
    quoteFills++;
    return quoteFillPrice(q, side, slippageBps + fillModel.latencyBps);
  };

  let peakEquity = initialCash;
  let maxDrawdownPct = 0;
  let maxConcurrent = 0;
  let turnover = 0;
  let forcedEodExits = 0;
  let partialFills = 0;
  let rejectedOrders = 0;
  let killSwitchTripped = false;
  let dailyLossFlattens = 0;
  let timeUnderWaterBars = 0;
  let dayStartEquity = initialCash;
  let currentDay = -1;

  const markEquity = (priceByPair: Map<string, number>): { equity: number; grossExposure: number } => {
    let positionsValue = 0;
    for (const pos of positions.values()) {
      const price = priceByPair.get(pos.pair) ?? pos.entry;
      positionsValue += pos.qty * price;
    }
    return { equity: cash + positionsValue, grossExposure: positionsValue };
  };

  // Group timeline by timestamp so exits precede entries within the same minute.
  const byTime = new Map<number, (Bar & { index: number })[]>();
  for (const bar of timeline) {
    const list = byTime.get(bar.t);
    if (list) list.push(bar);
    else byTime.set(bar.t, [bar]);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);

  for (const t of times) {
    const bars = byTime.get(t)!;
    const priceByPair = new Map<string, number>();
    for (const bar of bars) priceByPair.set(bar.pair, bar.candle.c);

    // Daily loss baseline resets on a new UTC day.
    const day = Math.floor(t / 86_400);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = markEquity(priceByPair).equity;
    }

    // 1) Exits first.
    for (const bar of bars) {
      const pos = positions.get(bar.pair);
      if (!pos) continue;
      const { candle } = bar;
      const slip = slipByPair.get(bar.pair) ?? p.slippageBps;
      const feePct = feeByPair.get(bar.pair) ?? p.feePct;
      const posLevels = { entry_price: pos.entry, stop_loss: pos.sl, take_profit: pos.tp };
      let reason: string | null = exitReason(posLevels, candle.c);
      let rawExit = candle.c;
      if (!reason) {
        const atr = atrProxy(candlesByPair.get(bar.pair)!, bar.index);
        const costPct = roundTripCostPct(feePct, slip, fillModel.spreadBps / 100);
        const newStop = trailingStop({ entry_price: pos.entry, stop_loss: pos.sl }, candle.c, atr, p, costPct);
        if (newStop !== null) pos.sl = newStop;
        if (timeStopHit(pos.openedAtSec * 1000, t * 1000, p)) { reason = 'TIME_STOP'; rawExit = candle.c; }
      }
      if (!reason && opts.signal(bar.pair, candlesByPair.get(bar.pair)!, bar.index) === 'SELL') {
        // Same policy as the engine. The backtest signal has no strength and no portfolio risk state,
        // so the force paths stay inert and the result matches the shipped `signalExitRequireProfit`.
        const verdict = shouldExitOnSignal({
          coversCosts: signalExitCoversCosts({ entryPrice: pos.entry, qty: pos.qty, costBasis: pos.cost, bid: candle.c, feePct, slippageBps: slip }),
          strength: 0,
          riskBlocked: false,
          drawdownPct: 0,
          maxDrawdownPct: p.maxDrawdownPct,
          policy: { requireProfit: p.signalExitRequireProfit, forceStrength: p.signalExitForceStrength, forceOnRiskBlock: false },
        });
        if (verdict.exit) { reason = 'SIGNAL'; rawExit = candle.c; }
      }
      if (reason) {
        const fill = resolveFill(bar.pair, rawExit, t, 'SELL', slip);
        const fee = feeFor(pos.qty * fill, feePct);
        const proceeds = pos.qty * fill - fee;
        const pnl = proceeds - pos.cost;
        cash += proceeds;
        turnover += pos.qty * fill;
        trades.push({ pair: bar.pair, entry: pos.entry, exit: fill, qty: pos.qty, pnl, cost: pos.cost, reason, entryTime: pos.openedAtSec, exitTime: t, regime: pos.regime });
        positions.delete(bar.pair);
      }
    }

    // 2) Daily-loss flatten.
    const afterExits = markEquity(priceByPair);
    const dailyLossPct = dayStartEquity > 0 ? (afterExits.equity - dayStartEquity) / dayStartEquity * 100 : 0;
    if (p.closeOnDailyLoss && -dailyLossPct >= p.dailyLossLimitPct && positions.size > 0) {
      for (const bar of bars) {
        const pos = positions.get(bar.pair);
        if (!pos) continue;
        const slip = slipByPair.get(bar.pair) ?? p.slippageBps;
        const feePct = feeByPair.get(bar.pair) ?? p.feePct;
        const fill = resolveFill(bar.pair, bar.candle.c, t, 'SELL', slip);
        const fee = feeFor(pos.qty * fill, feePct);
        const proceeds = pos.qty * fill - fee;
        const pnl = proceeds - pos.cost;
        cash += proceeds;
        turnover += pos.qty * fill;
        trades.push({ pair: bar.pair, entry: pos.entry, exit: fill, qty: pos.qty, pnl, cost: pos.cost, reason: 'DAILY_LOSS', entryTime: pos.openedAtSec, exitTime: t, regime: pos.regime });
        positions.delete(bar.pair);
      }
      dailyLossFlattens++;
    }

    // 3) Drawdown kill switch.
    const preKill = markEquity(priceByPair);
    const ddPct = peakEquity > 0 ? (peakEquity - preKill.equity) / peakEquity * 100 : 0;
    if (!killSwitchTripped && ddPct >= p.maxDrawdownPct) {
      killSwitchTripped = true;
      for (const bar of bars) {
        const pos = positions.get(bar.pair);
        if (!pos) continue;
        const slip = slipByPair.get(bar.pair) ?? p.slippageBps;
        const feePct = feeByPair.get(bar.pair) ?? p.feePct;
        const fill = resolveFill(bar.pair, bar.candle.c, t, 'SELL', slip);
        const fee = feeFor(pos.qty * fill, feePct);
        const proceeds = pos.qty * fill - fee;
        const pnl = proceeds - pos.cost;
        cash += proceeds;
        turnover += pos.qty * fill;
        trades.push({ pair: bar.pair, entry: pos.entry, exit: fill, qty: pos.qty, pnl, cost: pos.cost, reason: 'MAX_DRAWDOWN', entryTime: pos.openedAtSec, exitTime: t, regime: pos.regime });
        positions.delete(bar.pair);
      }
    }

    // 4) Rank candidate entries. Only pairs that produced a BUY on the previous completed bar.
    const blocked = killSwitchTripped || -dailyLossPct >= p.dailyLossLimitPct;
    if (!blocked) {
      const candidates: { pair: string; bar: Bar & { index: number } }[] = [];
      for (const bar of bars) {
        if (positions.has(bar.pair)) continue;
        const candles = candlesByPair.get(bar.pair)!;
        // Signal on the PREVIOUS bar; fill at this bar's open (parity with simulate()).
        const prevIndex = bar.index - 1;
        if (prevIndex < startIndex) continue;
        if (opts.signal(bar.pair, candles, prevIndex) !== 'BUY') continue;
        // Universe membership is evaluated at the SIGNAL bar, not at fill time: a pair that only
        // joined the universe after the signal fired must not be tradable on that signal.
        const intervals = intervalsByPair.get(bar.pair);
        const eligible = intervals
          ? memberAt(intervals, candles[prevIndex].t)
          : (universeFallback.get(bar.pair) ?? false);
        if (!eligible) { rejections.push({ pair: bar.pair, t, stage: 'universe_gate', reason: 'not_in_universe' }); continue; }
        candidates.push({ pair: bar.pair, bar });
      }
      // Rank by signal strength proxy: prefer the strongest momentum (close vs. own recent high).
      candidates.sort((a, b) => {
        const ra = momentumScore(candlesByPair.get(a.pair)!, a.bar.index);
        const rb = momentumScore(candlesByPair.get(b.pair)!, b.bar.index);
        return rb - ra || a.pair.localeCompare(b.pair);
      });
      for (const { pair, bar } of candidates) {
        if (positions.size >= p.maxOpenPositions) { rejections.push({ pair, t, stage: 'portfolio_gate', reason: 'max_positions' }); continue; }
        const slip = slipByPair.get(pair) ?? p.slippageBps;
        const feePct = feeByPair.get(pair) ?? p.feePct;
        const fill = resolveFill(pair, bar.candle.o, t, 'BUY', slip);
        const candles = candlesByPair.get(pair)!;
        const atr = atrProxy(candles, bar.index);
        const stops = computeStops(fill, atr, p);
        const gate = entryGate({ bid: fill, ask: fill, signalPrice: bar.candle.o, stopLoss: stops.stopLoss, fill }, { ...p, maxEntrySpreadPct: 0, maxEntryDriftPct: 0 });
        if (gate && gate !== 'wide_spread' && gate !== 'price_drift') { rejections.push({ pair, t, stage: 'entry_gate', reason: gate }); continue; }
        const economics = netRewardRiskDiagnostics({ entry: fill, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, feePct, exitSlippageBps: slip, minRatio: p.minNetRewardRiskRatio });
        if (economics.reason) { rejections.push({ pair, t, stage: 'economics_gate', reason: economics.reason }); continue; }
        const equityNow = markEquity(priceByPair).equity;
        const size = positionSize({ equity: equityNow, cash, entry: fill, stopLoss: stops.stopLoss, exitSlippageBps: slip, params: { ...p, feePct }, minNotional: minNotionalByPair.get(pair) ?? 10_000 });
        if (size.qty <= 0) { rejections.push({ pair, t, stage: 'sizing_gate', reason: size.reason ?? 'sizing_rejected' }); continue; }
        // Participation cap: cannot trade more than a fraction of the bar's volume.
        const maxQtyByVolume = bar.candle.v * (fillModel.participationRate > 0 ? fillModel.participationRate : 1);
        let qty = size.qty;
        let partial = false;
        if (fillModel.participationRate < 1 && qty > maxQtyByVolume) {
          qty = maxQtyByVolume;
          partial = true;
        }
        if (!(qty > 0)) { rejectedOrders++; rejections.push({ pair, t, stage: 'fill_gate', reason: 'zero_depth' }); continue; }
        const notional = qty * fill;
        const fee = feeFor(notional, feePct);
        const cost = notional + fee;
        if (cost > cash) { rejections.push({ pair, t, stage: 'sizing_gate', reason: 'insufficient_cash' }); continue; }
        const openCost = [...positions.values()].reduce((a, x) => a + x.cost, 0);
        if (!exposureAllows(openCost, cost, equityNow, p)) { rejections.push({ pair, t, stage: 'portfolio_gate', reason: 'max_total_exposure' }); continue; }
        cash -= cost;
        turnover += notional;
        if (partial) partialFills++;
        positions.set(pair, {
          pair, qty, entry: fill, cost, sl: stops.stopLoss, tp: stops.takeProfit, openedAtSec: t,
          entryBarT: bar.candle.t, regime: regimeAt(candles, bar.index - 1),
        });
      }
    }

    // 5) Mark the curve.
    const marked = markEquity(priceByPair);
    peakEquity = Math.max(peakEquity, marked.equity);
    const dd = peakEquity > 0 ? (peakEquity - marked.equity) / peakEquity * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
    if (marked.equity < peakEquity) timeUnderWaterBars++;
    maxConcurrent = Math.max(maxConcurrent, positions.size);
    equityCurve.push({ t, equity: marked.equity, cash, grossExposure: marked.grossExposure, openPositions: positions.size });
  }

  // Close anything still open at the last observed price of that pair (END_OF_DATA).
  for (const pos of positions.values()) {
    const candles = candlesByPair.get(pos.pair)!;
    const last = candles[candles.length - 1];
    if (!last) continue;
    const slip = slipByPair.get(pos.pair) ?? p.slippageBps;
    const feePct = feeByPair.get(pos.pair) ?? p.feePct;
    const fill = resolveFill(pos.pair, last.c, last.t, 'SELL', slip);
    const fee = feeFor(pos.qty * fill, feePct);
    const proceeds = pos.qty * fill - fee;
    const pnl = proceeds - pos.cost;
    cash += proceeds;
    turnover += pos.qty * fill;
    forcedEodExits++;
    trades.push({ pair: pos.pair, entry: pos.entry, exit: fill, qty: pos.qty, pnl, cost: pos.cost, reason: 'END_OF_DATA', entryTime: pos.openedAtSec, exitTime: last.t, regime: pos.regime });
  }

  return {
    trades,
    equityCurve,
    rejections,
    initialCash,
    finalEquity: cash,
    peakEquity,
    maxDrawdownPct,
    maxConcurrentPositions: maxConcurrent,
    turnoverIdr: turnover,
    forcedEodExits,
    partialFills,
    rejectedOrders,
    killSwitchTripped,
    dailyLossFlattens,
    timeUnderWaterBars,
    fillModel,
    universeIsTimestamped,
    effectiveFillLabel: quoteFills > 0 && Object.keys(quoteRejections).length === 0 ? 'QUOTE_BASED' : 'CANDLE_ONLY_OPTIMISTIC',
    quoteFills,
    quoteRejections,
  };
}

/** Simple momentum score for ranking: close relative to the max high of the last 20 bars. */
/**
 * Regime label from data available at the signal bar only: the close relative to a 50-bar mean,
 * with a dead band so a flat market is not forced into a trend bucket.
 */
export function regimeAt(candles: Candle[], index: number): MarketRegime {
  const period = 50;
  if (index < period) return 'range';
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) sum += candles[i].c;
  const mean = sum / period;
  if (!(mean > 0)) return 'range';
  const dev = (candles[index].c - mean) / mean;
  if (dev > 0.01) return 'uptrend';
  if (dev < -0.01) return 'downtrend';
  return 'range';
}

function momentumScore(candles: Candle[], index: number): number {
  const from = Math.max(0, index - 20);
  let hi = 0;
  for (let i = from; i < index; i++) if (candles[i].h > hi) hi = candles[i].h;
  const close = candles[index]?.c ?? 0;
  return hi > 0 ? (close - hi) / hi * 100 : 0;
}

/** ATR proxy from the previous 14 bars so stops are not degenerate in a candle-only run. */
function atrProxy(candles: Candle[], index: number): number | null {
  const period = 14;
  if (index < period + 1) return null;
  let sum = 0;
  for (let i = index - period; i < index; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    sum += tr;
  }
  const atr = sum / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}
