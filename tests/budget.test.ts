import { describe, expect, it } from 'vitest';
import { BudgetExceeded, createBudget } from '../worker/src/budget';
import { parseSubrequestLimit } from '../worker/src/pipeline';

const ok = async () => new Response('ok');

describe('subrequest budget', () => {
  it('counts every attempt, not just successful calls', async () => {
    const b = createBudget(ok as any, 10);
    await b.fetch('https://x/1');
    await b.fetch('https://x/2');
    expect(b.used()).toBe(2);
    expect(b.remaining()).toBe(8);
  });

  it('throws instead of silently exceeding the limit', async () => {
    const b = createBudget(ok as any, 2);
    await b.fetch('https://x/1');
    await b.fetch('https://x/2');
    await expect(b.fetch('https://x/3')).rejects.toBeInstanceOf(BudgetExceeded);
    expect(b.used()).toBe(2);
  });

  it('gives a child scope its own hard cap and reports exhaustion', async () => {
    const b = createBudget(ok as any, 100);
    const child = b.child(2);
    await child.fetch('https://x/1');
    await child.fetch('https://x/2');
    expect(child.exhausted()).toBe(true);
    await expect(child.fetch('https://x/3')).rejects.toBeInstanceOf(BudgetExceeded);
    // The child's spend still counts against the parent, so the reserve is real.
    expect(b.used()).toBe(2);
  });

  it('keeps the parent usable after a child is exhausted', async () => {
    const b = createBudget(ok as any, 10);
    const child = b.child(1);
    await child.fetch('https://x/1');
    await expect(child.fetch('https://x/2')).rejects.toBeInstanceOf(BudgetExceeded);
    // Core steps must still be able to run.
    await expect(b.fetch('https://core')).resolves.toBeInstanceOf(Response);
    expect(b.used()).toBe(2);
  });

  it('parses the configured limit and falls back to the free-plan default', () => {
    expect(parseSubrequestLimit('1000')).toBe(1000);
    expect(parseSubrequestLimit(undefined)).toBe(50);
    expect(parseSubrequestLimit('nope')).toBe(50);
    expect(parseSubrequestLimit('-5')).toBe(50);
    expect(parseSubrequestLimit('0')).toBe(50);
  });
});
