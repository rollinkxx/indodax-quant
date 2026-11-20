-- FIX-05: the trading day is a WIB (Asia/Jakarta) day, not a UTC day.
--
-- Proves the boundary used by every paper_* RPC (and begin_run's day_start_equity) splits 23:30 WIB
-- from 00:30 WIB into different days, while a UTC boundary would merge them - which would cut the
-- Indonesian morning session in half at 07:00 WIB.
\set ON_ERROR_STOP on

do $$
declare
  t_late timestamptz := '2026-11-20 23:30:00+07';
  t_early timestamptz := '2026-11-21 00:30:00+07';
  d_late timestamptz;
  d_early timestamptz;
  u_late timestamptz;
  u_early timestamptz;
begin
  d_late := (date_trunc('day', t_late at time zone 'Asia/Jakarta')) at time zone 'Asia/Jakarta';
  d_early := (date_trunc('day', t_early at time zone 'Asia/Jakarta')) at time zone 'Asia/Jakarta';
  assert d_late <> d_early, 'WIB: 23:30 and 00:30 must fall on different days';

  -- The same two instants are 16:30 and 17:30 UTC, i.e. one UTC day. This is the bug we are avoiding.
  u_late := date_trunc('day', t_late at time zone 'UTC');
  u_early := date_trunc('day', t_early at time zone 'UTC');
  assert u_late = u_early, 'sanity: a UTC boundary would merge them';

  -- begin_run is the only place that defines a trading day (day_start_equity is the first snapshot
  -- at or after v_day_start). The paper_* RPCs take a timestamp and never derive a day themselves, so
  -- they inherit this boundary. Guard both facts.
  assert (
    select pg_get_functiondef(p.oid) like '%Asia/Jakarta%'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'begin_run'
  ), 'begin_run must define the trading day in Asia/Jakarta';

  assert (
    select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('begin_run', 'paper_mark_to_market', 'paper_open_position', 'paper_close_position')
      and pg_get_functiondef(p.oid) ~ 'date_trunc\(.day.,[^)]*time zone .UTC.'
  ) = 0, 'no paper function may derive a trading day from a UTC boundary';

  raise notice 'PASS fix05: the trading day is a WIB day (% vs %)', d_late, d_early;
end $$;
