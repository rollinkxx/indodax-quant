-- INDODAX QUANT: enforce a single candle-source precedence for both 5m and HTF writes.
-- Observed trades > official OHLC history > synthetic gap-fill.
-- Same-source refreshes are accepted only when trade_count is not lower.
-- Rewrites the existing RPC definitions without changing their signatures or privileges.

do $$
declare
  v_sig regprocedure;
  v_definition text;
  v_old_predicate constant text := $old$
where not candles.is_closed
     or (candles.source <> 'trades' and excluded.source = 'trades')
     or (candles.source = excluded.source and excluded.trade_count >= candles.trade_count);
$old$;
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
    if position(v_old_predicate in v_definition) = 0 then
      raise exception 'Expected candle source precedence predicate not found in %', v_sig;
    end if;
    v_definition := replace(v_definition, v_old_predicate, v_replacement);
    execute v_definition;
  end loop;
end
$$;
