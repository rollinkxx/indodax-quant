import { describe, expect, it } from 'vitest';
import {
  applyRenewal, canFinish, createLeaseKeeper, heartbeatDue, leaseExpired, leaseTtlSeconds, LeaseLostError,
  type LeaseGrant,
} from '../shared/lease';

describe('lease TTL', () => {
  it('exceeds the p99 runtime with headroom and a floor', () => {
    expect(leaseTtlSeconds(20_000)).toBe(55); // 40s < 55s floor
    expect(leaseTtlSeconds(50_000)).toBe(100); // 2x p99
    expect(leaseTtlSeconds(0)).toBe(55);
  });

  it('detects expiry', () => {
    expect(leaseExpired({ expiresAtMs: 1000 }, 1000)).toBe(true);
    expect(leaseExpired({ expiresAtMs: 1001 }, 1000)).toBe(false);
  });

  it('asks for a heartbeat once a third of the TTL is left', () => {
    expect(heartbeatDue({ expiresAtMs: 1100 }, 1000, 300)).toBe(true);
    expect(heartbeatDue({ expiresAtMs: 1500 }, 1000, 300)).toBe(false);
  });
});

describe('lease renewal is fenced by the token', () => {
  const current: LeaseGrant = { owner: 'run-1', token: 7, expiresAtMs: 5000 };

  it('preserves the server reason so expired and stolen are distinguishable', () => {
    expect(applyRenewal(current, { ok: false, reason: 'lease_not_held' }, 1000))
      .toEqual({ ok: false, reason: 'lease_not_held' });
    expect(applyRenewal(current, { ok: false, reason: 'lease_token_mismatch' }, 1000))
      .toEqual({ ok: false, reason: 'lease_token_mismatch' });
    // No reason from the server still yields a generic, non-empty reason.
    expect(applyRenewal(current, { ok: false }, 1000)).toEqual({ ok: false, reason: 'lease_renewal_rejected' });
  });
  it('extends the lease on a matching token', () => {
    const r = applyRenewal(current, { ok: true, token: 7, expiresAtMs: 9000 }, 1000);
    expect(r.ok && r.lease.expiresAtMs).toBe(9000);
  });
  it('rejects a renewal that presents a different token', () => {
    expect(applyRenewal(current, { ok: true, token: 8, expiresAtMs: 9000 }, 1000)).toMatchObject({ ok: false, reason: 'lease_token_mismatch' });
  });
  it('rejects a renewal that has already expired', () => {
    expect(applyRenewal(current, { ok: true, token: 7, expiresAtMs: 500 }, 1000)).toMatchObject({ ok: false, reason: 'lease_already_expired' });
  });
  it('only lets the owning run finish', () => {
    expect(canFinish(current, { runId: 'run-1', token: 7 })).toBe(true);
    expect(canFinish(current, { runId: 'run-1', token: 8 })).toBe(false);
    expect(canFinish(current, { runId: 'run-2', token: 7 })).toBe(false);
  });
});

describe('lease keeper', () => {
  it('renews when due and throws LeaseLostError when the fence is lost', async () => {
    let now = 0;
    let calls = 0;
    const keeper = createLeaseKeeper({
      runId: 'run-1', token: 3, ttlSeconds: 60, now: () => now,
      renew: async (_runId, token) => { calls++; return { ok: true, token, expiresAtMs: now + 60_000 }; },
    });
    await keeper.ensure(); // heartbeat not due at t=0
    expect(calls).toBe(0);
    now = 50_000; // two thirds elapsed -> due
    await keeper.ensure();
    expect(calls).toBe(1);
    expect(keeper.lostReason).toBeNull();
  });

  it('stops once the lease has expired', async () => {
    let now = 0;
    const keeper = createLeaseKeeper({
      runId: 'run-1', token: 3, ttlSeconds: 10, now: () => now,
      renew: async () => ({ ok: true, token: 3, expiresAtMs: now + 10_000 }),
    });
    now = 20_000; // past the initial expiry
    await expect(keeper.ensure()).rejects.toBeInstanceOf(LeaseLostError);
    expect(keeper.lostReason).toBe('lease_expired_before_renewal');
  });

  it('stops when the renewal presents a different token (superseded owner)', async () => {
    let now = 0;
    const keeper = createLeaseKeeper({
      runId: 'run-1', token: 3, ttlSeconds: 60, now: () => now,
      renew: async () => ({ ok: true, token: 99, expiresAtMs: now + 60_000 }),
    });
    await expect(keeper.force()).rejects.toBeInstanceOf(LeaseLostError);
    expect(keeper.lostReason).toBe('lease_token_mismatch');
  });
});
