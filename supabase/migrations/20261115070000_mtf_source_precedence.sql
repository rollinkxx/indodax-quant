-- INDODAX QUANT: enforce a single candle-source precedence for both 5m and HTF writes.
-- Observed trades > official OHLC history > synthetic gap-fill.
-- Same-source refreshes are accepted only when trade_count is not lower.
-- Rewrites the existing RPC definitions without changing their signatures or privileges.

do $$
declare
  v_sig regprocedure;
  v_definition text;
  v_pattern constant text := $pattern$
where not candles\.is_closed[[:space:]]+
  or \(candles\.source <> 'trades' and excluded\.source = 'trades'\)[[:space:]]+
  or \(candles\.source = excluded\.source and excluded\.trade_count >= candles\.trade_count\);
$pattern$;
  v_replacement constant text := $replacement$
where not candles.is_closed
   or (
     case excluded.source
       when 'trades' then 3
       when 'history' then 2
       when 'synthetic' then 1
       else 0
     end
     >
     case candles.source
       when 'trades' then 3
       when 'history' then 2
       when 'synthetic' then 1
       else 0
     end
   )
   or (
     candles.source = excluded.source
     and excluded.trade_count >= candles.trade_count
   );
$replacement$;
begin
  foreach v_sig in array array[
    'public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure,
    'public.save_analysis(jsonb,jsonb,jsonb)'::regprocedure
  ] loop
    v_definition := pg_get_functiondef(v_sig);
    if v_definition !~ v_pattern then
      raise exception 'Expected candle source precedence predicate not found in %', v_sig;
    end if;
    v_definition := regexp_replace(v_definition, v_pattern, v_replacement, 'g');
    execute v_definition;
  end loop;
end
$$;
