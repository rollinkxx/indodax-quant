-- VERIFY-02: a pair that leaves the universe must keep being managed while a position is open.
--
-- selectUniverse decides which pairs are eligible for NEW entries. It must not decide which pairs get
-- marked to market and can be closed: a position on a pair that dropped out of the universe (volume
-- fell, spread widened, maintenance) would otherwise be orphaned - never marked, never stopped out.
-- begin_run is what defines the run scope, so the guarantee lives here.
\set ON_ERROR_STOP on

begin;

insert into public.market_pairs (id, symbol, ticker_id, base_currency, traded_currency, is_tracked, in_universe)
values ('goneidr', 'GONEIDR', 'gone_idr', 'gone', 'idr', false, false)
on conflict (id) do update set is_tracked = false, in_universe = false;
insert into public.paper_accounts (name) values ('default') on conflict do nothing;

insert into public.paper_positions (account_id, pair_id, status, qty, entry_price, entry_fee, cost_basis)
select id, 'goneidr', 'OPEN', 1, 1000, 2, 1002 from public.paper_accounts where name = 'default';

do $$
declare
  r jsonb;
  v_ids text[];
begin
  -- Independent of any other test's rows: begin_run keys execution_logs by scheduled_time, so a
  -- collision would silently return ok=false and an empty pair list.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r := public.begin_run('2026-11-20 04:20:00+00', 'manual', 45);
  assert (r->>'ok')::boolean, 'begin_run must acquire the lease for this test';

  select array_agg(x->>'id') into v_ids from jsonb_array_elements(r->'pairs') x;

  assert 'goneidr' = any(v_ids),
    'a pair with an OPEN position must stay in the run scope after leaving the universe';
  assert not exists (
    select 1 from jsonb_array_elements(r->'pairs') x
     where x->>'id' = 'goneidr' and (x->>'in_universe')::boolean
  ), 'the pair must not be re-admitted to the entry universe';

  raise notice 'PASS verify02: removed pair with an OPEN position is still managed';
end $$;

rollback;
