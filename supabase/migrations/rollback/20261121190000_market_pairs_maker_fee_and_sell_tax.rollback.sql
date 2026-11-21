-- Rollback for 20261121190000_market_pairs_maker_fee_and_sell_tax.
--
-- Restores the pre-change ingest_market / begin_run bodies, then drops the two nullable columns.
-- Safe because nothing but a feeModel='pair_maker' config reads them, and no row is rewritten.

do $$
declare
  v_definition text;
  v_updated text;
  v_old text[];
  v_new text[];
begin
  v_definition := pg_get_functiondef('public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure);
  v_updated := v_definition;

  v_old := array[
    'trade_fee_percent_taker, trade_fee_percent_maker, tax_percent_sell, is_maintenance, updated_at)',
    'x.trade_fee_percent_taker, x.trade_fee_percent_maker, x.tax_percent_sell, coalesce(x.is_maintenance, false), now()',
    'trade_fee_percent_taker numeric, trade_fee_percent_maker numeric, tax_percent_sell numeric, is_maintenance boolean)',
    'trade_fee_percent_taker = excluded.trade_fee_percent_taker, trade_fee_percent_maker = coalesce(excluded.trade_fee_percent_maker, market_pairs.trade_fee_percent_maker), tax_percent_sell = coalesce(excluded.tax_percent_sell, market_pairs.tax_percent_sell), is_maintenance = excluded.is_maintenance,'
  ];
  v_new := array[
    'trade_fee_percent_taker, is_maintenance, updated_at)',
    'x.trade_fee_percent_taker, coalesce(x.is_maintenance, false), now()',
    'trade_fee_percent_taker numeric, is_maintenance boolean)',
    'trade_fee_percent_taker = excluded.trade_fee_percent_taker, is_maintenance = excluded.is_maintenance,'
  ];

  for i in 1 .. array_length(v_old, 1) loop
    if strpos(v_updated, v_old[i]) = 0 then
      raise exception 'ingest_market rollback: expected pattern % not found', v_old[i];
    end if;
    v_updated := replace(v_updated, v_old[i], v_new[i]);
  end loop;

  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.begin_run(timestamptz,text,integer)'::regprocedure);
  v_updated := replace(
    v_definition,
    '''trade_fee_percent_taker'', p.trade_fee_percent_taker, ''trade_fee_percent_maker'', p.trade_fee_percent_maker,',
    '''trade_fee_percent_taker'', p.trade_fee_percent_taker,'
  );
  if v_updated = v_definition then
    raise exception 'begin_run rollback: pairs payload does not expose trade_fee_percent_maker';
  end if;
  execute v_updated;
end;
$$;

alter table public.market_pairs
  drop column if exists trade_fee_percent_maker,
  drop column if exists tax_percent_sell;
