import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/candles';
import {
  DEFAULT_MIN_NET_TARGET_PCT, computeStops, targetFeasibility, targetFeasibilityGate, trailUnit, trailingStop,
} from '../shared/paper';
import { DEFAULT_PARAMS, mergeParams, validateParams, type StrategyParams } from '../shared/strategy';
import { DEFAULT_FILL_MODEL, simulatePortfolio, type PortfolioPairInput } from '../shared/portfolioBacktest';

// scripts/backtest.ts fails fast on missing Supabase env at import time; the simulation itself is
// pure and never touches the network, so dummy values are enough here.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-key';
const { simulate } = await import('../scripts/backtest');

const P: StrategyParams = DEFAULT_PARAMS;
const TRAIL = { ...P, trailingStopEnabled: true };

/**
 * The audited defect, reproduced: a 0.12% ATR on a 1000 entry is 0.18% of price, below the 0.2%
 * minimum that makes an ATR stop meaningful, so `computeStops` falls back to the 2%/4% bracket.
 * The trail, sized off the raw 0.12% ATR, then described a different trade than the stop did.
 */
describe('trailing stop is sized off the bracket it governs', () => {
  const entry = 1000;
  const atr = 1.2; // 0.12% of price, BTC's median 5m ATR
  const stops = computeStops(entry, atr, P);
  const pos = { entry_price: entry, stop_loss: stops.stopLoss, take_profit: stops.takeProfit };

  it('the fixture really is the fallback bracket', () => {
    expect(stops.method).toBe('percent');
    expect(stops.stopLoss).toBeCloseTo(980, 10);
    expect(stops.takeProfit).toBeCloseTo(1040, 10);
  });

  it('derives the trail unit from the stop the position was given, not from the raw ATR', () => {
    // 2% stop / 1.5 = the 1.333% ATR that would have produced it: 11x the 0.12% ATR.
    expect(trailUnit(pos, atr, P)).toBeCloseTo(20 / 1.5, 10);
    // The ATR bracket keeps the raw ATR as its unit, so nothing changes for it.
    expect(trailUnit({ entry_price: 1000, stop_loss: 994, take_profit: 1012 }, 4, P)).toBeCloseTo(4, 10);
  });

  it('arms at one stop distance of profit instead of at 1.5 x a 0.12% ATR', () => {
    // Old unit (raw ATR): armed at 1000 + 1.5 x 1.2 = 1001.8, i.e. far below the 1006 break-even.
    // New unit: 1000 + 1.5 x 13.333 = 1020, exactly the 2% the position is risking.
    expect(trailingStop(pos, 1001.8, atr, TRAIL, 0.6)).toBeNull();
    expect(trailingStop(pos, 1019.99, atr, TRAIL, 0.6)).toBeNull();
    expect(trailingStop(pos, 1020, atr, TRAIL, 0.6)).toBeCloseTo(1006.6666667, 6);
  });

  it('no longer pins the stop at break-even: the first ratchet locks in real profit', () => {
    const stop = trailingStop(pos, 1020, atr, TRAIL, 0.6)!;
    expect(stop).toBeGreaterThan(entry * 1.006);
    expect((stop / entry - 1) * 100).toBeCloseTo(0.6667, 3);
    // The old arithmetic is still reachable for a position with no bracket left to read (null stop
    // and target), and shows what the defect did: it armed at 1001.8 and could only ratchet to
    // 0.08% above entry once price was already 0.8% up.
    expect(trailingStop({ entry_price: entry, stop_loss: null, take_profit: null }, 1008, atr, TRAIL, 0.6)).toBeCloseTo(1006.8, 6);
  });

  it('keeps the scale after the stop has ratcheted above entry', () => {
    // A ratcheted stop (above entry) can no longer report the bracket's risk, so the target does.
    const ratcheted = { entry_price: entry, stop_loss: 1010, take_profit: 1040 };
    expect(trailUnit(ratcheted, atr, P)).toBeCloseTo(40 / 3, 10);
    // 1025 - 13.333, not 1025 - 1.2: the trail does not collapse back onto the raw ATR.
    expect(trailingStop(ratcheted, 1025, atr, TRAIL, 0)).toBeCloseTo(1011.6666667, 6);
  });

  it('ratchets up only and never below the break-even floor', () => {
    // A candidate at or under the current stop is refused.
    expect(trailingStop({ ...pos, stop_loss: 1015 }, 1025, atr, TRAIL, 0)).toBeNull();
    // A candidate that still loses after the round trip is refused even when it is above the stop.
    expect(trailingStop({ entry_price: entry, stop_loss: 994, take_profit: 1012 }, 1010, 4, TRAIL, 0.6)).toBeNull();
    expect(trailingStop({ entry_price: entry, stop_loss: 994, take_profit: 1012 }, 1010.5, 4, TRAIL, 0.6)).toBeCloseTo(1006.5, 6);
  });

  it('leaves an ATR-bracket position on the numbers it had before', () => {
    const atrPos = { entry_price: 1000, stop_loss: 994, take_profit: 1012 };
    // Legacy formula: bid - trailDistanceAtr x atr.
    expect(trailingStop(atrPos, 1008, 4, TRAIL, 0)).toBeCloseTo(1008 - 1 * 4, 10);
    expect(trailingStop(atrPos, 1004, 4, TRAIL, 0)).toBeNull(); // below entry + 1.5 x ATR
    // A missing ATR still disables the trail (fail closed).
    expect(trailingStop(atrPos, 1100, null, TRAIL, 0)).toBeNull();
    expect(trailingStop(atrPos, 1100, 0, TRAIL, 0)).toBeNull();
  });
});

describe('pre-trade feasibility gate', () => {
  it('states the shortfall in percentage points', () => {
    const ok = targetFeasibility({ entry: 1000, takeProfit: 1040, feePct: 0.2, slippageBps: 10 });
    expect(ok.reason).toBeNull();
    expect(ok.grossTargetPct).toBeCloseTo(4, 10);
    expect(ok.roundTripCostPct).toBeCloseTo(0.6, 10);
    expect(ok.netTargetPct).toBeCloseTo(3.4, 10);
  });

  it('rejects a target that cannot pay for the round trip', () => {
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1006, feePct: 0.2, slippageBps: 10 })).toBe('target_below_round_trip_cost');
    expect(targetFeasibility({ entry: 1000, takeProfit: 1006, feePct: 0.2, slippageBps: 10 }).netTargetPct).toBeCloseTo(0, 10);
    // Paying exactly the round trip is still a loss of the risk taken: below the default margin.
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1006.5, feePct: 0.2, slippageBps: 10 })).toBe('target_net_below_minimum');
    // 0.71% gross - 0.6% cost = 0.11pp, just over the default 0.1pp margin.
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1007.1, feePct: 0.2, slippageBps: 10 })).toBeNull();
  });

  it('honours minNetTargetPct, including 0', () => {
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1006.5, feePct: 0.2, slippageBps: 10, minNetTargetPct: 0 })).toBeNull();
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1007.1, feePct: 0.2, slippageBps: 10, minNetTargetPct: 0.2 })).toBe('target_net_below_minimum');
    // A cost-free round trip still has to clear the margin.
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1000.5, feePct: 0, slippageBps: 0 })).toBe('target_net_below_minimum');
  });

  it('fails closed on a broken bracket', () => {
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 1000, feePct: 0.2, slippageBps: 10 })).toBe('invalid_target');
    expect(targetFeasibilityGate({ entry: 1000, takeProfit: 900, feePct: 0.2, slippageBps: 10 })).toBe('invalid_target');
    expect(targetFeasibilityGate({ entry: 0, takeProfit: 10, feePct: 0.2, slippageBps: 10 })).toBe('invalid_target');
  });

  it('ships a small non-zero default that is a valid parameter', () => {
    expect(DEFAULT_PARAMS.minNetTargetPct).toBe(DEFAULT_MIN_NET_TARGET_PCT);
    expect(DEFAULT_MIN_NET_TARGET_PCT).toBeGreaterThan(0);
    expect(validateParams({ minNetTargetPct: -0.1 })[0]).toMatch(/between/);
    expect(validateParams({ minNetTargetPct: 11 })[0]).toMatch(/between/);
    // A stored config without the key keeps the default.
    expect(mergeParams({}).minNetTargetPct).toBe(DEFAULT_MIN_NET_TARGET_PCT);
  });
});

/** Deterministic LCG fixture: a slow sine with noise, so signals fire on a mix of ATRs. */
function oscillator(n: number, seed = 1): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const price = 1000 * (1 + Math.sin((2 * Math.PI * i) / 45) * 0.02) * (1 + (rnd() - 0.5) * 0.002);
    const o = price * (1 - 0.0004);
    out.push({ t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996, c: price, v: 1000, n: 5, source: 'trades' });
  }
  return out;
}

const LOOSE: StrategyParams = mergeParams({
  ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
  useTrendFilter: false, maxEntryExtensionPct: 0, mtfMode: 'off', timeStopMinutes: 0, trailingStopEnabled: false,
});

/**
 * Both entry paths must run the gate: a margin no bracket can clear has to stop every entry in the
 * candle backtest and in the portfolio backtest, exactly as it does in the pipeline.
 */
describe('the gate is wired into both backtests', () => {
  it('blocks every entry in the single-pair backtest when no target can clear the margin', () => {
    const candles = oscillator(600);
    const open = simulate('xidr', candles, { ...LOOSE, minNetTargetPct: 0 }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(open.length).toBeGreaterThan(0);
    // A 10pp margin is unreachable for any bracket, so not one trade may open.
    const gated = simulate('xidr', candles, { ...LOOSE, minNetTargetPct: 10 }, 10_000_000, 5e9, 'crossover', 0, 0.2);
    expect(gated).toHaveLength(0);
  });

  it('records the rejection stage in the portfolio backtest', () => {
    const pairs: PortfolioPairInput[] = [{
      pair: 'aaa', candles: oscillator(600), volIdr: 5e9, pairTakerFeePct: 0.2, minNotional: 10_000,
    }];
    const signal = (_p: string, _c: Candle[], i: number) => (i % 5 === 0 ? 'BUY' as const : 'HOLD' as const);
    const gated = simulatePortfolio(pairs, { ...LOOSE, minNetTargetPct: 10 }, {
      initialCash: 10_000_000, signal, fillModel: DEFAULT_FILL_MODEL,
    });
    expect(gated.trades).toHaveLength(0);
    expect(gated.rejections.some((r) => r.stage === 'feasibility_gate')).toBe(true);
  });
});
