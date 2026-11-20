-- Retry queue for BUY signals that a transient gate rejected (spread, price drift, stale ticker,
-- sizing, lease loss). SELL already had this net (get_pending_sell_signals); BUY did not, and a
-- stored signal is only ever "new" in the run that saved it, so a rejected BUY was lost for good:
-- the BUY diagnostic reports `already_qualified` on every later candle of the same cross.
--
-- The queue is a claim, not an order: the Worker re-reads it next run, re-validates the trend setup
-- from the fresh candles and only then retries the entry. Rows expire (default 3 candles) and are
-- bounded by an attempt counter, so a pair that keeps failing cannot accumulate work.
--
-- Types mirror the referenced columns: paper_accounts.id and trading_signals.id are bigint identity
-- columns, not uuid.
create table if not exists public.pending_entries (
  id           uuid primary key default gen_random_uuid(),
  account_id   bigint not null references public.paper_accounts(id) on delete cascade,
  pair_id      text not null references public.market_pairs(id) on delete cascade,
  signal_id    bigint not null references public.trading_signals(id) on delete cascade,
  candle_time  timestamptz not null,
  expires_at   timestamptz not null,
  strength     numeric not null default 0,
  price        numeric not null default 0,
  indicators   jsonb not null default '{}'::jsonb,
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  unique (account_id, pair_id, candle_time)
);

create index if not exists pending_entries_expiry_idx
  on public.pending_entries (account_id, expires_at);

alter table public.pending_entries enable row level security;   -- no policies: service role only
revoke all on table public.pending_entries from public, anon, authenticated;
grant all on table public.pending_entries to service_role;

-- Upsert keyed on (account, pair, candle): re-rejecting the same signal refreshes its expiry and
-- bumps `attempts` instead of queueing a duplicate.
create or replace function public.upsert_pending_entries(
  p_account_id bigint,
  p_entries jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0;
begin
  insert into public.pending_entries
    (account_id, pair_id, signal_id, candle_time, expires_at, strength, price, indicators)
  select
    p_account_id,
    e->>'pair_id',
    (e->>'signal_id')::bigint,
    (e->>'candle_time')::timestamptz,
    (e->>'expires_at')::timestamptz,
    coalesce((e->>'strength')::numeric, 0),
    coalesce((e->>'price')::numeric, 0),
    coalesce(e->'indicators', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as e
  on conflict (account_id, pair_id, candle_time) do update
    set expires_at = excluded.expires_at,
        strength   = excluded.strength,
        price      = excluded.price,
        indicators = excluded.indicators,
        attempts   = public.pending_entries.attempts + 1;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Live queue for the pairs in scope. Expired rows are filtered here rather than deleted, so a run
-- that loses its lease mid-step cannot destroy another run's claims.
create or replace function public.get_pending_entries(
  p_account_id bigint,
  p_pairs text[],
  p_now timestamptz
) returns setof public.pending_entries
language sql
stable
security definer
set search_path = public
as $$
  select * from public.pending_entries
  where account_id = p_account_id
    and pair_id = any(coalesce(p_pairs, '{}'::text[]))
    and expires_at > p_now
    and attempts < 20
  order by strength desc, candle_time asc;
$$;

create or replace function public.delete_pending_entries(
  p_account_id bigint,
  p_signal_ids bigint[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0;
begin
  delete from public.pending_entries
  where account_id = p_account_id and signal_id = any(coalesce(p_signal_ids, '{}'::bigint[]));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Housekeeping for expired claims. Safe to call from any run; keeps the table bounded.
create or replace function public.prune_pending_entries() returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0;
begin
  delete from public.pending_entries where expires_at < now() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.upsert_pending_entries(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.get_pending_entries(bigint, text[], timestamptz) from public, anon, authenticated;
revoke all on function public.delete_pending_entries(bigint, bigint[]) from public, anon, authenticated;
revoke all on function public.prune_pending_entries() from public, anon, authenticated;

grant execute on function public.upsert_pending_entries(bigint, jsonb) to service_role;
grant execute on function public.get_pending_entries(bigint, text[], timestamptz) to service_role;
grant execute on function public.delete_pending_entries(bigint, bigint[]) to service_role;
grant execute on function public.prune_pending_entries() to service_role;
