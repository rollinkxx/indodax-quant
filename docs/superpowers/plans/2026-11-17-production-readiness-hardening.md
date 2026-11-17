# Production Readiness Hardening Implementation Plan

> **For agentic workers:** Execute task-by-task using the inline executing-plans workflow. Every behavior task uses RED → GREEN → full-suite verification. Do not modify production trading parameters.

**Goal:** Close relay, deployment, reproducibility, migration-validation, and operational-evidence gaps without changing the paper strategy or its risk gates.

**Architecture:** HMAC-authenticated read-only INDODAX relay, explicit changed-file release gates, fail-closed deployment credentials, reproducible npm install, complete migration replay, and evidence-based operational reports.

**Tech Stack:** TypeScript, Vitest, Supabase Edge Functions/PostgreSQL 17, Cloudflare Workers/Wrangler, GitHub Actions, npm.

**Spec:** `docs/superpowers/specs/2026-11-17-production-readiness-design.md`

## Global Constraints

- No live trading or INDODAX private API support.
- Do not reset paper account #1, modify historical orders, or change fee/strategy/risk parameters.
- Fee remains 0.00555% per side in the paper model.
- MTF mode remains `score`; current spread, quote-age, stop, reward/risk, position-size and exposure gates remain unchanged.
- Keep the evidence gate unchanged; failed variants remain NO-GO.
- No paid service or new persistent storage added.

## Review Focus

- Invalid, stale, future, tampered, missing or replayed relay signatures must be rejected before upstream fetch.
- History query must reject path traversal, duplicate/unknown parameters, invalid symbols/timeframes, non-numeric bounds, inverted ranges, and oversized windows.
- A deploy request with a missing mandatory credential must fail and never report a successful release.
- Docs-only changes must not run deploy/evaluation; strategy code, migrations, relay code and dependency changes must select the correct jobs.
- Historical fee values and paper account state must remain unchanged by all migrations and reports.

---

### Task 1: Authenticate and bound the INDODAX relay

**Files:**
- Create: `supabase/functions/_shared/relay.ts`
- Modify: `worker/src/relay.ts`, `worker/src/index.ts`, `worker/src/env.ts`, `scripts/backtest.ts`, `supabase/functions/indodax-proxy/index.ts`
- Test: `tests/relay-security.test.ts`, `tests/relay.test.ts`

**Interfaces:**
- `signRelayRequest(secret: string, target: string, timestamp: number): Promise<string>`
- `verifyRelayRequest(secret: string, target: string, timestamp: string, signature: string, nowSeconds?: number): Promise<boolean>`
- `validateRelayTarget(path: string, query: URLSearchParams): { ok: true; target: string } | { ok: false; status: 400; error: string }`
- `withIndodaxRelay(base, proxyUrl, relaySecret)` signs only rewritten INDODAX GET requests.

- [ ] Add tests for valid signature, wrong secret, modified query, malformed signature, stale/future timestamp, valid existing endpoints, invalid path, unknown/duplicate history parameters, and oversized history ranges.
- [ ] Run focused tests and confirm the new tests fail because the helper/auth behavior is absent.
- [ ] Implement HMAC-SHA256 over method + exact proxy path/query + Unix timestamp; verify within 60 seconds using Web Crypto. Never send or log the key itself.
- [ ] Validate GET only; keep public endpoint allowlist exact; validate history symbol, timeframe, numeric `from/to`, unique parameter names, and maximum windows (1m: 7 days; 15m/60m: 14 days).
- [ ] Update Worker and backtest relay callers to sign with the existing Supabase service secret; missing secret with a configured proxy fails closed.
- [ ] Re-run `npm test -- tests/relay.test.ts tests/relay-security.test.ts`, then `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Confirm the Supabase function deployment bundle includes the shared helper and the main function remains read-only.

### Task 2: Make release workflow deterministic and fail closed

**Files:**
- Modify: `.github/workflows/ci-deploy.yml`
- Create: `scripts/detect-ci-changes.mjs`, `tests/detect-ci-changes.test.ts`

**Interfaces:**
- Detector reads `EVENT_NAME`, `BASE_SHA`, `HEAD_SHA`, obtains changed files from Git, and emits deterministic `deploy`, `relay`, and `strategy` outputs.
- `workflow_dispatch` forces all three true; pull requests force all three false.

- [ ] Test docs-only, UI-only, Worker/shared strategy, relay-only, migration-only, dependency-only, empty-diff, missing-base, dispatch, and PR cases; verify RED before implementation.
- [ ] Move changed-file classification out of inline YAML to a unit-testable Node script.
- [ ] Make relay deployment a distinct gate; if relay files changed and `SUPABASE_ACCESS_TOKEN` is absent, fail that release path. Never log credentials.
- [ ] Make Worker deployment fail if Cloudflare token/account ID is missing instead of warning and skipping.
- [ ] Keep browser smoke and full tests on PRs; never expose production secrets to PR jobs.
- [ ] Add workflow tests to CI; verify the PR workflow skips production deploy/evaluation while a main Worker/relay/strategy change selects the expected jobs.

### Task 3: Reproducible dependency install

**Files:**
- Create: `package-lock.json`
- Modify: `package.json`, `.github/workflows/ci-deploy.yml`

- [ ] Generate a lockfile with the pinned Node/npm toolchain from the current package manifest; review the lockfile and ensure no unintended package upgrades.
- [ ] Replace CI `npm install` with `npm ci` in test, deploy and evaluation jobs.
- [ ] Verify `npm ci`, typecheck, full tests and build on a clean runner.

### Task 4: Complete PostgreSQL migration and privilege validation

**Files:**
- Create: `tests/sql/migrations-clean-replay.sql` or a dedicated migration validation script
- Modify: `.github/workflows/ci-deploy.yml`, SQL assertions under `tests/sql/`

- [ ] Test the entire migration chain against a new PostgreSQL 17 database in chronological order and verify it fails before any schema bootstrap is assumed.
- [ ] Assert RLS is enabled for every public application table, no public client table grants permit writes, backend RPCs are executable only by service_role, and `system_locks` remains backend-only.
- [ ] Assert active-config fee semantics and strategy hardening logic without connecting to or mutating production Supabase.
- [ ] Run migration replay and all existing SQL tests on every PR.

### Task 5: Reconcile operational reports and current evidence

**Files:**
- Modify: `README.md`, `PROJECT_STATE.md`, `docs/strategy-readiness-2026-11-17.md`
- Optional: PostHog strategy-readiness note only after the exact report is verified.

- [ ] Source strategy metrics only from the latest successful `strategy-evaluation` artifact; record run ID, captured config timestamp, date window, pair count, sample, fee assumption, limitations and gate status.
- [ ] Source paper-account status, cash/equity, realized P/L, open/closed positions and transaction counts from a single read-only database snapshot.
- [ ] Preserve old fee provenance; clearly separate historical 0.3% rejection logs from current 0.00555% settings.
- [ ] Never report an old artifact's paper state as current if its capture timestamp predates newer transactions.
- [ ] Run full verification and review final docs against the underlying artifact and database query.

### Task 6: Release and production verification

- [ ] Merge only after all required PR checks pass.
- [ ] Deploy the Supabase relay before Worker HMAC enforcement; verify missing signature, invalid signature, tampered query, and valid Worker-signed request behavior.
- [ ] Deploy the Worker and verify `/api/health`, static app, cron, market ingestion, and PostHog event freshness.
- [ ] Verify Supabase paper account/config exactly match the pre-release snapshot; no account reset, no live trading and no changed risk gates.
- [ ] Run a fresh official INDODAX 30-day evaluation after strategy-relevant changes only; retain NO-GO if any gate fails.
- [ ] Record any external credential unavailable as a release blocker; do not report it as complete.

