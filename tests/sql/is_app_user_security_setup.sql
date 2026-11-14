-- Disposable PostgreSQL fixture that mirrors the app_users RLS dependency.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

grant usage on schema public to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to authenticated, service_role;

create function auth.jwt()
returns jsonb
language sql
stable
as $function$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$function$;
grant execute on function auth.jwt() to authenticated, service_role;

create table public.app_users (
  email text primary key
);
alter table public.app_users enable row level security;
grant select on public.app_users to authenticated, service_role;
create policy app_users_self on public.app_users
  for select to authenticated
  using (email = pg_catalog.lower(coalesce(auth.jwt() ->> 'email', '')));
insert into public.app_users(email) values ('admin@example.com');

create function public.is_app_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1
    from public.app_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$function$;
revoke all on function public.is_app_user() from public, anon;
grant execute on function public.is_app_user() to authenticated, service_role;

create table public.private_data (
  id integer primary key,
  payload text not null
);
insert into public.private_data values (1, 'visible only to registered app users');
alter table public.private_data enable row level security;
grant select on public.private_data to authenticated, service_role;
create policy app_users_read on public.private_data
  for select to authenticated
  using (public.is_app_user());

-- Minimal paper-trading relations for foreign-key index validation.
create table public.market_pairs (id text primary key);
create table public.paper_accounts (id bigint primary key);
create table public.trading_signals (id bigint primary key);

create table public.paper_positions (
  id bigint primary key,
  account_id bigint not null references public.paper_accounts(id),
  pair_id text not null references public.market_pairs(id),
  entry_signal_id bigint references public.trading_signals(id),
  status text not null default 'OPEN',
  opened_at timestamptz not null default now()
);
create index paper_positions_account_idx on public.paper_positions (account_id, opened_at desc);
create unique index paper_positions_one_open_idx
  on public.paper_positions (account_id, pair_id) where status = 'OPEN';

create table public.paper_orders (
  id bigint primary key,
  account_id bigint not null references public.paper_accounts(id),
  position_id bigint references public.paper_positions(id),
  pair_id text not null references public.market_pairs(id),
  signal_id bigint references public.trading_signals(id),
  created_at timestamptz not null default now()
);
create index paper_orders_account_idx on public.paper_orders (account_id, created_at desc);

insert into public.market_pairs(id) values ('btcidr');
insert into public.paper_accounts(id) values (1);
insert into public.trading_signals(id) values (10);
insert into public.paper_positions(id, account_id, pair_id, entry_signal_id) values (100, 1, 'btcidr', 10);
insert into public.paper_orders(id, account_id, position_id, pair_id, signal_id)
values (1000, 1, 100, 'btcidr', 10);
