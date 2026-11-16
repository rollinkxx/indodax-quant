import type { Env } from './env';

export interface PostHogEvent {
  event: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp?: string;
}

interface PipelineResultLike {
  status: string;
  runId?: number;
  reason?: string;
  errors?: string[];
  steps?: Record<string, unknown>;
}

interface BatchItem {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean | null>;
  timestamp: string;
}

const WORKER_DISTINCT_ID = 'indodax-quant-worker';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stepInfo(result: PipelineResultLike, stepName: string): Record<string, unknown> {
  const step = record(result.steps?.[stepName]);
  return record(step?.info) ?? {};
}

function finiteMetrics(value: unknown): Record<string, number> {
  const source = record(value) ?? {};
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

/** Translate the pipeline's persisted decision summaries into low-volume, privacy-safe events. */
export function buildPipelinePostHogEvents(
  result: PipelineResultLike,
  trigger: 'cron' | 'manual',
  durationMs: number,
  occurredAt = new Date().toISOString(),
): PostHogEvent[] {
  const analysis = stepInfo(result, 'analyze');
  const paper = stepInfo(result, 'paper_trading');
  const signals = Array.isArray(analysis.new_signal_details) ? analysis.new_signal_details : [];
  const rejections = Array.isArray(paper.entry_rejections) ? paper.entry_rejections : [];
  const opened = Array.isArray(paper.opened_entries) ? paper.opened_entries : [];
  const events: PostHogEvent[] = [];

  const common = { service: 'indodax-quant', trigger, run_id: result.runId ?? null };
  events.push({
    event: 'trading_pipeline_run',
    timestamp: occurredAt,
    properties: {
      ...common,
      status: result.status,
      duration_ms: Math.max(0, Math.round(durationMs)),
      signals_saved: Number(analysis.new_signals ?? signals.length) || 0,
      buy_signals_received: Number(paper.buy_signals_received ?? 0) || 0,
      entries_opened: Number(paper.entries_opened ?? opened.length) || 0,
      entry_rejections: rejections.length,
      errors_count: result.errors?.length ?? 0,
      ...(result.reason ? { skip_reason: result.reason } : {}),
    },
  });

  for (const candidate of signals) {
    const signal = record(candidate);
    if (!signal) continue;
    events.push({
      event: 'trading_signal_generated',
      timestamp: occurredAt,
      properties: {
        ...common,
        signal_id: typeof signal.signal_id === 'number' ? signal.signal_id : null,
        pair_id: typeof signal.pair_id === 'string' ? signal.pair_id : 'unknown',
        side: typeof signal.side === 'string' ? signal.side : 'unknown',
        strength: typeof signal.strength === 'number' && Number.isFinite(signal.strength) ? signal.strength : null,
      },
    });
  }

  for (const candidate of rejections) {
    const rejection = record(candidate);
    if (!rejection) continue;
    events.push({
      event: 'paper_entry_rejected',
      timestamp: occurredAt,
      properties: {
        ...common,
        signal_id: typeof rejection.signal_id === 'number' ? rejection.signal_id : null,
        pair_id: typeof rejection.pair_id === 'string' ? rejection.pair_id : 'unknown',
        stage: typeof rejection.stage === 'string' ? rejection.stage : 'unknown',
        reason: typeof rejection.reason === 'string' ? rejection.reason : 'unknown',
        ...finiteMetrics(rejection.metrics),
      },
    });
  }

  for (const candidate of opened) {
    const entry = record(candidate);
    if (!entry) continue;
    events.push({
      event: 'paper_position_opened',
      timestamp: occurredAt,
      properties: {
        ...common,
        signal_id: typeof entry.signal_id === 'number' ? entry.signal_id : null,
        position_id: typeof entry.position_id === 'number' ? entry.position_id : null,
        pair_id: typeof entry.pair_id === 'string' ? entry.pair_id : 'unknown',
        qty: typeof entry.qty === 'number' && Number.isFinite(entry.qty) ? entry.qty : null,
        fill_price: typeof entry.fill_price === 'number' && Number.isFinite(entry.fill_price) ? entry.fill_price : null,
        notional: typeof entry.notional === 'number' && Number.isFinite(entry.notional) ? entry.notional : null,
        fee: typeof entry.fee === 'number' && Number.isFinite(entry.fee) ? entry.fee : null,
      },
    });
  }

  for (const message of result.errors ?? []) {
    const stage = message.split(':', 1)[0].trim().split(/\s+/, 1)[0] || 'unknown';
    events.push({
      event: 'trading_pipeline_step_error',
      timestamp: occurredAt,
      properties: { ...common, stage },
    });
  }

  return events;
}

/**
 * Send one batch through PostHog's public Capture API.
 * A missing token or a telemetry outage is deliberately non-fatal to trading.
 */
export async function sendPostHogBatch(
  env: Pick<Env, 'POSTHOG_PROJECT_TOKEN' | 'POSTHOG_HOST' | 'ENVIRONMENT'>,
  events: PostHogEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token || events.length === 0) {
    if (!token && env.ENVIRONMENT !== 'production') {
      console.warn('[posthog] POSTHOG_PROJECT_TOKEN is not configured; telemetry is disabled.');
    }
    return;
  }

  let host: URL;
  try {
    host = new URL(env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST);
    if (host.protocol !== 'https:') throw new Error('PostHog host must use HTTPS');
  } catch {
    console.warn('[posthog] invalid POSTHOG_HOST; telemetry batch skipped.');
    return;
  }

  const batch: BatchItem[] = events.map((item) => ({
    event: item.event,
    distinct_id: WORKER_DISTINCT_ID,
    timestamp: item.timestamp ?? new Date().toISOString(),
    properties: {
      $process_person_profile: false,
      ...item.properties,
    },
  }));

  try {
    const response = await fetchImpl(new URL('/batch/', host.origin).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: token, batch }),
    });
    if (!response.ok) console.warn(`[posthog] ingestion failed with HTTP ${response.status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network error';
    console.warn('[posthog] telemetry delivery failed:', message);
  }
}
