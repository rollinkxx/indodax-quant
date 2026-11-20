// Read-only view model for the "Engine Decisions / Why no trade" panel.
//
// The pipeline already records rich per-pair diagnostics in `execution_logs.steps`
// (`analyze.info.buy_diagnostics`, `paper_trading.info.entry_rejections`, ...), but they were only
// reachable through raw JSON. This module turns one stored run into a stable, display-ready shape so
// the UI (and tests) never depend on the raw jsonb layout. It performs no computation and no I/O.

export interface EnginePairDecision {
  pairId: string;
  /** Diagnostic stage reached (e.g. `no_recent_cross`, `indicators_not_ready`). */
  stage: string;
  /** Pipeline outcome (e.g. `passed_mtf`, `blocked_by_mtf`, `blocked_by_data_quality`). */
  outcome: string;
  /** Whether the 5m BUY gate was satisfied (before MTF). */
  candidate: boolean;
  barsSinceCross: number | null;
  filters: Record<string, boolean>;
  metrics: Record<string, number | null>;
  dataQuality: string;
  /** Human-readable MTF state, e.g. `15m:bull 1h:bear` or `off`. */
  mtf: string;
  /** MTF block reason when MTF stopped the entry (e.g. `mtf_against_trend`). */
  mtfBlock: string | null;
  marketAction: string | null;
  holdReason: string | null;
  rawSignalSide: string | null;
}

export interface EngineEntryRejection {
  pairId: string;
  signalId: number | null;
  stage: string;
  reason: string;
  metrics: Record<string, number>;
}

/**
 * Rejection reasons that mean "the engine could not evaluate this pair", not "the engine looked and
 * declined". A run made entirely of these is not a healthy idle HOLD: it is a run where missing or
 * malformed inputs blocked every candidate, and it must be visible as such rather than blending into
 * normal filtering.
 */
export const STRUCTURAL_REJECTION_REASONS: readonly string[] = [
  'stale_ticker',
  'missing_pair_fee',
  'invalid_reward_risk_inputs',
  'stop_out_of_bounds',
  // Sizing returns these when the inputs themselves are unusable. `below_min_notional` and
  // `insufficient_cash` are deliberately absent: those are the engine declining a valid setup.
  'invalid_inputs',
  'invalid_stop',
  // paper_open_position() rejects a malformed order; the other RPC reasons (duplicate,
  // position_already_open, account_not_running) describe account/race state, not bad inputs.
  'invalid_order',
  // Fallbacks used when the callee returns no reason of its own.
  'sizing_rejected',
  'paper_open_rejected',
  // The open RPC itself failed (transport/DB error) rather than returning a business rejection.
  // Every candidate failing this way is a broken engine, not a HOLD.
  'paper_open_failed',
];

export function isStructuralRejection(reason: string): boolean {
  return STRUCTURAL_REJECTION_REASONS.includes(reason);
}

export interface EngineDecisions {
  scheduledTime: string | null;
  status: string | null;
  accountStatus: string | null;
  buySignalsReceived: number;
  entriesOpened: number;
  openPositions: number;
  equity: number | null;
  drawdownPct: number | null;
  pairs: EnginePairDecision[];
  /** Count of pairs per stage, for a quick "why no trade" overview. */
  stageCounts: Record<string, number>;
  mtfBlocked: Record<string, string>;
  entryRejections: EngineEntryRejection[];
  entryRejectionCounts: Record<string, number>;
  /** Rejections caused by unusable inputs rather than by the strategy declining to trade. */
  structuralRejections: number;
  /** True when at least one candidate was rejected for a structural reason this run. */
  structurallyBlocked: boolean;
  riskBlockReasons: string[];
  actions: string[];
  degraded: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBool = (v: unknown): boolean => v === true;

function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isRecord(v)) for (const [k, val] of Object.entries(v)) if (typeof val === 'boolean') out[k] = val;
  return out;
}

function numberMap(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (isRecord(v)) for (const [k, val] of Object.entries(v)) out[k] = asNumber(val);
  return out;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function pairDecision(pairId: string, raw: unknown): EnginePairDecision {
  const d = isRecord(raw) ? raw : {};
  return {
    pairId,
    stage: asString(d.stage) ?? 'unknown',
    outcome: asString(d.outcome) ?? 'unknown',
    candidate: asBool(d.candidate_5m),
    barsSinceCross: asNumber(d.bars_since_cross),
    filters: boolMap(d.filters),
    metrics: numberMap(d.metrics),
    dataQuality: asString(d.data_quality) ?? 'unknown',
    mtf: asString(d.mtf) ?? 'off',
    mtfBlock: asString(d.mtf_block),
    marketAction: asString(d.market_action),
    holdReason: asString(d.hold_reason),
    rawSignalSide: asString(d.raw_signal_side),
  };
}

function entryRejection(raw: unknown): EngineEntryRejection | null {
  if (!isRecord(raw)) return null;
  const pairId = asString(raw.pair_id);
  const reason = asString(raw.reason);
  if (!pairId || !reason) return null;
  const metrics: Record<string, number> = {};
  if (isRecord(raw.metrics)) for (const [k, v] of Object.entries(raw.metrics)) { const n = asNumber(v); if (n !== null) metrics[k] = n; }
  return { pairId, signalId: asNumber(raw.signal_id), stage: asString(raw.stage) ?? 'unknown', reason, metrics };
}

/** A step may be selected as the whole step (`{ok,ms,info}`) or as its `info` object directly. */
function infoOf(step: unknown): Record<string, unknown> {
  if (!isRecord(step)) return {};
  if (isRecord(step.info)) return step.info;
  return step;
}

/** Transform one stored `execution_logs` row (with `analyze`/`paper` steps selected) into the view model. */
export function buildEngineDecisions(row: unknown): EngineDecisions {
  const r = isRecord(row) ? row : {};
  const analyzeInfo = infoOf(r.analyze);
  const paperInfo = infoOf(r.paper);

  const buyDiagnostics = isRecord(analyzeInfo.buy_diagnostics) ? analyzeInfo.buy_diagnostics : {};
  const pairs = Object.entries(buyDiagnostics)
    .map(([pairId, raw]) => pairDecision(pairId, raw))
    .sort((a, b) => a.pairId.localeCompare(b.pairId));

  const stageCounts: Record<string, number> = {};
  for (const p of pairs) stageCounts[p.stage] = (stageCounts[p.stage] ?? 0) + 1;

  const mtfBlocked: Record<string, string> = {};
  if (isRecord(analyzeInfo.mtf_blocked)) for (const [k, v] of Object.entries(analyzeInfo.mtf_blocked)) { const s = asString(v); if (s) mtfBlocked[k] = s; }

  const entryRejections = (Array.isArray(paperInfo.entry_rejections) ? paperInfo.entry_rejections : [])
    .map(entryRejection)
    .filter((x): x is EngineEntryRejection => x !== null);

  // The pipeline records the count itself; fall back to classifying the rejection list so an older
  // stored run (before WP1g) still renders correctly.
  const recordedStructural = asNumber(paperInfo.structural_rejections);
  const structuralRejections = recordedStructural ?? entryRejections.filter((r) => isStructuralRejection(r.reason)).length;

  const entryRejectionCounts: Record<string, number> = {};
  if (isRecord(paperInfo.entry_rejection_counts)) {
    for (const [k, v] of Object.entries(paperInfo.entry_rejection_counts)) { const n = asNumber(v); if (n !== null) entryRejectionCounts[k] = n; }
  }

  return {
    scheduledTime: asString(r.scheduled_time),
    status: asString(r.status),
    accountStatus: asString(paperInfo.status),
    buySignalsReceived: asNumber(paperInfo.buy_signals_received) ?? 0,
    entriesOpened: asNumber(paperInfo.entries_opened) ?? 0,
    openPositions: asNumber(paperInfo.open) ?? 0,
    equity: asNumber(paperInfo.equity),
    drawdownPct: asNumber(paperInfo.drawdown),
    pairs,
    stageCounts,
    mtfBlocked,
    entryRejections,
    entryRejectionCounts,
    structuralRejections,
    structurallyBlocked: structuralRejections > 0,
    riskBlockReasons: stringList(paperInfo.risk_block_reasons),
    actions: stringList(paperInfo.actions),
    degraded: stringList(paperInfo.degraded),
  };
}
