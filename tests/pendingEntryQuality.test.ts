// FIX-C: the pending BUY retry path validated only the trend setup and skipped the data-quality
// gate the SELL retry path already applies (analysis.quality?.[pair] === 'ok'). A claim could
// therefore be re-filled on a candle the engine itself refuses to analyse.
import { describe, expect, it } from 'vitest';
import { selectRetryablePending } from '../worker/src/pipeline';

const claim = (over: Record<string, unknown> = {}) => ({
  pair_id: 'btcidr',
  signal_id: 301,
  candle_time: '2026-11-21T01:00:00.000Z',
  expires_at: '2026-11-21T01:15:00.000Z',
  strength: 90,
  price: 1000,
  indicators: { atr14: 10 },
  attempts: 0,
  ...over,
});

const analysis = (quality: string, setupValid: boolean) => ({
  quality: { btcidr: quality },
  buyDiagnostics: { btcidr: { setup_valid: setupValid } },
}) as unknown as Parameters<typeof selectRetryablePending>[1];

describe('FIX-C pending BUY honours the data-quality gate', () => {
  it('drops a claim whose pair failed data quality even when the setup still holds', () => {
    expect(selectRetryablePending([claim()], analysis('stale_last_candle', true))).toHaveLength(0);
  });

  it('retries a claim when the pair is healthy and the setup still holds', () => {
    const rows = selectRetryablePending([claim()], analysis('ok', true));
    expect(rows.map((r) => r.signal_id)).toEqual([301]);
  });

  it('drops a claim whose setup broke', () => {
    expect(selectRetryablePending([claim()], analysis('ok', false))).toHaveLength(0);
  });

  it('never treats a claim as retryable without an analysis', () => {
    // Mark-phase runs have no fresh diagnostics, so the helper must not green-light anything.
    // The caller keeps the claims by not calling it at all outside `if (analysis)`.
    expect(selectRetryablePending([claim()], undefined)).toHaveLength(0);
  });
});
