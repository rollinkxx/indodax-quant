# Candle Ingestion Recovery — Design

**Date:** 2026-11-15  
**Status:** Implementation proposal for this recovery branch

## Intent
Restore reliable paper-entry evaluation by recovering missing one-minute observations from INDODAX's public OHLC history and preventing synthetic lower-timeframe aggregates from erasing valid higher-timeframe history. The objective is eligible, explainable signals—not a guaranteed trade or a forced BUY.

## Evidence and root cause
The current ingestion planner backfills only the interval before the oldest trade returned by `/api/trades/{pair}`. It does not inspect missing one-minute buckets between the oldest returned trade and the current completed minute; pairs with no recent trade can advance `covered_until` without retrieving OHLC history. Those holes propagate into synthetic 5m bars, breaking the 60-bar contiguous data-quality gate. In MTF, a synthetic aggregate is currently allowed to overwrite a stored official 15m/1h candle at the same timestamp, turning an otherwise known trend into `unknown` and blocking BUY in filter mode.

## Goals
- Detect the earliest uncovered minute in the recent trade window and request one official 1m OHLC backfill range through the latest completed minute.
- Merge official history with observed trades, preferring direct trade-derived candles for the same minute.
- Advance `covered_until` only when every minute in the requested range is represented by either a trade candle or a valid official OHLC candle.
- Preserve official observed 15m/1h candles when a synthetic 5m aggregate collides at the same timestamp.
- Reject a zero-volume final 5m candle as a signal candle while still allowing historical zero-volume candles for indicator warm-up.
- Keep MTF filter and all position-sizing, spread, slippage, and risk limits unchanged.

## Non-goals
- No live INDODAX trading, API keys, order placement, withdrawals, or change from paper-only execution.
- No weakening of 60 consecutive 5m bars or MTF confirmation to manufacture entries.
- No automatic change to DB strategy config, paper account, positions, balance, or production Worker deployment.
- Backtest parity and non-entry security hardening remain separate work.

## Approach
Use one range-based 1m OHLC history request per pair only when a missing minute is detected; this avoids one request per missing minute. Build a minute-indexed union of official-history and trade-derived candles (trades win collisions), measure completeness across the exact requested range, and leave the persisted coverage frontier unchanged on a failed/incomplete backfill. In MTF merge, observed stored history wins over a synthetic aggregate, while an observed aggregate continues to supersede stored history. Add regression tests for internal gaps, zero-trade windows, incomplete API history, direct-trade precedence, MTF precedence, and zero-volume signal-candle rejection.

## Acceptance
- A trailing internal 1m gap generates a backfill request through the last completed minute.
- Missing/failed history cannot move the coverage frontier forward.
- Complete official OHLC data, including zero-volume intervals, can restore a contiguous series without fabricating price candles.
- Synthetic aggregates never overwrite observed stored HTF history.
- A zero-volume last candle cannot produce BUY or SELL.
- Existing safety gates and paper-only boundaries remain intact.
- GitHub CI typecheck, all tests, and build pass before integration.
