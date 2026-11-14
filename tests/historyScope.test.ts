import { describe, expect, it } from 'vitest';
import { historyScopeNote, type HistoryPeriod } from '../src/lib/historyScope';

describe('history PnL scope', () => {
  it('explains that All includes retained history across account resets', () => {
    const note = historyScopeNote('all');
    expect(note).toContain('seluruh riwayat transaksi tersimpan');
    expect(note).toContain('sebelum reset akun');
    expect(note).toContain('tidak menghapus riwayat');
    expect(note).toContain('Overview/Paper');
    expect(note).toContain('reset terakhir');
  });

  it.each<HistoryPeriod>(['1', '7', '30'])('explains the date-filtered history scope for %s days', (period) => {
    const note = historyScopeNote(period);
    expect(note).toContain('rentang waktu terpilih');
    expect(note).toContain('dapat mencakup transaksi sebelum reset akun');
    expect(note).toContain('Overview/Paper');
    expect(note).toContain('reset terakhir');
  });
});
