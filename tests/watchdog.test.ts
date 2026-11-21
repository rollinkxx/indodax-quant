import { describe, expect, it } from 'vitest';
import { PipelineWatchdog, WATCHDOG_INTERVAL_MS } from '../worker/src/watchdog';
import { env, fakeFetch, json, SB } from './fakes';

/** Minimal DurableObjectState: only the alarm storage the watchdog touches. */
function fakeState(initialAlarm: number | null = null) {
  const alarms: (number | null)[] = [initialAlarm];
  return {
    alarms,
    state: {
      storage: {
        async getAlarm() {
          return alarms[alarms.length - 1];
        },
        async setAlarm(at: number) {
          alarms.push(at);
        },
      },
    } as unknown as DurableObjectState,
  };
}

const NOW = Date.parse('2026-11-21T10:00:00Z');

/** Fake Supabase RPCs: last_success_at is whatever the test wants, Telegram always accepts. */
function harness(lastSuccessAt: string | null) {
  const telegram: string[] = [];
  const f = fakeFetch([
    (u, init) => {
      if (!u.href.startsWith(SB + '/rest/v1/rpc/')) return;
      const fn = u.pathname.split('/').pop()!;
      if (fn === 'last_success_at') return json(lastSuccessAt);
      if (fn === 'claim_notifications') {
        const body = JSON.parse(String(init.body));
        return json(body.p_items.map((i: { dedupe_key: string }) => i.dedupe_key));
      }
      return json(null);
    },
    (u, init) => {
      if (u.hostname !== 'api.telegram.org') return;
      telegram.push(JSON.parse(String(init.body)).text);
      return json({ ok: true });
    },
  ]);
  return { f, telegram };
}

describe('PipelineWatchdog', () => {
  it('arms the alarm when none is pending', async () => {
    const { state, alarms } = fakeState(null);
    const w = new PipelineWatchdog(state, env());
    const at = await w.arm(NOW);
    expect(at).toBe(NOW + WATCHDOG_INTERVAL_MS);
    expect(alarms[alarms.length - 1]).toBe(NOW + WATCHDOG_INTERVAL_MS);
  });

  it('leaves an existing alarm alone so a chatty cron cannot postpone it', async () => {
    const { state, alarms } = fakeState(NOW + 1000);
    const w = new PipelineWatchdog(state, env());
    expect(await w.arm(NOW)).toBe(NOW + 1000);
    expect(alarms).toHaveLength(1);
  });

  it('pages when no run has succeeded for longer than the outage threshold', async () => {
    const { f, telegram } = harness('2026-11-21T09:30:00Z'); // 30 minutes stale
    const original = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    try {
      const { state } = fakeState(null);
      const r = await new PipelineWatchdog(state, env()).tick(NOW);
      expect(r).toEqual({ alerted: true, reason: 'paged' });
    } finally {
      globalThis.fetch = original;
    }
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('PIPELINE OUTAGE');
  });

  it('stays quiet while the log is fresh', async () => {
    const { f, telegram } = harness('2026-11-21T09:59:00Z');
    const original = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    try {
      const { state } = fakeState(null);
      const r = await new PipelineWatchdog(state, env()).tick(NOW);
      expect(r).toEqual({ alerted: false, reason: 'fresh' });
    } finally {
      globalThis.fetch = original;
    }
    expect(telegram).toHaveLength(0);
  });

  it('re-arms itself even when the tick throws, so one bad check cannot stop the watchdog', async () => {
    const { state, alarms } = fakeState(null);
    const w = new PipelineWatchdog(state, env());
    const before = Date.now();
    // Force a throw inside tick: a Db whose fetch rejects.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('db down');
    }) as unknown as typeof fetch;
    try {
      await w.alarm();
    } finally {
      globalThis.fetch = original;
    }
    // alarm() re-arms from the real clock, not from the tick's injected timestamp.
    expect(alarms[alarms.length - 1]).toBeGreaterThanOrEqual(before + WATCHDOG_INTERVAL_MS);
    expect(alarms.length).toBeGreaterThan(1);
  });

  it('fetch() arms the alarm and reports it', async () => {
    const { state } = fakeState(null);
    const w = new PipelineWatchdog(state, env());
    const res = await w.fetch();
    const body = await res.json() as { armed_at: number };
    expect(body.armed_at).toBeGreaterThan(0);
  });
});
