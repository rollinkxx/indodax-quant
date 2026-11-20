import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleApi } from '../worker/src/api';
import { clearAuthCache } from '../worker/src/auth';
import { buildEngineDecisions, isStructuralRejection } from '../shared/engineDecisions';
import { appUsersHandler, authHandler, env, fakeFetch, json } from './fakes';

const req = (path: string, token?: string) =>
  new Request(`https://app.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

// A trimmed but faithful copy of a real `execution_logs.steps` shape.
const analyzeStep = {
  ok: true,
  ms: 1554,
  info: {
    new_signals: 0,
    buy_diagnostics: {
      btcidr: {
        stage: 'no_recent_cross',
        candidate_5m: false,
        bars_since_cross: 7,
        filters: { trend: false, rsi: true, volume: false, extension: true },
        metrics: { rsi: 53.23, volume_ratio: 0.41, extension_pct: 0.3 },
        data_quality: 'ok',
        mtf: '15m:bear 1h:bear',
        outcome: 'no_recent_cross',
        raw_signal_side: null,
        raw_market_action: 'HOLD',
        market_action: 'HOLD',
        hold_reason: 'no_signal',
        mtf_block: null,
      },
      cstidr: {
        stage: 'no_recent_cross',
        candidate_5m: false,
        filters: { trend: true, rsi: false, volume: true, extension: false },
        metrics: { rsi: 70.79, volume_ratio: 1.9, extension_pct: 2.1 },
        data_quality: 'ok',
        mtf: '15m:bull 1h:bull',
        outcome: 'blocked_by_mtf',
        mtf_block: 'mtf_against_trend',
      },
    },
    mtf_blocked: { cstidr: 'BUY mtf_against_trend' },
    quality: { btcidr: 'ok', cstidr: 'ok' },
  },
};

const paperStep = {
  ok: true,
  ms: 320,
  info: {
    status: 'RUNNING',
    equity: 9870306.81,
    drawdown: 1.3,
    open: 1,
    buy_signals_received: 2,
    entries_opened: 0,
    entry_rejections: [
      { pair_id: 'cstidr', signal_id: 55, stage: 'economics', reason: 'net_reward_risk_below_minimum', metrics: { net_reward_risk: 0.8 } },
    ],
    entry_rejection_counts: { net_reward_risk_below_minimum: 1 },
    risk_block_reasons: [],
    actions: ['skip cstidr: net_reward_risk_below_minimum'],
    degraded: [],
  },
};

const row = { id: 7999, status: 'SUCCESS', scheduled_time: '2026-11-18T18:22:00+00:00', started_at: '2026-11-18T18:22:01+00:00', analyze: analyzeStep, paper: paperStep };

describe('buildEngineDecisions', () => {
  it('flattens pair diagnostics, MTF blocks and entry rejections', () => {
    const d = buildEngineDecisions(row);
    expect(d.status).toBe('SUCCESS');
    expect(d.accountStatus).toBe('RUNNING');
    expect(d.pairs.map((p) => p.pairId)).toEqual(['btcidr', 'cstidr']);

    const btc = d.pairs[0];
    expect(btc).toMatchObject({ stage: 'no_recent_cross', candidate: false, mtf: '15m:bear 1h:bear', outcome: 'no_recent_cross' });
    expect(btc.filters).toEqual({ trend: false, rsi: true, volume: false, extension: true });
    expect(btc.metrics.rsi).toBeCloseTo(53.23);
    expect(btc.barsSinceCross).toBe(7);

    const cst = d.pairs[1];
    expect(cst.outcome).toBe('blocked_by_mtf');
    expect(cst.mtfBlock).toBe('mtf_against_trend');

    expect(d.stageCounts).toEqual({ no_recent_cross: 2 });
    expect(d.mtfBlocked).toEqual({ cstidr: 'BUY mtf_against_trend' });
    expect(d.entryRejections).toHaveLength(1);
    expect(d.entryRejections[0]).toMatchObject({ pairId: 'cstidr', signalId: 55, reason: 'net_reward_risk_below_minimum' });
    expect(d.entryRejectionCounts).toEqual({ net_reward_risk_below_minimum: 1 });
    expect(d.entriesOpened).toBe(0);
    expect(d.buySignalsReceived).toBe(2);
    expect(d.equity).toBeCloseTo(9870306.81);
  });

  it('accepts a step selected as its info object directly (no wrapper)', () => {
    const d = buildEngineDecisions({ id: 1, status: 'SUCCESS', scheduled_time: 'x', analyze: analyzeStep.info, paper: paperStep.info });
    expect(d.pairs).toHaveLength(2);
    expect(d.entryRejections).toHaveLength(1);
  });

  it('is resilient to missing steps and malformed rows', () => {
    const empty = buildEngineDecisions({ id: 5, status: 'FAILED', scheduled_time: 't' });
    expect(empty.pairs).toEqual([]);
    expect(empty.stageCounts).toEqual({});
    expect(empty.entryRejections).toEqual([]);
    expect(empty.buySignalsReceived).toBe(0);
    // Non-object input must not throw.
    expect(buildEngineDecisions(null).pairs).toEqual([]);
    expect(buildEngineDecisions('nonsense').status).toBeNull();
  });

  it('drops entry rejections without a pair_id or reason and ignores non-numeric metrics', () => {
    const d = buildEngineDecisions({
      analyze: analyzeStep,
      paper: { info: { entry_rejections: [{ stage: 'x' }, { pair_id: 'a', reason: 'r', metrics: { good: 1, bad: 'no' } }] } },
    });
    expect(d.entryRejections).toHaveLength(1);
    expect(d.entryRejections[0].metrics).toEqual({ good: 1 });
  });
});

describe('GET /api/engine-decisions', () => {
  beforeEach(() => clearAuthCache());

  const logsHandler = (rows: unknown[]) => (u: URL) => {
    if (u.pathname !== '/rest/v1/execution_logs') return;
    // The endpoint must select only the two step objects, not `select=*`.
    expect(u.searchParams.get('select')).toContain('steps->analyze');
    return json(rows);
  };

  it('requires authentication', async () => {
    const f = fakeFetch([authHandler, appUsersHandler]);
    const res = await handleApi(req('/api/engine-decisions'), env(), f);
    expect(res.status).toBe(401);
  });

  it('returns the latest run view model for an authenticated viewer', async () => {
    const f = fakeFetch([authHandler, appUsersHandler, logsHandler([row])]);
    const res = await handleApi(req('/api/engine-decisions', 'viewer'), env(), f);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.liveTrading).toBe(false);
    expect(body.latest.id).toBe(7999);
    expect(body.latest.pairs).toHaveLength(2);
    expect(body.runs).toHaveLength(1);
    expect(body.latest.entryRejections[0].reason).toBe('net_reward_risk_below_minimum');
  });

  it('returns latest=null when there are no runs', async () => {
    const f = fakeFetch([authHandler, appUsersHandler, logsHandler([])]);
    const res = await handleApi(req('/api/engine-decisions', 'viewer'), env(), f);
    const body = (await res.json()) as any;
    expect(body.latest).toBeNull();
    expect(body.runs).toEqual([]);
  });

  it('clamps the limit parameter and queries PostgREST accordingly', async () => {
    let seen = '';
    const f = fakeFetch([authHandler, appUsersHandler, (u: URL) => {
      if (u.pathname !== '/rest/v1/execution_logs') return;
      seen = u.searchParams.get('limit') ?? '';
      return json([]);
    }]);
    await handleApi(req('/api/engine-decisions?limit=999', 'viewer'), env(), f);
    expect(seen).toBe('24');
  });
});

describe('structural rejections (WP1g)', () => {
  it('separates unusable inputs from the strategy declining to trade', () => {
    const d = buildEngineDecisions({
      paper: {
        info: {
          buy_signals_received: 3,
          entries_opened: 0,
          entry_rejections: [
            { pair_id: 'a', stage: 'fee_gate', reason: 'missing_pair_fee' },
            { pair_id: 'b', stage: 'market_data_gate', reason: 'stale_ticker' },
            { pair_id: 'c', stage: 'economics_gate', reason: 'net_reward_non_positive' },
          ],
          entry_rejection_counts: { missing_pair_fee: 1, stale_ticker: 1, net_reward_non_positive: 1 },
        },
      },
    });
    expect(d.structuralRejections).toBe(2);
    expect(d.structurallyBlocked).toBe(true);
  });

  it('reports a normal filtered run as NOT structurally blocked', () => {
    const d = buildEngineDecisions({
      paper: {
        info: {
          entry_rejections: [{ pair_id: 'c', stage: 'economics_gate', reason: 'net_reward_non_positive' }],
        },
      },
    });
    expect(d.structuralRejections).toBe(0);
    expect(d.structurallyBlocked).toBe(false);
  });

  it('prefers the count recorded by the pipeline over re-deriving it', () => {
    const d = buildEngineDecisions({
      paper: {
        info: {
          structural_rejections: 7,
          entry_rejections: [{ pair_id: 'a', stage: 'fee_gate', reason: 'missing_pair_fee' }],
        },
      },
    });
    expect(d.structuralRejections).toBe(7);
  });
});

describe('structural rejection reason set matches what the pipeline emits', () => {
  // Read the real call sites instead of restating them: a hardcoded copy of this list can never
  // notice a gate added later, which is exactly how the original list drifted out of sync.
  const source = readFileSync(resolve(process.cwd(), 'worker/src/pipeline.ts'), 'utf8');
  const calls = [...source.matchAll(/rejectEntry\(\w+, '([^']+)', ([^,)]+)/g)]
    .map((m) => ({ stage: m[1], arg: m[2].trim() }));
  // Reasons that are a literal at the call site; the rest are computed by a callee and covered by
  // the explicit cases below.
  const literal = calls
    .map((c) => ({ ...c, reason: /^'([^']+)'$/.exec(c.arg)?.[1] }))
    .filter((c): c is { stage: string; arg: string; reason: string } => c.reason !== undefined);

  it('finds the literal call sites (guards against the regex silently matching nothing)', () => {
    expect(literal.length).toBeGreaterThanOrEqual(4);
    expect(literal.map((c) => c.reason)).toEqual(expect.arrayContaining(['max_positions', 'already_open', 'stale_ticker', 'max_total_exposure']));
  });

  it.each(literal.map((c) => [c.stage, c.reason] as const))('%s / %s is classified correctly', (stage, reason) => {
    const d = buildEngineDecisions({ paper: { info: { entry_rejections: [{ pair_id: 'a', stage, reason }] } } });
    // A structural reason must land in the bucket; a healthy one must stay out of it.
    expect(d.structuralRejections).toBe(isStructuralRejection(reason) ? 1 : 0);
  });

  it('classifies every reason a callee can return at a structural gate', () => {
    // entryFeePct -> missing_pair_fee; netRewardRiskDiagnostics -> invalid_reward_risk_inputs;
    // positionSize -> invalid_inputs/invalid_stop; paper_open_position -> invalid_order.
    const fromCallees: [string, string][] = [
      ['fee_gate', 'missing_pair_fee'],
      ['economics_gate', 'invalid_reward_risk_inputs'],
      ['sizing_gate', 'invalid_inputs'],
      ['sizing_gate', 'invalid_stop'],
      ['persistence', 'invalid_order'],
      // The guarded open helper reports a thrown RPC as its own reason.
      ['persistence', 'paper_open_failed'],
      ['stop_out_of_bounds', 'stop_out_of_bounds'],
    ];
    for (const [stage, reason] of fromCallees) {
      const d = buildEngineDecisions({ paper: { info: { entry_rejections: [{ pair_id: 'a', stage, reason }] } } });
      expect(d.structuralRejections, `${stage}/${reason}`).toBe(1);
    }
  });

  it('keeps healthy filtering out of the structural bucket', () => {
    const healthy = ['wide_spread', 'price_drift', 'stop_inside_spread', 'net_reward_risk_below_minimum',
      'net_reward_non_positive', 'below_min_notional', 'insufficient_cash', 'max_positions',
      'max_total_exposure', 'already_open'];
    const d = buildEngineDecisions({
      paper: { info: { entry_rejections: healthy.map((reason, i) => ({ pair_id: `p${i}`, stage: 'gate', reason })) } },
    });
    expect(d.structuralRejections).toBe(0);
    expect(d.structurallyBlocked).toBe(false);
  });
});
