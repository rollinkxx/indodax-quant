// INDODAX QUANT — authenticated read-only relay for official INDODAX public market data.
// verify_jwt is disabled because this service-to-service endpoint uses a narrow HMAC protocol.
// No browser/client token is accepted, and no private INDODAX endpoint can pass the path validator.
import { singleRelayPath, validateRelayTarget, verifyRelayRequest } from './_shared/relay.ts';

function configuredRelaySecrets(): string[] {
  const values: string[] = [];
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) values.push(legacy);

  // Supabase exposes new sb_secret_* keys as a JSON map, while legacy projects
  // expose SUPABASE_SERVICE_ROLE_KEY as a plain string.
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const value of Object.values(parsed)) {
        if (typeof value === 'string' && value.length >= 16) values.push(value);
      }
    } catch {
      // Invalid environment configuration is handled as no usable credential below.
    }
  }
  return [...new Set(values)];
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const url = new URL(req.url);
  const timestamp = req.headers.get('x-indodax-relay-timestamp') ?? '';
  const signature = req.headers.get('x-indodax-relay-signature') ?? '';
  const signedTarget = url.pathname + url.search;
  const secrets = configuredRelaySecrets();

  if (secrets.length === 0) return json({ error: 'relay_auth_not_configured' }, 503);

  let authenticated = false;
  for (const secret of secrets) {
    if (await verifyRelayRequest(secret, signedTarget, timestamp, signature)) {
      authenticated = true;
      break;
    }
  }
  if (!authenticated) return json({ error: 'unauthorized' }, 401);

  const path = singleRelayPath(url.searchParams);
  if (!path) return json({ error: 'invalid_relay_path_parameter' }, 400);
  const upstreamQuery = new URLSearchParams(url.searchParams);
  upstreamQuery.delete('path');
  const validated = validateRelayTarget(path, upstreamQuery);
  if (!validated.ok) return json({ error: validated.error }, validated.status);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const response = await fetch(validated.target, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'indodax-quant/1.0 (paper-trading monitor)' },
      signal: ctrl.signal,
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'x-upstream-status': String(response.status),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return json({ error: 'upstream_failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
