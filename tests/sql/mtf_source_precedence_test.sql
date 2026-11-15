\set ON_ERROR_STOP on
BEGIN;

DROP FUNCTION IF EXISTS public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb);
DROP FUNCTION IF EXISTS public.save_analysis(jsonb,jsonb,jsonb);
DROP TABLE IF EXISTS public.candles;

CREATE TABLE public.candles (
  pair_id text NOT NULL,
  timeframe text NOT NULL,
  open_time timestamptz NOT NULL,
  open numeric NOT NULL,
  high numeric NOT NULL,
  low numeric NOT NULL,
  close numeric NOT NULL,
  volume numeric NOT NULL,
  trade_count integer NOT NULL,
  is_closed boolean NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, timeframe, open_time)
);

CREATE FUNCTION public.ingest_market(
  p_pairs jsonb, p_tickers_latest jsonb, p_tickers_history jsonb,
  p_trades jsonb, p_candles jsonb, p_sync jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.candles
    (pair_id,timeframe,open_time,open,high,low,close,volume,trade_count,is_closed,source,updated_at)
  SELECT x.pair_id,x.timeframe,x.open_time,x.open,x.high,x.low,x.close,x.volume,x.trade_count,x.is_closed,x.source,now()
  FROM jsonb_to_recordset(p_candles) AS x(
    pair_id text,timeframe text,open_time timestamptz,open numeric,high numeric,low numeric,
    close numeric,volume numeric,trade_count int,is_closed boolean,source text
  )
  ON CONFLICT (pair_id,timeframe,open_time) DO UPDATE SET
    open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
    volume=excluded.volume,trade_count=excluded.trade_count,is_closed=excluded.is_closed,
    source=excluded.source,updated_at=now()
  where not candles.is_closed
     or (candles.source <> 'trades' and excluded.source = 'trades')
     or (candles.source = excluded.source and excluded.trade_count >= candles.trade_count);
  RETURN '{}'::jsonb;
END;
$fn$;

CREATE FUNCTION public.save_analysis(p_indicators jsonb,p_signals jsonb,p_candles jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.candles
    (pair_id,timeframe,open_time,open,high,low,close,volume,trade_count,is_closed,source,updated_at)
  SELECT x.pair_id,x.timeframe,x.open_time,x.open,x.high,x.low,x.close,x.volume,x.trade_count,true,x.source,now()
  FROM jsonb_to_recordset(p_candles) AS x(
    pair_id text,timeframe text,open_time timestamptz,open numeric,high numeric,low numeric,
    close numeric,volume numeric,trade_count int,source text
  )
  ON CONFLICT (pair_id,timeframe,open_time) DO UPDATE SET
    open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
    volume=excluded.volume,trade_count=excluded.trade_count,is_closed=true,
    source=excluded.source,updated_at=now()
  where not candles.is_closed
     or (candles.source <> 'trades' and excluded.source = 'trades')
     or (candles.source = excluded.source and excluded.trade_count >= candles.trade_count);
  RETURN '{}'::jsonb;
END;
$fn$;

\i supabase/migrations/20261115070000_mtf_source_precedence.sql

DO $assert$
DECLARE
  v_source text;
  v_close numeric;
  v_candles jsonb;
BEGIN
  IF pg_get_functiondef('public.ingest_market(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure) NOT LIKE '%case excluded.source%' THEN
    RAISE EXCEPTION 'ingest_market source precedence was not updated';
  END IF;
  IF pg_get_functiondef('public.save_analysis(jsonb,jsonb,jsonb)'::regprocedure) NOT LIKE '%case excluded.source%' THEN
    RAISE EXCEPTION 'save_analysis source precedence was not updated';
  END IF;

  -- ingest_market: synthetic -> history -> trades; lower-ranked writes cannot downgrade it.
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','ingesttest','timeframe','1h','open_time','2026-01-01T00:00:00Z',
    'open',100,'high',101,'low',99,'close',100,'volume',1,'trade_count',0,'is_closed',true,'source','synthetic'
  ));
  PERFORM public.ingest_market('[]','[]','[]','[]',v_candles,'[]');
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','ingesttest','timeframe','1h','open_time','2026-01-01T00:00:00Z',
    'open',110,'high',111,'low',109,'close',110,'volume',1,'trade_count',0,'is_closed',true,'source','history'
  ));
  PERFORM public.ingest_market('[]','[]','[]','[]',v_candles,'[]');
  SELECT source,close INTO v_source,v_close FROM public.candles WHERE pair_id='ingesttest';
  IF v_source <> 'history' OR v_close <> 110 THEN RAISE EXCEPTION 'history did not replace synthetic in ingest_market'; END IF;

  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','ingesttest','timeframe','1h','open_time','2026-01-01T00:00:00Z',
    'open',120,'high',121,'low',119,'close',120,'volume',2,'trade_count',2,'is_closed',true,'source','trades'
  ));
  PERFORM public.ingest_market('[]','[]','[]','[]',v_candles,'[]');
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','ingesttest','timeframe','1h','open_time','2026-01-01T00:00:00Z',
    'open',130,'high',131,'low',129,'close',130,'volume',1,'trade_count',0,'is_closed',true,'source','history'
  ));
  PERFORM public.ingest_market('[]','[]','[]','[]',v_candles,'[]');
  SELECT source,close INTO v_source,v_close FROM public.candles WHERE pair_id='ingesttest';
  IF v_source <> 'trades' OR v_close <> 120 THEN RAISE EXCEPTION 'history overwrote trades in ingest_market'; END IF;

  -- save_analysis obeys the same source hierarchy.
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','savetest','timeframe','15m','open_time','2026-01-01T00:00:00Z',
    'open',100,'high',101,'low',99,'close',100,'volume',1,'trade_count',0,'source','synthetic'
  ));
  PERFORM public.save_analysis('[]','[]',v_candles);
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','savetest','timeframe','15m','open_time','2026-01-01T00:00:00Z',
    'open',110,'high',111,'low',109,'close',110,'volume',1,'trade_count',0,'source','history'
  ));
  PERFORM public.save_analysis('[]','[]',v_candles);
  SELECT source,close INTO v_source,v_close FROM public.candles WHERE pair_id='savetest';
  IF v_source <> 'history' OR v_close <> 110 THEN RAISE EXCEPTION 'history did not replace synthetic in save_analysis'; END IF;

  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','savetest','timeframe','15m','open_time','2026-01-01T00:00:00Z',
    'open',120,'high',121,'low',119,'close',120,'volume',2,'trade_count',2,'source','trades'
  ));
  PERFORM public.save_analysis('[]','[]',v_candles);
  v_candles := jsonb_build_array(jsonb_build_object(
    'pair_id','savetest','timeframe','15m','open_time','2026-01-01T00:00:00Z',
    'open',130,'high',131,'low',129,'close',130,'volume',1,'trade_count',0,'source','history'
  ));
  PERFORM public.save_analysis('[]','[]',v_candles);
  SELECT source,close INTO v_source,v_close FROM public.candles WHERE pair_id='savetest';
  IF v_source <> 'trades' OR v_close <> 120 THEN RAISE EXCEPTION 'history overwrote trades in save_analysis'; END IF;
END;
$assert$;

ROLLBACK;
