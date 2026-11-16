# Cost model and strategy telemetry

## Paper-trading fee assumption

The active paper strategy uses `feePct: 0.00555`. The code stores this value as a percentage, not as a decimal fraction:

`fee = notional × feePct ÷ 100`

The same requested rate is applied to both the entry and exit legs, and the simulation does not distinguish maker from taker. Slippage remains a separate cost assumption and spread remains an execution-quality gate.

**Important limitation:** INDODAX's 29 September 2026 announcement describes 0.00555% as the CFX component for IDR-market transactions. It should not be interpreted as proof that this is the complete all-in maker/taker charge for every account. This project applies it as the requested working assumption; net paper performance may therefore be overstated if other commissions or taxes are charged separately. Reconcile against the account's own Trading Fees page before relying on simulated net returns.

Past paper orders and realised P/L are not recalculated when this configuration changes. The new rate applies prospectively to future paper orders and strategy evaluations that load the active configuration.

## PostHog instrumentation

The Worker emits a small number of server-side events to PostHog:

- `trading_pipeline_run`: run duration, status, signal count, opened entries, rejection count, and error count.
- `trading_signal_generated`: pair, side, strength, and signal ID.
- `paper_entry_rejected`: pair, signal ID, execution stage, rejection reason, and numeric gate diagnostics such as spread, drift, fee, slippage, and net reward/risk.
- `paper_position_opened`: pair, signal ID, simulated position ID, fill, notional, and fee.
- `trading_pipeline_step_error`: pipeline step that failed, without sending raw error messages.

Events use a fixed service identity and disable person-profile creation. No account login, email, API key, balance snapshot, or user identity is sent. Supabase remains the canonical store for market data, signals, paper orders, and execution logs. PostHog is an additional diagnostic/analytics surface; a missing token or PostHog outage must never block the trading pipeline.

Set the Worker secret `POSTHOG_PROJECT_TOKEN` and the public host `POSTHOG_HOST=https://us.i.posthog.com`. If the token is absent, telemetry stays disabled.
