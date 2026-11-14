-- Validate function hardening and the nested RLS path used by app_users_read.
do $assert$
declare
  v_security_definer boolean;
  v_config text;
  v_policy text;
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

  select pg_get_expr(pol.polqual, pol.polrelid)
    into v_policy
  from pg_policy pol
  join pg_class rel on rel.oid = pol.polrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'app_users'
    and pol.polname = 'app_users_self';

  if v_policy is null or position('SELECT' in upper(v_policy)) = 0
     or position('auth.jwt()' in v_policy) = 0 then
    raise exception 'app_users_self must wrap auth.jwt() in a scalar subquery: %', v_policy;
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

-- Validate all five previously missing FK leading-column indexes.
do $fk_indexes$
declare
  v_expected record;
  v_first_column text;
  v_index_count integer;
begin
  for v_expected in
    select * from (values
      ('paper_orders'::text, 'paper_orders_pair_id_idx'::text, 'pair_id'::text),
      ('paper_orders'::text, 'paper_orders_position_id_idx'::text, 'position_id'::text),
      ('paper_orders'::text, 'paper_orders_signal_id_idx'::text, 'signal_id'::text),
      ('paper_positions'::text, 'paper_positions_entry_signal_id_idx'::text, 'entry_signal_id'::text),
      ('paper_positions'::text, 'paper_positions_pair_id_idx'::text, 'pair_id'::text)
    ) as expected(table_name, index_name, first_column)
  loop
    select a.attname::text
      into v_first_column
    from pg_index ix
    join pg_class idx on idx.oid = ix.indexrelid
    join lateral unnest(ix.indkey) with ordinality key_column(attnum, ordinal) on true
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = key_column.attnum
    where ix.indrelid = format('public.%I', v_expected.table_name)::regclass
      and idx.relname = v_expected.index_name
      and key_column.ordinal = 1
      and ix.indisvalid
      and ix.indisready
      and ix.indpred is null;

    if v_first_column is distinct from v_expected.first_column then
      raise exception 'Index % on % is missing, partial, invalid, or not led by %',
        v_expected.index_name, v_expected.table_name, v_expected.first_column;
    end if;
  end loop;

  -- Existing account indexes are enough for those FKs; do not add redundant single-column variants.
  select count(*) into v_index_count
  from pg_indexes
  where schemaname = 'public'
    and indexname in ('paper_orders_account_id_idx', 'paper_positions_account_id_idx');
  if v_index_count <> 0 then
    raise exception 'Unexpected duplicate account_id index created by FK remediation';
  end if;

  if (select count(*) from public.paper_positions) <> 1
     or (select count(*) from public.paper_orders) <> 1 then
    raise exception 'FK index migration changed existing rows';
  end if;
end;
$fk_indexes$;
