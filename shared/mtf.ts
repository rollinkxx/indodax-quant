// Multi-timeframe (MTF) analysis: confirm 5m signals with the trend on completed 15m and 1h candles.
// Higher-timeframe candles are aggregated from the 5m series (exact, built from real trades) and,
// for older history, from stored 15m / 1h candles (official INDODAX OHLC backfill).
import { ema, rsi } from './indicators';
import { fillGaps, floorTo, type Candle } from './candles';
import type { SignalDecision, StrategyParams } from './strategy';

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
  if (series5m.length === 0) return [];
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
    const allSynthetic = list.every((k) => k.source === 'synthetic');
    out.push({
      t,
      o: list[0].o,
      h: Math.max(...list.map((k) => k.h)),
      l: Math.min(...list.map((k) => k.l)),
      c: list[list.length - 1].c,
      v: list.reduce((s, k) => s + k.v, 0),
      n: list.reduce((s, k) => s + k.n, 0),
      source: allSynthetic ? 'synthetic' : list.some((k) => k.source === 'history') ? 'history' : 'trades',
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
  for (const c of stored) if (c.t <= lastComplete && c.t % tfSec === 0) byTime.set(c.t, c);
  for (const c of aggregated) if (c.t <= lastComplete) byTime.set(c.t, c);
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return [];
  return fillGaps(sorted.slice(-limit), tfSec, lastComplete).slice(-limit);
}

/** Trend on the last completed candle of a higher timeframe. */
export function trendState(tf: HigherTf, series: Candle[], lastComplete: number, p: Pick<StrategyParams, 'mtfEmaFast' | 'mtfEmaSlow' | 'mtfMinCandles' | 'rsiPeriod'>): TfState {
  const base: TfState = { tf, trend: 'unknown', candles: series.length, lastOpenTime: series.length ? series[series.length - 1].t : null, close: null, emaFast: null, emaSlow: null, rsi: null };
  if (series.length < p.mtfMinCandles) return { ...base, reason: `warming_up (${series.length}/${p.mtfMinCandles})` };
  const last = series[series.length - 1];
  if (last.t !== lastComplete) return { ...base, reason: 'stale_last_candle' };
  const closes = series.map((c) => c.c);
  const f = ema(closes, p.mtfEmaFast).at(-1) ?? null;
  const s = ema(closes, p.mtfEmaSlow).at(-1) ?? null;
  const r = rsi(closes, p.rsiPeriod).at(-1) ?? null;
  const out: TfState = { ...base, close: last.c, emaFast: f, emaSlow: s, rsi: r };
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

/**
 * Apply the higher-timeframe context to a 5m decision.
 * - off:    unchanged.
 * - filter: BUY needs 1h bullish and no bearish higher timeframe; unknown (warming up) blocks BUY.
 *           SELL is an exit signal for long positions and is never blocked.
 * - score:  never blocks; strength +10 per aligned timeframe, -15 per opposing one.
 */
export function applyMtf(decision: SignalDecision | null, states: TfState[], mode: StrategyParams['mtfMode']): MtfOutcome {
  const summary = Object.fromEntries(states.map((s) => [s.tf, { trend: s.trend, rsi: s.rsi, ema_fast: s.emaFast, ema_slow: s.emaSlow, candles: s.candles }])) as MtfOutcome['summary'];
  if (!decision || mode === 'off' || states.length === 0) return { decision, summary };
  const want: Trend = decision.side === 'BUY' ? 'bull' : 'bear';
  const against: Trend = decision.side === 'BUY' ? 'bear' : 'bull';
  const text = `MTF ${states.map((s) => `${s.tf} ${label(s.trend)}`).join(', ')}`;

  if (mode === 'filter' && decision.side === 'BUY') {
    const anchor = states.find((s) => s.tf === '1h') ?? states[states.length - 1];
    if (states.some((s) => s.trend === 'unknown')) return { decision: null, blocked: 'mtf_warming_up', summary };
    if (states.some((s) => s.trend === against)) return { decision: null, blocked: 'mtf_against_trend', summary };
    if (anchor.trend !== want) return { decision: null, blocked: 'mtf_anchor_not_bullish', summary };
  }

  let strength = decision.strength;
  if (mode === 'score' || mode === 'filter') {
    for (const s of states) {
      if (s.trend === want) strength += 10;
      else if (s.trend === against) strength -= 15;
    }
  }
  const aligned = states.every((s) => s.trend === want);
  return {
    decision: {
      ...decision,
      strength: Math.max(0, Math.min(100, strength)),
      reasons: [...decision.reasons, aligned ? `${text} (searah)` : text],
    },
    summary,
  };
}
