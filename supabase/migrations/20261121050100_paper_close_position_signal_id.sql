-- Record the SELL signal that triggered a signal exit on the resulting order.
--
-- All 16 SELL orders stored signal_id NULL (BUY: 16/16 filled), so the quality of an exit signal
-- could not be measured at all. `paper_close_position` now takes the id and writes it through; every
-- other exit reason (STOP_LOSS, TAKE_PROFIT, TRAILING_STOP, TIME_STOP, MAX_DRAWDOWN, DAILY_LOSS)
-- passes NULL because no signal caused it.
--
-- EXPAND step only: the new argument is optional, so the currently deployed Worker — which sends six
-- arguments — still resolves this function. The old six-argument signature is dropped in the same
-- transaction to avoid an ambiguous overload. Behaviour is unchanged: this is bookkeeping only, and
-- an unknown id is stored as NULL so a bad signal id can never fail an exit.
--
-- Rollback: supabase/migrations/rollback/20261121050100_paper_close_position_signal_id.rollback.sql

drop function if exists public.paper_close_position(bigint, numeric, numeric, numeric, numeric, text);

create or replace function public.paper_close_position(
  p_position_id bigint,
  p_requested_price numeric,
  p_fill_price numeric,
  p_fee numeric,
  p_slippage_bps numeric,
  p_reason text,
  p_signal_id bigint default null
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_pos paper_positions;
  v_notional numeric;
  v_proceeds numeric;
  v_pnl numeric;
  v_order_id bigint;
begin
  if p_fill_price <= 0 or p_fee < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_order');
  end if;

  select * into v_pos from paper_positions where id = p_position_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'position_not_found'); end if;
  if v_pos.status <> 'OPEN' then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;

  perform 1 from paper_accounts where id = v_pos.account_id for update;

  v_notional := round(v_pos.qty * p_fill_price, 8);
  v_proceeds := v_notional - p_fee;
  v_pnl := v_proceeds - v_pos.cost_basis;

  insert into paper_orders (account_id, position_id, pair_id, side, reason, requested_price, fill_price, qty, notional, fee,
                            slippage_bps, realized_pnl, idempotency_key, signal_id)
  values (v_pos.account_id, v_pos.id, v_pos.pair_id, 'SELL', p_reason, p_requested_price, p_fill_price, v_pos.qty, v_notional,
          p_fee, p_slippage_bps, v_pnl, 'close:' || v_pos.id,
          -- Bookkeeping must never block an exit: signal_id is a foreign key, so an id the Worker no
          -- longer recognises (or never had) is stored as NULL instead of failing the close.
          (select ts.id from trading_signals ts where ts.id = p_signal_id))
  returning id into v_order_id;

  update paper_positions
     set status = 'CLOSED', exit_price = p_fill_price, exit_fee = p_fee, realized_pnl = v_pnl,
         exit_reason = p_reason, closed_at = now(), last_price = p_fill_price, unrealized_pnl = 0
   where id = v_pos.id;

  update paper_accounts
     set cash_balance = cash_balance + v_proceeds,
         realized_pnl = realized_pnl + v_pnl,
         total_fees = total_fees + p_fee,
         updated_at = now()
   where id = v_pos.account_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'position_id', v_pos.id, 'pair_id', v_pos.pair_id,
                            'proceeds', v_proceeds, 'realized_pnl', v_pnl);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'duplicate');
end;
$$;

revoke all on function public.paper_close_position(bigint, numeric, numeric, numeric, numeric, text, bigint)
  from public, anon, authenticated;
grant execute on function public.paper_close_position(bigint, numeric, numeric, numeric, numeric, text, bigint)
  to service_role;
