// indodax.com answers HTTP 403 to requests that originate from Cloudflare Workers.
// Production therefore routes INDODAX calls through a read-only relay: the Supabase Edge Function
// `indodax-proxy` (supabase/functions/indodax-proxy), which enforces the same PUBLIC endpoint whitelist.
// Only https://indodax.com/* URLs are rewritten; Supabase and Telegram calls pass through unchanged.
// The IndodaxClient whitelist (no /tapi, no private API) still runs before any URL reaches this wrapper.
import type { FetchLike } from './env';

export const INDODAX_ORIGIN = 'https://indodax.com';

export function relayUrl(url: string, proxyUrl: string): string {
  const rest = url.slice(INDODAX_ORIGIN.length);
  const [path, query] = rest.split('?', 2);
  return `${proxyUrl}?path=${encodeURIComponent(path)}${query ? '&' + query : ''}`;
}

export function withIndodaxRelay(base: FetchLike, proxyUrl?: string): FetchLike {
  const proxy = proxyUrl?.trim();
  if (!proxy) return base;
  return (input, init) =>
    typeof input === 'string' && input.startsWith(INDODAX_ORIGIN + '/')
      ? base(relayUrl(input, proxy), init)
      : base(input, init);
}
