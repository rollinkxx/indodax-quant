import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Card, ErrorBox, Loading, PageHeader, Select, Stat, Empty } from '../components/ui';
import { CandleChart, LineChart, toSec, type Marker } from '../components/Charts';
import { idr, num, pairLabel, wib } from '../lib/format';

export default function Chart() {
  const [sp, setSp] = useSearchParams();
  const pairs = usePoll<any>('/api/market/pairs', 120000);
  const tracked: string[] = (pairs.data?.pairs ?? []).filter((p: any) => p.is_tracked).map((p: any) => p.id);
  const pair = sp.get('pair') ?? tracked[0] ?? 'btcidr';
  const tf = sp.get('tf') === '1m' ? '1m' : '5m';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set(k, v); setSp(n); };

  const cd = usePoll<any>(`/api/candles?pair=${pair}&tf=${tf}&limit=300`, 30000);
  const ind = usePoll<any>(`/api/indicators?pair=${pair}&limit=300`, 30000);
  const sig = usePoll<any>(`/api/signals?pair=${pair}&limit=100`, 60000);

  const candles = useMemo(() => (cd.data?.candles ?? []).map((c: any) => ({
    time: toSec(c.open_time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume,
  })), [cd.data]);
  const rows: any[] = ind.data?.indicators ?? [];
  const line = (k: string) => rows.filter((r) => r[k] !== null).map((r) => ({ time: toSec(r.open_time), value: +r[k] }));
  const lines = useMemo(() => tf === '5m' ? [
    { name: 'EMA9', color: '#facc15', data: line('ema9') },
    { name: 'EMA21', color: '#38bdf8', data: line('ema21') },
    { name: 'EMA50', color: '#a78bfa', data: line('ema50') },
  ] : [], [rows, tf]);
  const markers = useMemo<Marker[]>(() => tf === '5m' ? (sig.data?.signals ?? []).map((s: any) => ({ time: toSec(s.candle_time), side: s.side })) : [], [sig.data, tf]);
  const rsiSeries = useMemo(() => [{ name: 'RSI14', color: '#f97316', data: line('rsi14') }], [rows]);
  const macdSeries = useMemo(() => [
    { name: 'MACD', color: '#38bdf8', data: line('macd') },
    { name: 'Signal', color: '#f43f5e', data: line('macd_signal') },
  ], [rows]);
  const last = rows[rows.length - 1];

  const options = (tracked.length ? tracked : [pair]).map((p) => ({ value: p, label: pairLabel(p) }));
  if (!options.some((o) => o.value === pair)) options.unshift({ value: pair, label: pairLabel(pair) });

  return (
    <div className="space-y-4">
      <PageHeader title="Trading Chart" subtitle="Candlestick dibentuk dari transaksi aktual INDODAX"
        actions={<div className="flex gap-2">
          <Select value={pair} onChange={(v) => set('pair', v)} options={options} />
          <Select value={tf} onChange={(v) => set('tf', v)} options={[{ value: '5m', label: '5 menit' }, { value: '1m', label: '1 menit' }]} />
        </div>} />
      <ErrorBox error={cd.error ?? ind.error} />
      {last && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Stat label="Close" value={idr(last.close)} sub={wib(last.open_time)} />
          <Stat label="RSI 14" value={num(last.rsi14, 1)} />
          <Stat label="MACD hist" value={num(last.macd_hist, 4)} />
          <Stat label="ATR 14" value={idr(last.atr14)} />
          <Stat label="Support" value={idr(last.support)} />
          <Stat label="Resistance" value={idr(last.resistance)} />
        </div>
      )}
      <Card title={`${pairLabel(pair)} • ${tf}`}>
        {cd.loading && !cd.data ? <Loading /> : candles.length ? <CandleChart candles={candles} lines={lines} markers={markers} /> : <Empty>Belum ada candle untuk pair ini.</Empty>}
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
