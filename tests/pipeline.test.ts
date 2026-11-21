// End-to-end pipeline run against fake Supabase RPCs + fake INDODAX: dynamic universe, HTF backfill and MTF wiring.
import { describe, expect, it } from 'vitest';
import { CRON_INTERVAL_SECONDS, HISTORY_BACKFILL_PER_RUN, LEASE_TTL_SECONDS, MIN_LEASE_MARGIN_SECONDS, TRADE_FETCH_PER_RUN, leaseFitsCron, rotateWindow, rotationOffset, runPipeline, universeExceedsCapacity } from '../worker/src/pipeline';
import { env } from './fakes';

import { NOW, expectedLast, setup } from './pipelineSetup';

describe('universeExceedsCapacity', () => {
  it('accepts a universe that fits the per-run trade budget', () => {
    expect(universeExceedsCapacity(TRADE_FETCH_PER_RUN)).toBe(false);
    expect(universeExceedsCapacity(TRADE_FETCH_PER_RUN - 1)).toBe(false);
  });

  it('flags a universe larger than one run can serve', () => {
    expect(universeExceedsCapacity(TRADE_FETCH_PER_RUN + 1)).toBe(true);
    expect(universeExceedsCapacity(25)).toBe(true);
  });

  it('respects an explicit capacity override', () => {
    expect(universeExceedsCapacity(25, 30)).toBe(false);
    expect(universeExceedsCapacity(25, 20)).toBe(true);
  });

  it('treats non-finite input as within capacity instead of crashing', () => {
    expect(universeExceedsCapacity(Number.NaN)).toBe(false);
  });
});

describe('pipeline: MTF + dynamic universe', () => {
  it('selects the universe, backfills 15m/1h history once, analyses higher timeframes', async () => {
    const { f, rpcs, indodax } = setup();
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });
    expect(r.errors).toEqual([]);
    expect(r.status).toBe('SUCCESS');

    // universe: btcidr is pinned, usdtidr excluded (stablecoin), pepeidr + dogeidr ranked by volume
    const su = rpcs.find((x) => x.fn === 'set_universe');
    expect(su?.body.p_members).toEqual([{ id: 'pepeidr', rank: 1 }, { id: 'dogeidr', rank: 2 }]);
    const note = rpcs.find((x) => x.fn === 'claim_notifications')?.body.p_items.find((i: any) => i.event_type === 'universe');
    expect(note?.message).toContain('PEPE/IDR');

    // 1m history fills the uncovered tail through the latest completed minute.
    const oneMinute = indodax.filter((p) => p.startsWith('/tradingview/history_v2') && new URLSearchParams(p.split('?')[1]).get('tf') === '1');
    expect(oneMinute).toHaveLength(1);
    expect(Number(new URLSearchParams(oneMinute[0].split('?')[1]).get('to'))).toBe(Math.floor(NOW / 60) * 60 - 1);

    // One-time HTF history backfill: 15m and 1h, forming bucket dropped, marker set in sync state.
    expect(indodax.filter((p) => p.startsWith('/tradingview/history_v2')).map((p) => new URLSearchParams(p.split('?')[1]).get('tf')).filter((tf) => tf !== '1')).toEqual(['15', '60']);
    const ingest = rpcs.find((x) => x.fn === 'ingest_market')!.body;
    const htf = ingest.p_candles.filter((c: any) => c.timeframe === '15m' || c.timeframe === '1h');
    expect(htf.length).toBe(78); // one forming 15m and one forming 1h bar are discarded
    expect(htf.every((c: any) => c.source === 'history' && Date.parse(c.open_time) / 1000 + (c.timeframe === '1h' ? 3600 : 900) <= NOW)).toBe(true);
    expect(ingest.p_sync).toHaveLength(1);
    expect(ingest.p_sync[0].htf_backfilled_at).toBeTruthy();

    // analysis: stored + aggregated higher timeframes, indicator rows per timeframe, persisted aggregates
    const save = rpcs.find((x) => x.fn === 'save_analysis')!.body;
    expect(new Set(save.p_indicators.map((i: any) => i.timeframe))).toEqual(new Set(['5m', '15m', '1h']));
    expect(save.p_candles.filter((c: any) => c.timeframe === '15m')).toHaveLength(4);
    expect(save.p_candles.filter((c: any) => c.timeframe === '1h')).toHaveLength(2);
    const steps = r.steps as any;
    expect(steps.analyze.info.mtf.btcidr).toMatch(/15m:\w+ 1h:\w+/);
    expect(steps.analyze.info.buy_diagnostics.btcidr).toMatchObject({
      stage: 'no_recent_cross',
      candidate_5m: false,
      data_quality: 'ok',
      outcome: 'no_recent_cross',
    });
    expect(steps.analyze.info.continuation_diagnostics.btcidr).toMatchObject({
      setup: 'ema21_pullback_reclaim',
      execution: 'shadow_only',
      data_quality: 'ok',
    });
    expect(steps.universe.info.members).toEqual(['pepeidr', 'dogeidr']);
  });

  it('rejects a BUY whose take profit cannot pay for the round trip (feasibility gate)', async () => {
    const signal = {
      id: 99, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 2.866 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    // 1.6xATR target on a 0.2866% ATR is ~0.46% gross, below the 0.6% round-trip cost. The bracket
    // stays legal (1.6 > the 1.5 stop) so this is a feasibility rejection, not a params one.
    const { f, rpcs } = setup({ mtfMode: 'off', strategyParams: { atrTakeProfitMultiplier: 1.6 }, newSignals: [signal] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const paperInfo = (r.steps as any)?.paper_trading?.info;
    const actions = paperInfo.actions as string[];
    // The gate states the shortfall in percentage points, not as a ratio.
    expect(actions).toContain('skip btcidr: target_below_round_trip_cost');
    expect(paperInfo).toMatchObject({ buy_signals_received: 1, entries_opened: 0 });
    expect(paperInfo.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 99, stage: 'feasibility_gate', reason: 'target_below_round_trip_cost',
    }));
    expect(paperInfo.entry_rejection_counts.target_below_round_trip_cost).toBe(1);
    const metrics = paperInfo.entry_rejections[0].metrics;
    expect(metrics.net_target_pct).toBeLessThan(0);
    expect(metrics.round_trip_cost_pct).toBeCloseTo(0.6, 10);
    expect(metrics.gross_target_pct).toBeGreaterThan(0.4);
    expect(metrics.gross_target_pct).toBeLessThan(metrics.round_trip_cost_pct);
    expect(metrics.min_net_target_pct).toBe(0.1);
    expect(metrics.target_price).toBeGreaterThan(metrics.entry_price);
    // A bracket that cannot pay never pays later: the claim must be dropped, not retried.
    expect(rpcs.some((x) => x.fn === 'upsert_pending_entries')).toBe(false);
    expect(paperInfo.decision_counters.reward_risk_block_count).toBe(1);
  });

  it('skips a BUY when net take-profit reward does not cover net stop risk', async () => {
    const signal = {
      id: 98, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 2.866 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    // Feasible target (1.00% gross > 0.6% round trip) on a 0.86% stop: the economics gate behind
    // the feasibility one still refuses it, because the reward does not cover the risk.
    const { f, rpcs } = setup({ mtfMode: 'off', strategyParams: { atrStopMultiplier: 3, atrTakeProfitMultiplier: 3.5 }, newSignals: [signal] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const paperInfo = (r.steps as any)?.paper_trading?.info;
    expect(paperInfo.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 98, stage: 'economics_gate', reason: 'net_reward_risk_below_minimum',
    }));
    expect(paperInfo.entry_rejections[0].metrics.net_reward_risk_ratio).toBeLessThan(1);
    expect(paperInfo.entry_rejections[0].metrics.net_reward_per_unit).toBeDefined();
    expect(paperInfo.entry_rejections[0].metrics.net_risk_per_unit).toBeDefined();
  });


  it('records spread-versus-stop rejection metrics without opening a paper position', async () => {
    const signal = {
      id: 100, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 1.335 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const { f, rpcs } = setup({ mtfMode: 'off', newSignals: [signal], wideSpread: true });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });
    expect(r.status).toBe('SUCCESS');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const info = (r.steps as any)?.paper_trading?.info;
    expect(info.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 100, stage: 'entry_gate', reason: 'stop_inside_spread',
    }));
    expect(info.entry_rejections[0].metrics.spread_pct).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.stop_distance_pct).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.entry_price).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.bid_price).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.ask_price).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.spread_to_stop_pct).toBeGreaterThan(0);
    expect(info.entry_rejections[0].metrics.target_distance_pct).toBeGreaterThan(0);
  });

  it('records exhausted upstream 503 failures and keeps that pair fail-closed', async () => {
    const { f, rpcs } = setup({ failedTradePair: 'btcidr' });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('PARTIAL');
    const fetchInfo = (r.steps as any).fetch_trades.info;
    expect(fetchInfo.failures.btcidr).toMatchObject({
      http_status: 503,
      failure_class: 'upstream_service_degraded',
      retryable: true,
      attempts: 3,
    });
    expect((r.steps as any).build_candles.info.btcidr).toBe('no_trades_fetch');
    const ingest = rpcs.find((x) => x.fn === 'ingest_market')!.body;
    expect(ingest.p_trades).toEqual([]);
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
  });

  it('repairs legacy 5m holes although the old covered_until cursor is already current', async () => {
    const gapIndex = 220;
    const { f, indodax, rpcs } = setup({ oldGap5mAt: gapIndex });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.errors).toEqual([]);
    expect(r.status).toBe('SUCCESS');
    const oneMinute = indodax.filter((p) => p.startsWith('/tradingview/history_v2') && new URLSearchParams(p.split('?')[1]).get('tf') === '1');
    expect(oneMinute).toHaveLength(1);
    const firstGap = expectedLast - (249 - gapIndex) * 300;
    const minimumWindowStart = expectedLast - (60 + 2) * 300;
    const expectedRecoveryStart = Math.min(firstGap, minimumWindowStart);
    expect(Number(new URLSearchParams(oneMinute[0].split('?')[1]).get('from'))).toBe(expectedRecoveryStart);
    const info = (r.steps as any).build_candles.info.btcidr;
    expect(info.recovery_from).toBe(expectedRecoveryStart);
    expect(info.history_complete).toBe(true);
    expect(rpcs.some((x) => x.fn === 'save_analysis')).toBe(true);
  });

  it('does not mark HTF backfill complete when the API returns only a partial contiguous history', async () => {
    // Even a legacy non-null marker is not trusted when the actual 1h suffix is still short.
    const { f, rpcs, indodax } = setup({ htfBackfilled: true, htfHistoryBars: 5 });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(indodax.filter((p) => p.startsWith('/tradingview/history_v2')).map((p) => new URLSearchParams(p.split('?')[1]).get('tf')).filter((tf) => tf !== '1')).toEqual(['15', '60']);
    const ingest = rpcs.find((x) => x.fn === 'ingest_market')!.body;
    expect(ingest.p_sync[0].htf_backfilled_at).toBeNull();
    expect((r.steps as any).backfill_htf.info.btcidr.ready).toBe(false);
    expect((r.steps as any).backfill_htf.info.btcidr.timeframes['1h'].contiguous).toBe(4); // final 1h candle is still forming
  });

  it('skips the backfill once done and skips higher timeframes when MTF is off', async () => {
    const done = setup({ htfBackfilled: true, htfCoverageReady: true });
    await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: done.f, now: () => NOW * 1000 });
    const htfCalls = (list: string[]) => list.filter((p) => p.startsWith('/tradingview') && !p.includes('tf=1&'));
    expect(htfCalls(done.indodax)).toEqual([]);

    const off = setup({ mtfMode: 'off' });
    await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: off.f, now: () => NOW * 1000 });
    expect(off.rpcs.some((x) => x.fn === 'get_recent_candles_multi')).toBe(false);
    expect(htfCalls(off.indodax)).toEqual([]);
    const save = off.rpcs.find((x) => x.fn === 'save_analysis')!.body;
    expect(save.p_candles).toEqual([]);
  });
});

describe('pipeline: paper-only BUY / HOLD execution contract', () => {
  const run = (o: ReturnType<typeof setup>) => runPipeline(env(), {
    scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000,
  });

  it('opens a simulated paper position for an accepted BUY and never calls a private INDODAX endpoint', async () => {
    const signal = {
      id: 201, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 10 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({
      mtfMode: 'off',
      newSignals: [signal],
      openResult: { ok: true, position_id: 55, cash_after: 9_700_000 },
    });
    const result = await run(o);
    expect(result.status).toBe('SUCCESS');
    const opens = o.rpcs.filter((x) => x.fn === 'paper_open_position');
    expect(opens).toHaveLength(1);
    expect(opens[0].body).toMatchObject({
      p_account_id: 1, p_pair_id: 'btcidr', p_signal_id: 201,
      p_idempotency_key: 'open:1:201', p_reason: 'SIGNAL',
    });
    expect((result.steps as any).paper_trading.info).toMatchObject({
      buy_signals_received: 1, entries_opened: 1, open: 1,
    });
    expect(o.indodax.every((path) => !/\/api\/(private|order|orders)(\/|$)/i.test(path))).toBe(true);
  });

  it('persists the normalized order, not the requested one, when precision rounds it down', async () => {
    // price_precision 0 makes normalizePrice round the 1000.x fill to a whole rupiah, and the 8dp qty
    // step rounds the quantity down. The stored position and the RPC payload must agree with each
    // other, otherwise in-memory exposure/MTM drifts from the database for the rest of the cycle.
    const signal = {
      id: 202, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 10 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({ mtfMode: 'off', newSignals: [signal], pairPricePrecision: 0, tickerBid: 1000 });
    const result = await run(o);
    expect(result.status).toBe('SUCCESS');
    const opens = o.rpcs.filter((x) => x.fn === 'paper_open_position');
    expect(opens).toHaveLength(1);
    const body = opens[0].body;
    expect(Number.isInteger(body.p_fill_price)).toBe(true);
    // The fee must be charged on the normalized notional, not on the pre-rounding size.
    expect(body.p_fee).toBeCloseTo(body.p_qty * body.p_fill_price * 0.002, 6);
    const entry = (result.steps as any).paper_trading.info.opened_entries[0];
    expect(entry.qty).toBe(body.p_qty);
    expect(entry.fill_price).toBe(body.p_fill_price);
    expect(entry.notional).toBeCloseTo(body.p_qty * body.p_fill_price, 6);
    expect(entry.fee).toBeCloseTo(body.p_fee, 6);
  });

  it('keeps HOLD cycles idle: no simulated order is opened or closed', async () => {
    const o = setup({ mtfMode: 'off', newSignals: [] });
    const result = await run(o);
    expect(result.status).toBe('SUCCESS');
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    expect(o.rpcs.some((x) => x.fn === 'paper_close_position')).toBe(false);
    expect((result.steps as any).paper_trading.info).toMatchObject({
      buy_signals_received: 0, entries_opened: 0,
    });
  });

  it('charges the pair taker fee when feeModel=pair_taker', async () => {
    const signal = {
      id: 202, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 8 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({
      mtfMode: 'off', newSignals: [signal], pairTakerFee: 0.2,
      strategyParams: { feeModel: 'pair_taker', crossLookback: 2 },
      openResult: { ok: true, position_id: 56, cash_after: 9_700_000 },
    });
    const result = await run(o);
    expect(result.status).toBe('SUCCESS');
    const opens = o.rpcs.filter((x) => x.fn === 'paper_open_position');
    expect(opens).toHaveLength(1);
    // fill = ask(1000) + 10bps = 1001; sizing caps at 25% of 1e7 equity -> notional ~2.5M; fee = 2.5M * 0.2% = 5000
    expect(opens[0].body.p_fee).toBeCloseTo(5000, 2);
  });

  it('rejects an entry the legacy fee assumption would have approved when the real taker fee applies', async () => {
    const signal = {
      id: 203, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 3 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const assumption = setup({ mtfMode: 'off', newSignals: [signal], strategyParams: { feeModel: 'assumption', feePct: 0.00555 }, openResult: { ok: true, position_id: 57, cash_after: 9_700_000 } });
    await run(assumption);
    expect(assumption.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(true);

    const taker = setup({ mtfMode: 'off', newSignals: [signal], pairTakerFee: 0.2, strategyParams: { feeModel: 'pair_taker' } });
    const rt = await run(taker);
    expect(taker.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    expect((rt.steps as any).paper_trading.info.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 203, stage: 'economics_gate', reason: 'net_reward_risk_below_minimum',
    }));
  });

  it('charges the pair maker fee and no tax on the entry when feeModel=pair_maker', async () => {
    const signal = {
      id: 205, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 8 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const runModel = async (feeModel: 'pair_taker' | 'pair_maker') => {
      const o = setup({
        mtfMode: 'off', newSignals: [signal], pairTakerFee: 0.2, pairMakerFee: 0.1,
        strategyParams: { feeModel, crossLookback: 2 },
        openResult: { ok: true, position_id: 58, cash_after: 9_700_000 },
      });
      const result = await run(o);
      expect(result.status).toBe('SUCCESS');
      const open = o.rpcs.find((x) => x.fn === 'paper_open_position');
      expect(open).toBeDefined();
      const notional = open!.body.p_qty * open!.body.p_fill_price;
      return { fee: open!.body.p_fee, rate: open!.body.p_fee / notional * 100 };
    };
    const taker = await runModel('pair_taker');
    const maker = await runModel('pair_maker');
    expect(taker.rate).toBeCloseTo(0.2, 4);
    // 0.1% per side: the tax is a closing-leg charge and must not appear on the entry.
    expect(maker.rate).toBeCloseTo(0.1, 4);
  });

  it('rejects an entry under pair_maker when the maker fee is missing, instead of falling back', async () => {
    const signal = {
      id: 206, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 8 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({ mtfMode: 'off', newSignals: [signal], pairMakerFee: null, strategyParams: { feeModel: 'pair_maker' } });
    const result = await run(o);
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    expect((result.steps as any).paper_trading.info.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 206, stage: 'fee_gate', reason: 'missing_pair_fee',
    }));
  });

  it('rejects an entry under pair_taker when the pair taker fee is missing, instead of falling back', async () => {
    const signal = {
      id: 204, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 8 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({ mtfMode: 'off', newSignals: [signal], pairTakerFee: null, strategyParams: { feeModel: 'pair_taker' } });
    const result = await run(o);
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    expect((result.steps as any).paper_trading.info.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 204, stage: 'fee_gate', reason: 'missing_pair_fee',
    }));
  });
});

describe('pipeline: persisted SELL exits (F3)', () => {
  const run = (o: ReturnType<typeof setup>) => runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });
  const position = { id: 5, pair_id: 'btcidr', qty: 1, entry_price: 1000, cost_basis: 1000, stop_loss: 500, take_profit: 5000, opened_at: new Date((NOW - 600) * 1000).toISOString() };
  const sell = { id: 41, pair_id: 'btcidr', side: 'SELL', price: 1000, strength: 60, reasons: ['test'], indicators: {}, candle_time: new Date(expectedLast * 1000).toISOString() };
  const closes = (o: ReturnType<typeof setup>) => o.rpcs.filter((x) => x.fn === 'paper_close_position');

  it('charges the sell-side tax once on the close, and never on the entry, under pair_maker', async () => {
    const stopped = { ...position, id: 6, qty: 1000, entry_price: 1100, cost_basis: 1_100_000, stop_loss: 1001, take_profit: 5000 };
    const runClose = async (feeModel: 'pair_taker' | 'pair_maker') => {
      const o = setup({
        mtfMode: 'off', openPositions: [stopped], strategyParams: { feeModel, crossLookback: 2 },
        pairTakerFee: 0.2, pairMakerFee: 0.1,
      });
      const result = await run(o);
      expect(result.status).toBe('SUCCESS');
      const closed = closes(o);
      expect(closed).toHaveLength(1);
      expect(closed[0].body.p_reason).toBe('STOP_LOSS');
      return closed[0].body.p_fee / (stopped.qty * closed[0].body.p_fill_price) * 100;
    };
    expect(await runClose('pair_taker')).toBeCloseTo(0.2, 4);
    // 0.1% maker + 0.21% PPh, charged once on the closing leg.
    expect(await runClose('pair_maker')).toBeCloseTo(0.31, 4);
  });

  it('closes with SIGNAL on a later run even though save_analysis returns no new signals', async () => {
    // Run 1: SELL is saved as new, but the ticker is stale so the exit check is skipped.
    const run1 = setup({ mtfMode: 'off', openPositions: [position], newSignals: [sell], staleTicker: true });
    await run(run1);
    expect(closes(run1)).toHaveLength(0);

    // Run 2: ticker fresh, ON CONFLICT DO NOTHING means no new signals, the stored SELL is still pending.
    const run2 = setup({ mtfMode: 'off', openPositions: [position], newSignals: [], pendingSells: [sell], tickerBid: 1010 });
    const r = await run(run2);
    expect(r.status).toBe('SUCCESS');
    expect(run2.rpcs.find((x) => x.fn === 'get_pending_sell_signals')!.body).toEqual({ p_pairs: ['btcidr'] });
    expect(closes(run2)).toHaveLength(1);
    expect(closes(run2)[0].body).toMatchObject({ p_position_id: 5, p_reason: 'SIGNAL' });
  });

  it('closes once when the SELL is both new and pending', async () => {
    const o = setup({ mtfMode: 'off', openPositions: [position], newSignals: [sell], pendingSells: [sell], tickerBid: 1010 });
    await run(o);
    expect(closes(o)).toHaveLength(1);
  });

  it('a repeated pending SELL after the position is gone is rejected by the RPC without error', async () => {
    const o = setup({ mtfMode: 'off', openPositions: [position], pendingSells: [sell], closeResult: { ok: false, reason: 'not_open' }, tickerBid: 1010 });
    const r = await run(o);
    expect(r.status).toBe('SUCCESS');
    expect(closes(o)).toHaveLength(1);
  });

  it('does not look up pending SELLs for a pair that is flat or fails data quality', async () => {
    const flat = setup({ mtfMode: 'off', pendingSells: [sell] });
    await run(flat);
    expect(flat.rpcs.some((x) => x.fn === 'get_pending_sell_signals')).toBe(false);
    const stale = setup({ mtfMode: 'off', openPositions: [position], pendingSells: [sell], staleTicker: true });
    await run(stale);
    expect(stale.rpcs.some((x) => x.fn === 'get_pending_sell_signals')).toBe(false);
    expect(closes(stale)).toHaveLength(0);
  });

  it('degrades the run status when the pending SELL lookup fails instead of reporting success', async () => {
    // A broken safety net must not look healthy: the run stays alive (positions are still marked to
    // market) but reports PARTIAL and records the failure so an operator is alerted.
    const o = setup({ mtfMode: 'off', openPositions: [position], pendingSells: 'boom' as any });
    const r = await run(o);
    expect(r.status).toBe('PARTIAL');
    expect(closes(o)).toHaveLength(0);
    expect((r.steps as any).paper_trading.info.degraded).toContainEqual(expect.stringContaining('pending sell lookup failed'));
    expect(r.errors).toContainEqual(expect.stringContaining('pending sell lookup failed'));
  });
});

describe('pipeline: unwarmed universe members must not break the run', () => {
  // 2026-11-20: arbidr joined the universe with zero stored candles. get_recent_candles returned
  // {"arbidr": null} (jsonb_agg over an empty set), load_coverage_state threw on rows.length, the
  // recovery cursor fell back to a stale covered_until, and every pair scanned a full 24h window.
  // Those relay calls exhausted the Worker subrequest budget ("Too many subrequests"), so
  // store_market/analyze/finish_run never ran and cron runs were killed by the lease watchdog.
  it('keeps going when a pair has no stored candles (null rows)', async () => {
    const o = setup({ nullCandlePairs: ['arbidr'], extraPairs: ['arbidr'] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(r.errors).toEqual([]);
    expect((r.steps as any).load_coverage_state.info.arbidr).toBe(0);
    expect((r.steps as any).build_candles.ok).toBe(true);
  });

  it('caps 1m history backfill per run so a burst of new pairs cannot exhaust subrequests', async () => {
    const extraPairs = ['p1idr', 'p2idr', 'p3idr', 'p4idr', 'p5idr', 'p6idr', 'p7idr', 'p8idr'];
    const o = setup({ extraPairs, nullCandlePairs: extraPairs });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    const oneMinute = o.indodax.filter((p) => p.startsWith('/tradingview/history_v2')
      && new URLSearchParams(p.split('?')[1]).get('tf') === '1');
    expect(oneMinute).toHaveLength(HISTORY_BACKFILL_PER_RUN);

    // Deferred pairs keep their old cursor instead of pretending the hole was repaired.
    const stepInfo = (r.steps as any).build_candles.info;
    const deferred = Object.values(stepInfo).filter((v: any) => v?.history_deferred).length;
    expect(deferred).toBeGreaterThanOrEqual(extraPairs.length - HISTORY_BACKFILL_PER_RUN);
  });

  it('rotates the backfill queue so one pair cannot starve the rest', async () => {
    const extraPairs = ['p1idr', 'p2idr', 'p3idr', 'p4idr', 'p5idr'];
    const first = setup({ extraPairs, nullCandlePairs: extraPairs });
    await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: first.f, now: () => NOW * 1000 });
    const second = setup({ extraPairs, nullCandlePairs: extraPairs });
    await runPipeline(env(), { scheduledTime: (NOW + 60) * 1000, trigger: 'cron', fetchImpl: second.f, now: () => (NOW + 60) * 1000 });

    const served = (o: typeof first) => o.indodax
      .filter((p) => p.startsWith('/tradingview/history_v2') && new URLSearchParams(p.split('?')[1]).get('tf') === '1');
    const a = served(first);
    const b = served(second);
    expect(a).toHaveLength(HISTORY_BACKFILL_PER_RUN);
    expect(b).toHaveLength(HISTORY_BACKFILL_PER_RUN);
    // The window moves, so the tail of the queue is not permanently starved.
    expect(a.some((x) => !b.includes(x))).toBe(true);
  });

  // 2026-11-20 (third failure): rotation used `nowSec % length`. nowSec is a whole minute, so the
  // offset repeats with period length/gcd(length,60) and freezes completely when the length divides
  // 60. Production had 20 pairs wanting backfill, so the offset was always 0: qntidr and pepeidr sat
  // 6h behind while the rest recovered. The queue must advance across *every* consecutive run.
  it('advances the backfill queue across consecutive minutes even when its length divides 60', async () => {
    // 19 extra + btcidr = 20 wanting backfill: 20 divides 60, the exact production shape.
    const extraPairs = Array.from({ length: 19 }, (_, i) => `r${i}idr`);
    const served: string[][] = [];
    for (let m = 0; m < 3; m++) {
      const o = setup({ extraPairs, nullCandlePairs: extraPairs, staleCoverage: true });
      const at = (NOW + m * 60) * 1000;
      await runPipeline(env(), { scheduledTime: at, trigger: 'cron', fetchImpl: o.f, now: () => at });
      // Compare which *pairs* were served; the from/to window changes every minute either way.
      served.push(o.indodax
        .filter((p) => p.startsWith('/tradingview/history_v2') && new URLSearchParams(p.split('?')[1]).get('tf') === '1')
        .map((p) => new URLSearchParams(p.split('?')[1]).get('symbol') ?? p));
    }
    // Every minute must serve a different slice; a frozen offset repeats the same pairs forever.
    expect(served[0]).not.toEqual(served[1]);
    expect(served[1]).not.toEqual(served[2]);
  });

  // The real outage: Cloudflare rejects every subrequest past the cap. The invariant is that the run
  // still reaches store_market and finish_run, so the pipeline degrades to PARTIAL instead of dying
  // mid-flight and being killed by the lease watchdog.
  // 2026-11-20 (second failure): after the null-candle fix the runs reported SUCCESS again but the
  // 5m series stayed frozen at 03:20. The trade fetches (one call per pair) consumed the entire
  // optional pool, so `budget.remaining() - SUBREQUEST_RESERVE` was 0 and the 1m history backfill
  // was deferred on *every* run. Because `covered_until` only advances when the hole is repaired,
  // the cursor never moved. The invariant: on a realistic universe the history slice must survive.
  it('still backfills 1m history when trade fetches would otherwise eat the whole pool', async () => {
    // 25 pairs at one trade call each, plus market/HTF/RPCs, is the production shape that deadlocked.
    const extraPairs = Array.from({ length: 24 }, (_, i) => `q${i}idr`);
    const o = setup({ extraPairs, staleCoverage: true });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });

    expect(r.status).not.toBe('FAILED');
    const oneMinute = o.indodax.filter((p) => p.startsWith('/tradingview/history_v2')
      && new URLSearchParams(p.split('?')[1]).get('tf') === '1');
    expect(oneMinute.length).toBeGreaterThan(0);
    // The reserve still has to hold: the core steps must reach finish_run inside the cap.
    expect((r.steps as any).store_market?.ok).toBe(true);
    expect((r.steps as any).budget.info.used).toBeLessThanOrEqual(50);
  });

  // 2026-11-21: the Telegram alert "backfill xlmidr: incomplete_coverage (1265 missing minute(s))"
  // every hour. INDODAX publishes no 1m OHLC for that pair, so the shortfall could never be repaired;
  // the run went PARTIAL and the system-error notifier fired forever while the pair stored no candles.
  it('does not alert when a pair has no published 1m history at all', async () => {
    const o = setup({
      extraPairs: ['xlmidr'], nullCandlePairs: ['xlmidr'], staleCoverage: true, emptyHistoryPairs: ['xlmidr'],
    });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });

    expect(r.errors).toEqual([]);
    expect(r.status).toBe('SUCCESS');
    const info = (r.steps as any).build_candles.info.xlmidr;
    expect(info.history_complete).toBe(true);
    expect(info.history_source).toBe('unpublished');
    // The frontier moves to the current minute, which is what unblocks 5m aggregation next run.
    const sync = (o.rpcs.find((x) => x.fn === 'ingest_market')!.body.p_sync as any[]).find((s) => s.pair_id === 'xlmidr');
    expect(sync.covered_until).toBe(new Date(Math.floor(NOW / 60) * 60 * 1000).toISOString());
    expect(info.history_missing_minutes).toBeGreaterThan(0);
  });

  it('still alerts when the OHLC response is partial rather than absent', async () => {
    // A source that returned most of the window can usually return the rest, so this stays loud.
    const o = setup({ extraPairs: ['xlmidr'], nullCandlePairs: ['xlmidr'], staleCoverage: true, shortHistoryPairs: ['xlmidr'] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });

    expect(r.status).toBe('PARTIAL');
    expect((r.errors ?? []).some((e) => e.includes('incomplete_coverage'))).toBe(true);
  });

  it('reserves budget so store_market and finish_run survive a tight subrequest cap', async () => {
    const extraPairs = Array.from({ length: 12 }, (_, i) => `x${i}idr`);
    const o = setup({ extraPairs, nullCandlePairs: extraPairs, mtfMode: 'on' });

    // 30 is below what this universe needs, so only the reserve can keep the core steps alive.
    const r = await runPipeline(env(), {
      scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000, subrequestLimit: 30,
    });

    expect(r.status).not.toBe('FAILED');
    expect((r.steps as any).store_market?.ok).toBe(true);
    expect((r.steps as any).budget.info.used).toBeLessThanOrEqual(30);
    const rpcNames = o.f.calls.map((c) => c.url.split('/rpc/')[1]).filter(Boolean);
    expect(rpcNames).toContain('finish_run');
  });
});


describe('pipeline: invalid strategy config blocks entries', () => {
  // The admin API refuses to save an inverted reward/risk bracket, but a row can still reach the
  // pipeline via direct SQL or a migration. Entries must stop while exits keep running: withholding a
  // SELL would trap an open position past its stop, which is worse than the bad bracket itself.
  it('blocks every BUY and reports FAILED when take profit is not wider than the stop loss', async () => {
    const signal = {
      id: 77, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 2.866 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const { f, rpcs } = setup({ mtfMode: 'off', strategyParams: { atrStopMultiplier: 9, atrTakeProfitMultiplier: 5 }, newSignals: [signal] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('FAILED');
    expect((r.errors ?? []).join(' ')).toContain('invalid_strategy_params');
    expect((r.errors ?? []).join(' ')).toContain('INVALID_NET_REWARD_RISK');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const info = (r.steps as any)?.paper_trading?.info;
    expect(info).toMatchObject({ buy_signals_received: 1, entries_opened: 0 });
    expect(info.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', stage: 'strategy_params_gate', reason: 'invalid_strategy_params',
    }));
  });

  it('still closes an open position while entries are blocked', async () => {
    const { f, rpcs } = setup({
      mtfMode: 'off',
      strategyParams: { atrStopMultiplier: 9, atrTakeProfitMultiplier: 5 },
      openPositions: [{
        id: 5, pair_id: 'btcidr', status: 'OPEN', qty: 1, entry_price: 1000, entry_fee: 2,
        stop_loss: 1050, take_profit: 900, opened_at: '2026-01-01T00:00:00Z',
      }],
    });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });
    expect(r.status).toBe('FAILED');
    // The exit path is independent of the entry gate.
    expect(rpcs.some((x) => x.fn === 'paper_close_position')).toBe(true);
  });

  it('runs normally when the reward/risk bracket is valid', async () => {
    const { f } = setup({ strategyParams: { atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3 } });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });
    expect(r.status).toBe('SUCCESS');
  });
});

// A monotonic clock that advances on every read. The lease keeper renews lazily (only once a third
// of the TTL is left), so a frozen clock never calls ensure(); this simulates a run that takes time.
function advancingNow(startMs = NOW * 1000, stepMs = 6000) {
  let t = startMs;
  return () => (t += stepMs);
}


describe('pipeline: lease TTL has cron margin (FIX-01)', () => {
  it('keeps at least 15s between lease expiry and the next cron tick', () => {
    expect(leaseFitsCron()).toBe(true);
    expect(CRON_INTERVAL_SECONDS - LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(MIN_LEASE_MARGIN_SECONDS);
    // The old 55s left only a 5s margin, which a single retrying fetch can exceed.
    expect(leaseFitsCron(55)).toBe(false);
  });

  it('passes the shared constant to begin_run instead of a second hardcoded 55', async () => {
    const o = setup({ mtfMode: 'off', fenceToken: 11 });
    await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });
    const begin = o.rpcs.find((x) => x.fn === 'begin_run');
    expect(begin?.body.p_lock_ttl_seconds).toBe(LEASE_TTL_SECONDS);
  });

  it('classifies an expired lease and keeps the server reason in the run log', async () => {
    // An open position with a stop above the bid forces the exit path, which hits guardLease().
    const OPEN = [{ id: 5, pair_id: 'btcidr', status: 'OPEN', qty: 1, entry_price: 1000, entry_fee: 2, stop_loss: 1050, take_profit: 900, opened_at: '2026-01-01T00:00:00Z' }];
    // Slow clock (advances 6s/read) so the client-side deadline passes before renewal is attempted.
    const expired = setup({ mtfMode: 'off', openPositions: OPEN, fenceToken: 5, renewResult: { ok: false, reason: 'lease_not_held' } });
    const r1 = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: expired.f, now: advancingNow() });
    expect((r1.steps as any).lease).toMatchObject({ ok: false, kind: 'expired' });
    expect((r1.steps as any).lease.reason).toMatch(/expired|not_held/);

    // Fast clock (advances 0.5s/read) so the run reaches the server and the server rejects the token.
  });
});

describe('pipeline: no write after the lease is lost (VERIFY-01)', () => {
  const OPEN = [{
    id: 5, pair_id: 'btcidr', status: 'OPEN', qty: 1, entry_price: 1000, entry_fee: 2,
    stop_loss: 1050, take_profit: 900, opened_at: '2026-01-01T00:00:00Z',
  }];

  it('abandons the close when ensure() fails before the mutation', async () => {
    // stop_loss 1050 > bid 1000 => exitReason() fires STOP_LOSS, which routes through close()->guardLease().
    const o = setup({ mtfMode: 'off', openPositions: OPEN, fenceToken: 3, renewResult: { ok: false, reason: 'lease_not_held' } });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: advancingNow() });
    expect(o.rpcs.some((x) => x.fn === 'paper_close_position')).toBe(false);
    expect(o.rpcs.some((x) => x.fn === 'paper_mark_to_market')).toBe(false);
    expect((r.steps as any).paper_trading.info.actions.join(' ')).toContain('lease lost');
    expect((r.steps as any).lease).toMatchObject({ ok: false, abandoned: true });
  });

  it('abandons the open when ensure() fails before the mutation', async () => {
    const signal = {
      id: 301, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 10 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const o = setup({ mtfMode: 'off', newSignals: [signal], fenceToken: 3, renewResult: { ok: false, reason: 'lease_not_held' } });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: advancingNow() });
    // No order mutation may be sent once the fence is gone. MTM is itself a write, so it must be
    // skipped too; the run bails before it can reach the entry loop.
    expect(o.rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    expect(o.rpcs.some((x) => x.fn === 'paper_mark_to_market')).toBe(false);
    expect((r.steps as any).paper_trading.info.actions.join(' ')).toContain('lease lost');
  });

  it('records the abandoned run as PARTIAL, never SUCCESS', async () => {
    const o = setup({ mtfMode: 'off', openPositions: OPEN, fenceToken: 3, renewResult: { ok: false, reason: 'lease_not_held' } });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: advancingNow() });
    expect(r.status).toBe('PARTIAL');
  });
});

describe('pipeline: signal evaluation once per 5m bucket (FIX-07)', () => {
  // NOW sits 30s after a quarter-hour boundary, so it is the first tick of its 300s bucket.
  const bucketStart = Math.floor(NOW / 300) * 300;

  it('evaluates signals once in five consecutive ticks while marking every tick', async () => {
    const phases: string[] = [];
    let signalRuns = 0;
    for (let i = 0; i < 5; i++) {
      const scheduled = bucketStart + i * 60;
      // begin_run reports "a signal run already completed this hour" only after the first tick.
      const o = setup({ mtfMode: 'off', signalsDue: signalRuns === 0, openPositions: [{
        id: 5, pair_id: 'btcidr', status: 'OPEN', qty: 1, entry_price: 900, entry_fee: 2,
        stop_loss: 800, take_profit: 5000, opened_at: '2026-01-01T00:00:00Z',
      }] });
      const r = await runPipeline(env(), { scheduledTime: scheduled * 1000, trigger: 'cron', fetchImpl: o.f, now: () => scheduled * 1000 });
      const steps = r.steps as any;
      phases.push(steps.analyze ? 'signal' : 'mark');
      if (steps.analyze) signalRuns++;
      // Every tick must mark to market, including the mark-phase ones.
      expect(o.rpcs.some((x) => x.fn === 'paper_mark_to_market')).toBe(true);
    }
    expect(phases).toEqual(['signal', 'mark', 'mark', 'mark', 'mark']);
  });

  it('still marks and can close a held pair that is outside the universe on a mark run', async () => {
    // FIX-07 x VERIFY-02: begin_run scopes pairs to tracked OR in_universe OR held. A mark-phase run
    // must keep managing that held pair even though no signal evaluation happens.
    const o = setup({ mtfMode: 'off', signalsDue: false, openPositions: [{
      id: 5, pair_id: 'btcidr', status: 'OPEN', qty: 1, entry_price: 1000, entry_fee: 2,
      stop_loss: 1050, take_profit: 900, opened_at: '2026-01-01T00:00:00Z',
    }] });
    const r = await runPipeline(env(), { scheduledTime: bucketStart * 1000, trigger: 'cron', fetchImpl: o.f, now: () => bucketStart * 1000 });
    expect((r.steps as any).analyze).toBeUndefined();
    expect(o.rpcs.some((x) => x.fn === 'paper_mark_to_market')).toBe(true);
    // stop_loss 1050 > bid 1000 => STOP_LOSS, so the position must still be closed.
    expect(o.rpcs.some((x) => x.fn === 'paper_close_position')).toBe(true);
  });

  it('trusts the phase begin_run recorded instead of recomputing it', async () => {
    const o = setup({ mtfMode: 'off', signalsDue: false });
    const r = await runPipeline(env(), { scheduledTime: bucketStart * 1000, trigger: 'cron', fetchImpl: o.f, now: () => bucketStart * 1000 });
    expect((r.steps as any).analyze).toBeUndefined();
    expect(o.rpcs.some((x) => x.fn === 'save_analysis')).toBe(false);
  });

  it('keeps evaluating every tick when the phase migration is absent (fail-safe)', async () => {
    // signals_due absent means the database predates the migration. Degrading to "mark" would stop
    // opening positions entirely, so the fallback must reproduce the pre-FIX-07 behaviour.
    const o = setup({ mtfMode: 'off' });
    const r = await runPipeline(env(), { scheduledTime: (bucketStart + 120) * 1000, trigger: 'cron', fetchImpl: o.f, now: () => (bucketStart + 120) * 1000 });
    expect((r.steps as any).analyze).toBeTruthy();
  });
});

describe('pipeline: bounded work queue rotates instead of starving (FIX-04)', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => `p${String(i).padStart(2, '0')}idr`);

  it('serves every pair within ceil(total/window) consecutive runs', () => {
    const window = 5;
    const servedAt = new Map<string, number>();
    const runs = 12;
    // Cron ticks one minute apart, starting from a fixed second.
    const t0 = 1_800_000_000 - (1_800_000_000 % 60);
    for (let run = 0; run < runs; run++) {
      const nowSec = t0 + run * 60;
      const offset = rotationOffset(nowSec, pairs.length, window);
      for (const id of rotateWindow(pairs, offset).slice(0, window)) {
        if (!servedAt.has(id)) servedAt.set(id, run);
      }
    }
    expect(servedAt.size).toBe(pairs.length);
    const worst = Math.max(...servedAt.values());
    // 12 pairs / 5 per run = 3 runs to cover the whole queue; a one-per-run cursor needed up to 8.
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('a one-per-run cursor would have starved the tail (regression guard)', () => {
    // Document why the stride matters: advancing by 1 overlaps windows and leaves a pair unserved for
    // more than ceil(total/window) runs.
    const window = 5;
    const servedAt = new Map<string, number>();
    const t0 = 1_800_000_000 - (1_800_000_000 % 60);
    for (let run = 0; run < 12; run++) {
      const offset = (Math.floor((t0 + run * 60) / 60) * 1) % pairs.length;
      for (const id of rotateWindow(pairs, offset).slice(0, window)) {
        if (!servedAt.has(id)) servedAt.set(id, run);
      }
    }
    expect(Math.max(...servedAt.values())).toBeGreaterThan(2);
  });
});

describe('pipeline: capacity overflow is observable (FIX-10)', () => {
  it('emits a structured universe_capacity event with size, capacity and dropped pairs', async () => {
    // TRADE_FETCH_PER_RUN pairs fit; one more overflows the per-run trade budget.
    const extra = Array.from({ length: TRADE_FETCH_PER_RUN }, (_, i) => `x${i}idr`);
    const o = setup({ mtfMode: 'off', extraPairs: extra, nullCandlePairs: extra });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });
    const ev = (r.steps as any).universe_capacity;
    expect(ev).toMatchObject({ ok: false, reason: 'universe_exceeds_capacity', capacity: TRADE_FETCH_PER_RUN });
    expect(ev.universeSize).toBeGreaterThan(TRADE_FETCH_PER_RUN);
    expect(ev.droppedPairs).toBe(ev.universeSize - TRADE_FETCH_PER_RUN);
    expect((r.errors ?? []).join(' ')).toContain('universe_capacity');
  });

  it('stays silent when the scope fits', async () => {
    const o = setup({ mtfMode: 'off' });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });
    expect((r.steps as any).universe_capacity).toBeUndefined();
  });
});
