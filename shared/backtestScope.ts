import type { StrategyParams } from './strategy';

/**
 * Limitations users must see before interpreting the stored-candle backtest.
 * This is a per-pair 5m approximation, not a portfolio or production-parity simulation.
 */
export function backtestScopeWarnings(params: Pick<StrategyParams, 'mtfMode'>): string[] {
  const warnings = [
    'This is a 5m candle-only approximation, not a production-parity backtest.',
    'Each pair is simulated independently with its own starting balance; combined metrics pool trades and are not a shared portfolio equity curve.',
    'Historical bid/ask quotes and tick-level execution are unavailable: entries use the next 5m candle open and exits use stop-first OHLC assumptions with modeled slippage.',
    'Portfolio controls are not simulated across pairs: shared cash, max total exposure, max open positions, daily-loss flattening, and drawdown kill-switch.',
    'Dynamic slippage uses the current 24h volume tier from the latest ticker snapshot as a proxy across the historical sample; historical volume tiers are unavailable.',
  ];
  if (params.mtfMode !== 'off') {
    warnings.push(`MTF mode "${params.mtfMode}" is not applied; 15m/1h confirmation is omitted from this 5m-only simulation.`);
  }
  return warnings;
}
