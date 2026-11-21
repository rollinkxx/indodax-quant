-- Carry INDODAX's maker fee and the Indonesian sell-side tax in the pair catalog.
--
-- /api/pairs has always published `trade_fee_percent_maker` (0.1% for all 438 IDR pairs on
-- 2026-11-21, against 0.2% taker), but `market_pairs` only stored the taker fee, so every cost model
-- in the engine assumed taker-only execution. A maker round trip is 0.1 + 0.1 + 0.21 (PPh on the
-- sale, PMK 50/2025, charged to makers as well as takers) = 0.41%, not 0.20%.
--
-- Additive and behaviour-free: two nullable columns, a pair upsert that carries them, and one extra
-- key in begin_run's `pairs` payload. Nothing reads the new columns unless a config sets
-- feeModel='pair_maker'; the default stays 'pair_taker'.
--
-- /api/pairs publishes no tax field (verified against all 450 pairs), so `tax_percent_sell` stays
-- NULL from the pipeline. It exists so the catalog can describe the real cost; the runtime tax comes
-- from `strategy_configs.params.sellTaxPct`.
--
-- Rollback: supabase/migrations/rollback/20261121190000_market_pairs_maker_fee_and_sell_tax.rollback.sql

alter table public.market_pairs
  add column if not exists trade_fee_percent_maker numeric,
  add column if not exists tax_percent_sell numeric;

-- ingest_market is patched in place rather than re-emitted: a copy of its 150-line body would drift
-- from the candle-source precedence fix applied by 20261115070000. Every substitution is asserted,
-- so a future rewrite of the function fails this migration instead of silently dropping the columns.
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
    'trade_fee_percent_taker, is_maintenance, updated_at)',
    'x.trade_fee_percent_taker, coalesce(x.is_maintenance, false), now()',
    'trade_fee_percent_taker numeric, is_maintenance boolean)',
    'trade_fee_percent_taker = excluded.trade_fee_percent_taker, is_maintenance = excluded.is_maintenance,'
  ];
  v_new := array[
    'trade_fee_percent_taker, trade_fee_percent_maker, tax_percent_sell, is_maintenance, updated_at)',
    'x.trade_fee_percent_taker, x.trade_fee_percent_maker, x.tax_percent_sell, coalesce(x.is_maintenance, false), now()',
    'trade_fee_percent_taker numeric, trade_fee_percent_maker numeric, tax_percent_sell numeric, is_maintenance boolean)',
    -- coalesce: a payload without the field (or a hand-set tax) must not be wiped by the hourly refresh
    'trade_fee_percent_taker = excluded.trade_fee_percent_taker, trade_fee_percent_maker = coalesce(excluded.trade_fee_percent_maker, market_pairs.trade_fee_percent_maker), tax_percent_sell = coalesce(excluded.tax_percent_sell, market_pairs.tax_percent_sell), is_maintenance = excluded.is_maintenance,'
  ];

  for i in 1 .. array_length(v_old, 1) loop
    if strpos(v_updated, v_old[i]) = 0 then
      raise exception 'ingest_market: expected pattern % not found', v_old[i];
    end if;
    v_updated := replace(v_updated, v_old[i], v_new[i]);
  end loop;

  execute v_updated;
end;
$$;

-- The Worker reads the maker fee from begin_run's `pairs` payload (one subrequest per run is the
-- budget); without this key a 'pair_maker' config would reject every entry as missing_pair_fee.
do $$
declare
  v_definition text;
  v_updated text;
begin
  v_definition := pg_get_functiondef('public.begin_run(timestamptz,text,integer)'::regprocedure);
  v_updated := replace(
    v_definition,
    '''trade_fee_percent_taker'', p.trade_fee_percent_taker,',
    '''trade_fee_percent_taker'', p.trade_fee_percent_taker, ''trade_fee_percent_maker'', p.trade_fee_percent_maker,'
  );
  if v_updated = v_definition then
    raise exception 'begin_run: pairs payload does not expose trade_fee_percent_taker';
  end if;
  execute v_updated;
end;
$$;
