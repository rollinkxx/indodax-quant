import { describe, expect, it } from 'vitest';
import { parseMigrationFilename, planMigrations } from '../shared/migrationPlan';

describe('migration filename parsing', () => {
  it('splits the leading timestamp from the name', () => {
    expect(parseMigrationFilename('20261117140000_pending_sell_signals.sql'))
      .toEqual({ version: '20261117140000', name: 'pending_sell_signals', path: '20261117140000_pending_sell_signals.sql' });
  });

  it('rejects malformed names', () => {
    expect(parseMigrationFilename('pending_sell_signals.sql')).toBeNull();
    expect(parseMigrationFilename('2026111714000_too_short.sql')).toBeNull();
    expect(parseMigrationFilename('20261117140000_no_extension')).toBeNull();
  });
});

describe('migration planning', () => {
  it('returns only unapplied migrations, ascending by version', () => {
    const plan = planMigrations(
      ['20261118000000_begin_run_pair_taker_fee.sql', '20261117140000_pending_sell_signals.sql', '20261116163134_align.sql'],
      ['20261116163134'],
    );
    expect(plan.pending.map((m) => m.version)).toEqual(['20261117140000', '20261118000000']);
    expect(plan.unknown).toEqual([]);
  });

  it('reports nothing pending when the schema is current', () => {
    const plan = planMigrations(['20261117140000_pending_sell_signals.sql'], ['20261117140000']);
    expect(plan.pending).toEqual([]);
  });

  it('flags recorded versions with no repository file as unknown', () => {
    const plan = planMigrations(['20261117140000_pending_sell_signals.sql'], ['20261115011112', '20261117140000']);
    expect(plan.pending).toEqual([]);
    expect(plan.unknown).toEqual(['20261115011112']);
  });
});
