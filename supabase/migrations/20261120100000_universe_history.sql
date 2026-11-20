-- Timestamped universe membership.
--
-- Why: the backtest selected pairs with today's `in_universe` / `is_tracked` flags applied to the whole
-- history. A pair that only became liquid last week was therefore treated as tradable months earlier,
-- which inflates trade counts and mixes regimes. Membership is now recorded as an interval so a
-- historical run can ask "was this pair in the universe at time T?" instead of "is it in it now?".
--
-- Non-destructive: a new table plus a rewritten set_universe that appends intervals. The current
-- `market_pairs.in_universe` flags stay exactly as they are, so no existing reader changes behaviour.

create table if not exists public.market_universe_history (
  pair_id text not null references public.market_pairs(id) on delete cascade,
  -- First instant the pair is considered a universe member.
  effective_from timestamptz not null,
  -- First instant it stops being one. Null = still a member (open interval).
  effective_to timestamptz,
  universe_rank int,
  -- 'universe' for dynamic membership, 'pinned' for a manually tracked pair.
  source text not null default 'universe' check (source in ('universe', 'pinned')),
  -- `source` is part of the key: a pair can be pinned and dynamically ranked at the same instant,
  -- and those are two independent memberships with different lifetimes.
  primary key (pair_id, source, effective_from)
);

create index if not exists market_universe_history_lookup_idx
  on public.market_universe_history (effective_from, effective_to);

-- Membership changes are small and only matter for research, so this stays readable rather than
-- partitioned. It is append-only: an interval is closed by setting effective_to, never deleted.
comment on table public.market_universe_history is
  'Universe membership intervals. A pair is a member at time T when effective_from <= T < coalesce(effective_to, infinity).';

create or replace function public.set_universe(p_members jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_off int;
  v_on int;
  -- clock_timestamp(), not now(): now() is constant for the whole transaction, so two universe
  -- updates in one transaction would produce identical interval boundaries.
  v_now timestamptz := clock_timestamp();
begin
  -- Close the interval of every pair that is leaving the dynamic universe.
  update public.market_universe_history h
     set effective_to = v_now
   where h.effective_to is null
     and h.source = 'universe'
     and not exists (select 1 from jsonb_to_recordset(p_members) as x(id text, rank int) where x.id = h.pair_id);

  update market_pairs p
     set in_universe = false, universe_rank = null, universe_since = null
   where p.in_universe
     and not exists (select 1 from jsonb_to_recordset(p_members) as x(id text, rank int) where x.id = p.id);
  get diagnostics v_off = row_count;

  update market_pairs p
     set universe_rank = x.rank,
         universe_since = case when p.in_universe then coalesce(p.universe_since, v_now) else v_now end,
         in_universe = true
    from jsonb_to_recordset(p_members) as x(id text, rank int)
   where p.id = x.id;
  get diagnostics v_on = row_count;

  -- Open an interval for every member that does not already have one, and keep the rank current.
  insert into public.market_universe_history (pair_id, effective_from, effective_to, universe_rank, source)
  select x.id, v_now, null, x.rank, 'universe'
    from jsonb_to_recordset(p_members) as x(id text, rank int)
   where not exists (
     select 1 from public.market_universe_history h
      where h.pair_id = x.id and h.effective_to is null and h.source = 'universe'
   );

  update public.market_universe_history h
     set universe_rank = x.rank
    from jsonb_to_recordset(p_members) as x(id text, rank int)
   where h.pair_id = x.id and h.effective_to is null and h.source = 'universe';

  -- A pinned pair is a member for as long as it stays tracked; record it once when it becomes tracked.
  insert into public.market_universe_history (pair_id, effective_from, effective_to, universe_rank, source)
  select p.id, v_now, null, null, 'pinned'
    from market_pairs p
   where p.is_tracked
     and not exists (
       select 1 from public.market_universe_history h
        where h.pair_id = p.id and h.effective_to is null and h.source = 'pinned'
     )
  on conflict (pair_id, source, effective_from) do nothing;

  update public.market_universe_history h
     set effective_to = v_now
    from market_pairs p
   where p.id = h.pair_id and h.source = 'pinned' and h.effective_to is null and not p.is_tracked;

  return jsonb_build_object('removed', v_off, 'members', v_on);
end;
$$;

revoke all on function public.set_universe(jsonb) from public, anon, authenticated;
grant execute on function public.set_universe(jsonb) to service_role;

revoke all on table public.market_universe_history from public, anon, authenticated;
grant select on table public.market_universe_history to authenticated;
grant all on table public.market_universe_history to service_role;

alter table public.market_universe_history enable row level security;

drop policy if exists universe_history_read on public.market_universe_history;
create policy universe_history_read on public.market_universe_history
  for select to authenticated using (public.is_app_user());

-- Seed the open interval for whatever is a member right now, so a run started before the first
-- set_universe call still has a membership row to read.
insert into public.market_universe_history (pair_id, effective_from, effective_to, universe_rank, source)
select p.id, coalesce(p.universe_since, clock_timestamp()), null, p.universe_rank, 'universe'
  from market_pairs p
 where p.in_universe
on conflict (pair_id, source, effective_from) do nothing;

insert into public.market_universe_history (pair_id, effective_from, effective_to, universe_rank, source)
select p.id, clock_timestamp(), null, null, 'pinned'
  from market_pairs p
 where p.is_tracked
on conflict (pair_id, source, effective_from) do nothing;
