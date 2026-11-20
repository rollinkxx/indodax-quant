-- Universe membership interval regression test. Runs against the clean migration replay database.
-- Proves: set_universe records membership as an interval, a removed pair's interval is closed at the
-- change time rather than deleted, and a point-in-time lookup returns exactly one member row per pair.
\set ON_ERROR_STOP on

do $$
declare
  v_from timestamptz;
  v_open int;
begin
  delete from public.market_universe_history;

  perform public.set_universe('[{"id":"btcidr","rank":1},{"id":"ethidr","rank":2}]'::jsonb);
  select min(effective_from) into v_from from public.market_universe_history where source = 'universe';

  perform public.set_universe('[{"id":"ethidr","rank":1},{"id":"xrpidr","rank":2}]'::jsonb);

  -- btcidr left: its interval is closed, not deleted, so history before v_from still resolves.
  assert (select count(*) from public.market_universe_history where pair_id = 'btcidr' and source = 'universe') = 1,
    'a removed pair must keep its historical interval';
  assert (select effective_to is not null from public.market_universe_history where pair_id = 'btcidr' and source = 'universe'),
    'a removed pair interval must be closed';

  -- Membership at the instant before the change must still include btcidr.
  select count(*) into v_open from public.market_universe_history
   where source = 'universe' and effective_from <= v_from and (effective_to is null or effective_to > v_from);
  assert v_open = 2, 'membership at the first capture must be the original two pairs';

  -- At "now" the members are ethidr and xrpidr, and each pair has exactly one open interval.
  select count(*) into v_open from public.market_universe_history
   where source = 'universe' and effective_to is null;
  assert v_open = 2, 'exactly the current members must have an open interval';

  assert (select count(*) from (
            select pair_id from public.market_universe_history
             where source = 'universe' and effective_from <= now() and (effective_to is null or effective_to > now())
             group by pair_id having count(*) > 1) d) = 0,
    'a pair must never be a member through two overlapping intervals';
end $$;

select 'universe history ok' as result;
