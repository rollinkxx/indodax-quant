# Strategy readiness assessment — 17 November 2026

## Release decision

**NO-GO for profitability claims and real-money execution.** The engine is running in paper mode, but the current EMA crossover strategy and the two tested alternatives do not meet the project's evidence gate. No variant is promoted and no entry/risk filter is relaxed.

This is a research result, not a statement that the Worker is broken. The engine is generating signals, evaluating current quotes, and refusing entries whose spread, stop location, or net reward/risk makes the trade uneconomic.

## Historical evaluation

Source: GitHub Actions workflow run [#242](https://github.com/rollinkxx/indodax-quant/actions/runs/43908603234), artifact `strategy-evaluation`. The run fetched 30 days of official INDODAX public 1-minute OHLC history and aggregated complete 5-minute bars.

- History window: 17 Oct 2026 16:30 UTC to 16 Nov 2026 16:30 UTC.
- 13 pairs evaluated; 112,320 of 112,320 expected complete 5m bars (100% structural coverage).
- 19,614 bars had zero volume; active-volume coverage was 82.54%. Zero-volume bars were not used for signal/execution and break the contiguous warm-up.
- The first 70% of each chronological series was context/warm-up. The last 30% was the holdout, beginning 7 Nov 2026 16:30 UTC. No entries were taken before the holdout.

### Aggregate out-of-sample results

| Variant | Trades | Wins | Win rate | Profit factor | Net P/L (IDR) | Expectancy / trade |
|---|---:|---:|---:|---:|---:|---:|
| EMA crossover, crossLookback=2 (control) | 40 | 10 | 25.00% | 0.441 | -249,798.37 | -6,244.96 |
| EMA crossover, crossLookback=4 | 66 | 18 | 27.27% | 0.462 | -430,393.60 | -6,521.12 |
| EMA21 pullback-reclaim shadow (not traded) | 19 | 5 | 26.32% | 0.318 | -226,540.87 | -11,923.20 |

All three variants failed all four release checks:

1. At least 100 holdout trades.
2. Wilson 95% lower confidence bound of win rate at least 70%.
3. Profit factor greater than 1.
4. Net expectancy after modelled fees/slippage greater than zero.

The lower 95% win-rate bounds were 14.19%, 18.00%, and 11.81%, respectively. Samples are also below the minimum, so none is eligible for promotion.

### Important limitations

The result is a 5m candle-only approximation, not production-parity execution or a shared-portfolio backtest:

- No historical bid/ask quotes, historical spread gate, or tick-level fills. Entry is approximated at the next 5m open and exits use OHLC with stop-first assumptions.
- Production MTF `score` (15m/1h) is not simulated.
- Shared cash, aggregate exposure, max concurrent positions, daily-loss flattening, and portfolio drawdown kill switch are not simulated. Each pair starts with its own Rp10,000,000; aggregate metrics pool independent pair simulations.
- Dynamic slippage tiers use the current ticker-volume tier as a proxy for the historical sample.
- Active-volume coverage is lower than structural OHLC coverage.

This backtest must not be presented as an accurate production P/L forecast. Its NO-GO result is nevertheless sufficient to prevent promotion: even the optimistic approximation is materially negative and under-sampled.

## Live paper-engine evidence

Verified against Supabase project `sinyalku` and Cloudflare Worker `indodax-quant` on 17 Nov 2026:

- Paper account #1 is `RUNNING`, kill switch off, cash/equity Rp10,000,000. No live exchange orders are sent by this system.
- The 24-hour execution-log window contained 1,440 runs, all recorded as `SUCCESS`.
- The production universe has 8 manually tracked pairs and 5 dynamic members at the audit point (438 IDR market pairs in the catalog). The configured selector cap of 25 is not a promise that every pair qualifies.
- From the active fee configuration update at 16 Nov 2026 16:31:34 UTC through the latest checked run, there were 495 pipeline runs, 7 BUY entry attempts, 0 paper positions opened, and 7 rejections:
  - `stop_inside_spread`: 5
  - `price_drift`: 1
  - `net_reward_risk_below_minimum`: 1

These rejections are expected safety behavior. Do not relax the filters to force entries. The full account-reset history also contains older rejections recorded before the fee change; their recorded `fee_pct` values are historical and are not recalculated.

## Cost-model interpretation

The active strategy stores `feePct = 0.00555`. The shared calculation treats this as percentage points, so it means **0.00555% per side**. It is the explicit paper-model assumption requested for this project; it is not an independent verification that this is the all-in maker/taker fee for every account, market, or execution type. Spread and slippage remain separate costs. Old paper rejection logs keep the fee value recorded at the time of each run.

The backtest runner now writes the active strategy-config snapshot (including fee, slippage, MTF, spread, and sizing assumptions) into each new artifact, and refuses to run when no active strategy config exists. The paper report now records the active config and explains that historical rejection metrics retain their original fee assumptions.

## Monitoring

PostHog ingestion was verified after `POSTHOG_PROJECT_TOKEN` was synced into the Cloudflare Worker. The production dashboard is [Indodax Quant Operations](https://us.posthog.com/project/688639/dashboard/2365869). It tracks daily pipeline status and generated signal direction and carries this NO-GO release note.

The first 90 post-deployment pipeline events had zero BUY entry attempts and zero rejection events; five emitted signal events were SELL. Therefore the absence of `paper_entry_rejected` and `paper_position_opened` events at that point reflects no such post-deploy activity, not evidence that the detail-event sender failed. Those events are emitted when corresponding real paper events occur.

## Operating decision and next validation

- Keep the paper account running; no real orders, no exchange private API credentials, and no withdrawal/trading endpoints are enabled.
- Keep the current spread, stop-distance, cost, reward/risk, portfolio, and account-risk gates.
- Do not tune variants against the same 7–16 Nov holdout. A future candidate needs a new, untouched chronological holdout and production-parity execution assumptions.
- Continue collecting forward paper data with actual quotes/fills, modelled two-sided fee and slippage, portfolio constraints, and at least 100 closed holdout trades before reassessment. The 70% lower-confidence-bound condition is a release gate, not a promised accuracy.
- Review data-quality coverage and rejection reasons before adjusting the eligible universe. Increasing the universe or lowering thresholds only to create more trades is not a valid strategy improvement.
