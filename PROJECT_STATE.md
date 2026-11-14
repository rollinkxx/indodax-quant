# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-14 07:40 WIB (session 12: open tasks cleared by the owner)_

This is the **only working note** in the repo. `README.md` explains the system and how to set it up.
Keep this file short: update the current state, remove finished tasks (do not tick and keep them),
and put session details in commit messages. Earlier session logs live in git history (`git log -- HANDOFF.md TASKS.md`).

## Rules (do not break)

- Paper trading only. Never add INDODAX private/trade API calls or keys.
- Never expose the service role key to the frontend (only `SUPABASE_PUBLISHABLE_KEY` is public).
- Non-destructive migrations only; keep existing data.
- No n8n runtime dependency (the Worker only calls INDODAX via the relay, Supabase and Telegram).
- Do not recreate infrastructure.
- Do not stop or reset the paper account unless the admin (`gsdrxx@gmail.com`) asks.

## Infrastructure (existing)

| Item | Value |
|---|---|
| GitHub repo | `rollinkxx/indodax-quant` (public), branch `main` — push to `main` runs *CI & Deploy* (GitHub Actions) |
| Production URL | `https://indodax-quant.sinyalku.workers.dev` (old `*.rollinkxx.workers.dev` URL is dead, Cloudflare 1042) |
| Cloudflare Worker | `indodax-quant`, Workers **Free** plan (10 ms CPU per invocation), cron `* * * * *` (UTC) |
| Supabase | project `sinyalku`, ref `znikuooxiqfcicyuhqsx`, region ap-southeast-2 |
| INDODAX relay | Supabase Edge Function `indodax-proxy` (GET-only, public allow-list; INDODAX returns 403 to Cloudflare IPs), deployed by CI |
| Migrations applied | `init`, `functions`, `fix_lock_release`, `mtf_universe`, `strategy_hardening`, `entry_gate` (all files in `supabase/migrations/`) |
| Admin user | `gsdrxx@gmail.com` (Supabase Auth + `app_users.role = admin`) |

Notes: the "Workers Builds: indodax-quant" check (Cloudflare Git integration) fails intermittently; the production deploy is the
GitHub Actions job. New migrations in `supabase/migrations/` were applied automatically by the Supabase integration (entry_gate).

## Current state (verified 2026-11-14 07:35 WIB)

- `/api/health` 200, `liveTrading:false`. Live bundle `index-Df6dlSPj.js` (code-split `1fc0d2a`) confirmed.
- Cron since 2026-11-13 18:00Z: 393/393 SUCCESS; last 3 h avg 9.0 s / max 15.3 s. No CPU-limit or relay errors.
  Universe: 5 pinned + 8 dynamic = 13 pairs.
- Paper account: **RUNNING** since 2026-11-13 13:00 WIB (started by the admin), equity Rp9.939.100 (−0.61 %), max drawdown 0.98 %.
- Trades: 3, all closed — `nearidr` TAKE_PROFIT +Rp37.551; `anoaidr` STOP_LOSS −Rp64.384; `hypeidr` STOP_LOSS −Rp34.067. 0 open positions.
- Entry gate: 2 BUYs skipped (`stop_inside_spread`: pippinidr, fartcoinidr); 1 passed (hypeidr, signal 154, 19:05Z) and behaved
  as designed: spread 0.17 %, fill = ask + 15 bps, SL/TP = 1.5 / 3 × ATR, size capped at 25 % of equity, fees 0.3 %, Telegram
  signal + paper BUY + stop-loss notices sent. Exit filled 0.35 % below the stop (bid gapped 1.328.854 → 1.325.000 within 1 min).
- Active strategy config (DB `strategy_configs` row is the source of truth; changed by the admin 2026-11-13 17:52Z):
  `maxEntrySpreadPct` 0.6, `maxEntryDriftPct` 0.5, `universeMinVolumeIdr` 1e9, `universeSize` 25, `maxOpenPositions` 10.
- Local checks at `1fc0d2a`: typecheck 0 errors, 130 tests / 15 files pass, build OK.

## Open tasks

None.

## Known strategy limitations (watch, not changed)

- 5m EMA cross-down exits can whip out of winners early.
- MTF `filter` blocks every BUY while any higher timeframe is still warming up.
- Pinned pairs `xautidr` / `paxgidr` still emit signals although they are excluded from the dynamic universe.
- SELL signals without an open position are stored but not sent to Telegram (by design).
- Low-ATR entries have a very tight stop: hypeidr stop was 0.43 % and TP 0.86 % below/above entry, while the round trip costs
  ~0.9 % (fees 0.6 % + slippage 2 × 0.15 %) — TP barely breaks even, SL loses ~1.3 %. Checks run once per minute, so a fast bid drop fills below the stop.
- Only 3 closed trades: no meaningful win rate yet.

## Agent notes

- **"Session approvals are not available for this tool"** on GitHub/Supabase MCP calls: the connector is fine. Reconnect the server
  (`mcp-servers` → `connect`, slug `git-hub` or `supabase`) and retry. The approval is per tool: each write tool
  (`create_or_update_file`, `push_files`, `merge_pull_request`, `execute_sql`) may need its own reconnect.
- `create_or_update_file` on an existing file needs its blob SHA (`get_file_contents` first). `push_files` needs the FULL file content.
  Verify a push by `git clone` in the sandbox and `cmp` against the locally tested copy.
- Local build/test needs `npm install` first (no `package-lock.json`).
- Supabase via the n8n HTTP node does not work (OAuth credential not allowed there); use the Supabase MCP.
- Column names: `execution_logs` uses `started_at` (not `created_at`); `trading_signals` / `paper_orders` / `paper_positions` use `pair_id`
  (not `pair`); the signal direction column is `side`. When unsure, check `information_schema.columns`.
- Entry-gate skips appear in `execution_logs.steps.paper_trading.info.actions` as `skip <pair>: wide_spread|price_drift|stop_inside_spread|bad_quote`.
