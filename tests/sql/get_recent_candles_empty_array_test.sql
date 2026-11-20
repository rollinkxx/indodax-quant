-- get_recent_candles must return [] for a pair with no stored bars, never null.
--
-- jsonb_agg over an empty set is NULL, so a pair that had just joined the universe returned
-- {"arbidr": null}. The Worker mapped rows.length over every value, threw on null, and the whole
-- load_coverage_state step failed - which is how the 2026-11-20 pipeline outage started.
\set ON_ERROR_STOP on

do $$
declare
  v jsonb;
begin
  -- A pair with bars and a pair without, in one call: both keys must be present as arrays.
  v := public.get_recent_candles(array['btcidr', 'no_such_pair'], '5m', 5);
  assert v ? 'no_such_pair', 'every requested pair must be present as a key';
  assert jsonb_typeof(v -> 'no_such_pair') = 'array',
    'a pair with no candles must map to [], not null';
  assert jsonb_array_length(v -> 'no_such_pair') = 0, 'an unwarmed pair must have zero rows';

  -- The empty-array contract holds for a single unknown pair too.
  v := public.get_recent_candles(array['no_such_pair'], '1h', 3);
  assert jsonb_typeof(v -> 'no_such_pair') = 'array', 'single unwarmed pair must be an array';

  -- No pairs at all still yields a well-formed object rather than null.
  v := public.get_recent_candles(array[]::text[], '5m', 3);
  assert v = '{}'::jsonb, 'an empty pair list must return an empty object';
end $$;
