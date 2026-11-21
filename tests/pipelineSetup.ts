// Shared fake-backed pipeline fixture: fake Supabase RPCs + fake INDODAX responses.
// Extracted from pipeline.test.ts so the pending-entry suite drives the same run.
import { fakeFetch, json, SB } from './fakes';

export const NOW = 1_800_000_000 - (1_800_000_000 % 900) + 30; // 30 s after a quarter-hour boundary
export const expectedLast = Math.floor(NOW / 300) * 300 - 300;

export function candleRows(n: number, endT: number, step: number, fn: (i: number) => number, vol: (i: number) => number = () => 2) {
  return Array.from({ length: n }, (_, i) => {
    const t = endT - (n - 1 - i) * step;
    const c = fn(i);
    return [t, c, c + 1, c - 1, c, vol(i), 'trades'];
  });
}

export function setup(opts: { htfBackfilled?: boolean; htfCoverageReady?: boolean; htfHistoryBars?: number; mtfMode?: string; strategyParams?: Record<string, unknown>; newSignals?: any[]; oldGap5mAt?: number; wideSpread?: boolean; failedTradePair?: string; staleTicker?: boolean; openPositions?: any[]; pendingSells?: any[]; closeResult?: any; openResult?: any; pairTakerFee?: number | null; pairMakerFee?: number | null; tickerBid?: number; pairPricePrecision?: number | null; extraPairs?: string[]; nullCandlePairs?: string[]; emptyHistoryPairs?: string[]; shortHistoryPairs?: string[]; staleCoverage?: boolean; fenceToken?: number | null; renewResult?: Record<string, unknown>; signalsDue?: boolean; pendingEntries?: any[]; pendingEntriesError?: string; pruneError?: string; candleClose?: (i: number) => number; candleVolume?: (i: number) => number; lastSuccessAt?: string | null; beginRun?: Record<string, unknown>; closeRejectsSignalId?: boolean } = {}) {
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
        // A fresh SUCCESS one minute ago keeps the outage alarm quiet by default.
        case 'last_success_at':
          return json(opts.lastSuccessAt === undefined ? new Date((NOW - 60) * 1000).toISOString() : opts.lastSuccessAt);
        case 'begin_run':
          if (opts.beginRun) return json(opts.beginRun);
          return json({
            ok: true, run_id: 7, fence_token: opts.fenceToken === undefined ? null : opts.fenceToken,
            config: { ...(opts.strategyParams ?? {}), ...(opts.mtfMode ? { mtfMode: opts.mtfMode } : {}) },
            account: { id: 1, status: 'RUNNING', kill_switch: false, cash_balance: 1e7, equity: 1e7, peak_equity: 1e7, max_drawdown_pct: 0, reset_at: '2026-01-01T00:00:00Z' },
            pairs: [
              { id: 'btcidr', symbol: 'BTCIDR', ticker_id: 'btc_idr', is_maintenance: false, is_tracked: true, in_universe: false, trade_min_base_currency: 10000,
              trade_fee_percent_taker: opts.pairTakerFee === undefined ? 0.2 : opts.pairTakerFee,
              trade_fee_percent_maker: opts.pairMakerFee === undefined ? 0.1 : opts.pairMakerFee,
              price_precision: opts.pairPricePrecision ?? null,
              covered_until: new Date((Math.floor(NOW / 60) * 60 - 60) * 1000).toISOString(), last_trade_time: null, last_trade_tid: null,
              htf_backfilled_at: opts.htfBackfilled ? '2026-01-01T00:00:00Z' : null },
              ...(opts.extraPairs ?? []).map((id) => ({
                id, symbol: id.toUpperCase(), ticker_id: id.replace('idr', '_idr'), is_maintenance: false, is_tracked: false,
                in_universe: true, trade_min_base_currency: 10000, trade_fee_percent_taker: 0.2,
                trade_fee_percent_maker: opts.pairMakerFee === undefined ? 0.1 : opts.pairMakerFee, price_precision: null,
                // A newly admitted pair with no stored bars has no cursor at all.
                covered_until: opts.staleCoverage ? new Date((Math.floor(NOW / 60) * 60 - 3 * 3600) * 1000).toISOString() : null,
                last_trade_time: null, last_trade_tid: null, htf_backfilled_at: '2026-01-01T00:00:00Z',
              })),
            ],
            catalog: { btcidr: false, pepeidr: false, usdtidr: false, dogeidr: false },
            open_positions: opts.openPositions ?? [], day_start_equity: 1e7, pair_catalog_age_seconds: 60,
            ...(opts.signalsDue === undefined ? {} : { signals_due: opts.signalsDue, phase: opts.signalsDue ? 'signal' : 'mark' }),
          });
        case 'get_recent_candles': {
          const rows = candleRows(250, expectedLast, 300, opts.candleClose ?? ((i) => 1000 + i), opts.candleVolume);
          if (opts.oldGap5mAt !== undefined) rows.splice(opts.oldGap5mAt, 1);
          // Production returns null for a pair with no stored bars (jsonb_agg over an empty set),
          // which is exactly what broke load_coverage_state.
          const out: Record<string, unknown> = { btcidr: rows };
          for (const id of opts.nullCandlePairs ?? []) out[id] = null;
          return json(out);
        }
        case 'get_recent_candles_multi': {
          const last15m = Math.floor((expectedLast + 300) / 900) * 900 - 900;
          const last1h = Math.floor((expectedLast + 300) / 3600) * 3600 - 3600;
          return json({
            '15m': { btcidr: candleRows(100, last15m, 900, (i) => 900 + i) },
            '1h': { btcidr: opts.htfCoverageReady ? candleRows(100, last1h, 3600, (i) => 900 + i) : [] },
          });
        }
        case 'renew_pipeline_lease':
          return json(opts.renewResult ?? { ok: true, token: opts.fenceToken, expires_at_ms: Date.now() + 45_000 });
        case 'save_analysis': return json({ new_signals: opts.newSignals ?? [] });
        // A string simulates the production failure (PostgREST 404 when the RPC is missing); an array is a normal response.
        case 'get_pending_entries':
          return opts.pendingEntriesError
            ? json({ code: 'PGRST202', message: opts.pendingEntriesError }, 404)
            : json(opts.pendingEntries ?? []);
        case 'get_pending_sell_signals':
          return typeof opts.pendingSells === 'string'
            ? json({ code: 'PGRST202', message: opts.pendingSells }, 404)
            : json(opts.pendingSells ?? []);
        case 'prune_pending_entries':
          return opts.pruneError
            ? json({ code: 'PGRST202', message: opts.pruneError }, 404)
            : json(3);
        case 'paper_open_position': return json(opts.openResult ?? { ok: true, position_id: 55, cash_after: 9_700_000 });
        case 'paper_close_position':
          // Simulates a database that has not taken the signal_id migration: the seven-argument form 404s.
          if (opts.closeRejectsSignalId && body.p_signal_id !== undefined) {
            return json({ code: 'PGRST202', message: 'Could not find the function public.paper_close_position' }, 404);
          }
          return json(opts.closeResult ?? { ok: true, realized_pnl: -1 });
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
        // INDODAX publishes no 1m series for some thin pairs: the endpoint answers with an empty array.
        if (tf === 60 && (opts.emptyHistoryPairs ?? []).includes(String(u.searchParams.get('symbol')).toLowerCase())) return json([]);
        const end = Math.floor(NOW / tf) * tf; // includes the still-forming bucket, which must be dropped
        // A partial 1m answer: the source has the series but returned only its tail.
        if (tf === 60 && (opts.shortHistoryPairs ?? []).includes(String(u.searchParams.get('symbol')).toLowerCase())) {
          return json(Array.from({ length: 5 }, (_, i) => ({ Time: end - (4 - i) * tf, Open: 1000, High: 1001, Low: 999, Close: 1000, Volume: 1 })));
        }
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
