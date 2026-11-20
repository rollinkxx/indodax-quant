// Pair-specific order normalization.
//
// INDODAX quotes each pair at its own price precision and enforces a minimum order notional and a
// base-currency quantity step. Sizing a position without honouring those rules produces an order the
// exchange would reject, or a rounded-down notional below the minimum. This module applies the rules
// once so the paper engine and the backtest normalize identically.

export interface PairRules {
  /** Price decimals from `market_pairs.price_precision`. Null = no rounding (leave the price). */
  pricePrecision: number | null;
  /** `market_pairs.trade_min_base_currency` (IDR). Null = no minimum enforced. */
  minNotional: number | null;
  /** Smallest tradable base-currency step. Defaults to the 8dp ledger precision. */
  qtyStep?: number | null;
}

export interface NormalizedOrder {
  qty: number;
  price: number;
  notional: number;
  /** Requested qty minus normalized qty (>= 0); non-zero means the order was rounded down. */
  qtyReduced: number;
  ok: boolean;
  reason?: 'invalid_inputs' | 'below_min_notional' | 'qty_rounded_to_zero';
}

const QTY_DECIMALS = 8;

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function floorTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(value * f + 1e-9) / f;
}

/** Round a price to the pair's tick size, half-up. Invalid precision leaves the price untouched. */
export function normalizePrice(price: number, pricePrecision: number | null | undefined): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (pricePrecision === null || pricePrecision === undefined || !Number.isInteger(pricePrecision) || pricePrecision < 0 || pricePrecision > 12) {
    return price;
  }
  return roundTo(price, pricePrecision);
}

/**
 * Normalize a requested base-currency quantity to the pair's step and verify the resulting notional
 * clears the pair minimum. Rounding is always downward so the order can never cost more than sized.
 */
export function normalizeOrder(input: { qty: number; price: number; rules: PairRules }): NormalizedOrder {
  const { qty, price, rules } = input;
  const empty = (reason: NormalizedOrder['reason']): NormalizedOrder => ({
    qty: 0, price: Number.isFinite(price) ? price : 0, notional: 0, qtyReduced: Number.isFinite(qty) ? Math.max(0, qty) : 0, ok: false, reason,
  });
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return empty('invalid_inputs');

  const normalizedPrice = normalizePrice(price, rules.pricePrecision);
  const step = rules.qtyStep !== undefined && rules.qtyStep !== null && Number.isFinite(rules.qtyStep) && rules.qtyStep > 0
    ? rules.qtyStep
    : 1 / 10 ** QTY_DECIMALS;
  const steps = Math.floor(qty / step + 1e-9);
  const normalizedQty = floorTo(steps * step, QTY_DECIMALS);
  if (!(normalizedQty > 0)) return empty('qty_rounded_to_zero');

  const notional = normalizedQty * normalizedPrice;
  const min = rules.minNotional !== null && rules.minNotional !== undefined && Number.isFinite(rules.minNotional) && rules.minNotional > 0
    ? rules.minNotional
    : 0;
  if (notional < min) {
    return { qty: normalizedQty, price: normalizedPrice, notional, qtyReduced: Math.max(0, qty - normalizedQty), ok: false, reason: 'below_min_notional' };
  }
  return { qty: normalizedQty, price: normalizedPrice, notional, qtyReduced: Math.max(0, qty - normalizedQty), ok: true };
}
