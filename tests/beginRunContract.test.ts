import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBeginRunBody, REQUIRED_BEGIN_RUN_KEYS } from '../shared/beginRunContract';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const CHAIN_SOURCE = ['20261120160000_pipeline_phase.sql', '20261120170000_pipeline_phase_5m_bucket.sql']
  .map((name) => readFileSync(join(MIGRATIONS, name), 'utf8'));

/**
 * The body a hand-typed replacement produces: it returns a run id and a fence token and nothing else.
 * This is the 2026-11-20 outage in miniature — it applied cleanly, it looked right, and it took the
 * cron down with no `execution_logs` row because the throw happened before the insert.
 */
const TRUNCATED_BODY = `
CREATE OR REPLACE FUNCTION public.begin_run(p_scheduled timestamptz)
RETURNS jsonb AS $fn$
BEGIN
  RETURN jsonb_build_object('ok', true, 'run_id', v_run_id, 'fence_token', v_token);
END $fn$;
`;

describe('begin_run contract', () => {
  it('accepts the current migration chain', () => {
    // Only the newest migration defines the live body; earlier files legitimately predate the 300s
    // bucket fix, so asserting the cadence against them would fail for the right reason at the wrong
    // time. Keys are asserted against every file because none of them may ever drop one.
    expect(checkBeginRunBody(CHAIN_SOURCE[CHAIN_SOURCE.length - 1])).toEqual([]);
  });

  it('keeps every required key in every migration that defines begin_run', () => {
    for (const sql of CHAIN_SOURCE) {
      const missingKeys = checkBeginRunBody(sql).filter((v) => v.kind === 'missing_key');
      expect(missingKeys).toEqual([]);
    }
  });

  it('rejects a body that dropped the keys the Worker reads', () => {
    const violations = checkBeginRunBody(TRUNCATED_BODY);
    const missing = violations.filter((v) => v.kind === 'missing_key').map((v) => v.detail);
    // The three that caused the outage, plus the rest the Worker needs.
    for (const key of ['config', 'pairs', 'catalog', 'open_positions', 'lease_expires_at']) {
      expect(missing.some((detail) => detail.includes(`'${key}'`))).toBe(true);
    }
  });

  it('reports one violation per missing key, not a single vague failure', () => {
    const violations = checkBeginRunBody(TRUNCATED_BODY);
    const missingKeys = violations.filter((v) => v.kind === 'missing_key');
    expect(missingKeys).toHaveLength(REQUIRED_BEGIN_RUN_KEYS.length - 3); // ok, run_id, fence_token are present
  });

  it('rejects a body that evaluates signals once per hour', () => {
    const hourly = CHAIN_SOURCE[1].replace('make_interval(secs => 300 * floor', "date_trunc('hour'");
    const violations = checkBeginRunBody(hourly);
    expect(violations.some((v) => v.detail.includes('300s bucket'))).toBe(true);
  });

  it('rejects a body without the stale-run watchdog', () => {
    const noWatchdog = CHAIN_SOURCE[1].replace('stale_run_without_lease', 'removed');
    const violations = checkBeginRunBody(noWatchdog);
    expect(violations.some((v) => v.detail.includes('watchdog'))).toBe(true);
  });

  it('names every key it requires so a reader can check the list', () => {
    expect([...REQUIRED_BEGIN_RUN_KEYS]).toEqual([
      'ok', 'run_id', 'fence_token', 'lease_expires_at',
      'config', 'account', 'pairs', 'catalog', 'open_positions',
    ]);
  });
});
