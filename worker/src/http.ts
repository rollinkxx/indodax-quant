import type { FetchLike } from './env';

export class HttpError extends Error {
  constructor(message: string, public status: number, public body?: string, public attempts = 1) {
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
      lastError = new HttpError(`HTTP ${res.status} for ${redact(url)}`, res.status, redactBody(body), attempt + 1);
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
      lastError = e instanceof Error && e.name === 'AbortError' ? new HttpError(`Timeout after ${timeoutMs}ms for ${redact(url)}`, 408, undefined, attempt + 1) : e;
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

/**
 * Names whose values are secrets wherever they appear in an upstream response body.
 * Relay (Supabase Edge) and INDODAX errors can echo request headers, so a raw body is not safe to
 * persist or log: it may carry the service-role key, a bot token, or a session JWT.
 */
const SENSITIVE_KEYS = 'authorization|apikey|api_key|x-api-key|token|access_token|refresh_token|secret|password';

/**
 * Scrub credentials out of an arbitrary string (an HTTP error body).
 *
 * Two shapes are covered:
 * - `key=value` and `key: value` (JSON, form bodies, headers) -> value replaced with ***,
 * - a bearer/JWT blob anywhere -> ***.
 * The result is truncated to `max` so it stays log-sized.
 */
export function redactBody(body: string | undefined, max = 500): string | undefined {
  if (!body) return body;
  const scrubbed = body
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '***')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***')
    .replace(new RegExp(`(${SENSITIVE_KEYS})(["']?\\s*[=:]\\s*["']?)([^"',&}\\s]+)`, 'gi'), '$1$2***');
  return scrubbed.slice(0, max);
}

export function errorMessage(e: unknown): string {
  if (e instanceof HttpError) return `${e.message}${e.body ? `: ${e.body.slice(0, 200)}` : ''}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
