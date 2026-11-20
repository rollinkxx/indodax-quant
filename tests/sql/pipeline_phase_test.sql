-- FIX-07: begin_run decides and reports the run phase, so signals are evaluated once per 5m bucket
-- while every cron tick still marks to market.
--
-- Proves: the first run of an hour is a signal phase, the next minute is a mark phase, a new hour is
-- due again, and the phase is persisted on the execution_logs row.
\set ON_ERROR_STOP on

-- Transactional: begin_run inserts into execution_logs (unique scheduled_time), so a committed test
-- would make the next run of this file fail on the insert instead of on the behaviour under test.
begin;

insert into public.strategy_configs (name, params, is_active)
values ('default', '{}'::jsonb, true) on conflict do nothing;
insert into public.paper_accounts (name) values ('default') on conflict do nothing;

do $$
declare
  r jsonb;
  r2 jsonb;
  r3 jsonb;
  v_phase text;
begin
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';

  r := public.begin_run('2026-11-20 10:00:00+00', 'cron', 45);
  assert (r->>'ok')::boolean, 'the first run must acquire the lease';
  assert (r->>'signals_due')::boolean, 'the first run of an hour must evaluate signals';
  assert (r->>'phase') = 'signal', 'the first run of an hour must be a signal phase';
  perform public.finish_run((r->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r->>'fence_token')::bigint);
  select phase into strict v_phase from public.execution_logs where id = (r->>'run_id')::bigint;
  assert v_phase = 'signal', 'the phase must be persisted on the run row';

  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r2 := public.begin_run('2026-11-20 10:01:00+00', 'cron', 45);
  assert not (r2->>'signals_due')::boolean, 'a signal run already completed this hour';
  assert (r2->>'phase') = 'mark', 'a following minute must be a mark phase';
  perform public.finish_run((r2->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r2->>'fence_token')::bigint);

  -- A failed signal run must not consume the hour: the next tick retries the evaluation.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:02:00+00', 'cron', 45);
  assert (r3->>'phase') = 'mark', 'still the same hour, still a mark phase';
  perform public.finish_run((r3->>'run_id')::bigint, 'FAILED', '{}'::jsonb, 'boom', (r3->>'fence_token')::bigint);

  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:03:00+00', 'cron', 45);
  assert (r3->>'phase') = 'mark', 'a failed mark run does not create a signal run';
  perform public.finish_run((r3->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r3->>'fence_token')::bigint);

  -- New hour: due again.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 11:00:00+00', 'cron', 45);
  assert (r3->>'signals_due')::boolean, 'a new hour must evaluate signals again';
  assert (r3->>'phase') = 'signal', 'a new hour records a signal phase';

  raise notice 'PASS fix07: signal phase once per hour, mark phase on the ticks between';
end $$;

rollback;
