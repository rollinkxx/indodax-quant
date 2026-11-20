-- A pair with no stored bars must return [] rather than null.
--
-- jsonb_agg over an empty set is NULL, so `get_recent_candles` emitted {"arbidr": null} for a pair
-- that had just joined the universe with no candles yet. Callers map over the rows to build the
-- recovery cursor, so `Object.entries(r).map(([, rows]) => rows.length)` threw
-- "Cannot read properties of null (reading 'length')", the whole load_coverage_state step failed,
-- and the run fell back to a stale covered_until. That made every pair scan a full 24h bootstrap
-- window, which burned the Worker's subrequest budget and stalled the pipeline from 03:25 on
-- 2026-11-20 until the cron runs were killed by the lease watchdog.
--
-- coalesce(..., '[]') keeps the contract "every requested pair maps to an array", including the
-- empty one, so a newly admitted pair is simply unwarmed instead of fatal.

create or replace function public.get_recent_candles(
  p_pairs text[], p_timeframe text, p_limit integer default 200
) returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_object_agg(p.pair_id, coalesce(c.rows, '[]'::jsonb)), '{}'::jsonb)
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
