// Pure planning for the production migration step.
// The repository is the source of truth: a migration file named `<version>_<name>.sql` must be applied
// exactly once, in ascending version order. Drift between the repo and `supabase_migrations.schema_migrations`
// is what let a Worker change ship without the function it called (the pending-SELL 404 regression).

export interface MigrationFile {
  version: string; // leading timestamp, e.g. 20261117140000
  name: string; // remainder of the filename, e.g. pending_sell_signals
  path: string;
}

export interface MigrationPlan {
  pending: MigrationFile[]; // repo migrations not yet recorded, ascending by version
  unknown: string[]; // recorded versions with no matching repo file (informational)
}

export interface MigrationAudit {
  /** True when the repository and the database disagree in either direction. */
  drifted: boolean;
  /** Repo versions with no row in `schema_migrations`: they were never applied. */
  missingFromDatabase: string[];
  /** Recorded versions with no repository file: applied by something other than this repo. */
  missingFromRepository: string[];
}

/** Parse a migration filename into its version and name; returns null when the name is malformed. */
export function parseMigrationFilename(filename: string): MigrationFile | null {
  const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
  if (!match) return null;
  return { version: match[1], name: match[2], path: filename };
}

/**
 * Compute which repo migrations still need to be applied.
 * `appliedVersions` are the versions already present in `supabase_migrations.schema_migrations`.
 */
export function planMigrations(filenames: string[], appliedVersions: Iterable<string>): MigrationPlan {
  const applied = new Set(appliedVersions);
  const files = filenames
    .map(parseMigrationFilename)
    .filter((f): f is MigrationFile => f !== null)
    .sort((a, b) => a.version.localeCompare(b.version));
  const repoVersions = new Set(files.map((f) => f.version));
  return {
    pending: files.filter((f) => !applied.has(f.version)),
    unknown: [...applied].filter((v) => !repoVersions.has(v)).sort(),
  };
}

/**
 * Compare the repository's migrations against what production has recorded, in both directions.
 *
 * `planMigrations` answers "what still needs applying"; this answers "do these two lists describe the
 * same history". A version recorded with no file means something applied SQL that this repository
 * cannot reproduce — the exact shape of a hand-applied fix — and must fail the build rather than warn.
 */
export function auditMigrationDrift(filenames: string[], appliedVersions: Iterable<string>): MigrationAudit {
  const applied = new Set(appliedVersions);
  const repoVersions = new Set(
    filenames
      .map(parseMigrationFilename)
      .filter((f): f is MigrationFile => f !== null)
      .map((f) => f.version),
  );
  const missingFromDatabase = [...repoVersions].filter((v) => !applied.has(v)).sort();
  const missingFromRepository = [...applied].filter((v) => !repoVersions.has(v)).sort();
  return {
    drifted: missingFromDatabase.length > 0 || missingFromRepository.length > 0,
    missingFromDatabase,
    missingFromRepository,
  };
}

/**
 * Versions claimed by more than one file. Only one of them is ever applied, so the other is silently
 * dead — usually the residue of a bad merge.
 */
export function duplicateVersions(filenames: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) continue;
    if (seen.has(parsed.version)) duplicates.add(parsed.version);
    seen.add(parsed.version);
  }
  return [...duplicates].sort();
}

/**
 * `.sql` files in the migrations directory that `parseMigrationFilename` rejects. They are skipped by
 * planning without any error, so a malformed timestamp means the migration never runs.
 */
export function unparsableMigrations(filenames: string[]): string[] {
  return filenames
    .filter((name) => name.endsWith('.sql') && parseMigrationFilename(name) === null)
    .sort();
}
