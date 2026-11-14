-- Validate function hardening and the nested RLS path used by app_users_read.
do $assert$
declare
  v_security_definer boolean;
  v_config text;
begin
  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
    into v_security_definer, v_config
  from pg_proc p
  where p.oid = 'public.is_app_user()'::regprocedure;

  if v_security_definer then
    raise exception 'is_app_user must not be SECURITY DEFINER';
  end if;
  if position('search_path=pg_catalog, public' in v_config) = 0 then
    raise exception 'is_app_user search_path is not locked: %', v_config;
  end if;
  if has_function_privilege('anon', 'public.is_app_user()', 'EXECUTE') then
    raise exception 'anon must not execute is_app_user';
  end if;
  if not has_function_privilege('authenticated', 'public.is_app_user()', 'EXECUTE') then
    raise exception 'authenticated must retain execute';
  end if;
  if not has_function_privilege('service_role', 'public.is_app_user()', 'EXECUTE') then
    raise exception 'service_role must retain execute';
  end if;
end;
$assert$;

begin;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"admin@example.com"}';
do $authorized$
declare
  v_count integer;
begin
  if not public.is_app_user() then
    raise exception 'registered user lookup should return true';
  end if;
  select count(*) into v_count from public.private_data;
  if v_count <> 1 then
    raise exception 'registered user should see app_users_read rows; got %', v_count;
  end if;
end;
$authorized$;
rollback;

begin;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","email":"not-registered@example.com"}';
do $unauthorized$
declare
  v_count integer;
begin
  if public.is_app_user() then
    raise exception 'unregistered user lookup should return false';
  end if;
  select count(*) into v_count from public.private_data;
  if v_count <> 0 then
    raise exception 'unregistered user must not see app_users_read rows; got %', v_count;
  end if;
end;
$unauthorized$;
rollback;
