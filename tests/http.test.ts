import { describe, expect, it } from 'vitest';
import { errorMessage, fetchWithRetry, HttpError, redactBody } from '../worker/src/http';

describe('redactBody', () => {
  it('masks an apikey=... form field', () => {
    expect(redactBody('upstream said apikey=abc123&x=1')).toBe('upstream said apikey=***&x=1');
  });

  it('masks an authorization header value', () => {
    expect(redactBody('{"authorization":"Bearer xyz"}')).toBe('{"authorization":"***"}');
  });

  it('masks token / secret / password keys in JSON bodies', () => {
    const out = redactBody('{"token":"t0k","secret":"s3cr3t","password":"p@ss"}')!;
    expect(out).not.toContain('t0k');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('p@ss');
    expect(out.match(/\*\*\*/g)?.length).toBe(3);
  });

  it('masks a bare JWT even without a key name', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
    expect(redactBody(`oops ${jwt} oops`)).toBe('oops *** oops');
  });

  it('masks a standalone bearer token', () => {
    expect(redactBody('denied for Bearer abc.def.ghi')).toBe('denied for ***');
  });

  it('truncates to the log-sized limit', () => {
    expect(redactBody('x'.repeat(1000), 50)).toHaveLength(50);
  });
});

describe('HttpError keeps credentials out of logs', () => {
  it('stores and prints a redacted body', async () => {
    const fakeFetch = (async () => new Response('{"apikey":"abc123","authorization":"Bearer xyz"}', { status: 500 })) as unknown as typeof fetch;
    let err: unknown;
    try {
      await fetchWithRetry(fakeFetch, 'https://x/y', {}, { retries: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    const printed = errorMessage(err);
    expect(printed).not.toContain('abc123');
    expect(printed).not.toContain('xyz');
    expect((err as HttpError).body).not.toContain('abc123');
    expect((err as HttpError).body).not.toContain('xyz');
  });
});
