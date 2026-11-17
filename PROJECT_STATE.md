# PROJECT STATE — INDODAX QUANT

_Last verified: 17 November 2026 (WIB). Source of truth: production Supabase, Cloudflare Worker, PostHog, and GitHub Actions._

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

The latest verified main deployment (17 Nov 2026) deployed the Worker and Supabase `indodax-proxy` Edge Function successfully; GitHub Actions run #43991484904 reports both relay and Worker deployment smoke steps successful. `POSTHOG_PROJECT_TOKEN` is present as a GitHub Actions secret and synced to the Worker; do not print or request its value. **Important current security gap:** production Edge Function version 72 still runs the legacy unauthenticated GET-only relay (`verify_jwt:false`, no HMAC signature check). The HMAC-authenticated relay and Worker signer are prepared in PR #22, have passed PR CI, but are not yet deployed to production. Do not assume the relay is protected until PR #22 merges and post-deploy smoke verifies unsigned rejection plus signed INDODAX data retrieval.

Cloudflare Billing Read permission was not available through the connected account, so the effective plan/CPU entitlement could not be verified. Do not claim a plan tier or make billing changes. Observed Worker telemetry over the audited 24-hour window: approximately 1,448 Worker invocations; average CPU 124.8 ms, p95 211 ms, maximum 345 ms. In the same window, Supabase recorded 1,440 completed execution-log runs, all `SUCCESS`.

## Production state (database snapshot: 17 Nov 2026 04:10:13 UTC / 11:10:13 WIB)

- The latest Worker health check previously returned `ok:true` and `liveTrading:false`. The source repository and production Worker remain paper-only; no live trading API path is enabled.
- Paper account #1 is `RUNNING`, kill switch off. At the database snapshot: cash **Rp9,977,128.19**, equity **Rp9,977,128.19**, realized P/L **-Rp22,871.81**, unrealized P/L **Rp0**, and cumulative fees **Rp829.97** since account reset. The account reset timestamp is 14 Nov 2026 10:16:15 UTC. Do not reset or stop this account as part of maintenance.
- There are 6 paper positions in the database, all CLOSED, and 0 currently open. Three positions closed after the current reset: BTCIDR TAKE_PROFIT (+Rp10,465.40), FARTCOINIDR STOP_LOSS (-Rp19,481.45), and HYPEIDR STOP_LOSS (-Rp13,855.76). The net matches the account realized P/L snapshot (-Rp22,871.81). Three earlier closed positions predate the reset and are not part of current-period P/L.
- Last 24 hours at snapshot: 1,440 execution-log runs, all `SUCCESS`; 0 `PARTIAL` and 0 `FAILED`. Latest logged run was 17 Nov 2026 04:10 UTC. This proves pipeline uptime over that window, not profitability.
- Last 24 hours at snapshot: 30 BUY and 99 SELL signal records; 6 paper orders (3 BUY and 3 SELL), all marked simulated. Signal records are not equivalent to executable BUY attempts. The latest cycle had no new signal, which is a normal per-cycle result and does not mean the complete 24-hour signal stream was empty.
- Current active strategy snapshot: `feePct=0.00555` (percentage points, i.e. 0.00555% per side in the paper model), `mtfMode=score`, `crossLookback=2`, maximum entry spread 0.6%, and maximum ask drift 0.5%. Historical transactions retain the fee assumptions applied at their execution time; they are not rewritten by the current setting.
- PostHog ingestion is active and the production operations dashboard is available. Event counts must be interpreted from real pipeline actions; do not synthesize missing BUY, entry or rejection events.
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

PR #22, `ci: skip production deploy and backtest for doc-only changes`, is the active hardening branch: https://github.com/rollinkxx/indodax-quant/pull/22. Its scope is **not documentation-only**. It adds an HMAC-authenticated bounded read-only INDODAX relay, Worker request signing, a lockfile with `npm ci`, changed-file release classification, fail-closed release credentials, full PostgreSQL 17 migration replay assertions, and production/relay smoke scripts.

Latest PR head `290f871fc6f8cd7afa65ebb5936aa8ff48e320ef` passed GitHub Actions run `#44016094428`: `detect-changes`, complete test job (PostgreSQL 17 targeted checks + clean full migration replay, typecheck, full Vitest suite, build) all succeeded. Live public UI smoke run `#44016094432` also succeeded. Production deploy/evaluation jobs were correctly skipped for the pull-request event. A Worker-first deployment ordering fix is included: the signing-capable Worker deploy and smoke test happen before the relay is switched to HMAC enforcement, preventing a failed Worker rollout from locking out the old relay.

**Not yet complete:** PR #22 remains open and its HMAC changes have not been deployed. Production `indodax-proxy` version 72 remains unauthenticated as described above. Merge and post-deploy checks are still required before marking relay hardening complete.

## Open audit work (INDODAX-quant engine audit, base `054ec28`)

Validated against production data on 17 Nov 2026: F1, F2, F3, F4, F6 CONFIRMED; F9 PARTIAL (`market_tickers` exists, but only 9 core pairs have continuous per-minute quotes). Not yet validated or implemented: F5, F7, F8, F10, F11, F12 and the unaudited areas (ingest, api, relay, telegram, posthog, frontend, CI).

Planned PR order: PR-A observability (F7 `engine_decisions`, F1 3-scenario fee reports + `repriceTrades()`, F4 `actionable`, F5 per-trade analytics, F8 RESEARCH_ONLY metrics, F10 report, F12b); PR-C research tooling (F9 `replay-parity`, F2 MTF in backtest); PR-D default-off flags and owner proposals (F2 `minBuyStrength`, F5 `minStopCostMultiple`, F11, F12a, F1 `feeModel`, F10 options). F3 and F6 are in PR-B. Owner decisions (none activated): fee model, MTF filter / minimum strength, ATR and trailing multipliers, universe ranking, `minCandles`, evidence-gate proposal. Release decision stays NO-GO.

## Remaining validation

1. Merge PR #22 only after the latest checks remain green and the release diff has been reviewed.
2. Verify Worker-first deploy followed by relay deployment; run smoke tests that prove unsigned and tampered requests are rejected and a valid signed request receives a valid INDODAX payload.
3. Verify production Worker `/api/health`, static dashboard, cron schedule, market ingestion, PostHog event freshness, and Supabase paper account/config snapshots after deployment.
4. Keep the strategy release decision **NO-GO**. Continue forward paper observation; profitability remains unproven until there is a sufficiently large untouched sample with realistic quote, spread, fee, slippage and portfolio constraints.

## Owner-only / unavailable checks

- Supabase Security Advisor reports leaked-password protection disabled. Enable it in Supabase Auth settings after verifying the app's sign-in policy; this is an account-level security setting and has not been changed automatically.
- `system_locks` has RLS enabled and intentionally has no client policy; it is backend-only, not a missing public access rule.
- The performance advisor's `app_users_self` warning should be rechecked after migration/replay: the live policy already contains the recommended `(select auth.jwt())` pattern, so it may be a stale/heuristic lint result. Four unused-index notices are informational; do not drop them without query-plan and index-usage review.
- A final visual review of authenticated pages requires the owner's own browser session. No private user login or password was accessed.
- Cloudflare billing/plan entitlement is not verifiable with the connected permissions; no billing or plan change was attempted.
