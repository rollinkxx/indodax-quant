# Forensic audit of the buy/sell/hold engine

Date: 2026-11-19
Scope: `shared/strategy.ts`, `shared/paper.ts`, `worker/src/pipeline.ts`, `scripts/backtest.ts`,
the active `strategy_configs` row, and the 16 closed paper positions.

This is the audit the previous documents did not do: instead of asking "does the entry have
edge", it asks "is the machinery around the entry correct". Three defects were found, one was
fixed, and one long-standing measurement bias was identified.

## Finding 1 (fixed): the trailing-stop break-even floor ignored the spread

`roundTripCostPct` charged `fee x 2 + slippage x 2` and nothing else. But entries fill at the
**ask** and exits at the **bid**, so the quoted spread is a round-trip cost exactly like the
fee — and on INDODAX it is by far the largest one:

| 24h IDR volume | pairs | median spread |
|---|---|---|
| ≥ 10 B | 3 | 0.055% |
| 1 B – 10 B | 16 | 0.183% |
| 100 M – 1 B | 58 | 1.272% |
| 10 M – 100 M | 129 | 2.041% |
| < 10 M | 243 | 3.448% |

Universe-wide the median spread is **2.538%**, against a 0.6% fee+slippage assumption. The
break-even price that `trailingStop` enforces was therefore too low, and on a wide pair the
stop could ratchet to a level that still settled net negative after the exit crossed the
spread.

Three historical positions show the effect directly (all closed before the break-even floor
existed in commit `606fa5e`, so this is the class of bug that fix was aimed at, now closed
properly):

| id | pair | entry | stop | stop vs entry |
|---|---|---|---|---|
| 7 | btcidr | 1,189,571,383 | 1,192,531,490 | **+0.25%** |
| 9 | pippinidr | 202.2844 | 202.4938 | **+0.10%** |
| 14 | pippinidr | 333.3320 | 342.6240 | +2.79% (legitimate) |

Position 9's stop sat 0.10% above entry — far under the 0.6% fee+slippage floor, and nowhere
near covering the spread. It closed at **−4,128**.

Fix: `roundTripCostPct(feePct, slippageBps, spreadPct = 0)` now adds the spread, and the
pipeline passes the live `(ask-bid)/bid`. The backtest passes nothing and keeps its previous
behaviour, because a candle-only simulation has no quote to read.

## Finding 2: the active bracket cannot profit, and barely trades

The active config (`20261118160000_exit_bracket_win_rate_profile.sql`) sets **SL 9 ATR /
TP 5 ATR / minNetRewardRiskRatio 0.4**. The migration is candid about its evidence ("24 trades
… positive in only 2 of 5 folds … not a proven edge"), and the audit confirms the arithmetic:

- In a driftless market the probability of touching the target first is
  `stop / (stop + target)` = 9/14 = **64.3%**. Observed win rate is 68.6%. So the 68.6% is
  bracket geometry, not skill.
- Gross expectancy = 0.643 × 5 − 0.357 × 9 = **exactly 0**. Every cost then makes it negative.
- Net reward/risk at this bracket is **0.365**, below the 0.4 floor the same migration set.

The second point is not theoretical. Replaying the real gate over 2,501 historical BUY signals:

| outcome | share |
|---|---|
| `net_reward_risk_below_minimum` | **67.7%** |
| `net_reward_non_positive` | 17.0% |
| `PASS` | **11.5%** |
| `stop_inside_spread` | 2.0% |
| `wide_spread` | 1.7% |

Only 11.5% of signals can open a position. That is the real reason the paper account has
16 closed trades: the engine is not broken, it is starved. The cause is that a 5m ATR is tiny
relative to the spread — median ATR is **0.201%** of price, while the gate needs roughly 0.5%
for this bracket to clear 0.4 net reward/risk. Only 16.4% of candles have ATR above 0.6%.

A bracket sweep on the live 5m data with real per-pair spread charged (5 chronological folds,
`eligible` pairs only) shows 9/5 is the least-bad option, not a good one:

| SL | TP | minRR | n | win | mean net | PF | positive folds |
|---|---|---|---|---|---|---|---|
| **9** | **5** | **0.4** | **57** | **68.4%** | **+615** | **1.02** | **2/5** |
| 1.5 | 3 | 1 | 91 | 41.8% | −10,798 | 0.68 | 0/5 |
| 1.5 | 3 | 0.4 | 167 | 32.3% | −17,084 | 0.47 | 0/5 |
| 2 | 4 | 0.4 | 204 | 28.9% | −19,252 | 0.41 | 0/5 |
| 3 | 2 | 0.4 | 42 | 54.8% | −8,839 | 0.70 | 2/5 |

So the win-rate profile is the best available configuration and it still fails the
2-of-5-folds bar that the project treats as the minimum for a claim. Nothing here is worth
changing on the strength of 57 trades.

## Finding 3 (not fixed, documented): the backtest never charged the spread

`scripts/backtest.ts` fills at `next.o` / `c.c` with slippage and fee but **no spread**. The
live pipeline fills at `t.ask` / `t.bid`. Every research number produced by this repo is
therefore optimistic by roughly the spread, which — per Finding 1 — is the dominant cost.

This is why the 4h pullback rule looked profitable at a flat 0.6% and collapsed to −1.36% mean
once per-pair spreads were charged (see `entry-edge-4h-2026-11-19.md`). The lesson generalises:
**any backtest result in this repo must be re-read with the spread subtracted before it is
believed.**

It is deliberately not "fixed" by baking a constant into `simulate()`, because the honest
version needs a per-pair, per-period spread series, and INDODAX only exposes the current quote.
A constant would trade one bias for another. The correct next step is to record
`market_tickers_latest` history so a spread series exists.

## What was verified, and found correct

- **Buy/sell/hold state machine** (`evaluateMarketAction`): SELL is never blocked by MTF,
  `sellRequireConfirm` requires RSI and volume confirmation, and a fresh cross-down without
  confirmation correctly returns HOLD with a specific reason. No defect found.
- **Spread is genuinely paid on entry**: `fill = buyFillPrice(t.ask, slip)`, and the economics
  gate is fed that same `fill`, so the spread reaches the reward/risk calculation. The gate is
  conservative, not permissive.
- **`signalExitCoversCosts`**: compares sell proceeds (at bid, less fee) against `cost_basis`
  (built from the ask). The spread is already captured there. No defect.
- **Stops are always below entry at open**: 13 of 16 historical positions have `stop_loss <
  entry`; the 3 exceptions are ratcheted trailing stops, and only one of those (id 14, +2.79%)
  is above the true break-even. The other two predate the break-even floor.
- **Long-only enforcement**: a SELL with no open position is stored as a signal but never
  treated as a short. `liveTrading` remains false.

## Status

One code change shipped: `roundTripCostPct` charges the spread, with the pipeline passing the
live quote and 2 new tests covering the floor behaviour. 387 tests pass, typecheck clean.

Findings 2 and 3 are documented, not changed: the bracket has no defensible alternative at
n=57, and the backtest spread model needs data the exchange does not provide historically.
