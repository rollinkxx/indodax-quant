import { deriveRelayHmacSecret } from '../supabase/functions/indodax-proxy/_shared/relay.ts';

const rootKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (rootKey.length < 32) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to derive the relay HMAC secret');

// Print only the derived key. CI masks it before using it as a platform secret.
process.stdout.write(await deriveRelayHmacSecret(rootKey));
