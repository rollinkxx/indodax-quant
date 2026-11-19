export {};

const workerUrl = process.env.WORKER_URL?.replace(/\/$/, '');
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!workerUrl || !supabaseUrl || !key) {
  throw new Error('WORKER_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for production smoke');
}

const healthResponse = await fetch(`${workerUrl}/api/health`);
if (!healthResponse.ok) throw new Error(`Worker health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json() as { ok?: boolean; liveTrading?: boolean };
if (health.ok !== true || health.liveTrading !== false) throw new Error('Worker health did not confirm paper-only mode');

const appResponse = await fetch(`${workerUrl}/`);
if (!appResponse.ok) throw new Error(`Static dashboard returned HTTP ${appResponse.status}`);
const appHtml = await appResponse.text();
if (!/<!doctype html|<html/i.test(appHtml)) throw new Error('Static dashboard response is not HTML');

const headers: Record<string, string> = { apikey: key, accept: 'application/json' };
if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;

async function select<T>(path: string): Promise<T[]> {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers });
  if (!response.ok) throw new Error(`Read-only production verification failed: HTTP ${response.status}`);
  return await response.json() as T[];
}

const [accounts, configs] = await Promise.all([
  select<{ status: string; kill_switch: boolean }>('paper_accounts?select=status,kill_switch&id=eq.1&limit=1'),
  select<{ params: Record<string, unknown> }>('strategy_configs?select=params&is_active=eq.true&limit=1'),
]);

if (!accounts[0] || accounts[0].status !== 'RUNNING' || accounts[0].kill_switch !== false) {
  throw new Error('Paper account is not RUNNING with kill switch off');
}
const p = configs[0]?.params;
if (!p || Number(p.feePct) !== 0.2 || p.feeModel !== 'pair_taker' || p.mtfMode !== 'score'
  || Number(p.riskPerTradePct) !== 1 || Number(p.maxEntrySpreadPct) !== 0.6
  || Number(p.maxEntryDriftPct) !== 0.5 || Number(p.maxOpenPositions) !== 10
  || Number(p.maxTotalExposurePct) !== 60) {
  throw new Error('Active paper strategy configuration does not match the approved production snapshot');
}
// Cron runs once per minute and a healthy pipeline normally takes several seconds.
// Do not fail while the newest row is still RUNNING; require a SUCCESS run that began
// after this deployment/relay activation, and wait through the next scheduled tick.
const configuredMinStart = Number(process.env.MIN_PIPELINE_START_AT);
const minPipelineStartMs = Number.isFinite(configuredMinStart) && configuredMinStart > 0
  ? configuredMinStart * 1000
  : Date.now() - 5 * 60_000;
const deadline = Date.now() + 110_000;
let latest: { status: string; started_at: string } | undefined;
let freshSuccess = false;

while (Date.now() < deadline) {
  const rows = await select<{ status: string; started_at: string }>(
    'execution_logs?select=status,started_at&order=started_at.desc&limit=1',
  );
  latest = rows[0];
  const startedAtMs = latest ? Date.parse(latest.started_at) : Number.NaN;
  if (latest && Number.isFinite(startedAtMs) && startedAtMs >= minPipelineStartMs - 15_000) {
    if (latest.status === 'SUCCESS') {
      freshSuccess = true;
      break;
    }
    if (startedAtMs >= minPipelineStartMs
      && (latest.status === 'FAILED' || latest.status === 'PARTIAL')) {
      throw new Error(`Post-deploy pipeline finished with ${latest.status} at ${latest.started_at}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 4_000));
}

if (!freshSuccess) {
  throw new Error(
    `No SUCCESS pipeline execution started after deployment within 110s; latest=${latest?.status ?? 'missing'} at ${latest?.started_at ?? 'n/a'}`,
  );
}

const tickers = await select<{ server_time: string; updated_at: string }>(
  'market_tickers_latest?select=server_time,updated_at&order=updated_at.desc&limit=1',
);
const ticker = tickers[0];
const tickerAgeMs = ticker ? Date.now() - Date.parse(ticker.updated_at) : Number.POSITIVE_INFINITY;
const marketTimeAgeMs = ticker ? Date.now() - Date.parse(ticker.server_time) : Number.POSITIVE_INFINITY;
if (!ticker || !Number.isFinite(tickerAgeMs) || tickerAgeMs < -60_000 || tickerAgeMs > 5 * 60_000
  || !Number.isFinite(marketTimeAgeMs) || marketTimeAgeMs < -60_000 || marketTimeAgeMs > 5 * 60_000) {
  throw new Error('INDODAX market ticker ingestion is missing, stale, or has a stale upstream server timestamp');
}

console.log('Production smoke passed: Worker health, paper-only mode, dashboard HTML, active risk/fee config, post-deploy successful cron execution and fresh INDODAX market data verified.');
