// INDODAX QUANT — Cloudflare Worker entrypoint.
// fetch: REST API (/api/*) + static React dashboard (Workers Static Assets)
// scheduled: per-minute pipeline (Cron Trigger "* * * * *")
import type { Env } from './env';
import { handleApi } from './api';
import { runPipeline } from './pipeline';
import { errorMessage } from './http';
import { withIndodaxRelay } from './relay';
import { buildPipelinePostHogEvents, sendPostHogBatch } from './posthog';
import { Db } from './db';
import { dispatchNotifications } from './notify';
import type { NotificationItem } from './telegram';
import { PipelineWatchdog } from './watchdog';

export { PipelineWatchdog };

const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env, withIndodaxRelay((i, init) => fetch(i, init), env.INDODAX_PROXY_URL, env.SUPABASE_SERVICE_ROLE_KEY));
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      try {
        const result = await runPipeline(env, {
          scheduledTime: controller.scheduledTime,
          trigger: 'cron',
          fetchImpl: withIndodaxRelay((i, init) => fetch(i, init), env.INDODAX_PROXY_URL, env.SUPABASE_SERVICE_ROLE_KEY),
        });
        console.log(`[cron] ${result.status}${result.reason ? ` (${result.reason})` : ''} run=${result.runId ?? '-'}`);
        // Keep the out-of-band watchdog armed. Best effort: a missing binding or a DO hiccup must not
        // fail the run, because the run itself already carries the in-band outage alarm.
        if (env.WATCHDOG) {
          try {
            const stub = env.WATCHDOG.get(env.WATCHDOG.idFromName('pipeline'));
            await stub.fetch('https://watchdog.internal/arm');
          } catch (e) {
            console.error('[watchdog] arm failed', errorMessage(e));
          }
        }
        await sendPostHogBatch(env, buildPipelinePostHogEvents(result, 'cron', Date.now() - startedAt));
      } catch (e) {
        console.error('[cron] fatal', errorMessage(e));
        await sendPostHogBatch(env, [{
          event: 'trading_pipeline_fatal_error',
          properties: {
            service: 'indodax-quant',
            trigger: 'cron',
            error_type: e instanceof Error ? e.name : 'UnknownError',
          },
          timestamp: new Date().toISOString(),
        }]);
      }
    })());
  },

  /**
   * Notification consumer. The cron enqueues pages instead of sending them, so Telegram delivery no
   * longer competes for the run's subrequest budget. Dedupe still happens in Postgres
   * (`claim_notifications`), so a redelivered batch cannot page twice.
   */
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const items = batch.messages
      .map((m) => m.body as NotificationItem | null)
      .filter((b): b is NotificationItem => !!b?.dedupe_key);
    if (items.length === 0) {
      for (const m of batch.messages) m.ack();
      return;
    }
    try {
      const db = new Db(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, withIndodaxRelay((i, init) => fetch(i, init), env.INDODAX_PROXY_URL, env.SUPABASE_SERVICE_ROLE_KEY));
      const r = await dispatchNotifications(env, db, items);
      console.log(`[queue] notifications claimed=${r.claimed} sent=${r.sent} failed=${r.failed} skipped=${r.skipped}`);
      for (const m of batch.messages) m.ack();
    } catch (e) {
      // Only infrastructure failures (DB unreachable) land here; a Telegram error is recorded as
      // FAILED inside dispatchNotifications and must not be retried, because the dedupe claim is
      // already spent and the retry would be dropped anyway.
      console.error('[queue] notification dispatch failed', errorMessage(e));
      for (const m of batch.messages) m.retry();
    }
  },
} satisfies ExportedHandler<Env>;
