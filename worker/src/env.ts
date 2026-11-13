export interface Env {
  ASSETS: Fetcher;
  /** Public (safe to expose) */
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Read-only INDODAX public API relay (Supabase Edge Function). Empty = call indodax.com directly. */
  INDODAX_PROXY_URL?: string;
  /** Worker secrets (never sent to the browser) */
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
