# Cost model and strategy telemetry

## Paper-trading fee model

The active paper strategy charges the **real INDODAX taker fee per pair** (`feeModel: "pair_taker"`). `feePct: 0.2` remains only as a fallback. The code stores these values as percentages, not decimal fractions:

`fee = notional × feePct ÷ 100`

The same rate is applied to both the entry and exit legs, and the simulation does not distinguish maker from taker. Slippage remains a separate cost assumption and spread remains an execution-quality gate.

### Why the old 0.00555 assumption was retired

Until 2026-11-18 the active config used `feePct: 0.00555` under `feeModel: "assumption"`. INDODAX's 29 September 2026 announcement describes 0.00555% as the CFX component of IDR-market transactions, not the complete all-in taker charge. The live catalog reports `trade_fee_percent_taker = 0.2` for every IDR pair, so the assumption under-charged each side by roughly 36×.

That mismatch was not theoretical. Between 2026-11-17 and 2026-11-18, nine paper trades were booked at 0.00555%/side instead of 0.2%/side, leaving Rp86,659 of fees unbooked and overstating realised P/L. Because the net reward/risk entry gate reads the same `feePct`, nine of fifteen trades that the gate should have rejected were opened. The default in `DEFAULT_PARAMS` was also fail-open: an invalid stored config caused `mergeParams` to reset to the cheap assumption, silently restoring the undercharge.

Past paper orders and realised P/L are not recalculated when this configuration changes. The corrected rate applies prospectively to future paper orders and strategy evaluations that load the active configuration.

### Per-pair taker fee model (`feeModel`)

INDODAX publishes each pair's real taker fee as `trade_fee_percent_taker` in `/api/pairs`. For every IDR pair the live catalog currently reports `0.2`, i.e. **0.2% per side**, which is ~36× the `0.00555` assumption for a round trip. Under the assumption the net reward/risk gate can therefore approve entries that are economically negative once the real fee is charged.

`strategy_configs.params.feeModel` selects how the per-side fee is derived:

- `pair_taker` (default): each pair is charged its own `market_pairs.trade_fee_percent_taker`, and a genuine `0` fee is honoured. On the **entry** side a missing or invalid catalog value rejects the trade with `missing_pair_fee` (`entryFeePct`) rather than falling back, so the economics gate can never be fed a cheap fee. On the **exit** side it falls back to `feePct` (`effectiveFeePct`) so a close can never be blocked.
- `assumption`: every pair uses `feePct`. Retained for explicit sensitivity analysis only.

The model is applied consistently to position sizing, the economics gate, the exit fee, the kill switch, and the backtest. Per-pair taker fees are also returned by `begin_run` so the pipeline does not need a second query. Switching `feeModel` to `pair_taker` only affects future paper orders and evaluations; it does not rewrite past results.

To compare the retired assumption against the live taker fee, run the read-only report `npm run fee:sensitivity` (requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`). It replays stored candles under both models and prints the P&L difference without modifying the active config or placing any order.

## PostHog instrumentation

The Worker emits a small number of server-side events to PostHog:

- `trading_pipeline_run`: run duration, status, signal count, opened entries, rejection count, and error count.
- `trading_signal_generated`: pair, side, strength, and signal ID.
- `paper_entry_rejected`: pair, signal ID, execution stage, rejection reason, and numeric gate diagnostics such as spread, drift, fee, slippage, and net reward/risk.
- `paper_position_opened`: pair, signal ID, simulated position ID, fill, notional, and fee.
- `trading_pipeline_step_error`: pipeline step that failed, without sending raw error messages.

Events use a fixed service identity and disable person-profile creation. No account login, email, API key, balance snapshot, or user identity is sent. Supabase remains the canonical store for market data, signals, paper orders, and execution logs. PostHog is an additional diagnostic/analytics surface; a missing token or PostHog outage must never block the trading pipeline.

Set the Worker secret `POSTHOG_PROJECT_TOKEN` and the public host `POSTHOG_HOST=https://us.i.posthog.com`. If the token is absent, telemetry stays disabled.
