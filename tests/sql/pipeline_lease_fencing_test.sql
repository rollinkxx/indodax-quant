-- Pipeline lease fencing regression test. Runs against the clean migration replay database.
-- Proves: begin_run issues a monotonically increasing fence token, renewal requires the current
-- token, and finish_run only releases the lease for the owner that still holds it.
\set ON_ERROR_STOP on

insert into strategy_configs (name, params, is_active) values ('default', '{}'::jsonb, true) on conflict do nothing;
insert into paper_accounts (name) values ('default') on conflict do nothing;
insert into system_locks (name, owner, locked_until) values ('pipeline', null, '1970-01-01')
  on conflict (name) do update set locked_until = '1970-01-01';

do $$
declare
  r jsonb;
  tok bigint;
  rid bigint;
  next_tok bigint;
begin
  r := public.begin_run('2026-11-20 09:00:00+00', 'manual', 55);
  assert (r->>'ok')::boolean, 'begin_run should acquire an expired lease';
  tok := (r->>'fence_token')::bigint;
  rid := (r->>'run_id')::bigint;

  r := public.begin_run('2026-11-20 09:00:00+00', 'manual', 55);
  assert (r->>'reason') = 'duplicate_tick', 'a repeated scheduled time must be a duplicate tick';

  r := public.renew_pipeline_lease(rid, tok, 55);
  assert (r->>'ok')::boolean, 'renewal with the correct token should succeed';

  r := public.renew_pipeline_lease(rid, tok + 999, 55);
  assert not (r->>'ok')::boolean, 'renewal with a stale token must fail';
  assert (r->>'reason') = 'lease_not_held', 'expected lease_not_held';

  perform public.finish_run(rid, 'SUCCESS', '{}'::jsonb, null, tok + 999);
  assert (select locked_until > now() from system_locks where name = 'pipeline'),
    'a stale owner must not release the lease';

  perform public.finish_run(rid, 'SUCCESS', '{}'::jsonb, null, tok);
  assert (select locked_until < now() from system_locks where name = 'pipeline'),
    'the lease owner must release the lease';

  r := public.begin_run('2026-11-20 09:01:00+00', 'manual', 55);
  next_tok := (r->>'fence_token')::bigint;
  assert next_tok > tok, 'the fence token must increase monotonically';

  perform public.finish_run((r->>'run_id')::bigint, 'SUCCESS', '{}'::jsonb, null, next_tok);
end $$;

select 'pipeline lease fencing ok' as result;
