import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../shared/strategy';
import { backtestScopeWarnings, hasBacktestDataQuality } from '../shared/backtestScope';
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
  });

  it('warns when the active config enables MTF although the backtest does not apply it', () => {
    expect(backtestScopeWarnings({ mtfMode: 'filter' }).join('\n')).toContain('MTF mode "filter" is not applied');
    expect(backtestScopeWarnings({ mtfMode: 'score' }).join('\n')).toContain('15m/1h confirmation is omitted');
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

  it('requires a contiguous suffix after a gap and allows a later full warm-up', () => {
    const series: Candle[] = Array.from({ length: 90 }, (_, i) => ({
      t: i * 300, o: 100, h: 101, l: 99, c: 100, v: 1, n: 0, source: 'history',
    }));
    series[10] = { ...series[10], source: 'synthetic', v: 0 };
    expect(hasBacktestDataQuality(series, 59, 60)).toBe(false);
    expect(hasBacktestDataQuality(series, 59, 49)).toBe(true);
    expect(hasBacktestDataQuality(series, 89, 60)).toBe(true);
  });

});
