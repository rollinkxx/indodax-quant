// Apply every repository migration that production has not recorded yet, in ascending version order.
// Runs through the Supabase Management API (SUPABASE_ACCESS_TOKEN), so it needs no database password
// and can run in CI. Each file is submitted as one query, which Postgres executes in a single implicit
// transaction; the version is recorded in supabase_migrations.schema_migrations only after success.
//
// Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npx tsx scripts/apply-migrations.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { planMigrations } from '../shared/migrationPlan';

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
const plan = planMigrations(filenames, appliedRows.map((r) => r.version));

if (plan.unknown.length) {
  console.warn(`::warning::Recorded migrations with no repository file: ${plan.unknown.join(', ')}`);
}
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
