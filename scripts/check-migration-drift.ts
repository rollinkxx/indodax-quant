// Report drift between the repository and production's migration history, without changing anything.
//
// `apply-migrations.ts` refuses to run when a recorded version has no repository file, but that only
// fires on a deploy that has pending work. This script answers the question directly, at any time, so
// a phantom row left by a manual apply is visible immediately instead of on the next migration.
//
// Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npx tsx scripts/check-migration-drift.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditMigrationDrift, duplicateVersions, unparsableMigrations } from '../shared/migrationPlan';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  process.exit(1);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'select version from supabase_migrations.schema_migrations;' }),
});
const text = await response.text();
if (!response.ok) {
  console.error(`::error::Management API HTTP ${response.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
const applied = (JSON.parse(text) as { version: string }[]).map((row) => row.version);

const migrationsDir = join(import.meta.dirname, '..', 'supabase', 'migrations');
const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

const audit = auditMigrationDrift(filenames, applied);
const duplicates = duplicateVersions(filenames);
const unparsable = unparsableMigrations(filenames);

if (audit.missingFromRepository.length) {
  console.error(
    `::error::Recorded in schema_migrations but absent from supabase/migrations: ` +
    `${audit.missingFromRepository.join(', ')}. Something applied SQL this repository cannot reproduce.`,
  );
}
if (audit.missingFromDatabase.length) {
  console.error(
    `::error::Present in supabase/migrations but never applied: ${audit.missingFromDatabase.join(', ')}.`,
  );
}
if (duplicates.length) {
  console.error(`::error::Two migration files share a version: ${duplicates.join(', ')}.`);
}
if (unparsable.length) {
  console.error(`::error::Filenames that do not match <14 digits>_<name>.sql: ${unparsable.join(', ')}.`);
}

if (!audit.drifted && !duplicates.length && !unparsable.length) {
  console.log(`No drift: ${filenames.length} repository migration(s), ${applied.length} recorded version(s).`);
  process.exit(0);
}
process.exit(1);
