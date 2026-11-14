export type HistoryPeriod = '1' | '7' | '30' | 'all';

/** Explains how retained transaction history relates to the current paper-account session. */
export function historyScopeNote(_period: HistoryPeriod): string {
  return '';
}
