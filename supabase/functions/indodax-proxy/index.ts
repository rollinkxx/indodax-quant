// INDODAX QUANT — authenticated read-only relay for official INDODAX public market data.
// verify_jwt is disabled because this service-to-service endpoint uses a narrow HMAC protocol.
// No browser/client token is accepted, and no private INDODAX endpoint can pass the path validator.
import { singleRelayPath, validateRelayTarget, verifyRelayRequest } from './_shared/relay.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const url = new URL(req.url);
  const timestamp = req.headers.get('x-indodax-relay-timestamp') ?? '';
  const signature = req.headers.get('x-indodax-relay-signature') ?? '';
  const signedTarget = url.pathname + url.search;
  const relaySecret = Deno.env.get('INDODAX_RELAY_HMAC_SECRET') ?? '';

  if (relaySecret.length < 32) return json({ error: 'relay_auth_not_configured' }, 503);
  const timestampNumber = /^\\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestampSkewSeconds = Number.isSafeInteger(timestampNumber) ? nowSeconds - timestampNumber : null;
  const signatureFormatValid = /^[a-f0-9]{64}$/i.test(signature);
  const authenticated = await verifyRelayRequest(relaySecret, signedTarget, timestamp, signature);
  if (!authenticated) {
    // Safe operational diagnostics only: never log the HMAC, secret value, or request headers.
    const reason = !signatureFormatValid
      ? 'signature_format_invalid'
      : timestampSkewSeconds === null
        ? 'timestamp_format_invalid'
        : Math.abs(timestampSkewSeconds) > 60
          ? 'timestamp_out_of_window'
          : 'hmac_mismatch';
    console.warn('indodax_relay_auth_rejected', JSON.stringify({
      reason,
      target: signedTarget,
      timestampSkewSeconds,
      secretLength: relaySecret.length,
    }));
    return json({ error: 'unauthorized' }, 401);
  }

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
