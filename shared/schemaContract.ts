// Static description of the database objects the deployed Worker depends on.
// The Worker reaches Postgres only through PostgREST (RPC calls and table reads/writes), so a
// missing function or table is a runtime 404 that a per-minute cron swallows into its action log.
// This module lets CI compare the Worker's expectations against the live PostgREST schema and fail
// the release loudly instead of discovering the gap in production.

export interface SchemaContract {
  rpcs: string[];
  tables: string[];
}

const RPC_CALL = /db\.rpc\s*(?:<[^(]*?>)?\s*\(\s*'([a-z0-9_]+)'/g;
const TABLE_CALL = /db\.(?:select|update)\s*(?:<[^(]*?>)?\s*\(\s*'([a-z0-9_]+)'/g;

/**
 * Extract every RPC and table the Worker source references, from the `db.rpc('...')`,
 * `db.select('...')` and `db.update('...')` call sites (including their generic type arguments).
 */
export function extractSchemaContract(sources: { path: string; text: string }[]): SchemaContract {
  const rpcs = new Set<string>();
  const tables = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(RPC_CALL)) rpcs.add(match[1]);
    for (const match of text.matchAll(TABLE_CALL)) tables.add(match[1]);
  }
  return { rpcs: [...rpcs].sort(), tables: [...tables].sort() };
}

export interface ExposedSchema {
  rpcs: Set<string>;
  tables: Set<string>;
}

/** Parse the PostgREST OpenAPI document into the sets of callable RPCs and readable tables. */
export function parseExposedSchema(openapi: unknown): ExposedSchema {
  const paths = (openapi as { paths?: Record<string, unknown> })?.paths ?? {};
  const rpcs = new Set<string>();
  const tables = new Set<string>();
  for (const path of Object.keys(paths)) {
    if (path.startsWith('/rpc/')) rpcs.add(path.slice('/rpc/'.length));
    else if (path !== '/') tables.add(path.slice(1));
  }
  return { rpcs, tables };
}

/** Every contract entry absent from the exposed schema, as human-readable `kind: name` strings. */
export function missingSchemaObjects(contract: SchemaContract, exposed: ExposedSchema): string[] {
  const missing: string[] = [];
  for (const fn of contract.rpcs) if (!exposed.rpcs.has(fn)) missing.push(`function: ${fn}`);
  for (const table of contract.tables) if (!exposed.tables.has(table)) missing.push(`table: ${table}`);
  return missing;
}
