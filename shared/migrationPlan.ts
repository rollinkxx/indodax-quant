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
