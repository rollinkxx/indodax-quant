// INDODAX calls from Cloudflare Workers are routed through the authenticated read-only Supabase relay.
import type { FetchLike } from './env';
import { formatRelayAuthorization, signRelayRequest } from '../../supabase/functions/indodax-proxy/_shared/relay';

export const INDODAX_ORIGIN = 'https://indodax.com';
export function relayUrl(url: string, proxyUrl: string): string {
  const source = new URL(url);
  const proxy = new URL(proxyUrl);
  proxy.searchParams.set('path', source.pathname);
  source.searchParams.forEach((value, key) => proxy.searchParams.append(key, value));
  return proxy.toString();
}

/**
 * Rewrite only official INDODAX URLs. The Worker signs the canonical proxy path/query;
 * the HMAC proof is sent via Authorization, never the Supabase service secret.
 */
export function withIndodaxRelay(base: FetchLike, proxyUrl?: string, relaySecret?: string): FetchLike {
  const proxy = proxyUrl?.trim();
  if (!proxy) return base;
  return async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith(INDODAX_ORIGIN + '/')) return base(input, init);
    if (!relaySecret) throw new Error('INDODAX relay is configured but relay signing secret is missing');
    const target = relayUrl(input, proxy);
    const targetUrl = new URL(target);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signRelayRequest(relaySecret, targetUrl.pathname + targetUrl.search, timestamp);
    const headers = new Headers(init?.headers);
    headers.delete('x-indodax-relay-timestamp');
    headers.delete('x-indodax-relay-signature');
    headers.set('authorization', formatRelayAuthorization(timestamp, signature));
    return base(target, { ...init, method: 'GET', headers });
  };
}
