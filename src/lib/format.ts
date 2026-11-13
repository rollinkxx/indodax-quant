export const TZ = 'Asia/Jakarta';

export function idr(v: unknown, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 8;
  const s = opts.compact && abs >= 1e6
    ? new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 2 }).format(abs)
    : abs.toLocaleString('id-ID', { maximumFractionDigits: digits });
  const sign = n < 0 ? '-' : opts.sign && n > 0 ? '+' : '';
  return `${sign}Rp${s}`;
}

export function num(v: unknown, digits = 2): string {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('id-ID', { maximumFractionDigits: digits });
}

export function pct(v: unknown, digits = 2, sign = true): string {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return '—';
  return `${sign && n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** All timestamps are stored in UTC and displayed in WIB. */
export function wib(v: unknown, withSeconds = false): string {
  if (!v) return '—';
  const d = new Date(typeof v === 'number' ? v * 1000 : String(v));
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('id-ID', {
    timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  }) + ' WIB';
}

export function ago(v: unknown): string {
  if (!v) return '—';
  const s = Math.round((Date.now() - new Date(String(v)).getTime()) / 1000);
  if (s < 60) return `${s}d lalu`;
  if (s < 3600) return `${Math.floor(s / 60)}m lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)}j lalu`;
  return `${Math.floor(s / 86400)}h lalu`;
}

export const pairLabel = (p: string) => p.toUpperCase().replace(/IDR$/, '/IDR');

export const pnlClass = (v: unknown) => (Number(v) > 0 ? 'text-emerald-400' : Number(v) < 0 ? 'text-rose-400' : 'text-slate-300');
