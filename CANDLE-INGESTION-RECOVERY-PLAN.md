# Candle Ingestion Recovery Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with tests first. Steps use checkbox syntax.

**Goal:** Restore reliable 1m/5m coverage and preserve valid MTF history so the engine can evaluate legitimate paper BUY entries.

**Architecture:** Detect minute holes in the live trade window, fill only the affected trailing range from INDODAX's official 1m OHLC endpoint, and advance coverage only when the union of actual trade bars and validated history bars is complete. Preserve observed 15m/1h candles when the competing 5m aggregate is synthetic.

**Tech Stack:** TypeScript, Cloudflare Workers, INDODAX public REST/TradingView history API, Vitest.

**Spec:** `CANDLE-INGESTION-RECOVERY-DESIGN.md`

## Global Constraints
- Keep `/tapi`, live orders, withdrawals, and private INDODAX APIs unsupported.
- Keep paper execution only.
- Keep `minCandles=60`, MTF `filter`, 15m/1h confirmations, and all risk/fee/slippage/entry limits unchanged.
- Only completed OHLC candles may be persisted and evaluated.
- Do not advance `covered_until` when any minute in the requested coverage range is missing.

## Review Focus
- A quiet pair with zero returned trades must backfill its uncovered minute window instead of marking it complete.
- An internal missing minute after the oldest returned trade must be detected and backfilled.
- An empty, partial, invalid, or failed history response must not advance coverage.
- A trade-derived candle must win over an OHLC history row at the same timestamp.
- A history row with volume zero may warm indicators but cannot be the final signal candle.
- Official higher-timeframe history must survive collision with a synthetic 5m aggregate.

---

### Task 1: Recover minute-level coverage

**Files:**
- Modify: `worker/src/ingest.ts`
- Modify: `worker/src/pipeline.ts`
- Create: `tests/ingest.test.ts`
- Modify: `tests/pipeline.test.ts`

**Interfaces:**
- `CoveragePlan` exposes `historyRange: { from: number; to: number } | null` for a single bounded, minute-aligned 1m history request.
- `PairBuild` exposes whether the requested range is complete and how many backfilled minutes were returned.

- [ ] Write failing tests for a quiet pair, an internal trailing gap, a complete history fill, a partial/empty history response, and direct-trade precedence.
- [ ] Run the ingestion tests and confirm the expected failures.
- [ ] Implement gap detection, one range backfill, timestamp-indexed merge (trades win), and exact minute coverage validation.
- [ ] Wire the pipeline to request only the computed 1m history range and expose range/completeness in run diagnostics.
- [ ] Run ingestion and pipeline tests.

### Task 2: Preserve observed higher-timeframe history

**Files:**
- Modify: `shared/mtf.ts`
- Modify: `tests/mtf.test.ts`

**Interfaces:**
- Keep `buildHigherSeries(stored, aggregated, tfSec, lastComplete, limit)` unchanged.

- [ ] Add a failing test proving a synthetic aggregate cannot overwrite an observed stored HTF candle, while an observed aggregate still wins.
- [ ] Run the MTF test and confirm it fails on the synthetic-collision case.
- [ ] Implement precedence: observed aggregate > observed stored history > synthetic aggregate.
- [ ] Run MTF tests.

### Task 3: Enforce a traded signal candle

**Files:**
- Modify: `shared/strategy.ts`
- Modify: `tests/strategy.test.ts`

**Interfaces:**
- Keep `checkDataQuality(QualityInput)` unchanged.

- [ ] Add a failing test for a latest official-history candle with zero volume.
- [ ] Run the strategy test and confirm it fails.
- [ ] Reject a final candle with `v <= 0`, while retaining zero-volume historical bars in the warm-up suffix.
- [ ] Run strategy tests.

### Task 4: Full verification and review

**Files:**
- All files above.

- [ ] Run `npm run typecheck`, `npm test`, and `npm run build` through GitHub Actions on the pull request.
- [ ] Review the final diff for accidental config, account, secret, or live-trading changes.
- [ ] Keep the branch isolated until the user selects integration; do not deploy from this recovery branch.
