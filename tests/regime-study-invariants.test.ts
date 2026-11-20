// Pins the two properties that make scripts/regime-study.ts trustworthy. The study's whole value is
// that its trades are non-overlapping and costed; if either invariant regresses, every number it
// prints becomes an overstatement and nobody would notice from the output alone.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('scripts/regime-study.ts', 'utf8');

describe('regime study invariants', () => {
  it('charges the real round-trip cost instead of a round number', () => {
    expect(source).toContain('roundTripCostPct(FEE_PCT, SLIP_BPS)');
    expect(source).toMatch(/FEE_PCT = 0\.2\b/);
    expect(source).toMatch(/SLIP_BPS = 10\b/);
  });

  it('advances past the exit so trades never overlap', () => {
    // Overlapping trades reuse the same forward bars and inflate the mean; this is the one line that
    // prevents it. A refactor to `i++` here would silently reintroduce the bias.
    expect(source).toMatch(/i = exitIdx \+ 1;/);
    expect(source).toContain('no overlap');
  });

  it('takes the pessimistic exit when a bar spans both stop and target', () => {
    const stopAt = source.indexOf("reason = 'STOP_LOSS'");
    const tpAt = source.indexOf("reason = 'TAKE_PROFIT'");
    expect(stopAt).toBeGreaterThan(0);
    expect(tpAt).toBeGreaterThan(stopAt);
  });

  it('reports the three chronological thirds so one regime cannot carry the result', () => {
    expect(source).toContain('thirds=[');
    expect(source).toMatch(/const third = Math\.max\(1, Math\.floor\(trades\.length \/ 3\)\)/);
  });

  it('derives the sample from stored history, not the live universe', () => {
    // Reading the live universe would drop pairs that traded during the sample and have since been
    // delisted, which is survivorship bias. The pair list must be a literal.
    expect(source).toContain('const PAIRS = [');
    expect(source).not.toMatch(/market_pairs\?select=id/);
  });
});
