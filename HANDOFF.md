# HANDOFF — INDODAX QUANT

Read this first, then `PROJECT_STATE.md` and `TASKS.md`. Do not recreate infrastructure.

## Session log

### Session 1 (previous agent)
Commits `44a5b70`, `f1884f4`, `6a7cb51`, `1911b93`, `45a5424`. Built DB migrations (applied to Supabase
`sinyalku`), the Worker (INDODAX client, pipeline, API, Telegram) and shared logic. The commit message of
`45a5424` claims the 9 dashboard pages, and README claims `tests/` (91 tests), `scripts/` and a GitHub Actions
workflow, but **those files were never pushed** (only `src/pages/Login.tsx` existed; frontend did not compile).

### Session 2 (n8n Instance Agent, 2026-11-13)
- Audited repo, commits, and Supabase (migrations applied, seed data present, account STOPPED).
- Added the 9 missing pages (`src/pages/*.tsx`), all backed by real `/api/*` endpoints.
- Added `tests/` (66 tests, all passing) and `scripts/verify-indodax.ts` (live check passed).
- Added `.github/workflows/ci-deploy.yml` (typecheck → test → build → wrangler deploy → secrets sync → smoke test).
- Docs: PROJECT_STATE.md, TASKS.md, HANDOFF.md.
- Commit: see `git log` (message starts with `feat(web,test,ci): session 2`).

## Blockers (need the human owner)
1. **Cloudflare access**: no agent tool has Cloudflare credentials. Add GitHub repo secrets
   `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`, then run the
   *CI & Deploy* workflow. Without them the deploy job is skipped with a warning.
2. **Worker secrets**: add GitHub secrets `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API Keys,
   secret key) and `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. The workflow syncs them into the Worker.
3. **Login user**: create `gsdrxx@gmail.com` in Supabase Auth (Authentication → Users → Add user).
4. **Plan**: Workers Free has a 10 ms CPU limit per invocation; the per-minute job may exceed it. Workers
   Paid is recommended (see README).

## Next steps for the next agent
1. Check GitHub Actions run of the latest commit. If deploy succeeded, open the workers.dev URL.
2. In Supabase run: `select status, started_at, error from execution_logs order by started_at desc limit 10;`
   Expect one row per minute with SUCCESS/PARTIAL.
3. Check `candles` and `indicators` fill (first run backfills 24h of 1m candles).
4. Fix any production error found in `execution_logs.error`, add a test, commit, update these docs.
5. Paper trading must stay STOPPED until the administrator presses Start.

## Rules
- Paper trading only. Never add INDODAX private/trade API calls or keys.
- Never expose the service role key to the frontend (only `SUPABASE_PUBLISHABLE_KEY` is public).
- Non-destructive migrations only; keep existing data.
- No n8n runtime dependency.
