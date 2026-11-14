import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, Loading, PageHeader, Segmented, Select, Empty } from '../components/ui';
import { Icon } from '../components/Icon';
import { TZ, idr, num, pairLabel } from '../lib/format';

const trendColor = (t: string) => (t === 'bull' ? 'green' : t === 'bear' ? 'red' : t === 'neutral' ? 'yellow' : 'gray');
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const dayLabel = (iso: string) => {
  const k = dayKey(iso);
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  const full = new Date(iso).toLocaleDateString('id-ID', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return k === today ? `Hari ini • ${full}` : k === yesterday ? `Kemarin • ${full}` : full;
};
const timeWib = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function SignalCard({ s, open, onToggle }: { s: any; open: boolean; onToggle: () => void }) {
  const buy = s.side === 'BUY';
  const reasons: string[] = Array.isArray(s.reasons) ? s.reasons : [];
  const strength = Math.max(0, Math.min(100, Number(s.strength) || 0));
  const mtf = s.indicators?.mtf ? Object.entries(s.indicators.mtf) as [string, any][] : [];
  const panelId = `sig-${s.id}`;
  return (
    <li className="relative pl-7">
      <span aria-hidden="true" className={`absolute left-0 top-4 grid size-[1.125rem] place-items-center rounded-full ring-4 ring-app ${buy ? 'bg-emerald-500/20 text-up' : 'bg-rose-500/20 text-down'}`}>
        <span className={`size-2 rounded-full ${buy ? 'bg-emerald-400' : 'bg-rose-400'}`} />
      </span>
      <article className={`overflow-hidden rounded-card border border-line border-l-2 bg-surface shadow-card ${buy ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panelId}
          className="flex w-full items-start gap-3 p-3.5 text-left transition-colors hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:p-4">
          <span className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-control ${buy ? 'bg-emerald-500/15 text-up' : 'bg-rose-500/15 text-down'}`}>
            <Icon name={buy ? 'trendUp' : 'trendDown'} className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-semibold">{pairLabel(s.pair_id)}</span>
              <Badge color={buy ? 'green' : 'red'}>{s.side}</Badge>
              {s.timeframe && <span className="text-xs text-subtle">{s.timeframe}</span>}
            </span>
            <span className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">{idr(s.price)}</span>
              <span className="text-xs text-muted">RSI {num(s.indicators?.rsi14 ?? s.indicators?.rsi, 1)}</span>
              <span className="hidden text-xs text-muted min-[400px]:inline">ATR {idr(s.indicators?.atr14)}</span>
            </span>
            <span className="mt-2 flex items-center gap-2" title={`Kekuatan ${num(strength, 0)} / 100`}>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-elevated sm:w-32">
                <span className={`block h-full w-full origin-left rounded-full ${buy ? 'bg-emerald-400' : 'bg-rose-400'}`} style={{ transform: `scaleX(${strength / 100})` }} />
              </span>
              <span className="num text-xs text-muted">Kekuatan {num(strength, 0)}</span>
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-2">
            <span className="num inline-flex items-center gap-1 text-xs text-muted"><Icon name="clock" className="size-3.5" />{timeWib(s.candle_time)} WIB</span>
            <Icon name="chevronDown" className={`size-4 text-subtle transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {open && (
          <div id={panelId} className="animate-fade-in space-y-3 border-t border-line px-3.5 py-3 text-sm sm:px-4">
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-subtle">Alasan</div>
              {reasons.length ? (
                <ul className="space-y-1">
                  {reasons.map((r, i) => (
                    <li key={i} className="flex gap-2 text-muted"><Icon name="check" className={`mt-0.5 size-4 ${buy ? 'text-up' : 'text-down'}`} /><span>{r}</span></li>
                  ))}
                </ul>
              ) : <p className="text-subtle">Tidak ada alasan tercatat.</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wider text-subtle">MTF</span>
              {mtf.length ? mtf.map(([tf, v]) => <Badge key={tf} color={trendColor(v?.trend)}>{tf} {v?.trend ?? '—'}</Badge>) : <span className="text-subtle">—</span>}
              <span className="num text-xs text-muted min-[400px]:hidden">ATR {idr(s.indicators?.atr14)}</span>
            </div>
            <Link to={`/chart?pair=${s.pair_id}`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
              Buka chart {pairLabel(s.pair_id)} <Icon name="chevronRight" className="size-4" />
            </Link>
          </div>
        )}
      </article>
    </li>
  );
}

export default function Signals() {
  const [side, setSide] = useState('');
  const [pair, setPair] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const pairs = usePoll<any>('/api/market/pairs', 120000);
  const qs = new URLSearchParams({ limit: '200', ...(side ? { side } : {}), ...(pair ? { pair } : {}) });
  const { data, error, loading } = usePoll<any>(`/api/signals?${qs}`, 30000);
  const tracked = (pairs.data?.pairs ?? []).filter((p: any) => p.is_tracked || p.in_universe);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: any[] }[] = [];
    for (const s of (data?.signals ?? []) as any[]) {
      const k = dayKey(s.candle_time);
      const g = out[out.length - 1];
      if (g && g.key === k) g.items.push(s); else out.push({ key: k, label: dayLabel(s.candle_time), items: [s] });
    }
    return out;
  }, [data]);
  const counts = useMemo(() => {
    const list = (data?.signals ?? []) as any[];
    return { buy: list.filter((s) => s.side === 'BUY').length, sell: list.filter((s) => s.side === 'SELL').length };
  }, [data]);

  const toggle = (id: string) => setOpen((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-4">
      <PageHeader title="Trading Signals" subtitle="EMA crossover + RSI + konfirmasi volume pada candle 5 menit, dikonfirmasi tren 15m & 1h (MTF)" />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pair} onChange={setPair} options={[{ value: '', label: 'Semua pair' }, ...tracked.map((p: any) => ({ value: p.id, label: pairLabel(p.id) }))]} />
        <Segmented label="Jenis sinyal" value={side} onChange={setSide}
          options={[{ value: '', label: 'Semua' }, { value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }]} />
        {data && (
          <span className="num ml-auto flex items-center gap-3 text-xs text-muted">
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-400" />{counts.buy} BUY</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-rose-400" />{counts.sell} SELL</span>
          </span>
        )}
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Card><Loading rows={6} /></Card> : groups.length ? (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-subtle">{g.label}</h2>
              <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[0.5625rem] before:top-2 before:w-px before:bg-line">
                {g.items.map((s) => <SignalCard key={s.id} s={s} open={open.has(String(s.id))} onToggle={() => toggle(String(s.id))} />)}
              </ol>
            </section>
          ))}
        </div>
      ) : <Card><Empty>Belum ada sinyal. Sinyal hanya muncul saat seluruh syarat strategi dan data-quality gate terpenuhi.</Empty></Card>}
    </div>
  );
}
