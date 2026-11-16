import { describe, expect, it, vi } from 'vitest';
import { buildPipelinePostHogEvents, sendPostHogBatch } from '../worker/src/posthog';

describe('PostHog strategy telemetry', () => {
  it('tracks signal generation, rejection reasons, successful paper entries, and run totals', () => {
    const events = buildPipelinePostHogEvents({
      status: 'SUCCESS',
      runId: 42,
      errors: [],
      steps: {
        analyze: { info: { new_signals: 1, new_signal_details: [
          { signal_id: 1001, pair_id: 'BTCIDR', side: 'BUY', strength: 80 },
        ] } },
        paper_trading: { info: {
          buy_signals_received: 1,
          entries_opened: 0,
          entry_rejections: [{
            signal_id: 1001, pair_id: 'BTCIDR', stage: 'entry_gate', reason: 'wide_spread',
            metrics: { spread_pct: 0.72, fee_pct: 0.00555, slippage_bps: 10 },
          }],
          opened_entries: [],
        } },
      },
    }, 'cron', 850, '2026-11-16T00:00:00.000Z');

    expect(events.map((event) => event.event)).toEqual([
      'trading_pipeline_run', 'trading_signal_generated', 'paper_entry_rejected',
    ]);
    expect(events[2].properties).toMatchObject({
      signal_id: 1001, pair_id: 'BTCIDR', stage: 'entry_gate', reason: 'wide_spread',
      spread_pct: 0.72, fee_pct: 0.00555, slippage_bps: 10,
    });
  });

  it('does not call the network when the project token is absent', async () => {
    const fetchMock = vi.fn();
    await sendPostHogBatch({ ENVIRONMENT: 'production' }, [{
      event: 'trading_pipeline_run', properties: {},
    }], fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one batch to the configured PostHog host and never throws on ingestion failure', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    await expect(sendPostHogBatch({
      POSTHOG_PROJECT_TOKEN: 'phc_test_public_project_token',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      ENVIRONMENT: 'test',
    }, [{
      event: 'trading_pipeline_run',
      properties: { status: 'SUCCESS' },
      timestamp: '2026-11-16T00:00:00.000Z',
    }], fetchMock)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/batch/');
    const payload = JSON.parse(String(init.body));
    expect(payload.batch[0]).toMatchObject({
      event: 'trading_pipeline_run',
      distinct_id: 'indodax-quant-worker',
      properties: { status: 'SUCCESS', $process_person_profile: false },
    });
  });

  it('keeps the trading process running when PostHog returns an error', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 500 }));
    await expect(sendPostHogBatch({
      POSTHOG_PROJECT_TOKEN: 'phc_test_public_project_token',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      ENVIRONMENT: 'test',
    }, [{ event: 'trading_pipeline_run', properties: {} }], fetchMock)).resolves.toBeUndefined();
  });
});
