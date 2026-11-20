// Supabase Auth verification + app_users authorization.
import type { Env, FetchLike } from './env';
import type { Db } from './db';
import { fetchWithRetry, HttpError } from './http';

export interface AppUser {
  email: string;
  role: 'admin' | 'viewer';
}

/** Hard ceiling on cached tokens. A burst of distinct tokens must not grow the isolate's heap. */
export const AUTH_CACHE_MAX = 500;
/** Cache lifetime. Short enough that a revoked token stops being accepted without a restart. */
export const AUTH_CACHE_TTL_MS = 60_000;

interface CacheEntry { user: AppUser | null; exp: number }

/**
 * Module-scope token -> user cache.
 *
 * The Map is bounded and expires entries: an unbounded Map leaks memory across the isolate's
 * lifetime, and a never-invalidated entry keeps accepting a token after it was revoked or the user
 * logged out. Insertion order doubles as LRU order (a hit is re-inserted at the tail), so eviction
 * drops the coldest entry first.
 */
const cache = new Map<string, CacheEntry>();

function cacheGet(token: string, nowMs: number): CacheEntry | undefined {
  const hit = cache.get(token);
  if (!hit) return undefined;
  if (hit.exp <= nowMs) { cache.delete(token); return undefined; }
  cache.delete(token);
  cache.set(token, hit); // refresh LRU position
  return hit;
}

function cacheSet(token: string, entry: CacheEntry): void {
  cache.delete(token);
  cache.set(token, entry);
  while (cache.size > AUTH_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

export async function authenticate(req: Request, env: Env, db: Db, fetchImpl: FetchLike = fetch): Promise<AppUser> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AuthError(401, 'missing_token');

  const hit = cacheGet(token, Date.now());
  if (hit) {
    if (!hit.user) throw new AuthError(403, 'not_authorized');
    return hit.user;
  }

  let email: string | undefined;
  try {
    const res = await fetchWithRetry(fetchImpl, `${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}` },
    }, { retries: 1, timeoutMs: 6000 });
    const user = (await res.json()) as { email?: string };
    email = user.email?.toLowerCase();
  } catch (e) {
    // A 401 from the auth server means the token was revoked or expired: drop any stale entry so a
    // re-used token is re-verified instead of being served from the cache.
    if (e instanceof HttpError && e.status === 401) cache.delete(token);
    throw new AuthError(401, 'invalid_token');
  }
  if (!email) throw new AuthError(401, 'invalid_token');

  const rows = await db.select<{ role: 'admin' | 'viewer' }>('app_users', `select=role&email=eq.${encodeURIComponent(email)}`);
  const user = rows[0] ? { email, role: rows[0].role } : null;
  cacheSet(token, { user, exp: Date.now() + AUTH_CACHE_TTL_MS });
  if (!user) throw new AuthError(403, 'not_authorized');
  return user;
}

export function requireAdmin(user: AppUser) {
  if (user.role !== 'admin') throw new AuthError(403, 'admin_only');
}

export function clearAuthCache() {
  cache.clear();
}

/** Exposed for tests: current cache size. */
export function authCacheSize(): number {
  return cache.size;
}
