import type { NotificationItem } from './telegram';

export interface Env {
  ASSETS: Fetcher;
  /**
   * Optional notification queue. When bound, Telegram delivery runs in the queue consumer instead of
   * inside the cron invocation, so a burst of notifications cannot spend the run's subrequest budget
   * (Workers Free allows 50 per invocation). Missing binding means inline sending, which is the
   * behaviour that existed before the queue.
   */
  NOTIFY_QUEUE?: Queue<NotificationItem>;
  /**
   * Out-of-band pipeline watchdog. Its alarm runs independently of the cron trigger, so an outage is
   * still reported when the cron stops invoking the Worker at all. Optional: without the binding the
   * in-run outage alarm is the only one.
   */
  WATCHDOG?: DurableObjectNamespace;
  /** Public (safe to expose) */
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Read-only INDODAX public API relay (Supabase Edge Function). Empty = call indodax.com directly. */
  INDODAX_PROXY_URL?: string;
  /** Worker secrets (never sent to the browser) */
  SUPABASE_SERVICE_ROLE_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Optional PostHog project token for server-side strategy telemetry. */
  POSTHOG_PROJECT_TOKEN?: string;
  /** PostHog ingestion host; defaults to the US cloud host. */
  POSTHOG_HOST?: string;
  /** Set to production in deployed environments to avoid dev-only configuration warnings. */
  ENVIRONMENT?: string;
  /**
   * Cloudflare subrequest cap per invocation. Workers Free allows 50; paid plans default to 10,000.
   * Set this to match the deployed plan so the pipeline budgets optional work correctly.
   */
  SUBREQUEST_LIMIT?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
