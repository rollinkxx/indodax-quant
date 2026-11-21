// Out-of-band pipeline watchdog.
//
// The outage alarm used to ride on the per-minute cron run, so it only fired while the pipeline was
// still being invoked. When the cron stopped calling the Worker at all (a stuck lock, a deploy, a
// broken trigger) nothing paged. This Durable Object owns its own alarm, so it keeps checking
// independently of the cron: it wakes, asks the same `last_success_at` question, and re-arms itself.
import type { Env } from './env';
import { Db } from './db';
import { outageAlarmNote } from './pipeline';
import { dispatchNotifications } from './notify';
import { errorMessage } from './http';

/** How often the watchdog looks. Five minutes keeps the free-tier DO duration budget negligible. */
export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

export class PipelineWatchdog {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Called by the cron (and by a manual poke) to make sure the alarm is pending. */
  async fetch(): Promise<Response> {
    const at = await this.arm();
    return new Response(JSON.stringify({ armed_at: at }), { headers: { 'content-type': 'application/json' } });
  }

  /** Arm the alarm only when nothing is pending, so a chatty cron cannot keep pushing it back. */
  async arm(now: number = Date.now()): Promise<number> {
    const existing = await this.state.storage.getAlarm();
    if (existing !== null) return existing;
    const at = now + WATCHDOG_INTERVAL_MS;
    await this.state.storage.setAlarm(at);
    return at;
  }

  async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      console.error('[watchdog] tick failed', errorMessage(e));
    } finally {
      // Re-arm unconditionally: a throwing tick must not silently stop the watchdog.
      await this.state.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    }
  }

  /** One check. Returns what it did so tests and logs can assert on it. */
  async tick(now: number = Date.now()): Promise<{ alerted: boolean; reason?: string }> {
    const db = new Db(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY, fetch);
    const nowSec = Math.floor(now / 1000);
    const note = await outageAlarmNote(db, nowSec, Math.floor(nowSec / 60) * 60);
    if (!note) return { alerted: false, reason: 'fresh' };
    const r = await dispatchNotifications(this.env, db, [note]);
    return { alerted: r.sent > 0, reason: r.sent > 0 ? 'paged' : 'not_sent' };
  }
}
