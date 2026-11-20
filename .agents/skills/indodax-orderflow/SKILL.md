---
name: indodax-orderflow
description: Use the taker-side data the pipeline already stores (market_trades.side, /api/market/trades) to test order-flow hypotheses on INDODAX. Covers what the data really means, how to aggregate it causally, the leakage traps, and how to prove an edge before it reaches the engine.
---

# INDODAX order flow

The engine has never used taker direction. Every signal is built from candle
aggregates only: `shared/strategy.ts` consumes `close`, `volume`, EMA/RSI/MACD/ATR and
support/resistance. `side` is read in exactly one place — `tradesToCandles` in
`shared/candles.ts`, to build OHLCV — and is then discarded.

That is an unexplored axis, not a missing feature. Treat it as a hypothesis to test,
not an edge that already exists.

## What the data is

`market_trades` is populated by `ingest_market_data` (see
`supabase/migrations/*_functions.sql`) from the public `/api/trades/<pair>` endpoint.

| Column | Meaning |
| --- | --- |
| `tid` | INDODAX trade id, **text** — it exceeds 2^53, never cast to number |
| `traded_at` | exchange timestamp of the fill |
| `price`, `amount` | fill price and base-asset amount |
| `side` | `buy` or `sell` — **the taker's side** |

`side` comes from INDODAX's `type` field (`worker/src/indodax.ts`), which reports the
side of the **aggressor**. A `buy` print means a taker lifted the offer. It does *not*
mean the market is bullish, and it is not a maker/resting-order classification.

`amount` is in the base asset. Quote notional is `price * amount` — compute that
yourself, it is not stored.

## The causal trap that invalidates most order-flow results

Aggregating trades into a bar is easy to do with lookahead by accident. Three rules:

1. **Bucket by `traded_at`, close the bucket at its boundary.** A bar labelled `t` may
   only contain trades with `traded_at < t + timeframe`. Never `<= now`, never a
   `where traded_at between t-Δ and now`.
2. **A partial bucket is not a bar.** If the current minute is still forming, its
   buy/sell split will look extreme (few trades, one direction) and will mean-revert
   the instant the rest arrives. Drop the forming bucket, exactly as
   `candles.is_closed` does for price.
3. **Never join flow at `t` to a decision made at `t`.** The backtest enters at the
   **next** candle's open. Flow measured over bar `t` is knowable at `t+Δ`; a signal
   that needs it must enter at `t+Δ`, not at `t`'s close.

Pin the same guarantee the price path already has: any flow feature at index `i` must
be a pure function of trades with `traded_at < bar_i_close`. If a prefix run and a full
run disagree, you have leakage — `tests/backtest-causality.test.ts` is the pattern to
copy.

## Aggregations worth testing

Compute per bar, then treat as a candidate feature:

- **Taker buy ratio** = `sum(amount where side='buy') / sum(amount)`. The base measure.
- **Volume delta** = `buy_notional - sell_notional`, and its normalised form
  `delta / total_notional` (bounded −1..1, comparable across pairs of different size).
- **Cumulative volume delta (CVD)** over a window, and its slope. Levels are
  arbitrary; slope and divergence from price are the usable forms.
- **Trade-size asymmetry** — mean buy size vs mean sell size. A large average buy with
  few prints is a different regime from many small buys.
- **Print count imbalance** — `n_buy / n_total`, which weights *frequency* rather than
  size and often disagrees with the notional ratio.

Always normalise before comparing across pairs. INDODAX IDR pairs differ by orders of
magnitude in turnover, and raw delta is not comparable between them.

## What to be sceptical about

- **Sample size per bar.** A 5m bar on a thin pair can hold a handful of prints. A
  ratio computed from 4 trades is noise. Gate on `trade_count` and report how many bars
  you dropped.
- **`side` is taker-only.** It tells you who crossed the spread, not who is resting.
  You cannot reconstruct book depth or queue position from it — the repo ingests
  `/api/trades/` and `/api/summaries`, not order book depth.
- **Wash and self-trade prints.** Some INDODAX pairs carry repetitive small prints.
  Check for a dominant `tid` cluster or a single size appearing thousands of times
  before believing an imbalance.
- **The 0.2%/side wall.** This repository's settled research state is that 5m
  price/volume signals have not cleared 0.2%/side. Any flow feature must clear the same
  round-trip cost (entry fee + exit fee + slippage; see `roundTripCostPct` in
  `shared/paper.ts`). A flow signal that predicts direction but not by more than the
  cost is not a signal.
- **Multiple testing.** Testing 6 aggregations × 4 thresholds × N pairs will produce
  winners by chance. Use `walk-forward-validation` with purged folds, and report the
  number of configurations tried.

## How to prove it, in this repo

Read-only, in this order. None of these may write the active `strategy_configs` row or
place an order.

1. **Describe first.** Pull `market_trades` for a handful of liquid pairs and check the
   distribution of per-bar `trade_count`, the buy-ratio histogram, and whether the ratio
   has any persistence (autocorrelation at lag 1). If lag-1 autocorrelation is ~0, the
   feature carries no state and most strategies built on it will not work.
2. **In-sample relationship.** Regress forward return (next 1/3/5 bars) on the flow
   feature. Report the coefficient *and* its stability across sub-periods. A sign flip
   across sub-periods means no edge.
3. **Walk-forward.** Purged, embargoed folds — use the `walk-forward-validation` skill.
   Report out-of-sample only.
4. **Cost it.** Apply the real round-trip cost before declaring anything positive.
   `npm run fee:sensitivity` shows how fast an edge dies as fees rise.
5. **Backtest it.** `npm run backtest -- --overrides='{...}'` sweeps parameters in
   memory. Extending `shared/strategy.ts` with a flow feature means extending the
   indicator row and the parity tests too.

## If it survives

Then, and only then, wire it in — respecting the engine invariants in
`indodax-engine/SKILL.md`: keep the backtest/runtime exit precedence
(`SL/TP → trailing → TIME_STOP → SIGNAL`), keep fee parity across `simulate()`,
`shared/paper.ts` and the SQL functions, and fail closed when the flow window is
incomplete rather than defaulting to a neutral 0.5 ratio.

## Querying the data

The public API exposes it directly:

```
GET /api/market/trades?pair=<pair_id>&limit=<1..500>
```

Newest first, so reverse before bucketing. For bulk work query Supabase directly and
paginate on `(pair_id, traded_at)`; `tid` is text and sorts lexicographically, not
numerically, so do not use it for ordering.
