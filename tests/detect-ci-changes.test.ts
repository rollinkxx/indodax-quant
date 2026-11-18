import { describe, expect, it } from 'vitest';
import { classifyCiChanges } from '../scripts/detect-ci-changes.mjs';

describe('CI changed-file release policy', () => {
  it('skips deployment and backtest for documentation-only changes', () => {
    expect(classifyCiChanges('push', 'abc', ['README.md', 'docs/strategy-readiness-2026-11-17.md']))
      .toEqual({ deploy: false, relay: false, strategy: false, migrate: false });
  });

  it('deploys UI-only changes and synchronizes the relay signing secret without running strategy evaluation', () => {
    expect(classifyCiChanges('push', 'abc', ['src/pages/Market.tsx']))
      .toEqual({ deploy: true, relay: true, strategy: false, migrate: true });
  });

  it('deploys, synchronizes the relay, and evaluates when Worker or shared strategy code changes', () => {
    expect(classifyCiChanges('push', 'abc', ['worker/src/pipeline.ts']))
      .toEqual({ deploy: true, relay: true, strategy: true, migrate: true });
    expect(classifyCiChanges('push', 'abc', ['shared/strategy.ts']))
      .toEqual({ deploy: true, relay: true, strategy: true, migrate: true });
  });

  it('marks relay source changes as relay deployments and strategy-relevant changes', () => {
    expect(classifyCiChanges('push', 'abc', ['supabase/functions/indodax-proxy/index.ts']))
      .toEqual({ deploy: false, relay: true, strategy: false, migrate: false });
  });

  it('selects Worker and relay deployment when the end-to-end production smoke contract changes', () => {
    expect(classifyCiChanges('push', 'abc', ['scripts/smoke-production.ts']))
      .toEqual({ deploy: true, relay: true, strategy: false, migrate: true });
    expect(classifyCiChanges('push', 'abc', ['scripts/smoke-relay.ts']))
      .toEqual({ deploy: false, relay: true, strategy: false, migrate: false });
  });

  it('runs evaluation and applies migrations for migration changes without deploying the Worker', () => {
    expect(classifyCiChanges('push', 'abc', ['supabase/migrations/20261117000100_test.sql']))
      .toEqual({ deploy: false, relay: false, strategy: true, migrate: true });
    expect(classifyCiChanges('push', 'abc', ['scripts/backtest-history.ts']))
      .toEqual({ deploy: false, relay: false, strategy: true, migrate: false });
  });

  it('applies migrations when the applier or its planner changes', () => {
    expect(classifyCiChanges('push', 'abc', ['scripts/apply-migrations.ts']))
      .toEqual({ deploy: false, relay: false, strategy: false, migrate: true });
    // shared/ code is bundled into the Worker, so a planner change is also a deploy + strategy change.
    expect(classifyCiChanges('push', 'abc', ['shared/migrationPlan.ts']))
      .toEqual({ deploy: true, relay: true, strategy: true, migrate: true });
  });

  it('treats dependency lock changes as release, relay, and strategy relevant', () => {
    expect(classifyCiChanges('push', 'abc', ['package-lock.json']))
      .toEqual({ deploy: true, relay: true, strategy: true, migrate: true });
  });

  it('forces all release paths for workflow_dispatch and unknown/zero bases', () => {
    const all = { deploy: true, relay: true, strategy: true, migrate: true };
    expect(classifyCiChanges('workflow_dispatch', '', [])).toEqual(all);
    expect(classifyCiChanges('push', '', [])).toEqual(all);
    expect(classifyCiChanges('push', '000000000000', [])).toEqual(all);
  });

  it('never gives pull requests production deployment or historical evaluation permissions', () => {
    expect(classifyCiChanges('pull_request', 'abc', [
      'worker/src/pipeline.ts',
      'supabase/functions/indodax-proxy/index.ts',
      'supabase/migrations/20261117000100_test.sql',
    ])).toEqual({ deploy: false, relay: false, strategy: false, migrate: false });
  });

  it('re-synchronizes the relay when production deployment orchestration changes', () => {
    expect(classifyCiChanges('push', 'abc', ['.github/workflows/ci-deploy.yml']))
      .toEqual({ deploy: false, relay: true, strategy: false, migrate: false });
  });

  it('does not classify unrelated workflow and test edits as app, relay, or strategy changes', () => {
    expect(classifyCiChanges('push', 'abc', ['.github/workflows/live-public-ui-smoke.yml', 'tests/relay.test.ts']))
      .toEqual({ deploy: false, relay: false, strategy: false, migrate: false });
  });
});
