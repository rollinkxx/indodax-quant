import { describe, expect, it } from 'vitest';
import { applyBacktestOverrides, parseBacktestOverrides } from '../shared/backtestOverrides';
import { DEFAULT_PARAMS, mergeParams } from '../shared/strategy';

describe('parseBacktestOverrides', () => {
  it('parses a valid numeric override', () => {
    expect(parseBacktestOverrides('{"trailDistanceAtr":2}')).toEqual({ trailDistanceAtr: 2 });
  });

  it('parses a valid enum override', () => {
    expect(parseBacktestOverrides('{"feeModel":"pair_taker"}')).toEqual({ feeModel: 'pair_taker' });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBacktestOverrides('{not json')).toThrow(/valid JSON/);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseBacktestOverrides('[1,2]')).toThrow(/JSON object/);
    expect(() => parseBacktestOverrides('42')).toThrow(/JSON object/);
  });

  it('rejects unknown parameters', () => {
    expect(() => parseBacktestOverrides('{"notARealParam":1}')).toThrow(/unknown override parameter/);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseBacktestOverrides('{"trailDistanceAtr":99}')).toThrow(/invalid override/);
  });

  it('rejects a wrong-typed boolean parameter', () => {
    expect(() => parseBacktestOverrides('{"trailingStopEnabled":"yes"}')).toThrow(/invalid override/);
  });

  it('rejects a cross-field violation that only appears against the active config', () => {
    // emaFast=50 is in range on its own, but the merged config must still satisfy
    // emaFast < emaSlow. The check runs against the supplied base.
    const base = mergeParams({ emaSlow: 40 });
    expect(() => parseBacktestOverrides('{"emaFast":50}', base)).toThrow(/invalid override/);
  });

  it('accepts a cross-field-valid change against the active config', () => {
    // emaSlow=60 also needs minCandles>=62, so raise both to keep the base valid.
    const base = mergeParams({ emaSlow: 60, minCandles: 70 });
    expect(parseBacktestOverrides('{"emaFast":50}', base)).toEqual({ emaFast: 50 });
  });
});

describe('applyBacktestOverrides', () => {
  it('applies overrides on top of the base without mutating it', () => {
    const base = mergeParams(DEFAULT_PARAMS);
    const merged = applyBacktestOverrides(base, { trailDistanceAtr: 3, trailActivationAtr: 2 });
    expect(merged.trailDistanceAtr).toBe(3);
    expect(merged.trailActivationAtr).toBe(2);
    expect(base.trailDistanceAtr).toBe(DEFAULT_PARAMS.trailDistanceAtr);
  });

  it('returns an equivalent config when there are no overrides', () => {
    const base = mergeParams(DEFAULT_PARAMS);
    expect(applyBacktestOverrides(base, {})).toEqual(base);
  });
});
