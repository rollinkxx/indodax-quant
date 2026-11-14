import { describe, expect, it } from 'vitest';
import { buildPairCandles, planCoverage } from '../worker/src/ingest';
import type { Candle, Trade } from '../shared/candles';

const T0 = 1_800_000_000 - (1_800_000_000 % 300);
const NOW = T0 + 300 + 30;
const nowMin = T0 + 300;

const trade = (tid: string, minute: number, price = 100): Trade => ({
  tid, ts: T0 + minute * 60 + 10, price, amount: 1, side: 'buy',
});
const history = (minute: number, close = 99, volume = 0): Candle => ({
  t: T0 + minute * 60, o: close, h: close + 1, l: close - 1, c: close,
  v: volume, n: 0, source: 'history',
});
const completeHistory = () => Array.from({ length: 5 }, (_, i) => history(i));

describe('minute coverage recovery', () => {
  it('bootstraps from official history when no coverage frontier exists', () => {
    const plan = planCoverage([trade('1', 4)], null, NOW);
    expect(plan.historyRange).toEqual({ from: nowMin - 24 * 3600, to: nowMin });
  });

  it('detects missing minutes inside the recent trade window and requests one aligned range', () => {
    const trades = [trade('1', 0), trade('2', 2), trade('3', 4)];
    const plan = planCoverage(trades, T0, NOW);

    expect(plan.historyRange).toEqual({ from: T0, to: nowMin });
  });

  it('fills quiet minutes from official OHLC and keeps trade-derived bars on collisions', () => {
    const trades = [trade('1', 0, 100), trade('2', 2, 102), trade('3', 4, 104)];
    const plan = planCoverage(trades, T0, NOW);
    const built = buildPairCandles(trades, plan, T0, completeHistory());

    expect(built.historyComplete).toBe(true);
    expect(built.missingMinutes).toBe(0);
    expect(built.newCoveredUntil).toBe(nowMin);
    expect(built.m1).toHaveLength(5);
    expect(built.m1[0]).toMatchObject({ source: 'trades', c: 100, n: 1 });
    expect(built.m1[1]).toMatchObject({ source: 'history', v: 0 });
    expect(built.m5).toHaveLength(1);
  });

  it('backfills a pair with no recent trades instead of advancing coverage over an empty window', () => {
    const plan = planCoverage([], T0, NOW);
    expect(plan.historyRange).toEqual({ from: T0, to: nowMin });

    const built = buildPairCandles([], plan, T0, completeHistory());
    expect(built.historyComplete).toBe(true);
    expect(built.newCoveredUntil).toBe(nowMin);
    expect(built.m1).toHaveLength(5);
    expect(built.m5).toHaveLength(1);
    expect(built.m5[0]).toMatchObject({ source: 'history', v: 0 });
  });

  it('does not move the coverage frontier when the OHLC response omits a required minute', () => {
    const trades = [trade('1', 0), trade('2', 2), trade('3', 4)];
    const plan = planCoverage(trades, T0, NOW);
    const partial = [history(0), history(2), history(3), history(4)];
    const built = buildPairCandles(trades, plan, T0, partial);

    expect(built.historyComplete).toBe(false);
    expect(built.missingMinutes).toBe(1);
    expect(built.newCoveredUntil).toBe(T0);
  });

  it('does not move the coverage frontier when the OHLC request fails', () => {
    const plan = planCoverage([trade('1', 0), trade('2', 4)], T0, NOW);
    const built = buildPairCandles([trade('1', 0), trade('2', 4)], plan, T0, null);

    expect(built.historyComplete).toBe(false);
    expect(built.newCoveredUntil).toBe(T0);
  });
});
