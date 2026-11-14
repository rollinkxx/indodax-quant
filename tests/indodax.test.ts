import { describe, expect, it } from 'vitest';
import { IndodaxClient, parseHistory, parseSummaries, parseTrades } from '../worker/src/indodax';

const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('INDODAX public client', () => {
  it('blocks every non-public endpoint (no live trading possible)', async () => {
    const calls: string[] = [];
    const c = new IndodaxClient(async (u) => { calls.push(u); return okJson({}); });
    await expect(c.getJson('/tapi')).rejects.toThrow(/Blocked/);
    await expect(c.getJson('/api/v2/order')).rejects.toThrow(/Blocked/);
    await expect(c.getJson('/tapi/trade')).rejects.toThrow(/Blocked/);
    expect(calls).toHaveLength(0);
  });
  it('parses summaries: bid=buy, ask=sell, 24h change', () => {
    const t = parseSummaries({
      tickers: {
        btc_idr: { name: 'Bitcoin', last: '1100', buy: '1099', sell: '1101', high: '1200', low: '1000', vol_btc: '3', vol_idr: '3300', server_time: 1763000000 },
        bad_idr: { last: 'x', buy: '1', sell: '1', server_time: 1 },
        'BAD KEY': { last: '1' },
      },
      prices_24h: { btcidr: '1000' },
    });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ pair_id: 'btcidr', bid: 1099, ask: 1101, vol_traded: 3, vol_idr: 3300, price_24h: 1000 });
    expect(t[0].change_24h_pct).toBeCloseTo(10, 6);
  });
  it('parses and validates trades, sorted by time then tid', () => {
    const tr = parseTrades([
      { tid: '12', date: '1763000005', price: '100', amount: '0.5', type: 'sell' },
      { tid: '11', date: '1763000005', price: '101', amount: '1', type: 'buy' },
      { tid: 'x', date: '1', price: '1', amount: '1', type: 'buy' },
      { tid: '13', date: '1763000006', price: '-1', amount: '1', type: 'buy' },
      { tid: '14', date: '1763000006', price: '1', amount: '1', type: 'weird' },
    ]);
    expect(tr.map((t) => t.tid)).toEqual(['11', '12']);
  });
  it('parses official OHLC history and drops invalid rows', () => {
    const cs = parseHistory([
      { Time: 120, Open: '10', High: '12', Low: '9', Close: '11', Volume: '5' },
      { Time: 60, Open: '10', High: '9', Low: '10', Close: '11', Volume: '5' },
      { Time: 0, Open: '0', High: '1', Low: '1', Close: '1', Volume: '1' },
    ]);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ t: 120, o: 10, h: 12, l: 9, c: 11, v: 5, source: 'history' });
  });
  it('retries on 5xx and returns data', async () => {
    let n = 0;
    const c = new IndodaxClient(async () => (++n < 2 ? new Response('busy', { status: 503 }) : okJson({ ticker: { last: '1', buy: '1', sell: '2', server_time: '5' } })), { timeoutMs: 1000, retries: 2 });
    expect(await c.getTicker('btcidr')).toEqual({ last: 1, bid: 1, ask: 2, server_time: 5, vol_idr: null });
    expect(n).toBe(2);
  });
  it('does not retry on 404 and rejects invalid payloads', async () => {
    let n = 0;
    const c = new IndodaxClient(async () => { n++; return new Response('no', { status: 404 }); }, { timeoutMs: 1000, retries: 2 });
    await expect(c.getTrades('btcidr')).rejects.toThrow(/404/);
    expect(n).toBe(1);
    const c2 = new IndodaxClient(async () => okJson({ nope: 1 }), { timeoutMs: 1000, retries: 0 });
    await expect(c2.getTrades('btcidr')).rejects.toThrow(/Invalid/);
    await expect(c2.getTrades('../tapi')).rejects.toThrow(/invalid pair/);
  });
});
