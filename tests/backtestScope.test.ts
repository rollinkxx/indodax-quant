import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../shared/strategy';
import { backtestScopeWarnings } from '../shared/backtestScope';

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
});
