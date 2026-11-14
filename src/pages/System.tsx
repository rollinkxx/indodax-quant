import { useState } from 'react';
import { Icon } from '../components/Icon';
import { usePoll } from '../lib/usePoll';
import { post } from '../lib/api';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { ago, pairLabel, wib } from '../lib/format';

const RUN_TONE: Record<string, { dot: string; bar: string }> = {
  SUCCESS: { dot: 'bg-emerald-500', bar: 'bg-emerald-500/70' },
  PARTIAL: { dot: 'bg-amber-400', bar: 'bg-amber-400/70' },
  SKIPPED: { dot: 'bg-amber-400', bar: 'bg-amber-400/70' },
  FAILED: { dot: 'bg-rose-500', bar: 'bg-rose-500/70' },
  default: { dot: 'bg-slate-500', bar: 'bg-slate-500/70' },
};

export default function System({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = usePoll<any>('/api/system?limit=100', 15000);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runNow = async () => {
    setBusy(true); setErr(null);
    try { await post('/api/system/run'); await reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <Loading />;
  const runs: any[] = data?.runs ?? [];
  const ok = runs.filter((r) => r.status === 'SUCCESS').length;
  const maxMs = runs.reduce((m, r) => Math.max(m, r.duration_ms ?? 0), 0);
  const avgMs = runs.length ? Math.round(runs.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / runs.length) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="System Monitoring" subtitle={`Cloudflare Cron Trigger "${data?.cron ?? '* * * * *'}" (UTC) • waktu ditampilkan dalam WIB`}
        actions={isAdmin && <Button disabled={busy} onClick={runNow}>{busy ? 'Menjalankan…' : 'Jalankan pipeline sekarang'}</Button>} />
      <ErrorBox error={error ?? err} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kesehatan" value={<Badge color={data?.healthy ? 'green' : 'red'}>{data?.healthy ? 'SEHAT' : 'BERMASALAH'}</Badge>} sub={`Terakhir ${data?.lastRunAgeSeconds != null ? Math.round(data.lastRunAgeSeconds) + ' dtk lalu' : '—'}`} />
        <Stat label="Sukses (100 run)" value={`${ok}/${runs.length}`} sub={`Rata-rata ${avgMs ?? '—'} ms`} />
        <Stat label="Telegram" value={<Badge color={data?.telegramConfigured ? 'green' : 'yellow'}>{data?.telegramConfigured ? 'TERKONFIGURASI' : 'BELUM'}</Badge>} />
        <Stat label="Akun paper" value={<Badge color={statusColor(data?.accountStatus)}>{data?.accountStatus}</Badge>} sub="Live trading: nonaktif" />
      </div>
      <Card title="Riwayat Eksekusi" actions={runs.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-subtle">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" />Sukses</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-400" />Sebagian</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-rose-500" />Gagal</span>
        </div>)}>
        {runs.length ? (
          <ol className="relative max-h-[70vh] overflow-y-auto pr-1">
            {runs.map((r, i) => {
              const steps = Object.entries(r.steps ?? {}) as [string, any][];
              const tone = RUN_TONE[r.status as string] ?? RUN_TONE.default;
              const w = r.duration_ms != null && maxMs ? Math.max(2, (r.duration_ms / maxMs) * 100) : 0;
              const isOpen = open === r.id;
              return (
                <li key={r.id} className="relative pl-6">
                  {i < runs.length - 1 && <span aria-hidden="true" className="absolute left-[7px] top-5 bottom-0 w-px bg-line" />}
                  <span aria-hidden="true" className={`absolute left-0.5 top-3.5 size-2.5 rounded-full ring-4 ring-surface-2 ${tone.dot}`} />
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}
                    className="w-full rounded-control px-2 py-2 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="num text-sm font-medium">{wib(r.scheduled_time, true)}</span>
                      <Badge color={statusColor(r.status)}>{r.status}</Badge>
                      <span className="text-xs text-subtle">{r.trigger}</span>
                      <span className="ml-auto flex items-center gap-1" aria-label={`${steps.filter(([, v]) => v?.ok).length}/${steps.length} langkah sukses`}>
                        {steps.map(([k, v]) => <span key={k} title={k} className={`inline-block size-2 rounded-full ${v?.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />)}
                      </span>
                      <Icon name="chevronDown" className={`size-4 shrink-0 text-subtle transition-transform duration-200 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`} />
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line/70">
                        <div className={`h-full origin-left rounded-full ${tone.bar}`} style={{ width: `${w}%` }} />
                      </div>
                      <span className="num w-16 shrink-0 text-right text-xs text-muted">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</span>
                    </div>
                    {r.error && !isOpen && <div className="mt-1 truncate text-xs text-rose-300">{r.error}</div>}
                  </button>
                  {isOpen && (
                    <div className="mb-2 ml-2 space-y-2 rounded-control border border-line bg-app/60 p-3">
                      {steps.length > 0 && (
                        <ul className="grid gap-1.5 sm:grid-cols-2">
                          {steps.map(([k, v]) => (
                            <li key={k} className="flex min-w-0 items-center gap-2 text-xs">
                              <Icon name={v?.ok ? 'check' : 'x'} className={`size-3.5 shrink-0 ${v?.ok ? 'text-emerald-400' : 'text-rose-400'}`} />
                              <span className="truncate font-medium">{k}</span>
                              {v?.ms != null && <span className="num ml-auto shrink-0 text-subtle">{v.ms} ms</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-300">{JSON.stringify(r.steps, null, 2)}{r.error ? `\n\nERROR:\n${r.error}` : ''}</pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : <Empty>Belum ada eksekusi. Pastikan Worker sudah di-deploy dan Cron Trigger aktif.</Empty>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Sinkronisasi Data per Pair">
          {data?.sync?.length ? (
            <Table head={['Pair', 'Tercakup hingga', 'Trade terakhir', 'Update']}>
              {data.sync.map((s: any) => {
                const lag = s.covered_until ? (Date.now() - Date.parse(s.covered_until)) / 1000 : null;
                return (
                  <tr key={s.pair_id}>
                    <Td className="font-medium">{pairLabel(s.pair_id)}</Td>
                    <Td>{wib(s.covered_until, true)} {lag !== null && lag > 180 && <Badge color="yellow">gap</Badge>}</Td>
                    <Td>{wib(s.last_trade_time, true)}</Td>
                    <Td>{ago(s.updated_at)}</Td>
                  </tr>
                );
              })}
            </Table>
          ) : <Empty>Belum ada state sinkronisasi.</Empty>}
        </Card>
        <Card title="Notifikasi Telegram">
          {data?.notifications?.length ? (
            <Table head={['Waktu', 'Jenis', 'Status', 'Error']}>
              {data.notifications.map((n: any) => (
                <tr key={n.id}>
                  <Td>{wib(n.created_at, true)}</Td>
                  <Td>{n.event_type}</Td>
                  <Td><Badge color={statusColor(n.status)}>{n.status}</Badge></Td>
                  <Td className="max-w-xs truncate text-xs text-rose-300">{n.error ?? ''}</Td>
                </tr>
              ))}
            </Table>
          ) : <Empty>Belum ada notifikasi.</Empty>}
        </Card>
      </div>
      <Card title="Lock Konkurensi">
        <Table head={['Nama', 'Pemilik', 'Terkunci hingga']}>
          {(data?.locks ?? []).map((l: any) => (
            <tr key={l.name}><Td>{l.name}</Td><Td>{l.owner ?? '—'}</Td><Td>{wib(l.locked_until, true)}</Td></tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
