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

The Worker was deployed from main commit `054ec28e9c458f18992bc4ed2461ecc1a69a3965` by GitHub Actions run [#44020907306](https://github.com/rollinkxx/indodax-quant/actions/runs/44020907306); the deployment step succeeded and `/api/health` returned `ok:true` with `liveTrading:false`. The same run's production smoke failed because the first post-deploy pipeline was `PARTIAL`; the `deploy-relay` job was skipped after the Worker smoke failed. Supabase metadata currently reports `indodax-proxy` version 73 with `verify_jwt:false`, but version metadata does not prove HMAC validation. **HMAC status is NOT VERIFIED in production.** Do not claim the relay is protected until smoke proves unsigned/tampered requests are rejected and a correctly signed public INDODAX request succeeds. `POSTHOG_PROJECT_TOKEN` is present as a GitHub Actions secret and synced to the Worker; do not print or request its value.

Cloudflare Billing Read permission was not available through the connected account, so the effective plan/CPU entitlement could not be verified. Do not claim a plan tier or make billing changes. Observed Worker telemetry over the audited 24-hour window: approximately 1,448 Worker invocations; average CPU 124.8 ms, p95 211 ms, maximum 345 ms. In the same window, Supabase recorded 1,440 completed execution-log runs, all `SUCCESS`.

## Production state (database snapshot: 17 Nov 2026 04:10:13 UTC / 11:10:13 WIB)

- The latest Worker health check previously returned `ok:true` and `liveTrading:false`. The source repository and production Worker remain paper-only; no live trading API path is enabled.
- Paper account #1 is `RUNNING`, kill switch off. At the database snapshot: cash **Rp9,977,128.19**, equity **Rp9,977,128.19**, realized P/L **-Rp22,871.81**, unrealized P/L **Rp0**, and cumulative fees **Rp829.97** since account reset. The account reset timestamp is 14 Nov 2026 10:16:15 UTC. Do not reset or stop this account as part of maintenance.
- There are 6 paper positions in the database, all CLOSED, and 0 currently open. Three positions closed after the current reset: BTCIDR TAKE_PROFIT (+Rp10,465.40), FARTCOINIDR STOP_LOSS (-Rp19,481.45), and HYPEIDR STOP_LOSS (-Rp13,855.76). The net matches the account realized P/L snapshot (-Rp22,871.81). Three earlier closed positions predate the reset and are not part of current-period P/L.
- Last 24 hours at snapshot: 1,440 execution-log runs, all `SUCCESS`; 0 `PARTIAL` and 0 `FAILED`. Latest logged run was 17 Nov 2026 04:10 UTC. This proves pipeline uptime over that window, not profitability.
- Last 24 hours at snapshot: 30 BUY and 99 SELL signal records; 6 paper orders (3 BUY and 3 SELL), all marked simulated. Signal records are not equivalent to executable BUY attempts. The latest cycle had no new signal, which is a normal per-cycle result and does not mean the complete 24-hour signal stream was empty.
- Current active strategy snapshot: `feePct=0.00555` (percentage points, i.e. 0.00555% per side in the paper model), `mtfMode=score`, `crossLookback=2`, maximum entry spread 0.6%, and maximum ask drift 0.5%. Historical transactions retain the fee assumptions applied at their execution time; they are not rewritten by the current setting.
- PostHog ingestion is active and the production operations dashboard is available. Event counts must be interpreted from real pipeline actions; do not synthesize missing BUY, entry or rejection events.

## Fee-model finding (F1) — requires owner verification

A read-only production query on 17 Nov 2026 returned `market_pairs.trade_fee_percent_taker = 0.2` for **438/438 pairs**. The active strategy still has `feePct=0.00555` percentage points per side. Their ratio is `0.00555 / 0.2 = 0.02775` (2.775%), below the proposed non-blocking warning threshold of 0.25. This establishes a material mismatch between the current paper assumption and the pair metadata; it does **not** establish the user's final all-in fee.

The proposed `all_in` model must remain opt-in/shadow until the owner checks the current account's official fee schedule in INDODAX **Profil > Pengaturan > Biaya Trading**. In particular, `sellTaxPct=0.21` is **not verified** and must not be presented as an official tax value. Do not change the active `strategy_configs` row or assume the all-in model is approved.

Read-only verification also found that `trading_signals` does not yet contain `entry_outcome`, `entry_reject_reason`, or `entry_position_id`; outcome distributions cannot be queried until the PR-3 migration is implemented. Existing signal counts by UTC day (not execution outcomes) were:
| UTC day | BUY | SELL |
|---|---:|---:|
| 2026-11-13 | 5 | 43 |
| 2026-11-14 | 0 | 71 |
| 2026-11-15 | 13 | 76 |
| 2026-11-16 | 29 | 105 |
| 2026-11-17 (partial day) | 5 | 12 |

A rolling 3-day read-only comparison of median spread to `1.5 × median ATR5m%` found these highest ratios among 25 pairs:
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

## Live verification after PR #22 merge

- Read-only Supabase query confirms paper account #1 remains `RUNNING`; cash/equity Rp9,977,128.19, realized P/L -Rp22,871.81, unrealized P/L Rp0, total fees Rp829.97, reset timestamp unchanged. No account reset/stop or production strategy-config write was performed in this work.
- Active production config remains `feePct=0.00555` and `mtfMode=score`.
- The three latest execution-log runs observed during verification were `PARTIAL`. Their market fetch failed with HTTP 401 `unauthorized`; trade requests for the tracked pairs also returned HTTP 401. The resulting analyze step marked data coverage incomplete and MTF states unknown. This is an operational ingestion/authentication blocker, not evidence of a trading signal or of profitability.
- The latest CI run's full test job passed, but the evaluation and production smoke jobs failed as described above. Do not mark the post-merge release as green.

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

PR #22, [security: authenticate INDODAX relay and harden production releases](https://github.com/rollinkxx/indodax-quant/pull/22), was merged on 17 Nov 2026 as merge commit `b2ad833f8738762fee6e719296583a46e68a6731`. It adds an HMAC-authenticated bounded read-only INDODAX relay, Worker request signing, `npm ci`, changed-file release classification, fail-closed release credentials, PostgreSQL 17 migration replay assertions, and production/relay smoke scripts.

The merged PR's earlier PR checks passed, including PostgreSQL 17 replay, typecheck, Vitest, build, and public UI smoke. However, the first main deployment after the merge, [run #44020907306](https://github.com/rollinkxx/indodax-quant/actions/runs/44020907306), is **FAILED** overall:
- `detect-changes` and the full `test` job succeeded (PostgreSQL 17 security checks + clean full migration replay, typecheck, full Vitest suite, build).
- The `strategy-evaluation` job failed at `scripts/backtest.ts` with exit code 1. The artifact's stderr/root cause has not yet been independently reviewed; do not infer a reason.
- The Worker deployment step succeeded and `/api/health` returned `ok:true`, `liveTrading:false`.
- `scripts/smoke-production.ts` then observed the newest pipeline run as `PARTIAL` and failed. The database shows repeated HTTP 401 `unauthorized` responses for public INDODAX summaries/trades, so market ingestion and MTF backfill were not healthy in the observed runs.
- Because the Worker smoke failed, the `deploy-relay` job was skipped. The HMAC production handshake is therefore unverified.

The production relay version reported by Supabase metadata is 73 (`verify_jwt:false`); this metadata alone does not prove that HMAC is enforced or that signed requests succeed. Keep relay security status **NOT VERIFIED** until a post-deploy smoke passes for unsigned rejection, tampered-target rejection, signed-private-path rejection, and signed public ticker retrieval.

## Remaining validation

1. Diagnose and restore the read-only relay authentication path. The post-merge production run returned HTTP 401 for public market endpoints; do not bypass HMAC or weaken relay allow-lists. Re-run the Worker-first/relay-second deployment sequence only after the failure is understood.
2. Run `scripts/smoke-production.ts` again and require a successful post-deploy pipeline, signed public ticker retrieval, unsigned/tampered rejection, and signed private-path rejection before marking HMAC hardening complete.
3. Review the failure artifact from strategy-evaluation run #44020907306; identify why `scripts/backtest.ts` exited 1 and rerun the controlled evaluation.
4. Implement PR-1 through PR-6 as separate, reviewable PRs. Keep new decision/economic parameters at legacy defaults; run typecheck, full Vitest, build, and PostgreSQL 17 full migration replay for each.
5. Implement PR-7 documentation reconciliation (this update) and keep production `strategy_configs` unchanged.
6. Keep the strategy release decision **NO-GO**. Continue forward paper observation; profitability is unproven until the v2 evidence gate and untouched holdout requirements are met.

## Owner-only / unavailable checks

- Supabase Security Advisor reports leaked-password protection disabled. Enable it in Supabase Auth settings after verifying the app's sign-in policy; this is an account-level security setting and has not been changed automatically.
- `system_locks` has RLS enabled and intentionally has no client policy; it is backend-only, not a missing public access rule.
- The performance advisor's `app_users_self` warning should be rechecked after migration/replay: the live policy already contains the recommended `(select auth.jwt())` pattern, so it may be a stale/heuristic lint result. Four unused-index notices are informational; do not drop them without query-plan and index-usage review.
- A final visual review of authenticated pages requires the owner's own browser session. No private user login or password was accessed.
- Cloudflare billing/plan entitlement is not verifiable with the connected permissions; no billing or plan change was attempted.
- Owner must verify the actual INDODAX account maker/taker fee and sell-side tax in **Profil > Pengaturan > Biaya Trading** before approving `feeModel='all_in'`; the proposed `sellTaxPct=0.21` remains unverified.
- Owner approval is required before enabling any new production entry/exit gate or changing `mtfMode`; no such gate or mode change is approved by this audit.
- Owner/authorized operator must resolve the production relay HTTP 401/HMAC deployment issue. Do not expose or rotate secrets as part of an unapproved workaround.
