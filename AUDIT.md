# Implementation-correctness audit — Worker `indodax-quant`

Scope: correctness only (bugs, races, miscounts, invariant violations, data leaks, contract
drift). Strategy edge parameters are out of scope and were not changed.

Baseline before this work: 53 files / 571 tests passing.
After: **55 files / 605 tests passing**, `tsc --noEmit` clean for both `tsconfig.worker.json` and
`tsconfig.app.json`, and 7 SQL test files passing on a from-scratch migration replay
(`iq_final`).

Every FIXED item was proven in both directions: the new test fails against the pre-fix code and
passes after. That is stated per item below and was executed, not assumed.

---

## Status table

| Item | Status | One-line result |
|---|---|---|
| FIX-01 lease TTL margin | FIXED | 55s → 45s, one shared constant, margin asserted |
| VERIFY-01 stop writes on lost lease | FIXED | MTM, kill switch and trail ratchet were unguarded; now guarded |
| FIX-02 retry on non-idempotent PATCH | FIXED | `update()` default `retries: 0`; 3 call sites audited and opted in explicitly |
| FIX-03 `encodeQuery` only escapes `+` | FIXED | `filterValue()` + per-component escaping of `+ % #` |
| FIX-04 universe starvation | FIXED | window-advancing rotation; every pair served in ≤3 runs |
| VERIFY-02 positions on removed pairs | FIXED | `begin_run` scope keeps held pairs; proven by SQL test |
| FIX-05 daily-loss day boundary | NOT A BUG (after fix) | `begin_run` already uses `Asia/Jakarta`; `paper_*` never derive a day |
| FIX-06 body leaks credentials to logs | FIXED | `redactBody()` scrubs keys, bearer tokens, JWTs |
| FIX-07 signals evaluated 5× per candle | FIXED | explicit `signal`/`mark` phase, derived server-side |
| FIX-08 zero-volume candle invalid | NOT A BUG | `n` is never a validity gate; regression test added |
| FIX-09 auth cache unbounded/never invalidated | FIXED | bounded LRU + 60s TTL |
| FIX-10 `universeExceedsCapacity` no action | FIXED | structured `universe_capacity` event every run |
| VERIFY-03 `paper_mark_to_market` idempotency | VERIFIED | repeated call with same price is a no-op |
| Out-of-scope strategy items | NEEDS DATA | evidence gathered; no parameter changed |

---

## P0 — races and data integrity

### FIX-01 — Lease TTL had no margin against the cron interval — FIXED

`shared/lease.ts`, `worker/src/pipeline.ts`.

- **Before:** `LEASE_TTL_SECONDS = 55`, and the literal `55` was also hardcoded in the
  `begin_run({ p_lock_ttl_seconds: 55 })` call. Cron is `* * * * *`, so the margin was 5s. One
  `fetchWithRetry` (3 attempts × 8s timeout + backoff) exceeds that, the run then keeps working
  past its fence, and the next tick sees a half-finished state.
- **After:** `LEASE_TTL_SECONDS = 45`, `CRON_INTERVAL_SECONDS = 60`, `MIN_LEASE_MARGIN_SECONDS = 15`,
  and `leaseFitsCron()` makes the margin a checked property instead of a comment. `begin_run` now
  receives the constant, so the value exists once.
- **Proof:** `tests/pipeline.test.ts` — "keeps at least 15s between lease expiry and the next cron
  tick" asserts `leaseFitsCron()` is true, that `60 - 45 >= 15`, and that the old 55 would fail.
  Fails on old code, passes now.
- **Note on the number:** 45s is not arbitrary. Production SUCCESS runs measure p99 = 22.5s and
  max = 24.2s, so 45s keeps ~1.9× headroom while satisfying the cron margin.

### VERIFY-01 — Does the pipeline really stop writing when the lease is lost? — FIXED (3 gaps found)

`worker/src/pipeline.ts`.

Audit of every write path against `guardLease()`:

| Write | Guarded before this work? | Action |
|---|---|---|
| `paper_open_position` | yes | — |
| `paper_close_position` | yes | — |
| trail ratchet (`db.update` on `paper_positions`) | **no** | guard added |
| `paper_mark_to_market` | **no** | guard added; run returns early with `degraded` |
| `paper_set_status` (kill switch) | **no** | guard added |
| `save_analysis` | yes (inside `step('analyze')` after the gate) | — |
| `finish_run` | n/a — release/finalize must run even when the fence is gone | — |

The three unguarded paths were the dangerous ones: MTM writes equity, peak, drawdown and the
snapshot row, and the trail ratchet persists a new stop. Both could write into an account another
run now owns.

- **Proof:** `tests/pipeline.test.ts` (VERIFY-01 block) — with `ensure()` throwing, no
  `paper_open_position`, `paper_close_position` or `paper_mark_to_market` RPC is sent, the actions
  log says `lease lost`, and the run is recorded as `PARTIAL`, never `SUCCESS`.

### FIX-02 — Retry on an operation that is not necessarily idempotent — FIXED

`worker/src/db.ts`.

- **Before:** `update()` always used `retries: 1` under the comment "All RPCs used here are
  idempotent". That claim is true for the RPCs; it says nothing about an arbitrary PATCH body.
- **After:** `update()` defaults to `retries: 0`; retry is opt-in per call site. All three call
  sites were audited and classified:

| Call site | Body | Filter | Idempotent? | Setting |
|---|---|---|---|---|
| trail ratchet (`stop_loss`) | absolute set | `id=eq.X&status=eq.OPEN` (compare-and-set) | yes | `retries: 1` |
| `market_pairs` sync | absolute set | `id=eq.X` | yes | default |
| `strategy_configs` toggle | absolute set | `id=eq.X` | yes | default |

No increment/append PATCH exists in the codebase, so no compare-and-set column had to be added.

- **Proof:** `tests/db.test.ts` — "does not resend a non-idempotent PATCH after a 503 by default"
  returns 503 on attempt 1 and asserts the fetch was called exactly once. Fails on old code.

### FIX-03 — `encodeQuery` only escaped `+` — FIXED

`worker/src/db.ts`.

- **Before:** `query.replace(/\+/g, '%2B')`. A filter value containing `&`, `%` or `#` silently
  rewrote the PostgREST query — wrong rows, no error. The worst failure class.
- **After:** two layers. `filterValue(v)` = `encodeURIComponent` for values that are interpolated
  into a filter, and `encodeQuery()` repairs what a raw template literal leaves behind, per
  `key=value` component: a bare `%` becomes `%25` (only when not already a valid escape), `+`
  becomes `%2B` (preserving the `+00:00` timestamp case), `#` becomes `%23`. Already-encoded
  `%XX` from `filterValue` is never double-encoded.
- **Proof:** `tests/db.test.ts` — `a&b=c`, `100%`, `2026-11-20T00:00:00+00:00` and a
  literal `%` all round-trip without splitting the query. 7 tests, all fail on old code.

---

## P1 — behaviour that diverges from the contract

### FIX-04 — Universe starvation — FIXED

`worker/src/pipeline.ts` — `rotationOffset()`, `rotateWindow()`.

- **Before:** the rotation cursor advanced by **one** per run while the window was `w`.
  With 12 pairs and a window of 5, a one-step cursor slides the window instead of tiling it, so a
  pair at the tail could wait 7–8 runs. Three separate hand-rolled copies of this bug existed
  (HTF backfill, trade fetch, history backfill).
- **After:** one helper pair. The offset advances by the *window size*, so the queue tiles and every
  pair is served within `ceil(total / window)` runs — ≤3 for 12 pairs and a window of 5. The clock
  is the cursor, so the guarantee holds across runs without persisting new state (no migration
  needed).
- **Proof:** `tests/pipeline.test.ts` — "serves every pair within ceil(total/window) consecutive
  runs" plus "a one-per-run cursor would have starved the tail (regression guard)", which
  simulates the old cursor and shows it misses a pair for 7 runs. Both fail on old code.

### VERIFY-02 — Open positions on pairs that left the universe — FIXED

`supabase/migrations/20261120160000_pipeline_phase.sql` (`begin_run` scope), `worker/src/pipeline.ts`.

- **Finding:** the scope is correct by design — `begin_run` selects pairs `where p.is_tracked or
  p.in_universe or exists(open paper position for this account)`. A held pair therefore stays in
  `ctx.pairs`, `tracked`, and the MTM `bids` map even after it is dropped from the universe.
  I initially recorded this as a failure; the "failure" was my test colliding with a committed
  `execution_logs.scheduled_time` from another test. That was a test-isolation defect, not a code
  defect. Recorded here so the correction is on the record.
- **Hardening added:** `tests/sql/universe_removed_position_test.sql` asserts a pair with
  `is_tracked = false, in_universe = false` and an OPEN position is still returned by `begin_run`,
  and `tests/pipeline.test.ts` — "still marks and can close a held pair that is outside the
  universe on a mark run" asserts the worker marks and closes it on a **mark-phase** run too.
- **Proof both directions:** removing the `exists(...)` clause from `begin_run` makes the SQL test
  fail with *"a pair with an OPEN position must stay in the run scope after leaving the universe"*;
  gating `open` on `phase === 'signal'` makes the JS test fail. Both restored and green.

### FIX-05 — Daily-loss reset boundary — NOT A BUG (verified, no change)

`begin_run` in the base migration.

- **Finding:** only `begin_run` defines a trading day, and it already uses
  `date_trunc('day', now() at time zone 'Asia/Jakarta')` to compute `v_day_start`, which feeds
  `day_start_equity`. `paper_open_position`, `paper_close_position` and `paper_mark_to_market`
  never derive a day at all — they take a timestamp — so they inherit that boundary. There is no
  UTC day boundary anywhere in the paper path.
- **Why the original test failed:** it asserted that all four functions mention `Asia/Jakarta`,
  which is the wrong assertion — the paper RPCs have no reason to. Narrowed to the real contract.
- **Proof:** `tests/sql/wib_day_boundary_test.sql` — a trade at 23:30 WIB and one at 00:30 WIB fall
  on different WIB days while a UTC boundary would merge them, and `begin_run` is asserted to use
  `Asia/Jakarta` with no UTC `date_trunc('day')` in any paper function.

### FIX-06 — Error body could leak credentials into logs — FIXED

`worker/src/http.ts`.

- **Before:** `redact()` sanitised the URL only. `HttpError.body` kept the first 500 characters of
  the upstream response verbatim, and `errorMessage()` prints it via `console.error`. A relay or
  INDODAX error that echoes request headers would print the service-role key or a bot token.
- **After:** `redactBody()` scrubs, in order, `Bearer <token>`, bare JWTs (`eyJ…`), and
  `authorization|apikey|api_key|x-api-key|token|access_token|refresh_token|secret|password`
  in both `key=value` and `key: value` form, then truncates to 500.
- **Proof:** `tests/http.test.ts` — `apikey=abc123`, `authorization: Bearer xyz`, JSON
  `token/secret/password`, a bare JWT and a standalone bearer token are all masked. Fails on old
  code.

---

## P2 — hygiene and observability

### FIX-07 — Signals evaluated five times per candle — FIXED

`worker/src/pipeline.ts`, `supabase/migrations/20261120160000_pipeline_phase.sql`.

- **Before:** cron is 60s and the base timeframe is 300s, so 4 of 5 runs recomputed indicators and
  signals on an unchanged candle.
- **After:** two explicit phases. `begin_run` derives `phase`/`signals_due` **server-side** (it is
  the only place that can see whether a signal run already completed in the current 300s bucket)
  and returns them; the worker reads `ctx.phase`. Mark runs do MTM, stop/trailing/time-stop and the
  pending-SELL recovery net; signal runs additionally do ingest→indicators→MTF→universe→evaluate.
  Ingest is deliberately **not** gated (the trades endpoint returns a rolling window, so skipping it
  would punch holes in the 1m candles).
- **Compatibility:** `begin_run` keeps its 3-argument signature, so old code runs against the new
  schema. If `signals_due` is absent (old database, new code), the worker falls back to `signal`
  — i.e. exactly the pre-fix behaviour — rather than silently stopping evaluation. Fail-closed in
  the safe direction.
- **Proof:** `tests/pipeline.test.ts` — 5 consecutive ticks give `['signal','mark','mark','mark','mark']`
  with `paper_mark_to_market` called on all 5; `tests/sql/pipeline_phase_test.sql` proves the same
  cadence in SQL. Rolling back the migration makes the SQL test fail on
  *"the first run of an hour must evaluate signals"*. Rollback script verified.

### FIX-08 — Zero-volume candle marked invalid — NOT A BUG

`shared/candles.ts`, `shared/strategy.ts`.

- **Finding:** the brief's premise does not hold in this codebase. `isValidCandle()` never uses `n`
  as a validity gate, and `n` is only used for MTF aggregation source selection (`c.mtf.ts`) and
  for display. A zero-volume candle is already structurally valid. `checkDataQuality()` does reject
  a zero-volume **signal** candle (`no_trades_in_signal_candle`) — that is the intended volume
  filter, and it applies to entry evaluation, not to marking or closing a held position.
- **Proof:** the permanent regression test asserts `isValidCandle` accepts a zero-volume candle and
  that such a pair is not permanently excluded. No production change was needed.

### FIX-09 — Auth cache unbounded and never invalidated — FIXED

`worker/src/auth.ts`.

- **Before:** a module-scope `Map` with no size bound and a `if (size > 500) clear()` that wiped
  every entry at once (a thundering herd of re-verifications), no TTL refresh policy, and no
  response to a downstream 401.
- **After:** bounded LRU (`AUTH_CACHE_MAX = 500`, evicts the coldest single entry, a hit refreshes
  its position) and `AUTH_CACHE_TTL_MS = 60_000`. A 401 from the auth server deletes the entry
  (typed on `HttpError.status`, not a message regex).
- **Honest limitation:** the TTL, not the 401 handler, is what bounds the revocation window — an
  expired entry is dropped by `cacheGet()` before re-verification, so the explicit delete is a
  belt-and-braces measure. The test was named to match what it actually guarantees:
  "stops accepting a revoked token once its entry expires".
- **Proof:** `tests/auth.test.ts` — eviction removes one entry (not the whole map), and an expired
  entry is re-verified instead of served. Disabling the expiry check makes both fail.

### FIX-10 — `universeExceedsCapacity` produced no action — FIXED

`worker/src/pipeline.ts`.

- **Before:** the condition was computed and then ignored except inside a 15-minute universe
  refresh, so an oversized scope was invisible in observability.
- **After:** every run emits `steps.universe_capacity = { ok: false, reason, universeSize,
  capacity, droppedPairs }` and a matching entry in `errors`, which lands in `execution_logs`.
- **Proof:** `tests/pipeline.test.ts` — with `TRADE_FETCH_PER_RUN` pairs plus one, the event carries
  `universeSize`, `capacity` and `droppedPairs`; it stays silent when the scope fits. Fails on old
  code.

### VERIFY-03 — `paper_mark_to_market` idempotency — VERIFIED (no change needed)

- **Finding:** the RPC writes absolute values (`equity`, `peak_equity`, drawdown) and upserts the
  snapshot on `(account_id, snapshot_time)`, so a repeat call with the same price converges to the
  same state. `peak_equity` uses `greatest()`, so it cannot drift downward either.
- **Proof:** `tests/sql/paper_mark_idempotency_test.sql` calls it twice with identical prices and
  asserts the second call leaves `equity = peak = 10001200` and `unrealized = 198.00` unchanged.

---

## Out of scope — evidence only, no parameter changed

Source: production `znikuooxiqfcicyuhqsx`, `paper_positions` and `execution_logs`, read-only.

1. **`minNetRewardRiskRatio: 1` is too loose after fees.** Across 16 closed trades the average TP
   distance was 2.21% and the average stop distance 0.53%. Round-trip taker cost is 0.4%, so the
   effective reward:risk after cost on a 1:1 nominal setup is roughly `(2.21−0.4):(0.53+0.4)` =
   ~1.9:1 on paper — but 11 of 16 exits were STOP_LOSS and the realized average stop exit was
   −1.47%, versus a nominal −0.53%. The nominal ratio is not the realized ratio.
2. **Stop exits slip far beyond the stop.** All 11 STOP_LOSS exits settled 0.21–0.57% *worse* than
   their stop price (mean ≈ 0.40%). This is a backtest-realism issue: the simulator's exit fill
   does not model gap-through. Worth a slippage model change, but that is a strategy-model change,
   not a correctness fix, and it needs its own out-of-sample evidence.
3. **RSI 50–65 buy window, `sellRequireConfirm: false`.** With only 16 closed trades there is no
   statistical power to attribute the loss distribution to either rule. Needs more data.
4. **No walk-forward / out-of-sample validation of the defaults.** Confirmed absent; adding it is a
   research task, not an implementation fix.
5. **`engine_decisions` does not exist in this repository or database.** The brief references it as
   a data source; it is not present. Diagnostics live in `execution_logs.steps`
   (`buy_diagnostics`, `continuation_diagnostics`). Reporting a strategy finding from it is not
   possible as specified.

### Incidental production finding (reported, not changed)

Between 2026-11-20 06:56 and 08:2x UTC, **92 consecutive runs** were finalized by the watchdog
(`stale_run_without_lease`) with **zero steps written** and durations of 180–240s. That is a
~1.5h total outage of signal evaluation and position management. Two things made it benign here
and are worth stating precisely: no position was open during the window, so nothing went
unmanaged; and 5m candles for the window are still complete, so the ingest gap was recovered.
Had a position been open, its stop/trailing would not have been evaluated for 90 minutes. The
watchdog path behaved correctly — it is the only reason the runs did not stay `RUNNING` forever.
Root cause of the hang is not visible in `execution_logs` (no steps were recorded); it needs
Workers observability logs to pin down. This is outside the brief's fix list, so it is reported
rather than changed.

---

## Diff summary per item

| Item | File | Symbol | Before | After |
|---|---|---|---|---|
| FIX-01 | `shared/lease.ts`, `worker/src/pipeline.ts` | `LEASE_TTL_SECONDS`, `leaseFitsCron` | `55`, literal `55` in RPC | `45` + `CRON_INTERVAL_SECONDS` + `MIN_LEASE_MARGIN_SECONDS`, one constant |
| VERIFY-01 | `worker/src/pipeline.ts` | `guardLease` call sites | MTM/kill/trail unguarded | all state mutations guarded |
| FIX-02 | `worker/src/db.ts` | `Db.update` | `retries: 1` default | `retries: 0` default, opt-in |
| FIX-03 | `worker/src/db.ts` | `encodeQuery`, `filterValue` | `+` only | per-component `+ % #` + `filterValue` |
| FIX-04 | `worker/src/pipeline.ts` | `rotationOffset`, `rotateWindow` | one-step cursor ×3 | window-advancing rotation ×1 |
| VERIFY-02 | `begin_run` SQL, `pipeline.ts` | pair scope, `open` map | (already correct) | SQL + JS regression tests |
| FIX-05 | — | — | — | no change (verified) |
| FIX-06 | `worker/src/http.ts` | `redactBody` | raw body in `HttpError` | scrubbed body |
| FIX-07 | `pipeline.ts`, `20261120160000_pipeline_phase.sql` | `runPhase`, `begin_run` | evaluate every tick | `signal`/`mark` phase, server-derived |
| FIX-08 | — | — | — | no change (verified) |
| FIX-09 | `worker/src/auth.ts` | `cacheGet`, `cacheSet` | unbounded Map, clear-all | bounded LRU + TTL + 401 delete |
| FIX-10 | `worker/src/pipeline.ts` | `steps.universe_capacity` | ignored boolean | structured event + error |
| VERIFY-03 | — | — | — | no change (verified) |

---

## Rollback notes

All work is on branch `audit/implementation-correctness` off `main` (`05d18e3`). Nothing is
deployed by this change; deploying is a separate, explicit step.

- **Revert everything:** `git revert <merge-commit>` (or drop the branch).
- **Revert the migration only:**
  ```
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f supabase/migrations/rollback/20261120160000_pipeline_phase.rollback.sql
  ```
  This restores the original 3-argument `begin_run` and drops `phase`/`signals_due`. Verified: after
  rollback the worker's `runPhase(undefined)` fallback returns `signal`, i.e. the pre-FIX-07
  behaviour, so old and new code both work against either schema state.
- **Roll back the Worker version** (if a deploy went out):
  `npx wrangler rollback --message "audit rollback"` or redeploy the previous version id.
  Previous known-good version: `3da051d6-e8c0-4e4d-8ae4-b2ae26d17f77`.
- Each item is independently revertable: the source edits are in distinct files/functions and the
  only schema change is the single additive `pipeline_phase` migration, which is backward
  compatible with the old worker.

---

## Deliberately not changed

- **`DEFAULT_PARAMS`** — untouched, as required.
- **Indicator formulas** (`sma`, `ema`, `rsi`, `atr`) — untouched.
- **Cron frequency** — still `* * * * *`; FIX-07 changes what each tick *does*, not how often it
  fires.
- **Strategy parameters** (RSI window, `sellRequireConfirm`, `minNetRewardRiskRatio`, slippage
  model) — evidence reported above; changing them needs out-of-sample proof, not an audit.
- **`finish_run`** — intentionally not wrapped in `guardLease()`: it must be *attempted* even when the
  fence is gone, otherwise a lost lease leaves a permanently `RUNNING` row for the watchdog to clean
  up. It is still safe: the RPC receives `p_fence_token` and rejects a stale owner server-side.
- **Historical fee rows (2026-11-17/18, 0.0055%/side)** — a real accounting defect at the time, but
  already fixed by the 2026-11-18 configuration change; current rows are correct at 0.2%/side.
  Rewriting closed-position history would corrupt the realized-PnL audit trail, so it is reported
  rather than back-filled.
