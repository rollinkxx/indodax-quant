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
const signedTarget = requestUrl.pathname + requestUrl.search;
const signature = await signRelayRequest(secret, signedTarget, timestamp);

// A captured signature must not authorize a different target.
const tamperedUrl = new URL(requestUrl);
tamperedUrl.searchParams.set('path', '/api/ticker/ethidr');
const tampered = await fetch(tamperedUrl, {
  method: 'GET',
  headers: {
    'x-indodax-relay-timestamp': String(timestamp),
    'x-indodax-relay-signature': signature,
  },
});
if (tampered.status !== 401) {
  throw new Error(`Relay accepted a tampered request target: HTTP ${tampered.status}`);
}

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

// Even a correctly signed request must not reach private INDODAX endpoints.
const privateUrl = new URL(requestUrl);
privateUrl.searchParams.set('path', '/tapi');
const privateSignature = await signRelayRequest(secret, privateUrl.pathname + privateUrl.search, timestamp);
const privateResponse = await fetch(privateUrl, {
  method: 'GET',
  headers: {
    'x-indodax-relay-timestamp': String(timestamp),
    'x-indodax-relay-signature': privateSignature,
  },
});
if (privateResponse.status !== 400) {
  throw new Error(`Relay did not reject a signed private endpoint: HTTP ${privateResponse.status}`);
}

console.log('Relay smoke passed: unsigned and tampered requests rejected; signed private endpoint rejected; signed public ticker request succeeded.');
