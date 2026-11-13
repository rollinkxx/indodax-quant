// Technical indicators. Pure functions, no I/O. Index i of every output aligns with input index i.
export type Series = (number | null)[];

export interface OHLCV {
  t: number; // open time, unix seconds (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA over a series that contains leading nulls. */
function emaOfSeries(values: Series, period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const first = values.findIndex((v) => v !== null);
  if (first < 0) return out;
  const dense = values.slice(first) as number[];
  const e = ema(dense, period);
  for (let i = 0; i < e.length; i++) out[first + i] = e[i];
  return out;
}

/** Wilder's RSI. First value is at index `period`. */
export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  hist: Series;
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? (ef[i] as number) - (es[i] as number) : null));
  const signal = emaOfSeries(line, signalPeriod);
  const hist: Series = line.map((m, i) => (m !== null && signal[i] !== null ? m - (signal[i] as number) : null));
  return { macd: line, signal, hist };
}

/** Wilder's ATR. First value at index period-1 (simple average of the first `period` true ranges). */
export function atr(candles: OHLCV[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface SupportResistance {
  support: number | null;
  resistance: number | null;
}

/**
 * Support/resistance from swing pivots in the last `lookback` candles.
 * Support = highest pivot low below the close, resistance = lowest pivot high above the close.
 * Falls back to the lookback range low/high.
 */
export function supportResistance(candles: OHLCV[], lookback = 50, wing = 2): SupportResistance {
  if (candles.length === 0) return { support: null, resistance: null };
  const slice = candles.slice(-lookback);
  const close = slice[slice.length - 1].c;
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = wing; i < slice.length - wing; i++) {
    let isLow = true;
    let isHigh = true;
    for (let j = 1; j <= wing; j++) {
      if (!(slice[i].l <= slice[i - j].l && slice[i].l <= slice[i + j].l)) isLow = false;
      if (!(slice[i].h >= slice[i - j].h && slice[i].h >= slice[i + j].h)) isHigh = false;
    }
    if (isLow) lows.push(slice[i].l);
    if (isHigh) highs.push(slice[i].h);
  }
  const below = lows.filter((x) => x < close);
  const above = highs.filter((x) => x > close);
  const minLow = Math.min(...slice.map((c) => c.l));
  const maxHigh = Math.max(...slice.map((c) => c.h));
  return {
    support: below.length ? Math.max(...below) : minLow,
    resistance: above.length ? Math.min(...above) : maxHigh,
  };
}
