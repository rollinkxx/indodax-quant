// Live, READ-ONLY check against the INDODAX public API: builds 1m candles from /api/trades and
// compares closes with the official /tradingview/history_v2 1m OHLC. Usage: npm run verify:indodax btcidr
import { IndodaxClient } from '../worker/src/indodax';
import { tradesToCandles } from '../shared/candles';

const pair = (process.argv[2] ?? 'btcidr').toLowerCase();
const dx = new IndodaxClient(fetch);

const summaries = await dx.getSummaries();
const t = summaries.find((s) => s.pair_id === pair);
if (!t) throw new Error(`pair ${pair} not found in /api/summaries (${summaries.length} tickers)`);
console.log(`summaries: ${summaries.length} tickers; ${pair} last=${t.last} bid=${t.bid} ask=${t.ask} vol_idr=${t.vol_idr}`);

const trades = await dx.getTrades(pair);
if (!trades.length) throw new Error('no trades returned');
const from = Math.ceil(trades[0].ts / 60) * 60;
const to = Math.floor(Date.now() / 1000 / 60) * 60; // exclude the running minute
const built = tradesToCandles(trades, 60, from, to);
const symbol = pair.toUpperCase();
const hist = await dx.getHistory(symbol, '1', from, to);
const map = new Map(hist.map((h) => [h.t, h]));
let compared = 0, matched = 0;
for (const c of built) {
  const h = map.get(c.t);
  if (!h) continue;
  compared++;
  if (Math.abs(h.c - c.c) / h.c <= 0.001) matched++;
}
console.log(`trades: ${trades.length}, built 1m candles: ${built.length}, official 1m candles: ${hist.length}`);
console.log(`close match (<=0.1%): ${matched}/${compared}`);
if (compared === 0) { console.log('nothing to compare (low liquidity window)'); process.exit(0); }
process.exit(matched / compared >= 0.9 ? 0 : 1);
