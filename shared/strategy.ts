// Strategy: EMA crossover + RSI + volume confirmation on completed candles.
import { atr, ema, macd, rsi, sma, supportResistance } from './indicators';
import type { Candle } from './candles';

export interface StrategyParams {
  timeframe: '5m';
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  rsiPeriod: number;
  rsiBuyMin: number;
  rsiBuyMax: number;
  rsiSellMax: number;
  volumeMaPeriod: number;
  volumeMultiplier: number;
  useTrendFilter: boolean;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTakeProfitMultiplier: number;
  fallbackStopPct: number;
  fallbackTakeProfitPct: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  feePct: number;
  slippageBps: number;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  minCandles: number;
  maxTickerAgeSeconds: number;
  notifySignals: boolean;
}

export const DEFAULT_PARAMS: StrategyParams = {
  timeframe: '5m',
  emaFast: 9,
  emaSlow: 21,
  emaTrend: 50,
  rsiPeriod: 14,
  rsiBuyMin: 50,
  rsiBuyMax: 70,
  rsiSellMax: 50,
  volumeMaPeriod: 20,
  volumeMultiplier: 1.2,
  useTrendFilter: true,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  atrTakeProfitMultiplier: 3,
  fallbackStopPct: 2,
  fallbackTakeProfitPct: 4,
  riskPerTradePct: 1,
  maxPositionPct: 25,
  maxOpenPositions: 3,
  feePct: 0.3,
  slippageBps: 10,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
  minCandles: 60,
  maxTickerAgeSeconds: 180,
  notifySignals: true,
};

type NumKey = { [K in keyof StrategyParams]: StrategyParams[K] extends number ? K : never }[keyof StrategyParams];

export const PARAM_LIMITS: Record<NumKey, [number, number, boolean?]> = {
  emaFast: [2, 100, true],
  emaSlow: [3, 200, true],
  emaTrend: [5, 300, true],
  rsiPeriod: [2, 50, true],
  rsiBuyMin: [0, 100],
  rsiBuyMax: [0, 100],
  rsiSellMax: [0, 100],
  volumeMaPeriod: [2, 100, true],
  volumeMultiplier: [0, 10],
  atrPeriod: [2, 50, true],
  atrStopMultiplier: [0.1, 10],
  atrTakeProfitMultiplier: [0.1, 20],
  fallbackStopPct: [0.1, 50],
  fallbackTakeProfitPct: [0.1, 100],
  riskPerTradePct: [0.05, 10],
  maxPositionPct: [1, 100],
  maxOpenPositions: [1, 10, true],
  feePct: [0, 2],
  slippageBps: [0, 500],
  dailyLossLimitPct: [0.1, 50],
  maxDrawdownPct: [1, 90],
  minCandles: [30, 250, true],
  maxTickerAgeSeconds: [30, 900, true],
};

/** Validate a partial params object. Returns list of errors (empty = valid). */
export function validateParams(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'timeframe') {
      if (value !== '5m') errors.push('timeframe must be "5m"');
      continue;
    }
    if (key === 'useTrendFilter' || key === 'notifySignals') {
      if (typeof value !== 'boolean') errors.push(`${key} must be boolean`);
      continue;
    }
    const lim = PARAM_LIMITS[key as NumKey];
    if (!lim) {
      errors.push(`unknown parameter: ${key}`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${key} must be a number`);
      continue;
    }
    if (value < lim[0] || value > lim[1]) errors.push(`${key} must be between ${lim[0]} and ${lim[1]}`);
    if (lim[2] && !Number.isInteger(value)) errors.push(`${key} must be an integer`);
  }
  const merged = { ...DEFAULT_PARAMS, ...input } as StrategyParams;
  if (merged.emaFast >= merged.emaSlow) errors.push('emaFast must be smaller than emaSlow');
  if (merged.rsiBuyMin >= merged.rsiBuyMax) errors.push('rsiBuyMin must be smaller than rsiBuyMax');
  if (merged.minCandles < Math.max(merged.emaTrend, merged.emaSlow, 26 + 9) + 2) {
    errors.push('minCandles must exceed the longest indicator warm-up (emaTrend / MACD) by at least 2');
  }
  return errors;
}

/** Merge stored params with defaults, ignoring invalid values. */
export function mergeParams(stored: unknown): StrategyParams {
  const out: StrategyParams = { ...DEFAULT_PARAMS };
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!(k in DEFAULT_PARAMS)) continue;
    if (validateParams({ [k]: v }).some((e) => e.startsWith(k) || e.startsWith('unknown'))) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (validateParams(out as unknown as Record<string, unknown>).length) return { ...DEFAULT_PARAMS };
  return out;
}

export interface IndicatorRow {
  t: number;
  close: number;
  ema9: number | null; // fast EMA
  ema21: number | null; // slow EMA
  ema50: number | null; // trend EMA
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr14: number | null;
  volMa20: number | null;
  support: number | null;
  resistance: number | null;
}

export function computeIndicators(candles: Candle[], p: StrategyParams = DEFAULT_PARAMS): IndicatorRow[] {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const f = ema(closes, p.emaFast);
  const s = ema(closes, p.emaSlow);
  const tr = ema(closes, p.emaTrend);
  const r = rsi(closes, p.rsiPeriod);
  const m = macd(closes);
  const a = atr(candles, p.atrPeriod);
  const vm = sma(vols, p.volumeMaPeriod);
  return candles.map((c, i) => {
    const sr = i >= 5 ? supportResistance(candles.slice(0, i + 1), 50) : { support: null, resistance: null };
    return {
      t: c.t,
      close: c.c,
      ema9: f[i],
      ema21: s[i],
      ema50: tr[i],
      rsi14: r[i],
      macd: m.macd[i],
      macdSignal: m.signal[i],
      macdHist: m.hist[i],
      atr14: a[i],
      volMa20: vm[i],
      support: sr.support,
      resistance: sr.resistance,
    };
  });
}

/** Cheaper variant: indicators for all candles but support/resistance only on the last `tail` rows. */
export function computeIndicatorsTail(candles: Candle[], p: StrategyParams, tail = 3): IndicatorRow[] {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const f = ema(closes, p.emaFast);
  const s = ema(closes, p.emaSlow);
  const tr = ema(closes, p.emaTrend);
  const r = rsi(closes, p.rsiPeriod);
  const m = macd(closes);
  const a = atr(candles, p.atrPeriod);
  const vm = sma(vols, p.volumeMaPeriod);
  const start = Math.max(0, candles.length - tail);
  const rows: IndicatorRow[] = [];
  for (let i = start; i < candles.length; i++) {
    const sr = supportResistance(candles.slice(0, i + 1), 50);
    rows.push({
      t: candles[i].t, close: candles[i].c, ema9: f[i], ema21: s[i], ema50: tr[i], rsi14: r[i],
      macd: m.macd[i], macdSignal: m.signal[i], macdHist: m.hist[i], atr14: a[i], volMa20: vm[i],
      support: sr.support, resistance: sr.resistance,
    });
  }
  return rows;
}

export interface SignalDecision {
  side: 'BUY' | 'SELL';
  strength: number;
  reasons: string[];
}

/** Evaluate the LAST row (must be a completed candle). `prev` is the row before it. */
export function evaluateSignal(last: IndicatorRow, prev: IndicatorRow, volume: number, p: StrategyParams = DEFAULT_PARAMS): SignalDecision | null {
  const { ema9: f, ema21: s, ema50: tr, rsi14: r, volMa20: vm } = last;
  if (f === null || s === null || r === null || vm === null || prev.ema9 === null || prev.ema21 === null) return null;
  const volOk = vm > 0 && volume >= vm * p.volumeMultiplier;
  const crossUp = prev.ema9 <= prev.ema21 && f > s;
  const crossDown = prev.ema9 >= prev.ema21 && f < s;

  if (crossUp) {
    const trendOk = !p.useTrendFilter || (tr !== null && last.close > tr);
    const rsiOk = r >= p.rsiBuyMin && r <= p.rsiBuyMax;
    if (trendOk && rsiOk && volOk) {
      const reasons = [
        `EMA${p.emaFast} crossed above EMA${p.emaSlow}`,
        `RSI ${r.toFixed(1)} in [${p.rsiBuyMin}, ${p.rsiBuyMax}]`,
        `Volume ${(volume / vm).toFixed(2)}x of MA${p.volumeMaPeriod}`,
      ];
      if (p.useTrendFilter) reasons.push(`Close above EMA${p.emaTrend}`);
      let strength = 60;
      if (last.macdHist !== null && last.macdHist > 0) { strength += 15; reasons.push('MACD histogram positive'); }
      if (volume >= vm * 2) strength += 15;
      if (last.resistance !== null && last.close > last.resistance) { strength += 10; reasons.push('Breaking resistance'); }
      return { side: 'BUY', strength: Math.min(strength, 100), reasons };
    }
  }
  if (crossDown) {
    const rsiOk = r <= p.rsiSellMax;
    if (rsiOk && volOk) {
      const reasons = [
        `EMA${p.emaFast} crossed below EMA${p.emaSlow}`,
        `RSI ${r.toFixed(1)} <= ${p.rsiSellMax}`,
        `Volume ${(volume / vm).toFixed(2)}x of MA${p.volumeMaPeriod}`,
      ];
      let strength = 60;
      if (last.macdHist !== null && last.macdHist < 0) { strength += 15; reasons.push('MACD histogram negative'); }
      if (volume >= vm * 2) strength += 15;
      if (last.support !== null && last.close < last.support) { strength += 10; reasons.push('Breaking support'); }
      return { side: 'SELL', strength: Math.min(strength, 100), reasons };
    }
  }
  return null;
}

export interface QualityInput {
  candles: Candle[]; // gap-filled, ascending, completed candles only
  nowSec: number;
  intervalSec: number;
  coveredUntilSec: number | null; // trade coverage frontier
  minCandles: number;
}

/** Refuse to trade on incomplete or stale data. */
export function checkDataQuality(q: QualityInput): { ok: boolean; reason?: string } {
  const expectedLast = Math.floor(q.nowSec / q.intervalSec) * q.intervalSec - q.intervalSec;
  if (q.candles.length < q.minCandles) return { ok: false, reason: `warming_up (${q.candles.length}/${q.minCandles} candles)` };
  const last = q.candles[q.candles.length - 1];
  if (last.t !== expectedLast) return { ok: false, reason: 'stale_last_candle' };
  if (q.coveredUntilSec === null || q.coveredUntilSec < expectedLast + q.intervalSec) return { ok: false, reason: 'incomplete_trade_coverage' };
  if (last.source === 'synthetic' || last.n === 0 && last.source === 'trades') return { ok: false, reason: 'no_trades_in_signal_candle' };
  for (let i = 1; i < q.candles.length; i++) {
    if (q.candles[i].t - q.candles[i - 1].t !== q.intervalSec) return { ok: false, reason: 'non_contiguous_series' };
  }
  return { ok: true };
}
