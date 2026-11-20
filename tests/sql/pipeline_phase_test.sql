-- FIX-07: begin_run decides and reports the run phase, so signals are evaluated once per 5m bucket
-- while every cron tick still marks to market.
--
-- Proves: exactly one signal run per 300s bucket (the strategy's base timeframe), the four ticks
-- between are mark runs, a NEW bucket is due again, and the phase is persisted on the run row.
-- A date_trunc('hour') implementation would pass the "next minute is mark" assertion below but FAIL
-- the 12:05 assertion, which is the whole point of this test.
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
  v_minute int;
begin
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';

  r := public.begin_run('2026-11-20 10:00:00+00', 'cron', 45);
  assert (r->>'ok')::boolean, 'the first run must acquire the lease';
  assert (r->>'signals_due')::boolean, 'the first run of a bucket must evaluate signals';
  assert (r->>'phase') = 'signal', 'the first run of a bucket must be a signal phase';
  perform public.finish_run((r->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r->>'fence_token')::bigint);
  select phase into strict v_phase from public.execution_logs where id = (r->>'run_id')::bigint;
  assert v_phase = 'signal', 'the phase must be persisted on the run row';

  -- The four ticks inside the same 300s bucket are mark runs.
  for v_minute in 1..4 loop
    update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
    r2 := public.begin_run(
      ('2026-11-20 10:00:00+00'::timestamptz + make_interval(mins => v_minute)), 'cron', 45);
    assert not (r2->>'signals_due')::boolean,
      format('minute %s is still inside the 10:00 bucket', v_minute);
    assert (r2->>'phase') = 'mark',
      format('minute %s must be a mark phase', v_minute);
    perform public.finish_run((r2->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r2->>'fence_token')::bigint);
  end loop;

  -- The next 5-minute bucket must evaluate signals again. This is the assertion a per-hour
  -- implementation fails: with date_trunc('hour') 10:05 would still be a mark phase.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:05:00+00', 'cron', 45);
  assert (r3->>'signals_due')::boolean, 'a new 5m bucket must evaluate signals again';
  assert (r3->>'phase') = 'signal', 'a new 5m bucket records a signal phase';
  perform public.finish_run((r3->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r3->>'fence_token')::bigint);

  -- A failed signal run must not consume the bucket: the next tick retries the evaluation.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:10:00+00', 'cron', 45);
  assert (r3->>'phase') = 'signal', '10:10 is a new bucket and must be a signal phase';
  perform public.finish_run((r3->>'run_id')::bigint, 'FAILED', '{}'::jsonb, 'boom', (r3->>'fence_token')::bigint);

  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:11:00+00', 'cron', 45);
  assert (r3->>'phase') = 'signal',
    'a FAILED signal run must not consume the bucket, so the next tick retries it';
  perform public.finish_run((r3->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, (r3->>'fence_token')::bigint);

  -- Same bucket again is now a mark run, because the retry above succeeded.
  update public.system_locks set locked_until = '1970-01-01' where name = 'pipeline';
  r3 := public.begin_run('2026-11-20 10:12:00+00', 'cron', 45);
  assert (r3->>'phase') = 'mark', 'the retry succeeded, so 10:12 is a mark run';

  raise notice 'PASS fix07: one signal run per 5m bucket, mark runs on the ticks between';
end $$;

rollback;
