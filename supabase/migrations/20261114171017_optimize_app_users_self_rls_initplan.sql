-- Evaluate the JWT claim once per statement instead of once per app_users row.
drop policy if exists app_users_self on public.app_users;

create policy app_users_self on public.app_users
  for select to authenticated
  using (
    email = pg_catalog.lower(
      coalesce((select auth.jwt() ->> 'email'), '')
    )
  );
