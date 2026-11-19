import { describe, expect, it, vi } from 'vitest';
import { resolveResearchPairs, type Getter } from '../scripts/pairUniverse';

describe('resolveResearchPairs', () => {
  it('returns explicit ids lower-cased and ordered', async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toContain('id=in.(btcidr,ethidr)');
      return [{ id: 'btcidr', symbol: 'BTCIDR' }];
    }) as unknown as Getter;
    const out = await resolveResearchPairs(get, { explicit: ['BTCIDR', ' ethidr '] });
    expect(out).toEqual([{ id: 'btcidr', symbol: 'BTCIDR' }]);
  });

  it('orders top-N pairs by descending 24h IDR volume', async () => {
    const all = [{ id: 'a', symbol: 'A' }, { id: 'b', symbol: 'B' }, { id: 'c', symbol: 'C' }];
    const get = vi.fn(async (path: string) => {
      if (path.startsWith('market_tickers_latest')) {
        return [{ pair_id: 'a', vol_idr: 300 }, { pair_id: 'b', vol_idr: 900 }, { pair_id: 'c', vol_idr: 100 }];
      }
      // Emulate PostgREST id=in.(...) filtering and an arbitrary return order.
      const ids = path.match(/id=in\.\(([^)]*)\)/)?.[1].split(',') ?? [];
      return all.filter((p) => ids.includes(p.id)).reverse();
    }) as unknown as Getter;
    const out = await resolveResearchPairs(get, { top: 2 });
    expect(out.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('falls back to tracked/in-universe when no selection is given', async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toContain('or=(is_tracked.eq.true,in_universe.eq.true)');
      return [{ id: 'btcidr', symbol: 'BTCIDR' }];
    }) as unknown as Getter;
    expect(await resolveResearchPairs(get, {})).toEqual([{ id: 'btcidr', symbol: 'BTCIDR' }]);
  });

  it('returns empty when a top-N request finds no tickers', async () => {
    const get = vi.fn(async () => []) as unknown as Getter;
    expect(await resolveResearchPairs(get, { top: 10 })).toEqual([]);
  });
});
