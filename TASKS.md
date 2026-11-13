# TASKS — INDODAX QUANT

Legend: [x] done & verified · [~] done, unverified in production · [ ] open · [!] blocked (needs human)

_Last updated: 2026-11-13 15:40 WIB (session 5, read-only verification)_

## Database (Supabase `sinyalku`)
- [x] Schema, indexes, constraints, RLS (`20261113000001_init.sql`)
- [x] RPCs: begin_run/finish_run, ingest_market, save_analysis, paper_open/close_position, paper_set_status, paper_reset_account, claim/complete_notifications, retention (`..._functions.sql`)
- [x] Lock release fix (`..._fix_lock_release.sql`)
- [x] Supabase Auth user `gsdrxx@gmail.com` exists, admin (verified session 4)
- [ ] Optional: disable public sign-ups in Supabase Auth

## Backend (Cloudflare Worker)
- [x] INDODAX public client + validation + private endpoint block
- [x] Candles from trades, 5m aggregation, gap detection/backfill
- [x] Indicators + strategy + data-quality gate
- [x] Paper engine + risk management + kill switch (long-only; SELL = exit signal)
- [x] REST API with Supabase JWT auth and admin role
- [x] Telegram notifications (signals, orders, SL/TP, daily P/L, errors)
- [x] Cron pipeline end-to-end in production (last 60 runs: 60/60 SUCCESS, avg 5.6 s, 2026-11-13 15:32 WIB)
- [x] INDODAX relay via Supabase Edge Function `indodax-proxy` (Cloudflare IPs get 403 from INDODAX)
- [ ] Watch relay 502 "Maximum number of redirects" (incident 13:47 WIB, ids 103-104 PARTIAL, self-recovered); add retry/backoff if it repeats

## Frontend
- [x] Login
- [x] Overview, Market Monitor, Trading Chart, Trading Signals, Paper Trading, Trading History, Strategy Configuration, System Monitoring, Settings
- [ ] Optional: code-split lightweight-charts to reduce bundle size

## Quality
- [x] Unit/integration tests (75 pass, 10 files per session 4) — indicators, candles, strategy, paper, INDODAX client, API auth, notifications, db encoding, chart range
- [x] Live INDODAX verification script
- [ ] Pipeline end-to-end test with fake Supabase RPCs (nice to have)

## Deployment
- [x] GitHub Actions CI & Deploy workflow
- [x] GitHub secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_ACCESS_TOKEN
- [x] Deploy run 43372250003 green; `/api/health` smoke test OK; cron runs every minute
- [x] Production URL: https://indodax-quant.sinyalku.workers.dev (health 200, `liveTrading:false`, re-verified session 5)
- [x] First trading signals confirmed in production (2 SELL at 2026-11-13 15:20 WIB: ethidr, solidr; strategy `ema_rsi_volume`, strength 90)
- [x] Telegram delivery confirmed: signal, worker_status and system_error notifications all `SENT`
- [ ] Telegram test from Settings page (owner)
- [ ] Optional: Workers Paid plan (Free = 10 ms CPU per invocation; no failures seen so far)
- [x] Paper trading Start pressed by admin `gsdrxx@gmail.com` at 2026-11-13 13:00 WIB (status RUNNING, equity Rp10.000.000)
- [ ] Verify first BUY signal → paper order/position (sizing, SL/TP, fees, Telegram order notice)
