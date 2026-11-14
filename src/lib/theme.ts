import { useSyncExternalStore } from 'react';

/**
 * Light/dark theme. The preference is stored in localStorage ('light' | 'dark'); no stored value = follow the system.
 * index.html applies the same logic in an inline script before first paint (no flash); keep both in sync.
 */
export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'iq-theme';
const META = { dark: '#020617', light: '#f8fafc' } as const;

const listeners = new Set<() => void>();
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export const resolveTheme = (p: ThemePref): Theme => (p === 'system' ? (media()?.matches ?? true ? 'dark' : 'light') : p);

export function applyTheme(p: ThemePref = getThemePref()) {
  const t = resolveTheme(p);
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.style.colorScheme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META[t]);
  listeners.forEach((f) => f());
}

export function setThemePref(p: ThemePref) {
  try {
    if (p === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch { /* storage unavailable: apply for this session only */ }
  applyTheme(p);
}

let watching = false;
/** Re-apply when the OS theme changes while the preference is "system", and when another tab changes it. */
export function watchSystemTheme() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  media()?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) applyTheme(); });
}

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => `${getThemePref()}:${typeof document !== 'undefined' && !document.documentElement.classList.contains('dark') ? 'light' : 'dark'}`;

/** Current preference and the resolved theme; re-renders when either changes. */
export function useTheme(): { pref: ThemePref; theme: Theme } {
  const [pref, theme] = useSyncExternalStore(subscribe, snapshot, () => 'system:dark').split(':') as [ThemePref, Theme];
  return { pref, theme };
}
