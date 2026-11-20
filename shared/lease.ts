// Pipeline lease: fencing token, heartbeat and owner-checked finish.
//
// The original lease was a bare `locked_until` timestamp owned by the run id. Two failures were
// possible: a run whose work outlived the TTL could keep mutating state after another run had taken
// the lock, and a stale owner could release a lease it no longer held. A monotonically increasing
// fencing token closes both: every renewal and every finish must present the token the lease was
// granted with, so a superseded owner can never write.

export interface LeaseGrant {
  owner: string;
  token: number;
  expiresAtMs: number;
}

export type LeaseDecision = { ok: true; lease: LeaseGrant } | { ok: false; reason: string };

/** TTL must exceed the worst-case runtime; a lease shorter than the work invites overlap. */
export function leaseTtlSeconds(p99RuntimeMs: number, headroomFactor = 2, floorSec = 55): number {
  const p99 = Number.isFinite(p99RuntimeMs) && p99RuntimeMs > 0 ? p99RuntimeMs : 0;
  return Math.max(floorSec, Math.ceil((p99 * headroomFactor) / 1000));
}

export function leaseExpired(lease: Pick<LeaseGrant, 'expiresAtMs'>, nowMs: number): boolean {
  return !Number.isFinite(lease.expiresAtMs) || nowMs >= lease.expiresAtMs;
}

/** A heartbeat is due once a third of the remaining TTL is left, so a missed beat still has slack. */
export function heartbeatDue(lease: Pick<LeaseGrant, 'expiresAtMs'>, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return true;
  return lease.expiresAtMs - nowMs <= ttlMs / 3;
}

/**
 * Apply a renewal response. A renewal only extends the lease when the presented token still matches,
 * which is what makes the token a fence rather than a label. The server's `reason` is preserved so a
 * caller can tell "my lease expired" (`lease_not_held`) from "another run took it" (token mismatch).
 */
export function applyRenewal(current: LeaseGrant, response: { ok: boolean; token?: number; expiresAtMs?: number; reason?: string }, nowMs: number): LeaseDecision {
  if (!response.ok) return { ok: false, reason: response.reason ?? 'lease_renewal_rejected' };
  if (response.token !== undefined && response.token !== current.token) {
    return { ok: false, reason: 'lease_token_mismatch' };
  }
  const expiresAtMs = Number.isFinite(response.expiresAtMs) ? (response.expiresAtMs as number) : current.expiresAtMs;
  if (expiresAtMs <= nowMs) return { ok: false, reason: 'lease_already_expired' };
  return { ok: true, lease: { ...current, expiresAtMs } };
}

/** Finish is only allowed for the run that still owns the fence. */
export function canFinish(lease: LeaseGrant, presented: { runId: string; token: number }): boolean {
  return lease.owner === presented.runId && lease.token === presented.token;
}

export class LeaseLostError extends Error {
  constructor(public reason: string) {
    super(`pipeline lease lost: ${reason}`);
    this.name = 'LeaseLostError';
  }
}

export interface LeaseKeeperDeps {
  runId: string;
  token: number;
  ttlSeconds: number;
  now: () => number;
  renew: (runId: string, token: number, ttlSeconds: number) => Promise<{ ok: boolean; token?: number; expiresAtMs?: number; reason?: string }>;
}

/**
 * Heartbeat keeper. `ensure()` is cheap when a beat is not due, and throws `LeaseLostError` the
 * moment the fence is lost so the caller stops before any order or state mutation.
 */
export function createLeaseKeeper(deps: LeaseKeeperDeps) {
  const ttlMs = deps.ttlSeconds * 1000;
  let lease: LeaseGrant = { owner: deps.runId, token: deps.token, expiresAtMs: deps.now() + ttlMs };
  let lost: string | null = null;

  async function renew(): Promise<void> {
    if (lost) throw new LeaseLostError(lost);
    const nowMs = deps.now();
    if (leaseExpired(lease, nowMs)) {
      lost = 'lease_expired_before_renewal';
      throw new LeaseLostError(lost);
    }
    const res = await deps.renew(lease.owner, lease.token, deps.ttlSeconds);
    const decision = applyRenewal(lease, res, deps.now());
    if (!decision.ok) {
      lost = decision.reason;
      throw new LeaseLostError(lost);
    }
    lease = decision.lease;
  }

  return {
    async ensure(): Promise<void> {
      if (lost) throw new LeaseLostError(lost);
      if (heartbeatDue(lease, deps.now(), ttlMs)) await renew();
    },
    async force(): Promise<void> {
      await renew();
    },
    snapshot(): LeaseGrant {
      return { ...lease };
    },
    get lostReason(): string | null {
      return lost;
    },
  };
}

export type LeaseKeeper = ReturnType<typeof createLeaseKeeper>;
