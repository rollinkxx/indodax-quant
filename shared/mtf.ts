// Multi-timeframe (MTF) analysis: confirm 5m signals with the trend on completed 15m and 1h candles.
// Higher-timeframe candles are aggregated from the 5m series (exact, built from real trades) and,
// for older history, from stored 15m / 1h candles (official INDODAX OHLC backfill).
import { ema, rsi } from './indicators';
import { fillGaps, floorTo, isValidCandle, type Candle } from './candles';
import type { MarketActionDecision, SignalDecision, StrategyParams } from './strategy';

export type HigherTf = '15m' | '1h';
export const HIGHER_TFS: { tf: HigherTf; sec: number; historyTf: '15' | '60' }[] = [
  { tf: '15m', sec: 900, historyTf: '15' },
  { tf: '1h', sec: 3600, historyTf: '60' },
];
export const TF_SECONDS: Record<HigherTf, number> = { '15m': 900, '1h': 3600 };
/** Candles kept per higher timeframe for the analysis window. */
export const MTF_WINDOW = 120;

export type Trend = 'bull' | 'bear' | 'neutral' | 'unknown';

export interface TfState {
  tf: HigherTf;
  trend: Trend;
  candles: number;
  lastOpenTime: number | null;
  close: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  reason?: string;
}

const SUB = 300; // the base series is 5m

/** Open time of the most recent higher-timeframe bucket fully covered by the 5m series ending at `last5m`. */
export function lastCompleteBucket(last5m: number, tfSec: number): number {
  return floorTo(last5m + SUB, tfSec) - tfSec;
}

/**
 * Aggregate a contiguous, gap-filled 5m series into higher-timeframe candles.
 * Only buckets whose every 5m sub-candle is inside the series are returned (no partial / forming candles).
 */
export function aggregateComplete(series5m: Candle[], tfSec: number): Candle[] {
  if (series5m.length === 0 || tfSec <= SUB || tfSec % SUB !== 0) return [];
  const first = series5m[0].t;
  const lastBucket = lastCompleteBucket(series5m[series5m.length - 1].t, tfSec);
  const per = tfSec / SUB;
  const buckets = new Map<number, Candle[]>();
  for (const c of series5m) {
    const b = floorTo(c.t, tfSec);
    if (b < first || b > lastBucket) continue; // bucket started before the series => partial
    const list = buckets.get(b) ?? [];
    list.push(c);
    buckets.set(b, list);
  }
  const out: Candle[] = [];
  for (const [t, list] of buckets) {
    if (list.length !== per) continue;
    list.sort((a, b) => a.t - b.t);
    // Count alone is insufficient: duplicates can hide a missing 5m slot.
    if (list.some((c, i) => c.t !== t + i * SUB || !isValidCandle(c))) continue;
    out.push({
      t,
      o: list[0].o,
      h: Math.max(...list.map((k) => k.h)),
      l: Math.min(...list.map((k) => k.l)),
      c: list[list.length - 1].c,
      v: list.reduce((s, k) => s + k.v, 0),
      n: list.reduce((s, k) => s + k.n, 0),
      source: list.some((k) => k.source === 'synthetic') ? 'synthetic' : list.some((k) => k.source === 'history') ? 'history' : 'trades',
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Merge stored higher-timeframe candles with fresh aggregates (aggregates win), keep completed buckets only,
 * fill gaps and return the last `limit` candles.
 */
export function buildHigherSeries(stored: Candle[], aggregated: Candle[], tfSec: number, lastComplete: number, limit = MTF_WINDOW): Candle[] {
  const byTime = new Map<number, Candle>();
  const sourceRank: Record<Candle['source'], number> = { synthetic: 1, history: 2, trades: 3 };
  for (const c of stored) {
    if (c.t <= lastComplete && c.t % tfSec === 0 && isValidCandle(c)) byTime.set(c.t, c);
  }
  for (const c of aggregated) {
    if (c.t > lastComplete || c.t % tfSec !== 0 || !isValidCandle(c)) continue;
    const existing = byTime.get(c.t);
    // Enforce one source hierarchy everywhere: trades > official history > synthetic.
    // Equal-source refreshes may replace old values only when their trade count is not lower.
    if (!existing || sourceRank[c.source] > sourceRank[existing.source] ||
        (c.source === existing.source && c.n >= existing.n)) {
      byTime.set(c.t, c);
    }
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];
  return fillGaps(sorted.slice(-limit), tfSec, lastComplete).slice(-limit);
}

/**
 * Count the latest uninterrupted suffix of valid observed candles ending exactly at lastOpenTime.
 * Duplicate timestamps, malformed bars, synthetic rows, gaps, or a stale tail fail closed.
 */
export function contiguousObservedSuffix(series: Candle[], tfSec: number, lastOpenTime: number): number {
  if (tfSec <= 0 || lastOpenTime % tfSec !== 0) return 0;
  const rows = series.filter((c) => c.t <= lastOpenTime && c.t % tfSec === 0).slice().sort((a, b) => a.t - b.t);
  if (rows.length === 0) return 0;
  const last = rows[rows.length - 1];
  // A duplicate at the latest timestamp makes the signal candle ambiguous.
  if (last.t !== lastOpenTime || last.source === 'synthetic' || !isValidCandle(last) ||
      rows.at(-2)?.t === last.t) return 0;

  let count = 1;
  for (let i = rows.length - 2; i >= 0; i--) {
    const previous = rows[i];
    const current = rows[i + 1];
    if (current.t - previous.t !== tfSec || previous.source === 'synthetic' || !isValidCandle(previous)) break;
    count++;
  }
  return count;
}

/** Trend on the last completed candle of a higher timeframe. */
export function trendState(tf: HigherTf, series: Candle[], lastComplete: number, p: Pick<StrategyParams, 'mtfEmaFast' | 'mtfEmaSlow' | 'mtfMinCandles' | 'rsiPeriod'>): TfState {
  const ordered = series.slice().sort((a, b) => a.t - b.t);
  const base: TfState = { tf, trend: 'unknown', candles: ordered.length, lastOpenTime: ordered.length ? ordered[ordered.length - 1].t : null, close: null, emaFast: null, emaSlow: null, rsi: null };
  if (ordered.length < p.mtfMinCandles) return { ...base, reason: `warming_up (${ordered.length}/${p.mtfMinCandles})` };
  const last = ordered[ordered.length - 1];
  if (last.t !== lastComplete) return { ...base, reason: 'stale_last_candle' };
  if (last.source === 'synthetic') return { ...base, candles: 0, reason: 'synthetic_last_candle' };

  // A gap-filled candle carries no observed price action. Compute indicators only from the
  // latest uninterrupted suffix of actual history/trade candles, never across a synthetic gap.
  const contiguous = contiguousObservedSuffix(ordered, TF_SECONDS[tf], lastComplete);
  if (contiguous < p.mtfMinCandles) {
    const reason = contiguous === 0 && ordered.some((c) => c.t === lastComplete && !isValidCandle(c))
      ? 'invalid_last_candle'
      : `insufficient_contiguous_candles (${contiguous}/${p.mtfMinCandles})`;
    return { ...base, candles: contiguous, reason };
  }
  const valid = ordered.slice(-contiguous);
  const validBase = { ...base, candles: valid.length };

  const closes = valid.map((c) => c.c);
  const f = ema(closes, p.mtfEmaFast).at(-1) ?? null;
  const s = ema(closes, p.mtfEmaSlow).at(-1) ?? null;
  const r = rsi(closes, p.rsiPeriod).at(-1) ?? null;
  const out: TfState = { ...validBase, close: last.c, emaFast: f, emaSlow: s, rsi: r };
  if (f === null || s === null) return { ...out, trend: 'unknown', reason: 'indicators_not_ready' };
  if (last.c > s && f > s) return { ...out, trend: 'bull' };
  if (last.c < s && f < s) return { ...out, trend: 'bear' };
  return { ...out, trend: 'neutral' };
}

export interface MtfOutcome {
  decision: SignalDecision | null;
  blocked?: string;
  summary: Record<HigherTf, { trend: Trend; rsi: number | null; ema_fast: number | null; ema_slow: number | null; candles: number }>;
}

const label = (t: Trend) => ({ bull: 'bullish', bear: 'bearish', neutral: 'netral', unknown: 'belum siap' }[t]);

export type MtfOpts = {
  /** Block a weak SELL while both higher timeframes are bullish. Off restores the unfiltered SELL. */
  filterSell: boolean;
  /** SELL strength at or above this is never blocked by the uptrend filter. */
  minSellStrength: number;
};

const DEFAULT_MTF_OPTS: MtfOpts = { filterSell: false, minSellStrength: 70 };

/**
 * Apply the higher-timeframe context to a 5m decision.
 * - off:    unchanged.
 * - filter: BUY needs 1h bullish and no bearish higher timeframe; unknown (warming up) blocks BUY.
 *           SELL is an exit signal for long positions, so it is only blocked when it is weak AND
 *           both 15m and 1h are bullish: a trapped position must still be able to leave.
 * - score:  never blocks; strength +10 per aligned timeframe, -15 per opposing one.
 */
export function applyMtf(decision: SignalDecision | null, states: TfState[], mode: StrategyParams['mtfMode'], opts: MtfOpts = DEFAULT_MTF_OPTS): MtfOutcome {
  const summary = Object.fromEntries(states.map((s) => [s.tf, { trend: s.trend, rsi: s.rsi, ema_fast: s.emaFast, ema_slow: s.emaSlow, candles: s.candles }])) as MtfOutcome['summary'];
  if (!decision || mode === 'off') return { decision, summary };
  if (states.length === 0 && !(mode === 'filter' && decision.side === 'BUY')) return { decision, summary };
  const want: Trend = decision.side === 'BUY' ? 'bull' : 'bear';
  const against: Trend = decision.side === 'BUY' ? 'bear' : 'bull';
  const text = `MTF ${states.map((s) => `${s.tf} ${label(s.trend)}`).join(', ')}`;

  if (mode === 'filter' && decision.side === 'BUY') {
    // Both 15m and 1h are mandatory. Missing or duplicated state must never fail open.
    const required: HigherTf[] = ['15m', '1h'];
    const missing = required.filter((tf) => states.filter((s) => s.tf === tf).length !== 1);
    if (missing.length) return { decision: null, blocked: `mtf_missing_or_duplicate:${missing.join(',')}`, summary };
    const requiredStates = required.map((tf) => states.find((s) => s.tf === tf)!);
    const anchor = requiredStates.find((s) => s.tf === '1h')!;
    if (requiredStates.some((s) => s.trend === 'unknown')) return { decision: null, blocked: 'mtf_warming_up', summary };
    if (requiredStates.some((s) => s.trend === against)) return { decision: null, blocked: 'mtf_against_trend', summary };
    if (anchor.trend !== want) return { decision: null, blocked: 'mtf_anchor_not_bullish', summary };
  }

  let strength = decision.strength;
  if (mode === 'score' || mode === 'filter') {
    for (const s of states) {
      if (s.trend === want) strength += 10;
      else if (s.trend === against) strength -= 15;
    }
  }
  const finalStrength = Math.max(0, Math.min(100, strength));

  // Judged on the adjusted strength: a SELL against two bullish timeframes loses 30 points, and it
  // is that number the engine acts on. Filtering on the raw strength let through exactly the SELLs
  // this filter exists to block.
  if (mode === 'filter' && decision.side === 'SELL' && opts.filterSell) {
    const anchor = states.find((s) => s.tf === '1h');
    const fast = states.find((s) => s.tf === '15m');
    const bothBull = anchor?.trend === 'bull' && fast?.trend === 'bull';
    if (bothBull && finalStrength < opts.minSellStrength) {
      return { decision: null, blocked: 'mtf_sell_against_uptrend', summary };
    }
  }

  const aligned = states.every((s) => s.trend === want);
  return {
    decision: {
      ...decision,
      strength: finalStrength,
      reasons: [...decision.reasons, aligned ? `${text} (searah)` : text],
    },
    summary,
  };
}


/**
 * Apply MTF gating to the user-facing three-state decision.
 * A raw BUY rejected by a higher-timeframe filter is a final HOLD, not a BUY.
 * A SELL is only blocked while both higher timeframes are bullish and the SELL is weak.
 */
export interface MtfMarketActionOutcome {
  action: MarketActionDecision;
  mtf: MtfOutcome;
}

export function applyMtfToMarketAction(
  action: MarketActionDecision,
  states: TfState[],
  mode: StrategyParams['mtfMode'],
  opts?: MtfOpts,
): MtfMarketActionOutcome {
  const mtf = applyMtf(action.signal, states, mode, opts);
  if (action.action === 'HOLD') return { action, mtf };

  if (!mtf.decision) {
    return {
      action: {
        action: 'HOLD',
        signal: null,
        reason: mtf.blocked ? `mtf_blocked_${mtf.blocked}` : 'mtf_decision_unavailable',
      },
      mtf,
    };
  }

  return { action: { ...action, signal: mtf.decision }, mtf };
}
