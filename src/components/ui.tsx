import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-line-strong sm:p-4">
      <div className="truncate text-xs font-medium uppercase tracking-wider text-subtle">{label}</div>
      <div className={`num mt-1.5 truncate text-base font-semibold leading-7 min-[400px]:text-lg sm:text-xl ${valueClass}`} title={typeof value === 'string' ? value : undefined}>{value}</div>
      <div className="num mt-1 min-h-4 truncate text-xs leading-4 text-muted">{sub}</div>
    </div>
  );
}

const badgeColors: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  red: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  yellow: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  blue: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  gray: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
};

export function Badge({ color = 'gray', children }: { color?: keyof typeof badgeColors | string; children: ReactNode }) {
  return (
    <span className={`inline-flex h-5 items-center whitespace-nowrap rounded-md px-2 text-xs font-medium leading-none ring-1 ring-inset ${badgeColors[color] ?? badgeColors.gray}`}>
      {children}
    </span>
  );
}

export function statusColor(s: string | undefined): string {
  switch (s) {
    case 'RUNNING': case 'SUCCESS': case 'SENT': case 'BUY': case 'TAKE_PROFIT': case 'ok': return 'green';
    case 'KILLED': case 'FAILED': case 'SELL': case 'STOP_LOSS': case 'MAX_DRAWDOWN': case 'KILL_SWITCH': return 'red';
    case 'PARTIAL': case 'SKIPPED': case 'PENDING': case 'STOPPED': return 'yellow';
    default: return 'gray';
  }
}

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app';

export function Button({ children, onClick, variant = 'default', disabled, loading = false, type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; variant?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean;
  /** Shows a shimmer and blocks clicks; the button keeps its width. */
  loading?: boolean; type?: 'button' | 'submit'; className?: string;
}) {
  const styles = {
    default: 'border border-line-strong bg-elevated text-fg hover:border-slate-600 hover:bg-slate-700',
    primary: 'bg-accent-strong text-accent-fg hover:bg-accent-hover',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'text-muted hover:bg-elevated hover:text-fg',
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} aria-busy={loading || undefined}
      className={`relative inline-flex h-9 items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-control px-3 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${focusRing} ${styles} ${className}`}>
      {children}
      {loading && <span aria-hidden="true" className="skeleton pointer-events-none absolute inset-0 rounded-none bg-transparent" />}
    </button>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex animate-fade-in items-start gap-2 rounded-control border border-rose-800/70 bg-rose-950/50 p-3 text-sm text-rose-200">
      <Icon name="alert" className="mt-0.5 size-4 text-rose-300" />
      <span className="min-w-0 break-words">{error}</span>
    </div>
  );
}

/** Placeholder block with a shimmer. Give it the size of the content it replaces. */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} style={style} />;
}

/** Loading state inside a card or table area: skeleton rows filling `height` px (default 160). */
export function Loading({ height = 160, rows }: { height?: number; rows?: number }) {
  const n = rows ?? Math.max(2, Math.floor(height / 36));
  return (
    <div role="status" aria-label="Memuat data" className="flex flex-col justify-center gap-3 py-2" style={{ minHeight: height }}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-5" style={{ width: `${[100, 92, 96, 84, 90, 78][i % 6]}%` }} />
      ))}
      <span className="sr-only">Memuat data…</span>
    </div>
  );
}

/** Whole-page loading state: header, four stat cards and a large card. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Memuat halaman" className="animate-fade-in">
      <div className="mb-5 space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-card" />)}
      </div>
      <Skeleton className="mt-4 h-[300px] rounded-card" />
      <span className="sr-only">Memuat data…</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-subtle">
      <Icon name="inbox" className="size-6 text-slate-600" />
      <div className="max-w-md">{children}</div>
    </div>
  );
}

/**
 * Data table. The header sticks while the table scrolls; pass `maxHeight` (px or CSS length) to scroll
 * long tables inside the card.
 */
export function Table({ head, children, maxHeight }: { head: ReactNode[]; children: ReactNode; maxHeight?: number | string }) {
  return (
    <div className="overflow-auto" style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wider text-subtle">
          <tr>{head.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-line px-3 py-2.5 font-medium first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5">{h}</th>)}</tr>
        </thead>
        <tbody className="num divide-y divide-line/70 [&>tr]:transition-colors [&>tr:hover]:bg-white/[0.03]">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5 ${className}`}>{children}</td>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="relative inline-flex min-w-0 max-w-full">
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`h-9 w-full min-w-0 max-w-full cursor-pointer appearance-none truncate rounded-control border border-line-strong bg-surface-2 py-0 pl-3 pr-9 text-sm text-fg transition-colors hover:border-slate-600 ${focusRing}`}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="chevronDown" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
}

/**
 * Modal confirm dialog. Locks the page scroll (<main> and body), traps Tab focus, closes on Escape / backdrop
 * click (unless busy) and returns focus to the trigger. Focus starts on "Batal" so Enter never confirms by accident.
 */
export function ConfirmDialog({ open, title, children, confirmLabel = 'OK', cancelLabel = 'Batal', variant = 'primary', busy = false, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel?: string; cancelLabel?: string;
  variant?: 'primary' | 'danger'; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const state = useRef({ busy, onCancel });
  state.current = { busy, onCancel };

  useEffect(() => {
    if (!open) return;
    const main = document.querySelector('main');
    const prevMain = main?.style.overflow ?? '';
    const prevBody = document.body.style.overflow;
    if (main) main.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !state.current.busy) { e.preventDefault(); state.current.onCancel(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (main) main.style.overflow = prevMain;
      document.body.style.overflow = prevBody;
      prevFocus?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-overlay backdrop-blur-[2px]" onClick={() => !busy && onCancel()} />
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={`${id}t`} aria-describedby={`${id}d`}
        className="relative w-full max-w-md animate-slide-up rounded-card border border-line-strong bg-surface-2 p-5 shadow-card">
        <div className="flex items-start gap-3">
          <span className={`grid size-10 shrink-0 place-items-center rounded-full ${variant === 'danger' ? 'bg-rose-500/15 text-rose-300' : 'bg-accent-soft text-accent'}`}>
            <Icon name={variant === 'danger' ? 'alert' : 'info'} className="size-5" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 id={`${id}t`} className="text-base font-semibold">{title}</h2>
            <div id={`${id}d`} className="mt-1.5 text-sm text-muted">{children}</div>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="default" onClick={onCancel} disabled={busy} className="sm:min-w-24">{cancelLabel}</Button>
          <Button variant={variant} onClick={onConfirm} loading={busy} className="sm:min-w-28">{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Segmented control (radio group). Arrow keys move the selection; only the active option is in the Tab order.
 * Every option uses the same font weight so the control never changes width. `scroll` lets a long list scroll sideways.
 */
export function Segmented({ value, onChange, options, label, scroll = false, className = '' }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: ReactNode }[]; label: string; scroll?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir || !options.length) return;
    e.preventDefault();
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const next = options[(i + dir + options.length) % options.length];
    onChange(next.value);
    requestAnimationFrame(() => {
      const btn = ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`);
      btn?.focus();
      btn?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} onKeyDown={onKey}
      className={`inline-flex h-9 max-w-full items-center gap-0.5 rounded-control border border-line-strong bg-surface-2 p-0.5 ${scroll ? 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : ''} ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={active} tabIndex={active ? 0 : -1} data-value={o.value}
            onClick={() => onChange(o.value)}
            className={`h-full shrink-0 whitespace-nowrap rounded-[0.5rem] px-3 text-sm font-medium transition-colors duration-150 ${focusRing} ${active ? 'bg-elevated text-fg shadow-card' : 'text-muted hover:text-fg'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Search field with an icon. */
export function SearchInput({ value, onChange, placeholder = 'Cari…', label, className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; label?: string; className?: string;
}) {
  return (
    <div className={`relative inline-flex min-w-0 ${className}`}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label ?? placeholder}
        className={`h-9 w-full min-w-0 rounded-control border border-line-strong bg-surface-2 pl-9 pr-3 text-sm text-fg placeholder:text-subtle transition-colors hover:border-slate-600 ${focusRing}`} />
    </div>
  );
}
