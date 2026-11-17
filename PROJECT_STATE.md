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

The CI deployment job deploys the Edge Function and Worker, syncs configured Worker secrets, and smoke-tests `/api/health`. `POSTHOG_PROJECT_TOKEN` is present as a GitHub Actions secret and is synced to the Worker. Do not print or request its value.

Cloudflare Billing Read permission was not available through the connected account, so the effective plan/CPU entitlement could not be verified. Do not claim a plan tier or make billing changes. Observed Worker telemetry over the audited 24-hour window: approximately 1,448 Worker invocations; average CPU 124.8 ms, p95 211 ms, maximum 345 ms. In the same window, Supabase recorded 1,440 completed execution-log runs, all `SUCCESS`.

## Production state (verified 17 Nov 2026)

- `GET /api/health` returned `ok:true` and `liveTrading:false`. No live trading path is enabled.
- Paper account #1 is `RUNNING`, kill switch off, cash and equity Rp10,000,000. The account has not been reset or stopped during this work.
- Since the paper account reset at 14 Nov 2026 10:16:15 UTC, 0 positions have been opened. Three older CLOSED position rows exist outside the current reset window and are not current-period performance.
- Last 24 hours: 1,440 execution-log runs, all with status `SUCCESS`.
- The market catalog currently has 438 pairs; 8 are manually tracked and 5 currently qualify for the dynamic universe. `universeSize:25` is a configured maximum including manually tracked pairs, not a guarantee that 25 pairs pass the liquidity/spread screen.
- Since reset, the database contains 42 BUY signals and 204 SELL signals. BUY attempts were blocked by the execution/economics gates; no entry was forced.
- After the active fee configuration was updated at 16 Nov 2026 16:31:34 UTC, 495 pipeline runs recorded 7 BUY entry attempts, 0 positions opened, and 7 rejections: `stop_inside_spread` 5, `price_drift` 1, `net_reward_risk_below_minimum` 1. The gates are behaving as designed.
- Since the PostHog secret was synced, 90 `trading_pipeline_run` events and 5 `trading_signal_generated` events were observed. The five emitted signal events were SELL. There were no BUY attempts/rejections after telemetry activation in the observed period, so the absence of detailed rejection/open-position events is not evidence of a broken sender.

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

The 30-day historical evaluation (17 Oct–16 Nov 2026, 13 pairs) tested the production baseline, crossLookback=4, and an EMA21 pullback-reclaim shadow variant. All three had negative net expectancy, profit factor below 1, and fewer than the minimum 100 holdout trades. None met the release gate (at least 100 holdout trades, Wilson 95% lower win-rate bound ≥70%, PF>1, positive net expectancy).

| Variant | Holdout trades | Win rate | Profit factor | Net P/L |
|---|---:|---:|---:|---:|
| CrossLookback 2 | 40 | 25.00% | 0.441 | -Rp249,798.37 |
| CrossLookback 4 | 66 | 27.27% | 0.462 | -Rp430,393.60 |
| EMA21 continuation shadow | 19 | 26.32% | 0.318 | -Rp226,540.87 |

This was a 5m candle-only approximation, not production-parity: no historical bid/ask/tick fills, MTF score, or shared portfolio controls; dynamic slippage used current volume tiers as a proxy. Structural OHLC history coverage was 100%, but active-volume coverage was 82.54%. Read the full dated assessment: [docs/strategy-readiness-2026-11-17.md](docs/strategy-readiness-2026-11-17.md).

**Do not represent the strategy as profitable or ready for real-money use.** Keep the current engine in paper mode and collect fresh, untouched forward data. Do not tune against the same holdout. A candidate must be retested with quote/spread/fee/slippage and portfolio-cost parity before a manual release review.

## Current maintenance branch

Branch: `chore/engine-readiness-20261117` (based on main commit `5d503cd140822c40bbf1b00bc1ef30c804d3c5c7`).

Changes in progress:
- Correct stale README statements about production MTF mode, universe cap, fee, open-position cap, runtime measurements, and current paper-account status.
- Record a dated strategy NO-GO report with the actual holdout statistics and caveats.
- Add the active strategy configuration snapshot to future backtest output; refuse to run a backtest if no active strategy config exists.
- Add active config + historical fee-provenance caveat to the paper-account report.
- Align the local fee migration filename with the already-applied Supabase version `20261116163134`; this is a repository tracking correction only. **Do not re-run the SQL migration against production.**
- Keep the PostHog production operations dashboard separate from the legacy staging dashboard.

## Remaining release validation

1. Run CI typecheck, unit/integration tests, PostgreSQL migration assertions, and build on this branch. Resolve any failures before merge.
2. Merge only after checks pass; let GitHub Actions deploy production and run the new strategy evaluation.
3. Inspect the new evaluation artifact's `activeConfigSnapshot` and verify it records feePct 0.00555, MTF score, spread/slippage and risk caps.
4. Verify production health remains `liveTrading:false`, active Supabase strategy values and fee remain unchanged, cron continues to complete successfully, and new PostHog events are arriving.
5. Continue forward paper observation. Profitability remains unproven until a sufficiently large, untouched sample closes with realistic costs.

## Owner-only / unavailable checks

- Supabase Security Advisor previously reported leaked-password protection disabled and `system_locks` without client RLS policy (backend-only). No Auth policy or billing change was made during this work. Review the Auth setting in the owner's Supabase console.
- A final visual review of authenticated pages requires the owner's own browser session. No private user login or password was accessed.
- Current Cloudflare plan/entitlement is not verifiable through the connected API permissions; no plan upgrade or billing change was attempted.
