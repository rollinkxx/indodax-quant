# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-15 01:08 WIB (session 27: Telegram partial kill-switch reporting — in progress)_

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

## Current state (verified 2026-11-14 15:25 WIB)

- `/api/health` 200, `liveTrading:false`. Step 8 bundle `index-BqP42N3g.js` was live; the step 9 bundle is live when the served CSS
  contains `--app-accent-hover` (checked after the CI deploy, see the step 9 commit).
- Cron since 2026-11-13 18:00Z: 865/865 SUCCESS; last 3 h avg 8.8 s / max 18.4 s. No CPU-limit or relay errors.
  Universe: 5 pinned + 8 dynamic = 13 pairs.
- Paper account: **RUNNING** since 2026-11-13 13:00 WIB (started by the admin), equity Rp9.939.100 (−0.61 %), max drawdown 0.98 %.
- Trades: 3, all closed — `nearidr` TAKE_PROFIT +Rp37.551; `anoaidr` STOP_LOSS −Rp64.384; `hypeidr` STOP_LOSS −Rp34.067. 0 open positions.
- Entry gate: 2 BUYs skipped (`stop_inside_spread`: pippinidr, fartcoinidr); 1 passed (hypeidr, signal 154, 19:05Z) and behaved
  as designed: spread 0.17 %, fill = ask + 15 bps, SL/TP = 1.5 / 3 × ATR, size capped at 25 % of equity, fees 0.3 %, Telegram
  signal + paper BUY + stop-loss notices sent. Exit filled 0.35 % below the stop (bid gapped 1.328.854 → 1.325.000 within 1 min).
- Active strategy config (DB `strategy_configs` row is the source of truth; changed by the admin 2026-11-13 17:52Z):
  `maxEntrySpreadPct` 0.6, `maxEntryDriftPct` 0.5, `universeMinVolumeIdr` 1e9, `universeSize` 25, `maxOpenPositions` 10.
- Local checks after step 9: typecheck 0 errors (TypeScript 5.9, see agent notes), 138 tests / 17 files pass, build OK
  (index 510.4 kB, CSS 54.3 kB, Charts 184.4 kB).

## Open tasks

- Assistant: include total positions and failed pair/reason details in the manual kill-switch Telegram notification so it matches
  the API and dashboard partial-close summary. Preserve the existing automatic kill-switch message signature and test HTML escaping.
- Owner: enable Supabase Auth leaked-password protection in the project Auth settings; the security advisor reported it disabled.
  This is an Auth project setting, not a database migration, and was deliberately not changed from this branch.
- Owner: inspect the authenticated dashboard in a real browser (desktop + 375 px, light/dark, browser console).
  The public login page is already smoke-tested with Playwright in all four viewport/theme combinations; no admin credentials were used.

New features, libraries or pages: propose them to the owner first, do not build them.

## Frontend notes (UI redesign finished 2026-11-14)

- Rules that still apply to UI work: no new runtime dependencies (Tailwind v4 CSS-first, inline SVG icons); animations only
  `transform`/`opacity`, 150–300 ms, respect `prefers-reduced-motion`, never re-animate on a poll; fixed app shell (`<main>` is the
  scroll container); no layout shift; keep Indonesian texts, WIB times, the PAPER TRADING notice and code-split routes.
  Budget: initial `index-*.js` ≤ 520 kB.
- Where things live: tokens and both themes in `src/index.css` (`:root` dark, `:root:not(.dark)` light, which also remaps the status palette
  shades components use directly); shared components in `src/components/ui.tsx` + `Icon.tsx`; shell in `Layout.tsx`; theme in
  `src/lib/theme.ts` + inline script in `index.html`; PWA in `public/` + `src/lib/pwa.ts`; PnL calendar in `PnlCalendar.tsx` / `src/lib/pnlCalendar.ts`.
- Contrast: every text token is ≥ 4.5:1 on `bg-app`/`bg-surface`/`bg-elevated` in both themes. Primary buttons are white on
  `bg-accent-strong` (hover `bg-accent-hover`); do not put white text on `bg-accent`. A global `:focus-visible` outline is the fallback for
  elements without their own `focus-visible:ring-*`.

## Known strategy limitations (watch, not changed)

- 5m EMA cross-down exits can whip out of winners early.
- MTF `filter` blocks every BUY while any higher timeframe is still warming up.
- Pinned pairs `xautidr` / `paxgidr` still emit signals although they are excluded from the dynamic universe.
- SELL signals without an open position are stored but not sent to Telegram (by design).
- Stop-loss execution is still exposed to gaps between one-minute checks: the HYPE incident filled 0.35 % below the stop
  when the bid dropped quickly. The net reward/risk gate prices the configured exit slippage, but cannot guarantee a stop fill during a gap.
- Only 3 closed trades: no meaningful win rate yet.

## Agent notes

- Read-only public login browser check: `scripts/browser-smoke/live-public-ui.mjs`, manually runnable from the
  `Live public UI smoke` workflow. It checks 1440 px / 375 px in light/dark, login controls, theme-color, overflow and browser errors.

- **"Session approvals are not available for this tool"** on GitHub/Supabase MCP calls: the connector is fine. Reconnect the server
  (`mcp-servers` → `connect`, slug `git-hub` or `supabase`) and retry. The approval is per tool: each write tool
  (`create_or_update_file`, `push_files`, `merge_pull_request`, `execute_sql`) may need its own reconnect.
- GitHub MCP writes are text-only: binary files (PNG etc.) cannot be committed by the agent. PWA icons are SVG for that reason
  (no iOS `apple-touch-icon` PNG yet; the owner can add one by hand).
- `create_or_update_file` on an existing file needs its blob SHA (`get_file_contents` first). `push_files` needs the FULL file content.
  Verify a push by downloading the repo tarball in the sandbox and `cmp` against the locally tested copy.
- Local build/test needs `npm install` first (no `package-lock.json`).
- The n8n agent sandbox has an empty `/proc`: `tsc` 7 (Go) panics there (`readlink /proc/self/exe`) and headless Chromium cannot start.
  Typecheck with `npx -p typescript@5 tsc --noEmit -p tsconfig.app.json` (and `tsconfig.worker.json`); CI uses the real `tsc` 7.
  The sandbox has no git and ~2 GB disk: download the repo as a tarball from codeload.github.com and clear `~/.npm/_cacache` after `npm install`.
- Supabase via the n8n HTTP node does not work (OAuth credential not allowed there); use the Supabase MCP.
- Column names: `execution_logs` uses `started_at` (not `created_at`); `trading_signals` / `paper_orders` / `paper_positions` use `pair_id`
  (not `pair`); the signal direction column is `side`. When unsure, check `information_schema.columns`.
- Entry-gate skips appear in `execution_logs.steps.paper_trading.info.actions` as `skip <pair>: wide_spread|price_drift|stop_inside_spread|bad_quote`.
