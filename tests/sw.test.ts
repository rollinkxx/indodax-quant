import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Loads public/sw.js in a sandbox with a fake service-worker global and returns its route() helper. */
function loadSw() {
  const listeners: Record<string, unknown> = {};
  const self: Record<string, unknown> = {
    location: { origin: 'https://app.example' },
    addEventListener: (type: string, fn: unknown) => { listeners[type] = fn; },
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL, caches: {}, fetch: () => { throw new Error('no network'); }, Response });
  const route = self.__iqRoute as (r: { method: string; url: string; mode?: string }) => string | null;
  return { route, listeners, src: readFileSync('public/sw.js', 'utf8') };
}

describe('service worker', () => {
  const { route, listeners, src } = loadSw();
  const req = (path: string, mode = 'cors', method = 'GET', origin = 'https://app.example') => ({ method, url: origin + path, mode });

  it('registers install, activate and fetch handlers', () => {
    expect(Object.keys(listeners).sort()).toEqual(['activate', 'fetch', 'install']);
  });

  it('never handles the API, non-GET or cross-origin requests', () => {
    expect(route(req('/api/portfolio'))).toBeNull();
    expect(route(req('/api/health', 'navigate'))).toBeNull();
    expect(route(req('/api'))).toBeNull();
    expect(route(req('/assets/index-abc.js', 'cors', 'POST'))).toBeNull();
    expect(route(req('/auth/v1/token', 'cors', 'GET', 'https://znikuooxiqfcicyuhqsx.supabase.co'))).toBeNull();
    expect(route(req('/sw.js'))).toBeNull();
  });

  it('uses network-first for navigations and cache-first for hashed assets', () => {
    expect(route(req('/', 'navigate'))).toBe('shell');
    expect(route(req('/paper', 'navigate'))).toBe('shell');
    expect(route(req('/assets/index-Df6dlSPj.js'))).toBe('cache-first');
    expect(route(req('/icons/icon.svg'))).toBe('swr');
    expect(route(req('/manifest.webmanifest'))).toBe('swr');
    expect(route(req('/index.html'))).toBeNull();
  });

  it('names its cache and deletes old ones on activate', () => {
    expect(src).toMatch(/const CACHE = 'iq-static-v\d+'/);
    expect(src).toContain('caches.delete');
  });
});
