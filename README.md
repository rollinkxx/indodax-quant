# INDODAX QUANT

Cryptocurrency monitoring and **automated paper trading** platform for INDODAX markets.

- **Frontend**: React + TypeScript + Tailwind CSS (light/dark, responsive) served by **Cloudflare Workers Static Assets**;
  installable as a PWA (hand-written `public/sw.js` caches static assets only, never `/api/*`)
- **Backend**: Cloudflare Worker REST API (`/api/*`)
- **Scheduler**: Cloudflare Cron Trigger `* * * * *` (UTC)
- **Database / Auth**: Supabase PostgreSQL + Supabase Auth, Row Level Security
- **Market data**: [INDODAX Official Public API](https://github.com/btcid/indodax-official-api-docs) only,
  fetched through the read-only Supabase Edge Function relay `indodax-proxy` (INDODAX returns HTTP 403 to Cloudflare Worker IPs). The Worker signs relay requests with its backend-only Supabase service secret; CI copies that exact value into the Edge Function's explicit `INDODAX_RELAY_HMAC_SECRET` variable, and the key is never sent in the request
- **Notifications**: Telegram Bot API called directly from the Worker

> **No live trading.** The code contains no INDODAX private/trade API client, no API keys, no order
> submission, no withdrawals. The INDODAX client hard-blocks any non-public endpoint
> (`worker/src/indodax.ts`, covered by tests). Every order is an internal simulation
> (`paper_orders.is_simulated` is constrained to `true`). A fresh installation starts with paper trading **STOPPED**;
> an administrator must press **Start**. The current production paper account is already **RUNNING** with its kill switch off.

The production system has no dependency on n8n.

## Architecture

```
Cloudflare Cron (every minute, UTC)
  └─ Worker.scheduled → runPipeline()
       1. begin_run RPC        idempotency (one run per minute) + DB lock (no concurrent runs)
       2. INDODAX /api/summaries, /api/trades/{pair}  via HMAC-authenticated relay `indodax-proxy` (GET-only, strict public allow-list)
                               (timeouts, retries, 429 back-off, validation)
       3. 1m candles from trades; gaps/bootstrap from official /tradingview/history_v2; 5m aggregation
       4. ingest_market RPC    tickers (latest + history), trades (dedup by tid), candles, sync state
       5. indicators (EMA 9/21/50, RSI 14, MACD, ATR 14, Volume MA 20, support/resistance)
       6. signals on COMPLETED 5m candles with data-quality gate (no stale/incomplete data)
       7. paper trading: SL/TP/trailing/time-stop/SELL exits → mark-to-market → risk checks → entry gate → BUY entries
       8. Telegram notifications (claimed in DB first → never sent twice)
       9. finish_run RPC       execution log + lock release

Browser ── Supabase Auth (publishable key) ──▶ JWT ──▶ Worker /api/* ── service role ──▶ Supabase
```

All money-moving logic runs inside Postgres functions (`paper_open_position`, `paper_close_position`)
with row locks and unique idempotency keys, so balances stay consistent even if a request is retried
or two runs overlap.

### Strategy (default)

Timeframe 5m, completed candles only.

- **Multi-timeframe (MTF)**: 15m and 1h candles are aggregated from 5m (complete buckets only). Trend per timeframe is bull when close > slow EMA and fast EMA (9) > slow EMA (21), bear for the opposite, otherwise neutral (unknown while warming up; needs >= 30 HTF candles). The code default is `mtfMode: 'filter'`, which blocks BUY when MTF is warming up, a timeframe is against trend, or the 1h anchor is not bullish (`mtf_warming_up`, `mtf_against_trend`, `mtf_anchor_not_bullish`). The active production database configuration is `mtfMode: 'score'`: MTF adds/subtracts strength rather than blocking the BUY solely on MTF state. SELL is never blocked by MTF; `off` disables it.
- **Dynamic universe**: the active production selector is configured for up to 25 monitored pairs **including** manually tracked pairs. It ranks non-pinned pairs every 15 minutes by 24h IDR volume (≥ Rp1.000.000.000) and spread (≤ 0.6%), with rank buffer 4 and at most 3 new pairs per update. Stablecoins and gold-backed tokens (`xautidr`, `paxgidr`) are excluded. Pairs with an open paper position are always analysed. Set `universeMode: 'manual'` to analyse pinned pairs only. A configured maximum is a cap, not a promise that 25 pairs will qualify.

- **BUY**: EMA9 crosses above EMA21 on the signal candle or the one before (`crossLookback` 2), RSI14 in [50, 65],
  volume ≥ 1.2 × Volume MA20, close > EMA50, and close not more than 1.5% above EMA21 (`maxEntryExtensionPct`, anti-chasing).
- **SELL**: any fresh EMA9 cross below EMA21 (`sellRequireConfirm: false`; set it to `true` to also require RSI14 ≤ 50 and volume).
  The engine is long-only: SELL closes an open position on that pair and is ignored when flat. SELL signals are always stored,
  but sent to Telegram only when a position in that pair is open.
- Strength score adds MACD histogram, volume spikes and support/resistance breaks.
- **Entry gate** (checked against the live quote just before a BUY is filled): skip when the spread is above
  `maxEntrySpreadPct` (0.6%), the ask is more than `maxEntryDriftPct` (0.5%) above the signal close, or the bid is already at/below
  the stop or the spread is over half of the stop distance (`stop_inside_spread`). Skips are logged in `execution_logs`.
- Data gate: ≥ 60 contiguous candles, last candle = the most recently completed bucket, full trade coverage
  for that bucket, real trades in the signal candle, ticker age ≤ 180 s, pair not in maintenance.

The active `strategy_configs` row in Supabase is the production source of truth. Important production overrides are: `mtfMode: score`, `universeSize: 25`, `maxOpenPositions: 10`, `feePct: 0.00555` (0.00555%), with the other values in the parameter table below. Code defaults in `shared/strategy.ts` intentionally remain distinct (`mtfMode: filter`, `universeSize: 12`, `maxOpenPositions: 4`). Do not infer the live strategy from code defaults alone.

### Paper trading & risk

| Item | Default |
|---|---|
| Initial virtual balance | Rp10.000.000 |
| Fill model | BUY at ask + slippage, SELL at bid − slippage; base 10 bps, scaled ×1 / 1.5 / 2.5 / 4 by 24h IDR volume (≥ 1e10 / ≥ 2e9 / ≥ 5e8 / below) |
| Fee | 0.00555 % per side (active paper-model assumption; see caveat below) |
| Position size | risk 1 % of equity to the stop (fees and expected exit slippage included), max 25 % of equity per position, max 10 open positions, max 60 % total exposure |
| Stop loss / take profit | 1.5 × ATR / 3 × ATR (fallback 2 % / 4 %) |
| Trailing stop | arms at +1.5 × ATR above entry, then trails 1 × ATR below price |
| Time stop | close after 720 minutes |
| Daily loss limit | 3 % → close all positions (`DAILY_LOSS`) and no new entries for the rest of the day (WIB) |
| Max drawdown | 15 % → automatic kill switch (close all, lock account) |
| Emergency kill switch | button in the dashboard (admin) |

Stop loss and take profit keep protecting open positions while the account is STOPPED. The production paper account is currently RUNNING with kill switch off; current balance, equity, realized P/L and trade counts are recorded in PROJECT_STATE.md with an explicit database snapshot timestamp. Do not treat historical report values as live balances.

**Fee-model caveat:** `feePct` is stored in percentage points, so `0.00555` means `0.00555%` per side. This is the explicit paper-model assumption requested for this project. It must not be represented as independently verified all-in maker/taker fees for every account or market; actual fills can also differ because of spread, slippage, and execution conditions.

All parameters are editable on the *Strategy Configuration* page (validated server-side).

## Current strategy readiness (17 Nov 2026)

The current strategy is **NO-GO for any profitability claim or real-money use**. The latest 30-day historical comparison tested the production baseline and two alternatives; none passed the evidence gate. See [the dated evaluation report](docs/strategy-readiness-2026-11-17.md) for sample sizes, cost assumptions, results, and limitations. Keep the engine in paper mode and do not relax entry/risk gates to increase trade count.

## Backtest scope and interpretation

`npm run backtest` is a **5m candle-only approximation**, not a production-parity strategy test or a portfolio performance report.
Read its scope warnings before interpreting the output:

- Entries are modeled at the next 5m candle open; exits use candle high/low with stop-first ordering and modeled slippage.
  Historical bid/ask quotes, spread checks, tick-level fills and gap-through-stop prices are not available.
- The 15m/1h MTF filter/score is not applied. When the active config has MTF enabled, the script prints this omission.
- Every pair is simulated independently with its own Rp10.000.000 starting cash. Combined win rate and profit factor pool individual
  trades; they are not a shared portfolio equity curve. Shared cash, total exposure, max concurrent positions, daily-loss flattening
  and portfolio drawdown kill-switch are not simulated.
- Dynamic slippage tiers use the **current** 24h volume tier from `market_tickers_latest` as a proxy for the whole historical sample,
  not the volume tier that applied at each historical candle.
- Complete OHLC availability is not the same as active trading coverage: official zero-volume bars remain visible in coverage diagnostics,
  but are not eligible for simulated fills/exits and break the contiguous positive-volume indicator warm-up.
- Official history requests use one process-wide 500 ms start interval (at most 120 starts/minute) across all concurrent pairs and retries, below the documented public API limit of 180 requests/minute.
- The evidence gate reports `NO_GO` unless the holdout contains at least 100 trades, the Wilson 95% lower confidence bound for win rate is
  at least 70%, profit factor is above 1, and net expectancy after modeled fees/slippage is positive. This threshold is a conservative
  project release rule, not proof of independence or future profitability. `ELIGIBLE_FOR_MANUAL_REVIEW` never auto-promotes a strategy.

The script shares the paper fee, stop, sizing, net reward/risk and trailing/time-stop calculations where candle inputs allow them.
Use the output to compare rough per-pair rule behavior, not to estimate production portfolio returns. Strategy changes must be evaluated on a
new, untouched forward holdout; do not tune repeatedly against the same holdout window.

## Repository layout

```
worker/src/     Cloudflare Worker (index, api, pipeline, indodax, relay, db, auth, telegram, notify, ingest)
shared/         Pure, tested logic (indicators, candles, strategy, paper maths)
src/            React dashboard (9 pages + login)
public/         PWA manifest, icons and service worker (copied to dist/ by Vite)
supabase/migrations/  schema, indexes, constraints, RLS, RPC functions
supabase/functions/   Edge Function `indodax-proxy` (read-only INDODAX relay)
tests/          Vitest suites (test count evolves with the code)
scripts/verify-indodax.ts  live read-only check against the INDODAX public API
scripts/backtest.ts        read-only backtest on stored 5m + optional official 1m OHLC history (MTF not simulated)
PROJECT_STATE.md           current production state, open tasks and notes for maintainers/agents
```

## Setup

### 1. Supabase

The migrations in `supabase/migrations/` are already applied to project `sinyalku`
(`znikuooxiqfcicyuhqsx`). For a new project run them in order (SQL editor or `supabase db push`).

1. **Create the dashboard user**: Supabase → Authentication → Users → *Add user* → `gsdrxx@gmail.com`
   with a password (the email is pre-registered as `admin` in `public.app_users`).
2. Recommended: Authentication → Sign In / Providers → disable *Allow new users to sign up*.
3. Add more users: `insert into public.app_users (email, role) values ('someone@example.com', 'viewer');`
4. Copy the **service role / secret key** (Project Settings → API Keys). It is used only by the Worker.

### 2. Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → bot token.
2. Send a message to the bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your `chat.id`.

### 3. Cloudflare deployment

**Option A — GitHub Actions (recommended).** Add these repository secrets
(GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from the *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role / secret key |
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token (deploys the `indodax-proxy` Edge Function) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat id |
| `POSTHOG_PROJECT_TOKEN` | Optional PostHog Project API Key (`phc_`) used for non-fatal engine telemetry |

Then run the *CI & Deploy* workflow (Actions tab → *Run workflow*) or push to `main`. The workflow runs
typecheck + tests + build, deploys the Worker with static assets and the cron trigger, deploys the
`indodax-proxy` Edge Function, and syncs the Worker secrets.

**Option B — from your machine.**

```bash
npm install
npx wrangler login
npm run deploy                         # build + wrangler deploy (assets + cron)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
# Optional: enable PostHog engine telemetry
npx wrangler secret put POSTHOG_PROJECT_TOKEN
```

The app is then live at `https://indodax-quant.<your-subdomain>.workers.dev`
(production: `https://indodax-quant.sinyalku.workers.dev`).

> **Worker runtime note:** production telemetry over the most recent audited 24-hour window showed approximately 125 ms average CPU time, 211 ms p95, and 345 ms maximum for the Worker. All 1,440 recorded scheduled runs in the same window completed successfully. CPU time and wall-clock duration are different metrics. The current account plan and its effective limit were not verifiable with the connected Cloudflare permissions, so no plan limit or upgrade is asserted here. Re-check Cloudflare's current usage/limit before changing plan; do not enable trace sampling solely for routine monitoring.

### 4. First run

1. Open the site, sign in.
2. *System Monitoring* shows a new execution every minute. The first run backfills 24 h of 1m candles
   from the official OHLC endpoint, so indicators are available immediately.
3. *Settings* → *Kirim pesan tes* verifies Telegram.
4. *Paper Trading* → **Start** enables automated paper trading.

## Local development

```bash
npm ci
cp .env.example .dev.vars   # fill SUPABASE_SERVICE_ROLE_KEY etc.
npm run build && npx wrangler dev --test-scheduled   # API + assets on :8787
npm run dev                  # Vite dev server on :5173 (proxies /api to :8787)
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"  # trigger the cron locally
```

## Tests

```bash
npm ci                   # reproducible install from the committed package-lock.json
npm test                 # unit + integration tests (latest exact count is reported by CI)
npm run typecheck
npm run verify:indodax btcidr   # live, read-only check against INDODAX public API
BACKTEST_HISTORY_DAYS=30 npm run backtest  # official 30-day history; see Backtest scope and interpretation
```

Coverage includes: indicator maths (reference RSI values), candle building and gap handling,
signal rules and data-quality gate, sizing / fees / slippage / PnL (matches the SQL functions),
stop loss / take profit, daily loss limit, drawdown kill switch, API authentication and role checks,
cron idempotency, stale-data refusal, notification dedupe, the private-endpoint block, the INDODAX relay,
PostgREST query encoding, chart range padding, multi-timeframe trend, dynamic universe, strategy hardening
(trailing/time stop, dynamic slippage), the entry gate and the full pipeline with fake Supabase RPCs.

The Postgres functions were additionally verified directly in Supabase (inside rolled-back transactions):
duplicate idempotency key rejected, double close rejected, orders refused while STOPPED, balance/PnL
exact to the cent, duplicate cron tick rejected, concurrent run blocked by the lock, RLS enabled on every
table and RPCs not executable by `anon`/`authenticated`.

`npm run verify:indodax` cross-checks 1m candles built from INDODAX trades against the official
INDODAX 1m OHLC endpoint (BTC/IDR 43/43 and DOGE/IDR 242/242 closes matched within 0.1 % at build time).

## API

Public: `GET /api/health`, `GET /api/public-config`.
Authenticated (Supabase JWT + listed in `app_users`): `GET /api/me`, `/api/market/tickers?scope=tracked|all`,
`/api/market/pairs`, `/api/market/history?pair=&minutes=`, `/api/market/trades?pair=`,
`/api/candles?pair=&tf=1m|5m|15m|1h`, `/api/indicators?pair=`, `/api/signals`, `/api/portfolio`, `/api/orders`,
`/api/positions?status=open|closed`, `/api/strategy`, `/api/system`.
Admin: `POST /api/paper/start|stop|kill|reset`, `PUT /api/strategy`, `PUT /api/market/pairs/{id}/track`,
`POST /api/system/run`, `POST /api/telegram/test`.

## Data retention

Hourly: raw trades > 3 days, ticker history > 30 days, 1m candles > 7 days, execution logs > 14 days and
non-hourly portfolio snapshots > 90 days are deleted. 5m candles, indicators, signals, orders and positions
are kept.

## Time zones

Cloudflare cron runs in UTC and every timestamp is stored as `timestamptz` (UTC). The dashboard and
Telegram messages display Asia/Jakarta (WIB). The daily P/L report is sent shortly after 00:00 WIB.

## Integrations

- GitHub: source of truth. A push to `main` runs the *CI & Deploy* workflow (GitHub Actions), which is the production deploy.
- Cloudflare: Worker `indodax-quant`. The separate "Workers Builds" Git check can fail intermittently; it does not affect production.
- Supabase: project "sinyalku"; migrations in `supabase/migrations/` are applied by the Supabase integration.

Current production state and open tasks: see `PROJECT_STATE.md`.

_Last updated: 2026-11-17_
