import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS, checkReportedWinRate, validateCrossFieldParams, validateEvidenceRequirements,
} from '../shared/strategy';

describe('cross-field parameter validation', () => {
  it('warns when the BUY and SELL RSI bands overlap', () => {
    const findings = validateCrossFieldParams({ ...DEFAULT_PARAMS, rsiBuyMin: 45, rsiSellMax: 50 });
    expect(findings.map((f) => f.code)).toContain('BUY_AND_SELL_RSI_REGIMES_OVERLAP');
  });

  it('warns when volume confirmation is disabled', () => {
    const findings = validateCrossFieldParams({ ...DEFAULT_PARAMS, volumeMultiplier: 0 });
    expect(findings.map((f) => f.code)).toContain('VOLUME_CONFIRMATION_DISABLED');
  });

  it('errors on an inverted reward/risk bracket', () => {
    const findings = validateCrossFieldParams({ ...DEFAULT_PARAMS, atrStopMultiplier: 4, atrTakeProfitMultiplier: 2 });
    const err = findings.find((f) => f.code === 'INVALID_NET_REWARD_RISK');
    expect(err?.level).toBe('error');
  });

  it('accepts a non-overlapping RSI configuration without findings', () => {
    expect(validateCrossFieldParams({ ...DEFAULT_PARAMS, rsiBuyMin: 55, rsiSellMax: 45 })).toEqual([]);
  });
});

describe('evidence requirement validation', () => {
  it('rejects a non-positive holdout size', () => {
    expect(validateEvidenceRequirements({ minHoldoutTrades: 0, minWinRateLower95Pct: 50, minProfitFactorExclusive: 1 }).map((f) => f.code)).toContain('INVALID_HOLDOUT_SIZE');
  });
  it('rejects an out-of-range win-rate threshold', () => {
    expect(validateEvidenceRequirements({ minHoldoutTrades: 10, minWinRateLower95Pct: -1, minProfitFactorExclusive: 1 }).map((f) => f.code)).toContain('INVALID_WIN_RATE_THRESHOLD');
    expect(validateEvidenceRequirements({ minHoldoutTrades: 10, minWinRateLower95Pct: 120, minProfitFactorExclusive: 1 }).map((f) => f.code)).toContain('INVALID_WIN_RATE_THRESHOLD');
  });
  it('rejects a negative profit-factor threshold', () => {
    expect(validateEvidenceRequirements({ minHoldoutTrades: 10, minWinRateLower95Pct: 50, minProfitFactorExclusive: -0.1 }).map((f) => f.code)).toContain('INVALID_PROFIT_FACTOR_THRESHOLD');
  });
});

describe('reported win-rate consistency', () => {
  it('accepts a matching win rate', () => {
    expect(checkReportedWinRate(30, 100, 30)).toBeNull();
  });
  it('warns on a mismatch beyond 0.01pp', () => {
    expect(checkReportedWinRate(30, 100, 35)?.code).toBe('WIN_RATE_INPUT_MISMATCH');
  });
  it('ignores an omitted win rate', () => {
    expect(checkReportedWinRate(30, 100, null)).toBeNull();
  });
});
