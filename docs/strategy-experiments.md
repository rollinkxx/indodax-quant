# Controlled strategy experiments

This work keeps the active strategy unchanged: EMA 9/21/50, RSI 50–65, volume >= 1.2x MA20, max extension 1.5%, `crossLookback=2`, MTF `score`, and existing paper risk controls.

## Variants

1. **Control:** production parameter set with `crossLookback=2`.
2. **Single-variable test:** identical parameters with only `crossLookback=4`.
3. **Shadow continuation:** EMA9 > EMA21 > EMA50, price above EMA50, prior close at/below EMA21 then a completed close reclaim above EMA21, no recent fresh EMA cross, RSI/volume/extension filters pass. This variant is diagnostic/backtest-only and is never sent to paper execution.

The pipeline stores per-pair `continuation_diagnostics` in run logs. It does not add shadow candidates to `trading_signals`, notifications, or paper orders.

## Backtest

Run:

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run backtest
```

The script asserts that the controlled pair differs only in `crossLookback`. It reports per-pair results for the full available sample and the last chronological 30% holdout. The first 70% supplies indicator warm-up/context; no new position is opened before the holdout boundary.

The simulation is a per-pair 5m candle approximation. Historical bid/ask, tick-level execution, true historical liquidity tiers, MTF confirmations, and shared portfolio/risk constraints are not available. Outputs must not be described as production-parity results or proof of profitability. Compare trade count, win rate, profit factor, expectancy, average win/loss, and simulated drawdown; treat small samples as inconclusive.

## Paper execution funnel

Every rejected BUY entry now logs `pair_id`, `signal_id`, stage, stable reason, and spread/stop-distance metrics where relevant. Each run also stores rejection counts by reason. These diagnostics help distinguish a missing signal from a valid signal rejected by execution economics or portfolio risk.

## Paper performance report

Run:

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run paper:report -- 1
```

The report scopes closed paper trades, fees, expectancy, profit factor, win rate, drawdown, and entry-rejection counts to the selected paper account's latest reset. No orders are submitted.

## Promotion rule

Do not switch the active strategy to `crossLookback=4` or continuation based on signal frequency alone. Require a meaningful out-of-sample sample, positive net expectancy after fees/slippage, acceptable drawdown, and forward paper results. Keep the active production setting at `crossLookback=2` until those checks justify a separate approved change.
