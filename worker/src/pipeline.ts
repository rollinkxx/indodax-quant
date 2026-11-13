// The per-minute job executed by the Cloudflare Cron Trigger ("* * * * *").
import type { Env, FetchLike } from './env';
import { Db } from './db';
import { IndodaxClient, type PairInfo, type ParsedTicker } from './indodax';
import { buildPairCandles, newestTrade, newTradesSince, planCoverage } from './ingest';
import { dispatchNotifications } from './notify';
import { messages, type NotificationItem } from './telegram';
import { errorMessage } from './http';
import { fillGaps, floorTo, type Candle, type Trade } from '../../shared/candles';
import { checkDataQuality, computeIndicatorsTail, evaluateSignal, mergeParams } from '../../shared/strategy';
import { buyFillPrice, computeStops, exitReason, feeFor, positionSize, riskState, sellFillPrice } from '../../shared/paper';

export interface Account {
  id: number;
  status: 'STOPPED' | 'RUNNING' | 'KILLED';
  kill_switch: boolean;
  cash_balance: number | string;
  equity: number | string;
  peak_equity: number | string;
  max_drawdown_pct: number | string;
  reset_at: string;
}

export interface Position {
  id: number;
  pair_id: string;
  qty: number | string;
  entry_price: number | string;
  cost_basis: number | string;
  stop_loss: number | string | null;
  take_profit: number | string | null;
}

interface PairCtx {
  id: string;
  symbol: string;
  ticker_id: string;
  is_maintenance: boolean;
  trade_min_base_currency: number | null;
  covered_until: string | null;
  last_trade_time: string | null;
  last_trade_tid: string | null;
}

interface BeginRun {
  ok: boolean;
  reason?: string;
  run_id: number;
  config: unknown;
  account: Account;
  pairs: PairCtx[];
  open_positions: Position[];
  day_start_equity: number | string | null;
  pair_catalog_age_seconds: number | null;
}

interface SignalRow {
  id: number;
  pair_id: string;
  side: 'BUY' | 'SELL';
  price: number | string;
  strength: number | string;
  reasons: string[];
  indicators: { atr14?: number | null };
  candle_time: string;
}

interface MtmResult {
  ok: boolean;
  equity: number;
  cash: number;
  peak_equity: number;
  drawdown_pct: number;
  max_drawdown_pct: number;
  open_positions: number;
}

export interface RunResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  reason?: string;
  runId?: number;
  steps?: Record<string, unknown>;
  errors?: string[];
}

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const toSec = (s: string | null) => (s ? Math.floor(Date.parse(s) / 1000) : null);

export interface PipelineOptions {
  scheduledTime: number; // ms
  trigger: 'cron' | 'manual';
  fetchImpl?: FetchLike;
  now?: () => number; // ms
}

export async function runPipeline(env: Env, opts: PipelineOptions): Promise<RunResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl);
  const dx = new IndodaxClient(fetchImpl);
  const t0 = now();

  // Cron ticks are keyed by their minute => the same tick can never be processed twice.
  const scheduledIso = opts.trigger === 'cron'
    ? iso(floorTo(Math.floor(opts.scheduledTime / 1000), 60))
    : new Date(opts.scheduledTime).toISOString();
  const ctx = await db.rpc<BeginRun>('begin_run', { p_scheduled: scheduledIso, p_trigger: opts.trigger, p_lock_ttl_seconds: 55 });
  if (!ctx?.ok) return { status: 'SKIPPED', reason: ctx?.reason ?? 'unknown', runId: ctx?.run_id };

  const steps: Record<string, unknown> = {};
  const errors: string[] = [];
  const notes: NotificationItem[] = [];
  const params = mergeParams(ctx.config);
  const nowSec = Math.floor(now() / 1000);
  const nowMin = floorTo(nowSec, 60);
  const account = ctx.account;
  let accountStatus = account.status;
  let lastEquity: number | null = Number(account.equity);
  let finalStatus: RunResult['status'] = 'SUCCESS';

  async function step<T>(name: string, fn: () => Promise<T>, summarize?: (r: T) => unknown): Promise<T | undefined> {
    const s = now();
    try {
      const r = await fn();
      steps[name] = { ok: true, ms: now() - s, ...(summarize ? { info: summarize(r) } : {}) };
      return r;
    } catch (e) {
      const msg = errorMessage(e);
      steps[name] = { ok: false, ms: now() - s, error: msg };
      errors.push(`${name}: ${msg}`);
      console.error(`[pipeline] ${name} failed:`, msg);
      return undefined;
    }
  }

  try {
    const pairs = ctx.pairs;
    const tracked = pairs.map((p) => p.id);

    // 1. Fetch INDODAX market data (official public API only)
    const needCatalog = (ctx.pair_catalog_age_seconds ?? 99999) > 3600 || pairs.some((p) => p.trade_min_base_currency === null);
    const market = await step('fetch_market', async () => {
      const [tickers, catalog] = await Promise.all([
        dx.getSummaries(),
        needCatalog ? dx.getPairs().catch((e) => { errors.push(`fetch_pairs: ${errorMessage(e)}`); return null; }) : Promise.resolve(null),
      ]);
      return { tickers, catalog };
    }, (r) => ({ tickers: r.tickers.length, catalog: r.catalog?.length ?? null }));

    const tickers = new Map<string, ParsedTicker>((market?.tickers ?? []).map((t) => [t.pair_id, t]));
    const freshTicker = (pairId: string): ParsedTicker | null => {
      const t = tickers.get(pairId);
      if (!t || t.bid <= 0 || t.ask <= 0 || t.ask < t.bid) return null;
      return nowSec - t.server_time <= params.maxTickerAgeSeconds ? t : null;
    };

    const tradeResults = await step('fetch_trades', async () => {
      const out = new Map<string, Trade[] | null>();
      await Promise.all(pairs.map(async (p) => {
        try {
          out.set(p.id, await dx.getTrades(p.id));
        } catch (e) {
          out.set(p.id, null);
          errors.push(`fetch_trades ${p.id}: ${errorMessage(e)}`);
        }
      }));
      return out;
    }, (r) => Object.fromEntries([...r].map(([k, v]) => [k, v?.length ?? 'error'])));

    // 2+3. Build candles (1m from trades, gap backfill from official OHLC history, 5m aggregation)
    const coverage = new Map<string, number | null>();
    const ingestPayload = { trades: [] as unknown[], candles: [] as unknown[], sync: [] as unknown[] };
    await step('build_candles', async () => {
      const info: Record<string, unknown> = {};
      await Promise.all(pairs.map(async (p) => {
        const trades = tradeResults?.get(p.id);
        const prevCovered = toSec(p.covered_until);
        if (!trades) { coverage.set(p.id, prevCovered); info[p.id] = 'no_trades_fetch'; return; }
        const plan = planCoverage(trades, prevCovered, nowSec);
        let history: Candle[] | null = [];
        if (plan.gap) {
          try {
            history = await dx.getHistory(p.symbol, '1', plan.gap.from, plan.gap.to - 1);
          } catch (e) {
            history = null;
            errors.push(`backfill ${p.id}: ${errorMessage(e)}`);
          }
        }
        const built = buildPairCandles(trades, plan, prevCovered, history);
        coverage.set(p.id, built.newCoveredUntil);
        const fresh = newTradesSince(trades, p.last_trade_tid);
        const newest = newestTrade(trades);
        for (const t of fresh) {
          ingestPayload.trades.push({ pair_id: p.id, tid: t.tid, traded_at: iso(t.ts), price: t.price, amount: t.amount, side: t.side });
        }
        for (const [tf, list] of [['1m', built.m1], ['5m', built.m5]] as const) {
          for (const c of list) {
            ingestPayload.candles.push({
              pair_id: p.id, timeframe: tf, open_time: iso(c.t), open: c.o, high: c.h, low: c.l, close: c.c,
              volume: c.v, trade_count: c.n, is_closed: true, source: c.source,
            });
          }
        }
        ingestPayload.sync.push({
          pair_id: p.id,
          covered_until: built.newCoveredUntil === null ? null : iso(built.newCoveredUntil),
          last_trade_time: newest ? iso(newest.ts) : null,
          last_trade_tid: newest?.tid ?? null,
        });
        info[p.id] = { trades: trades.length, new: fresh.length, m1: built.m1.length, m5: built.m5.length, backfilled: built.backfilled, gap: plan.gap ? true : false };
      }));
      return info;
    }, (r) => r);

    // Store everything in one transaction
    await step('store_market', async () => {
      const catalog: PairInfo[] | null = market?.catalog ?? null;
      return db.rpc('ingest_market', {
        p_pairs: catalog ?? [],
        p_tickers_latest: [...tickers.values()].map((t) => ({ ...t, server_time: iso(t.server_time) })),
        p_tickers_history: tracked.map((id) => tickers.get(id)).filter(Boolean).map((t) => ({
          pair_id: t!.pair_id, captured_at: iso(nowMin), last: t!.last, bid: t!.bid, ask: t!.ask, high: t!.high, low: t!.low,
          vol_traded: t!.vol_traded, vol_idr: t!.vol_idr, change_24h_pct: t!.change_24h_pct, server_time: iso(t!.server_time),
        })),
        p_trades: ingestPayload.trades,
        p_candles: ingestPayload.candles,
        p_sync: ingestPayload.sync,
      });
    }, (r) => r);

    // 4+5. Indicators + signals on COMPLETED 5m candles only
    const lastIndicators = new Map<string, { atr14: number | null }>();
    const analysis = await step('analyze', async () => {
      const map = await db.rpc<Record<string, [number, number, number, number, number, number, string][]>>('get_recent_candles', {
        p_pairs: tracked, p_timeframe: '5m', p_limit: 250,
      });
      const expectedLast = floorTo(nowSec, 300) - 300;
      const indicatorRows: unknown[] = [];
      const signalRows: unknown[] = [];
      const quality: Record<string, string> = {};
      for (const p of pairs) {
        const raw = (map?.[p.id] ?? []).filter((r) => Number(r[0]) <= expectedLast);
        const candles: Candle[] = raw.map((r) => ({
          t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
          n: Number(r[5]) > 0 ? 1 : 0, source: (r[6] as Candle['source']) ?? 'trades',
        }));
        if (candles.length === 0) { quality[p.id] = 'no_candles'; continue; }
        const series = fillGaps(candles, 300, expectedLast).slice(-250);
        const rows = computeIndicatorsTail(series, params, 3);
        for (const r of rows) {
          indicatorRows.push({
            pair_id: p.id, timeframe: '5m', open_time: iso(r.t), close: r.close, ema9: r.ema9, ema21: r.ema21, ema50: r.ema50,
            rsi14: r.rsi14, macd: r.macd, macd_signal: r.macdSignal, macd_hist: r.macdHist, atr14: r.atr14, vol_ma20: r.volMa20,
            support: r.support, resistance: r.resistance,
          });
        }
        const last = rows[rows.length - 1];
        lastIndicators.set(p.id, { atr14: last?.atr14 ?? null });
        const q = checkDataQuality({ candles: series, nowSec, intervalSec: 300, coveredUntilSec: coverage.get(p.id) ?? null, minCandles: params.minCandles });
        if (!q.ok) { quality[p.id] = q.reason!; continue; }
        if (p.is_maintenance) { quality[p.id] = 'pair_maintenance'; continue; }
        if (!freshTicker(p.id)) { quality[p.id] = 'stale_ticker'; continue; }
        if (rows.length < 2) { quality[p.id] = 'insufficient_rows'; continue; }
        quality[p.id] = 'ok';
        const decision = evaluateSignal(last, rows[rows.length - 2], series[series.length - 1].v, params);
        if (decision) {
          signalRows.push({
            pair_id: p.id, timeframe: '5m', candle_time: iso(last.t), side: decision.side, price: last.close,
            strength: decision.strength, reasons: decision.reasons, strategy: 'ema_rsi_volume',
            indicators: { ema9: last.ema9, ema21: last.ema21, ema50: last.ema50, rsi14: last.rsi14, macd_hist: last.macdHist, atr14: last.atr14, vol_ma20: last.volMa20, support: last.support, resistance: last.resistance },
          });
        }
      }
      const saved = await db.rpc<{ new_signals: SignalRow[] }>('save_analysis', { p_indicators: indicatorRows, p_signals: signalRows });
      return { newSignals: saved?.new_signals ?? [], quality };
    }, (r) => ({ new_signals: r.newSignals.length, quality: r.quality }));

    const newSignals = analysis?.newSignals ?? [];
    if (params.notifySignals) {
      for (const s of newSignals) {
        notes.push({ event_type: 'signal', dedupe_key: `signal:${s.id}`, message: messages.signal({ ...s, reasons: s.reasons ?? [] }) });
      }
    }

    // 6+7. Paper trading (simulation only) + portfolio
    await step('paper_trading', async () => {
      const actions: string[] = [];
      const open = new Map<string, Position>(ctx.open_positions.map((p) => [p.pair_id, p]));
      const sellSignals = new Set(newSignals.filter((s) => s.side === 'SELL').map((s) => s.pair_id));
      const pairMin = new Map(pairs.map((p) => [p.id, p.trade_min_base_currency]));

      const close = async (pos: Position, reason: string, bid: number) => {
        const fill = sellFillPrice(bid, params.slippageBps);
        const fee = feeFor(Number(pos.qty) * fill, params.feePct);
        const r = await db.rpc<{ ok: boolean; reason?: string; realized_pnl?: number }>('paper_close_position', {
          p_position_id: pos.id, p_requested_price: bid, p_fill_price: fill, p_fee: fee, p_slippage_bps: params.slippageBps, p_reason: reason,
        });
        if (r?.ok) {
          open.delete(pos.pair_id);
          actions.push(`close ${pos.pair_id} ${reason}`);
          notes.push({ event_type: reason === 'STOP_LOSS' ? 'stop_loss' : reason === 'TAKE_PROFIT' ? 'take_profit' : 'paper_sell',
            dedupe_key: `close:${pos.id}`, message: messages.paperSell({ pair_id: pos.pair_id, reason, qty: Number(pos.qty), fill, pnl: Number(r.realized_pnl) }) });
        } else {
          actions.push(`close ${pos.pair_id} rejected: ${r?.reason}`);
        }
        return r?.ok ?? false;
      };

      // a) Exits: stop loss / take profit / SELL signal. Open positions stay protected even when STOPPED.
      for (const pos of [...open.values()]) {
        const t = freshTicker(pos.pair_id);
        if (!t) { actions.push(`skip exit check ${pos.pair_id}: stale ticker`); continue; }
        const reason = exitReason(pos, t.bid) ?? (sellSignals.has(pos.pair_id) ? 'SIGNAL' : null);
        if (reason) await close(pos, reason, t.bid);
      }

      // b) Mark to market + snapshot
      const bids = Object.fromEntries(tracked.map((id) => [id, freshTicker(id)?.bid]).filter(([, v]) => v));
      let mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
      lastEquity = Number(mtm.equity);

      // c) Risk management
      const risk = riskState({ equity: Number(mtm.equity), peakEquity: Number(mtm.peak_equity), dayStartEquity: ctx.day_start_equity === null ? null : Number(ctx.day_start_equity), params });
      if (accountStatus === 'RUNNING' && risk.killSwitch) {
        await db.rpc('paper_set_status', { p_account_id: account.id, p_status: 'KILLED', p_reason: risk.reasons.join('; ') });
        accountStatus = 'KILLED';
        let closed = 0;
        for (const pos of [...open.values()]) {
          const t = freshTicker(pos.pair_id);
          if (t && (await close(pos, 'MAX_DRAWDOWN', t.bid))) closed++;
        }
        notes.push({ event_type: 'kill_switch', dedupe_key: `kill:${account.id}:${nowMin}`, message: messages.killSwitch(risk.reasons.join('; '), closed) });
        mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
        lastEquity = Number(mtm.equity);
      }

      // d) Entries on new BUY signals
      let entries = 0;
      if (accountStatus === 'RUNNING' && !account.kill_switch && !risk.blockEntries) {
        let cash = Number(mtm.cash);
        const buys = newSignals.filter((s) => s.side === 'BUY').sort((a, b) => Number(b.strength) - Number(a.strength));
        for (const s of buys) {
          if (open.size >= params.maxOpenPositions) { actions.push(`skip ${s.pair_id}: max positions`); break; }
          if (open.has(s.pair_id)) { actions.push(`skip ${s.pair_id}: already open`); continue; }
          const t = freshTicker(s.pair_id);
          if (!t) { actions.push(`skip ${s.pair_id}: stale ticker`); continue; }
          const fill = buyFillPrice(t.ask, params.slippageBps);
          const atrValue = s.indicators?.atr14 ?? lastIndicators.get(s.pair_id)?.atr14 ?? null;
          const stops = computeStops(fill, atrValue === null ? null : Number(atrValue), params);
          const size = positionSize({ equity: Number(mtm.equity), cash, entry: fill, stopLoss: stops.stopLoss, params, minNotional: Number(pairMin.get(s.pair_id) ?? 10000) || 10000 });
          if (size.qty <= 0) { actions.push(`skip ${s.pair_id}: ${size.reason}`); continue; }
          const r = await db.rpc<{ ok: boolean; reason?: string; position_id?: number; cash_after?: number }>('paper_open_position', {
            p_account_id: account.id, p_pair_id: s.pair_id, p_qty: size.qty, p_requested_price: t.ask, p_fill_price: fill,
            p_fee: size.fee, p_slippage_bps: params.slippageBps, p_stop_loss: stops.stopLoss, p_take_profit: stops.takeProfit,
            p_signal_id: s.id, p_idempotency_key: `open:${account.id}:${s.id}`, p_reason: 'SIGNAL',
          });
          if (r?.ok) {
            entries++;
            cash = Number(r.cash_after);
            open.set(s.pair_id, { id: r.position_id!, pair_id: s.pair_id, qty: size.qty, entry_price: fill, cost_basis: size.cost, stop_loss: stops.stopLoss, take_profit: stops.takeProfit });
            actions.push(`open ${s.pair_id}`);
            notes.push({ event_type: 'paper_buy', dedupe_key: `open:${r.position_id}`, message: messages.paperBuy({ pair_id: s.pair_id, qty: size.qty, fill, fee: size.fee, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, cashAfter: cash }) });
          } else {
            actions.push(`open ${s.pair_id} rejected: ${r?.reason}`);
          }
        }
      } else if (accountStatus !== 'RUNNING') {
        actions.push(`entries disabled: account ${accountStatus}`);
      } else if (risk.blockEntries) {
        actions.push(`entries blocked: ${risk.reasons.join('; ')}`);
      }
      if (entries > 0) {
        mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
        lastEquity = Number(mtm.equity);
      }
      return { status: accountStatus, equity: Number(mtm.equity), drawdown: Number(mtm.drawdown_pct), open: open.size, actions };
    }, (r) => r);

    // Daily P/L report at 00:00-00:14 WIB (17:00 UTC)
    const jakartaNow = new Date((nowSec + 7 * 3600) * 1000);
    if (jakartaNow.getUTCHours() === 0 && jakartaNow.getUTCMinutes() < 15) {
      await step('daily_report', async () => {
        const dateKey = new Date((nowSec + 7 * 3600 - 86400) * 1000).toISOString().slice(0, 10);
        const since = iso(nowSec - 86400);
        const [prev, closed] = await Promise.all([
          db.select<{ equity: string }>('portfolio_snapshots', `select=equity&account_id=eq.${account.id}&snapshot_time=lte.${since}&order=snapshot_time.desc&limit=1`),
          db.select<{ id: number }>('paper_positions', `select=id&account_id=eq.${account.id}&status=eq.CLOSED&closed_at=gte.${since}`),
        ]);
        const equity = lastEquity ?? Number(account.equity);
        const startEq = prev[0] ? Number(prev[0].equity) : Number(account.equity);
        const pnl = equity - startEq;
        notes.push({ event_type: 'daily_report', dedupe_key: `daily:${dateKey}`, message: messages.daily({ equity, pnl, pnlPct: startEq > 0 ? pnl / startEq * 100 : 0, trades: closed.length, drawdown: Number(account.max_drawdown_pct), status: accountStatus }) });
        return { dateKey };
      }, (r) => r);
    }

    // Hourly retention
    if (new Date(nowSec * 1000).getUTCMinutes() === 7) {
      await step('retention', () => db.rpc('run_retention'), (r) => r);
    }
  } catch (e) {
    errors.push(`unexpected: ${errorMessage(e)}`);
  } finally {
    const failedCore = ['fetch_market', 'store_market'].every((k) => (steps[k] as { ok?: boolean } | undefined)?.ok === false);
    finalStatus = errors.length === 0 ? 'SUCCESS' : failedCore ? 'FAILED' : 'PARTIAL';

    // 8. Telegram: system errors (max one per hour per error set) and hourly worker status
    if (errors.length) {
      const sig = errors.map((e) => e.split(':')[0]).sort().join(',');
      notes.push({ event_type: 'system_error', dedupe_key: `error:${floorTo(nowSec, 3600)}:${sig}`, message: messages.error(errors) });
    }
    if (new Date(nowSec * 1000).getUTCMinutes() === 0) {
      notes.push({ event_type: 'worker_status', dedupe_key: `heartbeat:${floorTo(nowSec, 3600)}`, message: messages.heartbeat({ status: finalStatus, durationMs: now() - t0, pairs: ctx.pairs.length, accountStatus, equity: lastEquity }) });
    }
    try {
      steps.notifications = { ok: true, info: await dispatchNotifications(env, db, notes, fetchImpl) };
    } catch (e) {
      steps.notifications = { ok: false, error: errorMessage(e) };
      errors.push(`notifications: ${errorMessage(e)}`);
      if (finalStatus === 'SUCCESS') finalStatus = 'PARTIAL';
    }

    // 9. Execution log + release lock
    try {
      await db.rpc('finish_run', { p_run_id: ctx.run_id, p_status: finalStatus, p_steps: steps, p_error: errors.length ? errors.join('\n').slice(0, 4000) : null });
    } catch (e) {
      console.error('[pipeline] finish_run failed', errorMessage(e));
    }
  }
  return { status: finalStatus, runId: ctx.run_id, steps, errors };
}
