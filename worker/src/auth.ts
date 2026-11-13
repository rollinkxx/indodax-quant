// Supabase Auth verification + app_users authorization.
import type { Env, FetchLike } from './env';
import type { Db } from './db';
import { fetchWithRetry } from './http';

export interface AppUser {
  email: string;
  role: 'admin' | 'viewer';
}

const cache = new Map<string, { user: AppUser | null; exp: number }>();

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

export async function authenticate(req: Request, env: Env, db: Db, fetchImpl: FetchLike = fetch): Promise<AppUser> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AuthError(401, 'missing_token');

  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) {
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
  } catch {
    throw new AuthError(401, 'invalid_token');
  }
  if (!email) throw new AuthError(401, 'invalid_token');

  const rows = await db.select<{ role: 'admin' | 'viewer' }>('app_users', `select=role&email=eq.${encodeURIComponent(email)}`);
  const user = rows[0] ? { email, role: rows[0].role } : null;
  if (cache.size > 500) cache.clear();
  cache.set(token, { user, exp: Date.now() + 60_000 });
  if (!user) throw new AuthError(403, 'not_authorized');
  return user;
}

export function requireAdmin(user: AppUser) {
  if (user.role !== 'admin') throw new AuthError(403, 'admin_only');
}

export function clearAuthCache() {
  cache.clear();
}
