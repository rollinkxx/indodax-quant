import { describe, expect, it } from 'vitest';
import { normalizeOrder, normalizePrice } from '../shared/orderNormalize';

describe('price normalization', () => {
  it('rounds to the pair tick size', () => {
    expect(normalizePrice(100.456, 2)).toBe(100.46);
    expect(normalizePrice(0.00012345, 6)).toBe(0.000123);
    expect(normalizePrice(1000, 0)).toBe(1000);
  });
  it('leaves the price alone for an unknown precision', () => {
    expect(normalizePrice(100.456789, null)).toBe(100.456789);
    expect(normalizePrice(100.456789, -1)).toBe(100.456789);
  });
});

describe('order normalization', () => {
  it('rounds quantity down to the step and reports the reduction', () => {
    const r = normalizeOrder({ qty: 1.23456789, price: 100, rules: { pricePrecision: 0, minNotional: 0, qtyStep: 0.001 } });
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(1.234);
    expect(r.qtyReduced).toBeCloseTo(0.00056789, 8);
  });

  it('rejects an order below the pair minimum notional', () => {
    const r = normalizeOrder({ qty: 0.001, price: 1000, rules: { pricePrecision: 0, minNotional: 10_000 } });
    expect(r).toMatchObject({ ok: false, reason: 'below_min_notional' });
    expect(r.notional).toBe(1);
  });

  it('accepts an order exactly at the minimum notional', () => {
    const r = normalizeOrder({ qty: 10, price: 1000, rules: { pricePrecision: 0, minNotional: 10_000 } });
    expect(r.ok).toBe(true);
    expect(r.notional).toBe(10_000);
  });

  it('rejects a quantity that rounds to zero', () => {
    const r = normalizeOrder({ qty: 1e-12, price: 100, rules: { pricePrecision: 0, minNotional: 0 } });
    expect(r).toMatchObject({ ok: false, reason: 'qty_rounded_to_zero' });
  });

  it('rejects invalid inputs', () => {
    expect(normalizeOrder({ qty: 0, price: 100, rules: { pricePrecision: 0, minNotional: 0 } }).reason).toBe('invalid_inputs');
    expect(normalizeOrder({ qty: 1, price: -1, rules: { pricePrecision: 0, minNotional: 0 } }).reason).toBe('invalid_inputs');
  });
});
