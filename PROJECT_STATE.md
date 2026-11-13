# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-14 00:30 WIB (session 10: TASKS.md, HANDOFF.md and docs/STRATEGY_HARDENING.md merged into this file and README.md)_

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

## Current state (verified 2026-11-14 00:09 WIB)

- `/api/health` 200, `liveTrading:false`. Live bundle `index-DYmgLrX3.js` = build of `43f4f98`.
- Cron: last 3 h 180/180 SUCCESS, wall time avg 11.5 s / max 21.1 s (was 5.6 / 11.3 s before the dynamic universe grew). No CPU-limit errors.
- Paper account: **RUNNING** since 2026-11-13 13:00 WIB (started by the admin), initial equity Rp10.000.000.
- Trades so far: 2, both closed — `nearidr` TAKE_PROFIT +Rp37.551; `anoaidr` STOP_LOSS −Rp64.384 (bad fill on a 1.2% spread, the reason for the entry gate). 0 open positions.
- Entry gate is live: BUY pippinidr @ 223.928 (16:10Z) skipped as `stop_inside_spread` (execution id 667), no order.
- Active strategy config (DB `strategy_configs` row is the source of truth, see README for the parameters): `maxEntrySpreadPct` 0.6,
  `maxEntryDriftPct` 0.5, `universeMinVolumeIdr` 5e8 (code default 1e9). Both entry fields are editable on the Strategy page.
- Local checks at `43f4f98`: typecheck 0 errors, 130 tests / 15 files pass, build OK.

## Open tasks

- [ ] Watch the next BUY that passes the entry gate → paper order; compare fill vs signal price and check sizing, SL/TP, fee and the Telegram order notice.
- [ ] Watch run duration/CPU as the universe grows to ~17 pairs on Workers Free. If runs start failing, set `universeMode: 'manual'` on the Strategy page (no deploy needed).
- [ ] After ≥ 30 closed trades: run `npm run backtest` and review the known limitations below.
- [ ] Owner: confirm all 9 dashboard pages show real data after login.
- [ ] Optional: disable public sign-ups in Supabase Auth; code-split `lightweight-charts`; Workers Paid plan (30 s CPU).
- [ ] Only if the relay 502 "Maximum number of redirects" (seen once, 2026-11-13 13:47 WIB, self-recovered) repeats: add retry/backoff in `indodax-proxy`.

## Known strategy limitations (watch, not changed)

- 5m EMA cross-down exits can whip out of winners early.
- MTF `filter` blocks every BUY while any higher timeframe is still warming up.
- Pinned pairs `xautidr` / `paxgidr` still emit signals although they are excluded from the dynamic universe.
- SELL signals without an open position are stored but not sent to Telegram (by design).
- Only 2 closed trades: no meaningful win rate yet.

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
