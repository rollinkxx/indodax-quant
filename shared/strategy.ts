// Strategy: EMA crossover + RSI + volume confirmation on completed candles.
import { atr, ema, macd, rsi, sma, supportResistance } from './indicators';
import { roundTripCostPct } from './paper';
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
  /** BUY may fire up to N-1 completed candles after the EMA cross (1 = only on the cross candle itself). */
  crossLookback: number;
  /** SELL may fire up to N-1 completed candles after the EMA cross-down (1 = cross candle only). */
  sellCrossLookback: number;
  /**
   * How many 5m candles a BUY rejected by a transient gate (spread, drift, stale ticker, sizing,
   * lease) stays eligible for a retry. The setup itself is re-validated before the retry fires.
   */
  entryRetryTtlCandles: number;
  /** BUY is skipped when close is more than N% above the slow EMA (anti chasing). 0 = disabled. */
  maxEntryExtensionPct: number;
  /** false = every fresh EMA cross-down exits/signals SELL; true = RSI and volume must confirm too. */
  sellRequireConfirm: boolean;
  /**
   * Minimum signal strength required to open a position. Without it `mtfMode='score'` only changes
   * the execution order, because strength is used for sorting and display. 0 = disabled.
   */
  minSignalStrength: number;
  /** Gate a signal-driven exit on the position already covering the round trip (see shouldExitOnSignal). */
  signalExitRequireProfit: boolean;
  /** SELL strength at or above this exits regardless of profit (0 = never force). */
  signalExitForceStrength: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTakeProfitMultiplier: number;
  fallbackStopPct: number;
  fallbackTakeProfitPct: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  /** Skip BUY when the bid/ask spread is wider than N% of mid (round-trip cost eats the edge). 0 = disabled. */
  maxEntrySpreadPct: number;
  /** Skip BUY when the current ask is more than N% above the signal candle close (late / chasing entry). 0 = disabled. */
  maxEntryDriftPct: number;
  /** Cap on total open cost basis as % of equity. */
  maxTotalExposurePct: number;
  /** Trailing stop: arms after price is `trailActivationAtr` x ATR above entry, then trails `trailDistanceAtr` x ATR below price. */
  trailingStopEnabled: boolean;
  trailActivationAtr: number;
  trailDistanceAtr: number;
  /** Close a position held longer than N minutes (0 = disabled). */
  timeStopMinutes: number;
  /** Close all open positions when the daily loss limit is hit (otherwise it only blocks new entries). */
  closeOnDailyLoss: boolean;
  /** Scale slippage up for thin (low 24h IDR volume) pairs. */
  dynamicSlippage: boolean;
  /**
   * Minimum net reward per unit of net stop-loss risk required to open a position. Lower values
   * allow a nearer target and therefore a higher hit rate; see MIN_NET_REWARD_RISK_RATIO.
   */
  minNetRewardRiskRatio: number;
  /** Which per-side fee the paper engine charges; see FeeModel. Default 'assumption' (legacy). */
  feeModel: FeeModel;
  feePct: number;
  slippageBps: number;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  minCandles: number;
  maxTickerAgeSeconds: number;
  notifySignals: boolean;
  // Multi-timeframe (MTF) confirmation on completed 15m and 1h candles
  mtfMode: MtfMode;
  mtfEmaFast: number;
  mtfEmaSlow: number;
  mtfMinCandles: number;
  /** Block a weak SELL while both 15m and 1h are bullish (a trapped position can still leave). */
  mtfFilterSell: boolean;
  /** SELL strength at or above this is never blocked by the uptrend filter. */
  mtfSellBlockStrength: number;
  // Dynamic universe: pairs picked automatically by 24h IDR volume + spread, on top of the manually tracked pairs
  universeMode: UniverseMode;
  universeSize: number;
  universeMinVolumeIdr: number;
  universeMaxSpreadPct: number;
  universeBuffer: number;
  universeMaxNewPerUpdate: number;
  universeExclude: string[];
  notifyUniverse: boolean;
}

export type MtfMode = 'off' | 'filter' | 'score';
export type UniverseMode = 'manual' | 'dynamic';
export const MTF_MODES: MtfMode[] = ['off', 'filter', 'score'];
export const UNIVERSE_MODES: UniverseMode[] = ['manual', 'dynamic'];
/**
 * Which per-side fee (percentage points) the paper engine charges.
 * - 'assumption': charge `feePct` for every pair (legacy behaviour; the working assumption).
 * - 'pair_taker': charge each pair's real INDODAX taker fee (`market_pairs.trade_fee_percent_taker`),
 *   falling back to `feePct` only when that value is missing or invalid.
 */
export type FeeModel = 'assumption' | 'pair_taker';
export const FEE_MODELS: FeeModel[] = ['assumption', 'pair_taker'];
/** Stablecoins move with USD/IDR, not with crypto momentum: excluded from the dynamic universe by default. */
export const DEFAULT_UNIVERSE_EXCLUDE = ['usdtidr', 'usdcidr', 'busdidr', 'daiidr', 'tusdidr', 'fdusdidr', 'pyusdidr', 'usdeidr',
  // gold-backed tokens track XAU/USD, not crypto momentum
  'xautidr', 'paxgidr'];

export const DEFAULT_PARAMS: StrategyParams = {
  timeframe: '5m',
  emaFast: 9,
  emaSlow: 21,
  emaTrend: 50,
  rsiPeriod: 14,
  // 52, not 50: the default must not sit inside the SELL band (rsiSellMax 50) and trip its own
  // BUY_AND_SELL_RSI_REGIMES_OVERLAP warning.
  rsiBuyMin: 52,
  rsiBuyMax: 65,
  rsiSellMax: 50,
  volumeMaPeriod: 20,
  volumeMultiplier: 1.2,
  useTrendFilter: true,
  crossLookback: 2,
  entryRetryTtlCandles: 3,
  sellCrossLookback: 2,
  maxEntryExtensionPct: 1.5,
  sellRequireConfirm: false,
  minSignalStrength: 0,
  signalExitRequireProfit: true,
  signalExitForceStrength: 70,
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  atrTakeProfitMultiplier: 3,
  fallbackStopPct: 2,
  fallbackTakeProfitPct: 4,
  riskPerTradePct: 1,
  maxPositionPct: 25,
  maxOpenPositions: 4,
  maxEntrySpreadPct: 0.6,
  maxEntryDriftPct: 0.5,
  maxTotalExposurePct: 60,
  trailingStopEnabled: true,
  trailActivationAtr: 1.5,
  trailDistanceAtr: 1,
  timeStopMinutes: 720,
  closeOnDailyLoss: true,
  dynamicSlippage: true,
  minNetRewardRiskRatio: 1,
  feeModel: 'pair_taker',
  // Conservative fallback only. With feeModel='pair_taker' the real per-pair taker fee is charged
  // and a missing catalog value rejects the entry, so this value can never silently under-charge.
  feePct: 0.2,
  slippageBps: 10,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
  minCandles: 60,
  maxTickerAgeSeconds: 180,
  notifySignals: true,
  mtfMode: 'filter',
  mtfEmaFast: 9,
  mtfEmaSlow: 21,
  mtfMinCandles: 30,
  mtfFilterSell: true,
  mtfSellBlockStrength: 70,
  universeMode: 'dynamic',
  universeSize: 12,
  universeMinVolumeIdr: 1_000_000_000,
  universeMaxSpreadPct: 0.6,
  universeBuffer: 4,
  universeMaxNewPerUpdate: 3,
  universeExclude: DEFAULT_UNIVERSE_EXCLUDE,
  notifyUniverse: true,
};

const BOOL_KEYS = new Set(['useTrendFilter', 'notifySignals', 'notifyUniverse', 'sellRequireConfirm', 'signalExitRequireProfit', 'mtfFilterSell', 'trailingStopEnabled', 'closeOnDailyLoss', 'dynamicSlippage']);

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
  crossLookback: [1, 10, true],
  entryRetryTtlCandles: [1, 12, true],
  sellCrossLookback: [1, 10, true],
  maxEntryExtensionPct: [0, 20],
  signalExitForceStrength: [0, 100],
  minSignalStrength: [0, 100],
  atrPeriod: [2, 50, true],
  atrStopMultiplier: [0.1, 10],
  atrTakeProfitMultiplier: [0.1, 20],
  fallbackStopPct: [0.1, 50],
  fallbackTakeProfitPct: [0.1, 100],
  riskPerTradePct: [0.05, 10],
  maxPositionPct: [1, 100],
  maxOpenPositions: [1, 10, true],
  maxEntrySpreadPct: [0, 10],
  maxEntryDriftPct: [0, 10],
  minNetRewardRiskRatio: [0.05, 10],
  maxTotalExposurePct: [5, 100],
  trailActivationAtr: [0.1, 20],
  trailDistanceAtr: [0.1, 20],
  timeStopMinutes: [0, 20160, true],
  feePct: [0, 2],
  slippageBps: [0, 500],
  dailyLossLimitPct: [0.1, 50],
  maxDrawdownPct: [1, 90],
  minCandles: [30, 250, true],
  maxTickerAgeSeconds: [30, 900, true],
  mtfEmaFast: [2, 100, true],
  mtfEmaSlow: [3, 200, true],
  mtfMinCandles: [10, 250, true],
  mtfSellBlockStrength: [0, 100],
  universeSize: [1, 25, true],
  universeMinVolumeIdr: [0, 1e13],
  universeMaxSpreadPct: [0.01, 10],
  universeBuffer: [0, 20, true],
  universeMaxNewPerUpdate: [1, 10, true],
};

/** Validate a partial params object. Returns list of errors (empty = valid). */
export function validateParams(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'timeframe') {
      if (value !== '5m') errors.push('timeframe must be "5m"');
      continue;
    }
    if (BOOL_KEYS.has(key)) {
      if (typeof value !== 'boolean') errors.push(`${key} must be boolean`);
      continue;
    }
    if (key === 'mtfMode') {
      if (!MTF_MODES.includes(value as MtfMode)) errors.push(`mtfMode must be one of ${MTF_MODES.join(', ')}`);
      continue;
    }
    if (key === 'feeModel') {
      if (!FEE_MODELS.includes(value as FeeModel)) errors.push(`feeModel must be one of ${FEE_MODELS.join(', ')}`);
      continue;
    }
    if (key === 'universeMode') {
      if (!UNIVERSE_MODES.includes(value as UniverseMode)) errors.push(`universeMode must be one of ${UNIVERSE_MODES.join(', ')}`);
      continue;
    }
    if (key === 'universeExclude') {
      if (!Array.isArray(value) || value.length > 100 || !value.every((v) => typeof v === 'string' && /^[a-z0-9]{2,20}$/.test(v))) {
        errors.push('universeExclude must be a list of up to 100 pair ids (e.g. usdtidr)');
      }
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
  if (merged.mtfEmaFast >= merged.mtfEmaSlow) errors.push('mtfEmaFast must be smaller than mtfEmaSlow');
  if (merged.mtfMinCandles < merged.mtfEmaSlow + 2) errors.push('mtfMinCandles must exceed mtfEmaSlow by at least 2');
  return errors;
}

/**
 * Cross-field economics check that only makes sense on a complete parameter set.
 *
 * Costs only ever lower reward/risk, so a bracket whose *gross* ratio is under the net minimum
 * can never pass the entry gate: every signal is rejected as net_reward_risk_below_minimum and
 * the engine silently stops trading. On 2026-11-19 the active 9/5 bracket sat at 0.556 gross
 * against a 0.4 floor and could only trade on the 16% of bars whose ATR was high enough for
 * costs to matter less than the ratio gap.
 *
 * Deliberately not part of validateParams: mergeParams() validates the full stored set and
 * falls back to DEFAULT_PARAMS on any error, so an impossible stored bracket would silently
 * reset every other parameter instead of surfacing. This runs where a human saves a config.
 */
/**
 * Reject a bracket whose NET reward/risk cannot clear `minNetRewardRiskRatio`.
 *
 * The gross ratio (tp/sl multipliers) is not the quantity the runtime gate checks: fees and
 * slippage are charged on both legs, so gross > net always, and a config that looked fine on the
 * multipliers could still reject every entry as `net_reward_risk_below_minimum`. Both the ATR
 * bracket and the percentage fallback used when ATR is unavailable are projected at a 1% ATR.
 */
export function validateBracketEconomics(merged: StrategyParams): string[] {
  if (!(merged.atrStopMultiplier > 0)) return ['atrStopMultiplier must be positive'];

  const costPct = roundTripCostPct(merged.feePct, merged.slippageBps);

  const atrPct = 1;
  const slDistAtr = merged.atrStopMultiplier * atrPct;
  const tpDistAtr = merged.atrTakeProfitMultiplier * atrPct;
  const netRiskAtr = slDistAtr + costPct;
  const netRewardAtr = tpDistAtr - costPct;
  const netRatioAtr = netRiskAtr > 0 ? netRewardAtr / netRiskAtr : 0;

  const netRiskPct = merged.fallbackStopPct + costPct;
  const netRewardPct = merged.fallbackTakeProfitPct - costPct;
  const netRatioPct = netRiskPct > 0 ? netRewardPct / netRiskPct : 0;

  const errors: string[] = [];
  if (!(netRewardAtr > 0)) {
    errors.push(`ATR bracket: take profit ${tpDistAtr.toFixed(2)}% does not cover the ${costPct.toFixed(2)}% round-trip cost`);
  }
  if (!(netRewardPct > 0)) {
    errors.push(`fallback bracket: take profit ${merged.fallbackTakeProfitPct}% does not cover the ${costPct.toFixed(2)}% round-trip cost`);
  }
  if (netRatioAtr < merged.minNetRewardRiskRatio) {
    errors.push(`net reward/risk ATR ${netRatioAtr.toFixed(3)} (after ${costPct.toFixed(2)}% cost) < minNetRewardRiskRatio ${merged.minNetRewardRiskRatio}; no entry can pass the net reward/risk gate`);
  }
  if (netRatioPct < merged.minNetRewardRiskRatio) {
    errors.push(`net reward/risk fallback ${netRatioPct.toFixed(3)} (after ${costPct.toFixed(2)}% cost) < minNetRewardRiskRatio ${merged.minNetRewardRiskRatio}; no entry can pass the net reward/risk gate`);
  }
  return errors;
}

/**
 * Cross-field consistency checks that only make sense on a complete parameter set.
 *
 * These catch combinations that are individually valid but jointly broken: a BUY/SELL RSI band that
 * overlaps, volume confirmation silently disabled, an inverted net reward/risk bracket, or a holdout
 * / evidence threshold that can never be met. They are warnings or errors, never silent rewrites.
 */
export interface CrossFieldFinding {
  level: 'warn' | 'error';
  code: string;
  message: string;
}

export function validateCrossFieldParams(p: StrategyParams): CrossFieldFinding[] {
  const out: CrossFieldFinding[] = [];
  if (p.rsiBuyMin <= p.rsiSellMax) {
    out.push({ level: 'warn', code: 'BUY_AND_SELL_RSI_REGIMES_OVERLAP', message: `rsiBuyMin (${p.rsiBuyMin}) <= rsiSellMax (${p.rsiSellMax}); BUY and SELL regimes overlap` });
  }
  if (!(p.volumeMultiplier > 0)) {
    out.push({ level: 'warn', code: 'VOLUME_CONFIRMATION_DISABLED', message: 'volumeMultiplier <= 0 disables volume confirmation' });
  }
  if (!(p.atrTakeProfitMultiplier > p.atrStopMultiplier)) {
    out.push({ level: 'error', code: 'INVALID_NET_REWARD_RISK', message: `takeProfit (${p.atrTakeProfitMultiplier}x) <= stopLoss (${p.atrStopMultiplier}x); net reward cannot exceed risk` });
  }
  if (!(p.minNetRewardRiskRatio > 0)) {
    out.push({ level: 'error', code: 'INVALID_NET_REWARD_RISK', message: 'minNetRewardRiskRatio must be positive' });
  }
  if (p.mtfMode === 'score' && !(p.minSignalStrength > 0)) {
    out.push({
      level: 'warn',
      code: 'SCORE_MODE_WITHOUT_THRESHOLD',
      message: "mtfMode='score' tanpa minSignalStrength > 0 tidak mengubah keputusan; strength hanya dipakai untuk urutan eksekusi",
    });
  }
  return out;
}

/** Whether a strategy-evidence requirement set is internally satisfiable. */
export function validateEvidenceRequirements(req: {
  minHoldoutTrades: number;
  minWinRateLower95Pct: number;
  minProfitFactorExclusive: number;
}): CrossFieldFinding[] {
  const out: CrossFieldFinding[] = [];
  if (!(req.minHoldoutTrades >= 1)) out.push({ level: 'error', code: 'INVALID_HOLDOUT_SIZE', message: 'minHoldoutTrades must be at least 1' });
  if (!(req.minWinRateLower95Pct >= 0) || req.minWinRateLower95Pct > 100) out.push({ level: 'error', code: 'INVALID_WIN_RATE_THRESHOLD', message: 'minWinRateLower95Pct must be between 0 and 100' });
  if (!(req.minProfitFactorExclusive >= 0)) out.push({ level: 'error', code: 'INVALID_PROFIT_FACTOR_THRESHOLD', message: 'minProfitFactorExclusive must be non-negative' });
  return out;
}

/**
 * Warn when a caller supplies a win rate that disagrees with wins/trades. Accepts `null`/`undefined`
 * as "not supplied". Tolerance is 0.01 percentage points.
 */
export function checkReportedWinRate(wins: number, trades: number, reportedWinRatePct: number | null | undefined): CrossFieldFinding | null {
  if (reportedWinRatePct === null || reportedWinRatePct === undefined || !Number.isFinite(reportedWinRatePct)) return null;
  if (!(trades > 0)) return null;
  const calculated = wins / trades * 100;
  if (Math.abs(reportedWinRatePct - calculated) > 0.01) {
    return { level: 'warn', code: 'WIN_RATE_INPUT_MISMATCH', message: `reported win rate ${reportedWinRatePct.toFixed(2)}% disagrees with ${calculated.toFixed(2)}% from wins/trades` };
  }
  return null;
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
  /** True when a synthetic candle sits inside this row's warm-up window: the values are untrustworthy. */
  degraded?: boolean;
}

function emptyIndicatorRow(c: Candle): IndicatorRow {
  return {
    t: c.t, close: c.c, ema9: null, ema21: null, ema50: null, rsi14: null,
    macd: null, macdSignal: null, macdHist: null, atr14: null, volMa20: null,
    support: null, resistance: null, degraded: true,
  };
}

/**
 * Calculate the indicator tail over the FULL series, flagging rows whose warm-up window contains a
 * synthetic candle.
 *
 * Slicing the series at the last synthetic candle restarted EMA/RSI from a segment-local SMA seed,
 * so a single gap shifted EMA50 and RSI enough to fake a cross (or to silently hold). The values are
 * now computed on the continuous series; a row is instead marked `degraded` and treated as not warm
 * while a synthetic candle is still inside its warm-up window.
 */
function computeIndicatorSegment(candles: Candle[], p: StrategyParams, tail = candles.length): IndicatorRow[] {
  if (candles.length === 0) return [];
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  const f = ema(closes, p.emaFast);
  const s = ema(closes, p.emaSlow);
  const tr = ema(closes, p.emaTrend);
  const r = rsi(closes, p.rsiPeriod);
  const m = macd(closes);
  const a = atr(candles, p.atrPeriod);
  const vm = sma(vols, p.volumeMaPeriod);
  const warmup = Math.max(p.emaTrend, 26 + 9, p.rsiPeriod + 1, p.volumeMaPeriod);
  const start = Math.max(0, candles.length - Math.max(1, Math.floor(tail)));
  const rows: IndicatorRow[] = [];
  for (let i = start; i < candles.length; i++) {
    // Levels come from the candles BEFORE this one. A slice that includes the candle itself makes
    // resistance >= close and support <= close by construction, so a breakout could never be detected.
    const sr = supportResistance(candles.slice(0, i), 50);
    let degraded = false;
    for (let k = Math.max(0, i - warmup + 1); k <= i; k++) {
      if (candles[k].source === 'synthetic') { degraded = true; break; }
    }
    rows.push({
      t: candles[i].t, close: candles[i].c, ema9: f[i], ema21: s[i], ema50: tr[i], rsi14: r[i],
      macd: m.macd[i], macdSignal: m.signal[i], macdHist: m.hist[i], atr14: a[i], volMa20: vm[i],
      support: sr.support, resistance: sr.resistance, degraded,
    });
  }
  return rows;
}

/**
 * Calculate indicators independently on each uninterrupted non-synthetic segment.
 * A synthetic candle has no market observation and must not carry EMA/RSI/ATR state across the gap.
 */
export function computeIndicators(candles: Candle[], p: StrategyParams = DEFAULT_PARAMS): IndicatorRow[] {
  const rows: IndicatorRow[] = [];
  let start = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].source !== 'synthetic') continue;
    rows.push(...computeIndicatorSegment(candles.slice(start, i), p));
    rows.push(emptyIndicatorRow(candles[i]));
    start = i + 1;
  }
  rows.push(...computeIndicatorSegment(candles.slice(start), p));
  return rows;
}

/**
 * Indicator tail over the whole series. If the latest candle is synthetic, return an unready row so
 * callers can still inspect its timestamp; gaps earlier in the series are reported per row through
 * `degraded` instead of restarting the indicators.
 */
export function computeIndicatorsTail(candles: Candle[], p: StrategyParams, tail = 3): IndicatorRow[] {
  if (candles.length === 0) return [];
  if (candles[candles.length - 1].source === 'synthetic') return [emptyIndicatorRow(candles[candles.length - 1])];
  return computeIndicatorSegment(candles, p, tail);
}

export interface SignalDecision {
  side: 'BUY' | 'SELL';
  strength: number;
  reasons: string[];
}

type WarmRow = IndicatorRow & { ema9: number; ema21: number; rsi14: number; volMa20: number };
const warm = (r: IndicatorRow | undefined): r is WarmRow =>
  !!r && r.degraded !== true &&
  r.ema9 !== null && r.ema21 !== null && r.rsi14 !== null && r.volMa20 !== null;

/**
 * Fail closed on malformed market inputs before evaluating a crossover.
 * Null indicators are allowed during warm-up; non-finite values, invalid RSI,
 * non-positive closes, and negative/non-finite volume are not market observations.
 */
function validSignalInputs(rows: IndicatorRow[], volumes: number[]): boolean {
  if (rows.length < 2 || volumes.length !== rows.length) return false;
  return rows.every((row, index) => {
    if (!Number.isFinite(row.t) || !Number.isFinite(row.close) || row.close <= 0) return false;
    if (!Number.isFinite(volumes[index]) || volumes[index] < 0) return false;
    const indicators = [
      row.ema9, row.ema21, row.ema50, row.rsi14, row.macd, row.macdSignal,
      row.macdHist, row.atr14, row.volMa20, row.support, row.resistance,
    ];
    if (!indicators.every((value) => value === null || Number.isFinite(value))) return false;
    if (row.rsi14 !== null && (row.rsi14 < 0 || row.rsi14 > 100)) return false;
    if (row.volMa20 !== null && row.volMa20 < 0) return false;
    if (row.degraded !== undefined && typeof row.degraded !== 'boolean') return false;
    return true;
  });
}

/** BUY filters evaluated on a single candle (everything except the cross itself). */
function buyFiltersOk(r: WarmRow, volume: number, p: StrategyParams): boolean {
  const trendOk = !p.useTrendFilter || (r.ema50 !== null && r.close > r.ema50);
  const rsiOk = r.rsi14 >= p.rsiBuyMin && r.rsi14 <= p.rsiBuyMax;
  const volOk = r.volMa20 > 0 && volume >= r.volMa20 * p.volumeMultiplier;
  const extOk = p.maxEntryExtensionPct <= 0 || r.ema21 <= 0 || (r.close - r.ema21) / r.ema21 * 100 <= p.maxEntryExtensionPct;
  return trendOk && rsiOk && volOk && extOk;
}

/**
 * Evaluate the LAST row (must be a completed candle) using the recent rows.
 * `rows` and `volumes` are aligned and ascending; the last element is the signal candle.
 *
 * BUY: EMA fast crossed above EMA slow within the last `crossLookback` candles, stayed above since,
 * and the other filters (trend, RSI, volume, not stretched above EMA slow) pass on the last candle. To emit exactly one BUY per
 * cross, it only fires on the FIRST candle since the cross where all filters pass.
 * SELL: fresh cross down on the last candle only (exits stay responsive). RSI/volume confirmation is optional (`sellRequireConfirm`).
 */
export type BuyDiagnosticStage =
  | 'indicators_not_ready'
  | 'invalid_market_data'
  | 'ema_fast_not_above_slow'
  | 'no_recent_cross'
  | 'trend_filter'
  | 'rsi_filter'
  | 'volume_filter'
  | 'entry_extension'
  | 'already_qualified'
  | 'ready';

export interface BuySignalDiagnostics {
  stage: BuyDiagnosticStage;
  ready: boolean;
  crossFound: boolean;
  barsSinceCross: number | null;
  trendOk: boolean | null;
  rsiOk: boolean | null;
  volumeOk: boolean | null;
  extensionOk: boolean | null;
  alreadyQualified: boolean;
  /** The whole BUY filter, evaluated on the retry run: a queued entry may only fill while the setup
   *  that produced the signal is still true. A retry that skipped RSI/volume/extension would take an
   *  entry the normal path rejects. */
  setupValid: boolean;
  setupFilters: { trend: boolean; rsi: boolean; volume: boolean; extension: boolean } | null;
  rsi: number | null;
  volumeRatio: number | null;
  extensionPct: number | null;
}

/**
 * Explain the exact 5m BUY gate without changing it.
 * Keep this function as the single source of truth for the BUY branch of evaluateSignalWindow.
 */
export function diagnoseBuySignalWindow(
  rows: IndicatorRow[],
  volumes: number[],
  p: StrategyParams = DEFAULT_PARAMS,
): BuySignalDiagnostics {
  const unavailable: BuySignalDiagnostics = {
    stage: 'indicators_not_ready', ready: false, crossFound: false, barsSinceCross: null,
    trendOk: null, rsiOk: null, volumeOk: null, extensionOk: null, alreadyQualified: false,
    setupValid: false, setupFilters: null, rsi: null, volumeRatio: null, extensionPct: null,
  };
  const n = rows.length;
  if (n < 2 || volumes.length !== n) return unavailable;
  if (!validSignalInputs(rows, volumes)) return { ...unavailable, stage: 'invalid_market_data' };

  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || prev.ema9 === null || prev.ema21 === null) return unavailable;

  const volume = volumes[n - 1];
  const volumeRatio = last.volMa20 > 0 ? volume / last.volMa20 : null;
  const extensionPct = last.ema21 > 0 ? (last.close - last.ema21) / last.ema21 * 100 : null;
  const trendOk = !p.useTrendFilter || (last.ema50 !== null && last.close > last.ema50);
  const rsiOk = last.rsi14 >= p.rsiBuyMin && last.rsi14 <= p.rsiBuyMax;
  const volumeOk = last.volMa20 > 0 && volume >= last.volMa20 * p.volumeMultiplier;
  const extensionOk = p.maxEntryExtensionPct <= 0 || last.ema21 <= 0 ||
    (extensionPct !== null && extensionPct <= p.maxEntryExtensionPct);

  // Match evaluateSignalWindow's exact cross window and "stayed above" semantics.
  let crossIdx = -1;
  if (last.ema9 > last.ema21) {
    const lookback = Math.max(1, Math.floor(p.crossLookback));
    for (let j = n - 1; j >= 1 && n - 1 - j < lookback; j--) {
      const cur = rows[j];
      const before = rows[j - 1];
      if (cur.ema9 === null || cur.ema21 === null || before.ema9 === null || before.ema21 === null) break;
      if (!(cur.ema9 > cur.ema21)) break;
      if (before.ema9 <= before.ema21) { crossIdx = j; break; }
    }
  }
  const crossFound = crossIdx >= 0;
  const barsSinceCross = crossFound ? n - 1 - crossIdx : null;

  let alreadyQualified = false;
  if (crossFound && trendOk && rsiOk && volumeOk && extensionOk) {
    for (let j = crossIdx; j < n - 1; j++) {
      const earlier = rows[j];
      if (warm(earlier) && buyFiltersOk(earlier, volumes[j], p)) {
        alreadyQualified = true;
        break;
      }
    }
  }

  let stage: BuyDiagnosticStage;
  if (last.ema9 <= last.ema21) stage = 'ema_fast_not_above_slow';
  else if (!crossFound) stage = 'no_recent_cross';
  else if (!trendOk) stage = 'trend_filter';
  else if (!rsiOk) stage = 'rsi_filter';
  else if (!volumeOk) stage = 'volume_filter';
  else if (!extensionOk) stage = 'entry_extension';
  else if (alreadyQualified) stage = 'already_qualified';
  else stage = 'ready';

  const setupValid = trendOk && rsiOk && volumeOk && extensionOk;

  return {
    stage, ready: stage === 'ready', crossFound, barsSinceCross, trendOk, rsiOk, volumeOk, extensionOk,
    alreadyQualified, setupValid,
    setupFilters: { trend: trendOk, rsi: rsiOk, volume: volumeOk, extension: extensionOk },
    rsi: last.rsi14, volumeRatio, extensionPct,
  };
}

/**
 * Evaluate the LAST row (must be a completed candle) using the recent rows.
 * `rows` and `volumes` are aligned and ascending; the last element is the signal candle.
 *
 * BUY: EMA fast crossed above EMA slow within the last `crossLookback` candles, stayed above since,
 * and the other filters pass on the last candle. To emit exactly one BUY per cross, it only fires
 * on the FIRST candle since the cross where all filters pass.
 * SELL: fresh cross down on the last candle only (exits stay responsive). RSI/volume confirmation is optional.
 */

export type TrendContinuationStage =
  | 'indicators_not_ready'
  | 'invalid_market_data'
  | 'ema_fast_not_above_slow'
  | 'ema_slow_not_above_trend'
  | 'price_not_above_trend'
  | 'recent_cross'
  | 'no_pullback_reclaim'
  | 'rsi_filter'
  | 'volume_filter'
  | 'entry_extension'
  | 'ready';

export interface TrendContinuationDiagnostics {
  stage: TrendContinuationStage;
  ready: boolean;
  pullbackReclaimed: boolean;
  recentCross: boolean;
  trendOk: boolean | null;
  rsiOk: boolean | null;
  volumeOk: boolean | null;
  extensionOk: boolean | null;
  rsi: number | null;
  volumeRatio: number | null;
  extensionPct: number | null;
}

/**
 * Shadow-only setup: price reclaims EMA21 after a pullback while EMA9 > EMA21 > EMA50.
 * This deliberately does not create a trading signal; callers may log or backtest it separately.
 */
export function diagnoseTrendContinuationWindow(
  rows: IndicatorRow[],
  volumes: number[],
  p: StrategyParams = DEFAULT_PARAMS,
): TrendContinuationDiagnostics {
  const unavailable: TrendContinuationDiagnostics = {
    stage: 'indicators_not_ready', ready: false, pullbackReclaimed: false, recentCross: false,
    trendOk: null, rsiOk: null, volumeOk: null, extensionOk: null,
    rsi: null, volumeRatio: null, extensionPct: null,
  };
  const n = rows.length;
  if (n < 2 || volumes.length !== n) return unavailable;
  // Fail closed on malformed market inputs, exactly like the BUY diagnostic and evaluateSignalWindow.
  if (!validSignalInputs(rows, volumes)) return { ...unavailable, stage: 'invalid_market_data' };
  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || !warm(prev) || last.ema50 === null || prev.ema21 === null || prev.ema50 === null) return unavailable;

  const volume = volumes[n - 1];
  const volumeRatio = last.volMa20 > 0 ? volume / last.volMa20 : null;
  const extensionPct = last.ema21 > 0 ? (last.close - last.ema21) / last.ema21 * 100 : null;
  const trendOk = last.ema21 > last.ema50 && last.close > last.ema50;
  const pullbackReclaimed = prev.close <= prev.ema21 && last.close > last.ema21;
  const recentCross = diagnoseBuySignalWindow(rows, volumes, p).crossFound;
  const rsiOk = last.rsi14 >= p.rsiBuyMin && last.rsi14 <= p.rsiBuyMax;
  const volumeOk = last.volMa20 > 0 && volume >= last.volMa20 * p.volumeMultiplier;
  const extensionOk = p.maxEntryExtensionPct <= 0 || last.ema21 <= 0 ||
    (extensionPct !== null && extensionPct <= p.maxEntryExtensionPct);

  let stage: TrendContinuationStage;
  if (last.ema9 <= last.ema21) stage = 'ema_fast_not_above_slow';
  else if (last.ema21 <= last.ema50) stage = 'ema_slow_not_above_trend';
  else if (last.close <= last.ema50) stage = 'price_not_above_trend';
  else if (recentCross) stage = 'recent_cross';
  else if (!pullbackReclaimed) stage = 'no_pullback_reclaim';
  else if (!rsiOk) stage = 'rsi_filter';
  else if (!volumeOk) stage = 'volume_filter';
  else if (!extensionOk) stage = 'entry_extension';
  else stage = 'ready';

  return {
    stage, ready: stage === 'ready', pullbackReclaimed, recentCross, trendOk, rsiOk, volumeOk, extensionOk,
    rsi: last.rsi14, volumeRatio, extensionPct,
  };
}

export type SellDiagnosticStage =
  | 'indicators_not_ready'
  | 'invalid_market_data'
  | 'ema_fast_not_below_slow'
  | 'no_recent_cross'
  | 'rsi_filter'
  | 'volume_filter'
  | 'already_qualified'
  | 'ready';

export interface SellSignalDiagnostics {
  stage: SellDiagnosticStage;
  ready: boolean;
  crossFound: boolean;
  barsSinceCross: number | null;
  rsiOk: boolean | null;
  volumeOk: boolean | null;
  alreadyQualified: boolean;
  rsi: number | null;
  volumeRatio: number | null;
}

/**
 * Explain the exact 5m SELL gate without changing it: the mirror of diagnoseBuySignalWindow.
 * A SELL used to fire only on the single candle where EMA9 crossed below EMA21, so one missed cron
 * tick dropped the exit for good. It now accepts a cross within `sellCrossLookback` candles while
 * EMA9 stays below EMA21, and still emits at most one signal per cross.
 */
export function diagnoseSellSignalWindow(
  rows: IndicatorRow[],
  volumes: number[],
  p: StrategyParams = DEFAULT_PARAMS,
): SellSignalDiagnostics {
  const unavailable: SellSignalDiagnostics = {
    stage: 'indicators_not_ready', ready: false, crossFound: false, barsSinceCross: null,
    rsiOk: null, volumeOk: null, alreadyQualified: false, rsi: null, volumeRatio: null,
  };
  const n = rows.length;
  if (n < 2 || volumes.length !== n) return unavailable;
  if (!validSignalInputs(rows, volumes)) return { ...unavailable, stage: 'invalid_market_data' };
  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || prev.ema9 === null || prev.ema21 === null) return unavailable;

  const volume = volumes[n - 1];
  const volumeRatio = last.volMa20 > 0 ? volume / last.volMa20 : null;
  const rsiOk = last.rsi14 <= p.rsiSellMax;
  const volumeOk = last.volMa20 > 0 && volume >= last.volMa20 * p.volumeMultiplier;

  let crossIdx = -1;
  if (last.ema9 < last.ema21) {
    const lookback = Math.max(1, Math.floor(p.sellCrossLookback));
    for (let j = n - 1; j >= 1 && n - 1 - j < lookback; j--) {
      const cur = rows[j];
      const before = rows[j - 1];
      if (cur.ema9 === null || cur.ema21 === null || before.ema9 === null || before.ema21 === null) break;
      if (!(cur.ema9 < cur.ema21)) break;
      if (before.ema9 >= before.ema21) { crossIdx = j; break; }
    }
  }
  const crossFound = crossIdx >= 0;
  const barsSinceCross = crossFound ? n - 1 - crossIdx : null;

  let alreadyQualified = false;
  if (crossFound) {
    for (let j = crossIdx; j < n - 1; j++) {
      const earlier = rows[j];
      if (!warm(earlier)) continue;
      if (!(earlier.ema9 < earlier.ema21)) continue;
      const confOk = !p.sellRequireConfirm ||
        (earlier.rsi14 <= p.rsiSellMax &&
          earlier.volMa20 > 0 && volumes[j] >= earlier.volMa20 * p.volumeMultiplier);
      if (confOk) { alreadyQualified = true; break; }
    }
  }

  let stage: SellDiagnosticStage;
  if (last.ema9 >= last.ema21) stage = 'ema_fast_not_below_slow';
  else if (!crossFound) stage = 'no_recent_cross';
  else if (p.sellRequireConfirm && !rsiOk) stage = 'rsi_filter';
  else if (p.sellRequireConfirm && !volumeOk) stage = 'volume_filter';
  else if (alreadyQualified) stage = 'already_qualified';
  else stage = 'ready';

  return { stage, ready: stage === 'ready', crossFound, barsSinceCross, rsiOk, volumeOk, alreadyQualified, rsi: last.rsi14, volumeRatio };
}

export function evaluateSignalWindow(rows: IndicatorRow[], volumes: number[], p: StrategyParams = DEFAULT_PARAMS): SignalDecision | null {
  const n = rows.length;
  if (!validSignalInputs(rows, volumes)) return null;
  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || prev.ema9 === null || prev.ema21 === null) return null;

  const volume = volumes[n - 1];
  const { rsi14: r, volMa20: vm } = last;
  const buy = diagnoseBuySignalWindow(rows, volumes, p);

  if (buy.ready) {
    const barsSince = buy.barsSinceCross ?? 0;
    const reasons = [
      barsSince === 0
        ? `EMA${p.emaFast} crossed above EMA${p.emaSlow}`
        : `EMA${p.emaFast} crossed above EMA${p.emaSlow} ${barsSince} candle(s) ago and stayed above`,
      `RSI ${r.toFixed(1)} in [${p.rsiBuyMin}, ${p.rsiBuyMax}]`,
      `Volume ${(volume / vm).toFixed(2)}x of MA${p.volumeMaPeriod}`,
    ];
    if (p.useTrendFilter) reasons.push(`Close above EMA${p.emaTrend}`);
    let strength = 60 - 5 * barsSince;
    if (last.macdHist !== null && last.macdHist > 0) { strength += 15; reasons.push('MACD histogram positive'); }
    if (volume >= vm * 2) strength += 15;
    if (last.resistance !== null && last.close > last.resistance) { strength += 10; reasons.push('Breaking resistance'); }
    return { side: 'BUY', strength: Math.max(0, Math.min(strength, 100)), reasons };
  }

  const sell = diagnoseSellSignalWindow(rows, volumes, p);
  if (sell.ready) {
    const barsSince = sell.barsSinceCross ?? 0;
    const reasons = [
      barsSince === 0
        ? `EMA${p.emaFast} crossed below EMA${p.emaSlow}`
        : `EMA${p.emaFast} crossed below EMA${p.emaSlow} ${barsSince} candle(s) ago and stayed below`,
      `RSI ${r.toFixed(1)}${sell.rsiOk ? ` <= ${p.rsiSellMax}` : ''}`,
      `Volume ${vm > 0 ? (volume / vm).toFixed(2) : '0'}x of MA${p.volumeMaPeriod}`,
    ];
    let strength = 60 - 5 * barsSince;
    if (last.macdHist !== null && last.macdHist < 0) { strength += 15; reasons.push('MACD histogram negative'); }
    if (vm > 0 && volume >= vm * 2) strength += 15;
    if (last.support !== null && last.close < last.support) { strength += 10; reasons.push('Breaking support'); }
    return { side: 'SELL', strength: Math.max(0, Math.min(strength, 100)), reasons };
  }
  return null;
}

/**
 * Explicit three-state decision for consumers that must distinguish HOLD from missing data.
 * HOLD is deliberately not persisted as a trading signal or sent to paper execution.
 */
export type MarketAction = 'BUY' | 'SELL' | 'HOLD';

export interface MarketActionDecision {
  action: MarketAction;
  signal: SignalDecision | null;
  reason: string;
}

export function evaluateMarketAction(
  rows: IndicatorRow[],
  volumes: number[],
  p: StrategyParams = DEFAULT_PARAMS,
): MarketActionDecision {
  const n = rows.length;
  if (n < 2 || volumes.length !== n) {
    return { action: 'HOLD', signal: null, reason: 'insufficient_aligned_rows' };
  }
  if (!validSignalInputs(rows, volumes)) {
    return { action: 'HOLD', signal: null, reason: 'invalid_market_data' };
  }
  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || prev.ema9 === null || prev.ema21 === null) {
    return { action: 'HOLD', signal: null, reason: 'indicators_not_ready' };
  }
  const signal = evaluateSignalWindow(rows, volumes, p);
  if (signal) {
    return {
      action: signal.side,
      signal,
      reason: signal.side === 'BUY' ? 'buy_setup_confirmed' : 'sell_cross_confirmed',
    };
  }

  const buy = diagnoseBuySignalWindow(rows, volumes, p);
  if (buy.stage !== 'no_recent_cross' && buy.stage !== 'ema_fast_not_above_slow') {
    return { action: 'HOLD', signal: null, reason: `buy_blocked_${buy.stage}` };
  }
  const sell = diagnoseSellSignalWindow(rows, volumes, p);
  if (sell.stage !== 'no_recent_cross' && sell.stage !== 'ema_fast_not_below_slow') {
    return { action: 'HOLD', signal: null, reason: `sell_blocked_${sell.stage}` };
  }
  return { action: 'HOLD', signal: null, reason: 'no_fresh_setup' };
}

/** Evaluate the LAST row against only the previous row (fresh cross only, legacy behaviour). */
export function evaluateSignal(last: IndicatorRow, prev: IndicatorRow, volume: number, p: StrategyParams = DEFAULT_PARAMS): SignalDecision | null {
  return evaluateSignalWindow([prev, last], [0, volume], { ...p, crossLookback: 1 });
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
  if (last.source === 'synthetic' || last.v <= 0) return { ok: false, reason: 'no_trades_in_signal_candle' };
  for (let i = 1; i < q.candles.length; i++) {
    if (q.candles[i].t - q.candles[i - 1].t !== q.intervalSec) return { ok: false, reason: 'non_contiguous_series' };
  }

  // Gap-filled candles are for display/aggregation only. The signal engine must warm up again
  // from a contiguous suffix of observed candles after the most recent synthetic interval.
  let contiguousCandles = 1;
  for (let i = q.candles.length - 2; i >= 0; i--) {
    if (q.candles[i].source === 'synthetic') break;
    contiguousCandles++;
  }
  if (contiguousCandles < q.minCandles) {
    return { ok: false, reason: `insufficient_contiguous_candles (${contiguousCandles}/${q.minCandles})` };
  }
  return { ok: true };
}
