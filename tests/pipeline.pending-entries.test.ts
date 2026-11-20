// FIX-01: a BUY rejected by a transient gate is queued and retried while the setup still holds.
// SELL had this net (get_pending_sell_signals); BUY lost the signal permanently because a stored
// signal is only "new" in the run that saved it.
import { describe, expect, it } from 'vitest';
import { isRetryableEntryRejection, runPipeline } from '../worker/src/pipeline';
import { env } from './fakes';
import { NOW, expectedLast, setup } from './pipelineSetup';

const run = (o: ReturnType<typeof setup>) => runPipeline(env(), {
  scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000,
});

const buySignal = (over: Record<string, unknown> = {}) => ({
  id: 301, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
  indicators: { atr14: 10 }, candle_time: new Date(expectedLast * 1000).toISOString(), ...over,
});

const queued = (over: Record<string, unknown> = {}) => ({
  pair_id: 'btcidr', signal_id: 301,
  candle_time: new Date(expectedLast * 1000).toISOString(),
  expires_at: new Date((NOW + 600) * 1000).toISOString(),
  strength: 90, price: 1000, indicators: { atr14: 10 }, attempts: 0, ...over,
});

const paperInfo = (r: Awaited<ReturnType<typeof runPipeline>>) => (r.steps as any).paper_trading.info;

describe('FIX-01 pending entry retry queue', () => {
  it('T1 queues a BUY rejected by wide_spread with a TTL of entryRetryTtlCandles candles', async () => {
    // 0.11% spread against a 0.05% limit => entry_gate wide_spread.
    const o = setup({ mtfMode: 'off', wideSpread: true, newSignals: [buySignal()], strategyParams: { maxEntrySpreadPct: 0.05 } });
    const r = await run(o);

    const queuedCall = o.rpcs.find((x) => x.fn === 'upsert_pending_entries');
    expect(queuedCall).toBeTruthy();
    const entry = queuedCall!.body.p_entries[0];
    expect(entry).toMatchObject({ pair_id: 'btcidr', signal_id: 301, strength: 90, price: 1000 });
    // Default entryRetryTtlCandles = 3 => 900 s from the run that queued it (the signal candle is
    // one candle older, so the claim can never outlive the TTL counted from queue time).
    const nowMin = Math.floor(NOW / 60) * 60;
    expect(Date.parse(entry.expires_at)).toBe((nowMin + 900) * 1000);
    expect(paperInfo(r).entry_rejections).toContainEqual(expect.objectContaining({ stage: 'entry_gate', reason: 'wide_spread' }));
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
  });

  it('T2 retries a queued BUY on the next run when the quote and the setup are still good', async () => {
    const o = setup({
      mtfMode: 'off',
      newSignals: [],
      pendingEntries: [queued()],
      openResult: { ok: true, position_id: 77, cash_after: 9_700_000 },
    });
    const r = await run(o);

    const opens = o.rpcs.filter((x) => x.fn === 'paper_open_position');
    expect(opens).toHaveLength(1);
    // The retry reuses the stored signal id: paper_open_position's idempotency key stays `open:1:301`.
    expect(opens[0].body).toMatchObject({ p_signal_id: 301, p_idempotency_key: 'open:1:301' });
    expect(paperInfo(r).entries_opened).toBe(1);
    // The claim is dropped once it fills.
    expect(o.rpcs.filter((x) => x.fn === 'delete_pending_entries').some((x) => x.body.p_signal_ids.includes(301))).toBe(true);
  });

  it('T3 drops a queued BUY whose trend setup broke (EMA9 back below EMA21)', async () => {
    const o = setup({
      mtfMode: 'off',
      newSignals: [],
      pendingEntries: [queued()],
      // Descending closes invert the EMA stack: setup_valid is false in the fresh diagnostics.
      candleClose: (i) => 2000 - i,
    });
    const r = await run(o);
    expect(r.status).toBe('SUCCESS');
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const deletes = o.rpcs.filter((x) => x.fn === 'delete_pending_entries');
    expect(deletes.some((x) => x.body.p_signal_ids.includes(301))).toBe(true);
  });

  it('T4 never executes a claim that already expired', async () => {
    const o = setup({
      mtfMode: 'off',
      newSignals: [],
      pendingEntries: [queued({ expires_at: new Date((NOW - 60) * 1000).toISOString() })],
    });
    await run(o);
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
  });

  it('T5 does not queue a BUY rejected by the structural economics gate', async () => {
    // 1.6x take profit against a 1.5x stop cannot clear a 1.0 net reward/risk floor.
    const o = setup({
      mtfMode: 'off',
      newSignals: [buySignal()],
      strategyParams: { atrTakeProfitMultiplier: 1.6, atrStopMultiplier: 1.5, minNetRewardRiskRatio: 1 },
    });
    const r = await run(o);
    expect(paperInfo(r).entry_rejections).toContainEqual(expect.objectContaining({ stage: 'economics_gate' }));
    expect(o.rpcs.some((x) => x.fn === 'upsert_pending_entries')).toBe(false);
  });

  it('a missing queue RPC degrades the run instead of failing the entries step', async () => {
    const o = setup({ mtfMode: 'off', newSignals: [], pendingEntriesError: 'Could not find the function' });
    const r = await run(o);
    expect(r.status).not.toBe('FAILED');
    expect(paperInfo(r).degraded.join()).toMatch(/pending entry lookup failed/);
  });

  it('classifies stages: quote and portfolio rejections retry, structural ones do not', () => {
    expect(isRetryableEntryRejection('entry_gate', 'wide_spread')).toBe(true);
    expect(isRetryableEntryRejection('market_data_gate', 'stale_ticker')).toBe(true);
    expect(isRetryableEntryRejection('sizing_gate', 'insufficient_cash')).toBe(true);
    expect(isRetryableEntryRejection('lease_gate', 'lease_lost')).toBe(true);
    expect(isRetryableEntryRejection('portfolio_gate', 'max_positions')).toBe(true);
    expect(isRetryableEntryRejection('portfolio_gate', 'already_open')).toBe(false);
    expect(isRetryableEntryRejection('economics_gate', 'net_reward_risk_below_minimum')).toBe(false);
    expect(isRetryableEntryRejection('fee_gate', 'missing_pair_fee')).toBe(false);
    expect(isRetryableEntryRejection('strategy_params_gate', 'invalid_strategy_params')).toBe(false);
  });
});
