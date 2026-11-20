-- VERIFY-03: paper_mark_to_market must be idempotent.
--
-- The RPC is called once per open position per run (and would be called even more often if the cron
-- cadence ever changes). Marking twice at the same price must not move equity, peak_equity,
-- max_drawdown_pct, last_price or unrealized_pnl.
\set ON_ERROR_STOP on

begin;

insert into public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency)
values ('btcidr', 'BTCIDR', 'btc_idr', 'btc', 'idr') on conflict do nothing;
insert into public.paper_accounts (name) values ('verify03') on conflict (name) do nothing;

insert into public.paper_positions (account_id, pair_id, status, qty, entry_price, entry_fee, cost_basis)
select id, 'btcidr', 'OPEN', 10, 100, 2, 1002 from public.paper_accounts where name = 'verify03';

do $$
declare
  v_account bigint;
  v_position bigint;
  eq1 numeric; peak1 numeric; dd1 numeric; lp1 numeric; up1 numeric;
  eq2 numeric; peak2 numeric; dd2 numeric; lp2 numeric; up2 numeric;
begin
  select id into v_account from public.paper_accounts where name = 'verify03';
  select id into v_position from public.paper_positions where account_id = v_account;

  perform public.paper_mark_to_market(v_account, '{"btcidr": 120}'::jsonb, now());
  select equity, peak_equity, max_drawdown_pct into eq1, peak1, dd1 from public.paper_accounts where id = v_account;
  select last_price, unrealized_pnl into lp1, up1 from public.paper_positions where id = v_position;

  perform public.paper_mark_to_market(v_account, '{"btcidr": 120}'::jsonb, now());
  select equity, peak_equity, max_drawdown_pct into eq2, peak2, dd2 from public.paper_accounts where id = v_account;
  select last_price, unrealized_pnl into lp2, up2 from public.paper_positions where id = v_position;

  assert eq1 = eq2, format('equity drifted on a repeated mark: %s -> %s', eq1, eq2);
  assert peak1 = peak2, format('peak_equity drifted on a repeated mark: %s -> %s', peak1, peak2);
  assert dd1 = dd2, format('max_drawdown_pct drifted on a repeated mark: %s -> %s', dd1, dd2);
  assert lp1 = lp2, format('last_price drifted on a repeated mark: %s -> %s', lp1, lp2);
  assert up1 = up2, format('unrealized_pnl drifted on a repeated mark: %s -> %s', up1, up2);

  raise notice 'PASS verify03: paper_mark_to_market is idempotent (equity=%, peak=%, up=%)', eq1, peak1, up1;
end $$;

rollback;
