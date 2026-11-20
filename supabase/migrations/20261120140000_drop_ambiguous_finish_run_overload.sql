-- Drop the pre-fencing 4-argument finish_run.
--
-- 20261120090000_pipeline_lease_fencing added finish_run(bigint,text,jsonb,text,bigint) with both
-- p_error and p_fence_token defaulted, but left finish_run(bigint,text,jsonb,text) in place. Because
-- the 4-argument call then matches the old function exactly and the new one through two defaults,
-- PostgreSQL cannot choose and rejects it:
--
--   ERROR: function public.finish_run(bigint, unknown, jsonb, unknown) is not unique
--
-- Every 4-argument caller breaks, including the watchdog finalizer path exercised by
-- tests/sql/run_watchdog_test.sql. The Worker always passes p_fence_token, so only the stale overload
-- is removed here; the 5-argument version keeps its defaults and stays callable with 4 arguments.

drop function if exists public.finish_run(bigint, text, jsonb, text);
