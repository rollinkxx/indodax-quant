// INDODAX calls from Cloudflare Workers are routed through the authenticated read-only Supabase relay.
import type { FetchLike } from './env';
import { signRelayRequest } from '../../supabase/functions/indodax-proxy/_shared/relay';

export const INDODAX_ORIGIN = 'https://indodax.com';
export const RELAY_TIMESTAMP_HEADER = 'x-indodax-relay-timestamp';
export const RELAY_SIGNATURE_HEADER = 'x-indodax-relay-signature';

export function relayUrl(url: string, proxyUrl: string): string {
  const source = new URL(url);
  const proxy = new URL(proxyUrl);
  proxy.searchParams.set('path', source.pathname);
  source.searchParams.forEach((value, key) => proxy.searchParams.append(key, value));
  return proxy.toString();
}

/**
 * Rewrite only official INDODAX URLs. The Worker signs the exact proxy path/query;
 * its Supabase service secret is used as an HMAC key and is never transmitted.
 */
export function withIndodaxRelay(base: FetchLike, proxyUrl?: string, relaySecret?: string): FetchLike {
  const proxy = proxyUrl?.trim();
  if (!proxy) return base;
  return async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith(INDODAX_ORIGIN + '/')) return base(input, init);
    if (!relaySecret) throw new Error('INDODAX relay is configured but the relay signing secret is missing');
    const target = relayUrl(input, proxy);
    const targetUrl = new URL(target);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signRelayRequest(relaySecret, targetUrl.pathname + targetUrl.search, timestamp);
    const headers = new Headers(init?.headers);
    headers.set(RELAY_TIMESTAMP_HEADER, String(timestamp));
    headers.set(RELAY_SIGNATURE_HEADER, signature);
    return base(target, { ...init, method: 'GET', headers });
  };
}
