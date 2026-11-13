import { useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, Loading, PageHeader, Select, Table, Td, statusColor, Empty } from '../components/ui';
import { idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';

export default function History() {
  const [view, setView] = useState<'positions' | 'orders'>('positions');
  const pos = usePoll<any>(view === 'positions' ? '/api/positions?status=closed&limit=500' : null, 30000);
  const ord = usePoll<any>(view === 'orders' ? '/api/orders?limit=500' : null, 30000);
  const cur = view === 'positions' ? pos : ord;

  const exportCsv = () => {
    const rows: any[] = view === 'positions' ? pos.data?.positions ?? [] : ord.data?.orders ?? [];
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `indodax-quant-${view}.csv`;
    a.click();
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Trading History" subtitle="Riwayat transaksi simulasi (paper)"
        actions={<div className="flex gap-2">
          <Select value={view} onChange={(v) => setView(v as 'positions' | 'orders')} options={[{ value: 'positions', label: 'Posisi ditutup' }, { value: 'orders', label: 'Semua order' }]} />
          <button onClick={exportCsv} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">Export CSV</button>
        </div>} />
      <ErrorBox error={cur.error} />
      <Card>
        {cur.loading && !cur.data ? <Loading /> : view === 'positions' ? (
          pos.data?.positions?.length ? (
            <Table head={['Dibuka', 'Ditutup', 'Pair', 'Qty', 'Entry', 'Exit', 'Fee', 'PnL', 'Return', 'Alasan']}>
              {pos.data.positions.map((p: any) => (
                <tr key={p.id}>
                  <Td>{wib(p.opened_at)}</Td>
                  <Td>{wib(p.closed_at)}</Td>
                  <Td className="font-medium">{pairLabel(p.pair_id)}</Td>
                  <Td>{num(p.qty, 8)}</Td>
                  <Td>{idr(p.entry_price)}</Td>
                  <Td>{idr(p.exit_price)}</Td>
                  <Td>{idr(Number(p.entry_fee) + Number(p.exit_fee ?? 0))}</Td>
                  <Td className={pnlClass(p.realized_pnl)}>{idr(p.realized_pnl, { sign: true })}</Td>
                  <Td className={pnlClass(p.realized_pnl)}>{pct(Number(p.realized_pnl) / Number(p.cost_basis) * 100)}</Td>
                  <Td><Badge color={statusColor(p.exit_reason)}>{p.exit_reason ?? '—'}</Badge></Td>
                </tr>
              ))}
            </Table>
          ) : <Empty>Belum ada posisi yang ditutup.</Empty>
        ) : (
          ord.data?.orders?.length ? (
            <Table head={['Waktu', 'Pair', 'Sisi', 'Alasan', 'Harga diminta', 'Harga fill', 'Qty', 'Nilai', 'Fee', 'Slippage', 'PnL']}>
              {ord.data.orders.map((o: any) => (
                <tr key={o.id}>
                  <Td>{wib(o.created_at, true)}</Td>
                  <Td className="font-medium">{pairLabel(o.pair_id)}</Td>
                  <Td><Badge color={statusColor(o.side)}>{o.side}</Badge></Td>
                  <Td><Badge color={statusColor(o.reason)}>{o.reason}</Badge></Td>
                  <Td>{idr(o.requested_price)}</Td>
                  <Td>{idr(o.fill_price)}</Td>
                  <Td>{num(o.qty, 8)}</Td>
                  <Td>{idr(o.notional)}</Td>
                  <Td>{idr(o.fee)}</Td>
                  <Td>{num(o.slippage_bps, 1)} bps</Td>
                  <Td className={pnlClass(o.realized_pnl)}>{o.realized_pnl === null ? '—' : idr(o.realized_pnl, { sign: true })}</Td>
                </tr>
              ))}
            </Table>
          ) : <Empty>Belum ada order simulasi.</Empty>
        )}
      </Card>
    </div>
  );
}
