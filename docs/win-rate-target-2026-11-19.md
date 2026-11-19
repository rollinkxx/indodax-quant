# Target 50% win rate *and* profit: what the data says

Date: 2026-11-19
Data: 28 pairs, 485,110 closed 5m candles, 2026-09-20 → 2026-11-19 (60 days)
Cost model: 0.2%/side taker + 10 bps slippage = **0.60% round trip**

## The goal, stated precisely

Not "50% win rate" alone — that is easy and meaningless. The requirement is:

> win rate ≥ 50% **and** positive expectancy, consistently across periods.

Win rate alone can be manufactured. On a driftless random walk with a
take-profit at `TP` and a stop at `SL`, the probability the target is touched
first is exactly `SL/(SL+TP)`. Setting TP=1 ATR and SL=9 ATR yields a 90% win
rate that loses money every time. Any claim of a high win rate must be read
next to its profit factor.

## Result: not achieved. Three independent lines of evidence.

### 1. The current config already clears 50% — and still loses

Production config, full 60-day sample:

| metric | value |
|---|---|
| trades | 70 |
| win rate | **68.6%** |
| expectancy | **−329 IDR/trade** |
| profit factor | **0.988** |
| folds with win ≥50% | 4 / 5 |
| folds with positive expectancy | **1 / 5** |

So the win-rate half of the goal is already met. The profit half is not, and
the gap is not a rounding error — it is a structural identity (see §3).

### 2. No entry rule has edge — 30 rule/timeframe combinations, all negative out-of-sample

Mean net return per signal, 70/30 chronological split, cost subtracted.
"Baseline" is the unconditional return over the same bars, which is the control
that separates *skill* from *market drift*.

| timeframe | best rule (test) | net mean | baseline | relative edge |
|---|---|---|---|---|
| 5m | meanrev_below_bb | −0.383% | −0.511% | +0.13 pp |
| 15m | rsi_dip_in_uptrend | −0.066% | −0.738% | +0.67 pp |
| 1h | emacross | −0.688% | −2.087% | +1.40 pp |

Every rule beats its baseline (they avoid the worst of a falling market) and
every rule still loses money after cost. The 1h mean-reversion lead (RSI<50 + trend + lower Bollinger, hold 8 bars) was
tested further: its apparent +2.9% mean came from **one +95.8% trade**.
Excluding the three best trades it is **−0.503%**, median −0.510%, win 39.4%,
and only 3 of 8 folds are positive. That is an artefact, not an edge.

### 3. Cost is not the problem — zero cost still loses

Same config, fee and slippage swept to zero:

| round-trip cost | trades | win | expectancy | profit factor |
|---|---|---|---|---|
| 0.60% (real) | 70 | 68.6% | −329 | 0.988 |
| 0.50% | 81 | 67.9% | −1,373 | 0.954 |
| 0.40% | 101 | 61.4% | −10,676 | 0.704 |
| **0.00%** | 318 | 63.5% | **−1,647** | **0.915** |

With zero fees and zero slippage the strategy still loses. Removing cost
changes *which* trades are taken (the reward/risk gate admits more), not the
sign of the result.

## Why: the market fell, and the engine is long-only

Buy-and-hold over the same window:

- universe mean **−10.52%**, median **−22.56%**
- only **6 of 28** pairs finished higher
- worst: onlidr −97%, neonidr −93%, uaiidr −91%

Per third of the window:

| period | market | prod win | prod expectancy | profit factor |
|---|---|---|---|---|
| third 0 | +1.9% | 69.6% | −162 | 0.99 |
| third 1 | −7.9% | 72.7% | **+10,048** | 1.87 |
| third 2 | −7.0% | 65.8% | −271 | 0.99 |

The one profitable period is the one that fell hardest, which is the opposite
of what a long-only trend follower should show. That is noise, not skill.

## The identity that makes geometry alone insufficient

For a bracket exit, gross expectancy is `w·TP − (1−w)·SL`. On a driftless walk
`w = SL/(SL+TP)`, so that expression is **exactly zero** — before cost. Net of a
round-trip cost `c`, the win/loss ratio becomes

```
netRatio = SL·(TP − c) / (TP·(SL + c))     which is < 1 for every c > 0
```

Measured on the live config: avgWin 41,262 vs avgLoss 91,073 → ratio 0.453,
against a break-even requirement of 0.458. A **1.1% shortfall**. That is the
entire distance between the engine and break-even, and it can only be closed
from the entry side.

A corollary worth recording: `avgLoss ≈ 100,000 IDR = exactly 1% of equity =
riskPerTradePct`. Position sizing is working correctly and is not the bug.

## Configurations tried and rejected

- **Scaled brackets** (TP/SL ×2,3,4,6,8): profit factor falls monotonically
  0.988 → 0.509. Wider brackets lose more, because holding longer exposes the
  down-drift.
- **Asymmetric brackets** (32 combinations): 12 show PF > 1, best being
  SL=9/TP=4.5/trailing at PF 1.187, win 82.6%, n=46. Rejected on validation:
  **3/10 folds positive**, bootstrap P(total > 0) = **66%**, and the win rate is
  geometry plus a trailing-stop artefact (avgWin 16,192 vs avgLoss 64,817).
  It also fails in the one rising period.
- **ATR-vs-cost filter**: 5m ATR is 0.2–0.4% while round trip cost is 0.6%, so
  no 5m pair clears even 1× cost. The filter is structurally unusable at 5m;
  it is the correct tool at 1h+.

## What would actually be needed

1. **A shorter cost horizon or a maker-side entry.** Only taker fees exist in
   `market_pairs` (0.2%/side for every IDR pair). Posting limit orders would cut
   the round trip materially, but the paper engine always crosses the spread and
   has no maker model.
2. **A directional edge from data not in price/volume.** Cross-exchange
   lead-lag, funding, and Fear&Greed were all tested in earlier sessions and were
   negative. Orderbook imbalance is the remaining untested source.
3. **Longer horizon.** At 1h the cost is a smaller fraction of the move. The 1h
   screen is the least-bad result in §2 (+1.40 pp over baseline), but it still
   loses in absolute terms and n=681 over 60 days is too small to conclude.

## Recommendation

Do not ship a config change on this evidence. The honest position is that the
engine is **mechanically correct and economically break-even-to-slightly-negative
on a 60-day falling sample**, with no demonstrated edge. Shipping SL=9/TP=4.5
because it prints 82.6% wins would be shipping an overfit — its own fold test
fails 7 of 10 times.

The next step with real information value is extending the sample beyond 60 days
and testing 1h entries with the ATR-vs-cost filter, not further tuning of the 5m
bracket against the same 48 trading days.
