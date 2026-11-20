import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../shared/strategy';
import { backtestScopeWarnings, hasBacktestDataQuality, measurementWarnings } from '../shared/backtestScope';
import type { Candle } from '../shared/candles';

describe('backtest scope warnings', () => {
  it('states that the output is a 5m approximation, not production parity', () => {
    const scope = backtestScopeWarnings(DEFAULT_PARAMS).join('\n');
    expect(scope).toContain('5m candle-only approximation');
    expect(scope).toContain('not a production-parity backtest');
  });

  it('discloses independent per-pair simulations and trade-level aggregation', () => {
    const scope = backtestScopeWarnings(DEFAULT_PARAMS).join('\n');
    expect(scope).toContain('Each pair is simulated independently');
    expect(scope).toContain('not a shared portfolio equity curve');
  });

  it('discloses missing historical bid/ask and tick-level execution data', () => {
    const scope = backtestScopeWarnings(DEFAULT_PARAMS).join('\n');
    expect(scope).toContain('Historical bid/ask quotes');
    expect(scope).toContain('next 5m candle open');
  });

  it('discloses missing portfolio risk controls', () => {
    const scope = backtestScopeWarnings(DEFAULT_PARAMS).join('\n');
    expect(scope).toContain('max total exposure');
    expect(scope).toContain('daily-loss flattening');
    expect(scope).toContain('drawdown kill-switch');
    expect(scope).toContain('Cross-pair portfolio controls are not simulated');
  });

  it('states that MTF is applied causally rather than omitted when enabled', () => {
    expect(backtestScopeWarnings({ mtfMode: 'filter' }).join('\n')).toContain('MTF mode "filter" (15m/1h) is applied causally');
    expect(backtestScopeWarnings({ mtfMode: 'score' }).join('\n')).toContain('applied causally to BUY entries');
    expect(backtestScopeWarnings({ mtfMode: 'score' }).join('\n')).not.toContain('is not applied');
  });

  it('does not report an MTF omission when MTF is disabled', () => {
    expect(backtestScopeWarnings({ mtfMode: 'off' }).join('\n')).not.toContain('MTF mode');
  });
  
  it('discloses that historical slippage tiers use the current ticker snapshot', () => {
    const scope = backtestScopeWarnings(DEFAULT_PARAMS).join('\\n');
    expect(scope).toContain('current 24h volume tier');
    expect(scope).toContain('historical volume tiers are unavailable');
  });


  it('warns that synthetic bars are excluded and warm-up restarts after gaps', () => {
    expect(backtestScopeWarnings(DEFAULT_PARAMS).join('\\n')).toContain('synthetic gap bars are excluded');
  });

  it('accepts a full contiguous run of observed history candles', () => {
    const series: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 300, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(true);
  });

  it('rejects a synthetic or zero-volume signal candle', () => {
    const series: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 300, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    series[59] = { ...series[59], source: 'synthetic', v: 0 };
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(false);
    series[59] = { ...series[59], source: 'history', v: 0 };
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(false);
  });

  it('restarts contiguous warm-up after a zero-volume official OHLC candle', () => {
    const series: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 300, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    series[10] = { ...series[10], v: 0 };
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(false);
    expect(hasBacktestDataQuality(series, 59, 49)).toBe(true);
  });

  it('measures warm-up contiguity in the series bar interval, not a hardcoded 5m', () => {
    // A 1h series spaced 3600s apart must pass when told the interval; assuming 300s would call
    // every bar a gap, reset the warm-up each time, and silently produce zero trades.
    const hourly: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      t: i * 3600, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    expect(hasBacktestDataQuality(hourly, 59, 60, 3600)).toBe(true);
    expect(hasBacktestDataQuality(hourly, 59, 60)).toBe(false);
  });

  it('requires a contiguous suffix after a gap and allows a later full warm-up', () => {
    const series: Candle[] = Array.from({ length: 90 }, (_, i) => ({
      t: i * 300, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    series[10] = { ...series[10], source: 'synthetic', v: 0 };
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(false);
    expect(hasBacktestDataQuality(series, 59, 49)).toBe(true);
    expect(hasBacktestDataQuality(series, 89, 60)).toBe(true);
  });


describe('measurement warnings', () => {
  it('escalates a variant whose ambiguous-exit share exceeds the limit', () => {
    const w = measurementWarnings({ v: { trades: 10, ambiguousExits: 2, endOfDataExits: 0 } });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('UNRELIABLE');
    expect(w[0]).toContain('2/10');
  });

  it('reports a small ambiguous share as a caveat rather than suppressing it', () => {
    const w = measurementWarnings({ v: { trades: 200, ambiguousExits: 1, endOfDataExits: 0 } });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('CAVEAT');
    expect(w[0]).not.toContain('UNRELIABLE');
  });

  it('flags end-of-data exits separately and stays silent for a clean variant', () => {
    expect(measurementWarnings({ v: { trades: 5, ambiguousExits: 0, endOfDataExits: 2 } })[0]).toContain('end of data');
    expect(measurementWarnings({ v: { trades: 5, ambiguousExits: 0, endOfDataExits: 0 } })).toEqual([]);
  });

  it('says nothing about a variant with no trades', () => {
    expect(measurementWarnings({ v: { trades: 0, ambiguousExits: 0, endOfDataExits: 0 } })).toEqual([]);
  });
});
});
