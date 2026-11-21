import type { Env, FetchLike } from './env';
import type { Db } from './db';
import { sendTelegram, telegramConfigured, type NotificationItem } from './telegram';
import { errorMessage } from './http';

const MAX_PER_RUN = 15;

export interface DispatchResult { claimed: number; sent: number; failed: number; skipped: number }

/**
 * Hand notifications to the queue so Telegram delivery stops spending the cron run's subrequest
 * budget. Falls back to an inline send when the binding is absent or the enqueue itself fails: a page
 * that never leaves the Worker is worse than one sent from the cron.
 */
export async function enqueueNotifications(
  env: Env,
  db: Db,
  items: NotificationItem[],
  fetchImpl: FetchLike = fetch,
): Promise<{ queued: number; inline: DispatchResult | null }> {
  if (items.length === 0) return { queued: 0, inline: null };
  const queue = env.NOTIFY_QUEUE;
  if (!queue) return { queued: 0, inline: await dispatchNotifications(env, db, items, fetchImpl) };
  try {
    await queue.sendBatch(items.map((body) => ({ body })));
    return { queued: items.length, inline: null };
  } catch (e) {
    console.error('notify queue enqueue failed, sending inline', errorMessage(e));
    return { queued: 0, inline: await dispatchNotifications(env, db, items, fetchImpl) };
  }
}

/** Claim (dedupe) in Postgres first, then send. A dedupe key is never sent twice. */
export async function dispatchNotifications(env: Env, db: Db, items: NotificationItem[], fetchImpl: FetchLike = fetch): Promise<DispatchResult> {
  if (items.length === 0) return { claimed: 0, sent: 0, failed: 0, skipped: 0 };
  const unique = [...new Map(items.map((i) => [i.dedupe_key, i])).values()];
  const claimed = await db.rpc<string[]>('claim_notifications', { p_items: unique });
  const claimedSet = new Set(claimed ?? []);
  const results: { dedupe_key: string; status: string; error: string | null }[] = [];
  let sent = 0, failed = 0, skipped = 0;
  for (const item of unique) {
    if (!claimedSet.has(item.dedupe_key)) continue;
    if (!telegramConfigured(env)) {
      results.push({ dedupe_key: item.dedupe_key, status: 'SKIPPED', error: 'telegram_not_configured' });
      skipped++;
      continue;
    }
    if (sent + failed >= MAX_PER_RUN) {
      results.push({ dedupe_key: item.dedupe_key, status: 'SKIPPED', error: 'per_run_cap' });
      skipped++;
      continue;
    }
    const r = await sendTelegram(env, item.message, fetchImpl);
    if (r.ok) sent++; else failed++;
    results.push({ dedupe_key: item.dedupe_key, status: r.ok ? 'SENT' : 'FAILED', error: r.ok ? null : r.error ?? null });
  }
  if (results.length) {
    try {
      await db.rpc('complete_notifications', { p_results: results });
    } catch (e) {
      console.error('complete_notifications failed', errorMessage(e));
    }
  }
  return { claimed: claimedSet.size, sent, failed, skipped };
}
