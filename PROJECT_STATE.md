# PROJECT STATE — INDODAX QUANT

_Last updated: 2026-11-15 01:10 WIB (PR #4 merged, production deploy and DB verification complete)_

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
| Migrations applied | `init`, `functions`, `fix_lock_release`, `mtf_universe`, `strategy_hardening`, `entry_gate`, `is_app_user_security_invoker`, `improve_paper_trade_fk_indexes`, `optimize_app_users_self_rls_initplan` |
| Admin user | `gsdrxx@gmail.com` (Supabase Auth + `app_users.role = admin`) |

Notes: the "Workers Builds: indodax-quant" check (Cloudflare Git integration) fails intermittently; the production deploy is the
GitHub Actions job. New migrations in `supabase/migrations/` were applied automatically by the Supabase integration (entry_gate).

## Current state (verified 2026-11-15 01:09 WIB, after PR #4 production deploy)

- Production `GET /api/health`: HTTP 200, `liveTrading:false`; production homepage smoke passed.
- Cloudflare Worker `indodax-quant` deployed from main commit `6e1b3dfc9b5fe622cd260461910d09eec14324c8` at 2026-11-14 18:08:14Z. Worker version `ba6b5f07-1901-4748-b611-4f0ba9b04084`. GitHub Actions CI & Deploy run #162 succeeded, including relay deployment, Worker/static assets/cron deployment, Worker secret sync and smoke test.
- Cron: latest 8 executions (18:02Z–18:09Z) all SUCCESS, no logged errors.
- Paper account 1: **RUNNING**, kill switch false; initial balance / cash / equity / peak equity Rp10.000.000; max drawdown 0%; 0 open positions, 3 closed positions and 6 paper orders. Current `reset_at` is 2026-11-14 10:16:15Z; the previous Rp9.939.100 snapshot is superseded. This session did not stop or reset the account.
- Supabase production now has all 9 migrations, including `is_app_user_security_invoker`, `improve_paper_trade_fk_indexes`, and `optimize_app_users_self_rls_initplan`. The three new migrations were applied automatically after merge.
- Database verification: `is_app_user()` is SECURITY INVOKER with `search_path=pg_catalog, public`; anon cannot execute it, authenticated and service_role can. All five new FK indexes exist. `app_users_self` uses the scalar-subquery form.
- Supabase Security Advisor no longer reports the SECURITY DEFINER helper finding. Remaining findings: INFO for `system_locks` having no client policy (backend-only table) and WARN for leaked-password protection (disabled). The project organization is on Free.
- Supabase Performance Advisor still reports `auth_rls_initplan`, but an EXPLAIN under the authenticated role shows `InitPlan 1` and a one-time filter for the JWT claim; the actual query plan is using the intended init-plan. The five new FK indexes are currently reported as unused (INFO), expected until those FK lookup/delete paths occur.
- CI on the merged commit: TypeScript typecheck passed, 171 tests / 20 files passed, PostgreSQL 17 migration assertions passed, production build passed. Initial JS 510.40 kB (budget 520 kB), CSS 54.88 kB, Charts 184.42 kB.
- Live public login Playwright smoke passed 4/4: desktop 1440 px / mobile 375 px, dark and light. Authenticated dashboard pages still need an owner browser session for a final visual/console review.

## Open tasks

- Owner: decide whether to upgrade Supabase from Free to Pro or above to enable leaked-password protection. This is an Auth project setting, not a database migration; no paid upgrade was made.
- Owner: inspect the authenticated dashboard in a real browser using the owner's own session (desktop 1440 px and mobile 375 px, light/dark, browser console). Public login is already smoke-tested without admin credentials.


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

- Read-only public login browser check: `scripts/browser-smoke/live-public-ui.mjs`, runs on PRs and can also be manually dispatched via
  `Live public UI smoke`. It checks 1440 px / 375 px in light/dark, login controls, theme-color, overflow and browser errors.

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
