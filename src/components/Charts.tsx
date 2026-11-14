import { useEffect, useRef } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, createSeriesMarkers,
  type IChartApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { TZ } from '../lib/format';
import { padRange } from '../lib/chartRange';

const fmtTime = (t: Time) => {
  const d = new Date((t as number) * 1000);
  return d.toLocaleString('id-ID', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtTick = (t: Time) => {
  const d = new Date((t as number) * 1000);
  return d.toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
};

/**
 * Chart colours come from the CSS tokens (`--chart-*` in src/index.css), read when a chart is created,
 * so a second theme only has to override the variables.
 */
const FALLBACK = {
  text: '#94a3b8', grid: '#1e293b', border: '#334155', up: '#10b981', down: '#f43f5e', volume: '#334155',
  emaFast: '#facc15', emaSlow: '#38bdf8', emaTrend: '#a78bfa', rsi: '#f97316', macd: '#38bdf8', macdSignal: '#f43f5e', area: '#10b981',
};
export type ChartColors = typeof FALLBACK;
const TOKEN: Record<keyof ChartColors, string> = {
  text: '--chart-text', grid: '--chart-grid', border: '--chart-border', up: '--chart-up', down: '--chart-down', volume: '--chart-volume',
  emaFast: '--chart-ema-fast', emaSlow: '--chart-ema-slow', emaTrend: '--chart-ema-trend', rsi: '--chart-rsi', macd: '--chart-macd',
  macdSignal: '--chart-macd-signal', area: '--chart-area',
};
export function chartColors(): ChartColors {
  if (typeof document === 'undefined') return FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const out = { ...FALLBACK };
  for (const k of Object.keys(TOKEN) as (keyof ChartColors)[]) out[k] = cs.getPropertyValue(TOKEN[k]).trim() || FALLBACK[k];
  return out;
}
/** `#rrggbb` + alpha (0–1) → `#rrggbbaa`; other colour formats are returned unchanged. */
export const withAlpha = (c: string, a: number) =>
  /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c;

function baseChart(el: HTMLElement, height: number): IChartApi {
  const c = chartColors();
  return createChart(el, {
    height,
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border },
    timeScale: { borderColor: c.border, timeVisible: true, tickMarkFormatter: fmtTick },
    localization: { timeFormatter: fmtTime, priceFormatter: (p: number) => p.toLocaleString('id-ID', { maximumFractionDigits: p >= 1000 ? 0 : p >= 1 ? 2 : 8 }) },
    crosshair: { mode: 0 },
  });
}

const paddedAutoscale = (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
  const res = original();
  if (res?.priceRange) res.priceRange = padRange(res.priceRange.minValue, res.priceRange.maxValue);
  return res;
};

export interface CandlePoint { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface LinePoint { time: number; value: number }
export interface Marker { time: number; side: 'BUY' | 'SELL'; text?: string }

export function CandleChart({ candles, lines = [], markers = [], height = 460 }: {
  candles: CandlePoint[];
  lines?: { name: string; color: string; data: LinePoint[] }[];
  markers?: Marker[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = baseChart(ref.current, height);
    const c = chartColors();
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down,
    });
    cs.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, color: c.volume });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: withAlpha(k.close >= k.open ? c.up : c.down, 0.33) })));
    for (const l of lines) {
      const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: l.name });
      s.setData(l.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    if (markers.length) {
      createSeriesMarkers(cs, markers
        .filter((m) => candles.some((k) => k.time === m.time))
        .sort((a, b) => a.time - b.time)
        .map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.side === 'BUY' ? 'belowBar' : 'aboveBar',
          color: m.side === 'BUY' ? c.up : c.down,
          shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: m.text ?? m.side,
        })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, lines, markers, height]);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

export function AreaChart({ data, height = 260, color }: { data: LinePoint[]; height?: number; color?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = baseChart(ref.current, height);
    const col = color ?? chartColors().area;
    const s = chart.addSeries(AreaSeries, { lineColor: col, topColor: withAlpha(col, 0.33), bottomColor: withAlpha(col, 0.02), lineWidth: 2,
      autoscaleInfoProvider: paddedAutoscale,
    });
    s.setData(data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, height, color]);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

export function LineChart({ series, height = 160 }: { series: { name: string; color: string; data: LinePoint[] }[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = baseChart(ref.current, height);
    for (const l of series) {
      const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: 1, priceLineVisible: false, title: l.name });
      s.setData(l.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series, height]);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

export const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
