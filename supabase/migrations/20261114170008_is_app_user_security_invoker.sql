-- Harden the app-membership helper: callers retain their own table privileges and RLS context.
create or replace function public.is_app_user()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
    from public.app_users
    where email = pg_catalog.lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$function$;

-- Keep the function callable only by application users and the backend service role.
revoke all on function public.is_app_user() from public, anon;
grant execute on function public.is_app_user() to authenticated, service_role;
