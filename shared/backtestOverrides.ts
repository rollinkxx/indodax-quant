// Read-only parameter overrides for the backtest experiment.
//
// The default backtest compares the production config against a single-variable
// crossLookback change. Exit-parameter questions (trailing stop, ATR stops) need to
// sweep arbitrary StrategyParams without editing the active config, so this module
// parses and validates a JSON override object. It never touches the database.
import { DEFAULT_PARAMS, validateParams, type StrategyParams } from './strategy';

/**
 * Parse a JSON object of StrategyParams overrides. Rejects unknown keys and any value
 * that validateParams would refuse, so a typo cannot silently produce a meaningless run.
 * Cross-field rules are checked against `base` (defaults when omitted) to match the
 * configuration the overrides will actually be applied to.
 */
export function parseBacktestOverrides(text: string, base: StrategyParams = DEFAULT_PARAMS): Partial<StrategyParams> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`--overrides must be valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('--overrides must be a JSON object of StrategyParams');
  }
  const obj = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((key) => !(key in DEFAULT_PARAMS));
  if (unknownKeys.length) throw new Error(`unknown override parameter(s): ${unknownKeys.join(', ')}`);
  const errors = validateParams({ ...base, ...obj } as Record<string, unknown>);
  if (errors.length) throw new Error(`invalid override(s): ${errors.join('; ')}`);
  return obj as Partial<StrategyParams>;
}

/** Apply validated overrides on top of a base config, re-validating the merged result. */
export function applyBacktestOverrides(base: StrategyParams, overrides: Partial<StrategyParams>): StrategyParams {
  const merged = { ...base, ...overrides } as StrategyParams;
  const errors = validateParams(merged as unknown as Record<string, unknown>);
  if (errors.length) throw new Error(`invalid overrides after merge: ${errors.join('; ')}`);
  return merged;
}
