/* INDODAX QUANT service worker — caches static assets only (hand-written, no build plugin).
 *
 * - Never touches /api/*, non-GET requests or cross-origin requests (Supabase auth, INDODAX relay).
 * - Navigations: network-first; the cached app shell is only an offline fallback, so a deploy is never stuck on an old bundle.
 * - Hashed /assets/*: cache-first (file names change on every build).
 * - Icons / manifest: stale-while-revalidate.
 * Bump CACHE when this file's behaviour changes; old caches are deleted on activate.
 */
const CACHE = 'iq-static-v1';
const SHELL = '/'; // Workers Static Assets redirects /index.html to /
const PRECACHE = [SHELL, '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => undefined).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('iq-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheable = (res) => res && res.ok && res.type === 'basic' && !res.redirected;

async function put(req, res) {
  try {
    const c = await caches.open(CACHE);
    await c.put(req, res);
  } catch {
    /* quota or private mode: ignore */
  }
}

async function networkFirstShell(request) {
  try {
    const res = await fetch(request);
    if (cacheable(res)) put(SHELL, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(SHELL);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (cacheable(res)) put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then((res) => {
      if (cacheable(res)) put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await network) || Response.error();
}

/** Exported for tests: which strategy handles a request (null = not handled, browser default). */
function route(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null;
  if (url.pathname === '/sw.js') return null;
  if (request.mode === 'navigate') return 'shell';
  if (url.pathname.startsWith('/assets/')) return 'cache-first';
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') return 'swr';
  return null;
}
self.__iqRoute = route;

self.addEventListener('fetch', (event) => {
  const r = route(event.request);
  if (r === 'shell') event.respondWith(networkFirstShell(event.request));
  else if (r === 'cache-first') event.respondWith(cacheFirst(event.request));
  else if (r === 'swr') event.respondWith(staleWhileRevalidate(event.request));
});
