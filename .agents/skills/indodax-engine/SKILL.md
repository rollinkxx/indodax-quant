---
name: indodax-engine
description: How to change the indodax-quant paper-trading engine safely — where the strategy, fee, exit and risk logic lives, which invariants must not be broken, and how to prove a strategy change is real. Use when editing shared/strategy.ts, shared/paper.ts, shared/mtf.ts, worker/src/pipeline.ts, supabase migrations, backtest scripts, or when evaluating whether a signal has an edge.
---

# indodax-quant engine rules

Paper trading only. The repository contains no INDODAX private/trade API client, no
keys, no order submission; `paper_orders.is_simulated` is constrained to `true` and
`worker/src/indodax.ts` hard-blocks non-public endpoints (tested). Never add live
execution, API-key handling or withdrawals.

## Where things live

| Concern | File |
| --- | --- |
| Signal + indicators, `StrategyParams`, param validation | `shared/strategy.ts` |
| Fees, sizing, stops, trailing, exits, risk state | `shared/paper.ts` |
| 15m/1h confirmation (causal) | `shared/mtf.ts` |
| Decision audit trail | `shared/decisionPipeline.ts`, `shared/engineDecisions.ts` |
| Fill/quote realism | `shared/fillModel.ts`, `shared/quote.ts`, `shared/orderNormalize.ts` |
| Walk-forward, bootstrap, promotion criteria | `shared/walkForward.ts`, `shared/strategyEvidence.ts` |
| Backtest scope limits (user-visible) | `shared/backtestScope.ts` |
| Candle validation/gap fill | `shared/candles.ts` |
| Production pipeline (entry/exit ordering) | `worker/src/pipeline.ts` |
| Read-only experiments | `scripts/backtest.ts`, `scripts/alpha-research.ts`, `scripts/fee-sensitivity.ts` |

## Invariants (breaking any of these is a bug)

1. **Causality.** Indicators at bar `i` use only data `<= i`. `simulate()` enters at the
   *next* candle's open and only ratchets the trail from the bar after entry. Pinned by
   `tests/backtest-causality.test.ts`.
2. **Fee parity.** `simulate()`, `shared/paper.ts` and the SQL
   `paper_open_position`/`paper_close_position` must charge the same fee, the same 8dp
   notional rounding, and the same cost_basis/PnL formula. `feePct` is **percentage
   points per side**, not a fraction: `fee = notional * feePct / 100`. `feeModel:
   'pair_taker'` uses the per-pair INDODAX taker fee (0.2%/side for IDR pairs); under
   `pair_taker` a missing pair fee is a hard `missing_pair_fee` rejection, never a
   silent fallback. Pinned by `tests/backtest-fee-parity.test.ts`.
3. **Exit precedence, identical in backtest and runtime:** SL/TP → trailing → TIME_STOP
   → SIGNAL. A stop ratcheted above entry is attributed `TRAILING_STOP`, not
   `STOP_LOSS`; `TAKE_PROFIT` wins a gap through both levels.
4. **MTF parity.** When `mtfMode != 'off'`, the backtest must pass the raw 5m action
   through `evaluateMarketAction` + `applyMtfToMarketAction` exactly like the pipeline.
   Pinned by `tests/backtest-mtf-parity.test.ts`.
5. **Fail closed.** Missing/stale data, missing pair fee, or an unsatisfiable config
   must block entries and surface a reason, not trade anyway.
6. **Read-only scripts stay read-only.** Backtest and fee-sensitivity never write the
   active `strategy_configs` row and never place orders. `--overrides` is validated by
   `shared/backtestOverrides.ts` and applied in memory only.
7. **CI contract.** `scripts/write-evaluation-summary.mjs` reads the backtest keys
   `cross_lookback_2`, `cross_lookback_4` and `aggregateOutOfSampleIndependentPairAccounts`.
   Do not rename them.

## Known research state — do not re-litigate

The entry signal on 5m price/volume has **no edge** at 0.2%/side: BUY signals average
worse than the unconditional 2h forward return, no exit sweep or MTF config rescues it,
walk-forward is negative in most folds, and external free data (cross-exchange
lead-lag, Fear & Greed) failed a time-split holdout. The engine mechanics are sound —
the blocker is alpha. Do not "fix" this by loosening the economics gate
(`netRewardRiskGate`, `MIN_NET_REWARD_RISK_RATIO`), removing fees, or rewriting the
codebase. New ideas must clear `evaluatePromotion` / `DEFAULT_PROMOTION_CRITERIA`
(frozen config before the test fold, realistic fills, timestamped universe, ≥4 material
folds, bootstrap lower-95 expectancy > 0, no single pair/regime carrying the result).

## How to prove a strategy change

1. `npm run typecheck && npm test` — parity and causality suites must pass untouched.
2. Sweep read-only: `npm run backtest -- --overrides='{"trailActivationAtr":2.5}'`.
3. Forward-return study: `npm run alpha:research -- 30` (net of 0.4% round trip, 70/30
   chronological split, CANDIDATE only if positive on both).
4. Report the backtest scope warnings (`shared/backtestScope.ts`) alongside any number:
   independent per-pair accounts, next-open fills, no shared cash/exposure/kill-switch,
   no historical quotes.
5. State results net of fees and slippage, in IDR and percent, with sample size.

## Style

Minimal diffs, no new abstractions for one caller, comments only for non-obvious
invariants. Commit as `openhands <openhands@all-hands.dev>` with the co-author trailer.
Do not commit `.openhands/`, `.env` or scratch files.
