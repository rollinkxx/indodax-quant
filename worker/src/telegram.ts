// Telegram Bot API, called directly from the Worker. Token/chat id are Worker secrets.
import type { Env, FetchLike } from './env';
import { errorMessage, fetchWithRetry } from './http';

export interface NotificationItem {
  event_type: string;
  dedupe_key: string;
  message: string;
}

export function telegramConfigured(env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>): boolean {
  return !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID;
}

export async function sendTelegram(env: Pick<Env, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_CHAT_ID'>, text: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  if (!telegramConfigured(env)) return { ok: false, skipped: true, error: 'telegram_not_configured' };
  try {
    const res = await fetchWithRetry(fetchImpl, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }),
    }, { retries: 2, timeoutMs: 8000, maxDelayMs: 2500 });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    return body.ok ? { ok: true } : { ok: false, error: body.description ?? 'unknown_error' };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function idr(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 8;
  return 'Rp' + v.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function jakarta(d: Date | string | number = new Date()): string {
  return new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }) + ' WIB';
}

const pairLabel = (p: string) => p.toUpperCase().replace(/IDR$/, '/IDR');
const signed = (n: number) => (n >= 0 ? '+' : '') + idr(n).replace('Rp-', '-Rp');

export const messages = {
  signal(s: { pair_id: string; side: string; price: number | string; strength: number | string; reasons: string[]; candle_time: string }) {
    return [
      `${s.side === 'BUY' ? '🟢' : '🔴'} <b>SIGNAL ${s.side}</b> ${pairLabel(s.pair_id)} (5m)`,
      `Harga: <b>${idr(s.price)}</b> | Strength: ${Number(s.strength).toFixed(0)}`,
      ...s.reasons.map((r) => `• ${escapeHtml(r)}`),
      `Candle: ${jakarta(s.candle_time)}`,
    ].join('\n');
  },
  paperBuy(o: { pair_id: string; qty: number; fill: number; fee: number; stopLoss: number; takeProfit: number; cashAfter: number }) {
    return [
      `📥 <b>PAPER BUY</b> ${pairLabel(o.pair_id)} <i>(simulasi)</i>`,
      `Qty: ${o.qty} @ ${idr(o.fill)} | Fee ${idr(o.fee)}`,
      `SL: ${idr(o.stopLoss)} | TP: ${idr(o.takeProfit)}`,
      `Cash tersisa: ${idr(o.cashAfter)}`,
    ].join('\n');
  },
  paperSell(o: { pair_id: string; reason: string; qty: number; fill: number; pnl: number }) {
    const icon = o.reason === 'STOP_LOSS' ? '🛑' : o.reason === 'TAKE_PROFIT' ? '🎯' : '📤';
    const title = o.reason === 'STOP_LOSS' ? 'STOP LOSS' : o.reason === 'TAKE_PROFIT' ? 'TAKE PROFIT' : `PAPER SELL (${o.reason})`;
    return [
      `${icon} <b>${title}</b> ${pairLabel(o.pair_id)} <i>(simulasi)</i>`,
      `Qty: ${o.qty} @ ${idr(o.fill)}`,
      `Realized PnL: <b>${signed(o.pnl)}</b>`,
    ].join('\n');
  },
  killSwitch(reason: string, closed: number) {
    return `🚨 <b>KILL SWITCH AKTIF</b>\nAlasan: ${escapeHtml(reason)}\nPosisi ditutup: ${closed}\nPaper trading dihentikan sampai akun di-reset.`;
  },
  daily(d: { equity: number; pnl: number; pnlPct: number; trades: number; drawdown: number; status: string }) {
    return [
      `📊 <b>Laporan Harian Paper Trading</b>`,
      `Equity: <b>${idr(d.equity)}</b>`,
      `PnL 24 jam: <b>${signed(d.pnl)}</b> (${d.pnlPct.toFixed(2)}%)`,
      `Trade ditutup: ${d.trades} | Max DD: ${d.drawdown.toFixed(2)}%`,
      `Status: ${d.status}`,
    ].join('\n');
  },
  error(errors: string[]) {
    return `⚠️ <b>System error</b> (${jakarta()})\n` + errors.slice(0, 5).map((e) => `• ${escapeHtml(e.slice(0, 300))}`).join('\n');
  },
  universe(u: { added: string[]; removed: string[]; members: string[]; pinned: string[]; mode: string }) {
    const list = (ids: string[]) => ids.length ? ids.map(pairLabel).join(', ') : '—';
    return [
      `🧭 <b>Universe pair diperbarui</b> (${u.mode})`,
      ...(u.added.length ? [`Masuk: ${list(u.added)}`] : []),
      ...(u.removed.length ? [`Keluar: ${list(u.removed)}`] : []),
      `Dipantau manual: ${list(u.pinned)}`,
      `Otomatis (${u.members.length}): ${list(u.members)}`,
    ].join('\n');
  },
  heartbeat(h: { status: string; durationMs: number; pairs: number; accountStatus: string; equity: number | null }) {
    return [
      `✅ <b>Worker status</b> ${jakarta()}`,
      `Run terakhir: ${h.status} (${h.durationMs} ms) | Pairs: ${h.pairs}`,
      `Paper trading: ${h.accountStatus}${h.equity !== null ? ` | Equity ${idr(h.equity)}` : ''}`,
    ].join('\n');
  },
};
