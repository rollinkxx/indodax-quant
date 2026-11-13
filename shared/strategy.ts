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
  /** BUY may fire up to N-1 completed candles after the EMA cross (1 = only on the cross candle itself). */
  crossLookback: number;
  /** BUY is skipped when close is more than N% above the slow EMA (anti chasing). 0 = disabled. */
  maxEntryExtensionPct: number;
  /** false = every fresh EMA cross-down exits/signals SELL; true = RSI and volume must confirm too. */
  sellRequireConfirm: boolean;
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
  rsiBuyMin: 50,
  rsiBuyMax: 65,
  rsiSellMax: 50,
  volumeMaPeriod: 20,
  volumeMultiplier: 1.2,
  useTrendFilter: true,
  crossLookback: 2,
  maxEntryExtensionPct: 1.5,
  sellRequireConfirm: false,
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
  feePct: 0.3,
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
  universeMode: 'dynamic',
  universeSize: 12,
  universeMinVolumeIdr: 1_000_000_000,
  universeMaxSpreadPct: 0.6,
  universeBuffer: 4,
  universeMaxNewPerUpdate: 3,
  universeExclude: DEFAULT_UNIVERSE_EXCLUDE,
  notifyUniverse: true,
};

const BOOL_KEYS = new Set(['useTrendFilter', 'notifySignals', 'notifyUniverse', 'sellRequireConfirm', 'trailingStopEnabled', 'closeOnDailyLoss', 'dynamicSlippage']);

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
  maxEntryExtensionPct: [0, 20],
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

type WarmRow = IndicatorRow & { ema9: number; ema21: number; rsi14: number; volMa20: number };
const warm = (r: IndicatorRow | undefined): r is WarmRow =>
  !!r && r.ema9 !== null && r.ema21 !== null && r.rsi14 !== null && r.volMa20 !== null;

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
export function evaluateSignalWindow(rows: IndicatorRow[], volumes: number[], p: StrategyParams = DEFAULT_PARAMS): SignalDecision | null {
  const n = rows.length;
  if (n < 2 || volumes.length !== n) return null;
  const last = rows[n - 1];
  const prev = rows[n - 2];
  if (!warm(last) || prev.ema9 === null || prev.ema21 === null) return null;
  const volume = volumes[n - 1];
  const { ema9: f, ema21: s, rsi14: r, volMa20: vm } = last;
  const volOk = vm > 0 && volume >= vm * p.volumeMultiplier;

  // BUY: locate the most recent cross up within the lookback window
  if (f > s) {
    const lookback = Math.max(1, Math.floor(p.crossLookback));
    let crossIdx = -1;
    for (let j = n - 1; j >= 1 && n - 1 - j < lookback; j--) {
      const cur = rows[j];
      const before = rows[j - 1];
      if (cur.ema9 === null || cur.ema21 === null || before.ema9 === null || before.ema21 === null) break;
      if (!(cur.ema9 > cur.ema21)) break; // fell back below: no valid cross inside the window
      if (before.ema9 <= before.ema21) { crossIdx = j; break; }
    }
    if (crossIdx >= 0 && buyFiltersOk(last, volume, p)) {
      // one BUY per cross: skip if an earlier candle since the cross already qualified
      let alreadyQualified = false;
      for (let j = crossIdx; j < n - 1; j++) {
        const rj = rows[j];
        if (warm(rj) && buyFiltersOk(rj, volumes[j], p)) { alreadyQualified = true; break; }
      }
      if (!alreadyQualified) {
        const barsSince = n - 1 - crossIdx;
        const reasons = [
          barsSince === 0
            ? `EMA${p.emaFast} crossed above EMA${p.emaSlow}`
            : `EMA${p.emaFast} crossed above EMA${p.emaSlow} ${barsSince} candle(s) ago and stayed above`,
          `RSI ${r.toFixed(1)} in [${p.rsiBuyMin}, ${p.rsiBuyMax}]`,
          `Volume ${(volume / vm).toFixed(2)}x of MA${p.volumeMaPeriod}`,
        ];
        if (p.useTrendFilter) reasons.push(`Close above EMA${p.emaTrend}`);
        let strength = 60 - 5 * barsSince; // a later entry after the cross is slightly weaker
        if (last.macdHist !== null && last.macdHist > 0) { strength += 15; reasons.push('MACD histogram positive'); }
        if (volume >= vm * 2) strength += 15;
        if (last.resistance !== null && last.close > last.resistance) { strength += 10; reasons.push('Breaking resistance'); }
        return { side: 'BUY', strength: Math.max(0, Math.min(strength, 100)), reasons };
      }
    }
  }

  const crossDown = prev.ema9 >= prev.ema21 && f < s;
  if (crossDown) {
    const rsiOk = r <= p.rsiSellMax;
    // Exits must stay responsive: by default every fresh cross-down is a SELL, confirmation is optional.
    if (!p.sellRequireConfirm || (rsiOk && volOk)) {
      const reasons = [
        `EMA${p.emaFast} crossed below EMA${p.emaSlow}`,
        `RSI ${r.toFixed(1)}${rsiOk ? ` <= ${p.rsiSellMax}` : ''}`,
        `Volume ${vm > 0 ? (volume / vm).toFixed(2) : '0'}x of MA${p.volumeMaPeriod}`,
      ];
      let strength = 60;
      if (last.macdHist !== null && last.macdHist < 0) { strength += 15; reasons.push('MACD histogram negative'); }
      if (vm > 0 && volume >= vm * 2) strength += 15;
      if (last.support !== null && last.close < last.support) { strength += 10; reasons.push('Breaking support'); }
      return { side: 'SELL', strength: Math.min(strength, 100), reasons };
    }
  }
  return null;
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
  if (last.source === 'synthetic' || last.n === 0 && last.source === 'trades') return { ok: false, reason: 'no_trades_in_signal_candle' };
  for (let i = 1; i < q.candles.length; i++) {
    if (q.candles[i].t - q.candles[i - 1].t !== q.intervalSec) return { ok: false, reason: 'non_contiguous_series' };
  }
  return { ok: true };
}
