import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, Empty, ErrorBox, Loading, PageHeader, Segmented, Stat, statusColor } from '../components/ui';
import { Icon } from '../components/Icon';
import { num, pairLabel, wib } from '../lib/format';

interface PairDecision {
  pairId: string; stage: string; outcome: string; candidate: boolean; barsSinceCross: number | null;
  filters: Record<string, boolean>; metrics: Record<string, number | null>;
  dataQuality: string; mtf: string; mtfBlock: string | null;
  marketAction: string | null; holdReason: string | null; rawSignalSide: string | null;
}
interface EntryRejection { pairId: string; signalId: number | null; stage: string; reason: string; metrics: Record<string, number> }
interface Decisions {
  scheduledTime: string | null; status: string | null; accountStatus: string | null;
  buySignalsReceived: number; entriesOpened: number; openPositions: number;
  equity: number | null; drawdownPct: number | null;
  pairs: PairDecision[]; stageCounts: Record<string, number>;
  mtfBlocked: Record<string, string>; entryRejections: EntryRejection[];
  entryRejectionCounts: Record<string, number>; riskBlockReasons: string[];
  actions: string[]; degraded: string[];
}

const FILTER_ORDER = ['trend', 'rsi', 'volume', 'extension'] as const;

const STAGE_TONE: Record<string, string> = {
  no_recent_cross: 'gray',
  passed_mtf: 'green',
  blocked_by_mtf: 'red',
  sell_signal: 'red',
  blocked_by_data_quality: 'yellow',
  blocked_by_stale_ticker: 'yellow',
  blocked_by_maintenance: 'yellow',
  blocked_by_no_candles: 'gray',
  blocked_by_insufficient_rows: 'yellow',
  indicators_not_ready: 'gray',
  diagnostic_mismatch: 'red',
};

const stageTone = (outcome: string) => STAGE_TONE[outcome] ?? (outcome.startsWith('blocked') ? 'red' : 'gray');
const humanize = (s: string) => s.replace(/_/g, ' ');
const trendTone = (t: string) => (t === 'bull' ? 'green' : t === 'bear' ? 'red' : t === 'neutral' ? 'yellow' : 'gray');

function FilterDots({ filters }: { filters: Record<string, boolean> }) {
  const keys = FILTER_ORDER.filter((k) => k in filters);
  if (!keys.length) return <span className="text-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {keys.map((k) => (
        <span key={k} title={`${k}: ${filters[k] ? 'lolos' : 'gagal'}`} className="inline-flex items-center gap-1">
          <span className={`size-2 rounded-full ${filters[k] ? 'bg-emerald-400' : 'bg-slate-500'}`} />
          <span className="text-[11px] text-muted">{k}</span>
        </span>
      ))}
    </span>
  );
}

function MtfBadges({ mtf }: { mtf: string }) {
  if (!mtf || mtf === 'off') return <span className="text-subtle">off</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {mtf.split(' ').map((part, i) => {
        const [tf, trend] = part.split(':');
        return <Badge key={i} color={trendTone(trend)}>{tf} {trend}</Badge>;
      })}
    </span>
  );
}

function PairRow({ p }: { p: PairDecision }) {
  const rsi = p.metrics?.rsi;
  const volRatio = p.metrics?.volume_ratio;
  return (
    <tr>
      <td className="whitespace-nowrap px-3 py-2 font-medium">{pairLabel(p.pairId)}</td>
      <td className="px-3 py-2"><Badge color={stageTone(p.outcome)}>{humanize(p.outcome)}</Badge></td>
      <td className="hidden px-3 py-2 md:table-cell"><FilterDots filters={p.filters} /></td>
      <td className="num hidden px-3 py-2 text-right sm:table-cell">{rsi != null ? num(rsi, 1) : '—'}</td>
      <td className="num hidden px-3 py-2 text-right sm:table-cell">{volRatio != null ? `${num(volRatio, 2)}×` : '—'}</td>
      <td className="hidden px-3 py-2 lg:table-cell"><MtfBadges mtf={p.mtf} /></td>
      <td className="px-3 py-2 text-right">
        <Link to={`/chart?pair=${p.pairId}`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Chart <Icon name="chevronRight" className="size-3.5" />
        </Link>
      </td>
    </tr>
  );
}

export default function Decisions() {
  const { data, error, loading } = usePoll<{ latest: Decisions | null; runs: Decisions[] }>('/api/engine-decisions?limit=12', 15000);
  const [tab, setTab] = useState<'latest' | 'history'>('latest');
  const [runIndex, setRunIndex] = useState(0);
  const [onlyBlocked, setOnlyBlocked] = useState(false);

  const latest = data?.latest ?? null;
  const runs = data?.runs ?? [];
  const active = tab === 'latest' ? latest : runs[runIndex] ?? latest;

  const pairs = useMemo(() => {
    const list = active?.pairs ?? [];
    if (!onlyBlocked) return list;
    return list.filter((p) => p.outcome.startsWith('blocked') || p.candidate);
  }, [active, onlyBlocked]);

  if (loading && !data) return <Loading />;

  return (
    <div className="space-y-5">
      <PageHeader title="Engine Decisions"
        subtitle="Kenapa engine memutuskan BUY / SELL / HOLD pada setiap pair di setiap run — read-only, tanpa mengubah apa pun." />

      <ErrorBox error={error} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={tab} onChange={(v) => setTab(v as 'latest' | 'history')} label="Tampilan" options={[
          { value: 'latest', label: 'Run terakhir' },
          { value: 'history', label: `Riwayat (${runs.length})` },
        ]} />
        {tab === 'history' && runs.length > 0 && (
          <Segmented value={String(runIndex)} onChange={(v) => setRunIndex(Number(v))} label="Pilih run" scroll
            options={runs.map((r, i) => ({ value: String(i), label: r.scheduledTime ? wib(r.scheduledTime, true) : `#${i}` }))} />
        )}
      </div>

      {!active ? (
        <Empty>Belum ada run yang tercatat. Pastikan Worker sudah di-deploy dan Cron Trigger aktif.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Status run" value={<Badge color={statusColor(active.status ?? undefined)}>{active.status ?? '—'}</Badge>}
              sub={active.scheduledTime ? wib(active.scheduledTime, true) : '—'} />
            <Stat label="Pair dianalisis" value={num(active.pairs.length, 0)}
              sub={`${Object.values(active.stageCounts).reduce((a, b) => a + b, 0)} baris diagnostik`} />
            <Stat label="Sinyal BUY diterima" value={num(active.buySignalsReceived, 0)}
              sub={`${active.entriesOpened} entri dibuka • ${active.openPositions} posisi terbuka`} />
            <Stat label="Alasan ditolak" value={num(Object.values(active.entryRejectionCounts).reduce((a, b) => a + b, 0), 0)}
              sub={Object.keys(active.entryRejectionCounts)[0] ? humanize(Object.keys(active.entryRejectionCounts)[0]) : 'tidak ada penolakan entri'} />
          </div>

          {(active.riskBlockReasons.length > 0 || active.degraded.length > 0) && (
            <Card title="Peringatan run">
              <ul className="space-y-1 text-sm">
                {active.riskBlockReasons.map((r, i) => (
                  <li key={`r${i}`} className="flex gap-2 text-amber-300"><Icon name="alert" className="mt-0.5 size-4 shrink-0" />Risiko portofolio memblokir entri: {humanize(r)}</li>
                ))}
                {active.degraded.map((r, i) => (
                  <li key={`d${i}`} className="flex gap-2 text-rose-300"><Icon name="alert" className="mt-0.5 size-4 shrink-0" />Safety-net terdegradasi: {humanize(r)}</li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Ringkasan alasan HOLD per tahap"
            actions={<label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={onlyBlocked} onChange={(e) => setOnlyBlocked(e.target.checked)} className="size-3.5 accent-sky-500" />
              Sembunyikan pair tanpa sinyal
            </label>}>
            <div className="flex flex-wrap gap-2">
              {Object.entries(active.stageCounts).sort((a, b) => b[1] - a[1]).map(([stage, n]) => (
                <span key={stage} className="inline-flex items-center gap-2 rounded-control border border-line bg-app/50 px-2.5 py-1.5">
                  <Badge color={stageTone(stage)}>{humanize(stage)}</Badge>
                  <span className="num text-sm font-medium">{n}</span>
                </span>
              ))}
            </div>
          </Card>

          <Card title={`Keputusan per pair (${pairs.length})`}>
            {pairs.length ? (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-subtle">
                      <th className="px-3 py-2 font-medium">Pair</th>
                      <th className="px-3 py-2 font-medium">Hasil</th>
                      <th className="hidden px-3 py-2 font-medium md:table-cell">Filter (t/r/v/e)</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">RSI</th>
                      <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Vol×</th>
                      <th className="hidden px-3 py-2 font-medium lg:table-cell">MTF</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {pairs.map((p) => <PairRow key={p.pairId} p={p} />)}
                  </tbody>
                </table>
              </div>
            ) : <Empty>{onlyBlocked ? 'Tidak ada pair yang kandidat atau terblokir pada run ini.' : 'Tidak ada diagnostik pair pada run ini.'}</Empty>}
          </Card>

          <Card title={`Penolakan entri (${active.entryRejections.length})`}>
            {active.entryRejections.length ? (
              <ul className="space-y-2">
                {active.entryRejections.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-line bg-app/40 px-3 py-2 text-sm">
                    <Badge color="gray">{pairLabel(r.pairId)}</Badge>
                    <Badge color="yellow">{humanize(r.stage)}</Badge>
                    <span className="font-medium">{humanize(r.reason)}</span>
                    {Object.entries(r.metrics).map(([k, v]) => (
                      <span key={k} className="num text-xs text-muted">{humanize(k)}: {num(v, 3)}</span>
                    ))}
                  </li>
                ))}
              </ul>
            ) : <Empty>Tidak ada entri yang ditolak pada run ini (tidak ada sinyal BUY, atau semua lolos).</Empty>}
          </Card>

          {active.actions.length > 0 && (
            <Card title={`Log aksi (${active.actions.length})`}>
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-muted">
                {active.actions.map((a, i) => <li key={i} className="num">{a}</li>)}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
