import { useState } from 'react';
import { usePoll } from '../lib/usePoll';
import { Badge, Card, ErrorBox, Loading, PageHeader, Select, Table, Td, statusColor, Empty } from '../components/ui';
import { idr, num, pairLabel, wib } from '../lib/format';

export default function Signals() {
  const [side, setSide] = useState('');
  const [pair, setPair] = useState('');
  const pairs = usePoll<any>('/api/market/pairs', 120000);
  const qs = new URLSearchParams({ limit: '200', ...(side ? { side } : {}), ...(pair ? { pair } : {}) });
  const { data, error, loading } = usePoll<any>(`/api/signals?${qs}`, 30000);
  const tracked = (pairs.data?.pairs ?? []).filter((p: any) => p.is_tracked);

  return (
    <div className="space-y-4">
      <PageHeader title="Trading Signals" subtitle="EMA crossover + RSI + konfirmasi volume pada candle 5 menit yang sudah selesai"
        actions={<div className="flex gap-2">
          <Select value={pair} onChange={setPair} options={[{ value: '', label: 'Semua pair' }, ...tracked.map((p: any) => ({ value: p.id, label: pairLabel(p.id) }))]} />
          <Select value={side} onChange={setSide} options={[{ value: '', label: 'BUY & SELL' }, { value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }]} />
        </div>} />
      <ErrorBox error={error} />
      <Card>
        {loading && !data ? <Loading /> : data?.signals?.length ? (
          <Table head={['Candle (WIB)', 'Pair', 'Sinyal', 'Harga', 'Kekuatan', 'RSI', 'ATR', 'Alasan']}>
            {data.signals.map((s: any) => (
              <tr key={s.id}>
                <Td>{wib(s.candle_time)}</Td>
                <Td className="font-medium">{pairLabel(s.pair_id)}</Td>
                <Td><Badge color={statusColor(s.side)}>{s.side}</Badge></Td>
                <Td>{idr(s.price)}</Td>
                <Td>{num(s.strength, 0)}</Td>
                <Td>{num(s.indicators?.rsi14 ?? s.indicators?.rsi, 1)}</Td>
                <Td>{idr(s.indicators?.atr14)}</Td>
                <Td className="max-w-md whitespace-normal text-xs text-slate-400">{Array.isArray(s.reasons) ? s.reasons.join(' • ') : ''}</Td>
              </tr>
            ))}
          </Table>
        ) : <Empty>Belum ada sinyal. Sinyal hanya muncul saat seluruh syarat strategi dan data-quality gate terpenuhi.</Empty>}
      </Card>
    </div>
  );
}
