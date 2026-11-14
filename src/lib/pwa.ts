/**
 * Registers the hand-written service worker (public/sw.js) in production builds only, so `npm run dev` is never cached.
 * The worker caches static assets only (never /api/*); see public/sw.js.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* unsupported or blocked: the dashboard works without it */
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
