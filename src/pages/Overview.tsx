import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, Loading, PageHeader, PageSkeleton, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { EquityHero, PositionGrid } from '../components/Portfolio';
import { ago, idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';

const more = 'rounded text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line/70 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="num truncate text-right">{children}</span>
    </div>
  );
}

export default function Overview() {
  const pf = usePoll<any>('/api/portfolio?points=1440', 20000);
  const tk = usePoll<any>('/api/market/tickers?scope=tracked', 20000);
  const sg = usePoll<any>('/api/signals?limit=8', 30000);
  const sys = usePoll<any>('/api/system?limit=5', 30000);

  if (pf.loading && !pf.data) return <PageSkeleton />;
  const acc = pf.data?.account;
  const stats = pf.data?.stats;
  const open: any[] = pf.data?.openPositions ?? [];
  const curve: number[] = (pf.data?.equityCurve ?? []).map((p: any) => Number(p.equity));

  return (
    <div className="space-y-5">
      <PageHeader title="Overview" subtitle="Ringkasan portfolio simulasi, pasar, dan kesehatan sistem"
        actions={acc && <Badge color={statusColor(acc.status)}>Paper trading: {acc.status}</Badge>} />
      <ErrorBox error={pf.error ?? tk.error ?? sys.error} />

      <div className="grid gap-4 lg:grid-cols-3">
        {acc ? <EquityHero account={acc} curve={curve} className="lg:col-span-2" />
          : <Card className="lg:col-span-2"><Empty>Akun paper trading belum tersedia.</Empty></Card>}
        <Card title="Kesehatan Sistem" actions={<Link to="/system" className={more}>Detail →</Link>}>
          {sys.data ? (
            <div className="text-sm">
              <Row label="Status"><Badge color={sys.data.healthy ? 'green' : 'red'}>{sys.data.healthy ? 'SEHAT' : 'BERMASALAH'}</Badge></Row>
              <Row label="Run terakhir">{ago(sys.data.runs?.[0]?.started_at)}</Row>
              <Row label="Sukses terakhir">{wib(sys.data.lastSuccessAt)}</Row>
              <Row label="Telegram"><Badge color={sys.data.telegramConfigured ? 'green' : 'yellow'}>{sys.data.telegramConfigured ? 'aktif' : 'belum diatur'}</Badge></Row>
              <Row label="Posisi terbuka">{open.length}</Row>
              <Row label="Live trading"><Badge color="gray">NONAKTIF</Badge></Row>
            </div>
          ) : <Loading height={216} rows={6} />}
        </Card>
      </div>

      {acc && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Kas" value={idr(acc.cash_balance)} sub={`Awal ${idr(acc.initial_balance)}`} />
          <Stat label="Realized PnL" value={idr(acc.realized_pnl, { sign: true })} valueClass={pnlClass(acc.realized_pnl)} sub={`Fee ${idr(acc.total_fees)}`} />
          <Stat label="Unrealized PnL" value={idr(acc.unrealized_pnl, { sign: true })} valueClass={pnlClass(acc.unrealized_pnl)} sub={`${open.length} posisi terbuka`} />
          <Stat label="Win rate" value={`${num(stats?.winRate, 1)}%`} sub={`${stats?.wins ?? 0} menang / ${stats?.losses ?? 0} kalah`} />
        </div>
      )}

      <Card title={`Posisi Terbuka (${open.length})`} actions={<Link to="/paper" className={more}>Paper Trading →</Link>}>
        {open.length ? <PositionGrid positions={open} /> : <Empty>Tidak ada posisi terbuka.</Empty>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pasar yang Dipantau" actions={<Link to="/market" className={more}>Semua →</Link>}>
          {tk.data?.tickers?.length ? (
            <Table head={['Pair', 'Harga', '24j', 'Volume (IDR)']}>
              {tk.data.tickers.map((t: any) => (
                <tr key={t.pair_id}>
                  <Td><Link to={`/chart?pair=${t.pair_id}`} className="font-medium hover:text-accent">{pairLabel(t.pair_id)}</Link></Td>
                  <Td>{idr(t.last)}</Td>
                  <Td className={pnlClass(t.change_24h_pct)}>{pct(t.change_24h_pct)}</Td>
                  <Td>{idr(t.vol_idr, { compact: true })}</Td>
                </tr>
              ))}
            </Table>
          ) : tk.loading ? <Loading /> : <Empty>Belum ada data ticker.</Empty>}
        </Card>
        <Card title="Sinyal Terbaru" actions={<Link to="/signals" className={more}>Semua →</Link>}>
          {sg.data?.signals?.length ? (
            <Table head={['Waktu', 'Pair', 'Sinyal', 'Harga', 'Kekuatan']}>
              {sg.data.signals.map((s: any) => (
                <tr key={s.id}>
                  <Td>{wib(s.candle_time)}</Td>
                  <Td>{pairLabel(s.pair_id)}</Td>
                  <Td><Badge color={statusColor(s.side)}>{s.side}</Badge></Td>
                  <Td>{idr(s.price)}</Td>
                  <Td>{num(s.strength, 0)}</Td>
                </tr>
              ))}
            </Table>
          ) : sg.loading ? <Loading /> : <Empty>Belum ada sinyal trading.</Empty>}
        </Card>
      </div>
    </div>
  );
}
