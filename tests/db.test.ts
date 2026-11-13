import { describe, it, expect } from 'vitest';
import { Db, encodeQuery } from '../worker/src/db';

describe('Db query encoding', () => {
  it('encodes + in timestamp offsets so PostgREST does not read a space', () => {
    expect(encodeQuery('snapshot_time=gte.2026-11-13T01:27:30.747926+00:00&limit=10'))
      .toBe('snapshot_time=gte.2026-11-13T01:27:30.747926%2B00:00&limit=10');
  });

  it('leaves queries without + untouched', () => {
    expect(encodeQuery('select=*&name=eq.default&limit=1')).toBe('select=*&name=eq.default&limit=1');
  });

  it('select() sends the encoded URL', async () => {
    let seen = '';
    const fakeFetch = (async (url: string) => { seen = url; return new Response('[]', { status: 200 }); }) as unknown as typeof fetch;
    const db = new Db('https://x.supabase.co', 'test-key', fakeFetch);
    await db.select('portfolio_snapshots', 'snapshot_time=gte.2026-11-13T01:27:30+00:00');
    expect(seen).toBe('https://x.supabase.co/rest/v1/portfolio_snapshots?snapshot_time=gte.2026-11-13T01:27:30%2B00:00');
  });
});
