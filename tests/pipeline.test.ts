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

function setup(opts: { htfBackfilled?: boolean; htfCoverageReady?: boolean; htfHistoryBars?: number; mtfMode?: string; newSignals?: any[]; oldGap5mAt?: number } = {}) {
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
            ok: true, run_id: 7, config: opts.mtfMode ? { mtfMode: opts.mtfMode } : {},
            account: { id: 1, status: 'RUNNING', kill_switch: false, cash_balance: 1e7, equity: 1e7, peak_equity: 1e7, max_drawdown_pct: 0, reset_at: '2026-01-01T00:00:00Z' },
            pairs: [{ id: 'btcidr', symbol: 'BTCIDR', ticker_id: 'btc_idr', is_maintenance: false, is_tracked: true, in_universe: false, trade_min_base_currency: 10000,
              covered_until: new Date((Math.floor(NOW / 60) * 60 - 60) * 1000).toISOString(), last_trade_time: null, last_trade_tid: null,
              htf_backfilled_at: opts.htfBackfilled ? '2026-01-01T00:00:00Z' : null }],
            catalog: { btcidr: false, pepeidr: false, usdtidr: false, dogeidr: false },
            open_positions: [], day_start_equity: 1e7, pair_catalog_age_seconds: 60,
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
        case 'paper_mark_to_market': return json({ ok: true, equity: 1e7, cash: 1e7, peak_equity: 1e7, drawdown_pct: 0, max_drawdown_pct: 0, open_positions: 0 });
        case 'claim_notifications': return json(body.p_items.map((x: any) => x.dedupe_key));
        default: return json({ ok: true });
      }
    },
    (u) => {
      if (u.hostname !== 'indodax.com') return;
      indodax.push(u.pathname + u.search);
      if (u.pathname === '/api/summaries') {
        const t = (id: string, vol: number) => [id.replace('idr', '_idr'), { last: '1000', buy: '999', sell: '1000', high: '1', low: '1', vol_idr: String(vol), server_time: NOW - 5 }];
        return json({ tickers: Object.fromEntries([t('btcidr', 9e10), t('pepeidr', 5e10), t('usdtidr', 8e10), t('dogeidr', 2e10)]), prices_24h: {} });
      }
      if (u.pathname.startsWith('/api/trades/')) return json([{ tid: '1000', date: String(NOW - 20), price: '1000', amount: '1', type: 'buy' }]);
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
    expect(steps.universe.info.members).toEqual(['pepeidr', 'dogeidr']);
  });

  it('skips a BUY when net take-profit reward does not cover net stop risk', async () => {
    const signal = {
      id: 99, pair_id: 'btcidr', side: 'BUY', price: 1000, strength: 90, reasons: ['test'],
      indicators: { atr14: 2.866 }, candle_time: new Date(expectedLast * 1000).toISOString(),
    };
    const { f, rpcs } = setup({ mtfMode: 'off', newSignals: [signal] });
    const r = await runPipeline(env(), { scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: f, now: () => NOW * 1000 });

    expect(r.status).toBe('SUCCESS');
    expect(rpcs.some((x) => x.fn === 'paper_open_position')).toBe(false);
    const actions = (r.steps as any)?.paper_trading?.info?.actions as string[];
    expect(actions).toContain('skip btcidr: net_reward_risk_below_minimum');
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
