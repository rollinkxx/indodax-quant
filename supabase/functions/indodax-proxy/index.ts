// INDODAX QUANT — read-only relay for the INDODAX OFFICIAL PUBLIC API.
// Why: indodax.com answers HTTP 403 to requests that originate from Cloudflare Workers.
// The Worker calls this function; it forwards GET requests to whitelisted PUBLIC endpoints only.
// No private/trade API (/tapi), no API keys, no orders. Market data only.
// Deployed by .github/workflows/ci-deploy.yml (supabase functions deploy --no-verify-jwt).
const BASE = 'https://indodax.com';
const ALLOWED = [
  /^\/api\/summaries$/,
  /^\/api\/pairs$/,
  /^\/api\/server_time$/,
  /^\/api\/trades\/[a-z0-9]+$/,
  /^\/api\/ticker\/[a-z0-9]+$/,
  /^\/tradingview\/history_v2$/,
];

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const url = new URL(req.url);
  const path = url.searchParams.get('path') ?? '';
  if (!ALLOWED.some((r) => r.test(path))) return json({ error: 'path_not_allowed', path }, 400);
  const qs = new URLSearchParams(url.searchParams);
  qs.delete('path');
  const target = BASE + path + (qs.toString() ? '?' + qs.toString() : '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': 'indodax-quant/1.0 (paper-trading monitor)' },
      signal: ctrl.signal,
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/json',
        'x-upstream-status': String(res.status),
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return json({ error: 'upstream_failed', message: String(e) }, 502);
  } finally {
    clearTimeout(timer);
  }
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
