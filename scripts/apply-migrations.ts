// Apply every repository migration that production has not recorded yet, in ascending version order.
// Runs through the Supabase Management API (SUPABASE_ACCESS_TOKEN), so it needs no database password
// and can run in CI. Each file is submitted as one query, which Postgres executes in a single implicit
// transaction; the version is recorded in supabase_migrations.schema_migrations only after success.
//
// Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npx tsx scripts/apply-migrations.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditMigrationDrift, duplicateVersions, planMigrations, unparsableMigrations } from '../shared/migrationPlan';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  process.exit(1);
}

const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;
async function query(sql: string): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Management API HTTP ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const migrationsDir = join(import.meta.dirname, '..', 'supabase', 'migrations');
const filenames = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

const appliedRows = (await query('select version from supabase_migrations.schema_migrations;')) as { version: string }[];
const appliedVersions = appliedRows.map((r) => r.version);

// Refuse to run when a recorded version has no repository file. That means someone applied SQL this
// repository cannot reproduce, so the next `wrangler deploy` could ship code depending on a schema
// the repo does not describe. That is how a hand-applied `begin_run` replacement took the cron down
// on 2026-11-20 with no log row to show for it.
//
// The other direction — a file not yet applied — is this script's normal input, so it is not an
// error here. `tests/migrationDrift.test.ts` asserts both directions for the audit itself.
const drift = auditMigrationDrift(filenames, appliedVersions);
if (drift.missingFromRepository.length) {
  console.error(
    `::error::Recorded in schema_migrations but absent from supabase/migrations: ` +
    `${drift.missingFromRepository.join(', ')}. Something applied SQL this repository cannot ` +
    `reproduce. Add the missing migration file, or delete the phantom row if it was a stray record.`,
  );
  process.exit(1);
}

const duplicates = duplicateVersions(filenames);
if (duplicates.length) {
  console.error(
    `::error::Two migration files share a version: ${duplicates.join(', ')}. Only one is ever ` +
    `applied and the other is silently dead; rename one to a later timestamp.`,
  );
  process.exit(1);
}

const unparsable = unparsableMigrations(filenames);
if (unparsable.length) {
  console.error(
    `::error::Migration filenames that do not match <14 digits>_<name>.sql: ${unparsable.join(', ')}. ` +
    `They would be skipped without any error.`,
  );
  process.exit(1);
}

const plan = planMigrations(filenames, appliedVersions);

if (plan.pending.length === 0) {
  console.log('Production schema is up to date; no migrations to apply.');
  process.exit(0);
}

console.log(`Applying ${plan.pending.length} pending migration(s): ${plan.pending.map((m) => m.version).join(', ')}`);
for (const migration of plan.pending) {
  const sql = readFileSync(join(migrationsDir, migration.path), 'utf8');
  console.log(`Applying ${migration.version}_${migration.name}`);
  await query(sql);
  await query(
    `insert into supabase_migrations.schema_migrations (version, name) values ` +
    `('${migration.version}', '${migration.name}') on conflict (version) do nothing;`,
  );
}
console.log('All pending migrations applied and recorded.');
