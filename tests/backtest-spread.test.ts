import { describe, expect, it } from 'vitest';
import { mergeParams } from '../shared/strategy';
import { fillGaps, type Candle } from '../shared/candles';
import { computeIndicators } from '../shared/strategy';
import { dynamicSlippageBps } from '../shared/paper';

const { simulate, buildSpreadLookup, QUOTE_MAX_AGE_SEC } = await import('../scripts/backtest');

describe('scripts/backtest import safety (WP1e)', () => {
  it('imports without Supabase env and without exiting the process', () => {
    // The module used to call process.exit(1) at module scope when env was missing, so importing
    // the pure simulation helpers from a test or another script killed the whole process.
    expect(typeof simulate).toBe('function');
    expect(typeof buildSpreadLookup).toBe('function');
  });
});

function oscillator(n: number, periodBars: number, amp: number): Candle[] {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({ length: n }, (_, i) => {
    const price = 1000 * (1 + Math.sin((2 * Math.PI * i) / periodBars) * amp) * (1 + (rnd() - 0.5) * 0.001);
    const o = price * (1 - 0.0004);
    return {
      t: i * 300, o, h: Math.max(o, price) * 1.004, l: Math.min(o, price) * 0.996,
      c: price, v: 1000 * (1.5 + Math.sin(i / 4)), n: 5, source: 'trades' as const,
    };
  });
}

const LOOSE = mergeParams({
  rsiBuyMin: 0, rsiBuyMax: 100, volumeMultiplier: 0, useTrendFilter: false,
  maxEntryExtensionPct: 0, mtfMode: 'off',
});

describe('buildSpreadLookup', () => {
  it('returns null when a pair has no recorded quotes', () => {
    expect(buildSpreadLookup([])).toBeNull();
  });

  it('carries the last known spread forward and never looks ahead', () => {
    const at = buildSpreadLookup([
      { open_time: '2026-01-01T00:05:00Z', spread_pct: '0.4' },
      { open_time: '2026-01-01T00:10:00Z', spread_pct: '0.9' },
    ])!;
    const t5 = Date.parse('2026-01-01T00:05:00Z') / 1000;
    expect(at(t5 - 1)).toBeNull();          // before the first observation
    expect(at(t5)).toBeCloseTo(0.4, 10);
    expect(at(t5 + 299)).toBeCloseTo(0.4, 10);
    expect(at(t5 + 300)).toBeCloseTo(0.9, 10);
  });

  it('ignores malformed rows instead of charging NaN', () => {
    const at = buildSpreadLookup([
      { open_time: 'not-a-date', spread_pct: '1' },
      { open_time: '2026-01-01T00:00:00Z', spread_pct: 'nope' },
      { open_time: '2026-01-01T00:05:00Z', spread_pct: '0.5' },
    ])!;
    expect(at(Date.parse('2026-01-01T00:05:00Z') / 1000)).toBeCloseTo(0.5, 10);
  });
});

describe('simulate spread pricing (WP1c)', () => {
  const candles = oscillator(3000, 60, 0.03);
  const base = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2);

  it('produces trades without a spread source (legacy pricing preserved)', () => {
    expect(base.length).toBeGreaterThan(0);
  });

  it('charges the quoted spread: a wider book makes every trade worse', () => {
    // 0.4% is inside the default maxEntrySpreadPct (0.6%), so entries still fire but pay the book.
    const wide = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, () => 0.4);
    expect(wide.length).toBeGreaterThan(0);
    const netBase = base.reduce((sum, t) => sum + t.pnl, 0);
    const netWide = wide.reduce((sum, t) => sum + t.pnl, 0);
    expect(netWide).toBeLessThan(netBase);
    // Entry is above the mid and exit below it, so each round trip pays the full quoted spread.
    expect(base[0].entry).toBeLessThan(wide[0].entry);
  });

  it('refuses entries the live engine would skip as wide_spread (entryGate parity)', () => {
    // Production runs entryGate against the live quote. Before WP1d the backtest skipped it entirely,
    // so it opened entries the live engine would have refused. A 2% book is far above the 0.6% cap.
    const wide = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, () => 2.0);
    expect(wide).toEqual([]);
    expect(simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, () => 0.4).length).toBeGreaterThan(0);
  });

  it('treats a missing bucket as zero spread rather than inventing one', () => {
    const none = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, () => null);
    const zero = simulate('xidr', candles, LOOSE, 10_000_000, 5e9, 'crossover', 0, 0.2, () => 0);
    expect(none.map((t) => t.pnl)).toEqual(zero.map((t) => t.pnl));
    expect(none.map((t) => t.pnl)).toEqual(base.map((t) => t.pnl));
  });
});

describe('buildSpreadLookup staleness bound', () => {
  const row = (tSec: number, s: number) => ({ open_time: new Date(tSec * 1000).toISOString(), spread_pct: String(s) });

  it('uses the most recent recorded bucket at or before the bar', () => {
    const at = buildSpreadLookup([row(0, 0.3), row(300, 0.5), row(900, 0.7)])!;
    expect(at(600)).toBe(0.5);
    expect(at(1000)).toBe(0.7);
  });

  it('does not charge a quote that predates the bar by more than the bound', () => {
    const at = buildSpreadLookup([row(0, 0.5)])!;
    expect(at(QUOTE_MAX_AGE_SEC)).toBe(0.5);
    expect(at(QUOTE_MAX_AGE_SEC + 300)).toBeNull();
  });

  it('returns null before the first recorded bucket', () => {
    expect(buildSpreadLookup([row(1000, 0.5)])!(500)).toBeNull();
  });
});

/** Momentum random walk: unlike the pure oscillator it also produces stop-outs, so exit paths are covered. */
function walk(n: number, seed: number, vol: number): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: Candle[] = [];
  let price = 1000;
  let mom = 0;
  for (let i = 0; i < n; i++) {
    mom = mom * 0.85 + (rnd() - 0.5) * vol;
    price = Math.max(1, price * (1 + mom + (rnd() - 0.5) * vol * 0.7));
    const o = price * (1 - 0.0002);
    out.push({ t: i * 300, o, h: Math.max(o, price) * 1.002, l: Math.min(o, price) * 0.998, c: price, v: 500 + rnd() * 900, n: 5, source: 'trades' });
  }
  return out;
}

describe('exit decisions are made in bid space (live parity)', () => {
  const candles = walk(3000, 11, 0.02);
  // Trailing off: the exit level is then purely the ATR bracket, so the arithmetic is checkable.
  const p = mergeParams({ ...LOOSE, trailingStopEnabled: false });
  const spread = 0.4;
  const slipBps = dynamicSlippageBps(p.slippageBps, 5e9);
  const trades = simulate('xidr', candles, p, 10_000_000, 5e9, 'crossover', 0, 0.2, () => spread);

  it('covers both bracket exits so the assertions below are not vacuous', () => {
    const reasons = new Set(trades.map((t) => t.reason));
    expect(reasons.has('STOP_LOSS')).toBe(true);
    expect(reasons.has('TAKE_PROFIT')).toBe(true);
  });

  it('fills the entry at the ask plus slippage, exactly as the live buyFillPrice(ask) does', () => {
    const first = trades[0];
    const nextBar = candles.find((c) => c.t === first.entryTime)!;
    const expectedAsk = nextBar.o * (1 + spread / 200);
    expect(first.entry).toBeCloseTo(expectedAsk * (1 + slipBps / 10_000), 6);
  });

  it('triggers on the bid and charges the spread exactly once, honouring gap-throughs', () => {
    // resolveProtectiveExit fills at the bar open when the bar gaps past the level, otherwise at the
    // level; sellFillPrice then takes slippage. Reconstruction must match exactly — a second spread
    // term would show up as a ~half-spread gap.
    const rows = computeIndicators(fillGaps(candles, 300), p);
    const half = spread / 200; // spread is in percent, so half-spread as a fraction is spread/200
    for (const t of trades) {
      if (t.reason !== 'STOP_LOSS' && t.reason !== 'TAKE_PROFIT') continue;
      const signalBar = rows.find((r) => r.t === t.entryTime - 300)!;
      const atr = Number(signalBar.atr14);
      const bar = candles.find((c) => c.t === t.exitTime)!;
      const bidOpen = bar.o * (1 - half);
      const bidHigh = bar.h * (1 - half);
      const bidLow = bar.l * (1 - half);
      const level = t.reason === 'STOP_LOSS'
        ? t.entry - atr * p.atrStopMultiplier
        : t.entry + atr * p.atrTakeProfitMultiplier;
      const triggered = t.reason === 'STOP_LOSS'
        ? (bidLow <= level ? (bidOpen < level ? bidOpen : level) : NaN)
        : (bidHigh >= level ? (bidOpen > level ? bidOpen : level) : NaN);
      expect(Number.isNaN(triggered)).toBe(false);
      expect(t.exit).toBeCloseTo(triggered * (1 - slipBps / 10_000), 6);
    }
  });
});
