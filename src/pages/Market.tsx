import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { put } from '../lib/api';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, Select, Table, Td, Empty } from '../components/ui';
import { ago, idr, num, pairLabel, pct, pnlClass } from '../lib/format';

export default function Market({ isAdmin = false }: { isAdmin?: boolean }) {
  const [scope, setScope] = useState<'tracked' | 'all'>('tracked');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const { data, error, loading, reload, updatedAt } = usePoll<any>(`/api/market/tickers?scope=${scope}`, 15000);

  const rows = useMemo(() => {
    const list = (data?.tickers ?? []) as any[];
    const s = q.trim().toLowerCase();
    return s ? list.filter((t) => String(t.pair_id).includes(s) || String(t.name ?? '').toLowerCase().includes(s)) : list;
  }, [data, q]);

  const toggle = async (pair: string, tracked: boolean) => {
    setMsg(null);
    try { await put(`/api/market/pairs/${pair}/track`, { tracked }); await reload(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Market Monitor" subtitle={<>Data resmi INDODAX Public API • diperbarui {updatedAt ? ago(updatedAt.toISOString()) : '—'}</>}
        actions={<div className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari pair…" className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm" />
          <Select value={scope} onChange={(v) => setScope(v as 'tracked' | 'all')} options={[{ value: 'tracked', label: 'Dipantau' }, { value: 'all', label: 'Semua pair IDR' }]} />
        </div>} />
      <ErrorBox error={error ?? msg} />
      <Card>
        {loading && !data ? <Loading /> : rows.length ? (
          <Table head={['Pair', 'Last', 'Bid', 'Ask', 'Spread', 'High 24j', 'Low 24j', '24j', 'Volume (IDR)', 'Update', '']}>
            {rows.map((t) => {
              const spread = Number(t.ask) > 0 ? (Number(t.ask) - Number(t.bid)) / Number(t.ask) * 100 : null;
              const stale = Date.now() - Date.parse(t.server_time ?? t.updated_at) > 180_000;
              return (
                <tr key={t.pair_id}>
                  <Td><Link to={`/chart?pair=${t.pair_id}`} className="font-medium hover:text-emerald-300">{pairLabel(t.pair_id)}</Link> {t.is_tracked && <Badge color="blue">dipantau</Badge>}</Td>
                  <Td>{idr(t.last)}</Td>
                  <Td className="text-emerald-300">{idr(t.bid)}</Td>
                  <Td className="text-rose-300">{idr(t.ask)}</Td>
                  <Td>{spread === null ? '—' : `${num(spread, 3)}%`}</Td>
                  <Td>{idr(t.high)}</Td>
                  <Td>{idr(t.low)}</Td>
                  <Td className={pnlClass(t.change_24h_pct)}>{pct(t.change_24h_pct)}</Td>
                  <Td>{idr(t.vol_idr, { compact: true })}</Td>
                  <Td>{stale ? <Badge color="yellow">basi</Badge> : <span className="text-slate-400">{ago(t.server_time ?? t.updated_at)}</span>}</Td>
                  <Td>{isAdmin && <Button variant="ghost" onClick={() => toggle(t.pair_id, !t.is_tracked)}>{t.is_tracked ? 'Lepas' : 'Pantau'}</Button>}</Td>
                </tr>
              );
            })}
          </Table>
        ) : <Empty>{scope === 'tracked' ? 'Belum ada data untuk pair yang dipantau. Data muncul setelah cron pertama berjalan.' : 'Tidak ada data.'}</Empty>}
      </Card>
      <p className="text-xs text-slate-500">Maksimal 10 pair dipantau (batas rate limit API publik INDODAX). Data “basi” = ticker lebih dari 3 menit tidak berubah dan tidak dipakai untuk sinyal.</p>
    </div>
  );
}
