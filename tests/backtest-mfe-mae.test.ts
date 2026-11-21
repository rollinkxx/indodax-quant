import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, mergeParams, type StrategyParams } from '../shared/strategy';
import type { Candle } from '../shared/candles';
import type { SimTrade } from '../scripts/backtest';

// scripts/backtest.ts fails fast on missing Supabase env at import time; the simulation
// itself is pure and never touches the network, so dummy values are enough here.
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'test-key';
const { excursionPercentiles, measure, simulate } = await import('../scripts/backtest');

/** Loosest possible BUY gate, MTF pinned off: isolates the 5m crossover engine. */
const LOOSE: StrategyParams = mergeParams({
  ...DEFAULT_PARAMS, rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0,
  useTrendFilter: false, maxEntryExtensionPct: 0, mtfMode: 'off',
});

/** Deterministic LCG so the fixtures never depend on Math.random or the clock. */
function oscillator(n: number, periodBars: number, amp: number, seed = 1): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const wave = Math.sin((2 * Math.PI * i) / periodBars) * amp;
    const price = 1000 * (1 + wave) * (1 + (rnd() - 0.5) * 0.001);
    const o = price * (1 - 0.0004);
    out.push({
      t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996,
      c: price, v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades',
    });
  }
  return out;
}

/** Sine pair with a slow amplitude envelope, so calm stretches (stops) and wild ones (targets) mix. */
function modulated(n: number, seed = 7): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const amp = 0.004 + 0.022 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / 900));
    const wave = Math.sin((2 * Math.PI * i) / 45) + 0.35 * Math.sin((2 * Math.PI * i) / 17);
    const price = 1000 * (1 + wave * amp) * (1 + (rnd() - 0.5) * 0.002);
    const o = price * (1 - 0.0004);
    out.push({
      t: i * 300, o, h: Math.max(o, price) * (1 + amp * 0.15), l: Math.min(o, price) * (1 - amp * 0.15),
      c: price, v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades',
    });
  }
  return out;
}

function run(candles: Candle[], params: StrategyParams): SimTrade[] {
  return simulate('xidr', candles, params, 10_000_000, 5e9, 'crossover', 0, 0.2);
}

const round6 = (x: number) => Number(x.toFixed(6));
/** The PnL-relevant identity of a trade. Excursion fields are deliberately excluded here. */
const coreOf = (t: SimTrade) => [
  t.entryTime, t.exitTime, t.reason, round6(t.entry), round6(t.exit), round6(t.pnl), round6(t.cost),
];
const digestOf = (trades: SimTrade[]) =>
  createHash('sha256').update(JSON.stringify(trades.map(coreOf))).digest('hex');

const reasonHistogram = (trades: SimTrade[]) => trades.reduce<Record<string, number>>((counts, t) => {
  counts[t.reason] = (counts[t.reason] ?? 0) + 1;
  return counts;
}, {});

const netPnlOf = (trades: SimTrade[]) => round6(trades.reduce((sum, t) => sum + t.pnl, 0));

describe('excursionPercentiles', () => {
  it('interpolates linearly at p50/p75/p90/p95', () => {
    expect(excursionPercentiles([1, 2, 3, 4, 5])).toEqual({ p50: 3, p75: 4, p90: 4.6, p95: 4.8 });
  });

  it('is order independent and monotone', () => {
    const values = [4.2, 0.1, 9.9, 1.5, 3.3, 0, 7.7];
    expect(excursionPercentiles(values)).toEqual(excursionPercentiles([...values].reverse()));
    const { p50, p75, p90, p95 } = excursionPercentiles(values);
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p90);
    expect(p90).toBeLessThanOrEqual(p95);
  });

  it('reports 0 for an empty sample and the value itself for a single observation', () => {
    expect(excursionPercentiles([])).toEqual({ p50: 0, p75: 0, p90: 0, p95: 0 });
    expect(excursionPercentiles([2.5])).toEqual({ p50: 2.5, p75: 2.5, p90: 2.5, p95: 2.5 });
  });

  it('rounds to 3dp and ignores non-finite samples', () => {
    expect(excursionPercentiles([1 / 3]).p50).toBe(0.333);
    expect(excursionPercentiles([1, Number.NaN, 3])).toEqual({ p50: 2, p75: 2.5, p90: 2.8, p95: 2.9 });
  });
});

describe('per-trade MFE/MAE', () => {
  const candles = modulated(5000);
  const params: StrategyParams = { ...LOOSE, atrTakeProfitMultiplier: 3 };

  it('measures the excursion over exactly the bars the trade was held', () => {
    const trades = run(candles, params);
    expect(trades.length).toBeGreaterThan(0);
    for (const trade of trades) {
      // Recompute from the candles independently of the implementation: the holding window is
      // the entry bar through the exit bar, observed bars only (synthetic/zero-volume bars are
      // skipped by the simulation and therefore cannot contribute an excursion either).
      const held = candles.filter((c) =>
        c.t >= trade.entryTime && c.t <= trade.exitTime && c.source !== 'synthetic' && c.v > 0);
      expect(held.length).toBeGreaterThan(0);
      const high = Math.max(...held.map((c) => c.h));
      const low = Math.min(...held.map((c) => c.l));
      expect(trade.mfePct).toBeCloseTo((high - trade.entry) / trade.entry * 100, 10);
      expect(trade.maePct).toBeCloseTo((trade.entry - low) / trade.entry * 100, 10);
    }
  });

  it('reports both excursions as non-negative magnitudes with a consistent target flag', () => {
    for (const trade of run(candles, params)) {
      expect(trade.mfePct).toBeGreaterThanOrEqual(0);
      expect(trade.maePct).toBeGreaterThanOrEqual(0);
      expect(trade.tpDistancePct).toBeGreaterThan(0);
      expect(trade.reachedTakeProfit).toBe(trade.mfePct >= trade.tpDistancePct);
    }
  });

  it('counts every take-profit exit as having reached its own target', () => {
    const takeProfits = run(candles, params).filter((t) => t.reason === 'TAKE_PROFIT');
    expect(takeProfits.length).toBeGreaterThan(0);
    for (const trade of takeProfits) expect(trade.mfePct).toBeGreaterThanOrEqual(trade.tpDistancePct);
  });

  it('records excursions for a position closed at the end of the data', () => {
    const trades = run(candles, { ...LOOSE, atrTakeProfitMultiplier: 10 });
    const last = trades[trades.length - 1];
    expect(last.reason).toBe('END_OF_DATA');
    expect(last.mfePct).toBeGreaterThan(0);
    expect(last.maePct).toBeGreaterThan(0);
    expect(Number.isFinite(last.tpDistancePct)).toBe(true);
  });
});

describe('per-variant summary', () => {
  it('reports MFE/MAE percentiles and the share of trades that reached their target', () => {
    const trades = run(modulated(5000), { ...LOOSE, atrTakeProfitMultiplier: 3 });
    const metrics = measure(trades);
    expect(metrics.mfePct).toEqual(excursionPercentiles(trades.map((t) => t.mfePct)));
    expect(metrics.maePct).toEqual(excursionPercentiles(trades.map((t) => t.maePct)));
    const reached = trades.filter((t) => t.reachedTakeProfit).length;
    expect(metrics.takeProfitReached).toBe(reached);
    expect(metrics.takeProfitReachPct).toBe(Number((reached / trades.length * 100).toFixed(2)));
    // p90 of MFE is what answers "how far do winners actually run"; it must be finite and
    // no smaller than the median, or the summary is lying about the sample.
    expect(metrics.mfePct.p90).toBeGreaterThanOrEqual(metrics.mfePct.p50);
    expect(metrics.maePct.p90).toBeGreaterThanOrEqual(metrics.maePct.p50);
  });

  it('reports zeroed percentiles rather than NaN when there are no trades', () => {
    expect(measure([]).mfePct).toEqual({ p50: 0, p75: 0, p90: 0, p95: 0 });
    expect(measure([]).takeProfitReachPct).toBe(0);
  });
});

/**
 * Behaviour-unchanged proof. Each golden below was captured from the simulator BEFORE the
 * MFE/MAE instrumentation was added, on the same deterministic fixtures. If instrumentation
 * ever leaks into entries, exits, sizing, fees or slippage, these assertions fail.
 *
 * Re-captured once, deliberately: the trailing stop is now sized off the position's own bracket
 * (`trailUnit`) instead of the raw ATR, so the exit price of every TRAILING_STOP moved. The trade
 * count, the exit-reason histogram and every non-trailing exit are unchanged; the signal-exit
 * fixture (trailing disabled) still hashes to its original digest.
 */
describe('behaviour unchanged by the instrumentation', () => {
  it('reproduces every trade of the mixed-exit fixture exactly', () => {
    const trades = run(modulated(5000), { ...LOOSE, atrTakeProfitMultiplier: 3 });
    expect(trades.map(coreOf)).toEqual([
      [41100, 43800, 'TRAILING_STOP', 1011.081756, 1017.100723, 4852.731918, 2504999.999996],
      [53700, 56100, 'TAKE_PROFIT', 995.568641, 1019.106122, 49011.182639, 2506215.61297],
      [67500, 72900, 'TRAILING_STOP', 1010.76324, 1019.044941, 10499.062066, 2518492.90863],
      [81600, 83100, 'TAKE_PROFIT', 1007.206398, 1031.250312, 49879.334893, 2521122.92415],
      [94200, 96900, 'TAKE_PROFIT', 998.741173, 1021.417615, 47181.969216, 2533617.697877],
      [108300, 114600, 'STOP_LOSS', 1011.584192, 998.511941, -42923.657748, 2545436.780179],
      [311100, 312600, 'TAKE_PROFIT', 1007.813553, 1029.816993, 44999.963072, 2534684.405742],
      [323700, 326400, 'TAKE_PROFIT', 999.047792, 1022.082334, 48303.008596, 2545956.896508],
      [337800, 344100, 'STOP_LOSS', 1013.835282, 999.194285, -47005.741972, 2558056.798655],
      [351600, 352800, 'TAKE_PROFIT', 1004.068912, 1027.846656, 49893.967526, 2546281.863166],
      [364200, 367200, 'TAKE_PROFIT', 1001.275935, 1023.905641, 47385.098087, 2558780.30505],
      [378300, 384900, 'STOP_LOSS', 1011.710534, 997.758921, -45570.147328, 2570650.269569],
      [581400, 582900, 'TAKE_PROFIT', 1010.993715, 1032.47645, 43947.915866, 2559234.942737],
      [593700, 596700, 'TAKE_PROFIT', 1002.249429, 1025.451701, 49003.667509, 2570243.901699],
      [607800, 614400, 'STOP_LOSS', 1013.001544, 998.215062, -47855.243186, 2582519.318578],
      [621900, 623400, 'TAKE_PROFIT', 1008.586678, 1031.889385, 48891.683584, 2570531.57778],
      [634200, 637800, 'TAKE_PROFIT', 1003.640164, 1026.451625, 48158.429683, 2582778.948677],
      [648300, 655200, 'STOP_LOSS', 1009.368914, 994.726684, -47850.009013, 2594842.636103],
      [851100, 852300, 'TAKE_PROFIT', 1001.49277, 1022.902481, 44684.557994, 2582856.203851],
      [863700, 867000, 'TAKE_PROFIT', 1003.903354, 1027.149302, 49471.408551, 2594049.683342],
      [877800, 884700, 'STOP_LOSS', 1009.981396, 994.816894, -49383.516029, 2606442.275482],
      [891600, 892800, 'TAKE_PROFIT', 999.764601, 1023.043376, 49804.328938, 2594071.70648],
      [904200, 908400, 'TAKE_PROFIT', 1005.491888, 1028.710756, 49544.866037, 2606547.688709],
      [918600, 925200, 'STOP_LOSS', 1011.122965, 997.096166, -46641.375481, 2618958.675218],
      [1121100, 1122300, 'TAKE_PROFIT', 1000.508797, 1021.521865, 44132.108542, 2607275.011353],
      [1133700, 1137600, 'TAKE_PROFIT', 1006.0428, 1029.485154, 50315.164238, 2618330.108486],
      [1148100, 1154700, 'STOP_LOSS', 1014.426089, 998.088025, -52706.672193, 2630934.059543],
      [1161300, 1162800, 'TAKE_PROFIT', 995.276191, 1018.718124, 50959.771254, 2617731.031495],
      [1174500, 1179900, 'TRAILING_STOP', 1008.901688, 1017.035133, 10620.587407, 2630496.454312],
      [1188600, 1195200, 'STOP_LOSS', 1009.489628, 996.807754, -43459.005732, 2633156.911165],
      [1390800, 1392300, 'TAKE_PROFIT', 995.643376, 1016.749852, 44899.012756, 2622270.429732],
      [1404000, 1409100, 'TRAILING_STOP', 1010.440639, 1019.97948, 14248.846863, 2633517.632921],
      [1418100, 1420500, 'TRAILING_STOP', 1011.926122, 1019.521605, 9187.566502, 2637086.974635],
      [1430700, 1433100, 'TAKE_PROFIT', 996.760018, 1020.57772, 52280.252717, 2639388.456255],
      [1444500, 1450200, 'TRAILING_STOP', 1010.31755, 1014.436656, 182.353332, 2652484.659434],
      [1458600, 1461300, 'TRAILING_STOP', 1007.903658, 1016.558118, 12096.34041, 2652530.337768],
    ]);
    expect(netPnlOf(trades)).toBe(601039.811514);
    expect(reasonHistogram(trades)).toEqual({ TRAILING_STOP: 7, TAKE_PROFIT: 20, STOP_LOSS: 9 });
  });

  it('reproduces the trailing/stop fixture and its end-of-data close exactly', () => {
    const trades = run(modulated(5000), { ...LOOSE, atrTakeProfitMultiplier: 10 });
    expect(trades).toHaveLength(110);
    expect(netPnlOf(trades)).toBe(-350143.592352);
    expect(reasonHistogram(trades)).toEqual({ TRAILING_STOP: 53, STOP_LOSS: 56, END_OF_DATA: 1 });
    expect(digestOf(trades)).toBe('c81bb0479b8244ae0c65d9212978cd83efb7c31320efedd84eb72ecc5acb1476');
  });

  it('reproduces the signal-exit fixture exactly', () => {
    const trades = run(oscillator(4000, 60, 0.03), { ...LOOSE, atrTakeProfitMultiplier: 10, trailingStopEnabled: false });
    expect(trades).toHaveLength(65);
    expect(netPnlOf(trades)).toBe(1562971.113243);
    expect(reasonHistogram(trades)).toEqual({ SIGNAL: 65 });
    expect(digestOf(trades)).toBe('b784be63d1972ad4269c6ef51bd8e21111d9bc20c41703eacea629e45b2e2ccd');
  });
});
