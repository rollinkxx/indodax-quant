import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, statusColor } from './ui';
import { Icon, type IconName } from './Icon';
import { killSwitchOutcome } from '../lib/killSwitchOutcome';
import { post } from '../lib/api';
import { idr, num, pairLabel, pct, pnlClass, wib } from '../lib/format';

/* ------------------------------------------------------------------ */
/* Mini equity curve: static inline SVG (no chart library, no animation). */
/* ------------------------------------------------------------------ */

const W = 300;
const H = 100;

export function Sparkline({ values, className = '', height = 72 }: { values: number[]; className?: string; height?: number }) {
  const gid = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (values.length < 2) {
    return (
      <div className="flex items-center justify-center rounded-control border border-dashed border-line text-xs text-subtle" style={{ height }}>
        Belum ada snapshot portfolio
      </div>
    );
  }
  const step = Math.max(1, Math.ceil(values.length / 160));
  const pts = values.filter((_, i) => i % step === 0 || i === values.length - 1);
  let min = Infinity; let max = -Infinity;
  for (const v of pts) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || Math.max(Math.abs(max) * 0.001, 1);
  const n = pts.length - 1;
  const xy = pts.map((v, i) => `${((i / n) * W).toFixed(2)},${(H - 4 - ((v - min) / range) * (H - 8)).toFixed(2)}`);
  const line = `M${xy.join('L')}`;
  const area = `${line}L${W},${H}L0,${H}Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className={`block w-full ${className}`} style={{ height }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Hero equity card                                                     */
/* ------------------------------------------------------------------ */

function Chip({ icon, label, value, valueClass = '' }: { icon: IconName; label: string; value: string; valueClass?: string }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface-2 px-2.5 text-xs">
      <Icon name={icon} className="size-3.5 text-subtle" />
      <span className="text-muted">{label}</span>
      <span className={`num font-medium ${valueClass}`}>{value}</span>
    </span>
  );
}

export function EquityHero({ account, curve, className = '' }: { account: any; curve: number[]; className?: string }) {
  const equity = Number(account.equity);
  const initial = Number(account.initial_balance);
  const peak = Number(account.peak_equity);
  const ret = initial > 0 ? (equity / initial - 1) * 100 : null;
  const dd = peak > 0 ? Math.max(0, (peak - equity) / peak) * 100 : null;
  const up = (ret ?? 0) >= 0;
  return (
    <section className={`relative min-w-0 overflow-hidden rounded-card border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      <div aria-hidden="true" className={`pointer-events-none absolute -right-16 -top-20 size-56 rounded-full blur-3xl ${up ? 'bg-emerald-500/10' : 'bg-rose-500/10'}`} />
      <div className="relative flex min-h-8 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Equity simulasi</h2>
        <Badge color={statusColor(account.status)}>{account.status}</Badge>
      </div>
      <div className="relative mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="num text-3xl font-semibold tracking-tight sm:text-4xl">{idr(equity)}</span>
        <span className={`num inline-flex items-center gap-1 text-sm font-medium ${pnlClass(ret)}`}>
          <Icon name={up ? 'trendUp' : 'trendDown'} className="size-4" />
          {pct(ret)} <span className="font-normal text-subtle">({idr(equity - initial, { sign: true })})</span>
        </span>
      </div>
      <div className="relative mt-3 flex flex-wrap gap-2">
        <Chip icon="trendDown" label="Drawdown" value={pct(dd, 2, false)} valueClass={dd ? 'text-down' : ''} />
        <Chip icon="shield" label="Max DD" value={pct(account.max_drawdown_pct, 2, false)} />
        <Chip icon="wallet" label="Modal" value={idr(initial)} />
      </div>
      <div className={`relative mt-4 ${up ? 'text-up' : 'text-down'}`}>
        <Sparkline values={curve} />
      </div>
      <div className="num relative mt-2 flex justify-between gap-2 text-[11px] text-subtle">
        <span className="truncate">Peak {idr(peak)}</span>
        <span className="truncate">Diperbarui {wib(account.updated_at)}</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Open position card with SL → TP progress                             */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function RangeBar({ sl, tp, entry, last }: { sl: number; tp: number; entry: number; last: number }) {
  const valid = Number.isFinite(sl) && Number.isFinite(tp) && tp > sl;
  if (!valid) return <div className="h-2 rounded-full bg-elevated" title="Stop loss / take profit belum diatur" />;
  const e = clamp01((entry - sl) / (tp - sl)) * 100;
  const c = clamp01(((Number.isFinite(last) ? last : entry) - sl) / (tp - sl)) * 100;
  const gain = c >= e;
  return (
    <div className="relative h-2 rounded-full bg-elevated" role="img"
      aria-label={`Harga di ${c.toFixed(0)}% rentang stop loss ke take profit`}>
      <div className="absolute inset-y-0 left-0 w-1/2 rounded-l-full bg-linear-to-r from-rose-500/25 to-transparent" />
      <div className="absolute inset-y-0 right-0 w-1/2 rounded-r-full bg-linear-to-l from-emerald-500/25 to-transparent" />
      <div className={`absolute inset-y-0 rounded-full ${gain ? 'bg-up' : 'bg-down'}`} style={{ left: `${Math.min(e, c)}%`, width: `${Math.abs(c - e)}%` }} />
      <div className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-muted" style={{ left: `${e}%` }} title="Entry" />
      <div className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface-2 ${gain ? 'bg-up' : 'bg-down'}`} style={{ left: `${c}%` }} />
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[11px] uppercase tracking-wider text-subtle">{label}</div>
      <div className="num mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

export function PositionCard({ p }: { p: any }) {
  const pnl = Number(p.unrealized_pnl);
  const cost = Number(p.cost_basis);
  const pnlPct = cost > 0 ? (pnl / cost) * 100 : null;
  return (
    <article className="min-w-0 rounded-card border border-line bg-surface-2 p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/chart?pair=${p.pair_id}`} className="rounded font-semibold hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {pairLabel(p.pair_id)}
          </Link>
          <div className="num mt-0.5 truncate text-xs text-subtle">Dibuka {wib(p.opened_at)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`num text-sm font-semibold ${pnlClass(pnl)}`}>{idr(pnl, { sign: true })}</div>
          <div className={`num text-xs ${pnlClass(pnl)}`}>{pct(pnlPct)}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Entry">{idr(p.entry_price)}</Field>
        <Field label="Harga kini" className="text-right">{idr(p.last_price)}</Field>
        <Field label="Modal">{idr(p.cost_basis)}</Field>
        <Field label="Qty" className="text-right">{num(p.qty, 8)}</Field>
      </div>
      <div className="mt-4">
        <RangeBar sl={Number(p.stop_loss ?? NaN)} tp={Number(p.take_profit ?? NaN)} entry={Number(p.entry_price)} last={Number(p.last_price)} />
        <div className="num mt-2 flex justify-between gap-3 text-xs">
          <span className="truncate text-down">SL {idr(p.stop_loss)}</span>
          <span className="truncate text-right text-up">TP {idr(p.take_profit)}</span>
        </div>
      </div>
    </article>
  );
}

export function PositionGrid({ positions, narrow = false }: { positions: any[]; /** Max two columns (grid sits in a 2/3-width card). */ narrow?: boolean }) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 ${narrow ? '' : 'xl:grid-cols-3'}`}>
      {positions.map((p) => <PositionCard key={p.id} p={p} />)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Admin controls with a confirm dialog (same API calls as before)      */
/* ------------------------------------------------------------------ */

type Action = 'start' | 'stop' | 'kill' | 'reset';

const ACTIONS: Record<Action, {
  label: string; icon: IconName; variant: 'primary' | 'default' | 'danger' | 'ghost'; confirmVariant: 'primary' | 'danger';
  title: string; body: string; confirm: string; path: string; payload?: unknown;
}> = {
  start: {
    label: 'Start', icon: 'play', variant: 'primary', confirmVariant: 'primary', path: '/api/paper/start',
    title: 'Mulai automated paper trading?', confirm: 'Ya, mulai',
    body: 'Sistem akan membuka posisi simulasi baru saat sinyal BUY lolos entry gate dan cek risiko.',
  },
  stop: {
    label: 'Stop', icon: 'stop', variant: 'default', confirmVariant: 'primary', path: '/api/paper/stop',
    title: 'Hentikan entry baru?', confirm: 'Ya, hentikan',
    body: 'Tidak ada posisi baru yang dibuka. Stop loss dan take profit posisi terbuka tetap aktif.',
  },
  kill: {
    label: 'Kill switch', icon: 'power', variant: 'danger', confirmVariant: 'danger', path: '/api/paper/kill',
    title: 'Aktifkan kill switch?', confirm: 'Ya, kill',
    body: 'Semua posisi terbuka ditutup di harga bid dan akun dikunci (status KILLED).',
  },
  reset: {
    label: 'Reset', icon: 'refresh', variant: 'ghost', confirmVariant: 'danger', path: '/api/paper/reset',
    payload: { initialBalance: 10_000_000 },
    title: 'Reset akun ke Rp10.000.000?', confirm: 'Ya, reset',
    body: 'Saldo virtual kembali ke Rp10.000.000. Riwayat posisi dan order tetap disimpan.',
  },
};

function disabledFor(a: Action, status: string): boolean {
  switch (a) {
    case 'start': return status === 'RUNNING';
    case 'stop': return status !== 'RUNNING';
    case 'kill': return status === 'KILLED';
    case 'reset': return status === 'RUNNING';
  }
}

export function PaperControls({ status, onResult }: { status: string; onResult: (r: { msg?: string; err?: string }) => Promise<void> | void }) {
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const cfg = pending ? ACTIONS[pending] : null;

  const run = async () => {
    if (!pending) return;
    const a = pending;
    setBusy(a);
    try {
      const r = await post(ACTIONS[a].path, ACTIONS[a].payload);
      setPending(null);
      if (a === 'kill') {
        await onResult(killSwitchOutcome(r));
      } else {
        await onResult({ msg: r?.status ? `OK: ${r.status}` : 'OK' });
      }
    } catch (e) {
      setPending(null);
      await onResult({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(ACTIONS) as Action[]).map((a) => (
          <Button key={a} variant={ACTIONS[a].variant} loading={busy === a} disabled={!!busy || disabledFor(a, status)}
            onClick={() => setPending(a)} className="w-full">
            <Icon name={ACTIONS[a].icon} className="size-4" />{ACTIONS[a].label}
          </Button>
        ))}
      </div>
      <ConfirmDialog open={!!cfg} title={cfg?.title ?? ''} confirmLabel={cfg?.confirm ?? 'OK'} variant={cfg?.confirmVariant}
        busy={!!busy} onConfirm={run} onCancel={() => setPending(null)}>
        {cfg?.body}
      </ConfirmDialog>
    </>
  );
}

export const STATUS_HELP: Record<string, string> = {
  RUNNING: 'Entry otomatis aktif. Posisi baru dibuka saat sinyal BUY lolos semua cek.',
  STOPPED: 'Tidak ada entry baru. Stop loss dan take profit tetap melindungi posisi terbuka.',
  KILLED: 'Akun dikunci oleh kill switch. Reset akun untuk memulai lagi.',
};
