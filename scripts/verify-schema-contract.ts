// Post-deploy guardrail: verify the live PostgREST schema exposes every RPC and table the Worker
// references. The deployed Worker calls Postgres only through PostgREST, so a schema-dependent code
// change shipped without its migration fails at runtime with a 404 that the per-minute cron absorbs.
// This check turns that class of drift into a loud, early release failure.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/verify-schema-contract.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractSchemaContract, parseExposedSchema, missingSchemaObjects } from '../shared/schemaContract';

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const workerDir = join(import.meta.dirname, '..', 'worker', 'src');
const sources = readdirSync(workerDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ path: name, text: readFileSync(join(workerDir, name), 'utf8') }));
const contract = extractSchemaContract(sources);

const headers: Record<string, string> = { apikey: key, accept: 'application/openapi+json' };
if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;

const response = await fetch(`${url}/rest/v1/`, { headers });
if (!response.ok) {
  console.error(`Unable to read the PostgREST OpenAPI document: HTTP ${response.status}`);
  process.exit(1);
}
const exposed = parseExposedSchema(await response.json());

const missing = missingSchemaObjects(contract, exposed);
console.log(
  `Schema contract: ${contract.rpcs.length} RPC(s), ${contract.tables.length} table(s) referenced by the Worker; ` +
  `live schema exposes ${exposed.rpcs.size} RPC(s), ${exposed.tables.size} table(s).`,
);
if (missing.length) {
  console.error(`::error::The deployed PostgREST schema is missing ${missing.length} object(s) the Worker requires:`);
  for (const item of missing) console.error(`  - ${item}`);
  console.error('Apply the pending supabase/migrations before deploying Worker code that depends on them.');
  process.exit(1);
}
console.log('Schema contract satisfied: every Worker dependency exists in production.');
