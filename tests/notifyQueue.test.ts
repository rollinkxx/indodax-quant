import { describe, expect, it } from 'vitest';
import { dispatchNotifications, enqueueNotifications } from '../worker/src/notify';
import { Db } from '../worker/src/db';
import type { NotificationItem } from '../worker/src/telegram';
import worker from '../worker/src/index';
import { env, fakeFetch, json, SB } from './fakes';

const items: NotificationItem[] = [
  { event_type: 'signal', dedupe_key: 'a', message: 'A' },
  { event_type: 'heartbeat', dedupe_key: 'b', message: 'B' },
];

/** Records what the queue received without needing a real Cloudflare binding. */
function fakeQueue(behaviour: 'ok' | 'throw' = 'ok') {
  const sent: NotificationItem[][] = [];
  return {
    sent,
    queue: {
      async sendBatch(batch: { body: NotificationItem }[]) {
        if (behaviour === 'throw') throw new Error('queue unavailable');
        sent.push(batch.map((b) => b.body));
      },
    } as unknown as NonNullable<ReturnType<typeof env>['NOTIFY_QUEUE']>,
  };
}

/** Fake Supabase + Telegram so the inline path can be observed. */
function inlineHarness() {
  const telegram: string[] = [];
  const f = fakeFetch([
    (u, init) => {
      if (!u.href.startsWith(SB + '/rest/v1/rpc/')) return;
      const fn = u.pathname.split('/').pop()!;
      if (fn === 'claim_notifications') {
        const body = JSON.parse(String(init.body));
        return json(body.p_items.map((i: NotificationItem) => i.dedupe_key));
      }
      return json(null);
    },
    (u, init) => {
      if (u.hostname !== 'api.telegram.org') return;
      telegram.push(JSON.parse(String(init.body)).text);
      return json({ ok: true });
    },
  ]);
  return { f, telegram, db: new Db(SB, 'sb_secret_test', f) };
}

describe('notification queue', () => {
  it('enqueues instead of sending inline when the binding is present', async () => {
    const { f, telegram, db } = inlineHarness();
    const q = fakeQueue();
    const r = await enqueueNotifications(env({ NOTIFY_QUEUE: q.queue }), db, items, f);

    expect(r).toEqual({ queued: 2, inline: null });
    expect(q.sent).toHaveLength(1);
    expect(q.sent[0].map((i) => i.dedupe_key)).toEqual(['a', 'b']);
    expect(telegram).toHaveLength(0);
    expect(f.calls.some((c) => c.url.includes('claim_notifications'))).toBe(false);
  });

  it('sends inline when no binding is configured (previous behaviour preserved)', async () => {
    const { f, telegram, db } = inlineHarness();
    const r = await enqueueNotifications(env(), db, items, f);

    expect(r.queued).toBe(0);
    expect(r.inline).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(telegram).toHaveLength(2);
  });

  it('falls back to an inline send when enqueueing throws, so a page is never lost', async () => {
    const { f, telegram, db } = inlineHarness();
    const q = fakeQueue('throw');
    const r = await enqueueNotifications(env({ NOTIFY_QUEUE: q.queue }), db, items, f);

    expect(r.queued).toBe(0);
    expect(r.inline).toMatchObject({ sent: 2 });
    expect(telegram).toHaveLength(2);
  });

  it('does nothing for an empty notification list', async () => {
    const { f, db } = inlineHarness();
    const q = fakeQueue();
    expect(await enqueueNotifications(env({ NOTIFY_QUEUE: q.queue }), db, [], f)).toEqual({ queued: 0, inline: null });
    expect(q.sent).toHaveLength(0);
  });

  it('consumer acks the batch after dispatching it', async () => {
    const { f, telegram } = inlineHarness();
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      messages: items.map((body, i) => ({
        id: String(i),
        body,
        ack: () => acked.push(String(i)),
        retry: () => retried.push(String(i)),
      })),
    } as unknown as MessageBatch;

    // The consumer builds its own Db from env; point it at the fake fetch by stubbing globalThis.fetch.
    const original = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    try {
      await worker.queue!(batch, env());
    } finally {
      globalThis.fetch = original;
    }

    expect(acked).toEqual(['0', '1']);
    expect(retried).toEqual([]);
    expect(telegram).toHaveLength(2);
  });

  it('consumer retries the batch when the DB is unreachable', async () => {
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      messages: items.map((body, i) => ({
        id: String(i),
        body,
        ack: () => acked.push(String(i)),
        retry: () => retried.push(String(i)),
      })),
    } as unknown as MessageBatch;

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    try {
      await worker.queue!(batch, env());
    } finally {
      globalThis.fetch = original;
    }

    expect(acked).toEqual([]);
    expect(retried).toEqual(['0', '1']);
  });

  it('dispatchNotifications still returns a result object (callers depend on the shape)', async () => {
    const { f, db } = inlineHarness();
    const r = await dispatchNotifications(env(), db, items, f);
    expect(Object.keys(r).sort()).toEqual(['claimed', 'failed', 'sent', 'skipped']);
  });
});
