# TASKS — INDODAX QUANT

Legend: [x] done & verified · [~] done, unverified in production · [ ] open · [!] blocked (needs human)

## Database (Supabase `sinyalku`)
- [x] Schema, indexes, constraints, RLS (`20261113000001_init.sql`)
- [x] RPCs: begin_run/finish_run, ingest_market, save_analysis, paper_open/close_position, paper_set_status, paper_reset_account, claim/complete_notifications, retention (`..._functions.sql`)
- [x] Lock release fix (`..._fix_lock_release.sql`)
- [!] Create Supabase Auth user `gsdrxx@gmail.com` (Dashboard → Authentication → Users → Add user)
- [ ] Optional: disable public sign-ups in Supabase Auth

## Backend (Cloudflare Worker)
- [x] INDODAX public client + validation + private endpoint block
- [x] Candles from trades, 5m aggregation, gap detection/backfill
- [x] Indicators + strategy + data-quality gate
- [x] Paper engine + risk management + kill switch
- [x] REST API with Supabase JWT auth and admin role
- [x] Telegram notifications (signals, orders, SL/TP, daily P/L, errors)
- [~] Cron pipeline end-to-end in production

## Frontend
- [x] Login
- [x] Overview, Market Monitor, Trading Chart, Trading Signals, Paper Trading, Trading History, Strategy Configuration, System Monitoring, Settings
- [ ] Optional: code-split lightweight-charts to reduce bundle size

## Quality
- [x] Unit/integration tests (66) — indicators, candles, strategy, paper, INDODAX client, API auth, notifications
- [x] Live INDODAX verification script
- [ ] Pipeline end-to-end test with fake Supabase RPCs (nice to have)

## Deployment
- [x] GitHub Actions CI & Deploy workflow
- [!] Add GitHub secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- [ ] Run workflow → confirm `/api/health`, cron runs every minute in System Monitoring
- [ ] Verify Telegram test message from Settings
- [ ] Admin presses Start in Paper Trading (only after data warm-up)
