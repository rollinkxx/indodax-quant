# Strategy hardening (2026-11-13, after forensic audit)

Live config had drifted from the docs (universeSize 25, universeMinVolumeIdr 1e8, universeMaxNewPerUpdate 10, maxOpenPositions 10). The DB `strategy_configs` row is the source of truth; migration `20261113150000_strategy_hardening.sql` merges the values below into the active row.

| Area | Change |
|---|---|
| Entry | `crossLookback` 3 -> 2, `rsiBuyMax` 70 -> 65, new `maxEntryExtensionPct` 1.5 (skip BUY when close is >1.5% above EMA21) |
| Exit | `sellRequireConfirm=false`: any fresh EMA cross-down exits; ATR trailing stop (`trailingStopEnabled`, arms at +1.5 ATR, trails 1 ATR); time stop 720 min |
| Risk | `maxOpenPositions` 4, `maxTotalExposurePct` 60, `closeOnDailyLoss=true` (daily limit now flattens positions, reason `DAILY_LOSS`) |
| Costs | `dynamicSlippage=true`: slippage x1 / 1.5 / 2.5 / 4 by 24h IDR volume tier (>=1e10 / >=2e9 / >=5e8 / below) |
| Universe | `xautidr`, `paxgidr` excluded by default and merged into the live exclude list |
| Notifications | SELL signals go to Telegram only when a position in that pair is open (still stored in `trading_signals`) |
| Tooling | `npm run backtest` (`scripts/backtest.ts`): old rules vs live params on stored 5m candles, costs included, MTF not simulated. Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the shell |

New `paper_orders.reason` values: `TIME_STOP`, `DAILY_LOSS`. The trailing stop raises `paper_positions.stop_loss` via PostgREST PATCH (service role, worker only). Paper trading only; no INDODAX private API.
