import type { FetchLike } from './env';

export class HttpError extends Error {
  constructor(message: string, public status: number, public body?: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with per-attempt timeout, retry on network errors / 5xx / 429 and Retry-After support.
 * 4xx (other than 408/429) are not retried.
 */
export async function fetchWithRetry(fetchImpl: FetchLike, url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const base = opts.baseDelayMs ?? 400;
  const maxDelay = opts.maxDelayMs ?? 3000;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      const body = await res.text().catch(() => '');
      lastError = new HttpError(`HTTP ${res.status} for ${redact(url)}`, res.status, body.slice(0, 500));
      if (!retryable || attempt === retries) throw lastError;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : base * 2 ** attempt, maxDelay));
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof HttpError) {
        const retryable = e.status === 429 || e.status === 408 || e.status >= 500;
        if (!retryable || attempt === retries) throw e;
        continue;
      }
      lastError = e instanceof Error && e.name === 'AbortError' ? new HttpError(`Timeout after ${timeoutMs}ms for ${redact(url)}`, 408) : e;
      if (attempt === retries) throw lastError;
      await sleep(Math.min(base * 2 ** attempt, maxDelay));
    }
  }
  throw lastError;
}

/** Never leak bot tokens or keys into logs. */
export function redact(url: string): string {
  return url.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot***').replace(/(apikey=)[^&]+/gi, '$1***');
}

export function errorMessage(e: unknown): string {
  if (e instanceof HttpError) return `${e.message}${e.body ? `: ${e.body.slice(0, 200)}` : ''}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
