import { describe, expect, it } from 'vitest';
import { padRange } from '../src/lib/chartRange';

describe('padRange', () => {
  it('expands a flat range to 1% of value', () => {
    expect(padRange(10_000_000, 10_000_000)).toEqual({ minValue: 9_950_000, maxValue: 10_050_000 });
  });
  it('keeps a wide range unchanged', () => {
    expect(padRange(9_000_000, 11_000_000)).toEqual({ minValue: 9_000_000, maxValue: 11_000_000 });
  });
  it('handles zero', () => {
    expect(padRange(0, 0)).toEqual({ minValue: -0.5, maxValue: 0.5 });
  });
});
