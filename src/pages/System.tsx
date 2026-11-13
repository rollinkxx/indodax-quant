import { Fragment, useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { post } from '../lib/api';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { ago, pairLabel, wib } from '../lib/format';

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
  const avgMs = runs.length ? Math.round(runs.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / runs.length) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="System Monitoring" subtitle={`Cloudflare Cron Trigger "${data?.cron ?? '* * * * *'}" (UTC) • waktu ditampilkan dalam WIB`}
        actions={isAdmin && <Button disabled={busy} onClick={runNow}>{busy ? 'Menjalankan…' : 'Jalankan pipeline sekarang'}</Button>} />
      <ErrorBox error={error ?? err} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kesehatan" value={<Badge color={data?.healthy ? 'green' : 'red'}>{data?.healthy ? 'SEHAT' : 'BERMASALAH'}</Badge>} sub={`Run terakhir ${data?.lastRunAgeSeconds != null ? Math.round(data.lastRunAgeSeconds) + ' detik lalu' : '—'}`} />
        <Stat label="Sukses (100 run terakhir)" value={`${ok}/${runs.length}`} sub={`Rata-rata ${avgMs ?? '—'} ms`} />
        <Stat label="Telegram" value={<Badge color={data?.telegramConfigured ? 'green' : 'yellow'}>{data?.telegramConfigured ? 'TERKONFIGURASI' : 'BELUM'}</Badge>} />
        <Stat label="Akun paper" value={<Badge color={statusColor(data?.accountStatus)}>{data?.accountStatus}</Badge>} sub="Live trading: nonaktif" />
      </div>
      <Card title="Riwayat Eksekusi">
        {runs.length ? (
          <Table head={['Jadwal (WIB)', 'Pemicu', 'Status', 'Durasi', 'Langkah', 'Error']}>
            {runs.map((r) => {
              const steps = Object.entries(r.steps ?? {}) as [string, any][];
              return (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer hover:bg-slate-900" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <Td>{wib(r.scheduled_time, true)}</Td>
                    <Td>{r.trigger}</Td>
                    <Td><Badge color={statusColor(r.status)}>{r.status}</Badge></Td>
                    <Td>{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</Td>
                    <Td>{steps.map(([k, v]) => <span key={k} title={k} className={`mr-1 inline-block h-2 w-2 rounded-full ${v?.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />)}</Td>
                    <Td className="max-w-xs truncate text-xs text-rose-300">{r.error ?? ''}</Td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan={6} className="bg-slate-950 p-3">
                      <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify(r.steps, null, 2)}{r.error ? `\n\nERROR:\n${r.error}` : ''}</pre>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
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
