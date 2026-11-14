export interface KillSwitchResult {
  status?: string;
  closed?: number;
  total?: number;
  results?: Array<{
    pair?: string;
    ok?: boolean;
    error?: string;
    reason?: string;
  }>;
}

export interface KillSwitchOutcome {
  msg: string;
  err: string | null;
}

/** Summarize account kill status separately from whether every open position closed. */
export function killSwitchOutcome(_result: KillSwitchResult): KillSwitchOutcome {
  return { msg: '', err: null };
}
