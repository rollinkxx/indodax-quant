// Minimal Supabase PostgREST client for the Worker (service role, server-side only).
import type { FetchLike } from './env';
import { fetchWithRetry, HttpError } from './http';

/**
 * Encode a *value* that is interpolated into a PostgREST filter (`col=eq.<value>`).
 *
 * Without this, a value containing `&`, `#` or `%` silently rewrites the query instead of failing:
 * `email=eq.a&b=c` becomes two filters, and `100%` breaks percent-decoding. The result is a filter
 * that matches the wrong rows - the worst failure class, because nothing errors.
 */
export function filterValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Escape the reserved characters of a hand-built PostgREST query string.
 *
 * Callers must pass filter *values* through `filterValue()`; this function only repairs the
 * characters that a raw template literal leaves behind:
 * - a literal '+' (Postgres timestamps carry "+00:00", which the server decodes as a space and
 *   rejects with 22007),
 * - a bare '%' (which would otherwise start a malformed percent-escape),
 * - a literal '#' (which would truncate the URL at the fragment).
 * Already-encoded `%XX` sequences from `filterValue` are preserved, never double-encoded.
 */
export function encodeQuery(query: string): string {
  return query
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const value = part.slice(eq + 1)
        .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
        .replace(/\+/g, '%2B')
        .replace(/#/g, '%23');
      return `${part.slice(0, eq)}=${value}`;
    })
    .join('&');
}

export class Db {
  constructor(private url: string, private key: string, private fetchImpl: FetchLike = fetch) {
    if (!url || !key) throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, 'content-type': 'application/json', accept: 'application/json', ...extra };
    // Legacy service_role keys are JWTs and go in Authorization; new sb_secret_ keys only in apikey.
    if (!this.key.startsWith('sb_')) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  /**
   * All RPCs used here are idempotent by contract (fence/owner checks, ON CONFLICT, idempotency
   * keys), so retrying a transient failure is safe.
   */
  async rpc<T>(fn: string, args: Record<string, unknown> = {}, opts: { retries?: number } = {}): Promise<T> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(args),
    }, { retries: opts.retries ?? 2, timeoutMs: 15000 });
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async select<T>(table: string, query: string, opts: { retries?: number } = {}): Promise<T[]> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/${table}?${encodeQuery(query)}`, {
      method: 'GET', headers: this.headers(),
    }, { retries: opts.retries ?? 2, timeoutMs: 10000 });
    return (await res.json()) as T[];
  }

  /**
   * PATCH is NOT guaranteed idempotent: a plain `set col = value` is, but any increment/append
   * expression would be applied twice on a retry. The default is therefore no retry; a caller that
   * knows its body is an absolute set (and its filter is a compare-and-set on a stable key) opts in
   * with `retries: 1`.
   */
  async update<T>(table: string, filter: string, body: Record<string, unknown>, opts: { retries?: number } = {}): Promise<T[]> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/${table}?${encodeQuery(filter)}`, {
      method: 'PATCH', headers: this.headers({ prefer: 'return=representation' }), body: JSON.stringify(body),
    }, { retries: opts.retries ?? 0, timeoutMs: 10000 });
    return (await res.json()) as T[];
  }
}

export { HttpError };
