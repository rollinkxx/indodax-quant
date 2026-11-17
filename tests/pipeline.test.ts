// End-to-end pipeline run against fake Supabase RPCs + fake INDODAX: dynamic universe, HTF backfill and MTF wiring.
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../worker/src/pipeline';
import { env, fakeFetch, json, SB } from './fakes';

const NOW = 1_800_000_000 - (1_800_000_000 % 900) + 30; // 30 s after a quarter-hour boundary
const expectedLast = Math.floor(NOW / 300) * 300 - 300;

function candleRows(n: number, endT: number, step: number, fn: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const t = endT - (n - 1 - i) * step;
    const c = fn(i);
    return [t, c, c + 1, c - 1, c, 2, 'trades'];
  });
}

function setup(opts: { htfBackfilled?: boolean; htfCoverageReady?: boolean; htfHistoryBars?: number; mtfMode?: string; strategyParams?: Record<string, unknown>; newSignals?: any[]; oldGap5mAt?: number; wideSpread?: boolean; failedTradePair?: string; staleTicker?: boolean; openPositions?: any[]; pendingSells?: any[]; closeResult?: any; openResult?: any } = {}) {
  const rpcs: { fn: string; body: any }[] = [];
  const indodax: string[] = [];
  // record every INDODAX request, including the 1m OHLC coverage backfill
  const f = fakeFetch([
    (u, init) => {
      if (!u.href.startsWith(SB + '/rest/v1/rpc/')) return;
      const fn = u.pathname.replace('/rest/v1/rpc/', '');
      const body = JSON.parse(String(init.body ?? '{}'));
      rpcs.push({ fn, body });
      switch (fn) {
        case 'begin_run':
          return json({
            ok: true, run_id: 7, config: { ...(opts.strategyParams ?? {}), ...(opts.mtfMode ? { mtfMode: opts.mtfMode } : {}) },
            account: { id: 1, status: 'RUNNING', kill_switch: false, cash_balance: 1e7, equity: 1e7, peak_equity: 1e7, max_drawdown_pct: 0, reset_at: '2026-01-01T00:00:00Z' },
            pairs: [{ id: 'btcidr', symbol: 'BTCIDR', ticker_id: 'btc_idr', is_maintenance: false, is_tracked: true, in_universe: false, trade_min_base_currency: 10000,
              covered_until: new Date((Math.floor(NOW / 60) * 60 - 60) * 1000).toISOString(), last_trade_time: null, last_trade_tid: null,
              htf_backfilled_at: opts.htfBackfilled ? '2026-01-01T00:00:00Z' : null }],
            catalog: { btcidr: false, pepeidr: false, usdtidr: false, dogeidr: false },
            open_positions: opts.openPositions ?? [], day_start_equity: 1e7, pair_catalog_age_seconds: 60,
          });
        case 'get_recent_candles': {
          const rows = candleRows(250, expectedLast, 300, (i) => 1000 + i);
          if (opts.oldGap5mAt !== undefined) rows.splice(opts.oldGap5mAt, 1);
          return json({ btcidr: rows });
        }
        case 'get_recent_candles_multi': {
          const last15m = Math.floor((expectedLast + 300) / 900) * 900 - 900;
          const last1h = Math.floor((expectedLast + 300) / 3600) * 3600 - 3600;
          return json({
            '15m': { btcidr: candleRows(100, last15m, 900, (i) => 900 + i) },
            '1h': { btcidr: opts.htfCoverageReady ? candleRows(100, last1h, 3600, (i) => 900 + i) : [] },
          });
        }
        case 'save_analysis': return json({ new_signals: opts.newSignals ?? [] });
        case 'get_pending_sell_signals': return json(opts.pendingSells ?? []);
        case 'paper_open_position': return json(opts.openResult ?? { ok: true, position_id: 55, cash_after: 9_700_000 });
        case 'paper_close_position': return json(opts.closeResult ?? { ok: true, realized_pnl: -1 });
        case 'paper_mark_to_market': return json({ ok: true, equity: 1e7, cash: 1e7, peak_equity: 1e7, drawdown_pct: 0, max_drawdown_pct: 0, open_positions: 0 });
        case 'claim_notifications': return json(body.p_items.map((x: any) => x.dedupe_key));
        default: return json({ ok: true });
      }
    },
    (u) => {
      if (u.hostname !== 'indodax.com') return;
      indodax.push(u.pathname + u.search);
      if (u.pathname === '/api/summaries') {
        const t = (id: string, vol: number) => [id.replace('idr', '_idr'), { last: '1000', buy: opts.wideSpread ? '998.9' : '999', sell: '1000', high: '1', low: '1', vol_idr: String(vol), server_time: opts.staleTicker ? NOW - 3600 : NOW - 5 }];
        return json({ tickers: Object.fromEntries([t('btcidr', 9e10), t('pepeidr', 5e10), t('usdtidr', 8e10), t('dogeidr', 2e10)]), prices_24h: {} });
      }
      if (u.pathname.startsWith('/api/trades/')) {
        const pairId = u.pathname.split('/').at(-1);
        if (opts.failedTradePair === pairId) {
          return new Response(JSON.stringify({
            code: 'SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED',
            message: 'Service is temporarily unavailable',
          }), { status: 503, headers: { 'content-type': 'application/json' } });
        }
        return json([{ tid: '1000', date: String(NOW - 20), price: '1000', amount: '1', type: 'buy' }]);
      }
      if (u.pathname === '/tradingview/history_v2') {
        const tf = Number(u.searchParams.get('tf')) * 60;
        const end = Math.floor(NOW / tf) * tf; // includes the still-forming bucket, which must be dropped
        if (tf === 60) {
          const from = Number(u.searchParams.get('from'));
          const to = Number(u.searchParams.get('to'));
          const count = Math.floor((to - from) / tf) + 1;
          return json(Array.from({ length: count }, (_, i) => ({ Time: from + i * tf, Open: 1000, High: 1001, Low: 999, Close: 1000, Volume: 1 })));
        }
        const count = opts.htfHistoryBars ?? 40;
        return json(Array.from({ length: count }, (_, i) => ({ Time: end - (count - 1 - i) * tf, Open: 1000, High: 1001, Low: 999, Close: 1000, Volume: 1 })));
      }
      return undefined;
    },
    (u) => (u.hostname === 'api.telegram.org' ? json({ ok: true }) : undefined),
  ]);
  return { f, rpcs, indodax };
}

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

  it('skips a BUY when net take-profit reward does not cover net stop risk', async () => {
    const signal = {
      id: 99, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 2.866 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const { f, rpcs } = setup({ mtfMode: 'off', strategyParams: { atrTakeProfitMultiplier: 0.5 }, newSignals: [signal] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const actions = (r.steps as any)?.paper_trading?.info?.actions as string[];
    expect(actions).toContain('skip btcidr: net_reward_risk_below_minimum');
    const paperInfo = (r.steps as any)?.paper_trading?.info;
    expect(paperInfo).toMatchObject({ buy_signals_received: 1, entries_opened: 0 });
    expect(paperInfo.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 99, stage: 'economics_gate', reason: 'net_reward_risk_below_minimum',
    }));
    expect(paperInfo.entry_rejection_counts.net_reward_risk_below_minimum).toBe(1);
    expect(paperInfo.entry_rejections[0].metrics.net_reward_risk_ratio).toBeGreaterThan(0);
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
    expect(o.indodax.every((path) => !/private|trade|order/i.test(path))).toBe(true);
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
});

describe('pipeline: persisted SELL exits (F3)', () => {
  const run = (o: ReturnType<typeof setup>) => runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000 });
  const position = { id: 5, pair_id: 'btcidr', qty: 1, entry_price: 1000, cost_basis: 1000, stop_loss: 500, take_profit: 5000, opened_at: new Date((NOW - 600) * 1000).toISOString() };
  const sell = { id: 41, pair_id: 'btcidr', side: 'SELL', price: 1000, strength: 60, reasons: ['test'], indicators: {}, candle_time: new Date(expectedLast * 1000).toISOString() };
  const closes = (o: ReturnType<typeof setup>) => o.rpcs.filter((x) => x.fn === 'paper_close_position');

  it('closes with SIGNAL on a later run even though save_analysis returns no new signals', async () => {
    // Run 1: SELL is saved as new, but the ticker is stale so the exit check is skipped.
    const run1 = setup({ mtfMode: 'off', openPositions: [position], newSignals: [sell], staleTicker: true });
    await run(run1);
    expect(closes(run1)).toHaveLength(0);

    // Run 2: ticker fresh, ON CONFLICT DO NOTHING means no new signals, the stored SELL is still pending.
    const run2 = setup({ mtfMode: 'off', openPositions: [position], newSignals: [], pendingSells: [sell] });
    const r = await run(run2);
    expect(r.status).toBe('SUCCESS');
    expect(run2.rpcs.find((x) => x.fn === 'get_pending_sell_signals')!.body).toEqual({ p_pairs: ['btcidr'] });
    expect(closes(run2)).toHaveLength(1);
    expect(closes(run2)[0].body).toMatchObject({ p_position_id: 5, p_reason: 'SIGNAL' });
  });

  it('closes once when the SELL is both new and pending', async () => {
    const o = setup({ mtfMode: 'off', openPositions: [position], newSignals: [sell], pendingSells: [sell] });
    await run(o);
    expect(closes(o)).toHaveLength(1);
  });

  it('a repeated pending SELL after the position is gone is rejected by the RPC without error', async () => {
    const o = setup({ mtfMode: 'off', openPositions: [position], pendingSells: [sell], closeResult: { ok: false, reason: 'not_open' } });
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

  it('keeps running when the pending SELL lookup fails', async () => {
    const o = setup({ mtfMode: 'off', openPositions: [position], pendingSells: 'boom' as any });
    const r = await run(o);
    expect(r.status).toBe('SUCCESS');
    expect(closes(o)).toHaveLength(0);
  });
});
