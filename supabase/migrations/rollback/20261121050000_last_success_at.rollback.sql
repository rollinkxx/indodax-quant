-- Rollback for 20261121050000_last_success_at.
--
-- The outage alarm stops working without this function (the Worker treats an unusable RPC as "no
-- alarm" and stays silent), so roll this back only together with a Worker that does not call it.

drop index if exists public.execution_logs_success_scheduled_idx;
drop function if exists public.last_success_at(bigint);
