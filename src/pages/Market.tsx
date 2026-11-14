import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../lib/usePoll';
import { put } from '../lib/api';
import { Badge, Button, Card, ErrorBox, Loading, PageHeader, SearchInput, Segmented, Select, Empty } from '../components/ui';
import { Icon } from '../components/Icon';
import { ago, idr, num, pairLabel, pct, pnlClass } from '../lib/format';

type SortKey = 'pair' | 'last' | 'spread' | 'change' | 'vol';
type Sort = { key: SortKey; dir: 1 | -1 };
type FlashField = 'last' | 'bid' | 'ask';
type Flash = { dir: 'up' | 'down'; at: number };

const FLASH_MS = 400;
const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'vol', label: 'Volume' }, { value: 'change', label: 'Perubahan 24j' }, { value: 'last', label: 'Harga' },
  { value: 'spread', label: 'Spread' }, { value: 'pair', label: 'Nama pair' },
];

const spreadOf = (t: any) => (Number(t.ask) > 0 ? (Number(t.ask) - Number(t.bid)) / Number(t.ask) * 100 : null);
const sortVal = (t: any, k: SortKey): number | string | null =>
  k === 'pair' ? String(t.pair_id) : k === 'last' ? Number(t.last) : k === 'spread' ? spreadOf(t) : k === 'change' ? (t.change_24h_pct === null ? null : Number(t.change_24h_pct)) : (t.vol_idr === null ? null : Number(t.vol_idr));

/**
 * Remembers the previous poll's prices and returns, per pair and field, the direction of the last change.
 * Only values that changed between two polls of the same scope get a flash; switching scope resets the memory.
 */
function usePriceFlashes(tickers: any[] | undefined, scope: string) {
  const prev = useRef<{ scope: string; map: Map<string, Record<FlashField, number>> } | null>(null);
  const flashes = useRef(new Map<string, Flash>());
  useMemo(() => {
    if (!tickers) return;
    const now = Date.now();
    const p = prev.current?.scope === scope ? prev.current.map : null;
    const map = new Map<string, Record<FlashField, number>>();
    for (const t of tickers) {
      const cur = { last: Number(t.last), bid: Number(t.bid), ask: Number(t.ask) };
      map.set(t.pair_id, cur);
      const old = p?.get(t.pair_id);
      if (!old) continue;
      for (const f of ['last', 'bid', 'ask'] as FlashField[]) {
        if (cur[f] !== old[f] && Number.isFinite(cur[f]) && Number.isFinite(old[f])) flashes.current.set(`${t.pair_id}:${f}`, { dir: cur[f] > old[f] ? 'up' : 'down', at: now });
      }
    }
    prev.current = { scope, map };
  }, [tickers, scope]);
  useEffect(() => { flashes.current.clear(); }, [scope]);
  return (pair: string, field: FlashField): Flash | null => {
    const f = flashes.current.get(`${pair}:${field}`);
    return f && Date.now() - f.at < FLASH_MS ? f : null;
  };
}

/** A number that flashes once when its value changed since the previous poll (re-mounted per value). */
function Price({ value, flash, className = '' }: { value: unknown; flash: Flash | null; className?: string }) {
  return <span key={String(value)} className={`num inline-block ${flash ? `flash-${flash.dir}` : ''} ${className}`}>{idr(value)}</span>;
}

function SortHead({ label, k, sort, onSort, align = 'right' }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; align?: 'left' | 'right' }) {
  const active = sort.key === k;
  return (
    <button type="button" onClick={() => onSort(k)} aria-label={`Urutkan menurut ${label}`}
      className={`group inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg focus-visible:outline-none focus-visible:text-fg ${active ? 'text-fg' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      {label}
      <Icon name={active ? (sort.dir === 1 ? 'arrowUp' : 'arrowDown') : 'sort'} className={`size-3.5 ${active ? 'text-accent' : 'opacity-40 group-hover:opacity-80'}`} />
    </button>
  );
}

function Th({ children, className = '', ariaSort }: { children: ReactNode; className?: string; ariaSort?: 'ascending' | 'descending' | 'none' }) {
  return <th aria-sort={ariaSort} className={`whitespace-nowrap border-b border-line px-3 py-2.5 font-medium first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5 ${className}`}>{children}</th>;
}

export default function Market({ isAdmin = false }: { isAdmin?: boolean }) {
  const [scope, setScope] = useState<'tracked' | 'all'>('tracked');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'vol', dir: -1 });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, loading, reload, updatedAt } = usePoll<any>(`/api/market/tickers?scope=${scope}`, 15000);
  const flashOf = usePriceFlashes(data?.tickers, scope);

  const rows = useMemo(() => {
    const list = (data?.tickers ?? []) as any[];
    const s = q.trim().toLowerCase();
    const filtered = s ? list.filter((t) => String(t.pair_id).includes(s) || String(t.name ?? '').toLowerCase().includes(s)) : list;
    return [...filtered].sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
      if (va === null || (typeof va === 'number' && !Number.isFinite(va))) return 1;
      if (vb === null || (typeof vb === 'number' && !Number.isFinite(vb))) return -1;
      return (typeof va === 'string' ? va.localeCompare(String(vb)) : va - (vb as number)) * sort.dir;
    });
  }, [data, q, sort]);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'pair' ? 1 : -1 }));
  const ariaSort = (k: SortKey) => (sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');

  const toggle = async (pair: string, tracked: boolean) => {
    setMsg(null); setBusy(pair);
    try { await put(`/api/market/pairs/${pair}/track`, { tracked }); await reload(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const isStale = (t: any) => Date.now() - Date.parse(t.server_time ?? t.updated_at) > 180_000;
  const badges = (t: any) => (<>
    {t.is_tracked && <Badge color="blue">manual</Badge>}
    {t.in_universe && <Badge color="green">otomatis #{t.universe_rank ?? '—'}</Badge>}
  </>);
  const trackBtn = (t: any) => isAdmin && (
    <Button variant="ghost" className="w-20 justify-center" loading={busy === t.pair_id} disabled={busy !== null} onClick={() => toggle(t.pair_id, !t.is_tracked)}>
      {t.is_tracked ? 'Lepas' : 'Pantau'}
    </Button>
  );
  const emptyText = q.trim() ? `Tidak ada pair yang cocok dengan “${q.trim()}”.`
    : scope === 'tracked' ? 'Belum ada data untuk pair yang dipantau. Data muncul setelah cron pertama berjalan.' : 'Tidak ada data.';

  return (
    <div className="space-y-4">
      <PageHeader title="Market Monitor" subtitle={<>Data resmi INDODAX Public API • diperbarui {updatedAt ? ago(updatedAt.toISOString()) : '—'}</>} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Cari pair…" className="w-full sm:w-56" />
        <Segmented label="Cakupan pair" value={scope} onChange={(v) => setScope(v as 'tracked' | 'all')}
          options={[{ value: 'tracked', label: 'Dipantau' }, { value: 'all', label: 'Semua pair IDR' }]} />
        <div className="md:hidden">
          <Select value={sort.key} onChange={(v) => setSort({ key: v as SortKey, dir: v === 'pair' ? 1 : -1 })}
            options={SORT_OPTIONS.map((o) => ({ value: o.value, label: `Urutkan: ${o.label}` }))} />
        </div>
        {data && <span className="num ml-auto text-xs text-subtle">{rows.length} pair</span>}
      </div>
      <ErrorBox error={error ?? msg} />
      <Card>
        {loading && !data ? <Loading rows={8} /> : rows.length ? (<>
          {/* Desktop / tablet: sortable table */}
          <div className="hidden overflow-auto md:block" style={{ maxHeight: 'calc(100dvh - 15rem)' }}>
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wider text-subtle">
                <tr>
                  <Th ariaSort={ariaSort('pair')}><SortHead label="Pair" k="pair" sort={sort} onSort={onSort} align="left" /></Th>
                  <Th className="text-right" ariaSort={ariaSort('last')}><SortHead label="Last" k="last" sort={sort} onSort={onSort} /></Th>
                  <Th className="text-right">Bid</Th>
                  <Th className="text-right">Ask</Th>
                  <Th className="text-right" ariaSort={ariaSort('spread')}><SortHead label="Spread" k="spread" sort={sort} onSort={onSort} /></Th>
                  <Th className="hidden text-right xl:table-cell">High 24j</Th>
                  <Th className="hidden text-right xl:table-cell">Low 24j</Th>
                  <Th className="text-right" ariaSort={ariaSort('change')}><SortHead label="24j" k="change" sort={sort} onSort={onSort} /></Th>
                  <Th className="text-right" ariaSort={ariaSort('vol')}><SortHead label="Volume (IDR)" k="vol" sort={sort} onSort={onSort} /></Th>
                  <Th>Update</Th>
                  {isAdmin && <Th><span className="sr-only">Aksi</span></Th>}
                </tr>
              </thead>
              <tbody className="num divide-y divide-line/70 [&>tr]:transition-colors [&>tr:hover]:bg-white/[0.03] [&_td]:whitespace-nowrap [&_td]:px-3 [&_td]:py-2.5 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 sm:[&_td:first-child]:pl-5 sm:[&_td:last-child]:pr-5">
                {rows.map((t) => {
                  const spread = spreadOf(t);
                  return (
                    <tr key={t.pair_id}>
                      <td><div className="flex items-center gap-1.5"><Link to={`/chart?pair=${t.pair_id}`} className="font-medium hover:text-accent">{pairLabel(t.pair_id)}</Link>{badges(t)}</div></td>
                      <td className="text-right font-medium"><Price value={t.last} flash={flashOf(t.pair_id, 'last')} /></td>
                      <td className="text-right text-up"><Price value={t.bid} flash={flashOf(t.pair_id, 'bid')} /></td>
                      <td className="text-right text-down"><Price value={t.ask} flash={flashOf(t.pair_id, 'ask')} /></td>
                      <td className="text-right text-muted">{spread === null ? '—' : `${num(spread, 3)}%`}</td>
                      <td className="hidden text-right text-muted xl:table-cell">{idr(t.high)}</td>
                      <td className="hidden text-right text-muted xl:table-cell">{idr(t.low)}</td>
                      <td className={`text-right ${pnlClass(t.change_24h_pct)}`}>{pct(t.change_24h_pct)}</td>
                      <td className="text-right">{idr(t.vol_idr, { compact: true })}</td>
                      <td>{isStale(t) ? <Badge color="yellow">basi</Badge> : <span className="text-muted">{ago(t.server_time ?? t.updated_at)}</span>}</td>
                      {isAdmin && <td className="text-right">{trackBtn(t)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Mobile: card list */}
          <ul className="divide-y divide-line/70 md:hidden">
            {rows.map((t) => {
              const spread = spreadOf(t);
              return (
                <li key={t.pair_id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/chart?pair=${t.pair_id}`} className="font-medium hover:text-accent">{pairLabel(t.pair_id)}</Link>
                      <div className="mt-1 flex flex-wrap gap-1">{badges(t)}{isStale(t) && <Badge color="yellow">basi</Badge>}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-base font-semibold"><Price value={t.last} flash={flashOf(t.pair_id, 'last')} /></div>
                      <div className={`num text-sm ${pnlClass(t.change_24h_pct)}`}>{pct(t.change_24h_pct)}</div>
                    </div>
                  </div>
                  <dl className="num grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-subtle">Bid</dt><dd className="truncate text-up"><Price value={t.bid} flash={flashOf(t.pair_id, 'bid')} /></dd></div>
                    <div><dt className="text-subtle">Ask</dt><dd className="truncate text-down"><Price value={t.ask} flash={flashOf(t.pair_id, 'ask')} /></dd></div>
                    <div><dt className="text-subtle">Spread</dt><dd className="truncate text-muted">{spread === null ? '—' : `${num(spread, 3)}%`}</dd></div>
                  </dl>
                  <div className="flex items-center justify-between gap-2 text-xs text-subtle">
                    <span className="num">Vol {idr(t.vol_idr, { compact: true })} • {ago(t.server_time ?? t.updated_at)}</span>
                    {trackBtn(t)}
                  </div>
                </li>
              );
            })}
          </ul>
        </>) : <Empty>{emptyText}</Empty>}
      </Card>
      <p className="text-xs text-subtle">“Dipantau” = pair manual (maks 10) + pair otomatis dari universe dinamis (peringkat volume 24 jam, diperbarui tiap 15 menit; atur di Strategy Configuration). Data “basi” = ticker lebih dari 3 menit tidak berubah dan tidak dipakai untuk sinyal.</p>
    </div>
  );
}
