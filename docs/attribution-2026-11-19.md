# Win/loss and profitability attribution — 2026-11-19

Scope: the INDODAX paper engine on 5m candles, 28 pairs with enough stored history. Everything here
is paper trading; `liveTrading` stays `false`. Two source-of-truth datasets are used:

- **Realised paper account** (`paper_positions`, 15 closed trades, 2026-11-13 to 2026-11-19) — what
  the engine actually did before the fixes landed.
- **Replay of the stored 5m candles** with the same fee model — used to attribute each exit, because
  the paper account is too small to separate the effects.

## 1. Realised paper account, before the fixes

| exit reason | n | wins | avg PnL | total PnL |
|---|---|---|---|---|
| STOP_LOSS | 11 | 0 | -36,545 | -401,995 |
| TRAILING_STOP | 2 | 1 | +15,678 | +31,357 |
| TAKE_PROFIT | 2 | 2 | +24,008 | +48,017 |

15 trades, 20.0% win rate, **-322,622 IDR** net. Fees paid: 38,241 entry + 38,049 exit = **76,290**
IDR, i.e. 24% of the loss. The remaining -246,332 is price movement plus slippage.

Note the shape: every stop-loss lost and every target won, so the loss is not a hit-rate accident —
the stops were simply hit far more often than the targets.

## 2. A fee-charging defect inside this sample

Nine of the fifteen trades were charged a **0.011%** round trip instead of the real 0.4%:

| opened | pair | fee % of cost |
|---|---|---|
| 2026-11-13 | nearidr, anoaidr, hypeidr | 0.59–0.61 |
| 2026-11-17 → 2026-11-18 | hypeidr, fartcoinidr, btcidr, cstidr, pippinidr, pepeidr, uaiidr, fartcoinidr, penguidr | **0.011** |
| 2026-11-18 → 2026-11-19 | pippinidr, icntidr, pippinidr | 0.39–0.40 |

That window matches the stale `feePct = 0.00555` assumption that migration `20261118120000` removed.
Those trades look less bad than they were; the -322,622 figure is therefore **optimistic**. It also
means the `net_reward_risk` entry gate was reading a 36x-too-small cost during that window, so it
admitted setups it should have rejected.

## 3. Replay attribution, current active config

| exit | n | avg gross | avg net | win rate |
|---|---|---|---|---|
| TAKE_PROFIT | 16 | +5.137% | +4.717% | 100% |
| SIGNAL | 3 | +0.644% | +0.242% | 100% |
| STOP_LOSS | 7 | -7.898% | -8.266% | 0% |

26 trades, 73.1% win rate, +790 IDR expectancy, profit factor 1.03. The win rate is high because the
bracket is deliberately asymmetric (5x ATR target, 9x ATR stop): the target is nearer than the stop,
so it is touched first more often. Profit factor near 1.0 is the honest read — the engine is close to
break-even, not profitable.

## 4. Where the loss actually came from

Two mechanisms, both now fixed:

**Trailing stop below break-even.** `trailingStop()` ratcheted to `bid - trailDistanceAtr * ATR` with
no cost awareness. 1x ATR on 5m candles is often ~0.2%, half the 0.4% round trip, so a trailed exit
could sit under break-even and guarantee a loss. Measured before the fix: 35 TRAILING_STOP exits at
**+0.134% gross but -0.265% net**, 20% wins. After passing the round-trip cost in: +0.828% gross,
**+0.426% net**, 100% wins.

**SELL exits that booked a loss to save a fee.** 24 SIGNAL exits averaged **-0.572% gross and
-0.969% net** at a 4.2% win rate. They were paying another 0.2% to leave a position that was already
slightly down, instead of letting the stop decide. With the cost guard, 3 SIGNAL exits remain, all
winners at +0.242% net.

## 5. Fee drag

At the real 0.2% taker rate the round trip is 0.4%, plus 10 bps slippage per side. A trade that moves
+0.4% gross therefore nets roughly zero. This is why the fee is not a detail:

- 15 realised trades paid 76,290 IDR in fees on 37.15M IDR of entry cost basis. That is only
  0.205% of turnover, about half the true round trip, precisely because nine of those trades were
  undercharged (section 2). At the real rate the fee bill would have been roughly 150,000 IDR.
- Every exit family must clear 0.4% before it contributes anything, which is why the old 1:1
  reward/risk floor produced a 3.9% win rate — the targets were 0.10–0.46% away, at or below the
  cost of the round trip.

## 6. Per-pair, realised

| pair | n | wins | PnL |
|---|---|---|---|
| nearidr | 1 | 1 | +37,551 |
| btcidr | 1 | 1 | +10,465 |
| pepeidr | 1 | 0 | -22,690 |
| uaiidr | 1 | 0 | -26,362 |
| penguidr | 1 | 0 | -30,364 |
| cstidr | 1 | 0 | -37,537 |
| pippinidr | 3 | 1 | -38,971 |
| fartcoinidr | 2 | 0 | -40,706 |
| hypeidr | 2 | 0 | -47,923 |
| icntidr | 1 | 0 | -61,701 |
| anoaidr | 1 | 0 | -64,384 |

No pair is a reliable edge with n=1–3. The two winners were both large moves (take-profit and a
trailed winner); the losses cluster on thin, newly listed pairs where 5m ATR is large enough to hit a
9x ATR stop before any target.

## 7. What remains unproven

- 26 replay trades and 15 realised trades are both small samples.
- 5-fold walk-forward on the current config is positive in **2 of 5** folds; the unguarded version was
  **0 of 5**. Improvement, not robustness.
- Twelve entry families across five bracket geometries (60 configs) were all negative before costs.
  No directional edge has been demonstrated at 5m. The gains here come from **not paying fees to exit
  at a loss**, and from a bracket shape that fits the cost floor.
- Next honest step is to evaluate a longer window and a 15m/1h entry, not to tune the 5m bracket
  further against the same 48 days of data.
