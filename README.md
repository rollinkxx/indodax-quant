# INDODAX QUANT

Cryptocurrency monitoring and **automated paper trading** platform for INDODAX markets.

- **Frontend**: React + TypeScript + Tailwind CSS (dark, responsive) served by **Cloudflare Workers Static Assets**
- **Backend**: Cloudflare Worker REST API (`/api/*`)
- **Scheduler**: Cloudflare Cron Trigger `* * * * *` (UTC)
- **Database / Auth**: Supabase PostgreSQL + Supabase Auth, Row Level Security
- **Market data**: [INDODAX Official Public API](https://github.com/btcid/indodax-official-api-docs) only
- **Notifications**: Telegram Bot API called directly from the Worker

> **No live trading.** The code contains no INDODAX private/trade API client, no API keys, no order
> submission, no withdrawals. The INDODAX client hard-blocks any non-public endpoint
> (`worker/src/indodax.ts`, covered by tests). Every order is an internal simulation
> (`paper_orders.is_simulated` is constrained to `true`). Paper trading is **STOPPED** after installation
> and only starts when an administrator presses **Start**.

The production system has no dependency on n8n.

## Architecture

```
Cloudflare Cron (every minute, UTC)
  └─ Worker.scheduled → runPipeline()
       1. begin_run RPC        idempotency (one run per minute) + DB lock (no concurrent runs)
       2. INDODAX /api/summaries, /api/trades/{pair}  (timeouts, retries, 429 back-off, validation)
       3. 1m candles from trades; gaps/bootstrap from official /tradingview/history_v2; 5m aggregation
       4. ingest_market RPC    tickers (latest + history), trades (dedup by tid), candles, sync state
       5. indicators (EMA 9/21/50, RSI 14, MACD, ATR 14, Volume MA 20, support/resistance)
       6. signals on COMPLETED 5m candles with data-quality gate (no stale/incomplete data)
       7. paper trading: SL/TP/SELL exits → mark-to-market → risk checks → BUY entries
       8. Telegram notifications (claimed in DB first → never sent twice)
       9. finish_run RPC       execution log + lock release

Browser ── Supabase Auth (publishable key) ──▶ JWT ──▶ Worker /api/* ── service role ──▶ Supabase
```

All money-moving logic runs inside Postgres functions (`paper_open_position`, `paper_close_position`)
with row locks and unique idempotency keys, so balances stay consistent even if a request is retried
or two runs overlap.

### Strategy (default)

Timeframe 5m, completed candles only.

- **BUY**: EMA9 crosses above EMA21, RSI14 in [50, 70], volume ≥ 1.2 × Volume MA20, close > EMA50.
- **SELL**: EMA9 crosses below EMA21, RSI14 ≤ 50, volume confirmation. Closes any open position on that pair.
- Strength score adds MACD histogram, volume spikes and support/resistance breaks.
- Data gate: ≥ 60 contiguous candles, last candle = the most recently completed bucket, full trade coverage
  for that bucket, real trades in the signal candle, ticker age ≤ 180 s, pair not in maintenance.

### Paper trading & risk

| Item | Default |
|---|---|
| Initial virtual balance | Rp10.000.000 |
| Fill model | BUY at ask + 10 bps, SELL at bid − 10 bps |
| Fee | 0.3 % per side |
| Position size | risk 1 % of equity to the stop, max 25 % of equity per position, max 3 open positions |
| Stop loss / take profit | 1.5 × ATR / 3 × ATR (fallback 2 % / 4 %) |
| Daily loss limit | 3 % → no new entries for the rest of the day (WIB) |
| Max drawdown | 15 % → automatic kill switch (close all, lock account) |
| Emergency kill switch | button in the dashboard (admin) |

Stop loss and take profit keep protecting open positions while the account is STOPPED.
All parameters are editable on the *Strategy Configuration* page (validated server-side).

## Repository layout

```
worker/src/     Cloudflare Worker (index, api, pipeline, indodax, db, auth, telegram, notify, ingest)
shared/         Pure, tested logic (indicators, candles, strategy, paper maths)
src/            React dashboard (9 pages + login)
supabase/migrations/  schema, indexes, constraints, RLS, RPC functions
tests/          Vitest suites (91 tests)
scripts/verify-indodax.ts  live read-only check against the INDODAX public API
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
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat id |

Then run the *CI & Deploy* workflow (Actions tab → *Run workflow*) or push to `main`. The workflow runs
typecheck + tests + build, deploys the Worker with static assets and the cron trigger, and syncs the
Worker secrets.

**Option B — from your machine.**

```bash
npm install
npx wrangler login
npm run deploy                         # build + wrangler deploy (assets + cron)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

The app is then live at `https://indodax-quant.<your-subdomain>.workers.dev`.

> **Plan note:** the per-minute job is mostly I/O, but parsing 450 tickers plus indicator maths can exceed
> the 10 ms CPU limit of the Workers *Free* plan. The *Workers Paid* plan (30 s CPU per invocation)
> is recommended for reliable cron execution. Each run uses ~20 subrequests.

### 4. First run

1. Open the site, sign in.
2. *System Monitoring* shows a new execution every minute. The first run backfills 24 h of 1m candles
   from the official OHLC endpoint, so indicators are available immediately.
3. *Settings* → *Kirim pesan tes* verifies Telegram.
4. *Paper Trading* → **Start** enables automated paper trading.

## Local development

```bash
npm install
cp .env.example .dev.vars   # fill SUPABASE_SERVICE_ROLE_KEY etc.
npm run build && npx wrangler dev --test-scheduled   # API + assets on :8787
npm run dev                  # Vite dev server on :5173 (proxies /api to :8787)
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"  # trigger the cron locally
```

## Tests

```bash
npm test                 # 91 unit + integration tests (fake Supabase / INDODAX)
npm run typecheck
npm run verify:indodax btcidr   # live, read-only check against INDODAX public API
```

Coverage includes: indicator maths (reference RSI values), candle building and gap handling,
signal rules and data-quality gate, sizing / fees / slippage / PnL (matches the SQL functions),
stop loss / take profit, daily loss limit, drawdown kill switch, API authentication and role checks,
cron idempotency, stale-data refusal, notification dedupe, and the private-endpoint block.

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
`/api/candles?pair=&tf=5m|1m`, `/api/indicators?pair=`, `/api/signals`, `/api/portfolio`, `/api/orders`,
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
