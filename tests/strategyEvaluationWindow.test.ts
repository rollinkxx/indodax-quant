import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOW = resolve('.github/workflows/strategy-evaluation.yml');

/**
 * Contract for the evaluation window: a dispatch may widen it, the nightly run must not change. A
 * missing input or a broken expression silently falls back to 0 days, which runs the backtest with no
 * official history at all, so it is worth pinning.
 */
describe('strategy evaluation history window', () => {
  it('exposes a `days` dispatch input defaulting to the nightly window', async () => {
    const yaml = await readFile(WORKFLOW, 'utf8');

    expect(yaml).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+days:/);
    const dispatchBlock = yaml.slice(yaml.indexOf('workflow_dispatch:'), yaml.indexOf('concurrency:'));
    expect(dispatchBlock).toMatch(/default: '30'/);

    // The schedule has no inputs, so the fallback is what keeps the nightly run at 30 days.
    expect(yaml).toContain("BACKTEST_HISTORY_DAYS: ${{ github.event.inputs.days || '30' }}");
  });

  it('still runs nightly', async () => {
    const yaml = await readFile(WORKFLOW, 'utf8');
    expect(yaml).toContain("cron: '0 17 * * *'");
  });
});
