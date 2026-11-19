// Shared pair-universe selection so the candle backfill and the alpha harness always look at
// the same markets. Deterministic: top-N by 24h IDR volume, else explicit ids, else the
// tracked / in-universe set the live pipeline uses.
export interface PairRow { id: string; symbol: string }
export type Getter = <T>(path: string) => Promise<T>;
interface TickerRow { pair_id: string; vol_idr: number | null }

export interface PairSelection {
  top?: number;
  explicit?: string[];
}

export async function resolveResearchPairs(get: Getter, sel: PairSelection): Promise<PairRow[]> {
  const explicit = sel.explicit?.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (explicit?.length) {
    return get<PairRow[]>(`market_pairs?select=id,symbol&id=in.(${explicit.join(',')})&order=id.asc`);
  }
  const top = sel.top ?? 0;
  if (Number.isInteger(top) && top > 0) {
    const tickers = await get<TickerRow[]>('market_tickers_latest?select=pair_id,vol_idr&vol_idr=not.is.null&order=vol_idr.desc');
    const ids = tickers
      .slice()
      .sort((a, b) => (b.vol_idr ?? -1) - (a.vol_idr ?? -1))
      .slice(0, top)
      .map((t) => t.pair_id);
    if (!ids.length) return [];
    const pairs = await get<PairRow[]>(`market_pairs?select=id,symbol&id=in.(${ids.join(',')})`);
    const rank = new Map(ids.map((id, i) => [id, i]));
    return pairs.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }
  return get<PairRow[]>('market_pairs?select=id,symbol&or=(is_tracked.eq.true,in_universe.eq.true)&order=id.asc');
}
