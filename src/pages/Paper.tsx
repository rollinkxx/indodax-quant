import { useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, PageHeader, PageSkeleton, Stat, statusColor, Empty } from '../components/ui';
import { AreaChart, toSec } from '../components/Charts';
import { EquityHero, PaperControls, PositionGrid, STATUS_HELP } from '../components/Portfolio';
import { Icon } from '../components/Icon';
import { idr, num, pct, wib, pnlClass } from '../lib/format';

const CHART_H = 260;

export default function Paper({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = usePoll<any>('/api/portfolio?points=2000', 15000);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading && !data) return <PageSkeleton />;
  const acc = data?.account;
  const st = data?.stats;
  const open: any[] = data?.openPositions ?? [];
  const snaps: any[] = data?.equityCurve ?? [];
  const curve = snaps.map((p) => ({ time: toSec(p.snapshot_time), value: Number(p.equity) }));

  const onResult = async (r: { msg?: string; err?: string }) => {
    setMsg(r.msg ?? null);
    setErr(r.err ?? null);
    if (r.msg) await reload();
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Paper Trading" subtitle="Saldo virtual • eksekusi simulasi dengan fee dan slippage" />
      <ErrorBox error={error ?? err} />
      {msg && (
        <div role="status" className="flex animate-fade-in items-start gap-2 rounded-control border border-emerald-800/70 bg-emerald-950/40 p-3 text-sm text-emerald-200">
          <Icon name="check" className="mt-0.5 size-4" /><span>{msg}</span>
        </div>
      )}

      {acc ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <EquityHero account={acc} curve={curve.map((p) => p.value)} className="lg:col-span-2" />
          <Card title="Kontrol Akun" actions={<Badge color={statusColor(acc.status)}>{acc.status}</Badge>} className="flex flex-col">
            <p className="min-h-10 text-sm text-muted">{STATUS_HELP[acc.status] ?? '—'}</p>
            <div className="mt-4">
              {isAdmin
                ? <PaperControls status={acc.status} onResult={onResult} />
                : <p className="flex items-start gap-2 rounded-control border border-line bg-surface-2 p-3 text-xs text-muted">
                    <Icon name="lock" className="mt-px size-3.5 text-subtle" />
                    Hanya administrator yang dapat menjalankan Start, Stop, Kill switch, dan Reset.
                  </p>}
            </div>
            <div className="mt-auto space-y-1 pt-4 text-xs text-subtle">
              {acc.status_reason && <p className="truncate" title={acc.status_reason}>Status: {acc.status_reason}</p>}
              <p className="num">Terakhir diubah {wib(acc.updated_at)}</p>
            </div>
          </Card>
        </div>
      ) : <Card><Empty>Akun paper trading belum tersedia.</Empty></Card>}

      {acc && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Kas" value={idr(acc.cash_balance)} sub={`Awal ${idr(acc.initial_balance)}`} />
          <Stat label="Realized PnL" value={idr(acc.realized_pnl, { sign: true })} valueClass={pnlClass(acc.realized_pnl)} sub={`Total fee ${idr(acc.total_fees)}`} />
          <Stat label="Unrealized PnL" value={idr(acc.unrealized_pnl, { sign: true })} valueClass={pnlClass(acc.unrealized_pnl)} sub={`${open.length} posisi terbuka`} />
          <Stat label="Peak equity" value={idr(acc.peak_equity)} />
          <Stat label="Win rate" value={`${num(st?.winRate, 1)}%`} sub={`${st?.wins ?? 0} menang / ${st?.losses ?? 0} kalah`} />
          <Stat label="Profit factor" value={st?.profitFactor === null ? '∞' : num(st?.profitFactor, 2)} sub={`${st?.trades ?? 0} trade ditutup`} />
          <Stat label="Rata-rata PnL" value={idr(st?.avgPnl, { sign: true })} valueClass={pnlClass(st?.avgPnl)} sub="per trade" />
          <Stat label="Max drawdown" value={pct(acc.max_drawdown_pct, 2, false)} sub="sejak reset terakhir" />
        </div>
      )}

      <Card title="Kurva Equity">
        <div style={{ height: CHART_H }}>
          {curve.length > 1 ? <AreaChart data={curve} height={CHART_H} /> : <div className="grid h-full place-items-center"><Empty>Belum ada snapshot.</Empty></div>}
        </div>
      </Card>

      <Card title={`Posisi Terbuka (${open.length})`}>
        {open.length ? <PositionGrid positions={open} /> : <Empty>Tidak ada posisi terbuka.</Empty>}
      </Card>
    </div>
  );
}
