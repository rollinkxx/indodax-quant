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

## Finding 4 (fixed): the backtest could not simulate any timeframe but 5m

`simulate()` called `fillGaps(candles, 300)` and `hasBacktestDataQuality(series, i, minCandles)`
with the default `intervalSec = 300`. Fed a 1h or 4h series — which the 4h research cache and
any aggregated series produce — both assumed every bar was 5 minutes apart:

- `fillGaps` injected **11 synthetic bars between every real 1h candle**.
- The warm-up check then saw a synthetic bar as its immediate predecessor on every real bar,
  reset `contiguous` to 1, and failed `contiguous >= minCandles`.

Result: **zero trades, no error, no warning.** Every higher-timeframe research run in this
repository before this fix silently measured nothing. The `timeStopMinutes` check was hardcoded
to 5 minutes per bar for the same reason, and MTF aggregation tried to build 15m/1h buckets out
of an already-1h series.

Fixed by inferring the interval from the data (`inferIntervalSec`, snapped to a standard bar
size) and threading it through the gap filler, the warm-up check, the time stop, and the MTF
guard (MTF is disabled when the base series is coarser than the bucket). Three regression tests
cover it, including one that asserts a 1h series produces trades.

## Finding 5: with the timeframe bug fixed, higher timeframes are worse, not better

The structural argument for higher timeframes is real. Round-trip cost is roughly fixed at
0.6% (fee+slippage) plus the spread, while ATR grows with the bar:

| timeframe | median ATR % of price | cost / ATR |
|---|---|---|
| 5m | 0.201% | **3.88×** |
| 15m | 0.465% | 1.68× |
| 1h | 1.159% | 0.67× |
| 4h | 3.657% | 0.21× |

A 5m trade must travel 3.88 ATR just to break even. And the gate agrees: the share of BUY
signals clearing `minNetRewardRiskRatio` rises from **11.6% at 5m to 65.9% at 1h**.

So the hypothesis was that 1h would trade more *and* better. It trades more. It is much worse:

| timeframe | n | win% | mean net | median net | PF | positive folds |
|---|---|---|---|---|---|---|
| **5m** | 57 | **68.4%** | **+615** | +36,474 | **1.02** | 2/5 |
| 15m | 73 | 49.3% | −25,404 | −856 | 0.42 | 0/5 |
| 30m | 93 | 46.2% | −28,011 | −10,775 | 0.40 | 0/5 |
| 1h | 77 | 39.0% | −39,201 | −67,867 | 0.28 | 0/5 |

(Live params, real per-pair spread charged, spread-eligible pairs only.)

The interpretation is uncomfortable but clear: the EMA-crossover entry carries no directional
edge, so widening the bracket just makes each losing trade bigger. The 5m result only looks best
because the 9/5 bracket manufactures a high win rate at zero gross expectancy — its PF of 1.02 is
noise around break-even on 57 trades, not an edge. Larger ATR does not rescue a signal with no
information; it amplifies the loss.

**Conclusion for the engine's usability:** the machinery is now correct and can be trusted to
measure what it is given. What it measures is that this entry rule has no edge at any timeframe
tested, after real costs. Making the engine "usable" is therefore not a bug-fix problem — it
needs a different entry signal, which is a research decision, not a repair.

## Finding 6 (verified, not a bug): the paper ledger is internally exact

Audited all 16 closed positions against `paper_accounts.cash_balance`. Per position the identity
`realized_pnl = qty * exit_price - exit_fee - cost_basis` holds to 0.0000, and
`cost_basis = qty * entry_price + entry_fee` holds to 0.0000. Summing the ledger gives
−298,941.42 while cash moved −238,041.69; the Rp60,900 gap is exactly the three positions
(id 2–4) opened before `paper_accounts.reset_at`, which the reset correctly wrote off. No drift.

Two things that looked like bugs and are not:

- **Trailing stop can be set above the take-profit.** `trailingStop()` has no TP ceiling, so
  calling it with a bid above the target returns a stop above the target. It cannot happen: the
  caller only reaches it when `exitReason()` returned null, which means `bid < takeProfit`.
  The invariant holds by construction, so no ceiling was added — a defensive clamp would hide
  the real contract instead of enforcing it.
- **Historical fees of 0.00555%/side on positions 5–13.** Real, already diagnosed and fixed by
  `supabase/migrations/20261118120000_fix_undercharged_paper_fee.sql`: a 2026-11-16 migration set
  that assumption, nine trades were 36× under-charged, and the same value fed the reward/risk
  gate so entries the gate should have rejected were opened. `feeModel` is now `pair_taker` and
  `feePct` is a fallback pinned at the real 0.2%.

## Finding 7 (fixed): an impossible bracket could be saved and would silently kill the engine

The entry gate rejects any signal whose *net* reward/risk is below `minNetRewardRiskRatio`. Costs
only ever reduce that ratio, so a bracket whose **gross** `TP/SL` is already below the minimum can
never pass — every signal is rejected forever, with no error, no alert, and a healthy run status.

On 2026-11-19 the live config was 9 ATR stop / 5 ATR target (gross 0.556) against a 0.4 floor.
It was not quite impossible, but it was close enough to be nearly inert: at the median 5m ATR of
0.201% the net ratio is 0.087, and the bracket only clears 0.4 once ATR reaches ~0.78%, i.e. 3.9×
the median. That is why 100 BUY signals in six days produced 16 positions, and why the last one
(run 8962, 10:25) was rejected as `net_reward_risk_below_minimum`.

`validateBracketEconomics()` now rejects such a config at save time. It is deliberately **not**
part of `validateParams()`: `mergeParams()` validates the whole stored set and falls back to
`DEFAULT_PARAMS` on any error, so folding this rule in would silently reset every other parameter
of a config that already had an impossible bracket. The check runs only on the admin PUT path.

## Verification of the live system

- `GET /api/health` → `{"ok":true,"liveTrading":false}`.
- Last three cron runs: `SUCCESS` in 10–18s.
- Run 8962 end-to-end: 1 BUY signal created → received by `paper_trading` → rejected at
  `net_reward_risk_below_minimum`. Signal generation, gating, and rejection telemetry all work.
- Supabase reachable; `market_pairs` carries `trade_fee_percent_taker = 0.2` for all 438 pairs.
