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

const [accounts, configs, logs] = await Promise.all([
  select<{ status: string; kill_switch: boolean }>('paper_accounts?select=status,kill_switch&id=eq.1&limit=1'),
  select<{ params: Record<string, unknown> }>('strategy_configs?select=params&is_active=eq.true&limit=1'),
  select<{ status: string; started_at: string }>('execution_logs?select=status,started_at&order=started_at.desc&limit=1'),
]);

if (!accounts[0] || accounts[0].status !== 'RUNNING' || accounts[0].kill_switch !== false) {
  throw new Error('Paper account is not RUNNING with kill switch off');
}
const p = configs[0]?.params;
if (!p || Number(p.feePct) !== 0.00555 || p.mtfMode !== 'score'
  || Number(p.riskPerTradePct) !== 1 || Number(p.maxEntrySpreadPct) !== 0.6
  || Number(p.maxEntryDriftPct) !== 0.5 || Number(p.maxOpenPositions) !== 10
  || Number(p.maxTotalExposurePct) !== 60) {
  throw new Error('Active paper strategy configuration does not match the approved production snapshot');
}
const latest = logs[0];
const ageMs = latest ? Date.now() - Date.parse(latest.started_at) : Number.POSITIVE_INFINITY;
if (!latest || latest.status !== 'SUCCESS' || !Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > 5 * 60_000) {
  throw new Error('Latest scheduled pipeline execution is missing, not SUCCESS, or older than five minutes');
}

console.log('Production smoke passed: Worker health, paper-only mode, dashboard HTML, paper account, active risk/fee config, and recent cron execution verified.');
