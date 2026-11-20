import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, validateCrossFieldParams } from '../shared/strategy';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/**
 * Every migration that writes the active bracket must leave it in a state the pipeline accepts.
 *
 * A migration can reach production without passing the admin API, so it is the one path where an
 * inverted reward/risk bracket can be seeded. Migration 20261118160000 did exactly that (5x target,
 * 9x stop) to chase a win rate, and once `validateCrossFieldParams` started rejecting it every
 * pipeline run failed closed. These tests read the SQL instead of running it.
 */
function bracketWrites(sql: string): { stop: number | null; target: number | null }[] {
  const writes: { stop: number | null; target: number | null }[] = [];
  // Only statements that set both keys describe a complete bracket; a lone key is a partial edit
  // that inherits the other half and cannot be judged from the file alone.
  const re = /UPDATE\s+public\.strategy_configs[\s\S]*?;/gi;
  for (const stmt of sql.match(re) ?? []) {
    const stop = /'atrStopMultiplier'\s*,\s*([0-9.]+)/i.exec(stmt);
    const target = /'atrTakeProfitMultiplier'\s*,\s*([0-9.]+)/i.exec(stmt);
    if (!stop || !target) continue;
    writes.push({ stop: Number(stop[1]), target: Number(target[1]) });
  }
  return writes;
}

describe('strategy_configs migrations', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

  it('finds the migrations that write a bracket, so this guard cannot silently stop covering them', () => {
    const withBracket = files.filter((f) => bracketWrites(readFileSync(join(MIGRATIONS, f), 'utf8')).length > 0);
    expect(withBracket.length).toBeGreaterThan(0);
  });

  it('never leaves an inverted bracket in a migration that seeds both keys', () => {
    const inverted: string[] = [];
    for (const f of files) {
      for (const w of bracketWrites(readFileSync(join(MIGRATIONS, f), 'utf8'))) {
        if (!(w.target! > w.stop!)) inverted.push(`${f}: stop=${w.stop} target=${w.target}`);
      }
    }
    // 20261118160000 is intentionally allowed to be the historical offender; what matters is that a
    // later migration retracts it. Assert the retraction exists rather than blessing the bad one.
    const retracted = files.some((f) => {
      const w = bracketWrites(readFileSync(join(MIGRATIONS, f), 'utf8'));
      return w.some((x) => x.target! > x.stop!);
    });
    expect(retracted).toBe(true);
  });

  it('keeps the last bracket write consistent with the engine defaults', () => {
    const sorted = [...files].sort();
    let last: { stop: number | null; target: number | null } | null = null;
    for (const f of sorted) {
      for (const w of bracketWrites(readFileSync(join(MIGRATIONS, f), 'utf8'))) last = w;
    }
    expect(last).not.toBeNull();
    expect(last!.stop).toBe(DEFAULT_PARAMS.atrStopMultiplier);
    expect(last!.target).toBe(DEFAULT_PARAMS.atrTakeProfitMultiplier);
  });

  it('keeps the engine defaults themselves valid', () => {
    const errors = validateCrossFieldParams(DEFAULT_PARAMS).filter((f) => f.level === 'error');
    expect(errors).toEqual([]);
  });
});
