/**
 * Daily realised PnL per WIB day for the Overview calendar. Pure functions (tested in tests/pnlCalendar.test.ts).
 * WIB is UTC+7 all year (no DST), so a WIB date is the UTC date of `t + 7 h`.
 */
const WIB_OFFSET_MS = 7 * 3600 * 1000;

export type DayPnl = { pnl: number; trades: number; wins: number; losses: number };
export type MonthKey = { year: number; month: number }; // month 1..12

/** 'YYYY-MM-DD' of the WIB calendar day containing `v`, or null for an invalid date. */
export function wibDay(v: string | number | Date): string | null {
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

export function wibMonth(v: string | number | Date = Date.now()): MonthKey | null {
  const d = wibDay(v);
  return d ? { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) } : null;
}

export const monthIndex = (m: MonthKey) => m.year * 12 + (m.month - 1);
export const addMonths = (m: MonthKey, n: number): MonthKey => {
  const i = monthIndex(m) + n;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
};

type ClosedPosition = { account_id?: unknown; closed_at?: unknown; realized_pnl?: unknown; status?: unknown };

/**
 * Groups closed positions of `accountId` closed at/after `resetAt` by WIB day.
 * `/api/positions?status=closed` returns every account and also positions from before the last reset, so both filters matter.
 */
export function dailyPnl(positions: ClosedPosition[], accountId: unknown, resetAt: unknown): Map<string, DayPnl> {
  const out = new Map<string, DayPnl>();
  const since = resetAt ? Date.parse(String(resetAt)) : -Infinity;
  for (const p of positions) {
    if (String(p.account_id) !== String(accountId)) continue;
    if (p.status !== undefined && p.status !== 'CLOSED') continue;
    if (!p.closed_at) continue;
    const t = Date.parse(String(p.closed_at));
    if (!Number.isFinite(t) || t < since) continue;
    const pnl = Number(p.realized_pnl);
    if (!Number.isFinite(pnl)) continue;
    const day = wibDay(t)!;
    const d = out.get(day) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
    d.pnl += pnl;
    d.trades += 1;
    if (pnl > 0) d.wins += 1;
    else if (pnl < 0) d.losses += 1;
    out.set(day, d);
  }
  return out;
}

/**
 * Month grid starting on Monday, always 6 weeks (42 cells) so the calendar never changes height between months.
 * Cells outside the month are null.
 */
export function monthGrid(m: MonthKey): (string | null)[] {
  const first = new Date(Date.UTC(m.year, m.month - 1, 1));
  const days = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const mm = String(m.month).padStart(2, '0');
  return Array.from({ length: 42 }, (_, i) => {
    const d = i - lead + 1;
    return d >= 1 && d <= days ? `${m.year}-${mm}-${String(d).padStart(2, '0')}` : null;
  });
}

/** Totals for one month ('YYYY-MM' prefix). */
export function monthSummary(daily: Map<string, DayPnl>, m: MonthKey) {
  const prefix = `${m.year}-${String(m.month).padStart(2, '0')}-`;
  let pnl = 0; let trades = 0; let greenDays = 0; let redDays = 0; let maxAbs = 0;
  for (const [day, d] of daily) {
    if (!day.startsWith(prefix)) continue;
    pnl += d.pnl; trades += d.trades;
    if (d.pnl > 0) greenDays += 1; else if (d.pnl < 0) redDays += 1;
    maxAbs = Math.max(maxAbs, Math.abs(d.pnl));
  }
  return { pnl, trades, greenDays, redDays, maxAbs };
}
