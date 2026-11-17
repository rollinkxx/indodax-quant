const encoder = new TextEncoder();
const MAX_CLOCK_SKEW_SECONDS = 60;
const INDODAX_ORIGIN = 'https://indodax.com';

/** Derive a dedicated relay key from the backend root key using domain separation. */
export async function deriveRelayHmacSecret(rootKey: string): Promise<string> {
  if (!rootKey || rootKey.length < 32) throw new Error('relay root key is missing or too short');
  const input = encoder.encode(`indodax-quant:relay-hmac:v1:${rootKey}`);
  return toHex(await crypto.subtle.digest('SHA-256', input));
}

function payload(target: string, timestamp: number): Uint8Array {
  return encoder.encode(`GET\n${target}\n${timestamp}`);
}

async function importKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (!secret || secret.length < 16) throw new Error('relay signing secret is missing or too short');
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Sign the exact proxy path + raw query and timestamp; the secret is never sent. */
export async function signRelayRequest(secret: string, target: string, timestamp: number): Promise<string> {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('invalid relay timestamp');
  const key = await importKey(secret, 'sign');
  return toHex(await crypto.subtle.sign('HMAC', key, payload(target, timestamp)));
}

/** Verify HMAC with WebCrypto's constant-time signature verification. */
export async function verifyRelayRequest(
  secret: string,
  target: string,
  timestampValue: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !/^\d{1,12}$/.test(timestampValue) || !Number.isSafeInteger(nowSeconds)) return false;
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;
  const signatureBytes = fromHex(signature);
  if (!signatureBytes) return false;
  try {
    const key = await importKey(secret, 'verify');
    return await crypto.subtle.verify('HMAC', key, signatureBytes, payload(target, timestamp));
  } catch {
    return false;
  }
}

function exactParams(query: URLSearchParams, expected: string[]): boolean {
  const actual = [...query.keys()];
  return actual.length === expected.length
    && expected.every((key) => query.getAll(key).length === 1)
    && actual.every((key) => expected.includes(key));
}

/** Accept exactly one envelope path parameter; duplicate values are ambiguous and rejected. */
export function singleRelayPath(query: URLSearchParams): string | null {
  const values = query.getAll('path');
  return values.length === 1 && values[0].startsWith('/') ? values[0] : null;
}

/** Validate only read-only INDODAX public paths and bounded historical ranges. */
export function validateRelayTarget(
  path: string,
  query: URLSearchParams,
): { ok: true; target: string } | { ok: false; status: 400; error: string } {
  const reject = (error: string) => ({ ok: false as const, status: 400 as const, error });
  if (!path.startsWith('/') || path.includes('\\') || path.includes('//') || path.includes('..')) {
    return reject('path_not_allowed');
  }

  if (path === '/api/summaries' || path === '/api/pairs' || path === '/api/server_time') {
    if (query.size !== 0) return reject('query_not_allowed');
  } else if (/^\/api\/(trades|ticker)\/[a-z0-9]{2,20}$/.test(path)) {
    if (query.size !== 0) return reject('query_not_allowed');
  } else if (path === '/tradingview/history_v2') {
    if (!exactParams(query, ['symbol', 'tf', 'from', 'to'])) return reject('invalid_history_parameters');
    const symbol = query.get('symbol') ?? '';
    const tf = query.get('tf') ?? '';
    const fromValue = query.get('from') ?? '';
    const toValue = query.get('to') ?? '';
    if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !['1', '15', '60'].includes(tf)) return reject('invalid_history_symbol_or_timeframe');
    if (!/^\d{1,12}$/.test(fromValue) || !/^\d{1,12}$/.test(toValue)) return reject('invalid_history_range');
    const from = Number(fromValue), to = Number(toValue);
    const maxRange = tf === '1' ? 7 * 86_400 : 14 * 86_400;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to - from > maxRange) {
      return reject('history_range_out_of_bounds');
    }
  } else {
    return reject('path_not_allowed');
  }

  const suffix = query.size ? `?${query.toString()}` : '';
  return { ok: true, target: INDODAX_ORIGIN + path + suffix };
}
