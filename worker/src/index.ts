// INDODAX QUANT — Cloudflare Worker entrypoint.
// fetch: REST API (/api/*) + static React dashboard (Workers Static Assets)
// scheduled: per-minute pipeline (Cron Trigger "* * * * *")
import type { Env } from './env';
import { handleApi } from './api';
import { runPipeline } from './pipeline';
import { errorMessage } from './http';
import { withIndodaxRelay } from './relay';
import { buildPipelinePostHogEvents, sendPostHogBatch } from './posthog';

const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env, withIndodaxRelay((i, init) => fetch(i, init), env.INDODAX_PROXY_URL, env.INDODAX_RELAY_HMAC_SECRET));
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
          fetchImpl: withIndodaxRelay((i, init) => fetch(i, init), env.INDODAX_PROXY_URL, env.INDODAX_RELAY_HMAC_SECRET),
        });
        console.log(`[cron] ${result.status}${result.reason ? ` (${result.reason})` : ''} run=${result.runId ?? '-'}`);
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
} satisfies ExportedHandler<Env>;
