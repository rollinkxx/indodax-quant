import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/** Public config (URL + publishable key) is served by the Worker; no secret ever reaches the browser. */
export async function getSupabase(): Promise<SupabaseClient> {
  if (client) return client;
  const res = await fetch('/api/public-config');
  if (!res.ok) throw new Error('Failed to load public config');
  const cfg = (await res.json()) as { supabaseUrl: string; supabasePublishableKey: string };
  client = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}
