import { useMemo, useState } from 'react';
import { Card, Skeleton } from './ui';
import { Icon } from './Icon';
import { idr, pnlClass } from '../lib/format';
import { addMonths, dailyPnl, monthGrid, monthIndex, monthSummary, wibDay, wibMonth, type MonthKey } from '../lib/pnlCalendar';

const WEEKDAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const LIMIT = 1000;
const navBtn = 'grid size-8 place-items-center rounded-control text-muted transition-colors duration-150 hover:bg-elevated hover:text-fg disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

const monthLabel = (m: MonthKey) =>
  new Date(Date.UTC(m.year, m.month - 1, 1)).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Month grid of realised PnL per WIB day (green = profit, red = loss, stronger = larger relative to the month's biggest day).
 * Data: closed positions from `/api/positions?status=closed&limit=1000`, filtered to the active account since its last reset.
 * Always 6 rows, so switching months or polling never changes the card height.
 */
export function PnlCalendar({ positions, account, loading, className = '' }: {
  positions: any[] | null; account: { id: unknown; reset_at?: unknown } | null; loading: boolean; className?: string;
}) {
  const now = wibMonth()!;
  const minMonth: MonthKey = (account?.reset_at ? wibMonth(String(account.reset_at)) : null) ?? now;
  const [month, setMonth] = useState<MonthKey>(now);

  const daily = useMemo(() => dailyPnl(positions ?? [], account?.id, account?.reset_at), [positions, account?.id, account?.reset_at]);
  const cells = useMemo(() => monthGrid(month), [month]);
  const sum = useMemo(() => monthSummary(daily, month), [daily, month]);
  const today = wibDay(Date.now());
  const ready = !!positions && !!account;
  const truncated = (positions?.length ?? 0) >= LIMIT;

  const canPrev = monthIndex(month) > monthIndex(minMonth);
  const canNext = monthIndex(month) < monthIndex(now);

  return (
    <Card title="Kalender PnL Harian" className={className} actions={
      <div className="flex items-center gap-1">
        <button type="button" className={navBtn} onClick={() => setMonth(addMonths(month, -1))} disabled={!canPrev} aria-label="Bulan sebelumnya">
          <Icon name="chevronRight" className="size-4 rotate-180" />
        </button>
        <span className="min-w-[8.5rem] text-center text-sm font-medium capitalize" aria-live="polite">{monthLabel(month)}</span>
        <button type="button" className={navBtn} onClick={() => setMonth(addMonths(month, 1))} disabled={!canNext} aria-label="Bulan berikutnya">
          <Icon name="chevronRight" className="size-4" />
        </button>
      </div>
    }>
      <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] font-medium uppercase tracking-wide text-subtle" aria-hidden="true">
        {WEEKDAYS.map((d) => <div key={d} className="h-5 leading-5">{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1" role="list" aria-label={`PnL harian ${monthLabel(month)} (WIB)`}>
        {cells.map((day, i) => {
          if (!ready && loading) return <Skeleton key={i} className="h-9 rounded-md sm:h-10" />;
          if (!day) return <div key={i} aria-hidden="true" className="h-9 sm:h-10" />;
          const d = daily.get(day);
          const col = i % 7;
          const strength = d && sum.maxAbs > 0 ? 18 + Math.round((Math.abs(d.pnl) / sum.maxAbs) * 42) : 0;
          const bg = d && d.pnl !== 0 ? { backgroundColor: `color-mix(in srgb, var(--app-${d.pnl > 0 ? 'up' : 'down'}) ${strength}%, transparent)` } : undefined;
          const label = d ? `${dayLabel(day)}: ${idr(d.pnl, { sign: true })}, ${d.trades} trade` : `${dayLabel(day)}: tidak ada trade`;
          return (
            <div key={day} role="listitem" tabIndex={d ? 0 : undefined} aria-label={label}
              className={`group relative flex h-9 items-start justify-start rounded-md p-1 outline-none sm:h-10 ${d ? (d.pnl === 0 ? 'bg-elevated' : '') : 'bg-surface-2'} ${today === day ? 'ring-1 ring-inset ring-accent' : ''} ${d ? 'cursor-default focus-visible:ring-2 focus-visible:ring-focus' : ''}`}
              style={bg}>
              <span className={`num text-[0.6875rem] leading-none ${d ? 'font-semibold text-fg' : 'text-subtle'}`}>{Number(day.slice(8))}</span>
              {d && (
                <span aria-hidden="true"
                  className={`pointer-events-none absolute bottom-full z-20 mb-1.5 w-max max-w-[12rem] translate-y-1 rounded-control border border-line-strong bg-elevated px-2.5 py-1.5 text-left text-xs opacity-0 shadow-card transition-[opacity,translate] duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100 ${col < 2 ? 'left-0' : col > 4 ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}>
                  <span className="block text-muted">{dayLabel(day)}</span>
                  <span className={`num block font-semibold ${pnlClass(d.pnl)}`}>{idr(d.pnl, { sign: true })}</span>
                  <span className="num block text-subtle">{d.trades} trade · {d.wins} untung / {d.losses} rugi</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* Two fixed lines in every state (loading, data, error) so the card never changes height. */}
      <div className="num mt-3 grid h-9 content-center gap-1 text-xs leading-4 text-muted">
        {ready ? (
          <>
            <span className="truncate">Bulan ini <span className={`font-semibold ${pnlClass(sum.pnl)}`}>{idr(sum.pnl, { sign: true })}</span> · {sum.trades} trade</span>
            <span className="truncate">{sum.greenDays} hari hijau / {sum.redDays} hari merah</span>
          </>
        ) : loading ? (
          <>
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-32" />
          </>
        ) : <span className="row-span-2 self-center">Data posisi belum tersedia.</span>}
      </div>
      {truncated && <p className="mt-1 text-xs text-subtle">Hanya {LIMIT} posisi tertutup terakhir yang dihitung.</p>}
    </Card>
  );
}
