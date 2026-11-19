// Read-only *ingest* of official INDODAX 5m/15m/1h history into the candles table.
//
// Why: the alpha research harness needs far more coverage than the ~11 days / ~14 pairs the
// pipeline has accumulated live. INDODAX's public history endpoint caps ~12,960 bars per request,
// so we page by fixed time windows. We store source='history' and use ON CONFLICT DO NOTHING, so
// this never overwrites trade-built candles the live pipeline owns, and the live pipeline never
// needs the old rows (its coverage recovery is anchored near "now").
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run backfill:candles [-- <days>]
// Env:
//   BACKFILL_DAYS   days of history (default 60)
//   BACKFILL_TOP    take the top-N pairs by 24h IDR volume (default: tracked + in_universe)
//   BACKFILL_PAIRS  explicit comma-separated pair ids (overrides BACKFILL_TOP)
//   BACKFILL_DRY_RUN=1  fetch + normalize + report, but do not write
import { aggregateComplete } from '../shared/mtf';
import { isValidCandle, type Candle } from '../shared/candles';
import { createRequestStartLimiter } from './backtest-history';
import { resolveResearchPairs } from './pairUniverse';
import { IndodaxClient } from '../worker/src/indodax';

function config(): { url: string; key: string; headers: Record<string, string> } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  const headers: Record<string, string> = { apikey: key, accept: 'application/json', 'content-type': 'application/json' };
  if (!key.startsWith('sb_')) headers.authorization = `Bearer ${key}`;
  return { url, key, headers };
}

const ALL_TFS: { tf: '5m' | '15m' | '1h'; sec: number }[] = [
  { tf: '5m', sec: 300 },
  { tf: '15m', sec: 900 },
  { tf: '1h', sec: 3600 },
];
// Default to 5m only: it is the primitive the live pipeline and the alpha harness use, and the
// harness derives 15m/1h from it, so persisting them triples storage for no research gain.
function storeTfs(): typeof ALL_TFS {
  const wanted = (process.env.BACKFILL_TFS ?? "5m").split(",").map((s: string) => s.trim());
  const picked = ALL_TFS.filter((t) => wanted.includes(t.tf));
  return picked.length ? picked : ALL_TFS.slice(0, 1);
}
// INDODAX caps each history response at ~2,593 five-minute bars (~9 days). Requesting a wider
// window silently returns only its most recent ~9 days, so chunk below that: 8 days = 2,304 bars.
const CHUNK_SECONDS = 8 * 86_400;

/** Half-open [from, to) windows covering the range without exceeding one API response. */
export function chunkWindows(fromSec: number, toSec: number, chunkSeconds: number): { from: number; to: number }[] {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || !Number.isFinite(chunkSeconds) ||
      chunkSeconds <= 0 || fromSec >= toSec) return [];
  const out: { from: number; to: number }[] = [];
  for (let from = Math.floor(fromSec); from < toSec; from += chunkSeconds) {
    out.push({ from, to: Math.min(from + chunkSeconds, Math.floor(toSec)) });
  }
  return out;
}

/**
 * Keep only closed, valid, aligned, de-duplicated bars, newest value winning on a duplicate time.
 * `nowSec` guards against a still-forming tail bar being persisted.
 */
export function normalizeSeries(candles: Candle[], tfSec: number, nowSec: number): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (c.source === 'synthetic' || !isValidCandle(c)) continue;
    if (c.t % tfSec !== 0) continue;
    if (c.t + tfSec > nowSec) continue; // not closed yet
    byTime.set(c.t, c);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

interface PairRow { id: string; symbol: string }

async function get<T>(path: string): Promise<T> {
  const { url, headers } = config();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

function candleRow(pairId: string, tf: string, c: Candle): Record<string, unknown> {
  return {
    pair_id: pairId, timeframe: tf, open_time: new Date(c.t * 1000).toISOString(),
    open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, trade_count: c.n,
    is_closed: true, source: 'history',
  };
}

async function upsert(rows: Record<string, unknown>[], dryRun: boolean): Promise<number> {
  if (dryRun || rows.length === 0) return rows.length;
  const { url, headers } = config();
  const batch = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const r = await fetch(`${url}/rest/v1/candles?on_conflict=pair_id,timeframe,open_time`, {
      method: 'POST',
      headers: { ...headers, prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(slice),
    });
    if (!r.ok) throw new Error(`upsert candles: ${r.status} ${await r.text()}`);
    written += slice.length;
  }
  return written;
}

async function resolvePairs(): Promise<PairRow[]> {
  return resolveResearchPairs(get, {
    top: Number(process.env.BACKFILL_TOP ?? 0),
    explicit: process.env.BACKFILL_PAIRS?.split(','),
  });
}

async function main(): Promise<void> {
  const days = Math.max(1, Math.min(400, Number(process.argv[2] ?? process.env.BACKFILL_DAYS ?? 60)));
  const dryRun = process.env.BACKFILL_DRY_RUN === '1';
  const nowSec = Math.floor(Date.now() / 1000);
  const toSec = Math.floor(nowSec / 300) * 300; // last closed 5m boundary
  const fromSec = toSec - days * 86_400;

  const acquire = createRequestStartLimiter(400); // ~150 req/min, under INDODAX's 180/min quota
  const rateLimitedFetch: typeof fetch = async (input, init) => { await acquire(); return fetch(input, init); };
  const client = new IndodaxClient(rateLimitedFetch, { timeoutMs: 15_000, retries: 2 });

  const pairs = await resolvePairs();
  const tfs = storeTfs();
  const windows = chunkWindows(fromSec, toSec, CHUNK_SECONDS);
  console.log(`[backfill] pairs=${pairs.length} days=${days} windows/pair=${windows.length} tfs=${tfs.map((t) => t.tf).join(',')} dryRun=${dryRun}`);
  console.log(`[backfill] range ${new Date(fromSec * 1000).toISOString()} .. ${new Date(toSec * 1000).toISOString()}`);

  let totalRows = 0;
  for (const pair of pairs) {
    const fiveMinute: Candle[] = [];
    try {
      for (const w of windows) {
        const rows = await client.getHistory(pair.symbol.toUpperCase(), '5', w.from, w.to - 300);
        fiveMinute.push(...rows);
      }
    } catch (e) {
      console.warn(`[backfill] skip ${pair.id}: ${(e as Error).message}`);
      continue;
    }
    const base = normalizeSeries(fiveMinute, 300, nowSec);
    if (base.length === 0) { console.warn(`[backfill] ${pair.id}: no usable 5m bars`); continue; }

    const rows: Record<string, unknown>[] = [];
    for (const { tf, sec } of tfs) {
      const series = sec === 300 ? base : normalizeSeries(aggregateComplete(base, sec), sec, nowSec);
      for (const c of series) rows.push(candleRow(pair.id, tf, c));
    }
    try {
      const written = await upsert(rows, dryRun);
      totalRows += written;
    } catch (e) {
      console.warn(`[backfill] write failed ${pair.id}: ${(e as Error).message}`);
      continue;
    }
    console.log(`[backfill] ${pair.id}: 5m=${base.length} rows=${rows.length} ${dryRun ? '(dry-run)' : 'upserted'}`);
  }
  console.log(`[backfill] done. total rows ${dryRun ? 'would write' : 'upserted'}: ${totalRows}`);
}

// Only run when invoked directly; importing this module (tests) must not trigger network I/O.
if (process.argv[1] && /backfill-candles\.(ts|js|mts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
