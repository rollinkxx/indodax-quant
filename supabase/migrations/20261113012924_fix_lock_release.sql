-- Release the pipeline lock strictly in the past so the next run can always acquire it.
create or replace function public.finish_run(
  p_run_id bigint, p_status text, p_steps jsonb, p_error text default null
) returns void
language plpgsql
set search_path = public
as $$
begin
  update execution_logs
     set status = p_status,
         steps = coalesce(p_steps, '{}'::jsonb),
         error = p_error,
         finished_at = now(),
         duration_ms = (extract(epoch from now() - started_at) * 1000)::int
   where id = p_run_id;
  update system_locks set locked_until = now() - interval '1 second', owner = null
   where name = 'pipeline' and owner = p_run_id::text;
end;
$$;
revoke all on function public.finish_run(bigint,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.finish_run(bigint,text,jsonb,text) to service_role;
