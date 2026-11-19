# The 4h pullback edge: found, validated, and rejected on liquidity grounds

Date: 2026-11-19
Data: 412 pairs, 921,979 closed 4h candles, 2025-10-15 → 2026-11-19 (**400 days**)
Cost model: 0.2%/side taker + 10 bps slippage = 0.60% round trip

## Why 4h

The INDODAX history endpoint caps each response at roughly 2,593 bars, so the history
depth is inversely proportional to the bar size:

| timeframe | bars returned | history span |
|---|---|---|
| 1m | 2,593 | ~1.8 days |
| 5m | 2,593 | ~9 days per request, ~60 days reachable |
| 1h | 649 | **27 days** |
| **4h** | **2,401** | **400 days** |

Only 4h gives a sample long enough to test a rule. The 5m sample is 60 days of a single
market regime; the 1h sample yields 22 signals in total, which cannot be validated.

Note the 400-day window is itself a deep bear market: buy-and-hold mean **−48.3%**,
median −69.7%, only **34 of 412** pairs finished higher. Any long-only rule that shows a
profit here is doing something real, because the drift is working against it.

## The rule

```
BUY when:  EMA9 > EMA21                     (uptrend intact)
           RSI(14) < 40                     (short-term oversold)
           close < lower Bollinger(20, 2)   (price stretched below the band)
```

Exit: ATR bracket, stop 6×ATR, target 3×ATR, maximum hold 6 bars (24 hours).

This is a mean-reversion entry *inside* a trend. It is the only rule of eleven tested that
is profitable on this data; the trend-following rules (EMA cross, breakout, momentum,
volume spike) are all between −0.7% and −2.3% per trade.

## It validates properly

| split | n | mean | median | win | excl. top 5 | pairs positive | bootstrap P(mean>0) |
|---|---|---|---|---|---|---|---|
| train 70% | 226 | +3.023% | +1.822% | 58.8% | +2.456% | 18/23 | 100.0% |
| **test 30%** | **136** | **+1.387%** | **+1.522%** | **60.3%** | **+0.766%** | **7/7** | **97.7%** |
| full | 362 | +2.409% | +1.706% | 59.4% | +2.049% | 33/45 | 100.0% |

Positive on both sides of the split, positive median (so not an outlier artefact),
positive after deleting the five best trades, and every one of the seven pairs that
traded in the holdout was profitable. Fold test: 8 of 9 folds positive.

The rule is also genuinely specific to this timeframe. Run on 5m with the hold scaled to
24 hours it loses at every horizon tested (−0.116%, −0.084%, −0.062%). It is not a
generic "buy dips" effect.

Implementation was verified against the research harness before being reverted: feeding
the same data through `computeIndicators` + `diagnosePullbackEntry` reproduced the
research numbers exactly (median 1.706% both, mean 2.450% vs 2.409%, win 59.8% vs 59.4%).

## Why it was rejected anyway

**The edge lives entirely in pairs the engine will never trade.**

| 24h IDR volume | n | mean | win |
|---|---|---|---|
| ≥ 10 B | 1 | −0.79% | 0.0% |
| 1 B – 10 B | 10 | −2.48% | 30.0% |
| 100 M – 1 B | 41 | +1.37% | 48.8% |
| 10 M – 100 M | 81 | +0.61% | 50.6% |
| **< 10 M** | **229** | **+3.46%** | **65.9%** |

The sign flips with liquidity. The engine's dynamic universe requires
`universeMinVolumeIdr` = 1,000,000,000 and then picks the top `universeSize` = 12 by
volume — which is precisely the 1 B–10 B bucket where the rule returns **−2.48%** with a
30% win rate.

The signal is also far too rare to trade. Over 400 days across 412 pairs there are 362
signals in total, and the concentration is extreme:

- median signals per pair over 400 days: **0**
- pairs with ≥5 signals: **9 of 410**
- the top 12 pairs by volume produce **7 signals in 400 days ≈ 6.4 trades/year**

So the profitable sample is 229 trades spread across illiquid pairs, most of which
produce a single signal. There is no way to deploy this at the engine's liquidity
standard, and forcing the universe down to sub-10 M IDR pairs would trade instruments
where the 0.6% round-trip assumption and the 10 bps slippage assumption are both far too
optimistic — the spread on those pairs alone often exceeds the entire edge.

## What this changes about the earlier conclusion

The previous document (`win-rate-target-2026-11-19.md`) concluded that no entry rule has
edge. That is now known to be **too strong a statement**. A rule with edge does exist on
4h data. The accurate conclusion is narrower and more useful:

> An entry edge exists, but only in illiquid pairs, at a frequency too low and at a
> liquidity too poor to trade with the current cost and universe assumptions.

That reframes the next step. The problem is not "find an edge" — it is "make the edge
survive realistic liquidity". Three things follow:

1. **Re-test the rule with per-pair realistic costs.** The 0.6% flat assumption is wrong
   for sub-10 M IDR pairs. Model each pair's actual spread and depth. If the edge
   survives that, the universe constraint is the thing to change, not the rule.
2. **Check whether a relaxed version of the rule fires on liquid pairs.** RSI<40 + below
   band is very restrictive. RSI<45/50 and a shallower band would fire more often; on
   liquid pairs specifically, that may be the tradeable subset.
3. **Do not lower `universeMinVolumeIdr` to chase this.** It would convert a documented
   paper-trading result into an untradeable one.

## Status

No code change shipped. The implementation (an `entryMode: 'pullback'` parameter, a
Bollinger band on `IndicatorRow`, and a `diagnosePullbackEntry` rule) was written, verified
to reproduce the research numbers, and then reverted. It is not in `main`. Re-landing it
requires first answering question 1 above.

Scripts used: `/tmp/probe.ts` (history depth), `/tmp/cache4h.ts` (400-day cache),
`/tmp/screen4h.ts` (11-rule screen), `/tmp/brk4h_val.ts` (bracket validation),
`/tmp/freq.ts` (signal frequency), `/tmp/univ.ts` (edge by volume bucket),
`/tmp/verify_impl.ts` (implementation vs research parity).
