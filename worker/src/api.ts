// REST API served by the Worker under /api/*. All data endpoints require a Supabase session
// whose email is listed in public.app_users; mutating endpoints require role=admin.
import type { Env, FetchLike } from './env';
import { Db } from './db';
import { authenticate, AuthError, requireAdmin, type AppUser } from './auth';
import { IndodaxClient } from './indodax';
import { errorMessage } from './http';
import { runPipeline } from './pipeline';
import { sendTelegram, telegramConfigured, messages, jakarta } from './telegram';
import { sellFillPrice, feeFor, computeStats } from '../../shared/paper';
import { DEFAULT_PARAMS, mergeParams, validateParams } from '../../shared/strategy';

const MAX_TRACKED_PAIRS = 10;

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

const bad = (msg: string, status = 400, details?: unknown) => json({ error: msg, details }, status);
const int = (v: string | null, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : def;
};
const pairOk = (p: string | null): p is string => !!p && /^[a-z0-9]{2,20}$/.test(p);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function defaultAccount(db: Db) {
  const rows = await db.select<Record<string, unknown> & { id: number; reset_at: string; status: string }>('paper_accounts', 'select=*&name=eq.default&limit=1');
  if (!rows[0]) throw new Error('paper account missing');
  return rows[0];
}

export async function handleApi(req: Request, env: Env, fetchImpl: FetchLike = fetch): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method.toUpperCase();
  const q = url.searchParams;

  try {
    // ---- public endpoints
    if (path === '/api/health' && method === 'GET') {
      return json({ ok: true, service: 'indodax-quant', time: new Date().toISOString(), liveTrading: false });
    }
    if (path === '/api/public-config' && method === 'GET') {
      return json({ supabaseUrl: env.SUPABASE_URL, supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY });
    }

    // ---- authenticated endpoints
    const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl);
    const user: AppUser = await authenticate(req, env, db, fetchImpl);

    if (path === '/api/me' && method === 'GET') return json(user);

    if (path === '/api/market/tickers' && method === 'GET') {
      const scope = q.get('scope') === 'all' ? 'all' : 'tracked';
      const pairs = await db.select<{ id: string; is_tracked: boolean; description: string | null }>('market_pairs', 'select=id,is_tracked,description&is_tracked=eq.true');
      const trackedIds = pairs.map((p) => p.id);
      const filter = scope === 'all' ? 'order=vol_idr.desc.nullslast&limit=500' : `pair_id=in.(${trackedIds.join(',')})&order=vol_idr.desc.nullslast`;
      const rows = trackedIds.length || scope === 'all' ? await db.select<Record<string, unknown>>('market_tickers_latest', `select=*&${filter}`) : [];
      return json({ tracked: trackedIds, tickers: rows.map((r) => ({ ...r, is_tracked: trackedIds.includes(String(r.pair_id)) })) });
    }

    if (path === '/api/market/pairs' && method === 'GET') {
      const rows = await db.select('market_pairs', 'select=id,symbol,description,is_tracked,is_maintenance,trade_min_base_currency,trade_fee_percent_taker,updated_at&order=is_tracked.desc,id.asc');
      return json({ pairs: rows, maxTracked: MAX_TRACKED_PAIRS });
    }

    const trackMatch = path.match(/^\/api\/market\/pairs\/([a-z0-9]+)\/track$/);
    if (trackMatch && method === 'PUT') {
      requireAdmin(user);
      const body = await readJson(req);
      if (typeof body.tracked !== 'boolean') return bad('tracked must be boolean');
      if (body.tracked) {
        const current = await db.select<{ id: string }>('market_pairs', 'select=id&is_tracked=eq.true');
        if (current.length >= MAX_TRACKED_PAIRS && !current.some((c) => c.id === trackMatch[1])) {
          return bad(`maximum ${MAX_TRACKED_PAIRS} tracked pairs (INDODAX public rate limit is 180 req/min)`);
        }
      }
      const rows = await db.update('market_pairs', `id=eq.${trackMatch[1]}`, { is_tracked: body.tracked });
      if (!rows.length) return bad('pair not found (it appears after the hourly pair catalog sync)', 404);
      return json({ ok: true, pair: rows[0] });
    }

    if (path === '/api/market/history' && method === 'GET') {
      const pair = q.get('pair');
      if (!pairOk(pair)) return bad('invalid pair');
      const minutes = int(q.get('minutes'), 240, 10, 10080);
      const since = new Date(Date.now() - minutes * 60000).toISOString();
      const rows = await db.select('market_tickers', `select=captured_at,last,bid,ask,vol_idr,change_24h_pct&pair_id=eq.${pair}&captured_at=gte.${since}&order=captured_at.asc&limit=10080`);
      return json({ pair, rows });
    }

    if (path === '/api/market/trades' && method === 'GET') {
      const pair = q.get('pair');
      if (!pairOk(pair)) return bad('invalid pair');
      const rows = await db.select('market_trades', `select=tid,traded_at,price,amount,side&pair_id=eq.${pair}&order=traded_at.desc&limit=${int(q.get('limit'), 50, 1, 500)}`);
      return json({ pair, rows });
    }

    if (path === '/api/candles' && method === 'GET') {
      const pair = q.get('pair');
      const tf = q.get('tf') === '1m' ? '1m' : '5m';
      if (!pairOk(pair)) return bad('invalid pair');
      const rows = await db.select<Record<string, unknown>>('candles', `select=open_time,open,high,low,close,volume,trade_count,source&pair_id=eq.${pair}&timeframe=eq.${tf}&is_closed=eq.true&order=open_time.desc&limit=${int(q.get('limit'), 300, 10, 1000)}`);
      return json({ pair, timeframe: tf, candles: rows.reverse() });
    }

    if (path === '/api/indicators' && method === 'GET') {
      const pair = q.get('pair');
      if (!pairOk(pair)) return bad('invalid pair');
      const rows = await db.select<Record<string, unknown>>('indicators', `select=*&pair_id=eq.${pair}&timeframe=eq.5m&order=open_time.desc&limit=${int(q.get('limit'), 300, 1, 1000)}`);
      return json({ pair, indicators: rows.reverse() });
    }

    if (path === '/api/signals' && method === 'GET') {
      const pair = q.get('pair');
      const side = q.get('side');
      let filter = '';
      if (pair) { if (!pairOk(pair)) return bad('invalid pair'); filter += `&pair_id=eq.${pair}`; }
      if (side === 'BUY' || side === 'SELL') filter += `&side=eq.${side}`;
      const rows = await db.select('trading_signals', `select=*${filter}&order=created_at.desc&limit=${int(q.get('limit'), 100, 1, 500)}`);
      return json({ signals: rows });
    }

    if (path === '/api/portfolio' && method === 'GET') {
      const acc = await defaultAccount(db);
      const [open, closed, snaps] = await Promise.all([
        db.select<Record<string, unknown>>('paper_positions', `select=*&account_id=eq.${acc.id}&status=eq.OPEN&order=opened_at.desc`),
        db.select<{ realized_pnl: string; cost_basis: string }>('paper_positions', `select=realized_pnl,cost_basis&account_id=eq.${acc.id}&status=eq.CLOSED&closed_at=gte.${acc.reset_at}&limit=10000`),
        db.select<Record<string, unknown>>('portfolio_snapshots', `select=snapshot_time,equity,cash,positions_value,drawdown_pct&account_id=eq.${acc.id}&snapshot_time=gte.${acc.reset_at}&order=snapshot_time.desc&limit=${int(q.get('points'), 1440, 10, 10000)}`),
      ]);
      return json({ account: acc, openPositions: open, stats: computeStats(closed), equityCurve: snaps.reverse(), liveTrading: false });
    }

    if (path === '/api/orders' && method === 'GET') {
      const rows = await db.select('paper_orders', `select=*&order=created_at.desc&limit=${int(q.get('limit'), 100, 1, 1000)}`);
      return json({ orders: rows });
    }

    if (path === '/api/positions' && method === 'GET') {
      const status = q.get('status') === 'open' ? 'OPEN' : 'CLOSED';
      const order = status === 'OPEN' ? 'opened_at' : 'closed_at';
      const rows = await db.select('paper_positions', `select=*&status=eq.${status}&order=${order}.desc.nullslast&limit=${int(q.get('limit'), 100, 1, 1000)}`);
      return json({ positions: rows });
    }

    if (path === '/api/strategy' && method === 'GET') {
      const rows = await db.select<{ id: number; name: string; params: unknown; updated_at: string; updated_by: string | null }>('strategy_configs', 'select=*&is_active=eq.true&limit=1');
      return json({ strategy: rows[0] ?? null, effective: mergeParams(rows[0]?.params), defaults: DEFAULT_PARAMS });
    }

    if (path === '/api/strategy' && method === 'PUT') {
      requireAdmin(user);
      const body = await readJson(req);
      const params = (body.params ?? {}) as Record<string, unknown>;
      const errors = validateParams(params);
      if (errors.length) return bad('invalid strategy parameters', 422, errors);
      const rows = await db.select<{ id: number; params: Record<string, unknown> }>('strategy_configs', 'select=id,params&is_active=eq.true&limit=1');
      if (!rows[0]) return bad('no active strategy', 404);
      const merged = { ...DEFAULT_PARAMS, ...rows[0].params, ...params };
      const all = validateParams(merged);
      if (all.length) return bad('invalid strategy parameters', 422, all);
      const updated = await db.update('strategy_configs', `id=eq.${rows[0].id}`, { params: merged, updated_by: user.email, updated_at: new Date().toISOString() });
      return json({ ok: true, strategy: updated[0] });
    }

    if (path === '/api/system' && method === 'GET') {
      const [runs, notes, sync, locks, acc] = await Promise.all([
        db.select<Record<string, unknown>>('execution_logs', `select=*&order=started_at.desc&limit=${int(q.get('limit'), 60, 1, 500)}`),
        db.select('notification_logs', 'select=id,event_type,status,error,created_at,sent_at,message&order=created_at.desc&limit=40'),
        db.select('pair_sync_state', 'select=*&order=pair_id.asc'),
        db.select('system_locks', 'select=*'),
        defaultAccount(db),
      ]);
      const lastSuccess = runs.find((r) => r.status === 'SUCCESS' || r.status === 'PARTIAL');
      const lastRunAge = runs[0] ? (Date.now() - Date.parse(String(runs[0].started_at))) / 1000 : null;
      return json({
        healthy: lastRunAge !== null && lastRunAge < 180 && runs[0]?.status !== 'FAILED',
        lastRunAgeSeconds: lastRunAge,
        lastSuccessAt: lastSuccess?.started_at ?? null,
        telegramConfigured: telegramConfigured(env),
        serviceRoleConfigured: !!env.SUPABASE_SERVICE_ROLE_KEY,
        accountStatus: acc.status,
        cron: '* * * * *',
        runs, notifications: notes, sync, locks,
        liveTrading: false,
      });
    }

    // ---- admin actions
    if (path === '/api/paper/start' && method === 'POST') {
      requireAdmin(user);
      const acc = await defaultAccount(db);
      const r = await db.rpc<{ ok: boolean; reason?: string }>('paper_set_status', { p_account_id: acc.id, p_status: 'RUNNING', p_reason: `started by ${user.email}` });
      return r.ok ? json(r) : bad(r.reason ?? 'failed', 409);
    }
    if (path === '/api/paper/stop' && method === 'POST') {
      requireAdmin(user);
      const acc = await defaultAccount(db);
      const r = await db.rpc<{ ok: boolean; reason?: string }>('paper_set_status', { p_account_id: acc.id, p_status: 'STOPPED', p_reason: `stopped by ${user.email}` });
      return r.ok ? json(r) : bad(r.reason ?? 'failed', 409);
    }
    if (path === '/api/paper/kill' && method === 'POST') {
      requireAdmin(user);
      return json(await killSwitch(env, db, user.email, fetchImpl));
    }
    if (path === '/api/paper/reset' && method === 'POST') {
      requireAdmin(user);
      const body = await readJson(req);
      const initial = body.initialBalance === undefined ? 10_000_000 : Number(body.initialBalance);
      if (!Number.isFinite(initial) || initial < 100_000 || initial > 1e12) return bad('initialBalance must be between 100000 and 1e12');
      const acc = await defaultAccount(db);
      const r = await db.rpc<{ ok: boolean; reason?: string }>('paper_reset_account', { p_account_id: acc.id, p_initial_balance: initial });
      return r.ok ? json(r) : bad(r.reason ?? 'failed', 409);
    }
    if (path === '/api/system/run' && method === 'POST') {
      requireAdmin(user);
      const result = await runPipeline(env, { scheduledTime: Date.now(), trigger: 'manual', fetchImpl });
      return json(result);
    }
    if (path === '/api/telegram/test' && method === 'POST') {
      requireAdmin(user);
      const r = await sendTelegram(env, `🔔 <b>INDODAX QUANT</b>\nTes notifikasi berhasil (${jakarta()}).\nDikirim oleh ${user.email}.`, fetchImpl);
      return r.ok ? json(r) : bad(r.error ?? 'failed', r.skipped ? 412 : 502);
    }

    return bad('not_found', 404);
  } catch (e) {
    if (e instanceof AuthError) return bad(e.message, e.status);
    console.error('[api]', path, errorMessage(e));
    return bad('internal_error', 500, errorMessage(e).slice(0, 300));
  }
}

/** Emergency kill switch: block new entries first, then close every open position at the live bid. */
export async function killSwitch(env: Env, db: Db, actor: string, fetchImpl: FetchLike = fetch) {
  const acc = await defaultAccount(db);
  await db.rpc('paper_set_status', { p_account_id: acc.id, p_status: 'KILLED', p_reason: `kill switch by ${actor}` });
  const strategy = await db.select<{ params: unknown }>('strategy_configs', 'select=params&is_active=eq.true&limit=1');
  const params = mergeParams(strategy[0]?.params);
  const open = await db.select<{ id: number; pair_id: string; qty: string }>('paper_positions', `select=id,pair_id,qty&account_id=eq.${acc.id}&status=eq.OPEN`);
  const dx = new IndodaxClient(fetchImpl);
  const results: unknown[] = [];
  let closed = 0;
  for (const pos of open) {
    try {
      const t = await dx.getTicker(pos.pair_id);
      const fill = sellFillPrice(t.bid, params.slippageBps);
      const fee = feeFor(Number(pos.qty) * fill, params.feePct);
      const r = await db.rpc<{ ok: boolean; reason?: string; realized_pnl?: number }>('paper_close_position', {
        p_position_id: pos.id, p_requested_price: t.bid, p_fill_price: fill, p_fee: fee, p_slippage_bps: params.slippageBps, p_reason: 'KILL_SWITCH',
      });
      if (r.ok) closed++;
      results.push({ pair: pos.pair_id, ...r });
    } catch (e) {
      results.push({ pair: pos.pair_id, ok: false, error: errorMessage(e) });
    }
  }
  await sendTelegram(env, messages.killSwitch(`manual by ${actor}`, closed), fetchImpl).catch(() => undefined);
  return { ok: true, status: 'KILLED', closed, total: open.length, results };
}
