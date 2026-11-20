# Audit remediation — execution and promotion gates (20 November 2026)

Scope: the 12-part audit list supplied for this remediation. **Read-only research tooling; no live
trading, no order placement, and no change to the active `strategy_configs` row.** Status remains
**NO-GO for real money** and **NO-GO for profitability claims**.

## What changed, per audit item

| § | Requirement | Where it now lives |
|---|---|---|
| 1 | Live trading stays off until every gate passes | This document; `evaluatePromotion` in `shared/walkForward.ts` |
| 2 | Fill model: spread, slippage, fees, partial fill, participation, latency, stale/missing quote | `shared/fillModel.ts`, `shared/quoteHistory.ts`, `shared/portfolioBacktest.ts` (`resolveFill`) |
| 2 | Candle-only runs must be labelled, never called production | `PortfolioFillModel.label` = `CANDLE_ONLY_OPTIMISTIC` \| `QUOTE_BASED`; the engine also derives `effectiveFillLabel`, so a `QUOTE_BASED` model whose quotes were all stale is demoted instead of trusted |
| 2 | Spread scenarios P50/P75/P90/P99 | `SPREAD_SCENARIOS` in `shared/fillModel.ts`, applied in `scripts/backtest.ts` |
| 3 | Portfolio chronology: one cash pool, exits before entries, ranking, exposure caps, kill switch | `simulatePortfolio` in `shared/portfolioBacktest.ts` |
| 3 | Timestamped universe | `public.market_universe_history` (migration `20261120100000`) records membership intervals; `set_universe` appends/closes them; `memberAt` / `normalizeIntervals` in `shared/universe.ts`; the portfolio engine gates entries on `universe_gate:not_in_universe` and reports `universeIsTimestamped` |
| 4 | Timeframe adapter with contracts, 4h research-only | `shared/timeframes.ts` + `tests/timeframes.test.ts` |
| 4 | Compare 5m / 1h / 4h on net expectancy | `npm run backtest:timeframes` (`scripts/backtest-timeframes.ts`) |
| 5 | Separate raw signal / MTF / economics / risk / final + counters | `shared/decisionPipeline.ts`, wired into `worker/src/pipeline.ts` paper step |
| 6 | BUY/SELL/HOLD rules | `combineDecision` precedence + `entryGate` / `netRewardRiskDiagnostics` / risk gates |
| 7 | Stale and future-dated quotes, UNKNOWN valuation, explicit kill states | `shared/quote.ts` (`assessQuote`, `valuationHealth`, `killSwitchState`) |
| 8 | Lease TTL > p99, fencing token, heartbeat, owner-checked finish | `shared/lease.ts`, `worker/src/pipeline.ts`, `tests/sql/pipeline_lease_fencing_test.sql` |
| 9 | Cross-field parameter validation | `validateCrossFieldParams`, `validateEvidenceRequirements`, `checkReportedWinRate` in `shared/strategy.ts`; surfaced in `worker/src/api.ts` |
| 10 | Multi-fold walk-forward with embargo + cluster bootstrap | `shared/walkForward.ts`, run in `scripts/backtest.ts`; trades carry a `regime` label so the regime cluster is not degenerate |
| 11 | Promotion criteria incl. concentration and outlier dependence | `evaluatePromotion` + `PromotionRobustness`: single-pair and single-regime share, top-trade dependence, frozen config, earned fill label, timestamped universe |
| 12 | Implementation order | Followed: quote/kill-switch → lease → precision → decision split → quote history → portfolio → fill → walk-forward → timeframes → comparison → paper forward → live |

## Promotion gate (paper forward)

A run is eligible for paper-forward review only when **all** of these hold:

- at least 4 material folds, a majority positive, and no fold worse than −Rp1 expectancy;
- pooled profit factor > 1 after realistic costs;
- bootstrap lower-95 mean expectancy > 0, clustered by pair (also reported by day and regime);
- drawdown within the risk budget;
- no single pair contributes more than 60% of gross absolute PnL, and no single market regime more
  than 80% (regime labels come from `regimeAt`, a causal 50-bar trend proxy; unlabelled trades count
  as one bucket, so a missing label can never look like diversification);
- net PnL stays positive after removing the best 5 trades;
- the configuration was frozen before the test folds were read;
- the fill model is `QUOTE_BASED`, not candle-only (an earned label, not a configured one);
- universe membership was timestamped, not today's flags applied to all history;
- portfolio constraints were active.

Eligibility is a filter for human review. Nothing is auto-promoted, and live trading is not in scope
for this codebase at all.

## How to run

```bash
npm run backtest                 # per-pair + shared-cash portfolio + walk-forward + spread scenarios
npm run backtest:timeframes      # 5m / 1h / 4h comparison ranked on lower-95 net expectancy
npm test                         # unit + integration
npm run typecheck
```

`npm run backtest` now emits `portfolioChronology` with: per-scenario net PnL, drawdown, concurrency,
turnover, forced end-of-data exits, partial fills, rejected orders, per-pair contribution, rejection
reason histogram, quote-fill counts, the fold table, the three bootstraps, and the promotion decision.
`aggregateOutOfSampleIndependentPairAccounts` is kept unchanged so the CI evaluation summary keeps
working; its `aggregateAccountMeaning` now points at `portfolioChronology` for the shared-cash view.

## Universe history

`set_universe` writes membership as half-open `[effective_from, effective_to)` intervals rather than a
flag, so a historical run can ask "was this pair a member at time T?".

- a leaving pair's interval is **closed**, never deleted, so earlier membership still resolves;
- `source` is `universe` (dynamic) or `pinned` (manually tracked) and is part of the primary key, because
  a pair can hold both memberships with different lifetimes;
- `clock_timestamp()` rather than `now()` bounds each interval: `now()` is constant inside a
  transaction, so two updates in one transaction would produce identical boundaries;
- the backtest looks membership up at the **signal** bar, not at fill time;
- `tests/sql/universe_history_test.sql` (in CI) asserts the close-not-delete behaviour and that no pair
  is ever a member through two overlapping intervals.

## Known gaps (do not paper-forward on these)

1. **Universe history only starts now.** `market_universe_history` is append-only from this migration
   forward, so the seeded interval begins at the migration (or at the pair's `universe_since`). Earlier
   history has no membership record and the run is reported as `universeIsTimestamped: false`, which
   blocks promotion. It is not retroactively invented.
2. **No order-book depth.** Depth is approximated by bar volume × participation rate; there is no
   historical bid/ask size, so `partialFills` is a volume cap, not a book walk.
3. **Quote history is short.** `market_tickers` is retained for 8 days
   (`20261119130000_reclaim_disk_and_bound_growth.sql`), so `QUOTE_BASED` runs only cover recent weeks.
   Longer windows fall back to `CANDLE_ONLY_OPTIMISTIC`, which can never be promoted.
4. **1h/4h are research-only.** The production pipeline ingests and signals on 5m only, so a 1h/4h
   result cannot be reproduced forward until that pipeline exists.
5. **No paper-forward run yet.** No configuration has completed a frozen-parameter forward run.

Until 1–5 are closed, the standing decision is **NO-GO**.
