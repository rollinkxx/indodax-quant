// Read-only regime study: does a trend/regime filter turn the long-only engine positive?
//
// The settled research state says the 5m price/volume BUY signal has no edge at 0.2%/side. The
// remaining question is not "can we tune the entry" but "is there a market state where the long
// side pays". This script answers that with non-overlapping trades, because a forward-return study
// reuses the same future bars across thousands of samples and inflates every mean.
//
// Method (causal):
//   - bar i may only use data with index <= i (rolling SMA / ATR computed over trailing rows);
//   - entry at bar i+1 open, exit at the first of stop/target/time-stop, priced from OHLC;
//   - a trade occupies [i+1, exit]; the next candidate must start after the exit (no overlap);
//   - every trade pays the real round-trip cost (fee 2x + slippage 2x) exactly like the engine;
//   - results are split into chronological thirds so a single regime cannot carry the total.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run regime:study [maxPairs]
import type { Candle } from '../shared/candles';
import { fillGaps } from '../shared/candles';
import { roundTripCostPct } from '../shared/paper';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const headers: Record<string, string> = { apikey: KEY, accept: 'application/json' };
if (!KEY.startsWith('sb_')) headers.authorization = `Bearer ${KEY}`;

const FEE_PCT = 0.2;          // per side, INDODAX IDR taker
const SLIP_BPS = 10;          // per side
const COST_PCT = roundTripCostPct(FEE_PCT, SLIP_BPS);
const BAR_SEC = 300;
const MAX_PAIRS = Math.max(1, Math.min(200, Number(process.argv[2] ?? 30)));

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number | null; source: string }

async function loadCandles(pair: string): Promise<Candle[]> {
  const out: Row[] = [];
  // PostgREST caps a response at 1000 rows: page until a short page arrives, never cap by offset.
  for (let offset = 0; offset < 60_000; offset += 1000) {
    const page = await get<Row[]>(
      `candles?select=open_time,open,high,low,close,volume,trade_count,source&timeframe=eq.5m&pair_id=eq.${pair}` +
      `&is_closed=eq.true&order=open_time.asc&limit=1000&offset=${offset}`,
    );
    out.push(...page);
    if (page.length < 1000) break;
  }
  return fillGaps(
    out.map((r) => ({
      t: Math.floor(Date.parse(r.open_time) / 1000),
      o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume),
      n: Number(r.trade_count ?? 0),
      source: (r.source ?? 'synthetic') as Candle['source'],
    })),
    BAR_SEC,
  );
}

interface Trade { pair: string; entryIdx: number; exitIdx: number; retPct: number; netPct: number; reason: string; }

/**
 * One non-overlapping long trade per candidate window. `allow` decides, from data available at the
 * signal bar only, whether this bar is eligible. Stop/target are ATR multiples, exit precedence is
 * stop-first (a gap through both levels is a stop, the pessimistic assumption).
 */
function runFilter(
  pair: string,
  c: Candle[],
  allow: (i: number) => boolean,
  opts: { stopAtr: number; tpAtr: number; maxHoldBars: number },
): Trade[] {
  const trades: Trade[] = [];
  const atrPeriod = 14;
  // Trailing ATR (Wilder) computed causally.
  const tr = new Array<number>(c.length).fill(NaN);
  const atr = new Array<number>(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    atr[i] = i < atrPeriod ? NaN : i === atrPeriod ? tr.slice(1, atrPeriod + 1).reduce((a, b) => a + b, 0) / atrPeriod
      : (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
  }
  let i = 1;
  while (i < c.length - 1) {
    if (!Number.isFinite(atr[i]) || atr[i] <= 0 || !allow(i)) { i++; continue; }
    const entryIdx = i + 1;
    const entry = c[entryIdx].o;
    if (!(entry > 0)) { i++; continue; }
    const stop = entry - opts.stopAtr * atr[i];
    const tp = entry + opts.tpAtr * atr[i];
    let exitIdx = -1;
    let exitPrice = NaN;
    let reason = 'TIME_STOP';
    const last = Math.min(c.length - 1, entryIdx + opts.maxHoldBars);
    for (let j = entryIdx; j <= last; j++) {
      if (c[j].l <= stop) { exitIdx = j; exitPrice = stop; reason = 'STOP_LOSS'; break; }
      if (c[j].h >= tp) { exitIdx = j; exitPrice = tp; reason = 'TAKE_PROFIT'; break; }
    }
    if (exitIdx < 0) { exitIdx = last; exitPrice = c[last].c; }
    if (!(exitPrice > 0)) { i++; continue; }
    const grossPct = (exitPrice / entry - 1) * 100;
    trades.push({ pair, entryIdx, exitIdx, retPct: grossPct, netPct: grossPct - COST_PCT, reason });
    i = exitIdx + 1; // no overlap: the next candidate starts after this trade closed
  }
  return trades;
}

function summarise(label: string, trades: Trade[]) {
  if (!trades.length) { console.log(`${label.padEnd(46)} n=0`); return; }
  const net = trades.map((t) => t.netPct).sort((a, b) => a - b);
  const sum = net.reduce((a, b) => a + b, 0);
  const mean = sum / net.length;
  const wins = trades.filter((t) => t.netPct > 0);
  const grossWin = wins.reduce((a, t) => a + t.netPct, 0);
  const grossLoss = -trades.filter((t) => t.netPct <= 0).reduce((a, t) => a + t.netPct, 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const median = net[Math.floor(net.length / 2)];
  // Chronological thirds: a filter must not owe its result to one regime.
  const third = Math.max(1, Math.floor(trades.length / 3));
  const t3 = [0, 1, 2].map((k) => {
    const slice = trades.slice(k * third, k === 2 ? trades.length : (k + 1) * third);
    return slice.length ? slice.reduce((a, t) => a + t.netPct, 0) / slice.length : 0;
  });
  console.log(
    `${label.padEnd(46)} n=${String(trades.length).padStart(4)} win=${(100 * wins.length / trades.length).toFixed(1).padStart(5)}%` +
    ` mean=${mean.toFixed(3).padStart(7)} med=${median.toFixed(3).padStart(7)} PF=${(pf === Infinity ? 'inf' : pf.toFixed(2)).padStart(5)}` +
    ` thirds=[${t3.map((x) => x.toFixed(2)).join(', ')}]`,
  );
}

async function main() {
  // The sample is fixed, not "today's universe": the 29 pairs with the deepest stored 5m history.
  // Using the live universe would silently drop pairs that traded during the sample and have since
  // fallen out of favour, which is exactly the survivorship bias this study must avoid.
  const PAIRS = [
    'adaidr', 'asteridr', 'btcidr', 'solidr', 'suiidr', 'uaiidr', 'xrpidr', 'penguidr', 'enaidr',
    'ethidr', 'fartcoinidr', 'hypeidr', 'cstidr', 'anoaidr', 'pepeidr', 'dogeidr', 'pippinidr',
    'velvetidr', 'icntidr', 'pieverseidr', 'ondoidr', 'beatidr', 'rareidr', 'onlidr', 'usdtidr',
    'ankridr', 'neonidr', 'xautidr', 'usdcidr',
  ].slice(0, MAX_PAIRS);
  const pairs = PAIRS;
  if (!pairs.length) { console.error('no pairs selected'); process.exit(1); }
  console.log(`regime study: ${pairs.length} pairs, round-trip cost ${COST_PCT.toFixed(2)}% (fee ${FEE_PCT}x2 + slip ${SLIP_BPS}bps x2)\n`);

  const all: Record<string, Trade[]> = {};
  const push = (k: string, t: Trade[]) => { (all[k] ??= []).push(...t); };

  for (const pair of pairs) {
    const c = await loadCandles(pair);
    if (c.length < 400) continue;
    const sma = (i: number, n: number) => {
      if (i < n) return NaN;
      let s = 0;
      for (let k = i - n + 1; k <= i; k++) s += c[k].c;
      return s / n;
    };
    const dev = (i: number, n: number) => { const m = sma(i, n); return m > 0 ? c[i].c / m - 1 : NaN; };

    push('A. no filter (baseline)', runFilter(pair, c, () => true, { stopAtr: 1.5, tpAtr: 3, maxHoldBars: 48 }));
    push('B. only below SMA288 (bear dip)', runFilter(pair, c, (i) => dev(i, 288) < 0, { stopAtr: 1.5, tpAtr: 3, maxHoldBars: 48 }));
    push('C. only above SMA288 (trend)', runFilter(pair, c, (i) => dev(i, 288) > 0, { stopAtr: 1.5, tpAtr: 3, maxHoldBars: 48 }));
    push('D. dip -1.5..-3% (in-sample best)', runFilter(pair, c, (i) => { const d = dev(i, 288); return d >= -0.03 && d <= -0.015; }, { stopAtr: 1.5, tpAtr: 3, maxHoldBars: 48 }));
    push('E. above SMA + trend confirm', runFilter(pair, c, (i) => dev(i, 288) > 0 && sma(i, 24) > sma(i, 96), { stopAtr: 1.5, tpAtr: 3, maxHoldBars: 48 }));
    // Wider bracket: the live config's inverted 9/5 is what the guard now blocks. A legal 1.5/3 is
    // the reference; 2/4 and 3/6 test whether a bigger target survives the same cost.
    push('F. no filter, stop2/tp4', runFilter(pair, c, () => true, { stopAtr: 2, tpAtr: 4, maxHoldBars: 96 }));
    push('G. no filter, stop3/tp6', runFilter(pair, c, () => true, { stopAtr: 3, tpAtr: 6, maxHoldBars: 192 }));
  }

  for (const [label, trades] of Object.entries(all)) summarise(label, trades);
  console.log(`\nNet of ${COST_PCT.toFixed(2)}% round trip. Positive mean alone is not enough: require`);
  console.log(`mean>0, median>0, PF>1, and all three thirds positive.`);
}

main();
