# Production readiness hardening — design

## Intent

Harden INDODAX QUANT so its production paper engine operates consistently, relay access is restricted to the Worker, deployments cannot report success while required components were skipped, and strategy evidence/documentation always reflects the source run and database state that produced it.

## Goals

- Authenticate every Worker-to-Supabase INDODAX relay request with HMAC-SHA256, a timestamp, and a narrow replay window; never transmit the service-role secret.
- Validate relay paths, methods, and query parameters before contacting INDODAX; cap historical request ranges to bounded windows.
- Make deployment decisions explicit and fail closed when credentials required for a requested deployment are unavailable.
- Preserve separation between frontend/test/strategy evaluation and production deployment. A docs-only change must not redeploy or re-run a 30-day historical simulation.
- Use a committed npm lockfile and `npm ci` so CI/deploy resolves the same dependency graph.
- Test the complete Supabase migration chain on a clean PostgreSQL 17 database, including backend-only grants and RLS expectations.
- Keep strategy configuration, paper-account history, and all entry/risk gates unchanged. Refresh documentation only from captured, timestamped evidence.

## Non-goals and anti-goals

- No live INDODAX order endpoints, private API keys, order submission, withdrawals, or real-money activation.
- No relaxation of spread, quote-age, stop-distance, fees/slippage, net reward/risk, position sizing, or portfolio gates.
- No reset of the paper account, no deletion/recalculation of historic paper orders, and no rewriting historic fee provenance.
- No claim that a passing build or candle-only backtest proves profitability.
- No new paid Cloudflare product or persistent datastore solely for rate limiting.

## Approaches considered

1. Public relay with endpoint allowlist only — rejected because anyone can call it and consume the project's relay quota.
2. Pass the service-role secret directly in an Authorization header — rejected because it exposes a high-privilege credential to the relay request path and request logs.
3. HMAC-signed service-to-service requests using the existing Worker secret, timestamp, and exact relay path/query — selected. It authenticates the caller without transmitting the secret, and a bounded timestamp prevents indefinite replay. The relay remains read-only and validates each upstream target independently.

## Chosen architecture

The Worker signs `GET\n<proxy-path-and-query>\n<unix-timestamp>` using HMAC-SHA256 derived from its existing Supabase service secret. It sends only `x-indodax-relay-timestamp` and `x-indodax-relay-signature`. The Supabase Edge Function verifies the signature against the legacy service-role environment value or the new secret-key values provided by Supabase, requires a narrow timestamp window, validates the allowlisted path and exact query schema, and only then calls `https://indodax.com`.

The deployment workflow first classifies changed files. Tests run for every PR and main push. Worker deployment runs only for app/runtime/dependency changes. Relay deployment runs only when the relay implementation changes and fails visibly if its credential is unavailable. Historical evaluation runs only for strategy/data/schema/evaluator changes. Manual workflow dispatch remains an explicit full release/evaluation action.

## Constraints

- Existing stack remains Cloudflare Workers, Supabase PostgreSQL/Edge Functions, GitHub Actions, and PostHog.
- Existing production Supabase project and Worker are retained.
- Production paper account remains paper-only and is not reset.
- The current fee modelling assumption remains `feePct = 0.00555` percentage points, i.e. 0.00555% per side.
- Strategy remains NO-GO until untouched production-parity evidence satisfies the established sample, confidence-bound, profit-factor, and expectancy gates.
- Relay historical limits must support existing 12-hour 1m backtest chunks and the current higher-timeframe bootstrap range.

## Validation and release policy

Each behavior change gets a failing regression test before implementation, then focused tests, the full Vitest/typecheck/build suite, PostgreSQL 17 migration replay, browser smoke, and the relevant GitHub workflow branch scenario. No strategy tuning is bundled into infrastructure fixes. Production deploy is allowed only after tests pass and required release credentials are present. Relay must be deployed before the Worker version that requires its HMAC checks; if its deployment credential is unavailable, release stops and reports the exact missing secret rather than silently skipping the relay.
