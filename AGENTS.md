# AGENTS.md

Instructions for any AI agent working in this repository.

## Project

`indodax-quant` — INDODAX crypto **paper-trading** platform. React dashboard + Cloudflare Worker API
(`worker/src`) + Supabase Postgres + Cron pipeline. **No live trading** (non-negotiable).

## Commands

- `npm ci` — reproducible install from the committed `package-lock.json`
- `npm test` — unit + integration tests (vitest)
- `npm run typecheck` — tsc for app + worker
- `npm run build` — vite production build
- `npm run backtest` — read-only strategy experiments on stored 5m candles
  (`npm run backtest -- --overrides='{"trailActivationAtr":2.5}'` sweeps exit params in memory; the
  active config is never modified)

## Conventions

- Commit as `openhands <openhands@all-hands.dev>` and add
  `Co-authored-by: openhands <openhands@all-hands.dev>`.
- Do not commit `.openhands/`, `.env`, or scratch files.
- Read-only means read-only: the backtest and `fee:sensitivity` scripts never place orders and never
  write to the active `strategy_configs` row.

## Environment notes

- Secrets saved in OpenHands Settings only reach conversations that **start after** the save; a running
  session's environment is frozen at start.
- CI workflow: `.github/workflows/ci-deploy.yml`. On a `pull_request` event the `deploy`/`migrate`/`relay`
  jobs are SKIPPED by design; only `test`, `browser-smoke`, and `detect-changes` run.
- `scripts/write-evaluation-summary.mjs` (CI) depends on the backtest keys `cross_lookback_2` /
  `cross_lookback_4` and `aggregateOutOfSampleIndependentPairAccounts` — do not rename them.
