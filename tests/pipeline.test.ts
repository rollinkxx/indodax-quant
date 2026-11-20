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

function setup(opts: { htfBackfilled?: boolean; htfCoverageReady?: boolean; htfHistoryBars?: number; mtfMode?: string; strategyParams?: Record<string, unknown>; newSignals?: any[]; oldGap5mAt?: number; wideSpread?: boolean; failedTradePair?: string; staleTicker?: boolean; openPositions?: any[]; pendingSells?: any[]; closeResult?: any; openResult?: any; pairTakerFee?: number | null; tickerBid?: number; pairPricePrecision?: number | null } = {}) {
  const rpcs: { fn: string; body: any }[] = [];
  const indodax: string[] = [];
  // record every INDODAX request, including the 1m OHLC coverage backfill
  const f = fakeFetch([
    (u, init) => {
      // Trailing-stop ratchet writes straight to the table, not through an RPC.
      if (u.href.startsWith(SB + '/rest/v1/paper_positions')) return json([{ id: 5 }]);
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
              trade_fee_percent_taker: opts.pairTakerFee === undefined ? 0.2 : opts.pairTakerFee,
              price_precision: opts.pairPricePrecision ?? null,
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
        // A string simulates the production failure (PostgREST 404 when the RPC is missing); an array is a normal response.
        case 'get_pending_sell_signals':
          return typeof opts.pendingSells === 'string'
            ? json({ code: 'PGRST202', message: opts.pendingSells }, 404)
            : json(opts.pendingSells ?? []);
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
        const bid = String(opts.tickerBid ?? 1000);
        const t = (id: string, vol: number) => [id.replace('idr', '_idr'), { last: bid, buy: opts.wideSpread ? String(Number(bid) * 0.9989) : bid, sell: bid, high: '1', low: '1', vol_idr: String(vol), server_time: opts.staleTicker ? NOW - 3600 : NOW - 5 }];
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
    // At the real 0.2% taker fee a 0.5xATR target cannot even cover the round trip, so the
    // economics gate rejects it as net_reward_non_positive (stronger than below_minimum).
    expect(actions).toContain('skip btcidr: net_reward_non_positive');
    const paperInfo = (r.steps as any)?.paper_trading?.info;
    expect(paperInfo).toMatchObject({ buy_signals_received: 1, entries_opened: 0 });
    expect(paperInfo.entry_rejections).toContainEqual(expect.objectContaining({
      pair_id: 'btcidr', signal_id: 99, stage: 'economics_gate', reason: 'net_reward_non_positive',
    }));
    expect(paperInfo.entry_rejection_counts.net_reward_non_positive).toBe(1);
    expect(paperInfo.entry_rejections[0].metrics.net_reward_risk_ratio).toBeLessThan(0);
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
