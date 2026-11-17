import { describe, expect, it } from 'vitest';
import { classifyCiChanges } from '../scripts/detect-ci-changes.mjs';

describe('CI changed-file release policy', () => {
  it('skips deployment and backtest for documentation-only changes', () => {
    expect(classifyCiChanges('push', 'abc', ['README.md', 'docs/strategy-readiness-2026-11-17.md']))
      .toEqual({ deploy: false, relay: false, strategy: false });
  });

  it('deploys UI-only changes but does not run strategy evaluation', () => {
    expect(classifyCiChanges('push', 'abc', ['src/pages/Market.tsx']))
      .toEqual({ deploy: true, relay: false, strategy: false });
  });

  it('deploys and evaluates when Worker or shared strategy code changes', () => {
    expect(classifyCiChanges('push', 'abc', ['worker/src/pipeline.ts']))
      .toEqual({ deploy: true, relay: false, strategy: true });
    expect(classifyCiChanges('push', 'abc', ['shared/strategy.ts']))
      .toEqual({ deploy: true, relay: false, strategy: true });
  });

  it('marks relay source changes as relay deployments and strategy-relevant changes', () => {
    expect(classifyCiChanges('push', 'abc', ['supabase/functions/indodax-proxy/index.ts']))
      .toEqual({ deploy: false, relay: true, strategy: false });
  });

  it('selects Worker and relay deployment when the end-to-end production smoke contract changes', () => {
    expect(classifyCiChanges('push', 'abc', ['scripts/smoke-production.ts']))
      .toEqual({ deploy: true, relay: true, strategy: false });
    expect(classifyCiChanges('push', 'abc', ['scripts/smoke-relay.ts']))
      .toEqual({ deploy: false, relay: true, strategy: false });
  });

  it('runs evaluation for migrations and evaluator changes without deploying the Worker', () => {
    expect(classifyCiChanges('push', 'abc', ['supabase/migrations/20261117000100_test.sql']))
      .toEqual({ deploy: false, relay: false, strategy: true });
    expect(classifyCiChanges('push', 'abc', ['scripts/backtest-history.ts']))
      .toEqual({ deploy: false, relay: false, strategy: true });
  });

  it('treats dependency lock changes as release and strategy relevant', () => {
    expect(classifyCiChanges('push', 'abc', ['package-lock.json']))
      .toEqual({ deploy: true, relay: false, strategy: true });
  });

  it('forces all release paths for workflow_dispatch and unknown/zero bases', () => {
    const all = { deploy: true, relay: true, strategy: true };
    expect(classifyCiChanges('workflow_dispatch', '', [])).toEqual(all);
    expect(classifyCiChanges('push', '', [])).toEqual(all);
    expect(classifyCiChanges('push', '000000000000', [])).toEqual(all);
  });

  it('never gives pull requests production deployment or historical evaluation permissions', () => {
    expect(classifyCiChanges('pull_request', 'abc', [
      'worker/src/pipeline.ts',
      'supabase/functions/indodax-proxy/index.ts',
      'supabase/migrations/20261117000100_test.sql',
    ])).toEqual({ deploy: false, relay: false, strategy: false });
  });

  it('runs a complete Worker + relay release when the deployment workflow changes', () => {
    expect(classifyCiChanges('push', 'abc', ['.github/workflows/ci-deploy.yml']))
      .toEqual({ deploy: true, relay: true, strategy: false });
    expect(classifyCiChanges('push', 'abc', ['tests/relay.test.ts']))
      .toEqual({ deploy: false, relay: false, strategy: false });
  });
});
