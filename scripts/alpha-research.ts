// Read-only alpha research harness. No orders, no writes: it only reads stored 5m candles and
// measures whether a candidate feature predicts forward returns net of the real round-trip fee.
//
// Method: pool every stored 5m candle across the tracked/universe pairs, compute features causally
// (indicators use only data <= bar i; MTF state uses only completed 15m/1h buckets <= bar i), then
// measure the mean forward return at several horizons. A per-pair chronological 70/30 split keeps a
// holdout: a feature is only credible if its holdout mean also clears the cost hurdle.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run alpha:research [-- maxPairs]
import { computeIndicators, evaluateMarketAction, mergeParams, type StrategyParams } from '../shared/strategy';
import {
  aggregateComplete, applyMtfToMarketAction, buildHigherSeries, HIGHER_TFS, lastCompleteBucket,
  MTF_WINDOW, trendState, type TfState,
} from '../shared/mtf';
import type { Candle } from '../shared/candles';
import { resolveResearchPairs } from './pairUniverse';
import {
  contiguousSegments, evaluateHypothesis, forwardReturns, holdoutStartIndex, meanForwardVector,
  pctChange, quantileCuts, type AlphaSample,
} from '../shared/alphaResearch';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const headers: Record<string, string> = { apikey: KEY, accept: 'application/json' };
if (!KEY.startsWith('sb_')) headers.authorization = `Bearer ${KEY}`;

const FEE_ROUND_TRIP_PCT = 0.4; // 0.2%/side pair taker, the live model
const HORIZONS = [6, 12, 24, 48, 288] as const; // bars of 5m: 30m, 1h, 2h, 4h, 24h
const MAX_HORIZON = Math.max(...HORIZONS);
const VERDICT_HORIZON = HORIZONS.indexOf(48);
const MAX_PAIRS = Math.max(1, Math.min(500, Number(process.argv[2] ?? process.env.ALPHA_MAX_PAIRS ?? 60)));

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number; trade_count: number; source: string }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function fetchCandles(pair: string): Promise<Candle[]> {
  const out: Candle[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const rows = await get<Row[]>(`candles?select=open_time,open,high,low,close,volume,trade_count,source&pair_id=eq.${pair}&timeframe=eq.5m&is_closed=eq.true&order=open_time.asc&limit=${page}&offset=${offset}`);
    for (const r of rows) {
      out.push({ t: Math.floor(Date.parse(r.open_time) / 1000), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, n: r.trade_count, source: r.source as Candle['source'] });
    }
    if (rows.length < page) break;
  }
  return out;
}

function buildSamples(pair: string, seg: Candle[], P: StrategyParams): AlphaSample[] {
  const rows = computeIndicators(seg, P);
  const mtfOn = P.mtfMode !== 'off';
  const htf = mtfOn ? HIGHER_TFS.map((h) => ({ tf: h.tf, sec: h.sec, candles: aggregateComplete(seg, h.sec) })) : [];
  const cache = new Map<string, TfState>();
  const statesAt = (i: number): TfState[] => htf.map((h) => {
    const lb = lastCompleteBucket(seg[i].t, h.sec);
    const key = `${h.sec}:${lb}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const hs = buildHigherSeries([], h.candles, h.sec, lb, MTF_WINDOW);
    const st = trendState(h.tf, hs, lb, P);
    cache.set(key, st);
    return st;
  });

  const splitAt = holdoutStartIndex(seg.length);
  const win = Math.max(3, P.crossLookback + 1);
  const out: AlphaSample[] = [];
  for (let i = P.minCandles; i < seg.length; i++) {
    const fwd = forwardReturns(seg, i, HORIZONS);
    if (!fwd) break;
    const c = seg[i];
    const r = rows[i];
    if (r.ema9 === null || r.ema21 === null || r.ema50 === null || r.rsi14 === null || r.atr14 === null || r.volMa20 === null) continue;
    const ret24h = i >= 288 ? pctChange(c.c, seg[i - 288].c) : 0;
    const look20 = seg.slice(Math.max(0, i - 20), i);
    const hi20 = look20.length ? Math.max(...look20.map((x) => x.h)) : 0;
    const st15 = statesAt(i).find((s) => s.tf === '15m')?.trend ?? 'unknown';
    const st1h = statesAt(i).find((s) => s.tf === '1h')?.trend ?? 'unknown';

    // Production BUY decision at bar i (raw action, then MTF), for the baseline hypothesis.
    const wRows = rows.slice(i - win + 1, i + 1);
    const wVol = seg.slice(i - win + 1, i + 1).map((x) => x.v);
    const action = evaluateMarketAction(wRows, wVol, P);
    const rawBuy = action.signal?.side === 'BUY' ? 1 : 0;
    const finalAction = mtfOn ? applyMtfToMarketAction(action, statesAt(i), P.mtfMode).action : action;
    const prodBuy = finalAction.signal?.side === 'BUY' ? 1 : 0;

    out.push({
      pair, isHoldout: i >= splitAt, close: c.c, forward: fwd,
      features: {
        rsi14: r.rsi14,
        emaSpreadPct: pctChange(r.ema9, r.ema21),
        emaTrendPct: pctChange(c.c, r.ema50),
        volRatio: r.volMa20 > 0 ? c.v / r.volMa20 : 0,
        atrPct: c.c > 0 ? r.atr14 / c.c * 100 : 0,
        macdHist: r.macdHist ?? 0,
        distResistancePct: r.resistance ? pctChange(r.resistance, c.c) : 0,
        distSupportPct: r.support ? pctChange(r.support, c.c) : 0,
        ret24hPct: ret24h,
        breakout20Pct: look20.length ? pctChange(c.c, hi20) : 0,
        prodBuy,
        rawBuy,
        mtf15: st15,
        mtf1h: st1h,
      },
    });
  }
  return out;
}

interface Hypothesis { name: string; test: (f: Record<string, number | string>) => boolean }
const HYPOTHESES: Hypothesis[] = [
  { name: 'production BUY signal (raw+MTF)', test: (f) => f.prodBuy === 1 },
  { name: 'raw BUY signal (no MTF gate)', test: (f) => f.rawBuy === 1 },
  { name: 'rsi14 < 30 (oversold)', test: (f) => (f.rsi14 as number) < 30 },
  { name: 'rsi14 > 70 (overbought)', test: (f) => (f.rsi14 as number) > 70 },
  { name: 'volRatio > 3 (volume spike)', test: (f) => (f.volRatio as number) > 3 },
  { name: 'breakout: close > 20-bar high', test: (f) => (f.breakout20Pct as number) > 0 },
  { name: 'ema fast > slow (uptrend)', test: (f) => (f.emaSpreadPct as number) > 0 },
  { name: 'ema fast < slow (downtrend)', test: (f) => (f.emaSpreadPct as number) < 0 },
  { name: 'price < ema50 (below trend)', test: (f) => (f.emaTrendPct as number) < 0 },
  { name: 'MTF 15m+1h bull aligned', test: (f) => f.mtf15 === 'bull' && f.mtf1h === 'bull' },
  { name: 'MTF 15m+1h bear aligned', test: (f) => f.mtf15 === 'bear' && f.mtf1h === 'bear' },
  { name: '24h return < -5% (dip)', test: (f) => (f.ret24hPct as number) < -5 },
  { name: '24h return > +5% (momentum)', test: (f) => (f.ret24hPct as number) > 5 },
];

const NUMERIC_FEATURES = ['rsi14', 'emaSpreadPct', 'emaTrendPct', 'volRatio', 'atrPct', 'macdHist', 'distResistancePct', 'ret24hPct', 'breakout20Pct'];
const fmt = (v: number, w = 8): string => v.toFixed(3).padStart(w);

async function main(): Promise<void> {
  const active = await get<{ params: unknown }[]>('strategy_configs?select=params&is_active=eq.true&limit=1');
  const P = mergeParams(active[0]?.params ?? null);
  const pairs = await resolveResearchPairs(get, {
    top: Number(process.argv[3] ?? process.env.ALPHA_TOP ?? 0),
    explicit: process.env.ALPHA_PAIRS?.split(','),
  });
  const ids = pairs.map((p) => p.id).slice(0, MAX_PAIRS);
  console.log(`[alpha-research] pairs=${ids.length} horizons(bars)=${HORIZONS.join(',')} feeRoundTrip=${FEE_ROUND_TRIP_PCT}% mtfMode=${P.mtfMode}`);

  const all: AlphaSample[] = [];
  for (const id of ids) {
    try {
      for (const seg of contiguousSegments(await fetchCandles(id))) {
        if (seg.length < P.minCandles + MAX_HORIZON + 5) continue;
        all.push(...buildSamples(id, seg, P));
      }
    } catch (e) {
      console.warn(`[alpha-research] skip ${id}: ${(e as Error).message}`);
    }
  }
  const train = all.filter((s) => !s.isHoldout);
  const holdout = all.filter((s) => s.isHoldout);
  console.log(`[alpha-research] samples=${all.length} train=${train.length} holdout=${holdout.length}`);
  if (!all.length) { console.log('no samples'); return; }

  const H = HORIZONS.length;
  console.log('\nUnconditional mean forward return (%) by horizon [all | train | holdout]:');
  console.log('  horizon(bars)  ' + HORIZONS.map((h) => String(h).padStart(9)).join(''));
  console.log('  all            ' + meanForwardVector(all, H).map((v) => fmt(v, 9)).join(''));
  console.log('  train          ' + meanForwardVector(train, H).map((v) => fmt(v, 9)).join(''));
  console.log('  holdout        ' + meanForwardVector(holdout, H).map((v) => fmt(v, 9)).join(''));

  console.log(`\nHypotheses — mean forward return (%) per horizon; verdict uses ${HORIZONS[VERDICT_HORIZON]} bars net of ${FEE_ROUND_TRIP_PCT}% cost:`);
  console.log('  ' + 'rule'.padEnd(32) + HORIZONS.map((h) => String(h).padStart(9)).join('') + '   nTr   nHo   verdict');
  for (const hyp of HYPOTHESES) {
    const r = evaluateHypothesis(all, hyp.test, VERDICT_HORIZON, H, { feeRoundTripPct: FEE_ROUND_TRIP_PCT, minHoldout: 30 });
    console.log(
      `  ${hyp.name.padEnd(32)}` +
      r.trainMean.map((v) => fmt(v, 9)).join('') +
      `  ${String(r.trainCount).padStart(5)} ${String(r.holdoutCount).padStart(5)}   ${r.verdict}` +
      `  (net@${HORIZONS[VERDICT_HORIZON]}: train ${r.netTrainPct >= 0 ? '+' : ''}${r.netTrainPct.toFixed(3)} / holdout ${r.netHoldoutPct >= 0 ? '+' : ''}${r.netHoldoutPct.toFixed(3)}%)`,
    );
  }

  console.log(`\nNumeric feature quintiles (all samples, ${HORIZONS[VERDICT_HORIZON]}-bar forward return %):`);
  for (const key of NUMERIC_FEATURES) {
    const values = all.map((s) => s.features[key] as number);
    const cuts = quantileCuts(values, 5);
    const buckets: AlphaSample[][] = [[], [], [], [], []];
    for (const s of all) {
      const v = s.features[key] as number;
      const b = cuts.length === 0 ? 0 : v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : v <= cuts[3] ? 3 : 4;
      buckets[b].push(s);
    }
    const means = buckets.map((b) => meanForwardVector(b, H)[VERDICT_HORIZON]);
    console.log(`  ${key.padEnd(18)} Q1..Q5: ` + means.map((v) => fmt(v, 8)).join('') + `  spread Q5-Q1 ${(means[4] - means[0]).toFixed(3)} pp`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
