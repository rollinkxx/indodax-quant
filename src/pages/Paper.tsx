import { useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { post } from '../lib/api';
import { Badge, Button, Card, ErrorBox, PageHeader, PageSkeleton, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { AreaChart, toSec } from '../components/Charts';
import { idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';

export default function Paper({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = usePoll<any>('/api/portfolio?points=2000', 15000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = async (path: string, confirmText: string, body?: unknown) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await post(path, body); setMsg(r?.status ? `OK: ${r.status}${r.closed !== undefined ? `, ${r.closed} posisi ditutup` : ''}` : 'OK'); await reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <PageSkeleton />;
  const acc = data?.account;
  const st = data?.stats;
  const curve = (data?.equityCurve ?? []).map((p: any) => ({ time: toSec(p.snapshot_time), value: Number(p.equity) }));

  return (
    <div className="space-y-5">
      <PageHeader title="Paper Trading" subtitle="Saldo virtual • eksekusi simulasi dengan fee dan slippage"
        actions={acc && <div className="flex flex-wrap items-center gap-2">
          <Badge color={statusColor(acc.status)}>{acc.status}</Badge>
          {isAdmin && <>
            <Button variant="primary" disabled={busy || acc.status === 'RUNNING'} onClick={() => act('/api/paper/start', 'Mulai automated paper trading?')}>Start</Button>
            <Button disabled={busy || acc.status !== 'RUNNING'} onClick={() => act('/api/paper/stop', 'Hentikan entry baru? (SL/TP tetap aktif)')}>Stop</Button>
            <Button variant="danger" disabled={busy || acc.status === 'KILLED'} onClick={() => act('/api/paper/kill', 'KILL SWITCH: tutup semua posisi di harga bid dan kunci akun?')}>Kill switch</Button>
            <Button variant="ghost" disabled={busy || acc.status === 'RUNNING'} onClick={() => act('/api/paper/reset', 'Reset akun ke Rp10.000.000? Riwayat tetap disimpan.', { initialBalance: 10_000_000 })}>Reset</Button>
          </>}
        </div>} />
      <ErrorBox error={error ?? err} />
      {msg && <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-200">{msg}</div>}
      {acc?.status_reason && <p className="text-xs text-slate-500">Status: {acc.status_reason} • {wib(acc.updated_at)}</p>}
      {acc && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Equity" value={idr(acc.equity)} sub={<span className={pnlClass(Number(acc.equity) - Number(acc.initial_balance))}>{pct((Number(acc.equity) / Number(acc.initial_balance) - 1) * 100)}</span>} />
          <Stat label="Kas" value={idr(acc.cash_balance)} />
          <Stat label="Realized PnL" value={idr(acc.realized_pnl, { sign: true })} valueClass={pnlClass(acc.realized_pnl)} sub={`Total fee ${idr(acc.total_fees)}`} />
          <Stat label="Unrealized PnL" value={idr(acc.unrealized_pnl, { sign: true })} valueClass={pnlClass(acc.unrealized_pnl)} />
          <Stat label="Peak equity" value={idr(acc.peak_equity)} />
          <Stat label="Max drawdown" value={pct(acc.max_drawdown_pct, 2, false)} />
          <Stat label="Win rate" value={`${num(st?.winRate, 1)}%`} sub={`${st?.wins ?? 0} menang / ${st?.losses ?? 0} kalah`} />
          <Stat label="Profit factor" value={st?.profitFactor === null ? '∞' : num(st?.profitFactor, 2)} sub={`Rata-rata ${idr(st?.avgPnl, { sign: true })}`} />
        </div>
      )}
      <Card title="Kurva Equity">{curve.length > 1 ? <AreaChart data={curve} /> : <Empty>Belum ada snapshot.</Empty>}</Card>
      <Card title={`Posisi Terbuka (${data?.openPositions?.length ?? 0})`}>
        {data?.openPositions?.length ? (
          <Table head={['Dibuka', 'Pair', 'Qty', 'Entry', 'Harga kini', 'Stop loss', 'Take profit', 'Nilai modal', 'Unrealized']}>
            {data.openPositions.map((p: any) => (
              <tr key={p.id}>
                <Td>{wib(p.opened_at)}</Td>
                <Td className="font-medium">{pairLabel(p.pair_id)}</Td>
                <Td>{num(p.qty, 8)}</Td>
                <Td>{idr(p.entry_price)}</Td>
                <Td>{idr(p.last_price)}</Td>
                <Td className="text-rose-300">{idr(p.stop_loss)}</Td>
                <Td className="text-emerald-300">{idr(p.take_profit)}</Td>
                <Td>{idr(p.cost_basis)}</Td>
                <Td className={pnlClass(p.unrealized_pnl)}>{idr(p.unrealized_pnl, { sign: true })}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>Tidak ada posisi terbuka.</Empty>}
      </Card>
      {!isAdmin && <p className="text-xs text-slate-500">Hanya administrator yang dapat menjalankan Start, Stop, Kill switch, dan Reset.</p>}
    </div>
  );
}
