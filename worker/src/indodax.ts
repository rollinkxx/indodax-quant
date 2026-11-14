// INDODAX OFFICIAL PUBLIC API client (read-only market data).
// Docs: https://github.com/btcid/indodax-official-api-docs (Public-RestAPI.md)
// This module deliberately has NO private/trade API support: no /tapi, no keys, no orders, no withdrawals.
import type { FetchLike } from './env';
import { fetchWithRetry } from './http';
import type { Candle, Trade } from '../../shared/candles';

export const INDODAX_BASE = 'https://indodax.com';
const ALLOWED_PREFIXES = ['/api/summaries', '/api/pairs', '/api/trades/', '/api/ticker/', '/api/server_time', '/tradingview/history_v2'];

export interface ParsedTicker {
  pair_id: string; // btcidr
  ticker_id: string; // btc_idr
  name: string | null;
  last: number;
  bid: number; // INDODAX "buy"
  ask: number; // INDODAX "sell"
  high: number | null;
  low: number | null;
  vol_traded: number | null;
  vol_idr: number | null;
  price_24h: number | null;
  change_24h_pct: number | null;
  server_time: number; // unix seconds
}

export interface PairInfo {
  id: string;
  symbol: string;
  ticker_id: string;
  base_currency: string;
  traded_currency: string;
  description: string | null;
  price_precision: number | null;
  trade_min_base_currency: number | null;
  trade_fee_percent_taker: number | null;
  is_maintenance: boolean;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export class IndodaxClient {
  constructor(private fetchImpl: FetchLike = fetch, private opts = { timeoutMs: 8000, retries: 2 }) {}

  async getJson<T>(path: string): Promise<T> {
    if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      throw new Error(`Blocked non-public INDODAX endpoint: ${path}`);
    }
    const res = await fetchWithRetry(this.fetchImpl, INDODAX_BASE + path, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'indodax-quant/1.0 (paper-trading monitor)' },
    }, { retries: this.opts.retries, timeoutMs: this.opts.timeoutMs });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`INDODAX returned non-JSON for ${path}`);
    }
  }

  async getSummaries(): Promise<ParsedTicker[]> {
    const raw = await this.getJson<{ tickers?: Record<string, Record<string, unknown>>; prices_24h?: Record<string, unknown> }>('/api/summaries');
    if (!raw || typeof raw.tickers !== 'object') throw new Error('Invalid /api/summaries payload');
    return parseSummaries(raw);
  }

  async getTrades(pairId: string): Promise<Trade[]> {
    if (!/^[a-z0-9]+$/.test(pairId)) throw new Error(`invalid pair id ${pairId}`);
    const raw = await this.getJson<unknown>(`/api/trades/${pairId}`);
    if (!Array.isArray(raw)) throw new Error(`Invalid /api/trades/${pairId} payload`);
    return parseTrades(raw);
  }

  async getTicker(pairId: string): Promise<{ last: number; bid: number; ask: number; server_time: number; vol_idr: number | null }> {
    if (!/^[a-z0-9]+$/.test(pairId)) throw new Error(`invalid pair id ${pairId}`);
    const raw = await this.getJson<{ ticker?: Record<string, unknown> }>(`/api/ticker/${pairId}`);
    const t = raw?.ticker;
    const last = num(t?.last), bid = num(t?.buy), ask = num(t?.sell), st = num(t?.server_time);
    if (!t || last === null || bid === null || ask === null || st === null || bid <= 0 || ask <= 0) {
      throw new Error(`Invalid ticker for ${pairId}`);
    }
    return { last, bid, ask, server_time: st, vol_idr: num(t.vol_idr) };
  }

  async getPairs(): Promise<PairInfo[]> {
    const raw = await this.getJson<unknown>('/api/pairs');
    if (!Array.isArray(raw)) throw new Error('Invalid /api/pairs payload');
    return raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as Record<string, unknown>).id === 'string')
      .map((p) => ({
        id: String(p.id),
        symbol: String(p.symbol ?? String(p.id).toUpperCase()),
        ticker_id: String(p.ticker_id ?? ''),
        base_currency: String(p.base_currency ?? ''),
        traded_currency: String(p.traded_currency ?? ''),
        description: p.description ? String(p.description) : null,
        price_precision: num(p.price_precision),
        trade_min_base_currency: num(p.trade_min_base_currency),
        trade_fee_percent_taker: num(p.trade_fee_percent_taker),
        is_maintenance: Number(p.is_maintenance ?? 0) === 1 || Number(p.is_market_suspended ?? 0) === 1,
      }))
      .filter((p) => p.ticker_id && p.base_currency === 'idr');
  }

  /** Official OHLC history (used only to backfill gaps / bootstrap). tf '1' = 1 minute. */
  async getHistory(symbol: string, tf: '1' | '15' | '60', fromSec: number, toSec: number): Promise<Candle[]> {
    if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error(`invalid symbol ${symbol}`);
    const raw = await this.getJson<unknown>(`/tradingview/history_v2?symbol=${symbol}&tf=${tf}&from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`);
    if (!Array.isArray(raw)) throw new Error(`Invalid history payload for ${symbol}`);
    return parseHistory(raw);
  }
}

export function tickerIdToPairId(tickerId: string): string {
  return tickerId.replace('_', '');
}

export function parseSummaries(raw: { tickers?: Record<string, Record<string, unknown>>; prices_24h?: Record<string, unknown> }): ParsedTicker[] {
  const out: ParsedTicker[] = [];
  for (const [tickerId, t] of Object.entries(raw.tickers ?? {})) {
    if (!t || typeof t !== 'object' || !/^[a-z0-9]+_[a-z0-9]+$/.test(tickerId)) continue;
    const pairId = tickerIdToPairId(tickerId);
    const last = num(t.last), bid = num(t.buy), ask = num(t.sell), st = num(t.server_time);
    if (last === null || bid === null || ask === null || st === null || last <= 0) continue;
    const tradedKey = Object.keys(t).find((k) => k.startsWith('vol_') && k !== 'vol_idr' && k !== 'vol_usdt');
    const p24 = num(raw.prices_24h?.[pairId]);
    out.push({
      pair_id: pairId,
      ticker_id: tickerId,
      name: typeof t.name === 'string' ? t.name : null,
      last, bid, ask,
      high: num(t.high),
      low: num(t.low),
      vol_traded: tradedKey ? num(t[tradedKey]) : null,
      vol_idr: num(t.vol_idr),
      price_24h: p24,
      change_24h_pct: p24 && p24 > 0 ? (last - p24) / p24 * 100 : null,
      server_time: st,
    });
  }
  return out;
}

export function parseTrades(raw: unknown[]): Trade[] {
  const out: Trade[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const tid = String(o.tid ?? '');
    const ts = num(o.date), price = num(o.price), amount = num(o.amount);
    const side = o.type === 'buy' || o.type === 'sell' ? o.type : null;
    if (!/^\d+$/.test(tid) || ts === null || price === null || amount === null || !side || price <= 0 || amount < 0) continue;
    out.push({ tid, ts, price, amount, side });
  }
  return out.sort((a, b) => a.ts - b.ts || (BigInt(a.tid) < BigInt(b.tid) ? -1 : 1));
}

export function parseHistory(raw: unknown[]): Candle[] {
  const out: Candle[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const t = num(o.Time), op = num(o.Open), h = num(o.High), l = num(o.Low), c = num(o.Close), v = num(o.Volume);
    if (t === null || op === null || h === null || l === null || c === null || v === null) continue;
    if (op <= 0 || c <= 0 || l <= 0 || h < l) continue;
    out.push({ t, o: op, h: Math.max(h, op, c), l: Math.min(l, op, c), c, v, n: 0, source: 'history' });
  }
  return out.sort((a, b) => a.t - b.t);
}
