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
