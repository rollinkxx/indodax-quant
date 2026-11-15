-- INDODAX QUANT: enforce a single candle-source precedence for both 5m and HTF writes.
-- Observed trades > official OHLC history > synthetic gap-fill.
-- Same-source refreshes are accepted only when trade_count is not lower.
-- Rewrites the existing RPC definitions without changing their signatures or privileges.

do $$
declare
  v_sig regprocedure;
  v_definition text;
  v_updated text;
  -- Match only the old source-rank comparison, allowing PostgreSQL to normalize whitespace.
  v_pattern constant text := $pattern$candles[.]source[[:space:]]*<>[[:space:]]*'trades'[[:space:]]+and[[:space:]]+excluded[.]source[[:space:]]*=[[:space:]]*'trades'$pattern$;
  v_new_condition constant text := $replacement$
case excluded.source
  when 'trades' then 3
  when 'history' then 2
  when 'synthetic' then 1
  else 0
end > case candles.source
  when 'trades' then 3
  when 'history' then 2
  when 'synthetic' then 1
  else 0
end
$replacement$;
begin
  foreach v_sig in array array[
    'public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
    'public.save_analysis(jsonb,jsonb,jsonb)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_sig);
    v_updated := regexp_replace(v_definition, v_pattern, v_new_condition, 'gi');
    if v_updated = v_definition then
      raise exception 'Expected candle source precedence condition not found in %', v_sig;
    end if;
    execute v_updated;
  end loop;
end
$$;
