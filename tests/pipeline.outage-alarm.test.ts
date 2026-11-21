// The outage alarm has to fire while the pipeline lock is stuck.
//
// Between 2026-11-19 14:00Z and 2026-11-20 09:03Z 1.011 runs died on `stale_run_without_lease` and
// no notification was sent: every alert the Worker emits lives inside the run, and a run that cannot
// take the lock returns before the notifications step. The check therefore runs before `begin_run`.
import { describe, expect, it } from 'vitest';
import { OUTAGE_ALARM_MINUTES, outageAlarmNote, runPipeline } from '../worker/src/pipeline';
import { env } from './fakes';
import { NOW, setup } from './pipelineSetup';

const run = (o: ReturnType<typeof setup>, at = NOW) => runPipeline(env(), {
  scheduledTime: at * 1000, trigger: 'cron', fetchImpl: o.f, now: () => at * 1000,
});

const outageNotes = (o: ReturnType<typeof setup>) => o.rpcs
  .filter((x) => x.fn === 'claim_notifications')
  .flatMap((x) => x.body.p_items)
  .filter((i: any) => i.event_type === 'outage');

describe('outage alarm', () => {
  it('pages the operator when the last SUCCESS is 20 minutes old', async () => {
    const o = setup({ mtfMode: 'off', lastSuccessAt: new Date((NOW - 20 * 60) * 1000).toISOString() });
    await run(o);

    const notes = outageNotes(o);
    expect(notes).toHaveLength(1);
    expect(notes[0].dedupe_key).toBe(`outage:${Math.floor(NOW / 900)}`);
    expect(notes[0].message).toContain('20 menit');
  });

  it('stays silent while the pipeline is producing SUCCESS runs', async () => {
    const o = setup({ mtfMode: 'off' });
    await run(o);
    expect(outageNotes(o)).toHaveLength(0);
  });

  it('does not repeat itself inside the same 15-minute bucket', async () => {
    // NOW sits 30 s past a quarter-hour boundary, so NOW and NOW+60 share one bucket.
    const stale = new Date((NOW - 20 * 60) * 1000).toISOString();
    const a = setup({ mtfMode: 'off', lastSuccessAt: stale });
    const b = setup({ mtfMode: 'off', lastSuccessAt: stale });
    await run(a, NOW);
    await run(b, NOW + 60);

    const keys = [...outageNotes(a), ...outageNotes(b)].map((n) => n.dedupe_key);
    expect(keys).toHaveLength(2);
    // claim_notifications dedupes on this key, so one alert is delivered per bucket.
    expect(new Set(keys).size).toBe(1);
  });

  it('alerts even when the lock is stuck and the run never starts', async () => {
    const o = setup({
      mtfMode: 'off',
      lastSuccessAt: new Date((NOW - 45 * 60) * 1000).toISOString(),
      beginRun: { ok: false, reason: 'locked', run_id: 99 },
    });
    const r = await run(o);

    expect(r.status).toBe('SKIPPED');
    const notes = outageNotes(o);
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain('45 menit');
  });

  it('treats an unusable RPC as "no alarm" instead of paging on every tick', async () => {
    // PostgREST answers a missing function with 404; a scalar-less body must not read as "never".
    const note = await outageAlarmNote({ rpc: async () => ({ ok: true }) } as any, NOW, NOW);
    expect(note).toBeNull();
    const threw = await outageAlarmNote({ rpc: async () => { throw new Error('PGRST202'); } } as any, NOW, NOW);
    expect(threw).toBeNull();
  });

  it('treats a null last SUCCESS as unusable rather than an infinite outage', async () => {
    const note = await outageAlarmNote({ rpc: async () => null } as any, NOW, NOW);
    expect(note).toBeNull();
  });

  it('fires at exactly the threshold and not one minute earlier', async () => {
    const at = (min: number) => ({ rpc: async () => new Date((NOW - min * 60) * 1000).toISOString() } as any);
    expect(await outageAlarmNote(at(OUTAGE_ALARM_MINUTES - 1), NOW, NOW)).toBeNull();
    expect(await outageAlarmNote(at(OUTAGE_ALARM_MINUTES), NOW, NOW)).not.toBeNull();
  });
});
