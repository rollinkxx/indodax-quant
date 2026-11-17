# PROJECT STATE — INDODAX QUANT

_Last verified: 18 November 2026 (WIB) for GitHub/CI status, deploy conclusions, relay unsigned-rejection behavior (live probe), and the docs-only classification on PR #35/#36 main push runs (#44142910307 and #44146611162). Production database figures below remain the 17 Nov 2026 04:10 UTC snapshot and were **not** re-verified. Source of truth: production Supabase, Cloudflare Worker, PostHog, and GitHub Actions._

## Non-negotiable operating rules

- **Paper trading only.** Never add INDODAX private/trade API credentials, order submission, withdrawals, or live execution.
- Never expose Supabase service-role credentials in the frontend or browser.
- Preserve trading history and account state. Use non-destructive migrations; never reset or stop the production paper account without an explicit owner request.
- Do not relax spread, stop-distance, net reward/risk, exposure, or account-risk gates merely to increase the number of trades.
- Do not promote a strategy from a backtest automatically. Require a fresh untouched holdout and human review.
- Keep the existing GitHub, Cloudflare, and Supabase infrastructure. The production system has no n8n runtime dependency.

## Infrastructure

| Component | Current resource |
|---|---|
| GitHub | `rollinkxx/indodax-quant`, default branch `main`; GitHub Actions workflow **CI & Deploy** |
| Production Worker | `indodax-quant` |
| Production URL | https://indodax-quant.sinyalku.workers.dev |
| Cron | Every minute: `* * * * *` (UTC) |
| Supabase | Project `sinyalku`, ref `znikuooxiqfcicyuhqsx`, region `ap-southeast-2` |
| INDODAX relay | Supabase Edge Function `indodax-proxy`, read-only public endpoint allow-list |
| PostHog | US project 688639, host `https://us.i.posthog.com` |
| Operations dashboard | https://us.posthog.com/project/688639/dashboard/2365869 |

PR #22 ([security: authenticate INDODAX relay and harden production releases](https://github.com/rollinkxx/indodax-quant/pull/22)) was merged on 17 Nov 2026 04:25:31 UTC as `b2ad833f8738762fee6e719296583a46e68a6731`. The first post-merge deploy run [#44020907306](https://github.com/rollinkxx/indodax-quant/actions/runs/44020907306) (`054ec28`) **FAILED**: `strategy-evaluation` and `deploy` failed and `deploy-relay` was skipped; the 17 Nov read-only audit (PR #25) recorded production market ingestion returning HTTP 401 with `PARTIAL` pipelines at that time. A remediation streak on `main` (HMAC via the standard `Authorization` header + canonical function path, Worker/relay secret synchronization, deployment ordering, evaluation waiting for relay) ended with the first fully green run [#44108840929](https://github.com/rollinkxx/indodax-quant/actions/runs/44108840929) (`e5b0e51`, 17 Nov 14:57 UTC). The latest runtime-bearing main run [#44128264416](https://github.com/rollinkxx/indodax-quant/actions/runs/44128264416) (`aaf6da3`, PR #34) is fully **SUCCESS**, including `deploy-relay` steps that verify unsigned rejection, working HMAC requests, and Worker ingestion through the HMAC-enforced relay (17 Nov 16:41 UTC). The docs-only main push associated with PR #35 [#44142910307](https://github.com/rollinkxx/indodax-quant/actions/runs/44142910307) (`fd6cae7`) changed only `PROJECT_STATE.md`: the classifier log recorded `deploy:false`, `relay:false`, `strategy:false`, `changedFiles:1`; `test` and `detect-changes` succeeded, while `deploy`, `deploy-relay`, and `strategy-evaluation` were **skipped**. The docs-only main push associated with PR #36 [#44146611162](https://github.com/rollinkxx/indodax-quant/actions/runs/44146611162) (`66793ad`) also changed only `PROJECT_STATE.md`; its classifier returned the same three `false` flags with `changedFiles:1`, `test` and `detect-changes` succeeded, and all three deployment/evaluation jobs were **skipped**. A live unsigned probe on 18 Nov 2026 confirmed HTTP 401 `{"error":"unauthorized"}` from production `indodax-proxy`. The earlier "version 72 unauthenticated" statement was a 17 Nov morning observation and is superseded; PR #25 reported Supabase metadata version 73 with HMAC code later that day (owner-side observation, not re-verified here). The exact currently deployed function version number is **not verified** in this reconciliation (requires owner Supabase access). `POSTHOG_PROJECT_TOKEN` is present as a GitHub Actions secret and synced to the Worker; do not print or request its value. Worker `/api/health` passed the CI smoke step on run #44128264416; a live re-probe from the audit sandbox timed out (sandbox egress limitation, not evidence of an outage), so live Worker health is not re-verified here.

Cloudflare Billing Read permission was not available through the connected account, so the effective plan/CPU entitlement could not be verified. Do not claim a plan tier or make billing changes. Observed Worker telemetry over the audited 24-hour window: approximately 1,448 Worker invocations; average CPU 124.8 ms, p95 211 ms, maximum 345 ms. In the same window, Supabase recorded 1,440 completed execution-log runs, all `SUCCESS`.

## Production state (database snapshot: 17 Nov 2026 04:10:13 UTC / 11:10:13 WIB — **not re-verified on 18 Nov 2026; do not treat as live**)

- The latest Worker health check previously returned `ok:true` and `liveTrading:false`. The source repository and production Worker remain paper-only; no live trading API path is enabled.
- Paper account #1 is `RUNNING`, kill switch off. At the database snapshot: cash **Rp9,977,128.19**, equity **Rp9,977,128.19**, realized P/L **-Rp22,871.81**, unrealized P/L **Rp0**, and cumulative fees **Rp829.97** since account reset. The account reset timestamp is 14 Nov 2026 10:16:15 UTC. Do not reset or stop this account as part of maintenance.
- There are 6 paper positions in the database, all CLOSED, and 0 currently open. Three positions closed after the current reset: BTCIDR TAKE_PROFIT (+Rp10,465.40), FARTCOINIDR STOP_LOSS (-Rp19,481.45), and HYPEIDR STOP_LOSS (-Rp13,855.76). The net matches the account realized P/L snapshot (-Rp22,871.81). Three earlier closed positions predate the reset and are not part of current-period P/L.
- Last 24 hours at snapshot: 1,440 execution-log runs, all `SUCCESS`; 0 `PARTIAL` and 0 `FAILED`. Latest logged run was 17 Nov 2026 04:10 UTC. This proves pipeline uptime over that window, not profitability.
- Last 24 hours at snapshot: 30 BUY and 99 SELL signal records; 6 paper orders (3 BUY and 3 SELL), all marked simulated. Signal records are not equivalent to executable BUY attempts. The latest cycle had no new signal, which is a normal per-cycle result and does not mean the complete 24-hour signal stream was empty.
- Current active strategy snapshot: `feePct=0.00555` (percentage points, i.e. 0.00555% per side in the paper model), `mtfMode=score`, `crossLookback=2`, maximum entry spread 0.6%, and maximum ask drift 0.5%. Historical transactions retain the fee assumptions applied at their execution time; they are not rewritten by the current setting.
- PostHog ingestion is active and the production operations dashboard is available. Event counts must be interpreted from real pipeline actions; do not synthesize missing BUY, entry or rejection events.

## Engine update — 18 Nov 2026 (PR #34 merged)

- PR #34 "fix: validate trend-continuation signal inputs (parity with BUY gate)" was squash-merged into `main` as `aaf6da38577b00d1070422c1709f124316c18364` on 17 Nov 2026 16:39:30 UTC; head branch `fix/continuation-input-validation-20261118` deleted.
- Scope: `shared/strategy.ts` (+3) and `tests/strategy.test.ts` (+28). `diagnoseTrendContinuationWindow` now calls `validSignalInputs` and fails closed with a new `invalid_market_data` stage, matching the BUY diagnostic / `evaluateSignalWindow`. This hardens the shadow/telemetry and `trend_continuation` backtest path only. **No production entry/exit threshold was changed and no risk/entry gate was relaxed.**
- Pre-merge CI on PR head `b8b1381`: `test`, `browser-smoke`, `detect-changes` succeeded; `deploy`, `deploy-relay`, `strategy-evaluation`, `Supabase Preview` skipped (pull-request event). The `test` job runs the full Vitest suite + typecheck + build + PostgreSQL 17 migration replay. Local Vitest count moved 289 -> 291 (previous-session sandbox run; not re-run in this docs pass).
- Post-merge production deploy: **SUCCESS**. GitHub Actions run [#44128264416](https://github.com/rollinkxx/indodax-quant/actions/runs/44128264416) (`CI & Deploy`, push, `aaf6da3`) completed 17 Nov 2026 16:48:12 UTC with all jobs green: `detect-changes`, `test`, `deploy`, `deploy-relay`, `strategy-evaluation`. The `deploy-relay` job configured the relay HMAC secret, deployed the authenticated relay, and passed "Verify unsigned requests are blocked and HMAC requests work" plus "Verify Worker ingests through the HMAC-enforced relay" (16:41 UTC).
- Production relay enforcement is verified beyond the merge alone: an unsigned GET to `indodax-proxy` with an allow-listed path on 18 Nov 2026 returned HTTP 401 `{"error":"unauthorized"}` (live probe). The exact deployed function version number and an independent re-run of the full signed smoke matrix (`scripts/smoke-relay.ts`, requires the service-role key) remain owner-side verification items; CI reported that matrix green on run #44128264416.
- `main` had no branch protection at merge time; the merge was performed only after PR checks were green.
- The production database snapshot above (17 Nov 2026 04:10 UTC balances/equity/P/L) was **not** re-verified on 18 Nov and must not be treated as live. A fresh read-only paper account report artifact was uploaded by the `strategy-evaluation` job on run #44128264416; its contents were not reviewed in this docs pass.
- PR #34 is an additional remediation outside the F1–F12 / PR-A/PR-C/PR-D plan below; it does not close any F-item.
- The recurring `strategy-evaluation` job ran and succeeded on run #44128264416 (controlled crossLookback 2 vs 4 backtest + summary artifact). No fresh untouched-holdout release review was performed for this change. Strategy release decision remains **NO-GO**.

## Fee-model finding (F1) — 17 Nov read-only audit (carried from PR #25; not re-verified 18 Nov)

A read-only production query on 17 Nov 2026 (reported in PR #25) returned `market_pairs.trade_fee_percent_taker = 0.2` for **438/438 pairs**. The active strategy still has `feePct=0.00555` percentage points per side; ratio `0.00555 / 0.2 = 0.02775` (2.775%). This establishes a material mismatch between the paper assumption and pair metadata; it does **not** establish the account's final all-in fee. The INDODAX client already parses `trade_fee_percent_taker` per pair from `/api/pairs`, but the paper engine does not consume it; the realistic-fee sensitivity report (F1) is still planned, not implemented.

The proposed `all_in` model must remain opt-in/shadow until the owner checks the official fee schedule in INDODAX **Profil > Pengaturan > Biaya Trading**. `sellTaxPct=0.21` is **not verified** and must not be presented as an official tax value. Do not change the active `strategy_configs` row or assume the all-in model is approved.

Signal counts by UTC day (not execution outcomes), reported in PR #25. `trading_signals` did not yet contain `entry_outcome`, `entry_reject_reason`, or `entry_position_id` at that time:
| UTC day | BUY | SELL |
|---|---:|---:|
| 2026-11-13 | 5 | 43 |
| 2026-11-14 | 0 | 71 |
| 2026-11-15 | 13 | 76 |
| 2026-11-16 | 29 | 105 |
| 2026-11-17 (partial day) | 5 | 12 |

Rolling 3-day read-only comparison of median spread to `1.5 × median ATR5m%` (highest ratios among 25 pairs, reported in PR #25):
| Pair | Median spread % | Median ATR5m % | Spread / (1.5 × ATR) |
|---|---:|---:|---:|
| RENDERIDR | 0.610424 | 0.134640 | 3.022507 |
| VELVETIDR | 0.779944 | 0.189675 | 2.741339 |
| PENGUIDR | 0.641681 | 0.372880 | 1.147251 |
| SKYAIIDR | 0.546448 | 0.343900 | 1.059315 |
| PIPPINIDR | 0.374968 | 0.240768 | 1.038256 |
| HYPEIDR | 0.173370 | 0.297101 | 0.389025 |

This is a diagnostic, not an enabled universe gate. No production configuration was changed by these queries.

## Active paper strategy configuration

The active row in `public.strategy_configs` is the production source of truth. Important current values:

- 5m completed-candle engine; EMA 9/21/50, RSI 14, volume MA20 × 1.2.
- BUY RSI band 50–65; EMA cross lookback 2; anti-chasing extension 1.5%.
- MTF mode `score` (code default is `filter`).
- ATR stop 1.5× and target 3×; fallback stop/target 2%/4%.
- Risk 1% per trade; max position 25% of equity; max 10 open positions; total exposure cap 60%; daily loss limit 3%; max drawdown 15%.
- Maximum entry spread 0.6%; maximum ask drift 0.5%.
- Dynamic slippage enabled; base slippage 10 bps.
- Dynamic universe target cap 25 including pinned pairs; minimum 24h IDR volume Rp1 billion; maximum spread 0.6%; maximum 3 newly selected pairs per update.
- `feePct = 0.00555` in **percentage points**, i.e. 0.00555% per side in the paper model. This is the explicit user-selected modelling assumption, not independently verified as the all-in maker/taker fee for every market/account. Spread and slippage are separate costs.
- The fee update was applied prospectively. Historical execution logs retain their original `fee_pct`; old paper rejection metrics are not recalculated.

The code defaults intentionally differ from production settings for MTF mode, universe size, and open-position cap. Do not infer active production parameters from defaults.

## Strategy release decision — NO-GO

Latest main evaluation artifact: GitHub Actions run [#43991484904](https://github.com/rollinkxx/indodax-quant/actions/runs/43991484904), generated 17 Nov 2026 01:03 UTC. It loaded the active database config snapshot (`feePct:0.00555`, MTF `score`, dynamic slippage, 1% risk, 0.6% spread cap, and 10 open-position maximum) and used 30 days of INDODAX minute OHLC aggregated to 5m for 12 active pairs. Structural coverage was 100%; active-volume coverage was 83.8%. The last-30% chronological holdout started 8 Nov 2026 00:55 UTC.

| Variant | Holdout trades | Win rate | Profit factor | Net P/L | Expectancy / trade |
|---|---:|---:|---:|---:|---:|
| CrossLookback 2 (control) | 35 | 22.86% | 0.151 | -Rp312,087.31 | -Rp8,916.78 |
| CrossLookback 4 | 58 | 25.86% | 0.325 | -Rp439,005.81 | -Rp7,569.07 |
| EMA21 continuation shadow | 17 | 23.53% | 0.243 | -Rp179,878.39 | -Rp10,581.08 |

Wilson 95% lower win-rate bounds were 12.07%, 16.35%, and 9.55%. All three variants failed all four release criteria: at least 100 holdout trades, Wilson lower bound at least 70%, PF>1, and positive net expectancy. Read [the latest dated assessment](docs/strategy-readiness-2026-11-17.md) for the captured config and full limitations. This is a 5m candle-only approximation: no historical bid/ask/tick fills, MTF score, shared portfolio controls or historical slippage tiers; it is not a production P&L forecast.

**Do not represent the strategy as profitable or ready for real-money use.** Keep the current engine in paper mode and collect fresh, untouched forward data. Do not tune against the same holdout. A candidate must be retested with quote/spread/fee/slippage and portfolio-cost parity before a manual release review.

## Current maintenance branch and release status

PR #20 was merged into `main` as commit `75e38927deb22a7efe86cf99f2496e20655ac482`. It delivered the preceding production hardening and the historical strategy-evaluation report.

PR #22 is **merged** (17 Nov 2026 04:25:31 UTC, `b2ad833f8738762fee6e719296583a46e68a6731`); see the Infrastructure section above for the verified deployment history and current relay status. Its scope was not documentation-only: an HMAC-authenticated bounded read-only INDODAX relay, Worker request signing, a lockfile with `npm ci`, changed-file release classification, fail-closed release credentials, full PostgreSQL 17 migration replay assertions, and production/relay smoke scripts.

PR #34 (merged 17 Nov 2026 16:39:30 UTC, `aaf6da3`) added trend-continuation input validation; details in "Engine update — 18 Nov 2026" above. It is a remediation outside the F1–F12 plan.

PR #25 ([docs(state): reconcile post-merge smoke and fee audit](https://github.com/rollinkxx/indodax-quant/pull/25), head `fix/engine-forensic-remediation-20261117`) was **closed without merge** as superseded on 17 Nov 2026 17:58:19 UTC. Its closure-thread comment says: “Superseded by PR baru; observasi 17 Nov yang valid sudah dibawa maju.” This document carries forward the valid 17 Nov read-only observations from PR #25: pair fee metadata and the explicit fee-model mismatch / unverified tax assumption (F1), daily signal counts, rolling spread/ATR diagnostics, and the historical paper-account snapshot (clearly labeled stale). The intermediate morning HTTP 401 / `PARTIAL` observations and failed run #44020907306 are retained only as incident history, not current status. PR #25 is already closed, not merged; no further close action is pending.

## Post-merge incident history — 17 Nov 2026 (resolved)

- The 17 Nov read-only audit (PR #25) re-confirmed paper account #1 `RUNNING` with cash/equity Rp9,977,128.19, realized P/L -Rp22,871.81, unrealized Rp0, fees Rp829.97, reset timestamp unchanged; no account reset/stop or production strategy-config write was performed. Active config remained `feePct=0.00555`, `mtfMode=score`.
- After the PR #22 merge, production market fetches returned HTTP 401 `unauthorized` and pipelines were `PARTIAL` (run #44020907306 failed; `deploy-relay` skipped). Main commits 17 Nov ~13:57–15:11 UTC reworked relay HMAC signing (standard `Authorization` header, canonical function path), Worker/relay secret sync, and deployment ordering; the first fully green run afterwards was #44108840929 (`e5b0e51`, 14:57 UTC), and run #44128264416 (`aaf6da3`) passed the relay-ingestion smoke. Interpretation (high confidence; failure logs not independently re-reviewed): the 401 was a Worker-to-relay signing mismatch, not an INDODAX upstream rejection.
- This history is retained so the earlier "NOT VERIFIED / skipped" notes are not mistaken for current status.

## Open audit work (INDODAX-quant engine audit, base `054ec28`)

Validated against production data on 17 Nov 2026: F1, F2, F3, F4, F6 CONFIRMED; F9 PARTIAL (`market_tickers` exists, but only 9 core pairs have continuous per-minute quotes). F5, F7, F8, F10, F11, F12 remain unimplemented. A deep code audit completed 17–18 Nov 2026 (owner-verified) covered `shared/{strategy,paper,indicators,candles,mtf,universe,backtestScope}.ts`, `worker/src/{pipeline,ingest,indodax,api,db,http,relay,auth,notify}.ts`, `scripts/backtest*.ts`, the paper money-mutation migrations, and `supabase/functions/indodax-proxy`: production BUY/SELL/HOLD is fail-closed via `validSignalInputs`; S/R uses pre-signal candles (no look-ahead); MTF `filter` never blocks SELL; money mutations are atomic + idempotent; `begin_run` returns `opened_at` and WIB `day_start_equity`; relay HMAC is fail-closed (503/401). The single gap found — `diagnoseTrendContinuationWindow` missing input validation — was fixed by PR #34 (outside this F-list).

Planned PR order: PR-A observability (F7 `engine_decisions`, F1 3-scenario fee reports + `repriceTrades()`, F4 `actionable`, F5 per-trade analytics, F8 RESEARCH_ONLY metrics, F10 report, F12b); PR-C research tooling (F9 `replay-parity`, F2 MTF in backtest); PR-D default-off flags and owner proposals (F2 `minBuyStrength`, F5 `minStopCostMultiple`, F11, F12a, F1 `feeModel`, F10 options). F3 and F6 are in PR-B. Owner decisions (none activated): fee model, MTF filter / minimum strength, ATR and trailing multipliers, universe ranking, `minCandles`, evidence-gate proposal. Release decision stays NO-GO.

Additional pending remediation (not yet applied): the `candles` table has CHECKs for positive open/close, non-negative volume, and high/low ordering, but **no `low > 0` CHECK** even though `isValidCandle` requires `low > 0`. A non-destructive migration is proposed; before applying it, confirm zero violating rows in production. No migration was applied in this reconciliation.

## Remaining validation

1. Owner: confirm the exact deployed `indodax-proxy` version via Supabase metadata and re-run the full relay smoke matrix with credentials (`scripts/smoke-relay.ts`: unsigned 401, tampered-target 401, signed public ticker 200 with valid payload, signed private path 400). Unsigned rejection is already verified live (18 Nov) and CI reported the matrix green on run #44128264416; the independent re-run remains owner-side.
2. Re-verify the production database snapshot (balances/equity/realized P/L, open positions, execution-log freshness). It is stale since 17 Nov 04:10 UTC; a fresh read-only paper account report artifact exists on run #44128264416 for the owner to download.
3. Re-verify Worker `/api/health`, static dashboard, cron schedule, market ingestion, and PostHog event freshness from an unrestricted network (the audit sandbox probe timed out; CI smoke was green on 17 Nov).
4. F1: owner verifies the official INDODAX fee schedule (**Profil > Pengaturan > Biaya Trading**); implement the realistic-fee sensitivity report. Any change making the paper engine consume per-pair taker fees must be an approved opt-in change; do not write the active `strategy_configs` row as part of docs work.
5. Apply the non-destructive `candles` `low > 0` CHECK migration only after confirming zero violating production rows.
6. Implement the remaining F-items via the planned PR-A/PR-C/PR-D (and PR-B for F3/F6) as separate reviewable PRs; keep new decision/economic parameters at legacy defaults; run typecheck, full Vitest, build, and PostgreSQL 17 full migration replay for each.
7. Keep the strategy release decision **NO-GO**. Continue forward paper observation; profitability is unproven until a fresh untouched holdout with realistic quote, spread, fee, slippage and portfolio constraints passes human review. No auto-promotion.

## Owner-only / unavailable checks

- Supabase Security Advisor reports leaked-password protection disabled. Enable it in Supabase Auth settings after verifying the app's sign-in policy; this is an account-level security setting and has not been changed automatically.
- `system_locks` has RLS enabled and intentionally has no client policy; it is backend-only, not a missing public access rule.
- Owner must verify the actual INDODAX account maker/taker fee and sell-side tax in **Profil > Pengaturan > Biaya Trading** before approving `feeModel='all_in'`; the proposed `sellTaxPct=0.21` remains unverified.
- Owner approval is required before enabling any new production entry/exit gate or changing `mtfMode`; no such gate or mode change is approved by this audit.
- Owner/authorized operator must confirm the exact deployed relay version and re-run the signed relay smoke matrix; the 17 Nov HTTP 401 ingestion blocker is resolved per the verified run timeline, but the signed-path re-verification requires owner credentials. Do not expose or rotate secrets as part of an unapproved workaround.
- The performance advisor's `app_users_self` warning should be rechecked after migration/replay: the live policy already contains the recommended `(select auth.jwt())` pattern, so it may be a stale/heuristic lint result. Four unused-index notices are informational; do not drop them without query-plan and index-usage review.
- A final visual review of authenticated pages requires the owner's own browser session. No private user login or password was accessed.
- Cloudflare billing/plan entitlement is not verifiable with the connected permissions; no billing or plan change was attempted.
