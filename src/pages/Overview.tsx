import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, Loading, PageHeader, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { AreaChart, toSec } from '../components/Charts';
import { ago, idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';

export default function Overview() {
  const pf = usePoll<any>('/api/portfolio?points=1440', 20000);
  const tk = usePoll<any>('/api/market/tickers?scope=tracked', 20000);
  const sg = usePoll<any>('/api/signals?limit=8', 30000);
  const sys = usePoll<any>('/api/system?limit=5', 30000);

  if (pf.loading && !pf.data) return <Loading />;
  const acc = pf.data?.account;
  const stats = pf.data?.stats;
  const curve = (pf.data?.equityCurve ?? []).map((p: any) => ({ time: toSec(p.snapshot_time), value: Number(p.equity) }));
  const ret = acc ? (Number(acc.equity) / Number(acc.initial_balance) - 1) * 100 : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Overview" subtitle="Ringkasan portfolio simulasi, pasar, dan kesehatan sistem"
        actions={acc && <Badge color={statusColor(acc.status)}>Paper trading: {acc.status}</Badge>} />
      <ErrorBox error={pf.error ?? tk.error ?? sys.error} />
      {acc && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Equity" value={idr(acc.equity)} sub={<span className={pnlClass(ret)}>{pct(ret)} dari modal awal</span>} />
          <Stat label="Kas" value={idr(acc.cash_balance)} sub={`Modal awal ${idr(acc.initial_balance)}`} />
          <Stat label="Realized PnL" value={idr(acc.realized_pnl, { sign: true })} valueClass={pnlClass(acc.realized_pnl)} sub={`Unrealized ${idr(acc.unrealized_pnl, { sign: true })}`} />
          <Stat label="Max Drawdown" value={pct(acc.max_drawdown_pct, 2, false)} sub={`Win rate ${num(stats?.winRate, 1)}% • ${stats?.trades ?? 0} trade`} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Kurva Equity" className="lg:col-span-2">
          {curve.length > 1 ? <AreaChart data={curve} /> : <Empty>Belum ada snapshot portfolio. Snapshot dibuat setiap menit oleh cron.</Empty>}
        </Card>
        <Card title="Kesehatan Sistem" actions={<Link to="/system" className="text-xs text-emerald-400">Detail →</Link>}>
          {sys.data ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-400">Status</span><Badge color={sys.data.healthy ? 'green' : 'red'}>{sys.data.healthy ? 'SEHAT' : 'BERMASALAH'}</Badge></div>
              <div className="flex justify-between"><span className="text-slate-400">Run terakhir</span><span>{ago(sys.data.runs?.[0]?.started_at)}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Sukses terakhir</span><span>{wib(sys.data.lastSuccessAt)}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Telegram</span><Badge color={sys.data.telegramConfigured ? 'green' : 'yellow'}>{sys.data.telegramConfigured ? 'aktif' : 'belum diatur'}</Badge></div>
              <div className="flex justify-between"><span className="text-slate-400">Posisi terbuka</span><span>{pf.data?.openPositions?.length ?? 0}</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Live trading</span><Badge color="gray">NONAKTIF</Badge></div>
            </div>
          ) : <Loading />}
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pasar yang Dipantau" actions={<Link to="/market" className="text-xs text-emerald-400">Semua →</Link>}>
          {tk.data?.tickers?.length ? (
            <Table head={['Pair', 'Harga', '24j', 'Volume (IDR)']}>
              {tk.data.tickers.map((t: any) => (
                <tr key={t.pair_id}>
                  <Td><Link to={`/chart?pair=${t.pair_id}`} className="font-medium hover:text-emerald-300">{pairLabel(t.pair_id)}</Link></Td>
                  <Td>{idr(t.last)}</Td>
                  <Td className={pnlClass(t.change_24h_pct)}>{pct(t.change_24h_pct)}</Td>
                  <Td>{idr(t.vol_idr, { compact: true })}</Td>
                </tr>
              ))}
            </Table>
          ) : <Empty>Belum ada data ticker.</Empty>}
        </Card>
        <Card title="Sinyal Terbaru" actions={<Link to="/signals" className="text-xs text-emerald-400">Semua →</Link>}>
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
          ) : <Empty>Belum ada sinyal trading.</Empty>}
        </Card>
      </div>
    </div>
  );
}
