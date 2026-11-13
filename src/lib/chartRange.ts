/**
 * Ensure the visible price range is never collapsed. A flat series (e.g. equity
 * while paper trading is STOPPED) otherwise gets a micro range and every axis
 * label rounds to the same number. Minimum span = 1% of the value (or 1).
 */
export function padRange(min: number, max: number, minFrac = 0.01): { minValue: number; maxValue: number } {
  const mid = (min + max) / 2;
  const minSpan = Math.max(Math.abs(mid) * minFrac, 1);
  if (max - min >= minSpan) return { minValue: min, maxValue: max };
  return { minValue: mid - minSpan / 2, maxValue: mid + minSpan / 2 };
}
