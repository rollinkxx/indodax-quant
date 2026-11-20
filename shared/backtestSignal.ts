import { computeIndicators, evaluateMarketAction, evaluateSignalWindow, type IndicatorRow, type StrategyParams } from './strategy';
import type { Candle } from './candles';

/**
 * Caches full-series indicator rows per pair so a portfolio backtest can index the signal bar
 * without recomputing recursive indicators (EMA/RSI/ATR/volume MA) from scratch on every call.
 *
 * Seeding matters: indicators computed over only the `crossLookback`-bar decision window are
 * unseeded, so `evaluateMarketAction` returns `indicators_not_ready` forever and the portfolio run
 * reports zero trades while the per-pair simulation (full series) trades normally.
 */
export function createIndicatorRowsCache() {
  const cache = new Map<string, IndicatorRow[]>();
  return (pair: string, candles: Candle[], p: StrategyParams): IndicatorRow[] => {
    const key = `${pair}:${candles.length}`;
    let rows = cache.get(key);
    if (!rows) {
      rows = computeIndicators(candles, p);
      cache.set(key, rows);
    }
    return rows;
  };
}

/** BUY/SELL/HOLD at `index`, using fully seeded indicators and the `crossLookback` decision window. */
export function signalAtBar(
  pair: string,
  candles: Candle[],
  index: number,
  p: StrategyParams,
  rowsFor: (pair: string, candles: Candle[], p: StrategyParams) => IndicatorRow[],
): 'BUY' | 'SELL' | 'HOLD' {
  const win = Math.max(3, p.crossLookback + 1);
  if (index - win + 1 < 0) return 'HOLD';
  const rows = rowsFor(pair, candles, p);
  if (rows.length !== candles.length) return 'HOLD';
  const windowRows = rows.slice(index - win + 1, index + 1);
  const windowVolumes = candles.slice(index - win + 1, index + 1).map((c) => c.v);
  const action = evaluateMarketAction(windowRows, windowVolumes, p);
  return action.signal?.side ?? evaluateSignalWindow(windowRows, windowVolumes, p)?.side ?? 'HOLD';
}
