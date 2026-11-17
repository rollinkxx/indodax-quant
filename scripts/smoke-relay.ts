import { signRelayRequest } from '../supabase/functions/indodax-proxy/_shared/relay';

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !secret) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for relay smoke');

const requestUrl = new URL(`${supabaseUrl}/functions/v1/indodax-proxy?path=%2Fapi%2Fticker%2Fbtcidr`);
const unauthenticated = await fetch(requestUrl);
if (unauthenticated.status !== 401) {
  throw new Error(`Relay accepted an unsigned request or returned an unexpected status: HTTP ${unauthenticated.status}`);
}

const timestamp = Math.floor(Date.now() / 1000);
const signature = await signRelayRequest(secret, requestUrl.pathname + requestUrl.search, timestamp);
const response = await fetch(requestUrl, {
  method: 'GET',
  headers: {
    'x-indodax-relay-timestamp': String(timestamp),
    'x-indodax-relay-signature': signature,
  },
});
if (!response.ok) throw new Error(`Authenticated relay request failed: HTTP ${response.status}`);
const payload = await response.json() as { ticker?: { last?: string | number } };
const last = Number(payload?.ticker?.last);
if (!Number.isFinite(last) || last <= 0) throw new Error('Authenticated relay returned an invalid INDODAX ticker payload');

console.log('Relay smoke passed: unsigned request rejected; signed read-only ticker request succeeded.');
