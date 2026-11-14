import { describe, expect, it } from 'vitest';
import { dispatchNotifications } from '../worker/src/notify';
import { messages, sendTelegram } from '../worker/src/telegram';
import { redact } from '../worker/src/http';
import { Db } from '../worker/src/db';
import { env, fakeFetch, json, SB } from './fakes';

describe('Telegram notifications', () => {
  it('only sends items claimed in the DB (dedupe) and reports results', async () => {
    const sent: string[] = [];
    const rpcs: { fn: string; body: any }[] = [];
    const f = fakeFetch([
      (u, init) => {
        if (!u.href.startsWith(SB + '/rest/v1/rpc/')) return;
        const fn = u.pathname.split('/').pop()!;
        const body = JSON.parse(String(init.body));
        rpcs.push({ fn, body });
        if (fn === 'claim_notifications') return json(['a']); // 'b' was already sent earlier
        return json(null);
      },
      (u, init) => {
        if (u.hostname !== 'api.telegram.org') return;
        sent.push(JSON.parse(String(init.body)).text);
        return json({ ok: true });
      },
    ]);
    const db = new Db(SB, 'sb_secret_test', f);
    const items = [
      { event_type: 'signal', dedupe_key: 'a', message: 'A' },
      { event_type: 'signal', dedupe_key: 'a', message: 'A dup' },
      { event_type: 'signal', dedupe_key: 'b', message: 'B' },
    ];
    const r = await dispatchNotifications(env(), db, items as any, f);
    expect(sent).toHaveLength(1); // duplicate dedupe_key collapsed before claiming
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(rpcs[0].body.p_items).toHaveLength(2);
    expect(rpcs[1]).toMatchObject({ fn: 'complete_notifications', body: { p_results: [{ dedupe_key: 'a', status: 'SENT' }] } });
  });

  it('marks SKIPPED when Telegram is not configured', async () => {
    const f = fakeFetch([(u) => (u.pathname.endsWith('claim_notifications') ? json(['a']) : u.href.startsWith(SB) ? json(null) : undefined)]);
    const db = new Db(SB, 'sb_secret_test', f);
    const r = await dispatchNotifications(env({ TELEGRAM_BOT_TOKEN: undefined }), db, [{ event_type: 'x', dedupe_key: 'a', message: 'A' }] as any, f);
    expect(r.skipped).toBe(1);
    expect(f.calls.some((c) => c.url.includes('telegram'))).toBe(false);
  });

  it('manual kill-switch Telegram message reports total and failed positions safely', () => {
    const message = messages.killSwitch('manual by admin', 1, {
      total: 2,
      failures: [{ pair: 'thin<idr', reason: 'stale&crossed_ticker' }],
    });
    expect(message).toContain('Posisi ditutup: 1/2');
    expect(message).toContain('Gagal ditutup:');
    expect(message).toContain('thin&lt;idr: stale&amp;crossed_ticker');
  });

  it('automatic kill-switch message remains compatible without manual close details', () => {
    const message = messages.killSwitch('max drawdown', 2);
    expect(message).toContain('Posisi ditutup: 2');
    expect(message).not.toContain('Gagal ditutup:');
  });

  it('sendTelegram returns error instead of throwing', async () => {
    const f = fakeFetch([() => json({ ok: false, description: 'chat not found' })]);
    expect(await sendTelegram(env(), 'hi', f)).toEqual({ ok: false, error: 'chat not found' });
  });

  it('redacts bot tokens from URLs in logs', () => {
    expect(redact('https://api.telegram.org/bot123:ABC-def/sendMessage')).toBe('https://api.telegram.org/bot***/sendMessage');
  });

  it('new sb_secret keys go only in apikey header, never Authorization', async () => {
    const f = fakeFetch([() => json([])]);
    await new Db(SB, 'sb_secret_test', f).select('x', 'select=*');
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h.apikey).toBe('sb_secret_test');
    expect(h.authorization).toBeUndefined();
  });
});
