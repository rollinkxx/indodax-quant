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

The CI deployment job deploys the Worker, syncs configured Worker secrets, and smoke-tests `/api/health`. `POSTHOG_PROJECT_TOKEN` is present as a GitHub Actions secret and is synced to the Worker. Do not print or request its value. The 17 Nov main deployment skipped redeployment of the Supabase Edge Function because `SUPABASE_ACCESS_TOKEN` is not configured in GitHub; the existing `indodax-proxy` remained operational and the Worker continued ingesting market data. Future Edge Function source changes need that deployment secret.

Cloudflare Billing Read permission was not available through the connected account, so the effective plan/CPU entitlement could not be verified. Do not claim a plan tier or make billing changes. Observed Worker telemetry over the audited 24-hour window: approximately 1,448 Worker invocations; average CPU 124.8 ms, p95 211 ms, maximum 345 ms. In the same window, Supabase recorded 1,440 completed execution-log runs, all `SUCCESS`.

## Production state (verified 17 Nov 2026)

- `GET /api/health` returned `ok:true` and `liveTrading:false`. No live trading path is enabled.
- Paper account #1 is `RUNNING`, kill switch off, cash and equity Rp10,000,000. The account has not been reset or stopped during this work.
- Since the paper account reset at 14 Nov 2026 10:16:15 UTC, 0 positions have been opened. Three older CLOSED position rows exist outside the current reset window and are not current-period performance.
- Last 24 hours: 1,440 execution-log runs, all with status `SUCCESS`.
- The market catalog currently has 438 pairs; 8 are manually tracked and 5 currently qualify for the dynamic universe. `universeSize:25` is a configured maximum including manually tracked pairs, not a guarantee that 25 pairs pass the liquidity/spread screen.
- Since reset, the database contains 42 BUY signal records and 204 SELL signal records. The latest paper report counts 39 actual BUY entry attempts, 0 positions opened and 39 rejections: `stop_inside_spread` 19, `net_reward_risk_below_minimum` 7, `wide_spread` 6, `net_reward_non_positive` 6 and `price_drift` 1. Signal records and actual entry attempts are different counts.
- The paper report has 0 open positions and 0 closed trades since the current reset; paper profitability metrics are therefore not established. Historic rejection entries retain their original `fee_pct` values (including entries before the 16 Nov fee change); they are not recalculated.
- PostHog ingestion is active. The post-deployment dashboard counts pipeline status, signal direction and actual BUY-attempt / paper-entry / rejection counters. The event-level rejection/open-position events are emitted only when those real actions occur; zero events do not indicate a sender failure.

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

## Current maintenance branch

PR #20 was merged into `main` as commit `75e38927deb22a7efe86cf99f2496e20655ac482`. CI passed PostgreSQL 17 assertions, typecheck, tests and build; desktop/mobile light/dark browser smoke passed; production Worker deployment and `/api/health` smoke passed; the main strategy-evaluation job completed and uploaded artifact `strategy-evaluation`.

The same-day refresh is now prepared on documentation-only branch `docs/refresh-strategy-evaluation-20261117`: the strategy report and handoff show the latest 12-pair evaluation artifact (run #43991484904), and the PostHog NO-GO dashboard tile has been refreshed to the same figures.

The merged code changes:
- Correct stale README statements about production MTF mode, universe cap, fee, open-position cap, runtime measurements, and current paper-account status.
- Add active strategy configuration snapshot to future backtest output; refuse to run a backtest if no active strategy config exists.
- Add active config + historical fee-provenance caveat to the paper-account report.
- Align the local fee migration filename with the already-applied Supabase version `20261116163134`; repository tracking only. **Do not re-run the SQL migration against production.**
- Keep the PostHog production operations dashboard separate from the legacy staging dashboard.

## Remaining validation

1. Finish CI for the documentation refresh branch and merge only if checks pass.
2. Verify the final saved documentation and PostHog dashboard note remain aligned with run #43991484904.
3. Continue forward paper observation. Profitability remains unproven until a sufficiently large, untouched sample closes with realistic quote/spread/fee/slippage and portfolio constraints.

## Owner-only / unavailable checks

- Supabase Security Advisor previously reported leaked-password protection disabled and `system_locks` without client RLS policy (backend-only). No Auth policy or billing change was made during this work. Review the Auth setting in the owner's Supabase console.
- A final visual review of authenticated pages requires the owner's own browser session. No private user login or password was accessed.
- Current Cloudflare plan/entitlement is not verifiable through the connected API permissions; no plan upgrade or billing change was attempted.
