// Structured BUY/SELL/HOLD decision: raw signal → MTF → economics → risk → final.
//
// Before this module every blocking condition collapsed into a single `HOLD` with one free-text
// reason, so an operator could not tell "no setup" from "spread too wide" from "risk budget spent",
// and counters for raw vs final actions did not exist. The gates stay independent here: each one
// records its own action and reason, and only the final combination decides what is executed.

import type { MarketAction, MarketActionDecision, SignalDecision } from './strategy';
import type { MtfMarketActionOutcome } from './mtf';

export interface EconomicsGateResult {
  /** Null = passed; otherwise the machine-readable rejection reason. */
  reason: string | null;
  /** Expected net reward/risk ratio, when the gate computed one. */
  netRewardRiskRatio?: number | null;
}

export interface RiskGateResult {
  blockEntries: boolean;
  reasons: string[];
}

export interface QuoteContext {
  ok: boolean;
  ageSec: number | null;
  spreadBps: number | null;
  reason?: string;
}

export interface DecisionInputs {
  raw: MarketActionDecision;
  /** Present only when MTF is enabled; `action` is the post-MTF market action. */
  mtf?: MtfMarketActionOutcome;
  economics?: EconomicsGateResult;
  risk?: RiskGateResult;
  quote?: QuoteContext;
  feePct?: number | null;
  slippageBps?: number | null;
}

export interface StructuredDecision {
  raw_action: MarketAction;
  raw_reason: string;
  mtf_action: MarketAction | null;
  mtf_reason: string | null;
  economics_action: MarketAction | null;
  economics_reason: string | null;
  risk_action: MarketAction | null;
  risk_reason: string | null;
  final_action: MarketAction;
  final_reason: string;
  quote_age_sec: number | null;
  spread_bps: number | null;
  expected_net_reward_risk: number | null;
  fee_rate: number | null;
  slippage_assumption_bps: number | null;
  /** The signal that would be executed, if the final action is BUY or SELL. */
  signal: SignalDecision | null;
}

/**
 * Combine the gates. Precedence: quote freshness → MTF → economics → risk. A stale/invalid quote
 * blocks BUY first because nothing downstream can be trusted without a price; SELL exits are never
 * blocked by MTF or economics (they only apply to entries), but a stale quote still holds them.
 */
export function combineDecision(i: DecisionInputs): StructuredDecision {
  const rawAction = i.raw.action;
  const mtfAction = i.mtf ? i.mtf.action.action : null;
  const mtfReason = i.mtf ? (i.mtf.action.action === 'HOLD' ? i.mtf.action.reason : null) : null;
  const econReason = i.economics?.reason ?? null;
  const riskBlocked = !!i.risk?.blockEntries;
  const riskReason = riskBlocked ? (i.risk?.reasons.join('; ') || 'risk_blocked') : null;

  const base = {
    raw_action: rawAction,
    raw_reason: i.raw.reason,
    mtf_action: mtfAction,
    mtf_reason: mtfReason,
    economics_action: econReason ? ('HOLD' as MarketAction) : null,
    economics_reason: econReason,
    risk_action: riskBlocked ? ('HOLD' as MarketAction) : null,
    risk_reason: riskReason,
    quote_age_sec: i.quote?.ageSec ?? null,
    spread_bps: i.quote?.spreadBps ?? null,
    expected_net_reward_risk: i.economics?.netRewardRiskRatio ?? null,
    fee_rate: i.feePct ?? null,
    slippage_assumption_bps: i.slippageBps ?? null,
  };

  if (i.quote && !i.quote.ok) {
    return { ...base, final_action: 'HOLD', final_reason: i.quote.reason ? `quote_${i.quote.reason}` : 'quote_unavailable', signal: null };
  }

  // After MTF, the candidate action and its signal.
  const candidate: MarketAction = i.mtf ? i.mtf.action.action : rawAction;
  const candidateSignal: SignalDecision | null = i.mtf ? i.mtf.action.signal : i.raw.signal;

  if (candidate === 'HOLD') {
    return { ...base, final_action: 'HOLD', final_reason: (i.mtf ? i.mtf.action.reason : i.raw.reason) || 'no_setup', signal: null };
  }
  if (candidate === 'SELL') {
    // SELL is an exit: MTF/economics do not apply, risk blocking does not withhold a protective exit.
    return { ...base, final_action: 'SELL', final_reason: 'sell_signal', signal: candidateSignal };
  }

  // BUY: apply economics then risk.
  if (econReason) return { ...base, final_action: 'HOLD', final_reason: `economics_${econReason}`, signal: null };
  if (riskBlocked) return { ...base, final_action: 'HOLD', final_reason: `risk_${riskReason}`, signal: null };
  return { ...base, final_action: 'BUY', final_reason: 'buy_confirmed', signal: candidateSignal };
}

export interface DecisionCounters {
  raw_buy_count: number;
  raw_sell_count: number;
  final_buy_count: number;
  final_sell_count: number;
  mtf_block_count: number;
  spread_block_count: number;
  reward_risk_block_count: number;
  stale_data_block_count: number;
  risk_block_count: number;
  duplicate_signal_count: number;
}

export function emptyDecisionCounters(): DecisionCounters {
  return {
    raw_buy_count: 0, raw_sell_count: 0, final_buy_count: 0, final_sell_count: 0,
    mtf_block_count: 0, spread_block_count: 0, reward_risk_block_count: 0,
    stale_data_block_count: 0, risk_block_count: 0, duplicate_signal_count: 0,
  };
}

/** Accumulate one structured decision into the run counters (mutates and returns `counters`). */
export function tallyDecision(counters: DecisionCounters, d: StructuredDecision, opts: { duplicate?: boolean } = {}): DecisionCounters {
  if (d.raw_action === 'BUY') counters.raw_buy_count++;
  else if (d.raw_action === 'SELL') counters.raw_sell_count++;
  if (d.final_action === 'BUY') counters.final_buy_count++;
  else if (d.final_action === 'SELL') counters.final_sell_count++;
  if (d.final_action === 'HOLD') {
    if (d.mtf_reason) counters.mtf_block_count++;
    if (d.final_reason.startsWith('quote_') || d.final_reason.includes('stale')) counters.stale_data_block_count++;
    if (d.final_reason.includes('wide_spread') || d.final_reason.includes('spread')) counters.spread_block_count++;
    if (d.economics_reason) counters.reward_risk_block_count++;
    if (d.risk_action === 'HOLD') counters.risk_block_count++;
  }
  if (opts.duplicate) counters.duplicate_signal_count++;
  return counters;
}
