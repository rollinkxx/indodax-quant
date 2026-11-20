import { describe, it, expect } from 'vitest';
import { Db, encodeQuery, filterValue } from '../worker/src/db';

describe('Db query encoding', () => {
  it('encodes + in timestamp offsets so PostgREST does not read a space', () => {
    expect(encodeQuery('snapshot_time=gte.2026-11-13T01:27:30.747926+00:00&limit=10'))
      .toBe('snapshot_time=gte.2026-11-13T01:27:30.747926%2B00:00&limit=10');
  });

  it('leaves queries without reserved characters untouched', () => {
    expect(encodeQuery('select=*&name=eq.default&limit=1')).toBe('select=*&name=eq.default&limit=1');
  });

  it('does not double-encode values already escaped by filterValue', () => {
    const v = filterValue('a&b=c');
    expect(v).toBe('a%26b%3Dc');
    expect(encodeQuery(`col=eq.${v}`)).toBe('col=eq.a%26b%3Dc');
  });

  it('escapes a bare % so it cannot start a malformed percent-escape', () => {
    expect(encodeQuery('name=eq.100%')).toBe('name=eq.100%25');
  });

  it('escapes # so the fragment cannot truncate the query', () => {
    expect(encodeQuery('name=eq.a#b')).toBe('name=eq.a%23b');
  });

  it('keeps a full timestamp offset intact end to end', () => {
    const q = `snapshot_time=gte.${filterValue('2026-11-20T00:00:00+00:00')}`;
    expect(q).toBe('snapshot_time=gte.2026-11-20T00%3A00%3A00%2B00%3A00');
    // already fully encoded: nothing left for encodeQuery to rewrite
    expect(encodeQuery(q)).toBe(q);
  });

  it('select() sends the encoded URL', async () => {
    let seen = '';
    const fakeFetch = (async (url: string) => { seen = url; return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    const db = new Db('https://x.supabase.co', 'test-key', fakeFetch);
    await db.select('portfolio_snapshots', 'snapshot_time=gte.2026-11-13T01:27:30+00:00');
    expect(seen).toBe('https://x.supabase.co/rest/v1/portfolio_snapshots?snapshot_time=gte.2026-11-13T01:27:30%2B00:00');
  });
});

describe('filterValue keeps a value inside one PostgREST filter', () => {
  const parse = (query: string) => new URLSearchParams(encodeQuery(query));

  it('does not split a filter value containing & and =', () => {
    const params = parse(`email=eq.${filterValue('a&b=c')}`);
    expect([...params.keys()]).toEqual(['email']);
    expect(params.get('email')).toBe('eq.a&b=c');
  });

  it('round-trips a literal percent value', () => {
    const params = parse(`name=eq.${filterValue('100%')}`);
    expect([...params.keys()]).toEqual(['name']);
    expect(params.get('name')).toBe('eq.100%');
  });

  it('round-trips a timestamp with a +00:00 offset', () => {
    const params = parse(`ts=gte.${filterValue('2026-11-20T00:00:00+00:00')}`);
    expect(params.get('ts')).toBe('gte.2026-11-20T00:00:00+00:00');
  });
});

describe('Db.update retry policy', () => {
  it('does not resend a non-idempotent PATCH after a 503 by default', async () => {
    let patches = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      if ((init.method ?? 'GET') === 'PATCH') patches++;
      return new Response('upstream down', { status: 503 });
    }) as unknown as typeof fetch;
    const db = new Db('https://x.supabase.co', 'test-key', fakeFetch);
    await expect(db.update('paper_accounts', 'id=eq.1', { cash_balance: 'increment' })).rejects.toThrow();
    expect(patches).toBe(1);
  });

  it('resends a PATCH once when the caller opts into retries for an absolute set', async () => {
    let patches = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      if ((init.method ?? 'GET') === 'PATCH') patches++;
      return patches === 1 ? new Response('down', { status: 503 }) : new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const db = new Db('https://x.supabase.co', 'test-key', fakeFetch);
    await db.update('paper_positions', 'id=eq.1&status=eq.OPEN', { stop_loss: 5 }, { retries: 1 });
    expect(patches).toBe(2);
  });
});
