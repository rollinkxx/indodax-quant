-- Read-only helper so the Worker can re-check SELL signals that were stored in an earlier run
-- but never acted on (stale ticker, rejected close, orphaned run). Non-destructive: adds one function.
-- A SELL is pending for an OPEN position when it was stored after the position was opened.
-- Idempotency of the resulting exit is guaranteed by paper_close_position (rejects non-OPEN positions).
create or replace function public.get_pending_sell_signals(p_pairs text[])
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb)
  from (
    select distinct on (ts.pair_id)
           ts.id, ts.pair_id, ts.side, ts.price, ts.strength, ts.reasons, ts.indicators, ts.candle_time
      from public.trading_signals ts
      join public.paper_positions pp
        on pp.pair_id = ts.pair_id and pp.status = 'OPEN'
     where ts.side = 'SELL'
       and ts.pair_id = any(coalesce(p_pairs, '{}'::text[]))
       and ts.created_at > pp.opened_at
     order by ts.pair_id, ts.id desc
  ) s;
$$;

revoke all on function public.get_pending_sell_signals(text[]) from public, anon, authenticated;
grant execute on function public.get_pending_sell_signals(text[]) to service_role;
