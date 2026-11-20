-- The live engine attributes an exit to TRAILING_STOP when the trailing stop ratcheted the stop
-- above entry (shared/paper.ts exitReason). paper_close_position writes that reason straight into
-- paper_orders.reason, but the check constraint from 20261113150000_strategy_hardening never
-- included it, so every trailing-stop exit raised a constraint violation. PostgREST surfaces that
-- as HTTP 400, db.rpc throws HttpError, and the exit loop has no local try/catch: one ratcheted
-- position aborted the whole per-minute run before mark-to-market, entries and notifications.
--
-- Only the allowed value set is widened; no existing row is touched and the constraint keeps
-- rejecting anything the engine cannot emit.
alter table public.paper_orders drop constraint if exists paper_orders_reason_check;
alter table public.paper_orders add constraint paper_orders_reason_check
  check (reason in (
    'SIGNAL', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP',
    'MANUAL', 'KILL_SWITCH', 'MAX_DRAWDOWN', 'TIME_STOP', 'DAILY_LOSS'
  ));
