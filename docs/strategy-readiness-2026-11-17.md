# Strategy readiness assessment — 17 November 2026 (latest main evaluation)

## Release decision

**NO-GO for profitability claims and real-money execution.** The production engine is operational in paper mode, but none of the tested strategies meets the evidence gate. No variant is promoted, and no entry or risk gate is relaxed to force trades.

This is a strategy-performance failure, not a Worker availability failure. The Worker continues to collect market data and evaluate signals. Current market conditions often do not meet the configured BUY criteria, and the execution layer rejects BUY attempts that fail quote, spread, stop-distance, or net reward/risk checks.

## Source and reproducibility

Source: GitHub Actions [run #244](https://github.com/rollinkxx/indodax-quant/actions/runs/43991484904), artifact `strategy-evaluation`, generated on 17 Nov 2026. The evaluation runner now records the active configuration snapshot in `backtest.json` and fails closed if no active database strategy configuration exists.

- Official source: INDODAX public `tradingview/history_v2`, 1-minute OHLC, aggregated into complete 5-minute candles.
- Historical window: 18 Oct 2026 00:55 UTC to 17 Nov 2026 00:55 UTC.
- Active pairs evaluated: 12 (`btcidr`, `ethidr`, `asteridr`, `fartcoinidr`, `hypeidr`, `dogeidr`, `pepeidr`, `penguidr`, `pippinidr`, `skyaiidr`, `solidr`, `xrpidr`).
- 518,400 minute bars received and 103,680 complete 5-minute bars from 103,680 expected: 100% structural OHLC coverage.
- 16,797 five-minute bars had zero volume; 86,883 bars had positive volume, giving 83.8% active-volume coverage. Zero-volume bars are excluded from signal/execution and break contiguous warm-up.
- First 70% of each chronological series is context/warm-up; the final 30% is the holdout, beginning 8 Nov 2026 00:55 UTC. No entries are taken before the holdout.

### Active configuration snapshot used by run #244

The snapshot was fetched from the active `public.strategy_configs` row, updated 16 Nov 2026 16:31:34 UTC:

| Parameter | Captured value |
|---|---:|
| Signal timeframe | 5m |
| Fee assumption | 0.00555% per side |
| Slippage | Dynamic, base 10 bps |
| MTF mode | `score` |
| Risk per trade | 1% |
| Maximum position | 25% equity |
| Maximum open positions | 10 |
| Maximum total exposure | 60% |
| Maximum entry spread | 0.6% |
| Maximum entry drift | 0.5% |
| ATR stop / target | 1.5× / 3× |
| EMA cross lookback (control) | 2 |
| Dynamic universe cap | 25 including tracked pairs |
| Universe minimum 24h IDR volume | Rp1,000,000,000 |
| Universe maximum spread | 0.6% |

`feePct` is stored in percentage points. Therefore `0.00555` means `0.00555%` per side. This is the explicit user-selected paper modelling assumption, not independent proof that every account/market receives this all-in maker/taker fee. Spread and slippage remain separate costs.

### Aggregate out-of-sample results

Each pair was simulated independently with its own Rp10,000,000 initial balance; aggregate rows pool those independent trades. They are **not** a shared-cash portfolio equity curve.

| Variant | Holdout trades | Wins | Win rate | Profit factor | Net P/L (IDR) | Expectancy / trade |
|---|---:|---:|---:|---:|---:|---:|
| EMA crossover, crossLookback=2 (control) | 35 | 8 | 22.86% | 0.151 | -312,087.31 | -8,916.78 |
| EMA crossover, crossLookback=4 | 58 | 15 | 25.86% | 0.325 | -439,005.81 | -7,569.07 |
| EMA21 pullback-reclaim shadow (not traded) | 17 | 4 | 23.53% | 0.243 | -179,878.39 | -10,581.08 |

Wilson 95% lower win-rate bounds were 12.07%, 16.35%, and 9.55%, respectively. All three variants failed all four release checks:

1. At least 100 holdout trades.
2. Wilson 95% lower confidence bound of win rate at least 70%.
3. Profit factor greater than 1.
4. Positive net expectancy after modelled fees and slippage.

All three are **NO_GO**. The 70% figure is a release-gate condition, not a promised or achieved accuracy.

### Material backtest limitations

This is a 5-minute candle-only approximation, not production-parity execution:

- Historical bid/ask quotes and tick-level fills are unavailable. Entry is approximated at the next 5m open; exits use OHLC with stop-first assumptions and modelled slippage.
- Production MTF `score` (15m/1h) is not simulated.
- Shared cash, total exposure, max concurrent positions, daily-loss flattening and portfolio drawdown kill-switch are not simulated.
- Each pair starts with its own Rp10,000,000; aggregate results pool independent pair simulations.
- Dynamic slippage uses the current 24h volume tier as a historical proxy; historical volume tiers are unavailable.
- Structural OHLC coverage is 100%, but active-volume coverage is 83.8%.

The evaluation is sufficient to block promotion: even this simplified approximation is negative and under-sampled. It is not sufficiently realistic to forecast live/paper P&L.

## Production paper-engine evidence

Verified after deployment of main commit `75e38927deb22a7efe86cf99f2496e20655ac482`:

- Worker `indodax-quant` deployed successfully. The deployment smoke test returned `ok:true` and `liveTrading:false`.
- The paper account remains `RUNNING`, kill switch off, cash and equity Rp10,000,000; the account was not reset.
- The latest 24-hour execution-log audit had 1,440 successful runs and no failed or partial runs. After deployment, 60/60 checked pipeline runs were also successful.
- Each production cycle received 450 tickers, stored trades/candles, and ran the signal diagnostics. The latest inspected cycles had no qualifying BUY candidate; two pair/candle checks correctly reported `no_trades_in_signal_candle`.
- The paper report since account reset shows 39 BUY entry attempts, 0 opened positions and 39 rejections: `stop_inside_spread` 19, `net_reward_risk_below_minimum` 7, `wide_spread` 6, `net_reward_non_positive` 6 and `price_drift` 1.
- The paper report contains no closed trades since the current account reset. Therefore paper win rate, profit factor and expectancy are not established.
- Historical rejection logs preserve their original `fee_pct` values. Some attempts predate the fee update and used 0.3%; those values are not recalculated. The current active fee snapshot is 0.00555%.

These are safety-gate outcomes, not reasons to weaken the gates. No real orders are submitted.

## Monitoring

PostHog ingestion is active using the Cloudflare Worker secret `POSTHOG_PROJECT_TOKEN`. The [Indodax Quant Operations dashboard](https://us.posthog.com/project/688639/dashboard/2365869) contains:

- Daily production pipeline runs by status.
- Daily signals grouped by BUY/SELL.
- A strategy-readiness NO-GO note.
- Daily BUY attempts, paper entries opened and entry rejections from real pipeline counters.

The detailed rejection/open-position events are only emitted when those real actions occur. A zero counter means no such attempt occurred; it must not be filled with synthetic events.

## Operating decision and next validation

- Keep the current engine in paper mode. Do not enable real-money execution.
- Keep spread, stop-distance, fee/slippage, net reward/risk, exposure and account-risk gates unchanged.
- Do not tune against this 8–17 Nov holdout or automatically promote any variant.
- Continue forward paper collection with actual quotes/fills, fee and slippage, and portfolio constraints. Require at least 100 closed trades on an untouched holdout before any strategy review; preserve the Wilson lower-bound, PF and expectancy gates.
- If future BUYs are rejected, inspect the measured spread, stop location and net RR; do not force them through.
- Reassess with a production-parity replay that captures historical bid/ask/quotes and portfolio interactions before treating a positive candle-only backtest as credible.
