import { describe, expect, it } from 'vitest';
import { killSwitchOutcome } from '../src/lib/killSwitchOutcome';

describe('manual kill-switch outcome', () => {
  it('reports when all positions were closed', () => {
    expect(killSwitchOutcome({
      status: 'KILLED',
      closed: 2,
      total: 2,
      results: [{ pair: 'btcidr', ok: true }, { pair: 'ethidr', ok: true }],
    })).toEqual({
      msg: 'Kill switch aktif: 2/2 posisi berhasil ditutup.',
      err: undefined,
    });
  });

  it('warns with each pair and quote failure when some positions remain open', () => {
    const result = killSwitchOutcome({
      status: 'KILLED',
      closed: 1,
      total: 3,
      results: [
        { pair: 'btcidr', ok: true },
        { pair: 'thinidr', ok: false, error: 'stale_or_crossed_ticker (age=500s)' },
        { pair: 'otheridr', ok: false, reason: 'position_not_open' },
      ],
    });
    expect(result.msg).toBe('Kill switch aktif: 1/3 posisi berhasil ditutup.');
    expect(result.err).toContain('thinidr: stale_or_crossed_ticker (age=500s)');
    expect(result.err).toContain('otheridr: position_not_open');
    expect(result.err).toContain('Akun tetap KILLED');
  });

  it('reports zero open positions without showing a failure warning', () => {
    expect(killSwitchOutcome({ status: 'KILLED', closed: 0, total: 0, results: [] })).toEqual({
      msg: 'Kill switch aktif: 0/0 posisi berhasil ditutup.',
      err: undefined,
    });
  });

  it('still warns when the API says some closes failed but omits per-pair results', () => {
    expect(killSwitchOutcome({ status: 'KILLED', closed: 0, total: 2, results: [] })).toEqual({
      msg: 'Kill switch aktif: 0/2 posisi berhasil ditutup.',
      err: 'Perhatian: 2 posisi belum tertutup. Akun tetap KILLED; periksa harga pasar dan coba tutup posisi yang tersisa secara aman.',
    });
  });
});
