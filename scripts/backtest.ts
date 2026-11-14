// Offline 5m candle-only approximation (read-only; paper maths only, no trading; not production-parity).
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backtest.ts [pairId ...]
// Scope warnings are printed at runtime; historical bid/ask, MTF and shared portfolio controls are not simulated.
import { computeIndicators, DEFAULT_PARAMS, evaluateSignalWindow, mergeParams, type StrategyParams } from '../shared/strategy';
import { buyFillPrice, computeStats, computeStops, dynamicSlippageBps, feeFor, netRewardRiskGate, positionSize, sellFillPrice, trailingStop } from '../shared/paper';
import type { Candle } from '../shared/candles';
import { backtestScopeWarnings } from '../shared/backtestScope';

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const headers: Record<string, string> = { apikey: KEY, accept: 'application/json' };
if (!KEY.startsWith('sb_')) headers.authorization = `Bearer ${KEY}`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface Row { open_time: string; open: number; high: number; low: number; close: number; volume: number }

async function loadCandles(pair: string): Promise<Candle[]> {
  const rows = await get<Row[]>(`candles?select=open_time,open,high,low,close,volume&pair_id=eq.${pair}&timeframe=eq.5m&order=open_time.asc&limit=5000`);
  return rows.map((r) => ({ t: Math.floor(Date.parse(r.open_time) / 1000), o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume, n: 1, source: 'trades' as const }));
}

export interface SimTrade { pair: string; entry: number; exit: number; pnl: number; cost: number; reason: string }

export function simulate(pair: string, candles: Candle[], p: StrategyParams, equity0: number, volIdr: number | null): SimTrade[] {
  const rows = computeIndicators(candles, p);
  const trades: SimTrade[] = [];
  const slip = p.dynamicSlippage ? dynamicSlippageBps(p.slippageBps, volIdr) : p.slippageBps;
  let pos: { qty: number; entry: number; cost: number; sl: number; tp: number; openedIdx: number } | null = null;
  let equity = equity0;
  const win = Math.max(3, p.crossLookback + 1);
  for (let i = Math.max(p.minCandles, win); i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      // intrabar: stop first (conservative), then target
      let exit: number | null = null; let reason = '';
      if (c.l <= pos.sl) { exit = pos.sl; reason = 'STOP_LOSS'; }
      else if (c.h >= pos.tp) { exit = pos.tp; reason = 'TAKE_PROFIT'; }
      if (exit === null) {
        const nsl = trailingStop({ entry_price: pos.entry, stop_loss: pos.sl }, c.c, rows[i].atr14, p);
        if (nsl !== null) pos.sl = nsl;
        if (p.timeStopMinutes > 0 && (i - pos.openedIdx) * 5 >= p.timeStopMinutes) { exit = c.c; reason = 'TIME_STOP'; }
      }
      if (exit === null) {
        const sig = evaluateSignalWindow(rows.slice(i - win + 1, i + 1), candles.slice(i - win + 1, i + 1).map((x) => x.v), p);
        if (sig?.side === 'SELL') { exit = c.c; reason = 'SIGNAL'; }
      }
      if (exit !== null) {
        const fill = sellFillPrice(exit, slip);
        const fee = feeFor(pos.qty * fill, p.feePct);
        const pnl = pos.qty * fill - fee - pos.cost;
        equity += pnl;
        trades.push({ pair, entry: pos.entry, exit: fill, pnl, cost: pos.cost, reason });
        pos = null;
      }
      continue;
    }
    const sig = evaluateSignalWindow(rows.slice(i - win + 1, i + 1), candles.slice(i - win + 1, i + 1).map((x) => x.v), p);
    if (sig?.side !== 'BUY' || i + 1 >= candles.length) continue;
    const next = candles[i + 1]; // fill on the next candle open (no look-ahead)
    const fill = buyFillPrice(next.o, slip);
    const stops = computeStops(fill, rows[i].atr14, p);
    const economicsGate = netRewardRiskGate({
      entry: fill, stopLoss: stops.stopLoss, takeProfit: stops.takeProfit,
      feePct: p.feePct, exitSlippageBps: slip,
    });
    if (economicsGate) continue;
    const size = positionSize({
      equity, cash: equity, entry: fill, stopLoss: stops.stopLoss, exitSlippageBps: slip, params: p,
    });
    if (size.qty <= 0) continue;
    pos = { qty: size.qty, entry: fill, cost: size.cost, sl: stops.stopLoss, tp: stops.takeProfit, openedIdx: i + 1 };
    i += 1;
  }
  return trades;
}

function report(label: string, t: SimTrade[]) {
  const s = computeStats(t.map((x) => ({ realized_pnl: x.pnl, cost_basis: x.cost })));
  const avgW = t.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl / x.cost, 0) / Math.max(1, s.wins) * 100;
  const avgL = t.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl / x.cost, 0) / Math.max(1, s.losses) * 100;
  const be = avgW - avgL > 0 ? (-avgL / (avgW - avgL)) * 100 : NaN;
  console.log(`${label}: trades=${s.trades} win=${s.winRate.toFixed(1)}% PF=${s.profitFactor?.toFixed(2) ?? 'inf'} pnl=${s.totalPnl.toFixed(0)} avgRet=${s.avgReturnPct.toFixed(2)}% avgWin=${avgW.toFixed(2)}% avgLoss=${avgL.toFixed(2)}% breakevenWin=${be.toFixed(1)}%`);
}

async function main() {
  const cfg = await get<{ params: unknown }[]>('strategy_configs?select=params&is_active=eq.true&limit=1');
  const live = mergeParams(cfg[0]?.params);
  for (const warning of backtestScopeWarnings(live)) console.warn(`[BACKTEST SCOPE] ${warning}`);
  const pairs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : (await get<{ pair_id: string }[]>('market_tickers_latest?select=pair_id&order=vol_idr.desc&limit=25')).map((r) => r.pair_id);
  const vols = Object.fromEntries((await get<{ pair_id: string; vol_idr: number }[]>('market_tickers_latest?select=pair_id,vol_idr')).map((r) => [r.pair_id, +r.vol_idr]));
  // Compare older 5m rules with current settings; both remain candle-only per-pair approximations.
  const baseline: StrategyParams = { ...DEFAULT_PARAMS, ...live, crossLookback: 3, rsiBuyMax: 70, maxEntryExtensionPct: 0, sellRequireConfirm: true, trailingStopEnabled: false, timeStopMinutes: 0, dynamicSlippage: false };
  const all = { baseline: [] as SimTrade[], hardened: [] as SimTrade[] };
  for (const pair of pairs) {
    const candles = await loadCandles(pair);
    if (candles.length < live.minCandles + 20) continue;
    all.baseline.push(...simulate(pair, candles, baseline, 10_000_000, vols[pair] ?? null));
    all.hardened.push(...simulate(pair, candles, live, 10_000_000, vols[pair] ?? null));
  }
  report('baseline (older 5m rules)', all.baseline);
  report('hardened (5m approximation)', all.hardened);
  const reasons: Record<string, number> = {};
  for (const t of all.hardened) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1;
  console.log('hardened exits by reason:', reasons);
}

if (process.argv[1]?.endsWith('backtest.ts')) main().catch((e) => { console.error(e); process.exit(1); });
