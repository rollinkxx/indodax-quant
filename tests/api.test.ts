import { beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../worker/src/api';
import { clearAuthCache } from '../worker/src/auth';
import worker from '../worker/src/index';
import { appUsersHandler, authHandler, env, fakeFetch, json, SB } from './fakes';

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`https://app.test${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });

const account = { id: 1, name: 'default', status: 'STOPPED', reset_at: '2026-11-13T00:00:00Z', equity: '10000000', initial_balance: '10000000' };

function dbHandler(state: { rpcs: { fn: string; body: any }[]; strategyParams?: any; openPositions?: { id: number; pair_id: string; qty: string }[] }) {
  return (u: URL, init: RequestInit) => {
    if (!u.href.startsWith(SB + '/rest/v1/')) return;
    const table = u.pathname.replace('/rest/v1/', '');
    if (table.startsWith('rpc/')) {
      const fn = table.slice(4);
      state.rpcs.push({ fn, body: JSON.parse(String(init.body ?? '{}')) });
      return json({ ok: true, status: 'RUNNING' });
    }
    if (table === 'paper_accounts') return json([account]);
    if (table === 'paper_positions') return json(state.openPositions ?? []);
    if (table === 'strategy_configs') {
      if (init.method === 'PATCH') { state.strategyParams = JSON.parse(String(init.body)).params; return json([{ id: 1, params: state.strategyParams }]); }
      return json([{ id: 1, name: 'ema_rsi_volume', params: state.strategyParams ?? {} }]);
    }
    return json([]);
  };
}

describe('API auth & authorization', () => {
  beforeEach(() => clearAuthCache());

  it('health and public-config are public and expose no secrets', async () => {
    const f = fakeFetch([]);
    const h = await (await handleApi(req('/api/health'), env(), f)).json() as any;
    expect(h).toMatchObject({ ok: true, liveTrading: false });
    const pc = await (await handleApi(req('/api/public-config'), env(), f)).text();
    expect(pc).toContain('sb_publishable_test');
    expect(pc).not.toContain('sb_secret_test');
    expect(pc).not.toContain('123:abc');
  });

  it('rejects missing, invalid and unregistered users', async () => {
    const f = fakeFetch([authHandler, appUsersHandler]);
    expect((await handleApi(req('/api/me'), env(), f)).status).toBe(401);
    expect((await handleApi(req('/api/me', 'garbage'), env(), f)).status).toBe(401);
    const r = await handleApi(req('/api/me', 'stranger'), env(), f);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error).toBe('not_authorized');
  });

  it('viewer can read but not mutate', async () => {
    const state = { rpcs: [] as any[] };
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state)]);
    const me = await (await handleApi(req('/api/me', 'viewer'), env(), f)).json() as any;
    expect(me).toEqual({ email: 'viewer@x.com', role: 'viewer' });
    expect((await handleApi(req('/api/portfolio', 'viewer'), env(), f)).status).toBe(200);
    for (const p of ['/api/paper/start', '/api/paper/kill', '/api/system/run', '/api/telegram/test']) {
      const r = await handleApi(req(p, 'viewer', { method: 'POST' }), env(), f);
      expect(r.status).toBe(403);
    }
    expect(state.rpcs).toHaveLength(0);
  });

  it('admin Start calls paper_set_status RUNNING', async () => {
    const state = { rpcs: [] as any[] };
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state)]);
    const r = await handleApi(req('/api/paper/start', 'admin', { method: 'POST' }), env(), f);
    expect(r.status).toBe(200);
    expect(state.rpcs[0]).toMatchObject({ fn: 'paper_set_status', body: { p_account_id: 1, p_status: 'RUNNING' } });
  });

  it('manual kill switch applies dynamic slippage from the ticker volume tier', async () => {
    const state = {
      rpcs: [] as { fn: string; body: any }[],
      strategyParams: { dynamicSlippage: true, slippageBps: 10, feePct: 0.3 },
      openPositions: [{ id: 12, pair_id: 'thinidr', qty: '2' }],
    };
    const tickerHandler = (u: URL) => u.href === 'https://indodax.com/api/ticker/thinidr'
      ? json({ ticker: { last: '1000', buy: '999', sell: '1001', vol_idr: '100000000', server_time: String(Math.floor(Date.now() / 1000)) } })
      : undefined;
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state), tickerHandler]);
    const r = await handleApi(req('/api/paper/kill', 'admin', { method: 'POST' }), env(), f);

    expect(r.status).toBe(200);
    const close = state.rpcs.find((x) => x.fn === 'paper_close_position');
    expect(close?.body.p_slippage_bps).toBe(40);
    expect(close?.body.p_fill_price).toBeCloseTo(999 * (1 - 40 / 10_000));
  });

  it('manual kill switch does not close positions using a stale ticker', async () => {
    const state = {
      rpcs: [] as { fn: string; body: any }[],
      strategyParams: { dynamicSlippage: true, slippageBps: 10, feePct: 0.3 },
      openPositions: [{ id: 12, pair_id: 'thinidr', qty: '2' }],
    };
    const tickerHandler = (u: URL) => u.href === 'https://indodax.com/api/ticker/thinidr'
      ? json({ ticker: { last: '1000', buy: '999', sell: '1001', vol_idr: '100000000', server_time: '1' } })
      : undefined;
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state), tickerHandler]);
    const r = await handleApi(req('/api/paper/kill', 'admin', { method: 'POST' }), env(), f);
    const body = await r.json() as any;

    expect(r.status).toBe(200);
    expect(body).toMatchObject({ status: 'KILLED', closed: 0, total: 1 });
    expect(body.results[0]).toMatchObject({ pair: 'thinidr', ok: false });
    expect(state.rpcs.some((x) => x.fn === 'paper_close_position')).toBe(false);
  });

  it('manual kill switch does not close positions using a crossed bid/ask quote', async () => {
    const state = {
      rpcs: [] as { fn: string; body: any }[],
      strategyParams: { dynamicSlippage: true, slippageBps: 10, feePct: 0.3 },
      openPositions: [{ id: 12, pair_id: 'thinidr', qty: '2' }],
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const tickerHandler = (u: URL) => u.href === 'https://indodax.com/api/ticker/thinidr'
      ? json({ ticker: { last: '1000', buy: '1002', sell: '1001', vol_idr: '100000000', server_time: String(nowSec) } })
      : undefined;
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state), tickerHandler]);
    const r = await handleApi(req('/api/paper/kill', 'admin', { method: 'POST' }), env(), f);
    const body = await r.json() as any;

    expect(r.status).toBe(200);
    expect(body).toMatchObject({ status: 'KILLED', closed: 0, total: 1 });
    expect(body.results[0]).toMatchObject({ pair: 'thinidr', ok: false });
    expect(state.rpcs.some((x) => x.fn === 'paper_close_position')).toBe(false);
  });

  it('strategy update is validated server-side', async () => {
    const state = { rpcs: [] as any[], strategyParams: {} };
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler(state)]);
    const bad = await handleApi(req('/api/strategy', 'admin', { method: 'PUT', body: JSON.stringify({ params: { emaFast: 50, emaSlow: 21 } }) }), env(), f);
    expect(bad.status).toBe(422);
    const ok = await handleApi(req('/api/strategy', 'admin', { method: 'PUT', body: JSON.stringify({ params: { feePct: 0.2 } }) }), env(), f);
    expect(ok.status).toBe(200);
    expect(state.strategyParams).toMatchObject({ feePct: 0.2, emaFast: 9 });
  });

  it('rejects injection-like pair parameters', async () => {
    const f = fakeFetch([authHandler, appUsersHandler, dbHandler({ rpcs: [] })]);
    const r = await handleApi(req('/api/candles?pair=btcidr%26select%3D*', 'viewer'), env(), f);
    expect(r.status).toBe(400);
  });

  it('worker fetch serves static assets for non-API paths with no Supabase call', async () => {
    const r = await worker.fetch(new Request('https://app.test/market'), env());
    expect(await r.text()).toBe('asset');
  });
});
