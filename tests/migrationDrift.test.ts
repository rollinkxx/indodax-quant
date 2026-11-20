import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditMigrationDrift, duplicateVersions, unparsableMigrations } from '../shared/migrationPlan';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/**
 * Drift between the repository and `supabase_migrations.schema_migrations` is what let a function be
 * replaced by hand on 2026-11-20: the manual apply recorded a version with no repository file, and a
 * later "correction" recorded another. Neither was visible anywhere in CI, and the only symptom was a
 * cron that stopped running. These are the checks that make that visible.
 */
describe('migration drift', () => {
  it('reports no drift when the repository and the database agree', () => {
    const audit = auditMigrationDrift(
      ['20261117140000_pending_sell_signals.sql', '20261118000000_begin_run_pair_taker_fee.sql'],
      ['20261117140000', '20261118000000'],
    );
    expect(audit.drifted).toBe(false);
    expect(audit.missingFromDatabase).toEqual([]);
    expect(audit.missingFromRepository).toEqual([]);
  });

  it('flags a migration file that was never applied', () => {
    const audit = auditMigrationDrift(
      ['20261117140000_pending_sell_signals.sql', '20261120170000_pipeline_phase_5m_bucket.sql'],
      ['20261117140000'],
    );
    expect(audit.drifted).toBe(true);
    expect(audit.missingFromDatabase).toEqual(['20261120170000']);
  });

  it('flags a recorded version with no repository file', () => {
    const audit = auditMigrationDrift(
      ['20261117140000_pending_sell_signals.sql'],
      ['20261117140000', '20261120162840'],
    );
    expect(audit.drifted).toBe(true);
    expect(audit.missingFromRepository).toEqual(['20261120162840']);
  });

  it('flags both directions at once', () => {
    const audit = auditMigrationDrift(['20261120170000_new.sql'], ['20261120162840']);
    expect(audit.drifted).toBe(true);
    expect(audit.missingFromDatabase).toEqual(['20261120170000']);
    expect(audit.missingFromRepository).toEqual(['20261120162840']);
  });

  it('sorts every reported version so CI output is stable', () => {
    const audit = auditMigrationDrift(
      ['20261118000000_c.sql', '20261117140000_b.sql', '20261119000000_d.sql'],
      ['20261120162840', '20261120165648'],
    );
    expect(audit.missingFromDatabase).toEqual(['20261117140000', '20261118000000', '20261119000000']);
    expect(audit.missingFromRepository).toEqual(['20261120162840', '20261120165648']);
  });

  it('does not treat a duplicated recorded version as drift', () => {
    // A version recorded twice is a different problem (see duplicateVersions); it must not be
    // reported as "missing from the repository" when a file exists.
    const audit = auditMigrationDrift(['20261117140000_a.sql'], ['20261117140000', '20261117140000']);
    expect(audit.drifted).toBe(false);
  });
});

describe('duplicate migration versions', () => {
  it('accepts one file per version', () => {
    expect(duplicateVersions(['20261117140000_a.sql', '20261118000000_b.sql'])).toEqual([]);
  });

  it('reports the version when two files share it', () => {
    // Two files with the same leading timestamp both parse to the same version, so only one of them
    // is ever applied and the other is silently ignored. That is the shape of a bad merge.
    expect(duplicateVersions(['20261117140000_a.sql', '20261117140000_b.sql'])).toEqual(['20261117140000']);
  });

  it('ignores files that do not parse as migrations', () => {
    expect(duplicateVersions(['20261117140000_a.sql', 'README.md', 'notes.sql'])).toEqual([]);
  });
});

describe('unparsable migrations', () => {
  it('accepts names that follow the 14-digit convention', () => {
    expect(unparsableMigrations(['20261117140000_pending_sell_signals.sql'])).toEqual([]);
  });

  it('reports .sql files that would be skipped silently', () => {
    // planMigrations drops anything that does not match; a typo in the timestamp means the migration
    // is never applied and nothing complains.
    expect(unparsableMigrations(['202611171400_pending_sell_signals.sql'])).toEqual(['202611171400_pending_sell_signals.sql']);
    expect(unparsableMigrations(['pending_sell_signals.sql'])).toEqual(['pending_sell_signals.sql']);
  });
});

describe('the repository itself', () => {
  const filenames = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));

  it('has no duplicate versions', () => {
    expect(duplicateVersions(filenames)).toEqual([]);
  });

  it('has no unparsable migration filenames', () => {
    expect(unparsableMigrations(filenames)).toEqual([]);
  });
});
