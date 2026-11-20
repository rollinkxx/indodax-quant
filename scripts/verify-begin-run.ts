// Verify the live `begin_run` still honours the contract the Worker depends on.
//
// `verify-schema-contract.ts` proves the RPC *exists*; this proves it *returns what the Worker reads*.
// On 2026-11-20 a hand-applied replacement kept the name and the signature but dropped `config`,
// `pairs`, `catalog` and `open_positions` from the returned jsonb. Every check passed, the deploy
// succeeded, and the cron then crashed before inserting a run row — no error anywhere, no cron.
//
// Usage: SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npx tsx scripts/verify-begin-run.ts
import { checkBeginRunBody } from '../shared/beginRunContract';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  process.exit(1);
}

async function query(sql: string): Promise<unknown> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Management API HTTP ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const rows = (await query(
  `select pg_get_functiondef(p.oid) as body
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'begin_run' and n.nspname = 'public';`,
)) as { body: string }[];

if (!rows.length) {
  console.error('::error::begin_run does not exist in the live schema');
  process.exit(1);
}

const violations = checkBeginRunBody(rows[0].body);
if (violations.length) {
  for (const violation of violations) console.error(`::error::${violation.detail}`);
  process.exit(1);
}
console.log('begin_run returns every key the Worker reads, on the 5m signal bucket, with its watchdog.');
