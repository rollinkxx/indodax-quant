// Minimal fake fetch that routes Supabase (PostgREST/Auth), Telegram and INDODAX calls.
import type { Env, FetchLike } from '../worker/src/env';

export const SB = 'https://example.supabase.co';

export function env(over: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    SUPABASE_URL: SB,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '42',
    ...over,
  };
}

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export function fakeFetch(handlers: Handler[]): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    calls.push({ url: input, init });
    const u = new URL(input);
    for (const h of handlers) {
      const r = await h(u, init);
      if (r) return r;
    }
    return new Response(JSON.stringify({ error: 'unhandled ' + input }), { status: 500 });
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Supabase Auth: token "admin" -> admin@x, "viewer" -> viewer@x, "stranger" -> nobody@x */
export const authHandler: Handler = (u, init) => {
  if (u.pathname !== '/auth/v1/user') return;
  const tok = String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '');
  const map: Record<string, string> = { admin: 'admin@x.com', viewer: 'viewer@x.com', stranger: 'nobody@x.com' };
  return map[tok] ? json({ email: map[tok] }) : json({ msg: 'bad jwt' }, 401);
};

export const appUsersHandler: Handler = (u) => {
  if (u.pathname !== '/rest/v1/app_users') return;
  const email = decodeURIComponent(u.searchParams.get('email') ?? '').replace('eq.', '');
  const roles: Record<string, string> = { 'admin@x.com': 'admin', 'viewer@x.com': 'viewer' };
  return json(roles[email] ? [{ role: roles[email] }] : []);
};
