-- Make get_recent_candles read only the rows it returns.
--
-- The previous body numbered every closed candle for the requested pairs with a window
-- function and then filtered to the newest N. On 2026-11-19 that meant scanning 267k 5m rows
-- to return 3,500: 2.6s of work and 27k shared buffers per call, on every cron run.
--
-- That cost crossed Supabase's statement timeout roughly once a day (runs 8671 at 05:34 and
-- 8972 at 10:35 both died with SQLSTATE 57014 "canceling statement due to statement
-- timeout"), turning the whole run PARTIAL and skipping analysis for that minute.
--
-- A per-pair LATERAL with an ORDER BY ... LIMIT walks the (pair_id, timeframe, open_time DESC)
-- index and touches only the requested bars: 108ms and 2.7k buffers for the same 14 pairs.
create or replace function public.get_recent_candles(
  p_pairs text[], p_timeframe text, p_limit integer default 200
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(p.pair_id, c.rows), '{}'::jsonb)
  from unnest(p_pairs) as p(pair_id)
  cross join lateral (
    select jsonb_agg(
             jsonb_build_array(extract(epoch from q.open_time)::bigint, q.open, q.high, q.low, q.close, q.volume, q.source)
             order by q.open_time
           ) as rows
    from (
      select open_time, open, high, low, close, volume, source
      from candles
      where pair_id = p.pair_id and timeframe = p_timeframe and is_closed
      order by open_time desc
      limit greatest(p_limit, 0)
    ) q
  ) c;
$$;

revoke all on function public.get_recent_candles(text[], text, integer) from public, anon, authenticated;
grant execute on function public.get_recent_candles(text[], text, integer) to service_role;
