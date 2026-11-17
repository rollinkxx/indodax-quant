import { describe, expect, it } from 'vitest';
import { relayUrl, withIndodaxRelay } from '../worker/src/relay';
import { IndodaxClient } from '../worker/src/indodax';

const PROXY = 'https://x.supabase.co/functions/v1/indodax-proxy';
const RELAY_SECRET = 'test-worker-relay-secret-with-safe-length';
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('INDODAX relay (Cloudflare Workers are blocked by indodax.com)', () => {
  it('rewrites indodax.com URLs to the relay, keeping the query string', () => {
    expect(relayUrl('https://indodax.com/api/ticker/btcidr', PROXY)).toBe(`${PROXY}?path=%2Fapi%2Fticker%2Fbtcidr`);
    expect(relayUrl('https://indodax.com/tradingview/history_v2?symbol=BTCIDR&tf=1&from=1&to=2', PROXY))
      .toBe(`${PROXY}?path=%2Ftradingview%2Fhistory_v2&symbol=BTCIDR&tf=1&from=1&to=2`);
  });
  it('leaves Supabase / Telegram URLs untouched and is a no-op without a proxy', async () => {
    const calls: string[] = [];
    const base = async (u: string) => { calls.push(u); return okJson({}); };
    const f = withIndodaxRelay(base, PROXY, RELAY_SECRET);
    await f('https://abc.supabase.co/rest/v1/candles');
    await f('https://api.telegram.org/botX/sendMessage');
    await f('https://indodax.com/api/pairs');
    expect(calls).toEqual(['https://abc.supabase.co/rest/v1/candles', 'https://api.telegram.org/botX/sendMessage', `${PROXY}?path=%2Fapi%2Fpairs`]);
    expect(withIndodaxRelay(base, '')).toBe(base);
    expect(withIndodaxRelay(base, undefined)).toBe(base);
  });
  it('uses a standard Relay-HMAC Authorization header instead of custom x- headers', async () => {
    let authorization: string | null = null;
    let legacyHeadersPresent = false;
    const base = async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization');
      legacyHeadersPresent = headers.has('x-indodax-relay-timestamp') || headers.has('x-indodax-relay-signature');
      return okJson({});
    };
    await withIndodaxRelay(base, PROXY, RELAY_SECRET)('https://indodax.com/api/pairs');
    expect(authorization).toMatch(/^Relay-HMAC [0-9]{1,12}\.[a-f0-9]{64}$/i);
    expect(legacyHeadersPresent).toBe(false);
  });

  it('fails closed when the relay URL is configured without a signing secret', async () => {
    const base = async () => okJson({});
    const f = withIndodaxRelay(base, PROXY);
    await expect(f('https://indodax.com/api/pairs')).rejects.toThrow(/signing secret is missing/);
  });
  it('works end-to-end with IndodaxClient and still blocks private endpoints', async () => {
    const calls: string[] = [];
    const f = withIndodaxRelay(async (u) => { calls.push(u); return okJson({ ticker: { last: '1', buy: '1', sell: '2', server_time: '5' } }); }, PROXY, RELAY_SECRET);
    const dx = new IndodaxClient(f, { timeoutMs: 1000, retries: 0 });
    expect(await dx.getTicker('btcidr')).toEqual({ last: 1, bid: 1, ask: 2, server_time: 5, vol_idr: null });
    await expect(dx.getJson('/tapi')).rejects.toThrow(/Blocked/);
    expect(calls).toEqual([`${PROXY}?path=%2Fapi%2Fticker%2Fbtcidr`]);
  });
});
