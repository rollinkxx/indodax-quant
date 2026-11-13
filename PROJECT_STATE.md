# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-13 16:55 WIB by n8n Instance Agent (session 7: MTF + dynamic universe shipped)_

## Infrastructure (existing — do NOT recreate)

| Item | Value |
|---|---|
| GitHub repo | `rollinkxx/indodax-quant` (public), branch `main` |
| Supabase project | `sinyalku`, ref `znikuooxiqfcicyuhqsx`, region ap-southeast-2, org `ieksloorndnvydlfunml` |
| Supabase migrations applied | `init`, `functions`, `fix_lock_release`, `mtf_universe` (0004, applied 2026-11-13 ~16:45 WIB) (match `supabase/migrations/`) |
| Cloudflare Worker | `indodax-quant` — **DEPLOYED** via GitHub Actions — **URL: `https://indodax-quant.sinyalku.workers.dev`** (account subdomain is `sinyalku`, not `rollinkxx`) |
| INDODAX relay | Supabase Edge Function `indodax-proxy` (read-only, public endpoints only), deployed by CI |
| Cron | `* * * * *` active, verified in `execution_logs` |

## DB state (verified 2026-11-13 15:32 WIB, read-only)

- `paper_accounts`: 1 row, status **RUNNING** (started 13:00 WIB by `gsdrxx@gmail.com`), cash = equity = Rp10.000.000, kill_switch=false, no positions, no orders.
- `trading_signals`: 2 rows (SELL ethidr @ 35.249.000, SELL solidr @ 1.454.883; 5m candle 08:15Z; `ema_rsi_volume`; strength 90; created 15:20 WIB).
- `execution_logs`: last 60 = 60/60 SUCCESS, avg 5.6 s, max 11.3 s wall time. Ids 103-104 (13:47 WIB) PARTIAL: relay 502 redirect loop, self-recovered.
- `notification_logs`: signal, worker_status, system_error all `SENT`.
- `market_pairs`: btcidr, ethidr, xrpidr, solidr, dogeidr (tracked/pinned). Full catalog (438) syncs hourly from `/api/pairs`.
- Dynamic universe (16:50 WIB): fartcoinidr #1, uaiidr #2, pepeidr #3 (`in_universe`); grows by max 3 new pairs per update (every 15 min) up to 12 + pinned.
- Higher-timeframe candles (16:50 WIB): 15m = 260, 1h = 254 rows; `htf_backfilled_at` set for 2 pairs so far.
- `app_users` / `auth.users`: `gsdrxx@gmail.com` = admin, confirmed.
- `strategy_configs`: 1 active (EMA Crossover + RSI + Volume, 5m).

## Module status

| Module | Status | Notes |
|---|---|---|
| DB schema, RLS, RPCs | DONE, applied | atomic paper RPCs, idempotency keys, run lock |
| INDODAX public client | DONE, tested, live-verified | private endpoints hard-blocked |
| Candle builder (trades → 1m → 5m, gap fill, OHLC backfill) | DONE, tested, live-verified | BTC 14/14, DOGE 232/232 closes match official OHLC |
| Indicators (EMA 9/21/50, RSI14, MACD, ATR14, VolMA20, S/R) | DONE, tested | |
| Strategy + data-quality gate | DONE, tested, producing signals in prod | |
| Multi-timeframe (15m/1h aggregated from 5m, EMA 9/21 trend filter) | DONE, tested, deployed 16:48 WIB | `mtfMode` off/filter/score, default `filter`; min 30 HTF candles |
| Dynamic pair universe (24h IDR volume + spread) | DONE, tested, deployed 16:48 WIB, populating | default dynamic, size 12, minVol Rp1e9, maxSpread 0.6%, buffer 4, max 3 new/update, stablecoins excluded; open-position pairs always analysed |
| Paper engine (sizing, SL/TP, fee, slippage, DD kill switch, daily loss) | DONE, tested | long-only: SELL signal exits an open long, ignored when flat |
| Cron pipeline (retry, timeout, idempotency, lock, logging) | DONE, running in prod | 60/60 recent SUCCESS |
| REST API + auth/roles | DONE, tested | |
| Telegram (direct Bot API, DB dedupe) | DONE, delivery confirmed | Settings test button works (owner confirmed 2026-11-13 15:37 WIB) |
| React dashboard (9 pages + login) | DONE | owner still to confirm all 9 pages show real data |
| Automated tests | DONE | 106 tests / 13 files (session 7) |
| CI/CD (GitHub Actions) | DONE | `.github/workflows/ci-deploy.yml` |
| Cloudflare deploy | DONE | latest bundle live |
| Production verification | DONE (data pipeline, signals, Telegram) | pending: first BUY → paper order |

## Verification history

- Session 2: typecheck, 66 tests, build, live INDODAX script pass.
- Session 3: 69 tests; CI run 43372250003 green; relay 200; execution id 24 SUCCESS.
- Session 4: health 200; ids 24-44 SUCCESS; fixes for PostgREST `+` encoding and equity chart axis; 75 tests; CI 43376062984 green.
- Session 5 (read-only, no code/DB change): health 200 `liveTrading:false`; cron 60/60 SUCCESS; first 2 signals + Telegram SENT; paper RUNNING (admin Start); relay 502 incident at 13:47 WIB self-recovered.
- Session 6 (docs only, no code/DB change): synced PROJECT_STATE (Telegram Settings test confirmed) and README (test count 75 / 10 files) with TASKS/HANDOFF.
- Session 7: migration 0004 `mtf_universe` applied (old worker stayed SUCCESS); PR #1 merged (`6e9c20e`); CI & Deploy green 16:48 WIB; runs 16:47-16:49 WIB SUCCESS (4.6-8.8 s wall); typecheck, 106 tests, build OK.

## Safety invariants

- No live trading: `IndodaxClient` allow-list = public endpoints only; `paper_orders.is_simulated` CHECK = true; `/api/health` reports `liveTrading:false`.
- No n8n runtime dependency: Worker only calls INDODAX (via relay), Supabase and Telegram.
- Service role key never reaches the frontend.
