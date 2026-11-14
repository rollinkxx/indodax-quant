import type { StrategyParams } from './strategy';

/** Human-readable limitations of the candle-only backtest. */
export function backtestScopeWarnings(_params: Pick<StrategyParams, 'mtfMode'>): string[] {
  return [];
}
