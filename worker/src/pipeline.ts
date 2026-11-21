// The per-minute job executed by the Cloudflare Cron Trigger ("* * * * *").
import type { Env, FetchLike } from './env';
import { Db } from './db';
import { IndodaxClient, type PairInfo, type ParsedTicker } from './indodax';
import { buildPairCandles, findCoverageRecoveryStart, newestTrade, newTradesSince, planCoverage } from './ingest';
import { dispatchNotifications } from './notify';
import { messages, type NotificationItem } from './telegram';
import { errorMessage, HttpError } from './http';
import { fillGaps, floorTo, isValidCandle, type Candle, type Trade } from '../../shared/candles';
import { checkDataQuality, computeIndicatorsTail, diagnoseBuySignalWindow, diagnoseTrendContinuationWindow, evaluateMarketAction, mergeParams, validateCrossFieldParams } from '../../shared/strategy';
import { aggregateComplete, applyMtfToMarketAction, buildHigherSeries, contiguousObservedSuffix, HIGHER_TFS, lastCompleteBucket, MTF_WINDOW, trendState, type TfState } from '../../shared/mtf';
import { selectUniverse, universeDue } from '../../shared/universe';
import { buyFillPrice, computeStops, dynamicSlippageBps, effectiveFeePct, entryFeePct, entryGate, exitReason, exposureAllows, feeFor, netRewardRiskDiagnostics, positionSize, riskState, roundTripCostPct, sellFillPrice, shouldExitOnSignal, signalExitCoversCosts, timeStopHit, trailingStop } from '../../shared/paper';
import { assessQuote, valuationHealth, killSwitchState, type KillSwitchState } from '../../shared/quote';
import { createLeaseKeeper } from '../../shared/lease';
import { normalizeOrder } from '../../shared/orderNormalize';
import { combineDecision, emptyDecisionCounters, tallyDecision, type DecisionCounters } from '../../shared/decisionPipeline';
import { createBudget, BudgetExceeded } from './budget';

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
  opened_at?: string | null;
  /** Bid stored by the previous run's mark-to-market: the last observed price before this run. */
  last_price?: number | string | null;
}

interface PairCtx {
  id: string;
  symbol: string;
  ticker_id: string;
  is_maintenance: boolean;
  is_tracked?: boolean;
  in_universe?: boolean;
  trade_min_base_currency: number | null;
  trade_fee_percent_taker: number | null;
  price_precision?: number | null;
  covered_until: string | null;
  last_trade_time: string | null;
  last_trade_tid: string | null;
  htf_backfilled_at?: string | null;
}

type CandleRow = [number, number, number, number, number, number, string];
const toCandle = (r: CandleRow): Candle => ({
  t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
  n: Number(r[5]) > 0 ? 1 : 0, source: (r[6] as Candle['source']) ?? 'trades',
});

/** Max pairs per run that get their one-time 15m/1h OHLC history backfill (2 INDODAX calls each). */
export const HTF_BACKFILL_PER_RUN = 2;
/**
 * Max 1m OHLC recovery calls per run.
 *
 * A pair whose covered_until is stale asks for a full 24h bootstrap range, and a newly admitted pair
 * with no stored candles asks for the same. `fetchWithRetry` allows 2 retries, so each such pair can
 * cost 3 subrequests; with ~25 pairs in scope that alone exceeded the Worker's per-invocation
 * subrequest limit on 2026-11-20, after which every later step - including finish_run - failed with
 * "Too many subrequests" and the run was killed by the lease watchdog. Capping the queue keeps a
 * burst of new universe members (or one bad cursor) from starving the pipeline.
 */
export const HISTORY_BACKFILL_PER_RUN = 4;
/** Higher-timeframe buckets re-persisted per run (aggregated from 5m), per timeframe. */
const HTF_PERSIST: Record<string, number> = { '15m': 4, '1h': 2 };

/**
 * How many pairs one run can keep fresh.
 *
 * `strategy_configs.params.universeSize` is a *total scope* target, not a member count:
 * `selectUniverse` allocates `universeSize - pinned.size` slots to dynamic members, so with 8
 * pinned pairs a `universeSize` of 25 yields 17 members and 25 pairs in scope.
 *
 * Every pair in scope costs one trade fetch (3 subrequests when it retries), and the remaining
 * optional budget then funds the 1m/HTF backfill queues. With `SUBREQUEST_RESERVE` held back for
 * the mandatory steps, a 50-subrequest Free plan fits ~20 pairs per minute. Anything above this is
 * deferred to a later minute, so its candles lag by a few minutes — correct, but not "fresh".
 *
 * Measured production usage: avg 37.2 / max 41 of 50 subrequests with 25 pairs in scope, which
 * deferred ~5 pairs every run. Keep `universeSize` at or below this number on the Free plan; raise
 * it only together with `SUBREQUEST_LIMIT`.
 */
export const TRADE_FETCH_PER_RUN = 20;

/** True when the configured scope is larger than a single run can serve, so pairs will lag. */
export function universeExceedsCapacity(scopeSize: number, perRun = TRADE_FETCH_PER_RUN): boolean {
  return Number.isFinite(scopeSize) && scopeSize > perRun;
}

/**
 * Start index for a bounded, rotating work queue of `total` items that serves `window` per run.
 *
 * A `runIndex % total` cursor advances by ONE per run, so with a window smaller than the queue the
 * windows overlap and the tail is starved: with 12 pairs and a window of 5, a pair could wait 8 runs
 * (verified by simulation). Advancing by the window size instead tiles the queue, so every item is
 * served within `ceil(total / window)` runs (<= 3 for 12 pairs / 5). The clock is the cursor, so the
 * guarantee holds across runs without persisting state.
 */
export function rotationOffset(nowSec: number, total: number, window: number): number {
  if (total <= 0) return 0;
  const step = Math.max(1, Math.floor(window));
  const runIndex = Math.floor(nowSec / 60);
  return ((runIndex * step) % total + total) % total;
}

/** Rotate `items` so that the window starting at `offset` comes first. */
export function rotateWindow<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

interface BeginRun {
  ok: boolean;
  reason?: string;
  run_id: number;
  fence_token?: number;
  lease_expires_at?: string;
  config: unknown;
  account: Account;
  pairs: PairCtx[];
  catalog?: Record<string, boolean>; // pair id -> is_maintenance (whole INDODAX IDR catalog)
  open_positions: Position[];
  day_start_equity: number | string | null;
  pair_catalog_age_seconds: number | null;
  /** Phase begin_run recorded for this run (see FIX-07). */
  phase?: RunPhase;
  /** True when no signal evaluation has completed yet in the current hour (see FIX-07). */
  signals_due?: boolean;
}

/**
 * Lease TTL. Must exceed the worst-case *real* run, and must leave a margin against the cron
 * interval so a run never overruns into the next tick's lock.
 *
 * Measured on production (2026-11-20, post-fix): SUCCESS runs p99 = 22.5s, max = 24.2s; the 240s
 * rows are watchdog finalizations of zombie runs, not live execution. The cron fires every 60s, so
 * a 45s TTL leaves a 15s margin (>= 15s required) between the lease expiring and the next tick
 * trying to acquire it. The previous 55s left only 5s, which a single `fetchWithRetry` (3 attempts
 * x 8s timeout + backoff) can exceed - the run then keeps working past its fence and the next tick
 * sees a half-finished state.
 */
export const LEASE_TTL_SECONDS = 45;
/** The cron interval. Kept next to the TTL so the margin is checked, not assumed. */
export const CRON_INTERVAL_SECONDS = 60;
/** Minimum margin required between lease expiry and the next cron tick. */
export const MIN_LEASE_MARGIN_SECONDS = 15;

/** True when the lease TTL leaves at least `MIN_LEASE_MARGIN_SECONDS` before the next cron tick. */
export function leaseFitsCron(ttl = LEASE_TTL_SECONDS, interval = CRON_INTERVAL_SECONDS): boolean {
  return interval - ttl >= MIN_LEASE_MARGIN_SECONDS;
}

/** The strategy's base timeframe. Signals are only meaningful on a new bucket of this size. */
export const SIGNAL_TIMEFRAME_SECONDS = 300;

export type RunPhase = 'signal' | 'mark';

/**
 * Which phase this run executes. The cron fires every 60s but signals are computed on 300s candles,
 * so four of five runs would re-evaluate an unchanged candle. The signal phase runs once per bucket
 * (the first tick whose floorTo(now, 300) bucket has no completed signal run yet); every other tick is
 * a mark phase that only marks to market and checks exits.
 *
 * Ingest is deliberately NOT gated: `/api/trades` returns a rolling window, so skipping ingest for
 * four minutes would punch holes in the 1m candles. Only the expensive evaluation is skipped.
 */
export function runPhase(signalsDue: boolean | undefined): RunPhase {
  // Fail-safe: when the database predates the phase migration the field is absent. Falling back to
  // "mark" would silently stop opening positions; falling back to "signal" reproduces the exact
  // pre-FIX-07 behaviour (evaluate every tick), so the only cost is subrequests already budgeted.
  if (signalsDue === undefined) return 'signal';
  return signalsDue ? 'signal' : 'mark';
}

interface SignalRow {
  id: number;
  pair_id: string;
  side: 'BUY' | 'SELL';
  price: number | string;
  strength: number | string;
  reasons: string[];
  indicators: { atr14?: number | null; cross_time?: number | null };
  candle_time: string;
  /** True for a BUY replayed from pending_entries instead of a freshly stored signal. */
  retried?: boolean;
}

interface PendingEntryRow {
  pair_id: string;
  signal_id: number;
  candle_time: string;
  expires_at: string;
  strength: number | string;
  price: number | string;
  indicators: { atr14?: number | null };
  attempts: number;
}

/**
 * Entry rejections a later run may still act on. A gate that depends on the quote (spread, drift,
 * stale ticker) or on portfolio state (positions, cash, exposure, lease) is transient; the same
 * signal can be valid a minute later. Anything structural is not retried: the bracket economics of
 * a stored signal do not change, a missing fee catalog entry is a configuration gap, and the
 * strategy params / signal strength are fixed at signal time.
 */
const RETRYABLE_ENTRY_STAGES = new Set([
  'entry_gate',
  'market_data_gate',
  'sizing_gate',
  'normalization_gate',
  'lease_gate',
  'portfolio_gate',
]);
const NON_RETRYABLE_ENTRY_STAGES = new Set([
  'economics_gate',
  'fee_gate',
  'strength_gate',
  'strategy_params_gate',
  'account_gate',
  'risk_gate',
]);
/** Rejections inside a retryable stage that are still structural for that signal. */
const NON_RETRYABLE_ENTRY_REASONS = new Set(['already_open']);

/**
 * Stages whose rejection proves the stored signal can never fill: its bracket, fee, strength or the
 * strategy parameters will not change before the claim expires. Those also drop the queued claim.
 */
const PURGE_PENDING_STAGES = new Set(['economics_gate', 'fee_gate', 'strength_gate', 'strategy_params_gate']);

export function isRetryableEntryRejection(stage: string, reason: string): boolean {
  return RETRYABLE_ENTRY_STAGES.has(stage)
    && !NON_RETRYABLE_ENTRY_STAGES.has(stage)
    && !NON_RETRYABLE_ENTRY_REASONS.has(reason);
}

/**
 * Queued BUYs a later run may still fill: the pair must pass the same data-quality gate the SELL
 * retry path uses (analysis.quality[pair] === 'ok') and the trend setup must still hold. Without the
 * quality half a claim could be re-filled on a candle the engine refuses to analyse.
 */
export function selectRetryablePending(
  rows: PendingEntryRow[],
  analysis: { quality?: Record<string, string>; buyDiagnostics?: Record<string, { setup_valid?: boolean }> } | undefined,
): PendingEntryRow[] {
  return rows.filter((s) =>
    analysis?.quality?.[s.pair_id] === 'ok'
    && analysis?.buyDiagnostics?.[s.pair_id]?.setup_valid === true);
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
  /** Cloudflare subrequest cap per invocation. Free plan = 50; paid plans default to 10,000. */
  subrequestLimit?: number;
}

/**
 * Subrequests held back for the steps that must always run: store_market, analyze, save_analysis,
 * paper_trading, notifications, finish_run and lease heartbeats. Without this reserve the optional
 * work (trade fetches, history backfill) can starve them and the run dies after doing the expensive
 * part.
 */
export const SUBREQUEST_RESERVE = 18;
/** Default Cloudflare Workers Free plan cap. */
export const DEFAULT_SUBREQUEST_LIMIT = 50;

export function parseSubrequestLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SUBREQUEST_LIMIT;
}

/** True when PostgREST could not resolve the function, i.e. its migration is not applied yet. */
function isMissingRpc(e: unknown): boolean {
  return e instanceof HttpError && e.status === 404 && /PGRST202/.test(e.body ?? '');
}

/** Minutes without a SUCCESS run before the operator is paged. */
export const OUTAGE_ALARM_MINUTES = 15;

/**
 * Build the outage alert for a run that has not produced a SUCCESS for a while.
 *
 * The check has to run before `begin_run` acquires the pipeline lock: while the lock is stuck every
 * tick returns SKIPPED immediately, so nothing inside the run — including the notifications step —
 * ever executes. Between 2026-11-19 14:00Z and 2026-11-20 09:03Z 1.011 runs died that way and no
 * alarm fired.
 *
 * Returns null when the log is fresh, or when the RPC is unusable: a missing migration must not turn
 * every tick into a false alarm.
 */
export async function outageAlarmNote(
  db: Pick<Db, 'rpc'>, nowSec: number, nowMin: number,
): Promise<NotificationItem | null> {
  let lastOk: string | null;
  try {
    // execution_logs has no account_id column yet, so the RPC ignores the argument (see the migration).
    lastOk = await db.rpc<string | null>('last_success_at', { p_account_id: 0 }, { retries: 1 });
  } catch {
    return null;
  }
  if (typeof lastOk !== 'string') return null;
  const lastOkMs = Date.parse(lastOk);
  if (!Number.isFinite(lastOkMs)) return null;
  const staleMin = Math.floor((nowSec * 1000 - lastOkMs) / 60000);
  if (staleMin < OUTAGE_ALARM_MINUTES) return null;
  return {
    event_type: 'outage',
    // One alert per 15-minute bucket: a stuck lock fails every tick for hours.
    dedupe_key: `outage:${Math.floor(nowMin / 900)}`,
    message: `⚠️ <b>PIPELINE OUTAGE</b>\nTidak ada run SUCCESS selama ${staleMin} menit.\nTerakhir: ${lastOk}`,
  };
}

export async function runPipeline(env: Env, opts: PipelineOptions): Promise<RunResult> {
  const rawFetch = opts.fetchImpl ?? fetch;
  const limit = opts.subrequestLimit ?? parseSubrequestLimit(env.SUBREQUEST_LIMIT);
  const budget = createBudget(rawFetch as typeof fetch, limit);
  const fetchImpl = budget.fetch as FetchLike;
  const now = opts.now ?? Date.now;
  const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl);
  const dx = new IndodaxClient(fetchImpl);
  const t0 = now();

  // Cron ticks are keyed by their minute => the same tick can never be processed twice.
  const scheduledIso = opts.trigger === 'cron'
    ? iso(floorTo(Math.floor(opts.scheduledTime / 1000), 60))
    : new Date(opts.scheduledTime).toISOString();
  // A stuck lock makes this tick return below, so it never reaches the notifications step where the
  // alarm normally rides. The check is cheap here: the run does nothing else.
  const bootSec = Math.floor(now() / 1000);
  const ctx = await db.rpc<BeginRun>('begin_run', {
    p_scheduled: scheduledIso, p_trigger: opts.trigger, p_lock_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (!ctx?.ok) {
    const note = await outageAlarmNote(db, bootSec, floorTo(bootSec, 60));
    if (note) {
      try { await dispatchNotifications(env, db, [note], fetchImpl); } catch { /* best effort */ }
    }
    return { status: 'SKIPPED', reason: ctx?.reason ?? 'unknown', runId: ctx?.run_id };
  }

  // Fencing token for this lease. Every heartbeat renewal and the final release must present it, so a
  // run that overran its TTL can never mutate state or free a lease another run now owns.
  const fenceToken = Number.isFinite(ctx.fence_token) ? Number(ctx.fence_token) : null;
  const leaseKeeper = fenceToken === null ? null : createLeaseKeeper({
    runId: String(ctx.run_id),
    token: fenceToken,
    ttlSeconds: LEASE_TTL_SECONDS,
    now,
    renew: async (runId, token, ttl) => {
      const r = await db.rpc<{ ok: boolean; reason?: string; token?: number; expires_at_ms?: number }>(
        'renew_pipeline_lease', { p_run_id: Number(runId), p_fence_token: token, p_lock_ttl_seconds: ttl },
      );
      return {
        ok: !!r?.ok,
        reason: r?.reason,
        token: r?.token === undefined ? undefined : Number(r.token),
        expiresAtMs: r?.expires_at_ms === undefined ? undefined : Number(r.expires_at_ms),
      };
    },
  });
  // Two distinct failure modes that need different operator responses:
  //  - lease_expired: this run outlived its TTL (it is too slow) -> shrink the work, not the TTL;
  //  - lease_stolen:  another run acquired the fence (a zombie overlap) -> investigate overlap.
  const leaseLost: { reason: string | null; kind: 'expired' | 'stolen' | null } = { reason: null, kind: null };
  function classifyLeaseLoss(raw: string): 'expired' | 'stolen' {
    // The RPC answers `lease_not_held` both for an expired lease and a lost owner; the client-side
    // guard raises `lease_expired_before_renewal` only when its own clock already passed the deadline.
    return /expired|not_held/i.test(raw) ? 'expired' : 'stolen';
  }
  // Called before every state mutation that can place/close an order. If the fence is gone, the run
  // must stop instead of writing to an account another run now controls.
  async function guardLease(): Promise<boolean> {
    if (!leaseKeeper) return true;
    try {
      await leaseKeeper.ensure();
      return true;
    } catch (e) {
      const raw = e instanceof Error ? e.message.replace(/^pipeline lease lost: /, '') : String(e);
      leaseLost.reason = raw;
      leaseLost.kind = classifyLeaseLoss(raw);
      errors.push(`lease: ${raw}`);
      return false;
    }
  }

  const steps: Record<string, unknown> = {};
  const errors: string[] = [];
  const notes: NotificationItem[] = [];
  const params = mergeParams(ctx.config);

  // A strategy config that is individually valid but jointly broken must not open new risk. The admin
  // API rejects such saves, yet the row can still reach the pipeline (direct SQL, a migration, or a
  // save made before the check existed). `atrTakeProfitMultiplier <= atrStopMultiplier` puts the take
  // profit closer than the stop loss, so no win rate below the implied breakeven can profit.
  //
  // Entries are blocked, exits are NOT: withholding a SELL to protect the config would trap open
  // positions past their stop, which is strictly worse than the bad bracket itself.
  const paramErrors = validateCrossFieldParams(params)
    .filter((f) => f.level === 'error')
    .map((f) => `${f.code}: ${f.message}`);
  const entriesBlocked = paramErrors.length > 0;
  if (entriesBlocked) {
    for (const e of paramErrors) errors.push(`invalid_strategy_params: ${e}`);
  }
  const nowSec = Math.floor(now() / 1000);
  const nowMin = floorTo(nowSec, 60);
  const account = ctx.account;
  let accountStatus = account.status;
  let lastEquity: number | null = Number(account.equity);
  let finalStatus: RunResult['status'] = 'SUCCESS';
  const phase = ctx.phase ?? runPhase(ctx.signals_due);

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
    // Freshness is decided in one place (shared/quote.ts): a crossed, non-positive, stale or
    // future-dated quote is not tradable. `assessQuote` reports which of those failed.
    const quoteAssessment = (pairId: string) => {
      const t = tickers.get(pairId);
      return assessQuote(t ? { bid: t.bid, ask: t.ask, serverTimeSec: t.server_time } : null, nowSec, { maxAgeSec: params.maxTickerAgeSeconds });
    };
    const freshTicker = (pairId: string): ParsedTicker | null => (quoteAssessment(pairId).ok ? tickers.get(pairId)! : null);

    // Capacity event, emitted every run (not only on the 15-minute universe refresh) so an oversized
    // scope is visible in execution_logs instead of silently deferring pairs forever.
    if (universeExceedsCapacity(pairs.length)) {
      const dropped = Math.max(0, pairs.length - TRADE_FETCH_PER_RUN);
      steps.universe_capacity = {
        ok: false,
        reason: 'universe_exceeds_capacity',
        universeSize: pairs.length,
        capacity: TRADE_FETCH_PER_RUN,
        droppedPairs: dropped,
      };
      errors.push(
        `universe_capacity: ${pairs.length} pairs in scope > capacity ${TRADE_FETCH_PER_RUN}; ` +
        `${dropped} pair(s) deferred this run and rotated out next run. Lower universeSize or raise SUBREQUEST_LIMIT.`,
      );
    }

    // 1b. Dynamic universe (from the summaries already fetched; takes effect on the next run)
    const currentUniverse = new Set(pairs.filter((p) => p.in_universe).map((p) => p.id));
    if (market && ctx.catalog && universeDue(nowSec, currentUniverse.size, params.universeMode)) {
      await step('universe', async () => {
        const catalog = ctx.catalog!;
        const result = selectUniverse({
          tickers: market.tickers,
          known: new Set(Object.keys(catalog)),
          maintenance: new Set(Object.entries(catalog).filter(([, m]) => m).map(([id]) => id)),
          pinned: new Set(pairs.filter((p) => p.is_tracked).map((p) => p.id)),
          current: currentUniverse,
          nowSec,
          params,
        });
        // one statement: membership changes + refreshed ranks
        await db.rpc('set_universe', { p_members: result.members.map((m) => ({ id: m.pair_id, rank: m.rank })) });
        if (params.notifyUniverse && (result.added.length || result.removed.length)) {
          notes.push({
            event_type: 'universe', dedupe_key: `universe:${nowMin}`,
            message: messages.universe({ added: result.added, removed: result.removed, members: result.members.map((m) => m.pair_id), pinned: pairs.filter((p) => p.is_tracked).map((p) => p.id), mode: params.universeMode }),
          });
        }
        return result;
      }, (r) => ({ mode: params.universeMode, members: r.members.map((m) => m.pair_id), added: r.added, removed: r.removed, eligible: r.eligible, rejected: r.rejected }));
    }

    // 1c. Check actual higher-timeframe coverage on every run. The legacy timestamp
    // marker is not proof that a complete history backfill was stored.
    const htfBackfilled = new Set<string>();
    const htfCandles: unknown[] = [];
    const storedHtf: Record<string, Record<string, CandleRow[]>> = params.mtfMode !== 'off'
      ? (await step('load_htf_coverage_state', async () =>
          db.rpc<Record<string, Record<string, CandleRow[]>>>('get_recent_candles_multi', {
            p_pairs: tracked, p_timeframes: HIGHER_TFS.map((h) => h.tf), p_limit: MTF_WINDOW,
          }),
        (r) => Object.fromEntries(HIGHER_TFS.map((h) => [
          h.tf, Object.fromEntries(tracked.map((id) => [id, r?.[h.tf]?.[id]?.length ?? 0])),
        ]))) ?? {})
      : {};
    if (params.mtfMode !== 'off' && phase === 'signal') {
      const expectedLast5m = floorTo(nowSec, 300) - 300;
      const needsHtfHistory = (p: PairCtx) => HIGHER_TFS.some((h) => {
        const lastComplete = lastCompleteBucket(expectedLast5m, h.sec);
        const stored = (storedHtf[h.tf]?.[p.id] ?? []).map(toCandle);
        return contiguousObservedSuffix(stored, h.sec, lastComplete) < params.mtfMinCandles;
      });
      const candidates = pairs.filter(needsHtfHistory)
        .sort((a, b) => Number(!!b.is_tracked) - Number(!!a.is_tracked) || a.id.localeCompare(b.id));
      // Rotate the bounded work queue. The offset advances by the *window* (not by one) so the queue
      // is tiled instead of slid: with a window smaller than the queue, a one-per-run cursor leaves
      // the tail unserved for many runs (see rotationOffset).
      const htfWindow = Math.min(HTF_BACKFILL_PER_RUN, Math.max(0, budget.remaining() - SUBREQUEST_RESERVE - 2));
      const rotated = rotateWindow(candidates, rotationOffset(nowSec, candidates.length, htfWindow));
      const todo = rotated.slice(0, htfWindow);
      if (todo.length) {
        const htfBudget = budget.child(Math.max(0, budget.remaining() - SUBREQUEST_RESERVE));
        const dxHtf = new IndodaxClient(htfBudget.fetch as FetchLike);
        await step('backfill_htf', async () => {
          const info: Record<string, unknown> = {};
          await Promise.all(todo.map(async (p) => {
            try {
              const counts: Record<string, { received: number; contiguous: number }> = {};
              let pairReady = true;
              for (const h of HIGHER_TFS) {
                const from = nowSec - (MTF_WINDOW + 4) * h.sec;
                const list = await dxHtf.getHistory(p.symbol, h.historyTf, from, nowSec);
                const lastComplete = lastCompleteBucket(expectedLast5m, h.sec);
                const done = list.filter((c) =>
                  c.t % h.sec === 0 && c.t + h.sec <= nowSec && isValidCandle(c),
                );
                for (const c of done) {
                  htfCandles.push({ pair_id: p.id, timeframe: h.tf, open_time: iso(c.t), open: c.o, high: c.h, low: c.l, close: c.c,
                    volume: c.v, trade_count: 0, is_closed: true, source: 'history' });
                }
                const previous = (storedHtf?.[h.tf]?.[p.id] ?? []).map(toCandle);
                const merged = buildHigherSeries(previous, done, h.sec, lastComplete, MTF_WINDOW);
                const contiguous = contiguousObservedSuffix(merged, h.sec, lastComplete);
                counts[h.tf] = { received: done.length, contiguous };
                if (contiguous < params.mtfMinCandles) pairReady = false;
              }
              // Store the marker only after BOTH mandatory timeframes are fully warmed up.
              if (pairReady) htfBackfilled.add(p.id);
              info[p.id] = { timeframes: counts, ready: pairReady };
            } catch (e) {
              errors.push(`backfill_htf ${p.id}: ${errorMessage(e)}`);
              info[p.id] = { ready: false, error: errorMessage(e) };
            }
          }));
          return info;
        }, (r) => r);
      }
    }

    // Inspect persisted 5m candles before ingest. Older workers could advance
    // covered_until while leaving holes behind, so the cursor alone is not proof
    // that the last 60 bars are contiguous.
    const recoveryCandles = await step('load_coverage_state', async () =>
      db.rpc<Record<string, CandleRow[]>>('get_recent_candles', { p_pairs: tracked, p_timeframe: '5m', p_limit: 250 }),
    (r) => Object.fromEntries(Object.entries(r ?? {}).map(([id, rows]) => [id, rows?.length ?? 0])));

    const tradeFetchFailures: Record<string, {
      http_status: number;
      failure_class: string;
      retryable: boolean;
      attempts: number;
    }> = {};
    // Trade fetches are the largest single cost (one relay call per pair, 3 attempts on failure).
    // They run in a child budget so retries can never eat the reserve the core steps need; a pair
    // that does not fit is deferred for this minute and keeps its old cursor.
    //
    // The 1m history slice is held back *before* the trades spend the pool. On 2026-11-20 the trades
    // consumed every optional slot, leaving exactly SUBREQUEST_RESERVE, so `remaining - RESERVE` was
    // 0 on every run: the backfill never ran, `covered_until` could never advance past the hole, and
    // the 5m series froze at 03:20 while runs kept reporting SUCCESS.
    const historyReserve = Math.max(0, Math.min(HISTORY_BACKFILL_PER_RUN, budget.remaining() - SUBREQUEST_RESERVE));
    const optional = budget.child(Math.max(0, budget.remaining() - SUBREQUEST_RESERVE - historyReserve));
    const dxOptional = new IndodaxClient(optional.fetch as FetchLike);
    const byPriority = [...pairs].sort((a, b) => Number(!!b.is_tracked) - Number(!!a.is_tracked) || a.id.localeCompare(b.id));
    // Rotate the tail so a capped queue does not permanently starve the same pairs. The offset
    // advances by the effective window so the queue tiles; a one-per-run cursor overlapped windows
    // and left the tail waiting up to ceil(n/window) x window runs.
    const tradeWindow = Math.max(1, Math.min(TRADE_FETCH_PER_RUN, budget.remaining() - SUBREQUEST_RESERVE - historyReserve));
    const tradeOrder = rotateWindow(byPriority, rotationOffset(nowSec, byPriority.length, tradeWindow));
    const tradeDeferred = new Set<string>();

    const tradeResults = await step('fetch_trades', async () => {
      const out = new Map<string, Trade[] | null>();
      await Promise.all(tradeOrder.map(async (p) => {
        if (optional.exhausted()) { tradeDeferred.add(p.id); return; }
        try {
          out.set(p.id, await dxOptional.getTrades(p.id));
        } catch (e) {
          out.set(p.id, null);
          if (e instanceof BudgetExceeded) { tradeDeferred.add(p.id); return; }
          const status = e instanceof HttpError ? e.status : 0;
          const body = e instanceof HttpError ? (e.body ?? '') : '';
          tradeFetchFailures[p.id] = {
            http_status: status,
            failure_class: status === 503 && body.includes('SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED')
              ? 'upstream_service_degraded'
              : status >= 500
                ? 'upstream_http_error'
                : status === 408
                  ? 'upstream_timeout'
                  : 'request_error',
            retryable: status === 429 || status === 408 || status >= 500,
            attempts: e instanceof HttpError ? e.attempts : 1,
          };
          errors.push(`fetch_trades ${p.id}: ${errorMessage(e)}`);
        }
      }));
      return out;
    }, (r) => ({
      ...Object.fromEntries([...r].map(([k, v]) => [k, v?.length ?? 'error'])),
      ...(tradeDeferred.size ? { deferred_budget: [...tradeDeferred] } : {}),
      ...(Object.keys(tradeFetchFailures).length ? { failures: tradeFetchFailures } : {}),
    }));

    // 2+3. Build candles (1m from trades, gap backfill from official OHLC history, 5m aggregation)
    const coverage = new Map<string, number | null>();
    const ingestPayload = { trades: [] as unknown[], candles: [] as unknown[], sync: [] as unknown[] };
    await step('build_candles', async () => {
      const info: Record<string, unknown> = {};
      const usable = pairs.filter((p) => tradeResults?.get(p.id));
      for (const p of pairs) {
        if (!tradeResults?.get(p.id)) { coverage.set(p.id, toSec(p.covered_until)); info[p.id] = 'no_trades_fetch'; }
      }

      const plans = new Map<string, ReturnType<typeof planCoverage>>();
      const recoveryStarts = new Map<string, number | null>();
      for (const p of usable) {
        const trades = tradeResults!.get(p.id)!;
        const prevCovered = toSec(p.covered_until);
        const stored5m = (recoveryCandles?.[p.id] ?? []).map(toCandle);
        const recoveryFrom = recoveryCandles ? findCoverageRecoveryStart(stored5m, nowSec, params.minCandles) : null;
        recoveryStarts.set(p.id, recoveryFrom);
        const planningCursor = recoveryFrom !== null && prevCovered !== null
          ? Math.min(prevCovered, recoveryFrom)
          : prevCovered;
        plans.set(p.id, planCoverage(trades, planningCursor, nowSec));
      }

      // Rotate then cap: a pair that keeps failing cannot starve the queue, and the cap follows the
      // subrequests actually left. History is optional work; store_market/analyze/finish_run are not.
      const wanting = usable.filter((p) => plans.get(p.id)!.historyRange).map((p) => p.id);
      const affordable = Math.min(HISTORY_BACKFILL_PER_RUN, historyReserve);
      const budgeted = new Set(rotateWindow(wanting, rotationOffset(nowSec, wanting.length, affordable)).slice(0, Math.max(0, affordable)));
      const historyBudget = budget.child(Math.max(0, affordable));
      const dxHistory = new IndodaxClient(historyBudget.fetch as FetchLike);

      await Promise.all(usable.map(async (p) => {
        const trades = tradeResults!.get(p.id)!;
        const prevCovered = toSec(p.covered_until);
        const plan = plans.get(p.id)!;
        const deferred = plan.historyRange !== null && !budgeted.has(p.id);
        // null, not []: a deferred or unsent request must never look like "the source published
        // nothing", which now means the frontier may advance.
        let history: Candle[] | null = null;
        // Both causes leave the same evidence in the database: the cursor must not move past a hole
        // that this run did not repair, or the next run will trust it and skip the backfill.
        let held = deferred;
        if (plan.historyRange && !deferred) {
          try {
            history = await dxHistory.getHistory(p.symbol, '1', plan.historyRange.from, plan.historyRange.to - 1);
          } catch (e) {
            history = null;
            if (e instanceof BudgetExceeded) {
              held = true;
              info[`${p.id}_history`] = 'deferred_budget';
            } else {
              errors.push(`backfill ${p.id}: ${errorMessage(e)}`);
            }
          }
        }
        const built = buildPairCandles(trades, plan, prevCovered, history);
        if (plan.historyRange && !deferred && !held && !built.historyComplete && history !== null) {
          errors.push(`backfill ${p.id}: incomplete_coverage (${built.missingMinutes} missing minute(s))`);
        }
        coverage.set(p.id, held ? prevCovered : built.newCoveredUntil);
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
          covered_until: held
            ? (prevCovered === null ? null : iso(prevCovered))
            : (built.newCoveredUntil === null ? null : iso(built.newCoveredUntil)),
          last_trade_time: newest ? iso(newest.ts) : null,
          last_trade_tid: newest?.tid ?? null,
          htf_backfilled_at: htfBackfilled.has(p.id) ? iso(nowSec) : null,
        });
        info[p.id] = {
          trades: trades.length, new: fresh.length, m1: built.m1.length, m5: built.m5.length,
          backfilled: built.backfilled, recovery_from: recoveryStarts.get(p.id) ?? null,
          history_range: plan.historyRange, history_complete: built.historyComplete,
          history_source: !plan.historyRange ? undefined : history === null ? 'error' : history.length === 0 ? 'unpublished' : 'ok',
          history_missing_minutes: built.missingMinutes, history_deferred: held || undefined,
        };
      }));
      // pairs whose trade fetch failed still record a successful HTF backfill (one sync row per pair)
      const synced = new Set((ingestPayload.sync as { pair_id: string }[]).map((x) => x.pair_id));
      for (const id of htfBackfilled) {
        if (!synced.has(id)) ingestPayload.sync.push({ pair_id: id, covered_until: null, last_trade_time: null, last_trade_tid: null, htf_backfilled_at: iso(nowSec) });
      }
      ingestPayload.candles.push(...htfCandles);
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

    // 4+5. Indicators + signals on COMPLETED 5m candles only.
    // Skipped on mark-phase runs: the candle has not changed since the signal run that evaluated it, so
    // re-running indicators and signal evaluation would burn subrequests for an identical result. MTF
    // backfill is also signal-only (its data only feeds the evaluation).
    const lastIndicators = new Map<string, { atr14: number | null }>();
    const analysis = phase === 'signal' ? await step('analyze', async () => {
      const mtfOn = params.mtfMode !== 'off';
      const [map, htfMap] = await Promise.all([
        db.rpc<Record<string, CandleRow[]>>('get_recent_candles', { p_pairs: tracked, p_timeframe: '5m', p_limit: 250 }),
        mtfOn
          ? db.rpc<Record<string, Record<string, CandleRow[]>>>('get_recent_candles_multi', { p_pairs: tracked, p_timeframes: HIGHER_TFS.map((h) => h.tf), p_limit: MTF_WINDOW })
          : Promise.resolve({} as Record<string, Record<string, CandleRow[]>>),
      ]);
      const htfSave: unknown[] = [];
      const mtfInfo: Record<string, string> = {};
      const mtfBlocked: Record<string, string> = {};
      const buyDiagnostics: Record<string, Record<string, unknown>> = {};
      const continuationDiagnostics: Record<string, Record<string, unknown>> = {};
      const expectedLast = floorTo(nowSec, 300) - 300;
      const indicatorRows: unknown[] = [];
      const signalRows: unknown[] = [];
      const quality: Record<string, string> = {};
      for (const p of pairs) {
        const raw = (map?.[p.id] ?? []).filter((r) => Number(r[0]) <= expectedLast);
        const candles: Candle[] = raw.map(toCandle);
        if (candles.length === 0) {
          quality[p.id] = 'no_candles';
          buyDiagnostics[p.id] = { stage: 'indicators_not_ready', candidate_5m: false, outcome: 'blocked_by_no_candles' };
          continuationDiagnostics[p.id] = { setup: 'ema21_pullback_reclaim', stage: 'indicators_not_ready', candidate_5m: false, outcome: 'blocked_by_no_candles' };
          continue;
        }
        const series = fillGaps(candles, 300, expectedLast).slice(-250);

        // Higher timeframes (completed candles only): stored history + exact aggregates of the 5m series
        const states: TfState[] = [];
        if (mtfOn) {
          for (const h of HIGHER_TFS) {
            const lastComplete = lastCompleteBucket(expectedLast, h.sec);
            const aggregated = aggregateComplete(series, h.sec);
            const stored = (htfMap?.[h.tf]?.[p.id] ?? []).map(toCandle);
            const hs = buildHigherSeries(stored, aggregated, h.sec, lastComplete);
            const st = trendState(h.tf, hs, lastComplete, params);
            states.push(st);
            for (const c of aggregated.slice(-HTF_PERSIST[h.tf])) {
              htfSave.push({ pair_id: p.id, timeframe: h.tf, open_time: iso(c.t), open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, trade_count: c.n, source: c.source });
            }
            if (hs.length) {
              const hr = computeIndicatorsTail(hs, { ...params, emaFast: params.mtfEmaFast, emaSlow: params.mtfEmaSlow }, 1).at(-1);
              if (hr) {
                indicatorRows.push({
                  pair_id: p.id, timeframe: h.tf, open_time: iso(hr.t), close: hr.close, ema9: hr.ema9, ema21: hr.ema21, ema50: hr.ema50,
                  rsi14: hr.rsi14, macd: hr.macd, macd_signal: hr.macdSignal, macd_hist: hr.macdHist, atr14: hr.atr14, vol_ma20: hr.volMa20,
                  support: hr.support, resistance: hr.resistance,
                });
              }
            }
          }
          mtfInfo[p.id] = states.map((st) => `${st.tf}:${st.trend}`).join(' ');
        }
        // enough rows to look back for a recent EMA cross (crossLookback) plus the candle before it
        // The tail must cover the longer of the two cross lookbacks: the SELL gate reads its own window.
        const rows = computeIndicatorsTail(series, params, Math.max(3, params.crossLookback + 1, params.sellCrossLookback + 1));
        const rowVolumes = series.slice(-rows.length).map((c) => c.v);
        const buyDiag = diagnoseBuySignalWindow(rows, rowVolumes, params);
        const continuationDiag = diagnoseTrendContinuationWindow(rows, rowVolumes, params);
        const continuationBase = {
          setup: 'ema21_pullback_reclaim',
          stage: continuationDiag.stage,
          candidate_5m: continuationDiag.ready,
          filters: {
            trend: continuationDiag.trendOk,
            pullback_reclaimed: continuationDiag.pullbackReclaimed,
            no_recent_cross: !continuationDiag.recentCross,
            rsi: continuationDiag.rsiOk,
            volume: continuationDiag.volumeOk,
            extension: continuationDiag.extensionOk,
          },
          metrics: {
            rsi: continuationDiag.rsi,
            volume_ratio: continuationDiag.volumeRatio,
            extension_pct: continuationDiag.extensionPct,
          },
          execution: 'shadow_only',
        };
        for (const r of rows.slice(-3)) {
          indicatorRows.push({
            pair_id: p.id, timeframe: '5m', open_time: iso(r.t), close: r.close, ema9: r.ema9, ema21: r.ema21, ema50: r.ema50,
            rsi14: r.rsi14, macd: r.macd, macd_signal: r.macdSignal, macd_hist: r.macdHist, atr14: r.atr14, vol_ma20: r.volMa20,
            support: r.support, resistance: r.resistance,
          });
        }
        const last = rows[rows.length - 1];
        lastIndicators.set(p.id, { atr14: last?.atr14 ?? null });
        const q = checkDataQuality({ candles: series, nowSec, intervalSec: 300, coveredUntilSec: coverage.get(p.id) ?? null, minCandles: params.minCandles });
        const diagnosticBase = {
          stage: buyDiag.stage,
          candidate_5m: buyDiag.ready,
          bars_since_cross: buyDiag.barsSinceCross,
          setup_valid: buyDiag.setupValid,
          cross_time: buyDiag.crossTime ?? null,
          filters: {
            trend: buyDiag.trendOk, rsi: buyDiag.rsiOk, volume: buyDiag.volumeOk, extension: buyDiag.extensionOk,
          },
          metrics: {
            rsi: buyDiag.rsi,
            volume_ratio: buyDiag.volumeRatio,
            extension_pct: buyDiag.extensionPct,
          },
          data_quality: q.ok ? 'ok' : q.reason,
          mtf: mtfOn ? states.map((st) => `${st.tf}:${st.trend}`).join(' ') : 'off',
        };
        if (!q.ok) {
          quality[p.id] = q.reason!;
          buyDiagnostics[p.id] = { ...diagnosticBase, outcome: 'blocked_by_data_quality' };
          continuationDiagnostics[p.id] = { ...continuationBase, outcome: 'blocked_by_data_quality', data_quality: q.reason };
          continue;
        }
        if (p.is_maintenance) {
          quality[p.id] = 'pair_maintenance';
          buyDiagnostics[p.id] = { ...diagnosticBase, outcome: 'blocked_by_maintenance' };
          continuationDiagnostics[p.id] = { ...continuationBase, outcome: 'blocked_by_maintenance' };
          continue;
        }
        if (!freshTicker(p.id)) {
          quality[p.id] = 'stale_ticker';
          buyDiagnostics[p.id] = { ...diagnosticBase, outcome: 'blocked_by_stale_ticker' };
          continuationDiagnostics[p.id] = { ...continuationBase, outcome: 'blocked_by_stale_ticker' };
          continue;
        }
        if (rows.length < 2) {
          quality[p.id] = 'insufficient_rows';
          buyDiagnostics[p.id] = { ...diagnosticBase, outcome: 'blocked_by_insufficient_rows' };
          continuationDiagnostics[p.id] = { ...continuationBase, outcome: 'blocked_by_insufficient_rows' };
          continue;
        }
        quality[p.id] = 'ok';
        continuationDiagnostics[p.id] = { ...continuationBase, data_quality: 'ok', outcome: continuationDiag.ready ? 'shadow_candidate' : continuationDiag.stage };
        const rawAction = evaluateMarketAction(rows, rowVolumes, params);
        const raw5m = rawAction.signal;
        const { action: finalAction, mtf } = applyMtfToMarketAction(rawAction, states, params.mtfMode, {
          filterSell: params.mtfFilterSell,
          minSellStrength: params.mtfSellBlockStrength,
        });
        if (raw5m && mtf.blocked) mtfBlocked[p.id] = `${raw5m.side} ${mtf.blocked}`;
        buyDiagnostics[p.id] = {
          ...diagnosticBase,
          raw_signal_side: raw5m?.side ?? null,
          raw_market_action: rawAction.action,
          market_action: finalAction.action,
          hold_reason: finalAction.action === 'HOLD' ? finalAction.reason : null,
          outcome: (raw5m?.side === 'BUY') !== buyDiag.ready
            ? 'diagnostic_mismatch'
            : buyDiag.ready
              ? (mtf.blocked ? 'blocked_by_mtf' : mtf.decision?.side === 'BUY' ? 'passed_mtf' : 'diagnostic_mismatch')
              : raw5m?.side === 'SELL' ? 'sell_signal' : buyDiag.stage,
          mtf_block: mtf.blocked ?? null,
        };
        const decision = mtf.decision;
        if (decision) {
          signalRows.push({
            pair_id: p.id, timeframe: '5m', candle_time: iso(last.t), side: decision.side, price: last.close,
            strength: decision.strength, reasons: decision.reasons, strategy: mtfOn ? 'ema_rsi_volume_mtf' : 'ema_rsi_volume',
            indicators: {
              ema9: last.ema9, ema21: last.ema21, ema50: last.ema50, rsi14: last.rsi14, macd_hist: last.macdHist, atr14: last.atr14, vol_ma20: last.volMa20, support: last.support, resistance: last.resistance,
              // Identity of the setup: lets a later run tell "the same cross" from "a new one".
              cross_time: decision.crossTime ?? null,
              ...(mtfOn ? { mtf: mtf.summary, mtf_mode: params.mtfMode } : {}),
            },
          });
        }
      }
      const saved = await db.rpc<{ new_signals: SignalRow[] }>('save_analysis', { p_indicators: indicatorRows, p_signals: signalRows, p_candles: htfSave });
      return { newSignals: saved?.new_signals ?? [], quality, mtf: mtfInfo, mtfBlocked, buyDiagnostics, continuationDiagnostics };
    }, (r) => ({
      new_signals: r.newSignals.length,
      new_signal_details: r.newSignals.map((s) => ({
        signal_id: s.id, pair_id: s.pair_id, side: s.side, strength: Number(s.strength),
      })),
      quality: r.quality,
      ...(Object.keys(r.mtf).length ? { mtf: r.mtf } : {}),
      ...(Object.keys(r.mtfBlocked).length ? { mtf_blocked: r.mtfBlocked } : {}),
      buy_diagnostics: r.buyDiagnostics,
      continuation_diagnostics: r.continuationDiagnostics,
    })) : undefined;

    const newSignals = analysis?.newSignals ?? [];
    if (params.notifySignals) {
      const heldPairs = new Set(ctx.open_positions.map((p) => p.pair_id));
      for (const s of newSignals) {
        // long-only engine: a SELL with nothing to sell is noise (it is still stored in trading_signals)
        if (s.side === 'SELL' && !heldPairs.has(s.pair_id)) continue;
        // One notification per cross, not per stored signal row: the lookback can store the same
        // cross on two consecutive candles and each row has its own id.
        const crossKey = s.indicators?.cross_time ?? s.id;
        notes.push({
          event_type: 'signal',
          dedupe_key: `signal:${s.pair_id}:${s.side}:${crossKey}`,
          message: messages.signal({ ...s, reasons: s.reasons ?? [] }),
        });
      }
    }

    // 6+7. Paper trading (simulation only) + portfolio
    const paperTrading = await step('paper_trading', async () => {
      const actions: string[] = [];
      // Failures of the position-protection safety nets (stored-SELL lookup, trailing-stop persistence).
      // A position stays open when these break, so they must degrade the run status instead of hiding in
      // `actions`: otherwise a run reports SUCCESS while the stop/exit net is silently disabled.
      const degraded: string[] = [];
      const openedEntries: { pair_id: string; signal_id: number; position_id: number; qty: number; fill_price: number; notional: number; fee: number }[] = [];
      const entryRejections: { pair_id: string; signal_id: number; stage: string; reason: string; metrics?: Record<string, number> }[] = [];
      const purgeSignalIds: number[] = [];
      const rejectEntry = (signal: SignalRow, stage: string, reason: string, metrics?: Record<string, number>) => {
        entryRejections.push({
          pair_id: signal.pair_id,
          signal_id: signal.id,
          stage,
          reason,
          ...(metrics ? { metrics } : {}),
        });
        actions.push(`skip ${signal.pair_id}: ${reason}`);
        if (PURGE_PENDING_STAGES.has(stage)) purgeSignalIds.push(signal.id);
      };
      const open = new Map<string, Position>(ctx.open_positions.map((p) => [p.pair_id, p]));
      const sellSignals = new Set(newSignals.filter((s) => s.side === 'SELL').map((s) => s.pair_id));
      // Strength drives the exit policy (a strong SELL leaves even at a loss), so keep the per-pair value.
      const sellStrength = new Map<string, number>();
      // The SELL signal that triggered an exit is recorded on the resulting order so the exit signal's
      // own quality can be measured later (16/16 SELL orders used to store a NULL signal_id).
      const sellSignalId = new Map<string, number>();
      for (const s of newSignals) {
        if (s.side === 'SELL') {
          sellStrength.set(s.pair_id, Number(s.strength));
          sellSignalId.set(s.pair_id, Number(s.id));
        }
      }
      const pairMin = new Map(pairs.map((p) => [p.id, p.trade_min_base_currency]));
      const pairFee = new Map(pairs.map((p) => [p.id, p.trade_fee_percent_taker]));
      const pairPrecision = new Map(pairs.map((p) => [p.id, p.price_precision ?? null]));
      const decisionCounters: DecisionCounters = emptyDecisionCounters();

      // Valuation health: a single open position without a fresh quote makes equity unverifiable, so
      // new entries are blocked and the run is flagged instead of sizing against a stale mark.
      const freshQuotePairs = new Set(tracked.filter((id) => quoteAssessment(id).ok));
      const valuation = valuationHealth([...open.keys()], freshQuotePairs);
      if (valuation.status === 'UNKNOWN') {
        for (const pair of valuation.unpricedPairs) actions.push(`unpriced open position ${pair}: valuation UNKNOWN`);
      }

      // Exits cap the dynamic penalty at 2x: an unknown volume must not turn every stop into a 4x fill.
      const slipFor = (pairId: string, exitSide = false) => (params.dynamicSlippage
        ? dynamicSlippageBps(params.slippageBps, tickers.get(pairId)?.vol_idr, { maxMultiplier: exitSide ? 2 : 4 })
        : params.slippageBps);
      // Per-side fee charged for a pair; 'pair_taker' uses the real INDODAX taker fee (see effectiveFeePct).
      const feePctFor = (pairId: string) => effectiveFeePct(params, pairFee.get(pairId));

      // Note event type per close reason; anything unmapped (TIME_STOP, SIGNAL, DAILY_LOSS, ...) is a plain sell.
      const CLOSE_EVENT_TYPES: Record<string, string> = {
        STOP_LOSS: 'stop_loss', TAKE_PROFIT: 'take_profit', TRAILING_STOP: 'trailing_stop',
      };

      const close = async (pos: Position, reason: string, bid: number, fillBidOverride: number | null = null) => {
        // Never close against a lease we no longer hold: a superseded run must not mutate the account.
        if (!(await guardLease())) { actions.push(`close ${pos.pair_id} skipped: lease lost`); return false; }
        const slip = slipFor(pos.pair_id, true);
        // A take profit fills at the target at best: if the bid already gapped past it, booking the
        // higher price was paper profit the market never had to give.
        const fillBid = fillBidOverride !== null ? fillBidOverride : bid;
        const fill = sellFillPrice(fillBid, slip);
        const fee = feeFor(Number(pos.qty) * fill, feePctFor(pos.pair_id));
        const closeArgs = {
          p_position_id: pos.id, p_requested_price: fillBid, p_fill_price: fill, p_fee: fee, p_slippage_bps: slip, p_reason: reason,
        };
        // Deploy order must not matter. A database that has not taken the signal_id migration answers
        // 404 for the seven-argument form, and a position must still be closed: the id is bookkeeping,
        // so it is dropped rather than leaving the position unprotected.
        const r = await db.rpc<{ ok: boolean; reason?: string; realized_pnl?: number }>('paper_close_position', {
          ...closeArgs,
          // Only a signal exit has a signal behind it; a bracket or a risk exit has none.
          p_signal_id: reason === 'SIGNAL' ? (sellSignalId.get(pos.pair_id) ?? null) : null,
        }).catch((e: unknown) => {
          if (!isMissingRpc(e)) throw e;
          return db.rpc<{ ok: boolean; reason?: string; realized_pnl?: number }>('paper_close_position', closeArgs);
        });
        if (r?.ok) {
          open.delete(pos.pair_id);
          actions.push(`close ${pos.pair_id} ${reason}`);
          notes.push({ event_type: CLOSE_EVENT_TYPES[reason] ?? 'paper_sell',
            dedupe_key: `close:${pos.id}`, message: messages.paperSell({ pair_id: pos.pair_id, reason, qty: Number(pos.qty), fill, pnl: Number(r.realized_pnl) }) });
        } else {
          actions.push(`close ${pos.pair_id} rejected: ${r?.reason}`);
        }
        return r?.ok ?? false;
      };

      // a0) A SELL is stored once (ON CONFLICT DO NOTHING), so it is only "new" in the run that saved it. If that run skipped the
      // exit check (stale ticker, rejected close, orphaned run) the SELL would be lost. Re-read stored SELLs for open positions on
      // pairs that pass data quality; paper_close_position makes the close idempotent (duplicate / not OPEN is rejected).
      // On a mark-phase run there is no fresh analysis, so gate on quote freshness instead of candle
      // quality. The recovery net must still run every minute: a SELL stored by the signal run is only
      // "new" in that one run, and a position left unprotected for four minutes is worse than a lookup.
      const pendingSellPairs = [...open.keys()].filter((id) =>
        analysis ? analysis.quality?.[id] === 'ok' : freshQuotePairs.has(id));
      if (pendingSellPairs.length > 0) {
        try {
          const pending = await db.rpc<SignalRow[]>('get_pending_sell_signals', { p_pairs: pendingSellPairs });
          if (Array.isArray(pending)) {
            for (const s of pending) {
              if (s.side !== 'SELL') continue;
              sellSignals.add(s.pair_id);
              if (!sellStrength.has(s.pair_id)) sellStrength.set(s.pair_id, Number(s.strength ?? 0));
              if (!sellSignalId.has(s.pair_id)) sellSignalId.set(s.pair_id, Number(s.id));
            }
          }
        } catch (e) {
          const msg = `pending sell lookup failed: ${errorMessage(e)}`;
          actions.push(msg);
          degraded.push(msg);
        }
      }

      // Risk state as of the last completed run, used by the exit policy. The post-mark-to-market
      // state below governs entries; an exit must not depend on a valuation that has not run yet.
      const riskAtExit = riskState({
        equity: Number(account.equity),
        peakEquity: Number(account.peak_equity),
        dayStartEquity: ctx.day_start_equity === null ? null : Number(ctx.day_start_equity),
        params,
      });

      // a) Exits: stop loss / take profit / trailing stop / time stop / SELL signal. Open positions stay protected even when STOPPED.
      for (const pos of [...open.values()]) {
        const t = freshTicker(pos.pair_id);
        if (!t) { actions.push(`skip exit check ${pos.pair_id}: stale ticker`); continue; }
        // pos.last_price is the bid the previous run marked this position at, so a gap that cleared
        // both brackets resolves to the stop instead of the take profit.
        const prevBid = pos.last_price === null || pos.last_price === undefined ? null : Number(pos.last_price);
        let reason: string | null = exitReason(pos, t.bid, prevBid);
        if (!reason) {
          // Trailing stop: ratchet the stop up with price (takes effect from the next run).
          // The break-even floor must cover the spread too: the exit fills at the bid, so a stop
          // set only above fees+slippage can still close net negative on a wide pair.
          const spreadPct = t.bid > 0 ? (t.ask - t.bid) / t.bid * 100 : 0;
          const trailCostPct = roundTripCostPct(feePctFor(pos.pair_id), slipFor(pos.pair_id, true), spreadPct);
          const newStop = trailingStop(pos, t.bid, lastIndicators.get(pos.pair_id)?.atr14 ?? null, params, trailCostPct);
          if (newStop !== null) {
            // The ratchet is a state mutation: never persist it under a lease we no longer hold.
            if (!(await guardLease())) { actions.push(`trail ${pos.pair_id} skipped: lease lost`); continue; }
            try {
              // Absolute set filtered on the OPEN row: replaying it is a no-op, so a transient 503 may retry.
              await db.update('paper_positions', `id=eq.${pos.id}&status=eq.OPEN`, { stop_loss: newStop }, { retries: 1 });
              pos.stop_loss = newStop;
              actions.push(`trail ${pos.pair_id} stop -> ${newStop}`);
            } catch (e) {
              const msg = `trail ${pos.pair_id} failed: ${errorMessage(e)}`;
              actions.push(msg);
              degraded.push(msg);
            }
          }
        }
        if (!reason && timeStopHit(pos.opened_at ? Date.parse(pos.opened_at) : null, now(), params)) reason = 'TIME_STOP';
        if (!reason && sellSignals.has(pos.pair_id)) {
          const covers = signalExitCoversCosts({
            entryPrice: Number(pos.entry_price), qty: Number(pos.qty), costBasis: Number(pos.cost_basis),
            bid: t.bid, feePct: feePctFor(pos.pair_id), slippageBps: slipFor(pos.pair_id, true),
          });
          const verdict = shouldExitOnSignal({
            coversCosts: covers,
            strength: sellStrength.get(pos.pair_id) ?? 0,
            riskBlocked: riskAtExit.blockEntries,
            drawdownPct: riskAtExit.drawdownPct,
            maxDrawdownPct: params.maxDrawdownPct,
            policy: {
              requireProfit: params.signalExitRequireProfit,
              forceStrength: params.signalExitForceStrength,
              forceOnRiskBlock: true,
            },
          });
          if (verdict.exit) {
            reason = 'SIGNAL';
            actions.push(`signal exit ${pos.pair_id}: ${verdict.reason}`);
          } else {
            actions.push(`signal exit ${pos.pair_id} withheld: ${verdict.reason}`);
          }
        }
        if (reason) {
          const tp = pos.take_profit === null || pos.take_profit === undefined ? null : Number(pos.take_profit);
          const fillBid = reason === 'TAKE_PROFIT' && tp !== null && Number.isFinite(tp) ? Math.min(t.bid, tp) : t.bid;
          await close(pos, reason, t.bid, fillBid);
        }
      }

      // b) Mark to market + snapshot. MTM writes equity, peak, drawdown and the snapshot row, so it
      // must respect the fence exactly like an order. If the lease is gone, stop before writing and
      // return early with the degraded status so the operator sees an unmarked run instead of a
      // silently half-updated account.
      const bids = Object.fromEntries(tracked.map((id) => [id, freshTicker(id)?.bid]).filter(([, v]) => v));
      if (!(await guardLease())) {
        actions.push('mark_to_market skipped: lease lost');
        degraded.push('mark_to_market skipped: lease lost');
        return { status: accountStatus, equity: Number(account.equity), drawdown: 0, open: open.size, actions, degraded,
          buy_signals_received: 0, entries_opened: 0, opened_entries: [], entry_rejections: [], entry_rejection_counts: {},
          risk_block_reasons: [], kill_state: killSwitchState({ status: accountStatus, killSwitch: account.kill_switch, openPositions: open.size }), valuation_status: 'UNKNOWN',
          unpriced_pairs: [], decision_counters: decisionCounters };
      }
      let mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
      lastEquity = Number(mtm.equity);

      // c) Risk management
      const risk = riskState({ equity: Number(mtm.equity), peakEquity: Number(mtm.peak_equity), dayStartEquity: ctx.day_start_equity === null ? null : Number(ctx.day_start_equity), params });
      let killState: KillSwitchState = killSwitchState({ status: accountStatus, killSwitch: account.kill_switch, openPositions: open.size });
      if (accountStatus === 'RUNNING' && risk.killSwitch) {
        if (!(await guardLease())) { actions.push('kill switch skipped: lease lost'); degraded.push('kill switch skipped: lease lost'); return { status: accountStatus, equity: Number(mtm.equity), drawdown: Number(mtm.drawdown_pct), open: open.size, actions, degraded, buy_signals_received: 0, entries_opened: 0, opened_entries: [], entry_rejections: [], entry_rejection_counts: {}, risk_block_reasons: [], kill_state: killSwitchState({ status: accountStatus, killSwitch: account.kill_switch, openPositions: open.size }), valuation_status: valuation.status, unpriced_pairs: valuation.unpricedPairs, decision_counters: decisionCounters }; }
        await db.rpc('paper_set_status', { p_account_id: account.id, p_status: 'KILLED', p_reason: risk.reasons.join('; ') });
        accountStatus = 'KILLED';
        let closed = 0;
        let failures = 0;
        for (const pos of [...open.values()]) {
          const t = freshTicker(pos.pair_id);
          if (t) { if (await close(pos, 'MAX_DRAWDOWN', t.bid)) closed++; else failures++; }
          else failures++; // no fresh quote => cannot prove the position is flat
        }
        killState = killSwitchState({ status: accountStatus, killSwitch: true, openPositions: open.size, closeFailures: failures });
        // A kill switch that leaves a position open is not "ok": surface it in the run so an operator sees it.
        if (killState === 'KILLED_NOT_FLAT' || killState === 'KILL_CLOSE_FAILED') {
          const msg = `kill switch ${killState}: ${open.size} position(s) still open after flatten`;
          actions.push(msg);
          degraded.push(msg);
        }
        notes.push({ event_type: 'kill_switch', dedupe_key: `kill:${account.id}:${nowMin}`, message: messages.killSwitch(risk.reasons.join('; '), closed) });
        mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
        lastEquity = Number(mtm.equity);
      }

      // c2) Daily loss limit: flatten instead of only blocking new entries
      if (accountStatus === 'RUNNING' && risk.dailyLossHit && params.closeOnDailyLoss && open.size > 0) {
        let closed = 0;
        for (const pos of [...open.values()]) {
          const t = freshTicker(pos.pair_id);
          if (t && (await close(pos, 'DAILY_LOSS', t.bid))) closed++;
        }
        if (closed > 0) {
          mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
          lastEquity = Number(mtm.equity);
        }
      }

      // d) Entries on new BUY signals. Shadow continuation diagnostics are intentionally not used here.
      let entries = 0;
      const buys = newSignals.filter((s) => s.side === 'BUY').sort((a, b) => Number(b.strength) - Number(a.strength));

      // d0) Retry BUYs a transient gate rejected in an earlier run. A stored signal is only "new" in
      // the run that saved it and the BUY diagnostic never re-emits an already-qualified cross, so
      // without this queue a wide spread at the wrong second dropped the entry permanently.
      // Only the signal phase has fresh diagnostics: on a mark-phase run the setup cannot be
      // re-validated, and consuming the queue blind would delete live claims.
      let pendingBuys: PendingEntryRow[] = [];
      if (analysis) {
        try {
          const rows = await db.rpc<PendingEntryRow[]>('get_pending_entries', {
            p_account_id: account.id, p_pairs: tracked, p_now: iso(nowMin),
          });
          // The RPC already filters on expiry; re-check it here so a Worker running against an older
          // function definition still cannot act on an expired claim.
          if (Array.isArray(rows)) {
            pendingBuys = rows.filter((r) => {
              const expiresAt = Date.parse(r.expires_at);
              return Number.isFinite(expiresAt) && expiresAt > nowMin * 1000;
            });
          }
        } catch (e) {
          const msg = `pending entry lookup failed: ${errorMessage(e)}`;
          actions.push(msg);
          degraded.push(msg);
        }
      }
      const stillValid = selectRetryablePending(pendingBuys, analysis);
      const invalidated = pendingBuys.filter((s) => !stillValid.includes(s));
      if (invalidated.length > 0) {
        try {
          await db.rpc('delete_pending_entries', {
            p_account_id: account.id,
            p_signal_ids: invalidated.map((s) => Number(s.signal_id)),
          });
          actions.push(`pending entry invalidated: ${invalidated.map((s) => s.pair_id).join(',')}`);
        } catch (e) {
          const msg = `pending entry cleanup failed: ${errorMessage(e)}`;
          actions.push(msg);
          degraded.push(msg);
        }
      }
      // A fresh signal for the same pair wins: it carries the current candle's price and strength.
      const seenPairs = new Set(buys.map((s) => s.pair_id));
      const mergedBuys: SignalRow[] = [
        ...buys,
        ...stillValid
          .filter((s) => !seenPairs.has(s.pair_id))
          .map((s) => ({
            id: Number(s.signal_id),
            pair_id: s.pair_id,
            side: 'BUY' as const,
            price: s.price,
            strength: s.strength,
            reasons: [],
            candle_time: s.candle_time,
            indicators: s.indicators,
            retried: true,
          })),
      ].sort((a, b) => Number(b.strength) - Number(a.strength));
      for (const s of mergedBuys) if (s.retried) actions.push(`retry queued entry ${s.pair_id}`);

      // An invalid parameter set is rejected here, at the entry gate, and not earlier: exits must keep
      // running so an already-open position can still hit its stop.
      if (entriesBlocked) {
        for (const s of mergedBuys) rejectEntry(s, 'strategy_params_gate', 'invalid_strategy_params');
      } else
      // An unverifiable equity (unpriced open position) blocks new risk, on top of the account/risk gates.
      if (accountStatus === 'RUNNING' && !account.kill_switch && !risk.blockEntries && !valuation.blockEntries) {
        let cash = Number(mtm.cash);
        for (let i = 0; i < mergedBuys.length; i++) {
          const s = mergedBuys[i];
          if (open.size >= params.maxOpenPositions) {
            for (const queued of mergedBuys.slice(i)) rejectEntry(queued, 'portfolio_gate', 'max_positions');
            break;
          }
          if (open.has(s.pair_id)) { rejectEntry(s, 'portfolio_gate', 'already_open'); continue; }
          if (params.minSignalStrength > 0 && Number(s.strength) < params.minSignalStrength) {
            rejectEntry(s, 'strength_gate', 'below_min_strength', {
              strength: Number(s.strength),
              min_strength: params.minSignalStrength,
            });
            continue;
          }
          const t = freshTicker(s.pair_id);
          if (!t) { rejectEntry(s, 'market_data_gate', 'stale_ticker'); continue; }
          const slip = slipFor(s.pair_id);
          // Entry-side fee must be the real per-pair taker fee; a missing catalog value rejects the
          // entry instead of falling back, so the economics gate below cannot be fed a cheap fee.
          const feeRes = entryFeePct(params, pairFee.get(s.pair_id));
          if ('reason' in feeRes) { rejectEntry(s, 'fee_gate', feeRes.reason); continue; }
          const feePct = feeRes.pct;
          const fill = buyFillPrice(t.ask, slip);
          const atrValue = s.indicators?.atr14 ?? lastIndicators.get(s.pair_id)?.atr14 ?? null;
          const stops = computeStops(fill, atrValue === null ? null : Number(atrValue), params);
          // A retried signal carries the price it was first seen at, so judging it against the
          // strict drift limit rejects every retry after a normal move; setupValid's extension check
          // is what stops the entry chasing.
          const gateParams = s.retried ? { ...params, maxEntryDriftPct: params.maxRetryDriftPct } : params;
          const gate = entryGate({ bid: t.bid, ask: t.ask, signalPrice: Number(s.price), stopLoss: stops.stopLoss, fill }, gateParams);
          if (gate) {
            const mid = (t.ask + t.bid) / 2;
            const stopDistance = fill - stops.stopLoss;
            const spread = t.ask - t.bid;
            rejectEntry(s, 'entry_gate', gate, {
              bid_price: t.bid,
              ask_price: t.ask,
              signal_price: Number(s.price),
              entry_price: fill,
              stop_price: stops.stopLoss,
              target_price: stops.takeProfit,
              spread_pct: mid > 0 ? spread / mid * 100 : 0,
              stop_distance_pct: fill > 0 ? stopDistance / fill * 100 : 0,
              target_distance_pct: fill > 0 ? (stops.takeProfit - fill) / fill * 100 : 0,
              spread_to_stop_pct: stopDistance > 0 ? spread / stopDistance * 100 : 0,
              ask_drift_pct: Number(s.price) > 0 ? (t.ask - Number(s.price)) / Number(s.price) * 100 : 0,
              slippage_bps: slip,
              fee_pct: feePct,
              // Metrics are numeric: 1 marks a replayed claim, with the drift limit it was judged by.
              ...(s.retried ? { retried: 1, drift_limit_pct: gateParams.maxEntryDriftPct } : {}),
            });
            continue;
          }
          const economics = netRewardRiskDiagnostics({
            entry: fill, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
            feePct, exitSlippageBps: slip, minRatio: params.minNetRewardRiskRatio,
          });
          if (economics.reason) {
            rejectEntry(s, 'economics_gate', economics.reason, {
              bid_price: t.bid,
              ask_price: t.ask,
              signal_price: Number(s.price),
              stop_price: stops.stopLoss,
              target_price: stops.takeProfit,
              spread_pct: (t.ask + t.bid) > 0 ? (t.ask - t.bid) / ((t.ask + t.bid) / 2) * 100 : 0,
              spread_to_stop_pct: fill > stops.stopLoss ? (t.ask - t.bid) / (fill - stops.stopLoss) * 100 : 0,
              slippage_bps: slip,
              ...economics.metrics,
            });
            continue;
          }
          const size = positionSize({ equity: Number(mtm.equity), cash, entry: fill, stopLoss: stops.stopLoss, exitSlippageBps: slip, params: { ...params, feePct }, minNotional: Number(pairMin.get(s.pair_id) ?? 10000) || 10000 });
          if (size.qty <= 0) { rejectEntry(s, 'sizing_gate', size.reason ?? 'sizing_rejected'); continue; }
          // Normalize to the pair's tick/step/min-notional before persisting: an order INDODAX would
          // reject must be rejected here, not silently rounded into a position that cannot exist.
          const norm = normalizeOrder({
            qty: size.qty, price: fill,
            rules: { pricePrecision: pairPrecision.get(s.pair_id) ?? null, minNotional: Number(pairMin.get(s.pair_id) ?? 10000) || 10000 },
          });
          if (!norm.ok) { rejectEntry(s, 'normalization_gate', norm.reason ?? 'normalization_rejected', { requested_qty: size.qty, notional: norm.notional }); continue; }
          if (norm.qtyReduced > 0) actions.push(`normalize ${s.pair_id}: qty ${size.qty} -> ${norm.qty}`);
          // Everything downstream must use the normalized order: the stored position is norm.qty at
          // norm.price, so sizing/exposure/MTM from the requested qty would drift from the database.
          const fillPrice = norm.price;
          const normNotional = norm.qty * fillPrice;
          const normFee = feeFor(normNotional, feePct);
          const normCost = normNotional + normFee;
          const openCost = [...open.values()].reduce((a, x) => a + Number(x.cost_basis), 0);
          if (!exposureAllows(openCost, normCost, Number(mtm.equity), params)) { rejectEntry(s, 'portfolio_gate', 'max_total_exposure'); continue; }
          if (normCost > cash) { rejectEntry(s, 'sizing_gate', 'insufficient_cash'); continue; }
          if (!(await guardLease())) { rejectEntry(s, 'lease_gate', 'lease_lost'); break; }
          const r = await db.rpc<{ ok: boolean; reason?: string; position_id?: number; cash_after?: number }>('paper_open_position', {
            p_account_id: account.id, p_pair_id: s.pair_id, p_qty: norm.qty, p_requested_price: t.ask, p_fill_price: fillPrice,
            p_fee: normFee, p_slippage_bps: slip, p_stop_loss: stops.stopLoss, p_take_profit: stops.takeProfit,
            p_signal_id: s.id, p_idempotency_key: `open:${account.id}:${s.id}`, p_reason: 'SIGNAL',
          });
          if (r?.ok) {
            entries++;
            cash = Number(r.cash_after);
            open.set(s.pair_id, { id: r.position_id!, pair_id: s.pair_id, qty: norm.qty, entry_price: fillPrice, cost_basis: normCost, stop_loss: stops.stopLoss, take_profit: stops.takeProfit });
            openedEntries.push({ pair_id: s.pair_id, signal_id: s.id, position_id: r.position_id!, qty: norm.qty, fill_price: fillPrice, notional: normNotional, fee: normFee });
            actions.push(`open ${s.pair_id}`);
            notes.push({ event_type: 'paper_buy', dedupe_key: `open:${r.position_id}`, message: messages.paperBuy({ pair_id: s.pair_id, qty: norm.qty, fill: fillPrice, fee: normFee, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit, cashAfter: cash }) });
            if (s.retried) {
              try {
                await db.rpc('delete_pending_entries', { p_account_id: account.id, p_signal_ids: [s.id] });
              } catch { /* the claim expires on its own; a filled entry must not fail on cleanup */ }
            }
          } else {
            rejectEntry(s, 'persistence', r?.reason ?? 'paper_open_rejected');
          }
        }
      } else {
        const reason = accountStatus !== 'RUNNING'
          ? `account_${accountStatus.toLowerCase()}`
          : account.kill_switch
            ? 'kill_switch_active'
            : 'risk_blocked';
        const stage = accountStatus !== 'RUNNING' ? 'account_gate' : 'risk_gate';
        for (const s of buys) rejectEntry(s, stage, reason);
        if (buys.length === 0 && accountStatus !== 'RUNNING') actions.push(`entries disabled: account ${accountStatus}`);
        if (buys.length === 0 && risk.blockEntries) actions.push(`entries blocked: ${risk.reasons.join('; ')}`);
      }
      if (entries > 0) {
        mtm = await db.rpc<MtmResult>('paper_mark_to_market', { p_account_id: account.id, p_prices: bids, p_snapshot_time: iso(nowMin) });
        lastEquity = Number(mtm.equity);
      }
      // e) Queue the rejections a later run may still fill, and drop the claims that can never fill.
      // A signal that fails on the quote now may be fine on the next tick; one that fails on its own
      // bracket economics never will be.
      if (purgeSignalIds.length > 0) {
        try {
          await db.rpc('delete_pending_entries', { p_account_id: account.id, p_signal_ids: purgeSignalIds });
        } catch (e) {
          degraded.push(`pending entry purge failed: ${errorMessage(e)}`);
        }
      }
      const retryable = entryRejections.filter((r) => isRetryableEntryRejection(r.stage, r.reason));
      if (retryable.length > 0) {
        const ttlSec = Math.max(1, Math.floor(params.entryRetryTtlCandles)) * 300;
        const payload = retryable.map((r) => {
          const sig = mergedBuys.find((s) => s.id === r.signal_id);
          return {
            pair_id: r.pair_id,
            signal_id: r.signal_id,
            candle_time: sig?.candle_time ?? iso(nowMin),
            expires_at: iso(nowMin + ttlSec),
            strength: Number(sig?.strength ?? 0),
            price: Number(sig?.price ?? 0),
            indicators: sig?.indicators ?? {},
          };
        });
        try {
          await db.rpc('upsert_pending_entries', { p_account_id: account.id, p_entries: payload });
        } catch (e) {
          const msg = `pending entry persist failed: ${errorMessage(e)}`;
          actions.push(msg);
          degraded.push(msg);
        }
      }
      const entryRejectionCounts = entryRejections.reduce<Record<string, number>>((counts, rejection) => {
        counts[rejection.reason] = (counts[rejection.reason] ?? 0) + 1;
        return counts;
      }, {});
      // Structured decision counters: what the signal stage proposed vs. what the gates allowed.
      // Each gate is attributed independently so an operator can tell "no setup" apart from "spread
      // too wide" or "risk budget spent" instead of seeing one undifferentiated HOLD.
      const quoteByPair = new Map<string, ReturnType<typeof quoteAssessment>>();
      for (const s of newSignals) if (!quoteByPair.has(s.pair_id)) quoteByPair.set(s.pair_id, quoteAssessment(s.pair_id));
      for (const s of newSignals) {
        const q = quoteByPair.get(s.pair_id)!;
        const rejection = entryRejections.find((x) => x.signal_id === s.id);
        const rawDecision = {
          action: s.side,
          reason: s.side === 'BUY' ? 'signal_buy' : 'signal_sell',
          signal: { side: s.side, strength: Number(s.strength), reasons: s.reasons ?? [] },
        };
        tallyDecision(decisionCounters, combineDecision({
          raw: rawDecision,
          economics: rejection?.stage === 'economics_gate' ? { reason: rejection.reason } : undefined,
          risk: rejection?.stage === 'risk_gate' || rejection?.stage === 'portfolio_gate'
            ? { blockEntries: true, reasons: [rejection.reason] } : undefined,
          quote: { ok: q.ok, ageSec: q.ageSec, spreadBps: q.spreadBps, ...(q.reason ? { reason: q.reason } : {}) },
          feePct: feePctFor(s.pair_id),
          slippageBps: slipFor(s.pair_id),
        }));
      }
      // final_buy_count is authoritative from the fills that actually landed.
      decisionCounters.final_buy_count = openedEntries.length;
      return {
        status: accountStatus,
        equity: Number(mtm.equity),
        drawdown: Number(mtm.drawdown_pct),
        open: open.size,
        actions,
        degraded,
        buy_signals_received: buys.length,
        entries_opened: entries,
        opened_entries: openedEntries,
        entry_rejections: entryRejections,
        entry_rejection_counts: entryRejectionCounts,
        risk_block_reasons: risk.blockEntries ? risk.reasons : [],
        kill_state: killState,
        valuation_status: valuation.status,
        unpriced_pairs: valuation.unpricedPairs,
        decision_counters: decisionCounters,
      };
    }, (r) => r);

    // A degraded safety net leaves positions unprotected; escalate it to a run error so the status
    // becomes PARTIAL and the hourly system-error notification fires (see the `degraded` comment above).
    for (const failure of paperTrading?.degraded ?? []) errors.push(`paper_trading: ${failure}`);

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
      // Expired queue rows are unreachable (the entry path filters on expires_at), so they are dead
      // weight; drop them on the same hourly beat. Housekeeping must never downgrade a run.
      try {
        steps.prune_pending_entries = { ok: true, info: await db.rpc('prune_pending_entries') };
      } catch (e) {
        steps.prune_pending_entries = { ok: false, error: errorMessage(e) };
        console.error('[pipeline] prune_pending_entries failed:', errorMessage(e));
      }
    }
  } catch (e) {
    errors.push(`unexpected: ${errorMessage(e)}`);
  } finally {
    const failedCore = ['fetch_market', 'store_market'].every((k) => (steps[k] as { ok?: boolean } | undefined)?.ok === false);
    finalStatus = errors.length === 0 ? 'SUCCESS' : failedCore ? 'FAILED' : 'PARTIAL';
    // A config that cannot legally trade is an operator error, not a transient degradation.
    if (entriesBlocked && finalStatus !== 'FAILED') finalStatus = 'FAILED';

    // A lost lease means part of the run was abandoned mid-flight; record it for the operator.
    if (leaseLost.reason) {
      steps.lease = { ok: false, reason: leaseLost.reason, kind: leaseLost.kind, fence_token: fenceToken, abandoned: true };
      if (finalStatus === 'SUCCESS') finalStatus = 'PARTIAL';
    } else if (fenceToken !== null) {
      steps.lease = { ok: true, fence_token: fenceToken };
    }

    // 8. Telegram: system errors (max one per hour per error set) and hourly worker status
    // The outage check sits here, after every budget allocation is settled, so the extra subrequest is
    // paid from the reserve instead of shrinking the trade/history window computed earlier in the run.
    const outageNote = await outageAlarmNote(db, nowSec, nowMin);
    if (outageNote) notes.push(outageNote);
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

    // 9. Execution log + release lock (only if this run still owns the fence)
    steps.budget = { ok: true, info: { used: budget.used(), limit } };
    try {
      await db.rpc('finish_run', {
        p_run_id: ctx.run_id, p_status: finalStatus, p_steps: steps,
        p_error: errors.length ? errors.join('\n').slice(0, 4000) : null,
        p_fence_token: fenceToken,
      });
    } catch (e) {
      console.error('[pipeline] finish_run failed', errorMessage(e));
    }
  }
  return { status: finalStatus, runId: ctx.run_id, steps, errors };
}
