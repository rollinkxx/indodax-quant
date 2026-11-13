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

function baseChart(el: HTMLElement, height: number): IChartApi {
  return createChart(el, {
    height,
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
    grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
    rightPriceScale: { borderColor: '#334155' },
    timeScale: { borderColor: '#334155', timeVisible: true, tickMarkFormatter: fmtTick },
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
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', downColor: '#f43f5e', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#f43f5e',
    });
    cs.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, color: '#334155' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#10b98155' : '#f43f5e55' })));
    for (const l of lines) {
      const s = chart.addSeries(LineSeries, { color: l.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: l.name });
      s.setData(l.data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    if (markers.length) {
      createSeriesMarkers(cs, markers
        .filter((m) => candles.some((c) => c.time === m.time))
        .sort((a, b) => a.time - b.time)
        .map((m) => ({
          time: m.time as UTCTimestamp,
          position: m.side === 'BUY' ? 'belowBar' : 'aboveBar',
          color: m.side === 'BUY' ? '#10b981' : '#f43f5e',
          shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: m.text ?? m.side,
        })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, lines, markers, height]);
  return <div ref={ref} className="w-full" style={{ height }} />;
}

export function AreaChart({ data, height = 260, color = '#10b981' }: { data: LinePoint[]; height?: number; color?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = baseChart(ref.current, height);
    const s = chart.addSeries(AreaSeries, { lineColor: color, topColor: color + '55', bottomColor: color + '05', lineWidth: 2,
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
