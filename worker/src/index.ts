// INDODAX QUANT — Cloudflare Worker entrypoint.
// fetch: REST API (/api/*) + static React dashboard (Workers Static Assets)
// scheduled: per-minute pipeline (Cron Trigger "* * * * *")
import type { Env } from './env';
import { handleApi } from './api';
import { runPipeline } from './pipeline';
import { errorMessage } from './http';

const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await handleApi(request, env);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env, { scheduledTime: controller.scheduledTime, trigger: 'cron' })
        .then((r) => console.log(`[cron] ${r.status}${r.reason ? ` (${r.reason})` : ''} run=${r.runId ?? '-'}`))
        .catch((e) => console.error('[cron] fatal', errorMessage(e))),
    );
  },
} satisfies ExportedHandler<Env>;
