import { useEffect, useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { put } from '../lib/api';
import { Button, Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { wib } from '../lib/format';

type Field = { key: string; label: string; step?: number; bool?: boolean; hint?: string; options?: { value: string; label: string }[]; list?: boolean };
const GROUPS: { title: string; fields: Field[] }[] = [
  { title: 'Indikator', fields: [
    { key: 'emaFast', label: 'EMA cepat' }, { key: 'emaSlow', label: 'EMA lambat' }, { key: 'emaTrend', label: 'EMA tren' },
    { key: 'rsiPeriod', label: 'Periode RSI' }, { key: 'atrPeriod', label: 'Periode ATR' }, { key: 'volumeMaPeriod', label: 'Periode Volume MA' },
  ] },
  { title: 'Aturan Sinyal', fields: [
    { key: 'rsiBuyMin', label: 'RSI BUY minimum', step: 0.1 }, { key: 'rsiBuyMax', label: 'RSI BUY maksimum', step: 0.1 },
    { key: 'rsiSellMax', label: 'RSI SELL maksimum', step: 0.1 }, { key: 'volumeMultiplier', label: 'Pengali volume', step: 0.05, hint: 'volume ≥ N × Volume MA' },
    { key: 'crossLookback', label: 'Jendela cross EMA (candle)', hint: '1 = hanya candle cross; 2 = cross boleh terjadi 1 candle sebelumnya' },
    { key: 'maxEntryExtensionPct', label: 'Jarak maks close di atas EMA lambat (%)', step: 0.1, hint: 'anti mengejar harga; 0 = nonaktif' },
    { key: 'sellRequireConfirm', label: 'SELL wajib konfirmasi RSI + volume', bool: true, hint: 'mati = setiap cross-down langsung keluar' },
    { key: 'useTrendFilter', label: 'Filter tren (close > EMA tren)', bool: true }, { key: 'notifySignals', label: 'Kirim sinyal ke Telegram', bool: true },
    { key: 'minCandles', label: 'Minimal candle' }, { key: 'maxTickerAgeSeconds', label: 'Umur ticker maks (detik)' },
  ] },
  { title: 'Stop Loss & Take Profit', fields: [
    { key: 'atrStopMultiplier', label: 'Stop loss (× ATR)', step: 0.1 }, { key: 'atrTakeProfitMultiplier', label: 'Take profit (× ATR)', step: 0.1 },
    { key: 'trailingStopEnabled', label: 'Trailing stop ATR', bool: true },
    { key: 'trailActivationAtr', label: 'Trailing aktif setelah profit (× ATR)', step: 0.1 },
    { key: 'trailDistanceAtr', label: 'Jarak trailing (× ATR)', step: 0.1 },
    { key: 'timeStopMinutes', label: 'Time stop (menit, 0 = mati)' },
    { key: 'fallbackStopPct', label: 'Stop loss cadangan (%)', step: 0.1 }, { key: 'fallbackTakeProfitPct', label: 'Take profit cadangan (%)', step: 0.1 },
  ] },
  { title: 'Risk Management & Biaya', fields: [
    { key: 'riskPerTradePct', label: 'Risiko per trade (% equity)', step: 0.05 }, { key: 'maxPositionPct', label: 'Ukuran posisi maks (% equity)', step: 0.5 },
    { key: 'maxOpenPositions', label: 'Posisi terbuka maks' }, { key: 'maxTotalExposurePct', label: 'Eksposur total maks (% equity)', step: 1 },
    { key: 'closeOnDailyLoss', label: 'Tutup semua posisi saat batas rugi harian tercapai', bool: true },
    { key: 'dynamicSlippage', label: 'Slippage dinamis untuk pair tipis', bool: true }, { key: 'dailyLossLimitPct', label: 'Batas rugi harian (%)', step: 0.1 },
    { key: 'maxDrawdownPct', label: 'Max drawdown → kill switch (%)', step: 0.5 }, { key: 'feePct', label: 'Fee per sisi (%)', step: 0.01 },
    { key: 'slippageBps', label: 'Slippage (bps)', step: 1 },
  ] },
  { title: 'Multi-timeframe (MTF)', fields: [
    { key: 'mtfMode', label: 'Mode MTF', options: [
      { value: 'filter', label: 'Filter (BUY wajib searah 1h)' }, { value: 'score', label: 'Skor (hanya ubah kekuatan)' }, { value: 'off', label: 'Mati' },
    ], hint: 'Konfirmasi tren di candle 15m & 1h yang sudah selesai' },
    { key: 'mtfEmaFast', label: 'EMA cepat (15m/1h)' }, { key: 'mtfEmaSlow', label: 'EMA lambat (15m/1h)' },
    { key: 'mtfMinCandles', label: 'Minimal candle 15m/1h' },
  ] },
  { title: 'Universe Pair Dinamis', fields: [
    { key: 'universeMode', label: 'Mode universe', options: [
      { value: 'dynamic', label: 'Dinamis (otomatis + manual)' }, { value: 'manual', label: 'Manual saja' },
    ] },
    { key: 'universeSize', label: 'Total pair dipantau', hint: 'termasuk pair manual; maks 25' },
    { key: 'universeMinVolumeIdr', label: 'Volume 24j minimal (IDR)', step: 1000000 },
    { key: 'universeMaxSpreadPct', label: 'Spread maksimal (%)', step: 0.05 },
    { key: 'universeBuffer', label: 'Buffer peringkat (histeresis)', hint: 'anggota bertahan selama peringkat ≤ slot + buffer' },
    { key: 'universeMaxNewPerUpdate', label: 'Pair baru maks per update', hint: 'update tiap 15 menit' },
    { key: 'universeExclude', label: 'Pair dikecualikan', list: true, hint: 'pisahkan dengan koma, mis. usdtidr, usdcidr' },
    { key: 'notifyUniverse', label: 'Kirim perubahan universe ke Telegram', bool: true },
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
    for (const g of GROUPS) for (const f of g.fields) {
      const v = form[f.key];
      params[f.key] = f.bool ? !!v
        : f.options ? String(v)
        : f.list ? (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x: string) => x.trim().toLowerCase()).filter(Boolean)
        : Number(v);
    }
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
                  ) : f.options ? (
                    <select disabled={!isAdmin} value={form[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 disabled:opacity-60">
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.list ? (
                    <input type="text" disabled={!isAdmin} value={Array.isArray(form[f.key]) ? form[f.key].join(', ') : (form[f.key] ?? '')} onChange={(e) => setVal(f.key, e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 disabled:opacity-60" />
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
          <li><b>SELL</b>: EMA cepat memotong ke bawah EMA lambat (konfirmasi RSI ≤ batas SELL + volume hanya bila diaktifkan). Menutup posisi terbuka di pair tsb. Posisi juga keluar via stop loss, take profit, trailing stop ATR, time stop, atau batas rugi harian.</li>
          <li>Sinyal hanya dihitung pada candle 5 menit yang sudah selesai dan lolos pemeriksaan kualitas data.</li>
          <li><b>MTF</b>: tren 15m &amp; 1h (candle selesai) = bullish bila close &gt; EMA lambat dan EMA cepat &gt; EMA lambat, bearish sebaliknya. Mode <i>Filter</i>: BUY hanya bila 1h bullish dan tidak ada timeframe bearish (data belum siap = BUY ditahan); SELL tidak pernah diblokir karena berfungsi sebagai exit. Searah +10 kekuatan per timeframe, berlawanan −15.</li>
          <li><b>Universe dinamis</b>: tiap 15 menit pair IDR diperingkat menurut volume 24 jam (lolos volume minimal, spread maksimal, bukan stablecoin/maintenance). Pair manual selalu ikut; pair dengan posisi terbuka tetap dianalisa sampai ditutup.</li>
          <li>Validasi parameter dilakukan juga di server; nilai tidak valid ditolak.</li>
        </ul>
      </Card>
    </div>
  );
}
