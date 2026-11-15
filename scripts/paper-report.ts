// Read-only paper account performance and entry-rejection report.
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run paper:report -- [accountId]
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const ACCOUNT_ID = process.argv[2] ?? '1';
const headers: Record<string, string> = { apikey: KEY, accept: 'application/json' };
if (!KEY.startsWith('sb_')) headers.authorization = `Bearer ${KEY}`;

async function get<T>(table: string, filters: Record<string, string>): Promise<T> {
  const url = new URL(`${URL_}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const n = (value: number | string | null | undefined) => Number(value ?? 0);

async function getAll<T>(table: string, filters: Record<string, string>): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < 50_000; offset += 1_000) {
    const page = await get<T[]>(table, { ...filters, limit: '1000', offset: String(offset) });
    all.push(...page);
    if (page.length < 1_000) break;
  }
  return all;
}


interface Account {
  id: number; name: string; status: string; reset_at: string;
  equity: number | string; cash_balance: number | string; realized_pnl: number | string;
  unrealized_pnl: number | string; total_fees: number | string; max_drawdown_pct: number | string;
}
interface Position {
  id: number; pair_id: string; status: string; cost_basis: number | string;
  realized_pnl: number | string | null; entry_fee: number | string | null; exit_fee: number | string | null;
  opened_at: string; closed_at: string | null; exit_reason: string | null;
}
interface Snapshot { snapshot_time: string; drawdown_pct: number | string; equity: number | string }
interface ExecutionLog { scheduled_time: string; steps: Record<string, any> }

async function main() {
  const accounts = await get<Account[]>('paper_accounts', {
    select: 'id,name,status,reset_at,equity,cash_balance,realized_pnl,unrealized_pnl,total_fees,max_drawdown_pct',
    id: `eq.${ACCOUNT_ID}`, limit: '1',
  });
  const account = accounts[0];
  if (!account) throw new Error(`Paper account ${ACCOUNT_ID} not found`);

  const since = account.reset_at;
  const [positions, snapshots, logs] = await Promise.all([
    getAll<Position>('paper_positions', {
      select: 'id,pair_id,status,cost_basis,realized_pnl,entry_fee,exit_fee,opened_at,closed_at,exit_reason',
      account_id: `eq.${ACCOUNT_ID}`, opened_at: `gte.${since}`, order: 'opened_at.asc',
    }),
    getAll<Snapshot>('portfolio_snapshots', {
      select: 'snapshot_time,drawdown_pct,equity',
      account_id: `eq.${ACCOUNT_ID}`, snapshot_time: `gte.${since}`, order: 'snapshot_time.asc',
    }),
    getAll<ExecutionLog>('execution_logs', {
      select: 'scheduled_time,steps', scheduled_time: `gte.${since}`, order: 'scheduled_time.asc',
    }),
  ]);

  const closed = positions.filter((p) => p.status === 'CLOSED' && p.closed_at);
  const wins = closed.filter((p) => n(p.realized_pnl) > 0);
  const losses = closed.filter((p) => n(p.realized_pnl) <= 0);
  const grossProfit = wins.reduce((sum, p) => sum + n(p.realized_pnl), 0);
  const grossLoss = -losses.reduce((sum, p) => sum + n(p.realized_pnl), 0);
  const netPnl = closed.reduce((sum, p) => sum + n(p.realized_pnl), 0);
  const totalFees = positions.reduce((sum, p) => sum + n(p.entry_fee) + n(p.exit_fee), 0);
  const totalCost = closed.reduce((sum, p) => sum + n(p.cost_basis), 0);
  const maxObservedDrawdown = snapshots.reduce((max, s) => Math.max(max, n(s.drawdown_pct)), 0);

  const rejectionCounts: Record<string, number> = {};
  const rejectionStages: Record<string, number> = {};
  let buySignals = 0;
  let entriesOpened = 0;
  for (const log of logs) {
    const info = log.steps?.paper_trading?.info;
    if (!info) continue;
    buySignals += n(info.buy_signals_received);
    entriesOpened += n(info.entries_opened);
    for (const rejection of Array.isArray(info.entry_rejections) ? info.entry_rejections : []) {
      const reason = String(rejection.reason ?? 'unknown');
      const stage = String(rejection.stage ?? 'unknown');
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
      rejectionStages[stage] = (rejectionStages[stage] ?? 0) + 1;
    }
  }

  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const report = {
    account: {
      id: account.id, name: account.name, status: account.status, resetAt: since,
      equityIdr: n(account.equity), cashIdr: n(account.cash_balance),
      accountRealizedPnlIdr: n(account.realized_pnl), accountUnrealizedPnlIdr: n(account.unrealized_pnl),
    },
    paperPerformanceSinceReset: {
      closedTrades: closed.length,
      openPositions: positions.filter((p) => p.status === 'OPEN').length,
      wins: wins.length, losses: losses.length,
      winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      netPnlIdr: netPnl,
      expectancyPerClosedTradeIdr: closed.length ? netPnl / closed.length : 0,
      averageWinIdr: avgWin, averageLossIdr: avgLoss,
      averageReturnPct: closed.length
        ? closed.reduce((sum, p) => sum + (n(p.cost_basis) > 0 ? n(p.realized_pnl) / n(p.cost_basis) * 100 : 0), 0) / closed.length
        : 0,
      positionFeesIdr: totalFees,
      averageNetReturnOnCostPct: totalCost > 0 ? netPnl / totalCost * 100 : 0,
      maxDrawdownPct: Math.max(n(account.max_drawdown_pct), maxObservedDrawdown),
      exitsByReason: closed.reduce<Record<string, number>>((counts, p) => {
        const reason = p.exit_reason ?? 'unknown';
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      }, {}),
    },
    entryFunnelSinceReset: {
      buySignalsReceived: buySignals, entriesOpened,
      rejectionCount: Object.values(rejectionCounts).reduce((a, b) => a + b, 0),
      rejectionCountsByReason: rejectionCounts,
      rejectionCountsByStage: rejectionStages,
      sourceRuns: logs.length,
    },
    limitations: [
      'Only paper positions opened since the account reset are included.',
      'Profit factor and expectancy are not meaningful until a sufficient closed-trade sample exists.',
      'No live orders are sent by this report.',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });
