import { useEffect, useMemo, useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { put } from '../lib/api';
import { Badge, Button, ConfirmDialog, ErrorBox, Loading, PageHeader } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { wib } from '../lib/format';

type Field = { key: string; label: string; step?: number; bool?: boolean; hint?: string; options?: { value: string; label: string }[]; list?: boolean };
const GROUPS: { title: string; desc: string; icon: IconName; fields: Field[] }[] = [
  { title: 'Indikator', desc: 'Periode indikator teknikal yang dihitung pada candle 5 menit.', icon: 'activity', fields: [
    { key: 'emaFast', label: 'EMA cepat' }, { key: 'emaSlow', label: 'EMA lambat' }, { key: 'emaTrend', label: 'EMA tren' },
    { key: 'rsiPeriod', label: 'Periode RSI' }, { key: 'atrPeriod', label: 'Periode ATR' }, { key: 'volumeMaPeriod', label: 'Periode Volume MA' },
  ] },
  { title: 'Aturan Sinyal', desc: 'Kapan sinyal BUY/SELL dianggap valid dan boleh dieksekusi.', icon: 'signal', fields: [
    { key: 'rsiBuyMin', label: 'RSI BUY minimum', step: 0.1 }, { key: 'rsiBuyMax', label: 'RSI BUY maksimum', step: 0.1 },
    { key: 'rsiSellMax', label: 'RSI SELL maksimum', step: 0.1 }, { key: 'volumeMultiplier', label: 'Pengali volume', step: 0.05, hint: 'volume ≥ N × Volume MA' },
    { key: 'crossLookback', label: 'Jendela cross EMA (candle)', hint: '1 = hanya candle cross; 2 = cross boleh terjadi 1 candle sebelumnya' },
    { key: 'maxEntryExtensionPct', label: 'Jarak maks close di atas EMA lambat (%)', step: 0.1, hint: 'anti mengejar harga; 0 = nonaktif' },
    { key: 'maxEntrySpreadPct', label: 'Spread maks saat entry (%)', step: 0.05, hint: 'BUY dilewati jika spread lebih lebar; 0 = nonaktif' },
    { key: 'maxEntryDriftPct', label: 'Drift harga maks sejak sinyal (%)', step: 0.05, hint: 'BUY dilewati jika ask naik melebihi close sinyal; 0 = nonaktif' },
    { key: 'sellRequireConfirm', label: 'SELL wajib konfirmasi RSI + volume', bool: true, hint: 'mati = setiap cross-down langsung keluar' },
    { key: 'useTrendFilter', label: 'Filter tren (close > EMA tren)', bool: true }, { key: 'notifySignals', label: 'Kirim sinyal ke Telegram', bool: true },
    { key: 'minCandles', label: 'Minimal candle' }, { key: 'maxTickerAgeSeconds', label: 'Umur ticker maks (detik)' },
  ] },
  { title: 'Stop Loss & Take Profit', desc: 'Cara posisi ditutup otomatis berdasarkan ATR atau persentase cadangan.', icon: 'shield', fields: [
    { key: 'atrStopMultiplier', label: 'Stop loss (× ATR)', step: 0.1 }, { key: 'atrTakeProfitMultiplier', label: 'Take profit (× ATR)', step: 0.1 },
    { key: 'trailingStopEnabled', label: 'Trailing stop ATR', bool: true },
    { key: 'trailActivationAtr', label: 'Trailing aktif setelah profit (× ATR)', step: 0.1 },
    { key: 'trailDistanceAtr', label: 'Jarak trailing (× ATR)', step: 0.1 },
    { key: 'timeStopMinutes', label: 'Time stop (menit, 0 = mati)' },
    { key: 'fallbackStopPct', label: 'Stop loss cadangan (%)', step: 0.1 }, { key: 'fallbackTakeProfitPct', label: 'Take profit cadangan (%)', step: 0.1 },
  ] },
  { title: 'Risk Management & Biaya', desc: 'Ukuran posisi, batas eksposur, batas rugi, serta fee dan slippage simulasi.', icon: 'wallet', fields: [
    { key: 'riskPerTradePct', label: 'Risiko per trade (% equity)', step: 0.05 }, { key: 'maxPositionPct', label: 'Ukuran posisi maks (% equity)', step: 0.5 },
    { key: 'maxOpenPositions', label: 'Posisi terbuka maks' }, { key: 'maxTotalExposurePct', label: 'Eksposur total maks (% equity)', step: 1 },
    { key: 'closeOnDailyLoss', label: 'Tutup semua posisi saat batas rugi harian tercapai', bool: true },
    { key: 'dynamicSlippage', label: 'Slippage dinamis untuk pair tipis', bool: true }, { key: 'dailyLossLimitPct', label: 'Batas rugi harian (%)', step: 0.1 },
    { key: 'maxDrawdownPct', label: 'Max drawdown → kill switch (%)', step: 0.5 }, { key: 'feePct', label: 'Fee per sisi (%)', step: 0.01 },
    { key: 'slippageBps', label: 'Slippage (bps)', step: 1 },
  ] },
  { title: 'Multi-timeframe (MTF)', desc: 'Konfirmasi arah tren pada candle 15m dan 1h yang sudah selesai.', icon: 'chart', fields: [
    { key: 'mtfMode', label: 'Mode MTF', options: [
      { value: 'filter', label: 'Filter (BUY wajib searah 1h)' }, { value: 'score', label: 'Skor (hanya ubah kekuatan)' }, { value: 'off', label: 'Mati' },
    ], hint: 'Konfirmasi tren di candle 15m & 1h yang sudah selesai' },
    { key: 'mtfEmaFast', label: 'EMA cepat (15m/1h)' }, { key: 'mtfEmaSlow', label: 'EMA lambat (15m/1h)' },
    { key: 'mtfMinCandles', label: 'Minimal candle 15m/1h' },
  ] },
  { title: 'Universe Pair Dinamis', desc: 'Pemilihan otomatis pair IDR yang dipantau berdasarkan likuiditas.', icon: 'market', fields: [
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

const FIELDS = GROUPS.flatMap((g) => g.fields);

/** Normalises a form value to the type the server expects (same rules as the PUT payload). */
function norm(f: Field, v: any): unknown {
  if (f.bool) return !!v;
  if (f.options) return String(v ?? '');
  if (f.list) return (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x: string) => String(x).trim().toLowerCase()).filter(Boolean);
  return Number(v);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const slug = (t: string) => 'grp-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const inputCls = 'mt-1.5 h-9 w-full min-w-0 rounded-control border bg-surface-2 px-3 text-sm text-fg transition-colors hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-60';

function Toggle({ id, checked, disabled, onChange }: { id: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app disabled:cursor-not-allowed disabled:opacity-60 ${checked ? 'bg-accent-strong' : 'bg-line-strong'}`}>
      <span aria-hidden="true" className={`inline-block size-5 rounded-full bg-white shadow transition-transform duration-200 motion-reduce:transition-none ${checked ? 'translate-x-5.5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function Strategy({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = usePoll<any>('/api/strategy', 60000);
  const [form, setForm] = useState<Record<string, any>>({});
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askDefault, setAskDefault] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // A poll never overwrites fields the user is editing.
  useEffect(() => { if (data && !edited) setForm(data.effective); }, [data, edited]);

  const changed = useMemo(() => {
    const out = new Set<string>();
    if (!data?.effective) return out;
    for (const f of FIELDS) if (!same(norm(f, form[f.key]), norm(f, data.effective[f.key]))) out.add(f.key);
    return out;
  }, [form, data]);
  const dirty = changed.size > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setVal = (k: string, v: any) => { setForm((f) => ({ ...f, [k]: v })); setEdited(true); setOk(null); };
  const discard = () => { setForm(data.effective); setEdited(false); setErr(null); };
  const save = async () => {
    setErr(null); setOk(null); setSaving(true);
    const params: Record<string, unknown> = {};
    for (const f of FIELDS) params[f.key] = norm(f, form[f.key]);
    try { await put('/api/strategy', { params }); setEdited(false); setOk('Konfigurasi disimpan. Berlaku pada run cron berikutnya.'); await reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  if (loading && !data) return <Loading />;
  return (
    <div className="space-y-4">
      <PageHeader title="Strategy Configuration" subtitle={<>Strategi: <b>{data?.strategy?.name ?? 'ema_rsi_volume'}</b> • timeframe 5m • diperbarui {wib(data?.strategy?.updated_at)} {data?.strategy?.updated_by ? `oleh ${data.strategy.updated_by}` : ''}</>}
        actions={isAdmin ? <Button variant="ghost" onClick={() => setAskDefault(true)}><Icon name="refresh" className="size-4" />Kembalikan default</Button>
          : <Badge color="gray">Hanya baca — perubahan khusus admin</Badge>} />
      <ErrorBox error={error ?? err} />
      {ok && <div role="status" className="flex items-center gap-2 rounded-card border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200"><Icon name="check" className="size-4 shrink-0" />{ok}</div>}

      <nav aria-label="Bagian konfigurasi" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {GROUPS.map((g) => {
          const n = g.fields.filter((f) => changed.has(f.key)).length;
          return (
            <a key={g.title} href={`#${slug(g.title)}`} onClick={(e) => { e.preventDefault(); document.getElementById(slug(g.title))?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface-2 px-3 text-xs text-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <Icon name={g.icon} className="size-3.5" />{g.title}
              <span aria-hidden={!n} className={`num inline-flex size-4 items-center justify-center rounded-full bg-amber-500/20 text-[10px] text-amber-300 transition-opacity duration-150 ${n ? 'opacity-100' : 'opacity-0'}`}>{n || ''}</span>
            </a>
          );
        })}
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} id={slug(g.title)} className="min-w-0 scroll-mt-4 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
            <header className="mb-4 flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"><Icon name={g.icon} className="size-4" /></span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">{g.title}</h2>
                <p className="mt-0.5 text-xs text-muted">{g.desc}</p>
              </div>
            </header>
            <div className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
              {g.fields.map((f) => {
                const mod = changed.has(f.key);
                const border = mod ? 'border-amber-500/60' : 'border-line-strong';
                const id = `f-${f.key}`;
                const labelEl = (
                  <span className="flex items-center gap-1.5 text-sm text-muted">
                    <span className={`size-1.5 shrink-0 rounded-full bg-amber-400 transition-opacity duration-150 ${mod ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                    <span className="min-w-0">{f.label}</span>
                    {mod && <span className="sr-only">(diubah)</span>}
                  </span>
                );
                return (
                  <div key={f.key} className={`min-w-0 ${f.bool ? 'sm:col-span-2' : ''}`}>
                    {f.bool ? (
                      <div className="flex items-start justify-between gap-3 rounded-control border border-line/70 bg-surface-2/50 px-3 py-2.5">
                        <div className="min-w-0">
                          <label htmlFor={id}>{labelEl}</label>
                          {f.hint && <p className="mt-0.5 pl-3 text-xs text-subtle">{f.hint}</p>}
                        </div>
                        <Toggle id={id} checked={!!form[f.key]} disabled={!isAdmin} onChange={(v) => setVal(f.key, v)} />
                      </div>
                    ) : (
                      <label htmlFor={id} className="block">
                        {labelEl}
                        {f.options ? (
                          <select id={id} disabled={!isAdmin} value={form[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)} className={`${inputCls} ${border} cursor-pointer`}>
                            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : f.list ? (
                          <input id={id} type="text" disabled={!isAdmin} value={Array.isArray(form[f.key]) ? form[f.key].join(', ') : (form[f.key] ?? '')} onChange={(e) => setVal(f.key, e.target.value)} className={`${inputCls} ${border}`} />
                        ) : (
                          <input id={id} type="number" inputMode="decimal" step={f.step ?? 1} disabled={!isAdmin} value={form[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)} className={`num ${inputCls} ${border}`} />
                        )}
                        {f.hint && <span className="mt-1 block text-xs text-subtle">{f.hint}</span>}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <section className="rounded-card border border-line bg-surface p-4 shadow-card sm:p-5">
        <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><Icon name="info" className="size-4" />Aturan</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li><b>BUY</b>: EMA cepat memotong ke atas EMA lambat, RSI dalam rentang BUY, volume ≥ pengali × Volume MA, dan (opsional) close &gt; EMA tren.</li>
          <li><b>SELL</b>: EMA cepat memotong ke bawah EMA lambat (konfirmasi RSI ≤ batas SELL + volume hanya bila diaktifkan). Menutup posisi terbuka di pair tsb. Posisi juga keluar via stop loss, take profit, trailing stop ATR, time stop, atau batas rugi harian.</li>
          <li>Sinyal hanya dihitung pada candle 5 menit yang sudah selesai dan lolos pemeriksaan kualitas data.</li>
          <li><b>MTF</b>: tren 15m &amp; 1h (candle selesai) = bullish bila close &gt; EMA lambat dan EMA cepat &gt; EMA lambat, bearish sebaliknya. Mode <i>Filter</i>: BUY hanya bila 1h bullish dan tidak ada timeframe bearish (data belum siap = BUY ditahan); SELL tidak pernah diblokir karena berfungsi sebagai exit. Searah +10 kekuatan per timeframe, berlawanan −15.</li>
          <li><b>Universe dinamis</b>: tiap 15 menit pair IDR diperingkat menurut volume 24 jam (lolos volume minimal, spread maksimal, bukan stablecoin/maintenance). Pair manual selalu ikut; pair dengan posisi terbuka tetap dianalisa sampai ditutup.</li>
          <li>Validasi parameter dilakukan juga di server; nilai tidak valid ditolak.</li>
        </ul>
      </section>

      {isAdmin && (
        <div className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-header px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-sm" role="status" aria-live="polite">
              <span className={`size-2 shrink-0 rounded-full ${dirty ? 'bg-amber-400' : 'bg-emerald-500'}`} aria-hidden="true" />
              <span className="truncate">{dirty ? <><b className="num">{changed.size}</b> perubahan belum disimpan</> : <span className="text-muted">Semua perubahan tersimpan</span>}</span>
            </span>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" disabled={!dirty || saving} onClick={discard}>Batalkan</Button>
              <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Simpan</Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog open={askDefault} title="Kembalikan ke default?" confirmLabel="Isi nilai default"
        onCancel={() => setAskDefault(false)} onConfirm={() => { setForm(data.defaults); setEdited(true); setOk(null); setAskDefault(false); }}>
        Form akan diisi nilai default strategi. Perubahan belum tersimpan sampai Anda menekan <b>Simpan</b>.
      </ConfirmDialog>
    </div>
  );
}
