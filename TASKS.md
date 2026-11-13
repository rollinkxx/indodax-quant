# TASKS — INDODAX QUANT

Legend: [x] done & verified · [~] done, unverified in production · [ ] open · [!] blocked (needs human)

_Last updated: 2026-11-13 22:35 WIB (session 8, IN PROGRESS)_

> Tooling note: if GitHub/Supabase MCP says "Session approvals are not available for this tool", reconnect the MCP server
> (`mcp-servers` → `connect`) and retry. Details at the top of HANDOFF.md.

## SESSION 8 — forensic audit of the buy/sell/hold engine (22:20-22:45 WIB)
Verdict: signal logic (EMA9/21 cross + RSI band + volume + EMA50 trend + 15m/1h MTF filter, long-only, SELL = exit) is sound and
already hardened (see docs/STRATEGY_HARDENING.md). The weak point is EXECUTION QUALITY at entry.

Evidence (prod, Supabase `sinyalku`): 21 signals (2 BUY / 19 SELL), 2 positions. `nearidr` +Rp37.551 (TAKE_PROFIT after 2 h).
`anoaidr` BUY 15:20Z filled Rp234.330 (ask 233.397 + 40 bps dynamic slippage) on a **1.2% spread** (bid 230.633, ask 233.397);
ATR stop = 231.050 was ABOVE the bid -> STOP_LOSS 61 s later, -Rp64.384 (-2.6% of the position). Not a market move: the quote stopped it out.
Cause: no entry-time check of spread / price drift / stop-vs-bid. Spread filter existed only for universe selection.
Live config also had `universeMinVolumeIdr` = 1e8 (code default 1e9), letting thin pairs (anoaidr 24h vol Rp362jt, slippage x4) in.

Findings and status:
- [~] F1 entry gate `entryGate()` (shared/paper.ts): skip BUY when spread > `maxEntrySpreadPct` (0.6), ask > signal close by `maxEntryDriftPct` (0.5),
      or bid <= stop / spread > 50% of stop distance (`stop_inside_spread`). Wired in worker/src/pipeline.ts before sizing. Tests in tests/entryGate.test.ts.
- [~] F2 sizing includes expected exit slippage (`exitSlippageBps` in positionSize).
- [~] F3 migration `20261113230000_entry_gate.sql`: merges new params into the active config and raises `universeMinVolumeIdr` to >= 5e8.
- [~] F4 Strategy page fields for the two new params.
- [ ] (PLAN, code push pending at time of this note) If shared/paper.ts has no `entryGate`, the code commit has NOT landed yet: re-implement F1-F4 as described above and run `npm run typecheck && npm test && npm run build` (expect 130 tests in 15 files).
- [ ] After deploy: verify `/api/health`, runs SUCCESS, and that `execution_logs.steps.paper_trading.info.actions` shows `skip <pair>: wide_spread|price_drift|stop_inside_spread` for wide quotes.
- [ ] Known limitations (not changed, watch): 5m EMA cross-down exits can whipsaw out of winners; MTF `filter` blocks BUY on any warming-up TF;
      pinned pairs (xautidr, paxgidr) still emit signals although excluded from the universe; SELL signals with no position are stored but not sent.

## Database (Supabase `sinyalku`)
- [x] Schema, indexes, constraints, RLS (`20261113000001_init.sql`)
- [x] RPCs: begin_run/finish_run, ingest_market, save_analysis, paper_open/close_position, paper_set_status, paper_reset_account, claim/complete_notifications, retention (`..._functions.sql`)
- [x] Lock release fix (`..._fix_lock_release.sql`)
- [x] MTF + dynamic universe migration (`20261113000004_mtf_universe.sql`, applied session 7)
- [x] Supabase Auth user `gsdrxx@gmail.com` exists, admin (verified session 4)
- [ ] Optional: disable public sign-ups in Supabase Auth

## Backend (Cloudflare Worker)
- [x] INDODAX public client + validation + private endpoint block
- [x] Candles from trades, 5m aggregation, gap detection/backfill
- [x] Indicators + strategy + data-quality gate
- [x] Multi-timeframe filter (15m/1h from 5m, EMA 9/21) — deployed session 7
- [x] Dynamic pair universe (volume/spread ranking, every 15 min) — deployed session 7, populating
- [ ] Watch CPU/duration with up to ~17 pairs on Workers Free (10 ms CPU); fall back to `universeMode: 'manual'` if runs fail
- [x] Paper engine + risk management + kill switch (long-only; SELL = exit signal)
- [x] REST API with Supabase JWT auth and admin role
- [x] Telegram notifications (signals, orders, SL/TP, daily P/L, errors)
- [x] Cron pipeline end-to-end in production (last 60 runs: 60/60 SUCCESS, avg 5.6 s, 2026-11-13 15:32 WIB; 119/120 in the 2 h before session 8)
- [x] INDODAX relay via Supabase Edge Function `indodax-proxy` (Cloudflare IPs get 403 from INDODAX)
- [x] Relay 502 "Maximum number of redirects" (13:47 WIB, ids 103-104 PARTIAL) self-recovered; owner confirms it has not recurred. Re-open with retry/backoff only if it repeats.

## Frontend
- [x] Login
- [x] Overview, Market Monitor, Trading Chart, Trading Signals, Paper Trading, Trading History, Strategy Configuration, System Monitoring, Settings
- [ ] Optional: code-split lightweight-charts to reduce bundle size

## Quality
- [x] Unit/integration tests (123 pass, 14 files before session 8)
- [x] Live INDODAX verification script
- [x] Pipeline end-to-end test with fake Supabase RPCs (`tests/pipeline.test.ts`, session 7)
- [x] Offline backtest `scripts/backtest.ts` (old rules vs live params)

## Deployment
- [x] GitHub Actions CI & Deploy workflow
- [x] GitHub secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_ACCESS_TOKEN
- [x] Deploy run 43372250003 green; `/api/health` smoke test OK; cron runs every minute
- [x] Production URL: https://indodax-quant.sinyalku.workers.dev (health 200, `liveTrading:false`, re-verified session 5)
- [x] First trading signals confirmed in production (2 SELL at 2026-11-13 15:20 WIB: ethidr, solidr; strategy `ema_rsi_volume`, strength 90)
- [x] Telegram delivery confirmed: signal, worker_status and system_error notifications all `SENT`
- [x] Telegram test from Settings page works (owner confirmed 2026-11-13 15:37 WIB)
- [ ] Optional: Workers Paid plan (Free = 10 ms CPU per invocation; no failures seen so far)
- [x] Paper trading Start pressed by admin `gsdrxx@gmail.com` at 2026-11-13 13:00 WIB (status RUNNING, equity Rp10.000.000)
- [x] First BUY signals -> paper orders/positions verified (session 8): nearidr TAKE_PROFIT +Rp37.551; anoaidr STOP_LOSS -Rp64.384 (see finding above)
