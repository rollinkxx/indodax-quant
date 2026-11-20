// Counts and caps outbound requests so the pipeline can spend its subrequest budget deliberately.
//
// Cloudflare caps subrequests per invocation (50 on the Free plan). The failure mode is nasty: the
// error surfaces on whichever step happens to run when the budget runs out, so the *last* steps -
// store_market, analyze, finish_run - die after the expensive work was already done, and the run
// looks hung until the lease watchdog kills it.
//
// Counting alone is not enough, because one logical call can retry (fetchWithRetry does 3 attempts).
// A pair that fails upstream therefore costs 3 subrequests, and N failing pairs exhaust the budget
// even though the pre-call estimate said there was room. So optional work gets a *child* scope with
// a hard cap: once it is spent the child throws instead of stealing from the reserved core steps.
export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

export interface Budget {
  /** fetch() with the same signature; counts every attempt, including retries. */
  fetch: typeof fetch;
  used: () => number;
  remaining: () => number;
  /** A scope that may spend at most `maxCalls` subrequests, then throws BudgetExceeded. */
  child: (maxCalls: number) => { fetch: typeof fetch; used: () => number; exhausted: () => boolean };
}

export function createBudget(inner: typeof fetch, limit: number): Budget {
  let used = 0;

  // async so a rejection behaves like the real fetch: callers that `await` inside try/catch see it.
  const parentFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (used >= limit) throw new BudgetExceeded(`subrequest budget exhausted (${used}/${limit})`);
    used++;
    return inner(input as never, init as never);
  }) as typeof fetch;

  return {
    fetch: parentFetch,
    used: () => used,
    remaining: () => Math.max(0, limit - used),
    child: (maxCalls: number) => {
      let childUsed = 0;
      const childFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (childUsed >= maxCalls) throw new BudgetExceeded(`optional subrequest budget spent (${childUsed}/${maxCalls})`);
        childUsed++;
        return parentFetch(input as never, init as never);
      }) as typeof fetch;
      return { fetch: childFetch, used: () => childUsed, exhausted: () => childUsed >= maxCalls };
    },
  };
}
