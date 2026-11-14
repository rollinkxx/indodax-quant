import { describe, expect, it } from 'vitest';
import { addMonths, dailyPnl, monthGrid, monthSummary, wibDay, wibMonth } from '../src/lib/pnlCalendar';

describe('PnL calendar', () => {
  it('maps UTC timestamps to the WIB day (UTC+7)', () => {
    expect(wibDay('2026-11-13T16:59:59Z')).toBe('2026-11-13');
    expect(wibDay('2026-11-13T17:00:00Z')).toBe('2026-11-14');
    expect(wibDay('2026-11-13T19:46:11.566685+00:00')).toBe('2026-11-14');
    expect(wibDay('nope')).toBeNull();
    expect(wibMonth('2026-12-31T18:00:00Z')).toEqual({ year: 2027, month: 1 });
  });

  it('sums realised PnL per WIB day for the active account since the last reset only', () => {
    const rows = [
      { account_id: 1, closed_at: '2026-11-13T13:34:14Z', realized_pnl: '37551.36' },
      { account_id: 1, closed_at: '2026-11-13T15:21:15Z', realized_pnl: '-64383.61' },
      { account_id: 1, closed_at: '2026-11-13T19:46:11Z', realized_pnl: '-34067.48' },
      { account_id: 2, closed_at: '2026-11-13T12:00:00Z', realized_pnl: '999' }, // other account
      { account_id: 1, closed_at: '2026-11-12T12:00:00Z', realized_pnl: '555' }, // before reset
      { account_id: 1, closed_at: null, realized_pnl: '1' },
    ];
    const d = dailyPnl(rows, 1, '2026-11-13T01:27:30Z');
    expect([...d.keys()].sort()).toEqual(['2026-11-13', '2026-11-14']);
    expect(d.get('2026-11-13')!.trades).toBe(2);
    expect(d.get('2026-11-13')!.pnl).toBeCloseTo(-26832.25, 2);
    expect(d.get('2026-11-13')).toMatchObject({ wins: 1, losses: 1 });
    expect(d.get('2026-11-14')).toMatchObject({ trades: 1, wins: 0, losses: 1 });
    const s = monthSummary(d, { year: 2026, month: 11 });
    expect(s.trades).toBe(3);
    expect(s.pnl).toBeCloseTo(-60899.73, 2);
    expect(s).toMatchObject({ greenDays: 0, redDays: 2 });
    expect(monthSummary(d, { year: 2026, month: 10 }).trades).toBe(0);
  });

  it('builds a Monday-first 6-week grid', () => {
    const g = monthGrid({ year: 2026, month: 11 }); // 1 Nov 2026 is a Sunday
    expect(g).toHaveLength(42);
    expect(g.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(g[6]).toBe('2026-11-01');
    expect(g[6 + 29]).toBe('2026-11-30');
    expect(g.filter(Boolean)).toHaveLength(30);
    const feb = monthGrid({ year: 2027, month: 2 }); // 1 Feb 2027 is a Monday
    expect(feb[0]).toBe('2027-02-01');
    expect(feb.filter(Boolean)).toHaveLength(28);
  });

  it('steps months across year boundaries', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });
});
