import { describe, expect, it } from 'vitest';
import { selectUniverse, spreadPct, universeDue, type UniverseInput, type UniverseTicker } from '../shared/universe';
import { DEFAULT_PARAMS, mergeParams, validateParams } from '../shared/strategy';

const NOW = 1_800_000_000;
const tk = (pair_id: string, vol: number, spread = 0.1, age = 10): UniverseTicker => {
  const bid = 1000;
  return { pair_id, bid, ask: bid * (1 + spread / 100), vol_idr: vol, server_time: NOW - age };
};

const base = (over: Partial<UniverseInput> = {}): UniverseInput => {
  const tickers = over.tickers ?? [
    tk('btcidr', 90e9), tk('ethidr', 50e9), tk('pepeidr', 40e9), tk('usdtidr', 80e9), tk('wifidr', 20e9),
    tk('bonkidr', 10e9), tk('arbidr', 5e9), tk('lowidr', 1e8), tk('wideidr', 30e9, 2), tk('staleidr', 30e9, 0.1, 3600),
    tk('btcusdt', 99e9),
  ];
  return {
    tickers,
    known: new Set(tickers.map((t) => t.pair_id).concat(['maintidr'])),
    maintenance: new Set(['maintidr']),
    pinned: new Set(['btcidr']),
    current: new Set(),
    nowSec: NOW,
    params: { ...DEFAULT_PARAMS, universeSize: 4, universeMaxNewPerUpdate: 10, universeBuffer: 1 },
    ...over,
  };
};

describe('selectUniverse', () => {
  it('ranks eligible pairs by 24h IDR volume and fills the slots left by pinned pairs', () => {
    const r = selectUniverse(base());
    expect(r.members.map((m) => m.pair_id)).toEqual(['ethidr', 'pepeidr', 'wifidr']);
    expect(r.members.map((m) => m.rank)).toEqual([1, 2, 3]);
    expect(r.added).toEqual(['ethidr', 'pepeidr', 'wifidr']);
  });

  it('filters stablecoins, low volume, wide spread, stale tickers, non-IDR and maintenance pairs', () => {
    const r = selectUniverse(base({ tickers: [...base().tickers, tk('maintidr', 99e9)] }));
    const ids = r.members.map((m) => m.pair_id);
    for (const bad of ['usdtidr', 'lowidr', 'wideidr', 'staleidr', 'btcusdt', 'maintidr']) expect(ids).not.toContain(bad);
    expect(r.rejected).toMatchObject({ excluded: 1, low_volume: 1, wide_spread: 1, stale_ticker: 1, not_idr: 1, maintenance: 1 });
  });

  it('pairs missing from the catalog are skipped (foreign keys)', () => {
    const b = base();
    b.known.delete('ethidr');
    expect(selectUniverse(b).members.map((m) => m.pair_id)).not.toContain('ethidr');
  });

  it('hysteresis keeps a member inside slots + buffer', () => {
    // bonkidr is rank 4 (slots 3 + buffer 1) -> stays; arbidr rank 5 -> dropped
    const r = selectUniverse(base({ current: new Set(['bonkidr', 'arbidr']) }));
    expect(r.members.map((m) => m.pair_id)).toContain('bonkidr');
    expect(r.removed).toEqual(['arbidr']);
  });

  it('caps new entries per update', () => {
    const r = selectUniverse(base({ params: { ...DEFAULT_PARAMS, universeSize: 6, universeMaxNewPerUpdate: 2, universeBuffer: 0 } }));
    expect(r.added).toHaveLength(2);
    expect(r.members.map((m) => m.pair_id)).toEqual(['ethidr', 'pepeidr']);
  });

  it('members that become ineligible are removed', () => {
    const r = selectUniverse(base({ current: new Set(['lowidr', 'ethidr']) }));
    expect(r.removed).toEqual(['lowidr']);
    expect(r.added).not.toContain('ethidr');
  });

  it('manual mode clears all dynamic members', () => {
    const r = selectUniverse(base({ current: new Set(['ethidr']), params: { ...DEFAULT_PARAMS, universeMode: 'manual' } }));
    expect(r.members).toEqual([]);
    expect(r.removed).toEqual(['ethidr']);
  });

  it('no free slots when pinned pairs already fill the universe', () => {
    const r = selectUniverse(base({ params: { ...DEFAULT_PARAMS, universeSize: 1 } }));
    expect(r.members).toEqual([]);
  });

  it('spreadPct', () => {
    expect(spreadPct(99, 101)).toBeCloseTo(2, 6);
    expect(spreadPct(0, 0)).toBe(Infinity);
  });
});

describe('universeDue', () => {
  it('runs every 15 minutes, immediately when empty, and once to clear after switching to manual', () => {
    const q = 1_800_000_000 - (1_800_000_000 % 900);
    expect(universeDue(q, 5, 'dynamic')).toBe(true);
    expect(universeDue(q + 60, 5, 'dynamic')).toBe(false);
    expect(universeDue(q + 60, 0, 'dynamic')).toBe(true);
    expect(universeDue(q + 60, 3, 'manual')).toBe(true);
    expect(universeDue(q + 60, 0, 'manual')).toBe(false);
  });
});

describe('MTF + universe parameters', () => {
  it('accept valid values', () => {
    expect(validateParams({ mtfMode: 'score', universeMode: 'manual', universeSize: 20, universeExclude: ['usdtidr'], notifyUniverse: false })).toEqual([]);
  });
  it('reject invalid values', () => {
    expect(validateParams({ mtfMode: 'yes' })[0]).toContain('mtfMode');
    expect(validateParams({ universeMode: 'auto' })[0]).toContain('universeMode');
    expect(validateParams({ universeSize: 26 })[0]).toContain('universeSize');
    expect(validateParams({ universeExclude: ['BAD PAIR'] })[0]).toContain('universeExclude');
    expect(validateParams({ universeExclude: 'usdtidr' })[0]).toContain('universeExclude');
    expect(validateParams({ mtfEmaFast: 30, mtfEmaSlow: 21 })).toContain('mtfEmaFast must be smaller than mtfEmaSlow');
    expect(validateParams({ mtfMinCandles: 15 })).toContain('mtfMinCandles must exceed mtfEmaSlow by at least 2');
  });
  it('stored configs without the new keys get the defaults (MTF filter + dynamic universe)', () => {
    const p = mergeParams({ emaFast: 9, emaSlow: 21 });
    expect(p).toMatchObject({ mtfMode: 'filter', universeMode: 'dynamic', universeSize: 12 });
    expect(p.universeExclude).toContain('usdtidr');
  });
  it('invalid stored values fall back per key', () => {
    expect(mergeParams({ mtfMode: 'bogus', universeSize: 3 })).toMatchObject({ mtfMode: 'filter', universeSize: 3 });
  });
});
