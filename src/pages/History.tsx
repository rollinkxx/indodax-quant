import { useMemo, useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Segmented, Select, Stat, Table, Td, statusColor, Empty } from '../components/ui';
import { Icon } from '../components/Icon';
import { idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';
import { historyScopeNote } from '../lib/historyScope';

type View = 'positions' | 'orders';
type Period = '1' | '7' | '30' | 'all';

const PERIODS: { value: Period; label: string }[] = [
  { value: '1', label: '24 jam' }, { value: '7', label: '7 hari' }, { value: '30', label: '30 hari' }, { value: 'all', label: 'Semua' },
];

const ret = (p: any) => (Number(p.cost_basis) ? (Number(p.realized_pnl) / Number(p.cost_basis)) * 100 : null);

export default function History() {
  const [view, setView] = useState<View>('positions');
  const [period, setPeriod] = useState<Period>('all');
  const [pair, setPair] = useState('all');
  const [kind, setKind] = useState('all');
  const pos = usePoll<any>(view === 'positions' ? '/api/positions?status=closed&limit=500' : null, 30000);
  const ord = usePoll<any>(view === 'orders' ? '/api/orders?limit=500' : null, 30000);
  const cur = view === 'positions' ? pos : ord;
  const all: any[] = (view === 'positions' ? pos.data?.positions : ord.data?.orders) ?? [];

  const pairs = useMemo(() => [...new Set(all.map((r) => r.pair_id))].sort(), [all]);
  const kinds = useMemo(() => [...new Set(all.map((r) => (view === 'positions' ? r.exit_reason : r.reason)).filter(Boolean))].sort() as string[], [all, view]);

  const rows = useMemo(() => {
    const since = period === 'all' ? 0 : Date.now() - Number(period) * 86_400_000;
    return all.filter((r) => {
      const t = Date.parse(view === 'positions' ? r.closed_at : r.created_at);
      if (since && !(t >= since)) return false;
      if (pair !== 'all' && r.pair_id !== pair) return false;
      if (kind !== 'all' && (view === 'positions' ? r.exit_reason : r.reason) !== kind) return false;
      return true;
    });
  }, [all, period, pair, kind, view]);

  const summary = useMemo(() => {
    const pnlRows = rows.filter((r) => r.realized_pnl !== null && r.realized_pnl !== undefined);
    const pnl = pnlRows.reduce((a, r) => a + Number(r.realized_pnl), 0);
    const wins = pnlRows.filter((r) => Number(r.realized_pnl) > 0).length;
    const fee = rows.reduce((a, r) => a + (view === 'positions' ? Number(r.entry_fee ?? 0) + Number(r.exit_fee ?? 0) : Number(r.fee ?? 0)), 0);
    const volume = rows.reduce((a, r) => a + Number(view === 'positions' ? r.cost_basis ?? 0 : r.notional ?? 0), 0);
    return { pnl, wins, closed: pnlRows.length, fee, volume };
  }, [rows, view]);

  const switchView = (v: string) => { setView(v as View); setKind('all'); };
  const filtered = period !== 'all' || pair !== 'all' || kind !== 'all';

  const exportCsv = () => {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `indodax-quant-${view}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Trading History" subtitle="Riwayat transaksi simulasi (paper) • waktu dalam WIB"
        actions={<>
          <Segmented label="Jenis riwayat" value={view} onChange={switchView} options={[{ value: 'positions', label: 'Posisi ditutup' }, { value: 'orders', label: 'Semua order' }]} />
          <Button onClick={exportCsv} disabled={!rows.length}><Icon name="arrowDown" className="size-4" />Export CSV</Button>
        </>} />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Periode" value={period} onChange={(v) => setPeriod(v as Period)} options={PERIODS} scroll className="max-w-full" />
          <Select value={pair} onChange={setPair} options={[{ value: 'all', label: 'Semua pair' }, ...pairs.map((p) => ({ value: p, label: pairLabel(p) }))]} />
          <Select value={kind} onChange={setKind} options={[{ value: 'all', label: view === 'positions' ? 'Semua alasan keluar' : 'Semua alasan' }, ...kinds.map((k) => ({ value: k, label: k }))]} />
          <Button variant="ghost" disabled={!filtered} onClick={() => { setPeriod('all'); setPair('all'); setKind('all'); }}>
            <Icon name="x" className="size-4" />Reset filter
          </Button>
          <span className="num ml-auto text-xs text-subtle">{rows.length} dari {all.length} baris</span>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted">{historyScopeNote(period)}</p>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="PnL riwayat" value={idr(summary.pnl, { sign: true })} valueClass={pnlClass(summary.pnl)} sub={`${summary.closed} transaksi ber-PnL`} />
        <Stat label="Win rate" value={summary.closed ? pct((summary.wins / summary.closed) * 100, 1, false) : '—'} sub={`${summary.wins} menang • ${summary.closed - summary.wins} kalah`} />
        <Stat label="Total fee" value={idr(summary.fee)} sub="Simulasi, kedua sisi" />
        <Stat label={view === 'positions' ? 'Modal diputar' : 'Nilai order'} value={idr(summary.volume, { compact: true })} sub={`${rows.length} ${view === 'positions' ? 'posisi' : 'order'}`} />
      </div>

      <ErrorBox error={cur.error} />
      <Card className="overflow-hidden p-0! sm:p-0!">
        {cur.loading && !cur.data ? <div className="p-4"><Loading /></div> : !rows.length ? (
          <Empty>{all.length ? 'Tidak ada data yang cocok dengan filter.' : view === 'positions' ? 'Belum ada posisi yang ditutup.' : 'Belum ada order simulasi.'}</Empty>
        ) : view === 'positions' ? (
          <>
            <div className="hidden md:block">
              <Table maxHeight="70vh" head={['Dibuka', 'Ditutup', 'Pair', 'Qty', 'Entry', 'Exit', 'Fee', 'PnL', 'Return', 'Alasan']}>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <Td>{wib(p.opened_at)}</Td>
                    <Td>{wib(p.closed_at)}</Td>
                    <Td className="font-medium">{pairLabel(p.pair_id)}</Td>
                    <Td>{num(p.qty, 8)}</Td>
                    <Td>{idr(p.entry_price)}</Td>
                    <Td>{idr(p.exit_price)}</Td>
                    <Td>{idr(Number(p.entry_fee) + Number(p.exit_fee ?? 0))}</Td>
                    <Td className={pnlClass(p.realized_pnl)}>{idr(p.realized_pnl, { sign: true })}</Td>
                    <Td className={pnlClass(p.realized_pnl)}>{pct(ret(p))}</Td>
                    <Td><Badge color={statusColor(p.exit_reason)}>{p.exit_reason ?? '—'}</Badge></Td>
                  </tr>
                ))}
              </Table>
            </div>
            <ul className="divide-y divide-line/70 md:hidden">
              {rows.map((p) => (
                <li key={p.id} className="num space-y-1.5 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{pairLabel(p.pair_id)}</span>
                    <Badge color={statusColor(p.exit_reason)}>{p.exit_reason ?? '—'}</Badge>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <span className="text-xs text-muted">{idr(p.entry_price)} → {idr(p.exit_price)}</span>
                    <span className={`whitespace-nowrap font-semibold ${pnlClass(p.realized_pnl)}`}>{idr(p.realized_pnl, { sign: true })} <span className="text-xs">({pct(ret(p))})</span></span>
                  </div>
                  <div className="truncate text-xs text-subtle">{wib(p.opened_at)} → {wib(p.closed_at)}</div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="hidden md:block">
              <Table maxHeight="70vh" head={['Waktu', 'Pair', 'Sisi', 'Alasan', 'Harga diminta', 'Harga fill', 'Qty', 'Nilai', 'Fee', 'Slippage', 'PnL']}>
                {rows.map((o) => (
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
            </div>
            <ul className="divide-y divide-line/70 md:hidden">
              {rows.map((o) => (
                <li key={o.id} className="num space-y-1.5 p-4 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2"><Badge color={statusColor(o.side)}>{o.side}</Badge><span className="truncate font-semibold">{pairLabel(o.pair_id)}</span></span>
                    <Badge color={statusColor(o.reason)}>{o.reason}</Badge>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <span className="truncate text-xs text-muted">{num(o.qty, 8)} @ {idr(o.fill_price)}</span>
                    <span className={`whitespace-nowrap font-semibold ${pnlClass(o.realized_pnl)}`}>{o.realized_pnl === null ? idr(o.notional) : idr(o.realized_pnl, { sign: true })}</span>
                  </div>
                  <div className="truncate text-xs text-subtle">{wib(o.created_at, true)} • fee {idr(o.fee)} • slip {num(o.slippage_bps, 1)} bps</div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
