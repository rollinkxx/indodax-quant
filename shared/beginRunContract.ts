// The contract between `begin_run` and the Worker.
//
// The Worker reads these keys straight off the returned jsonb. A replacement body that omits one of
// them throws inside `begin_run` *before* the run row is inserted, so the cron goes silent with no
// `execution_logs` row to explain it — which is exactly what a hand-typed replacement did on
// 2026-11-20. Checking the live definition turns a nine-minute silent outage into a failed job.

/** Keys the Worker destructures from the `begin_run` result. */
export const REQUIRED_BEGIN_RUN_KEYS = [
  'ok',
  'run_id',
  'fence_token',
  'lease_expires_at',
  'config',
  'account',
  'pairs',
  'catalog',
  'open_positions',
] as const;

/** Fragments that must appear in the body for the cadence and watchdog to still work. */
export const REQUIRED_BEGIN_RUN_FRAGMENTS = [
  // FIX-07: signals are due once per 300s bucket, not once per hour.
  { needle: 'make_interval(secs => 300 * floor', reason: 'signals_due must be derived from a 300s bucket' },
  // Finalizes a RUNNING row whose lease expired; without it a crashed run blocks later runs.
  { needle: 'stale_run_without_lease', reason: 'the stale-run watchdog must survive' },
] as const;

export interface BeginRunContractViolation {
  kind: 'missing_key' | 'missing_fragment';
  detail: string;
}

/**
 * Check a `pg_get_functiondef('begin_run')` body against the contract the Worker depends on.
 * `body` is the SQL text; keys are matched as quoted literals (`'config'`) because that is how they
 * appear in the `jsonb_build_object` call.
 */
export function checkBeginRunBody(body: string): BeginRunContractViolation[] {
  const violations: BeginRunContractViolation[] = [];
  for (const key of REQUIRED_BEGIN_RUN_KEYS) {
    if (!body.includes(`'${key}'`)) {
      violations.push({
        kind: 'missing_key',
        detail: `begin_run no longer returns '${key}'; the Worker throws before inserting the run row`,
      });
    }
  }
  for (const { needle, reason } of REQUIRED_BEGIN_RUN_FRAGMENTS) {
    if (!body.includes(needle)) {
      violations.push({ kind: 'missing_fragment', detail: `${reason} (missing "${needle}")` });
    }
  }
  return violations;
}
