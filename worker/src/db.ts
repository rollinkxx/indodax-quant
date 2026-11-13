// Minimal Supabase PostgREST client for the Worker (service role, server-side only).
import type { FetchLike } from './env';
import { fetchWithRetry, HttpError } from './http';

/**
 * PostgREST query strings are built by hand. A literal '+' (e.g. in "+00:00" timestamp offsets returned by
 * Postgres) is decoded as a space by the server, which fails with 22007 invalid datetime. Encode it.
 */
export function encodeQuery(query: string): string {
  return query.replace(/\+/g, '%2B');
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

  /** All RPCs used here are idempotent, so retrying on transient failures is safe. */
  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(args),
    }, { retries: 2, timeoutMs: 15000 });
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async select<T>(table: string, query: string): Promise<T[]> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/${table}?${encodeQuery(query)}`, {
      method: 'GET', headers: this.headers(),
    }, { retries: 2, timeoutMs: 10000 });
    return (await res.json()) as T[];
  }

  async update<T>(table: string, filter: string, body: Record<string, unknown>): Promise<T[]> {
    const res = await fetchWithRetry(this.fetchImpl, `${this.url}/rest/v1/${table}?${encodeQuery(filter)}`, {
      method: 'PATCH', headers: this.headers({ prefer: 'return=representation' }), body: JSON.stringify(body),
    }, { retries: 1, timeoutMs: 10000 });
    return (await res.json()) as T[];
  }
}

export { HttpError };
