import { describe, expect, it } from 'vitest';
import { signRelayRequest, validateRelayTarget, verifyRelayRequest } from '../supabase/functions/indodax-proxy/_shared/relay';

const secret = 'test-service-secret-never-use-in-production';
const target = '/functions/v1/indodax-proxy?path=%2Fapi%2Ftrades%2Fbtcidr';

describe('INDODAX relay request authentication', () => {
  it('accepts a valid HMAC signature for the exact request target', async () => {
    const timestamp = 1_000;
    const signature = await signRelayRequest(secret, target, timestamp);
    await expect(verifyRelayRequest(secret, target, String(timestamp), signature, 1_000)).resolves.toBe(true);
  });

  it('rejects a request when its query string is changed after signing', async () => {
    const timestamp = 1_000;
    const signature = await signRelayRequest(secret, target, timestamp);
    await expect(verifyRelayRequest(secret, target + '&pair_id=ethidr', String(timestamp), signature, 1_000)).resolves.toBe(false);
  });

  it('rejects the wrong secret and malformed signatures', async () => {
    const timestamp = 1_000;
    const signature = await signRelayRequest(secret, target, timestamp);
    await expect(verifyRelayRequest('different-secret', target, String(timestamp), signature, timestamp)).resolves.toBe(false);
    await expect(verifyRelayRequest(secret, target, String(timestamp), 'not-a-signature', timestamp)).resolves.toBe(false);
  });

  it('rejects stale, future, non-integer, and non-finite timestamps', async () => {
    const signature = await signRelayRequest(secret, target, 1_000);
    await expect(verifyRelayRequest(secret, target, '1000', signature, 1_061)).resolves.toBe(false);
    await expect(verifyRelayRequest(secret, target, '1061', signature, 1_000)).resolves.toBe(false);
    await expect(verifyRelayRequest(secret, target, '1.5', signature, 1_000)).resolves.toBe(false);
    await expect(verifyRelayRequest(secret, target, 'NaN', signature, 1_000)).resolves.toBe(false);
  });
});

describe('INDODAX relay target validation', () => {
  it('allows exact public API paths with no extra query parameters', () => {
    expect(validateRelayTarget('/api/summaries', new URLSearchParams()).ok).toBe(true);
    expect(validateRelayTarget('/api/trades/btcidr', new URLSearchParams()).ok).toBe(true);
    expect(validateRelayTarget('/api/ticker/ethidr', new URLSearchParams()).ok).toBe(true);
    expect(validateRelayTarget('/api/pairs', new URLSearchParams()).ok).toBe(true);
  });

  it('rejects private endpoints, path traversal, and malformed pair ids', () => {
    expect(validateRelayTarget('/tapi', new URLSearchParams()).ok).toBe(false);
    expect(validateRelayTarget('/api/trades/../tapi', new URLSearchParams()).ok).toBe(false);
    expect(validateRelayTarget('/api/trades/BTCIDR', new URLSearchParams()).ok).toBe(false);
    expect(validateRelayTarget('/api/ticker/btcidr/extra', new URLSearchParams()).ok).toBe(false);
  });

  it('accepts a valid 12-hour 1m history chunk used by the evaluator', () => {
    const query = new URLSearchParams({ symbol: 'BTCIDR', tf: '1', from: '1000', to: String(1000 + 43_200) });
    expect(validateRelayTarget('/tradingview/history_v2', query).ok).toBe(true);
  });

  it('rejects invalid history symbols, timeframes, bounds, unknown and duplicate parameters', () => {
    const invalid = [
      new URLSearchParams({ symbol: '../BTC', tf: '1', from: '1000', to: '2000' }),
      new URLSearchParams({ symbol: 'BTCIDR', tf: '5', from: '1000', to: '2000' }),
      new URLSearchParams({ symbol: 'BTCIDR', tf: '1', from: 'NaN', to: '2000' }),
      new URLSearchParams({ symbol: 'BTCIDR', tf: '1', from: '2000', to: '1000' }),
      new URLSearchParams({ symbol: 'BTCIDR', tf: '1', from: '1000', to: String(1000 + 7 * 86_400 + 1) }),
      new URLSearchParams({ symbol: 'BTCIDR', tf: '1', from: '1000', to: '2000', injected: '1' }),
      new URLSearchParams('symbol=BTCIDR&symbol=ETHIDR&tf=1&from=1000&to=2000'),
    ];
    for (const query of invalid) expect(validateRelayTarget('/tradingview/history_v2', query).ok).toBe(false);
  });

  it('bounds 15m and 1h bootstrap ranges while allowing the production 104-hour warmup', () => {
    const valid = new URLSearchParams({ symbol: 'BTCIDR', tf: '60', from: '1000', to: String(1000 + 104 * 3600) });
    const tooLong = new URLSearchParams({ symbol: 'BTCIDR', tf: '60', from: '1000', to: String(1000 + 14 * 86_400 + 1) });
    expect(validateRelayTarget('/tradingview/history_v2', valid).ok).toBe(true);
    expect(validateRelayTarget('/tradingview/history_v2', tooLong).ok).toBe(false);
  });
});
