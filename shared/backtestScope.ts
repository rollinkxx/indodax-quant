import { isValidCandle, type Candle } from './candles';
import type { StrategyParams } from './strategy';

/**
 * Apply the production-style observed-candle warm-up gate to a historical 5m index.
 * A signal candle must be valid, observed, and have volume; its preceding warm-up
 * must be a contiguous run of valid non-synthetic candles.
 */
export function hasBacktestDataQuality(
  candles: Candle[],
  index: number,
  minCandles: number,
  intervalSec = 300,
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= candles.length || minCandles < 1) return false;
  const last = candles[index];
  if (!last || last.source === 'synthetic' || last.v <= 0 || !isValidCandle(last)) return false;

  let contiguous = 1;
  for (let i = index - 1; i >= 0; i--) {
    const previous = candles[i];
    const current = candles[i + 1];
    if (current.t - previous.t !== intervalSec || previous.source === 'synthetic' || previous.v <= 0 || !isValidCandle(previous)) break;
    contiguous++;
  }
  return contiguous >= minCandles;
}

/**
 * Limitations users must see before interpreting the stored-candle backtest.
 * This is a per-pair 5m approximation, not a portfolio or production-parity simulation.
 * MTF (15m/1h) confirmation is applied causally (see scripts/backtest.ts), so it is not listed as omitted.
 */
export function backtestScopeWarnings(params: Pick<StrategyParams, 'mtfMode'>): string[] {
  const warnings = [
    'This is a 5m candle-only approximation, not a production-parity backtest.',
    'Stored candle source is preserved; synthetic gap bars are excluded from signals and execution, with warm-up restarting after each gap.',
    'Zero-volume official OHLC rows count toward structural history coverage only; they are excluded from execution and break the contiguous positive-volume warm-up.',
    'Each pair is simulated independently with its own starting balance; combined metrics pool trades and are not a shared portfolio equity curve.',
    'Historical bid/ask quotes and tick-level execution are unavailable: entries use the next 5m candle open and exits use stop-first OHLC assumptions with modeled slippage.',
    'Cross-pair portfolio controls are not simulated: shared cash, max open positions, max total exposure, daily-loss flattening, and the drawdown kill-switch are evaluated only in production, not in this backtest.',
    'Dynamic slippage uses the current 24h volume tier from the latest ticker snapshot as a proxy across the historical sample; historical volume tiers are unavailable.',
  ];
  if (params.mtfMode !== 'off') {
    warnings.push(`MTF mode "${params.mtfMode}" (15m/1h) is applied causally to BUY entries, mirroring the pipeline; per-timeframe history is aggregated from the 5m series.`);
  }
  return warnings;
}
