import { useEffect, useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { put } from '../lib/api';
import { Button, Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { wib } from '../lib/format';

type Field = { key: string; label: string; step?: number; bool?: boolean; hint?: string };
const GROUPS: { title: string; fields: Field[] }[] = [
  { title: 'Indikator', fields: [
    { key: 'emaFast', label: 'EMA cepat' }, { key: 'emaSlow', label: 'EMA lambat' }, { key: 'emaTrend', label: 'EMA tren' },
    { key: 'rsiPeriod', label: 'Periode RSI' }, { key: 'atrPeriod', label: 'Periode ATR' }, { key: 'volumeMaPeriod', label: 'Periode Volume MA' },
  ] },
  { title: 'Aturan Sinyal', fields: [
    { key: 'rsiBuyMin', label: 'RSI BUY minimum', step: 0.1 }, { key: 'rsiBuyMax', label: 'RSI BUY maksimum', step: 0.1 },
    { key: 'rsiSellMax', label: 'RSI SELL maksimum', step: 0.1 }, { key: 'volumeMultiplier', label: 'Pengali volume', step: 0.05, hint: 'volume ≥ N × Volume MA' },
    { key: 'useTrendFilter', label: 'Filter tren (close > EMA tren)', bool: true }, { key: 'notifySignals', label: 'Kirim sinyal ke Telegram', bool: true },
    { key: 'minCandles', label: 'Minimal candle' }, { key: 'maxTickerAgeSeconds', label: 'Umur ticker maks (detik)' },
  ] },
  { title: 'Stop Loss & Take Profit', fields: [
    { key: 'atrStopMultiplier', label: 'Stop loss (× ATR)', step: 0.1 }, { key: 'atrTakeProfitMultiplier', label: 'Take profit (× ATR)', step: 0.1 },
    { key: 'fallbackStopPct', label: 'Stop loss cadangan (%)', step: 0.1 }, { key: 'fallbackTakeProfitPct', label: 'Take profit cadangan (%)', step: 0.1 },
  ] },
  { title: 'Risk Management & Biaya', fields: [
    { key: 'riskPerTradePct', label: 'Risiko per trade (% equity)', step: 0.05 }, { key: 'maxPositionPct', label: 'Ukuran posisi maks (% equity)', step: 0.5 },
    { key: 'maxOpenPositions', label: 'Posisi terbuka maks' }, { key: 'dailyLossLimitPct', label: 'Batas rugi harian (%)', step: 0.1 },
    { key: 'maxDrawdownPct', label: 'Max drawdown → kill switch (%)', step: 0.5 }, { key: 'feePct', label: 'Fee per sisi (%)', step: 0.01 },
    { key: 'slippageBps', label: 'Slippage (bps)', step: 1 },
  ] },
];

export default function Strategy({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = usePoll<any>('/api/strategy', 60000);
  const [form, setForm] = useState<Record<string, any>>({});
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => { if (data && !dirty) setForm(data.effective); }, [data, dirty]);

  const setVal = (k: string, v: any) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); setOk(null); };
  const save = async () => {
    setErr(null); setOk(null);
    const params: Record<string, unknown> = {};
    for (const g of GROUPS) for (const f of g.fields) params[f.key] = f.bool ? !!form[f.key] : Number(form[f.key]);
    try { await put('/api/strategy', { params }); setDirty(false); setOk('Konfigurasi disimpan. Berlaku pada run cron berikutnya.'); await reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  if (loading && !data) return <Loading />;
  return (
    <div className="space-y-4">
      <PageHeader title="Strategy Configuration" subtitle={<>Strategi: <b>{data?.strategy?.name ?? 'ema_rsi_volume'}</b> • timeframe 5m • diperbarui {wib(data?.strategy?.updated_at)} {data?.strategy?.updated_by ? `oleh ${data.strategy.updated_by}` : ''}</>}
        actions={isAdmin && <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setForm(data.defaults); setDirty(true); }}>Kembalikan default</Button>
          <Button variant="primary" disabled={!dirty} onClick={save}>Simpan</Button>
        </div>} />
      <ErrorBox error={error ?? err} />
      {ok && <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{ok}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <Card key={g.title} title={g.title}>
            <div className="grid gap-3 sm:grid-cols-2">
              {g.fields.map((f) => (
                <label key={f.key} className="block text-sm">
                  <span className="text-slate-400">{f.label}</span>
                  {f.bool ? (
                    <div className="mt-1"><input type="checkbox" disabled={!isAdmin} checked={!!form[f.key]} onChange={(e) => setVal(f.key, e.target.checked)} className="h-4 w-4 accent-emerald-500" /></div>
                  ) : (
                    <input type="number" step={f.step ?? 1} disabled={!isAdmin} value={form[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)}
                      className="num mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 disabled:opacity-60" />
                  )}
                  {f.hint && <span className="text-xs text-slate-500">{f.hint}</span>}
                </label>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <Card title="Aturan">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li><b>BUY</b>: EMA cepat memotong ke atas EMA lambat, RSI dalam rentang BUY, volume ≥ pengali × Volume MA, dan (opsional) close &gt; EMA tren.</li>
          <li><b>SELL</b>: EMA cepat memotong ke bawah EMA lambat, RSI ≤ batas SELL, dengan konfirmasi volume. Menutup posisi terbuka di pair tsb.</li>
          <li>Sinyal hanya dihitung pada candle 5 menit yang sudah selesai dan lolos pemeriksaan kualitas data.</li>
          <li>Validasi parameter dilakukan juga di server; nilai tidak valid ditolak.</li>
        </ul>
      </Card>
    </div>
  );
}
