import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Card, ErrorBox, Loading, PageHeader, Segmented, Stat, Empty } from '../components/ui';
import { CandleChart, LineChart, chartColors, toSec, type Marker } from '../components/Charts';
import { idr, num, pairLabel, wib } from '../lib/format';

export default function Chart() {
  const [sp, setSp] = useSearchParams();
  const pairs = usePoll<any>('/api/market/pairs', 120000);
  const tracked: string[] = (pairs.data?.pairs ?? []).filter((p: any) => p.is_tracked || p.in_universe).map((p: any) => p.id);
  const pair = sp.get('pair') ?? tracked[0] ?? 'btcidr';
  const tfRaw = sp.get('tf');
  const tf = tfRaw === '1m' || tfRaw === '15m' || tfRaw === '1h' ? tfRaw : '5m';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n, { replace: true }); };
  const colors = useMemo(() => chartColors(), []);
  const [chartH] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 340 : 460));

  const cd = usePoll<any>(`/api/candles?pair=${pair}&tf=${tf}&limit=300`, 30000);
  const ind = usePoll<any>(`/api/indicators?pair=${pair}&limit=300`, 30000);
  const sig = usePoll<any>(`/api/signals?pair=${pair}&limit=100`, 60000);
  const m15 = usePoll<any>(`/api/indicators?pair=${pair}&tf=15m&limit=1`, 60000);
  const h1 = usePoll<any>(`/api/indicators?pair=${pair}&tf=1h&limit=1`, 60000);
  const mtf = [{ tf: '15m', r: m15.data?.indicators?.[0] }, { tf: '1h', r: h1.data?.indicators?.[0] }].map(({ tf, r }) => {
    if (!r || r.ema9 === null || r.ema21 === null) return { tf, trend: 'belum siap', color: 'text-subtle', r };
    const c = +r.close, f = +r.ema9, s = +r.ema21;
    return c > s && f > s ? { tf, trend: 'bullish', color: 'text-emerald-300', r } : c < s && f < s ? { tf, trend: 'bearish', color: 'text-rose-300', r } : { tf, trend: 'netral', color: 'text-amber-300', r };
  });

  const candles = useMemo(() => (cd.data?.candles ?? []).map((c: any) => ({
    time: toSec(c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume,
  })), [cd.data]);
  const rows: any[] = ind.data?.indicators ?? [];
  const line = (k: string) => rows.filter((r) => r[k] !== null).map((r) => ({ time: toSec(r.open_time), value: +r[k] }));
  const lines = useMemo(() => tf === '5m' ? [
    { name: 'EMA9', color: colors.emaFast, data: line('ema9') },
    { name: 'EMA21', color: colors.emaSlow, data: line('ema21') },
    { name: 'EMA50', color: colors.emaTrend, data: line('ema50') },
  ] : [], [rows, tf, colors]);
  const markers = useMemo<Marker[]>(() => tf === '5m' ? (sig.data?.signals ?? []).map((s: any) => ({ time: toSec(s.candle_time), side: s.side })) : [], [sig.data, tf]);
  const rsiSeries = useMemo(() => [{ name: 'RSI14', color: colors.rsi, data: line('rsi14') }], [rows, colors]);
  const macdSeries = useMemo(() => [
    { name: 'MACD', color: colors.macd, data: line('macd') },
    { name: 'Signal', color: colors.macdSignal, data: line('macd_signal') },
  ], [rows, colors]);
  const last = rows[rows.length - 1];

  const options = (tracked.length ? tracked : [pair]).map((p) => ({ value: p, label: pairLabel(p) }));
  if (!options.some((o) => o.value === pair)) options.unshift({ value: pair, label: pairLabel(pair) });

  const legend = tf === '5m' ? [['EMA9', colors.emaFast], ['EMA21', colors.emaSlow], ['EMA50', colors.emaTrend]] : [];

  return (
    <div className="space-y-4">
      <PageHeader title="Trading Chart" subtitle="Candlestick dibentuk dari transaksi aktual INDODAX" />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Pair" scroll value={pair} onChange={(v) => set('pair', v)} options={options} className="min-w-0" />
        <Segmented label="Timeframe" value={tf} onChange={(v) => set('tf', v)}
          options={[{ value: '1m', label: '1m' }, { value: '5m', label: '5m' }, { value: '15m', label: '15m' }, { value: '1h', label: '1j' }]} />
      </div>
      <ErrorBox error={cd.error ?? ind.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Close" value={last ? idr(last.close) : '—'} sub={last ? wib(last.open_time) : 'menunggu data'} />
        <Stat label="RSI 14" value={last ? num(last.rsi14, 1) : '—'} />
        <Stat label="MACD hist" value={last ? num(last.macd_hist, 4) : '—'} valueClass={last ? (Number(last.macd_hist) > 0 ? 'text-up' : Number(last.macd_hist) < 0 ? 'text-down' : '') : ''} />
        <Stat label="ATR 14" value={last ? idr(last.atr14) : '—'} />
        <Stat label="Support" value={last ? idr(last.support) : '—'} />
        <Stat label="Resistance" value={last ? idr(last.resistance) : '—'} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {mtf.map((m) => (
          <Stat key={m.tf} label={`Tren ${m.tf} (MTF)`} value={m.trend} valueClass={m.color}
            sub={m.r ? `RSI ${num(m.r.rsi14, 1)} • ${wib(m.r.open_time)}` : 'menunggu data'} />
        ))}
      </div>
      <Card title={`${pairLabel(pair)} • ${tf === '1h' ? '1j' : tf}`}
        actions={legend.length ? <div className="flex flex-wrap gap-3 text-xs text-muted">{legend.map(([n, c]) => (
          <span key={n} className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: c }} />{n}</span>
        ))}</div> : undefined}>
        {cd.loading && !cd.data ? <Loading height={chartH} /> : candles.length
          ? <CandleChart candles={candles} lines={lines} markers={markers} height={chartH} />
          : <div className="flex items-center justify-center" style={{ height: chartH }}><Empty>Belum ada candle untuk pair ini.</Empty></div>}
      </Card>
      {tf === '5m' && rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="RSI 14"><LineChart series={rsiSeries} /></Card>
          <Card title="MACD (12, 26, 9)"><LineChart series={macdSeries} /></Card>
        </div>
      )}
    </div>
  );
}
