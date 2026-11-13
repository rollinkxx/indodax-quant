# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-13 12:55 WIB by n8n Instance Agent (session 4)_

## Infrastructure (existing — do NOT recreate)

| Item | Value |
|---|---|
| GitHub repo | `rollinkxx/indodax-quant` (public), branch `main` |
| Supabase project | `sinyalku`, ref `znikuooxiqfcicyuhqsx`, region ap-southeast-2, org `ieksloorndnvydlfunml` |
| Supabase migrations applied | `init`, `functions`, `fix_lock_release` (match `supabase/migrations/`) |
| Cloudflare Worker | `indodax-quant` — **DEPLOYED** via GitHub Actions — **URL: `https://indodax-quant.sinyalku.workers.dev`** (account subdomain is `sinyalku`, not `rollinkxx`) |
| INDODAX relay | Supabase Edge Function `indodax-proxy` (read-only, public endpoints only), deployed by CI |
| Cron | `* * * * *` active, verified in `execution_logs` |

## DB state (verified 2026-11-13)

- `paper_accounts`: 1 row `default`, status **STOPPED**, cash Rp10.000.000, kill_switch=false.
- `market_pairs`: btcidr, ethidr, xrpidr, solidr, dogeidr (tracked). Full catalog syncs hourly from `/api/pairs`.
- `app_users`: `gsdrxx@gmail.com` = admin.
- `auth.users`: 1 user `gsdrxx@gmail.com` (confirmed) → login unblocked.
- `strategy_configs`: 1 active (EMA Crossover + RSI + Volume, 5m).
- Market data filling since 2026-11-13 05:30Z: 438 pairs, 2500 trades, 8314 candles (24h backfill), quality ok for 5 pairs.

## Verification results (session 4, 2026-11-13 12:55 WIB)

- Production URL `https://indodax-quant.sinyalku.workers.dev`: `/` 200, `/api/health` 200 (`liveTrading:false`).
- Cron ids 24-44 all SUCCESS; signals 0 so far; paper STOPPED. Details in HANDOFF.md.

## Module status

| Module | Status | Notes |
|---|---|---|
| DB schema, RLS, RPCs | DONE, applied | atomic paper RPCs, idempotency keys, run lock |
| INDODAX public client | DONE, tested, live-verified | private endpoints hard-blocked |
| Candle builder (trades → 1m → 5m, gap fill, OHLC backfill) | DONE, tested, live-verified | BTC 14/14, DOGE 232/232 closes match official OHLC |
| Indicators (EMA 9/21/50, RSI14, MACD, ATR14, VolMA20, S/R) | DONE, tested | |
| Strategy + data-quality gate | DONE, tested | |
| Paper engine (sizing, SL/TP, fee, slippage, DD kill switch, daily loss) | DONE, tested | |
| Cron pipeline (retry, timeout, idempotency, lock, logging) | DONE, running in prod | SUCCESS from 05:30Z after relay |
| REST API + auth/roles | DONE, tested | |
| Telegram (direct Bot API, DB dedupe) | DONE, tested | needs bot token + chat id secrets |
| React dashboard (9 pages + login) | DONE (session 2) | pages were missing from repo after session 1 |
| Automated tests | DONE (session 2) | 66 tests, `tests/` was missing after session 1 |
| CI/CD (GitHub Actions) | DONE (session 2) | `.github/workflows/ci-deploy.yml` |
| Cloudflare deploy | DONE | CI run 43372250003 |
| Production verification | DONE (data pipeline) | login + Telegram test from UI still to confirm |

## Verification results (session 2)

- `npm run typecheck`: pass (app + worker).
- `npm test`: 7 files, 66 tests pass.
- `npm run build`: pass (dist ~700 kB JS).
- `npm run verify:indodax btcidr|dogeidr`: pass (live, read-only).
- No live trading: `IndodaxClient` allow-list = public endpoints only; `paper_orders.is_simulated` CHECK = true.
- No n8n runtime dependency: Worker only calls INDODAX, Supabase, Telegram.

## Verification results (session 3)

- `npm test`: 8 files, 69 tests pass. `npm run build`: pass. CI typecheck: pass.
- CI run 43372250003: all steps green (edge function deploy, worker deploy, secrets sync, smoke test).
- Relay: `/functions/v1/indodax-proxy?path=/api/ticker/btcidr` = 200 with valid ticker.
- `execution_logs` id 24 SUCCESS; earlier PARTIAL rows were 403 (direct) then 404 (relay not deployed yet).
- Paper account still STOPPED.
