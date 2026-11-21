// FIX-A: mergeParams() discarded the WHOLE stored config when one key failed a cross-field rule.
// The per-key skip only looks for errors that *start* with the key name, and every cross-field
// message names another key ("emaFast must be smaller than emaSlow", "rsiBuyMin must be smaller
// than rsiBuyMax", "minCandles must exceed the longest ... (emaTrend / MACD) ..."), so a legal
// per-key value that only fails a cross-field rule survives the loop, fails the final check, and
// takes riskPerTradePct, maxOpenPositions, notifySignals and the rest down with it — silently.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, mergeParams, validateParams } from '../shared/strategy';

describe('FIX-A mergeParams repairs only the blamed key', () => {
  it('keeps unrelated keys when emaTrend trips the minCandles rule', () => {
    const merged = mergeParams({
      emaTrend: 200,
      riskPerTradePct: 2.5,
      maxOpenPositions: 6,
      notifySignals: false,
    });

    expect(merged.riskPerTradePct).toBe(2.5);
    expect(merged.maxOpenPositions).toBe(6);
    expect(merged.notifySignals).toBe(false);
    expect(merged.emaTrend).toBe(50);
  });

  // emaSlow 200 needs minCandles >= 202. FIX-B's guard message names emaSlow as the key that sets
  // the warm-up, so the repair resets emaSlow (200 -> 21) instead of throwing the config away.
  it('keeps unrelated keys when emaSlow inverts the EMA stack', () => {
    const merged = mergeParams({
      emaSlow: 200,
      riskPerTradePct: 2.5,
      maxOpenPositions: 6,
      notifySignals: false,
    });

    expect(merged.riskPerTradePct).toBe(2.5);
    expect(merged.maxOpenPositions).toBe(6);
    expect(merged.notifySignals).toBe(false);
    expect(merged.emaSlow).toBe(21);
  });

  it('warns instead of silently defaulting when nothing can repair the config', () => {
    // minCandles 30 with volumeMaPeriod 100 and emaTrend 300: the warm-up needs 302 bars, above the
    // 250 cap, so resetting every blamed key still cannot satisfy the guard.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeParams({ emaTrend: 300, volumeMaPeriod: 100, minCandles: 30, riskPerTradePct: 2.5 });

    expect(merged).toEqual(DEFAULT_PARAMS);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps unrelated keys when rsiBuyMax inverts the RSI band', () => {
    const merged = mergeParams({
      rsiBuyMax: 10,
      riskPerTradePct: 2.5,
      maxOpenPositions: 6,
      notifySignals: false,
    });

    expect(merged.riskPerTradePct).toBe(2.5);
    expect(merged.maxOpenPositions).toBe(6);
    expect(merged.notifySignals).toBe(false);
    expect(merged.rsiBuyMax).toBe(65);
  });

  it('repairs a cross-field pair by resetting only the keys the message names', () => {
    const merged = mergeParams({ emaFast: 30, emaSlow: 21, riskPerTradePct: 2.5 });

    expect(merged.emaFast).toBe(9);
    expect(merged.emaSlow).toBe(21);
    expect(merged.riskPerTradePct).toBe(2.5);
  });

  it('treats an empty or absent stored config as the defaults', () => {
    expect(mergeParams({})).toEqual(DEFAULT_PARAMS);
    expect(mergeParams(null)).toEqual(DEFAULT_PARAMS);
    expect(mergeParams(undefined)).toEqual(DEFAULT_PARAMS);
  });

  it('never repairs the default configuration', () => {
    expect(validateParams(DEFAULT_PARAMS as unknown as Record<string, unknown>)).toEqual([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeParams(DEFAULT_PARAMS)).toEqual(DEFAULT_PARAMS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

});
