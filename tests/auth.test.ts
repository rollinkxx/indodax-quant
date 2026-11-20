import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { authenticate, AuthError, authCacheSize, clearAuthCache, AUTH_CACHE_MAX, AUTH_CACHE_TTL_MS } from '../worker/src/auth';
import { Db } from '../worker/src/db';
import { appUsersHandler, authHandler, env, fakeFetch } from './fakes';

function req(token: string) {
  return new Request('https://w/api/me', { headers: { authorization: `Bearer ${token}` } });
}

describe('auth cache is bounded and expires', () => {
  beforeEach(() => clearAuthCache());
  afterEach(() => vi.useRealTimers());

  it('evicts one entry at a time instead of wiping the whole map on overflow', async () => {
    const flood = fakeFetch([
      (u, init) => (u.pathname === '/auth/v1/user'
        ? new Response(JSON.stringify({ email: String((init.headers as Record<string, string>).authorization).replace('Bearer ', '') + '@x.com' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : undefined),
      (u) => (u.pathname === '/rest/v1/app_users' ? new Response(JSON.stringify([{ role: 'viewer' }]), { status: 200 }) : undefined),
    ]);
    const db = new Db('https://example.supabase.co', 'k', flood);
    for (let i = 0; i < AUTH_CACHE_MAX + 50; i++) {
      await authenticate(req(`tok${i}`), env(), db, flood);
    }
    // Bounded: never above the cap.
    expect(authCacheSize()).toBe(AUTH_CACHE_MAX);
    // The old code called cache.clear() on overflow, so a flood left a single entry behind. With LRU
    // the most recently seen MAX tokens survive, so a token from that window is still cached.
    const before = flood.calls.filter((c) => c.url.endsWith('/auth/v1/user')).length;
    await authenticate(req(`tok${AUTH_CACHE_MAX + 40}`), env(), db, flood);
    expect(flood.calls.filter((c) => c.url.endsWith('/auth/v1/user')).length).toBe(before);
  });

  it('re-verifies a token after its entry expires instead of serving it from cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    let userCalls = 0;
    const f = fakeFetch([
      (u, init) => {
        if (u.pathname !== '/auth/v1/user') return undefined;
        userCalls++;
        return authHandler(u, init);
      },
      appUsersHandler,
    ]);
    const db = new Db('https://example.supabase.co', 'k', f);
    await authenticate(req('admin'), env(), db, f);
    await authenticate(req('admin'), env(), db, f);
    expect(userCalls).toBe(1); // second call served from cache

    vi.setSystemTime(new Date(Date.now() + AUTH_CACHE_TTL_MS + 1));
    await authenticate(req('admin'), env(), db, f);
    expect(userCalls).toBe(2); // expired entry forced a re-check
  });

  it('stops accepting a revoked token once its entry expires', async () => {
    const f = fakeFetch([
      // token "revoked" verifies once, then the auth server rejects it
      (() => { let n = 0; return (u: URL, init: RequestInit) => {
        if (u.pathname !== '/auth/v1/user') return undefined;
        n++;
        return n === 1 ? authHandler(u, init) : new Response('{"msg":"revoked"}', { status: 401 });
      }; })(),
      appUsersHandler,
    ]);
    const db = new Db('https://example.supabase.co', 'k', f);
    await authenticate(req('admin'), env(), db, f);
    expect(authCacheSize()).toBe(1);

    // The window in which a revoked token is still accepted is bounded by the TTL, not by the
    // isolate's lifetime: after expiry the token is re-verified, rejected, and leaves no entry.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + AUTH_CACHE_TTL_MS + 1);
    await expect(authenticate(req('admin'), env(), db, f)).rejects.toBeInstanceOf(AuthError);
    expect(authCacheSize()).toBe(0);
  });
});
