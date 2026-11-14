import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Badge } from './ui';
import { Icon, type IconName } from './Icon';
import { usePoll } from '../lib/usePoll';
import { setThemePref, useTheme } from '../lib/theme';

interface NavItem { to: string; label: string; icon: IconName }

const GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Pasar', items: [
    { to: '/', label: 'Overview', icon: 'home' },
    { to: '/market', label: 'Market Monitor', icon: 'market' },
    { to: '/chart', label: 'Trading Chart', icon: 'chart' },
  ] },
  { label: 'Trading', items: [
    { to: '/signals', label: 'Trading Signals', icon: 'signal' },
    { to: '/paper', label: 'Paper Trading', icon: 'wallet' },
    { to: '/history', label: 'Trading History', icon: 'history' },
  ] },
  { label: 'Sistem', items: [
    { to: '/strategy', label: 'Strategy Config', icon: 'sliders' },
    { to: '/system', label: 'System Monitoring', icon: 'activity' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];
const ALL = GROUPS.flatMap((g) => g.items);

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-accent-strong text-accent-fg shadow-card">
        <Icon name="trendUp" className="size-4" />
      </span>
      <div className="leading-tight">
        <div className="text-sm font-bold tracking-tight">INDODAX <span className="text-accent">QUANT</span></div>
        <div className="text-[11px] text-subtle">Paper trading • simulasi</div>
      </div>
    </div>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Menu utama" className="flex flex-col gap-5 px-3 py-4">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{g.label}</div>
          <div className="flex flex-col gap-0.5">
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={onNavigate}
                className={({ isActive }) => `group relative flex h-9 items-center gap-3 rounded-control px-3 text-sm transition-colors ${focusRing} ${isActive ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:bg-elevated hover:text-fg'}`}>
                {({ isActive }) => (
                  <>
                    <span aria-hidden="true" className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`} />
                    <Icon name={n.icon} className={`size-4 transition-colors ${isActive ? 'text-accent' : 'text-subtle group-hover:text-muted'}`} />
                    <span className="truncate">{n.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** Cron status from the existing /api/system endpoint (1 run, every 60 s). */
function LiveStatus() {
  const { data, error } = usePoll<{ healthy: boolean; lastRunAgeSeconds: number | null }>('/api/system?limit=1', 60000);
  const state = error ? 'down' : !data ? 'wait' : data.healthy ? 'ok' : 'down';
  const age = data?.lastRunAgeSeconds;
  const text = state === 'wait' ? 'Memeriksa…' : state === 'ok' ? 'Live' : 'Bermasalah';
  const title = error ? `Status tidak terbaca: ${error}`
    : age != null ? `Cron terakhir ${Math.round(age)} detik lalu` : 'Belum ada run cron';
  const dot = { ok: 'bg-up', down: 'bg-down', wait: 'bg-subtle' }[state];
  return (
    <div title={title} role="status" aria-label={`Status sistem: ${text}. ${title}`}
      className="flex h-8 w-8 shrink-0 items-center justify-center gap-2 rounded-full border border-line bg-surface-2 text-xs text-muted sm:w-[7.5rem] sm:justify-start sm:px-3">
      <span className="relative flex size-2">
        {state === 'ok' && <span className="absolute inset-0 animate-ping rounded-full bg-up opacity-60 motion-reduce:hidden" />}
        <span className={`relative size-2 rounded-full ${dot}`} />
      </span>
      <span className="hidden truncate sm:inline">{text}</span>
      {age != null && state !== 'wait' && <span className="num ml-auto hidden text-subtle sm:inline">{age < 60 ? `${Math.round(age)}d` : `${Math.round(age / 60)}m`}</span>}
    </div>
  );
}

function ThemeToggle() {
  const { theme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap';
  return (
    <button type="button" onClick={() => setThemePref(next)} aria-label={label} title={label}
      className={`grid size-9 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-elevated hover:text-fg ${focusRing}`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="size-[18px]" />
    </button>
  );
}

function UserMenu({ email, role, onLogout }: { email: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="Menu akun"
        className={`flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 pl-1 pr-2 text-muted transition-colors hover:border-line-strong hover:text-fg ${focusRing}`}>
        <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-xs font-semibold uppercase text-accent">{email.charAt(0)}</span>
        <Icon name="chevronDown" className={`size-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 origin-top-right animate-slide-up rounded-card border border-line-strong bg-surface-2 p-1.5 shadow-card">
          <div className="px-3 py-2.5">
            <div className="truncate text-sm font-medium text-fg">{email}</div>
            <div className="mt-1.5"><Badge color={role === 'admin' ? 'blue' : 'gray'}>{role}</Badge></div>
          </div>
          <div className="my-1 h-px bg-line" />
          <button role="menuitem" onClick={() => { setOpen(false); onLogout(); }}
            className={`flex h-9 w-full items-center gap-2.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-elevated hover:text-fg ${focusRing}`}>
            <Icon name="logout" className="size-4" /> Keluar
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout({ children, email, role, onLogout }: { children: ReactNode; email: string; role: string; onLogout: () => void }) {
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const openBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const current = ALL.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to))) ?? ALL[0];

  // New page: close the drawer and start at the top.
  useEffect(() => { setDrawer(false); mainRef.current?.scrollTo({ top: 0 }); }, [pathname]);

  // Drawer focus: move into the drawer when it opens, back to the menu button when it closes (the page behind is inert meanwhile).
  useEffect(() => {
    if (drawer) closeBtnRef.current?.focus();
    else if (wasOpen.current) openBtnRef.current?.focus({ preventScroll: true });
    wasOpen.current = drawer;
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    // The drawer only exists below md; close it if the window grows past that so the page never stays inert.
    const mq = matchMedia('(min-width: 768px)');
    const onMq = () => { if (mq.matches) setDrawer(false); };
    document.addEventListener('keydown', onKey);
    mq.addEventListener('change', onMq);
    return () => { document.removeEventListener('keydown', onKey); mq.removeEventListener('change', onMq); };
  }, [drawer]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-sidebar md:flex">
        <div className="flex h-14 items-center border-b border-line px-5"><Brand /></div>
        <div className="min-h-0 flex-1 overflow-y-auto"><Nav /></div>
        <div className="border-t border-line px-5 py-3 text-[11px] leading-4 text-subtle">
          Data publik INDODAX • tanpa API trading
        </div>
      </aside>

      {/* Mobile drawer (always mounted so it can slide; inert while closed) */}
      <div className={`fixed inset-0 z-50 md:hidden ${drawer ? '' : 'pointer-events-none'}`} inert={!drawer || undefined}>
        <div onClick={() => setDrawer(false)} aria-hidden="true"
          className={`absolute inset-0 bg-overlay transition-opacity duration-200 ${drawer ? 'opacity-100' : 'opacity-0'}`} />
        <aside role="dialog" aria-modal="true" aria-label="Menu"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-app shadow-card transition-transform duration-250 ease-out ${drawer ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex h-14 items-center justify-between border-b border-line pl-5 pr-3">
            <Brand />
            <button ref={closeBtnRef} onClick={() => setDrawer(false)} aria-label="Tutup menu"
              className={`grid size-9 place-items-center rounded-control text-muted hover:bg-elevated hover:text-fg ${focusRing}`}>
              <Icon name="x" className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><Nav onNavigate={() => setDrawer(false)} /></div>
        </aside>
      </div>

      <div className="flex min-w-0 flex-1 flex-col" inert={drawer || undefined}>
        <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-header px-3 backdrop-blur sm:px-4 md:px-6">
          <button ref={openBtnRef} onClick={() => setDrawer(true)} aria-label="Buka menu" aria-expanded={drawer}
            className={`grid size-9 shrink-0 place-items-center rounded-control text-muted hover:bg-elevated hover:text-fg md:hidden ${focusRing}`}>
            <Icon name="menu" className="size-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Icon name={current.icon} className="hidden size-4 text-accent sm:block" />
            <span className="truncate text-sm font-semibold">{current.label}</span>
          </div>
          <LiveStatus />
          <ThemeToggle />
          <UserMenu email={email} role={role} onLogout={onLogout} />
        </header>
        <div className="flex h-7 shrink-0 items-center justify-center gap-1.5 border-b border-amber-900/50 bg-amber-950/30 px-3 text-[11px] text-amber-300">
          <Icon name="info" className="size-3.5" />
          <span className="truncate"><b className="font-semibold">PAPER TRADING</b> — semua transaksi simulasi<span className="hidden sm:inline">. Tidak ada order sungguhan ke INDODAX</span>.</span>
        </div>
        <main ref={mainRef} className={`min-h-0 flex-1 [scrollbar-gutter:stable] ${drawer ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          <div key={pathname} className="mx-auto max-w-7xl animate-fade-in p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
