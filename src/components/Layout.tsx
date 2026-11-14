import { useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Badge } from './ui';

const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/market', label: 'Market Monitor' },
  { to: '/chart', label: 'Trading Chart' },
  { to: '/signals', label: 'Trading Signals' },
  { to: '/paper', label: 'Paper Trading' },
  { to: '/history', label: 'Trading History' },
  { to: '/strategy', label: 'Strategy Config' },
  { to: '/system', label: 'System Monitoring' },
  { to: '/settings', label: 'Settings' },
];

export function Layout({ children, email, role, onLogout }: { children: ReactNode; email: string; role: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen md:flex">
      <aside className={`${open ? 'block' : 'hidden'} border-b border-slate-800 bg-slate-950 md:block md:min-h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r`}>
        <div className="hidden px-5 py-5 md:block">
          <div className="text-lg font-bold tracking-tight">INDODAX <span className="text-emerald-400">QUANT</span></div>
          <div className="mt-1 text-xs text-slate-500">Paper trading • simulasi saja</div>
        </div>
        <nav className="flex flex-col gap-0.5 px-3 pb-4">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}
              className={({ isActive }) => `rounded-lg px-3 py-2 text-sm ${isActive ? 'bg-emerald-500/10 font-medium text-emerald-300' : 'text-slate-300 hover:bg-slate-900'}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400">
          <div className="truncate">{email}</div>
          <div className="mt-1 flex items-center justify-between">
            <Badge color={role === 'admin' ? 'blue' : 'gray'}>{role}</Badge>
            <button onClick={onLogout} className="text-slate-400 hover:text-white">Keluar</button>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur md:hidden">
          <div className="font-bold">INDODAX <span className="text-emerald-400">QUANT</span></div>
          <button onClick={() => setOpen(!open)} className="rounded-md border border-slate-700 px-3 py-1 text-sm">Menu</button>
        </header>
        <div className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-1.5 text-center text-xs text-amber-300">
          Mode PAPER TRADING — semua transaksi adalah simulasi internal. Tidak ada order sungguhan ke INDODAX.
        </div>
        <main className="mx-auto max-w-7xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
