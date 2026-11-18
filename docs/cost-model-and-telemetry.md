# Cost model and strategy telemetry

## Paper-trading fee assumption

The active paper strategy uses `feePct: 0.00555`. The code stores this value as a percentage, not as a decimal fraction:

`fee = notional × feePct ÷ 100`

The same requested rate is applied to both the entry and exit legs, and the simulation does not distinguish maker from taker. Slippage remains a separate cost assumption and spread remains an execution-quality gate.

**Important limitation:** INDODAX's 29 September 2026 announcement describes 0.00555% as the CFX component for IDR-market transactions. It should not be interpreted as proof that this is the complete all-in maker/taker charge for every account. This project applies it as the requested working assumption; net paper performance may therefore be overstated if other commissions or taxes are charged separately. Reconcile against the account's own Trading Fees page before relying on simulated net returns.

Past paper orders and realised P/L are not recalculated when this configuration changes. The new rate applies prospectively to future paper orders and strategy evaluations that load the active configuration.

### Per-pair taker fee model (`feeModel`)

INDODAX publishes each pair's real taker fee as `trade_fee_percent_taker` in `/api/pairs`. For every IDR pair the live catalog currently reports `0.2`, i.e. **0.2% per side**, which is ~36× the `0.00555` assumption for a round trip. Under the assumption the net reward/risk gate can therefore approve entries that are economically negative once the real fee is charged.

To close that gap, `strategy_configs.params.feeModel` selects how the per-side fee is derived:

- `assumption` (default, current behavior): every pair uses `feePct`. Nothing changes until you opt in.
- `pair_taker`: each pair is charged its own `market_pairs.trade_fee_percent_taker`; a pair whose catalog value is missing or invalid falls back to `feePct`, and a genuine `0` fee is honoured.

The model is applied consistently to position sizing, the economics gate, the exit fee, the kill switch, and the backtest. Per-pair taker fees are also returned by `begin_run` so the pipeline does not need a second query. Switching `feeModel` to `pair_taker` only affects future paper orders and evaluations; it does not rewrite past results.

To see the cost of the mismatch before switching, run the read-only report `npm run fee:sensitivity` (requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`). It replays stored candles under both models and prints the P&L difference without modifying the active config or placing any order.

## PostHog instrumentation

The Worker emits a small number of server-side events to PostHog:

- `trading_pipeline_run`: run duration, status, signal count, opened entries, rejection count, and error count.
- `trading_signal_generated`: pair, side, strength, and signal ID.
- `paper_entry_rejected`: pair, signal ID, execution stage, rejection reason, and numeric gate diagnostics such as spread, drift, fee, slippage, and net reward/risk.
- `paper_position_opened`: pair, signal ID, simulated position ID, fill, notional, and fee.
- `trading_pipeline_step_error`: pipeline step that failed, without sending raw error messages.

Events use a fixed service identity and disable person-profile creation. No account login, email, API key, balance snapshot, or user identity is sent. Supabase remains the canonical store for market data, signals, paper orders, and execution logs. PostHog is an additional diagnostic/analytics surface; a missing token or PostHog outage must never block the trading pipeline.

Set the Worker secret `POSTHOG_PROJECT_TOKEN` and the public host `POSTHOG_HOST=https://us.i.posthog.com`. If the token is absent, telemetry stays disabled.
