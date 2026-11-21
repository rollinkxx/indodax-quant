// Regression tests for the engine BUY/SELL/HOLD logic (FIX-02 .. FIX-10).
// Each block names the spec acceptance case it covers.
import { describe, expect, it } from 'vitest';
import { dynamicSlippageBps, exitReason, positionSize, shouldExitOnSignal } from '../shared/paper';
import { applyMtfToMarketAction, type TfState } from '../shared/mtf';
import { combineDecision } from '../shared/decisionPipeline';
import { computeIndicatorsTail, DEFAULT_PARAMS, diagnoseSellSignalWindow, evaluateMarketAction, evaluateSignalWindow, mergeParams, validateBracketEconomics, validateCrossFieldParams, type IndicatorRow, type MarketAction, type MarketActionDecision, type SignalDecision } from '../shared/strategy';
import { ema } from '../shared/indicators';
import type { Candle } from '../shared/candles';

describe('FIX-02 graded signal exit policy', () => {
  const policy = { requireProfit: true, forceStrength: 70, forceOnRiskBlock: true };
  const base = { coversCosts: false, strength: 0, riskBlocked: false, drawdownPct: 0, maxDrawdownPct: 15, policy };

  it('T6 exits a losing position on a strong SELL', () => {
    expect(shouldExitOnSignal({ ...base, strength: 80 })).toEqual({ exit: true, reason: 'strong_signal' });
  });

  it('T7 keeps withholding a weak SELL that cannot cover the round trip', () => {
    expect(shouldExitOnSignal({ ...base, strength: 55 })).toEqual({ exit: false, reason: 'below_cost' });
  });

  it('T8 exits on any SELL while entries are risk blocked', () => {
    expect(shouldExitOnSignal({ ...base, strength: 10, riskBlocked: true }))
      .toEqual({ exit: true, reason: 'risk_block' });
  });

  it('T9 exits once drawdown reaches half the limit', () => {
    expect(shouldExitOnSignal({ ...base, strength: 10, drawdownPct: 7.5 }))
      .toEqual({ exit: true, reason: 'drawdown_half' });
    expect(shouldExitOnSignal({ ...base, strength: 10, drawdownPct: 7.4 }).exit).toBe(false);
  });

  it('exits on a SELL that covers the round trip, and when the profit requirement is off', () => {
    expect(shouldExitOnSignal({ ...base, coversCosts: true, strength: 20 }))
      .toEqual({ exit: true, reason: 'covers_costs' });
    expect(shouldExitOnSignal({ ...base, strength: 20, policy: { ...policy, requireProfit: false } }))
      .toEqual({ exit: true, reason: 'policy_off' });
  });

  it('a non-finite strength never forces an exit', () => {
    expect(shouldExitOnSignal({ ...base, strength: Number.NaN }).exit).toBe(false);
  });
});

describe('FIX-03 MTF sell filter', () => {
  const tf = (name: '15m' | '1h', trend: TfState['trend']): TfState => ({
    tf: name, trend, candles: 60, lastOpenTime: 0, close: 100, emaFast: 100, emaSlow: 99, rsi: 50,
  });
  const sell = (strength: number): MarketActionDecision => ({
    action: 'SELL',
    signal: { side: 'SELL', strength, reasons: ['cross down'] } as SignalDecision,
    reason: 'sell_cross_confirmed',
  });
  const run = (strength: number, states: TfState[], opts = { filterSell: true, minSellStrength: 70 }) =>
    applyMtfToMarketAction(sell(strength), states, 'filter', opts);

  it('T10 blocks a weak SELL while 15m and 1h are both bullish', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bull')]);
    expect(out.action.action).toBe('HOLD');
    expect(out.action.reason).toBe('mtf_blocked_mtf_sell_against_uptrend');
  });

  // T11 originally expected raw strength 85 to pass, which only held because the filter compared the
  // strength before the timeframe adjustment. N4 judges the adjusted value: 85 - 30 = 55 is weak, so
  // the SELL that survives the same uptrend is the one that still clears the bar after the penalty.
  it('T11 lets a SELL through the same uptrend only if it still clears the bar after the penalty', () => {
    expect(run(100, [tf('15m', 'bull'), tf('1h', 'bull')]).action.action).toBe('SELL');
    expect(run(85, [tf('15m', 'bull'), tf('1h', 'bull')]).action).toMatchObject({
      action: 'HOLD', reason: 'mtf_blocked_mtf_sell_against_uptrend',
    });
  });

  it('T12 does not block a SELL when the 1h anchor is not bullish', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bear')]);
    expect(out.action.action).toBe('SELL');
  });

  it('T13 mtfFilterSell=false restores the unfiltered SELL', () => {
    const out = run(50, [tf('15m', 'bull'), tf('1h', 'bull')], { filterSell: false, minSellStrength: 70 });
    expect(out.action.action).toBe('SELL');
  });
});

describe('FIX-04 score mode warning', () => {
  it('warns when mtfMode=score has no strength threshold', () => {
    const findings = validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'score', minSignalStrength: 0 });
    expect(findings).toContainEqual(expect.objectContaining({ level: 'warn', code: 'SCORE_MODE_WITHOUT_THRESHOLD' }));
    expect(validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'score', minSignalStrength: 60 })
      .some((f) => f.code === 'SCORE_MODE_WITHOUT_THRESHOLD')).toBe(false);
    expect(validateCrossFieldParams({ ...DEFAULT_PARAMS, mtfMode: 'filter' })
      .some((f) => f.code === 'SCORE_MODE_WITHOUT_THRESHOLD')).toBe(false);
  });
});

describe('FIX-05 SELL cross lookback', () => {
  const row = (over: Partial<IndicatorRow> = {}): IndicatorRow => ({
    t: 0, close: 100, ema9: 101, ema21: 100, ema50: 95, rsi14: 45, macd: 0, macdSignal: 0, macdHist: -1,
    atr14: 1, volMa20: 10, support: 90, resistance: 110, ...over,
  });
  const above = row();
  const confirm = { ...DEFAULT_PARAMS, sellRequireConfirm: true };

  it('T16 signals SELL one candle after the cross when the filters pass there', () => {
    const crossWeak = row({ ema9: 99, rsi14: 55 });
    const lastStrong = row({ ema9: 98, rsi14: 45 });
    const rows = [above, crossWeak, lastStrong];
    const volumes = [10, 10, 20];

    expect(diagnoseSellSignalWindow(rows, volumes, confirm)).toMatchObject({
      stage: 'ready', ready: true, crossFound: true, barsSinceCross: 1, crossTime: above.t,
    });
    expect(evaluateSignalWindow(rows, volumes, confirm)?.side).toBe('SELL');
  });

  it('T17 ignores a cross older than sellCrossLookback', () => {
    const below = row({ ema9: 99, rsi14: 45 });
    const cross = row({ ema9: 99, rsi14: 45 });
    const rows = [above, cross, below, below, below, row({ ema9: 97, rsi14: 45 })];
    const volumes = [10, 10, 10, 10, 10, 20];
    const diag = diagnoseSellSignalWindow(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 2 });
    expect(diag.stage).toBe('no_recent_cross');
    expect(evaluateMarketAction(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 2 }).action).toBe('HOLD');
    // Widening the window finds it again.
    expect(diagnoseSellSignalWindow(rows, volumes, { ...DEFAULT_PARAMS, sellCrossLookback: 5 }).crossFound).toBe(true);
  });

  // T18 originally asserted the old suppression (stage 'already_qualified'). N3 removed it: the
  // lookback was dead whenever the confirming candle was the cross candle itself, so a run that
  // missed a candle lost the exit. Re-emission is now expected and deduped on crossTime instead.
  it('T18 re-emits the cross on the next candle, carrying the same crossTime', () => {
    const crossStrong = row({ ema9: 99, rsi14: 45 });
    const lastStrong = row({ ema9: 98, rsi14: 45 });
    const rows = [above, crossStrong, lastStrong];
    const volumes = [10, 20, 20];
    expect(diagnoseSellSignalWindow(rows, volumes, confirm)).toMatchObject({
      stage: 'ready', ready: true, crossTime: above.t,
    });
    expect(evaluateSignalWindow(rows, volumes, confirm)).toMatchObject({ side: 'SELL', crossTime: above.t });
  });
});

describe('FIX-06 bracket validation uses NET reward/risk', () => {
  it('T19 rejects a bracket that only clears the threshold before costs', () => {
    const errors = validateBracketEconomics(mergeParams({
      atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3, feePct: 0.5, slippageBps: 50,
    }));
    expect(errors.join()).toMatch(/net reward\/risk ATR 0\.\d+ .* < minNetRewardRiskRatio/);
    // The gross ratio (2.0) would have passed the old check.
    expect(errors.join()).not.toMatch(/atrTakeProfitMultiplier \/ atrStopMultiplier/);
  });

  it('T20 keeps the shipped defaults valid', () => {
    expect(validateBracketEconomics(DEFAULT_PARAMS)).toEqual([]);
  });
});

describe('FIX-07 shipped defaults do not warn about themselves', () => {
  it('T21 DEFAULT_PARAMS has no overlapping RSI regimes', () => {
    expect(validateCrossFieldParams(DEFAULT_PARAMS).some((f) => f.code === 'BUY_AND_SELL_RSI_REGIMES_OVERLAP')).toBe(false);
    expect(DEFAULT_PARAMS.rsiBuyMin).toBeGreaterThan(DEFAULT_PARAMS.rsiSellMax);
  });
});

describe('FIX-08 synthetic candles degrade rows instead of restarting indicators', () => {
  const candle = (t: number, close: number, source: Candle['source'] = 'trades'): Candle => ({
    t, o: close, h: close + 1, l: close - 1, c: close, v: source === 'synthetic' ? 0 : 10,
    n: source === 'synthetic' ? 0 : 1, source,
  });
  const series = (gapAt: number | null) => Array.from({ length: 250 }, (_, i) =>
    candle(i * 300, 1000 + Math.sin(i / 7) * 20 + i * 0.1, i === gapAt ? 'synthetic' : 'trades'));

  it('T22 matches a full-series EMA when there is no gap', () => {
    const rows = computeIndicatorsTail(series(null), DEFAULT_PARAMS, 3);
    const closes = series(null).map((c) => c.c);
    const expected = ema(closes, DEFAULT_PARAMS.emaTrend);
    expect(rows).toHaveLength(3);
    expect(rows[2].ema50).toBeCloseTo(expected[249] as number, 9);
  });

  it('T23 treats a row as not warm when a synthetic candle is inside its warm-up', () => {
    const rows = computeIndicatorsTail(series(245), DEFAULT_PARAMS, 3);
    expect(rows[2].degraded).toBe(true);
    const volumes = series(245).slice(-rows.length).map((c) => c.v);
    // N6 names the gap: the same HOLD used to read indicators_not_ready, indistinguishable from a
    // cold series.
    expect(evaluateMarketAction(rows, volumes)).toMatchObject({ action: 'HOLD', reason: 'indicators_degraded_by_gap' });
    expect(evaluateSignalWindow(rows, volumes)).toBeNull();
  });

  it('T24 keeps a row usable when the synthetic candle is outside its warm-up', () => {
    const rows = computeIndicatorsTail(series(190), DEFAULT_PARAMS, 3);
    expect(rows[2].degraded).toBe(false);
  });

  it('returns an unready, degraded row when the latest candle is synthetic', () => {
    const rows = computeIndicatorsTail(series(249), DEFAULT_PARAMS, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ degraded: true, ema9: null, rsi14: null });
  });
});

describe('FIX-09/N5 a gap over both brackets is booked at the target, not at the bid', () => {
  const pos = { entry_price: 100, stop_loss: 95, take_profit: 110 };

  // T25 originally booked STOP_LOSS on this gap while the pipeline still filled at the (higher) bid,
  // so the label and the price disagreed. N5 labels the target and clamps the fill to it.
  it('T25 books TAKE_PROFIT on a gap over both brackets', () => {
    expect(exitReason(pos, 111, 94)).toBe('TAKE_PROFIT');
    expect(exitReason({ ...pos, stop_loss: 101 }, 111, 100)).toBe('TAKE_PROFIT');
  });

  it('T26 keeps the ordering when there is no previous bid', () => {
    expect(exitReason(pos, 111)).toBe('TAKE_PROFIT');
    expect(exitReason(pos, 111, null)).toBe('TAKE_PROFIT');
    // A previous bid above the stop means the stop was never crossed: the target wins.
    expect(exitReason(pos, 111, 96)).toBe('TAKE_PROFIT');
  });
});

describe('FIX-10 position sizing charges the exit fee on the stop notional', () => {
  it('T27 per-unit risk = stop distance + entry fee + exit fee at the stop + exit slippage', () => {
    // 50 + 1000*0.003 + 950*0.003 + 950*0.002 = 57.75. The old formula charged the exit fee on the
    // entry notional (1000) and would have produced 57.70 for the same trade.
    const sized = positionSize({
      equity: 10_000_000, cash: 10_000_000, entry: 1000, stopLoss: 950,
      params: { ...DEFAULT_PARAMS, feePct: 0.3, riskPerTradePct: 1, maxPositionPct: 100 },
      exitSlippageBps: 20,
    });
    expect(sized.riskAmount).toBeCloseTo(100_000, 6);
    expect(sized.qty * 57.75).toBeCloseTo(100_000, 0);
  });
});

describe('FIX-11 exit-side slippage cap', () => {
  it('caps an unknown-volume penalty at the requested multiplier', () => {
    expect(dynamicSlippageBps(10, null)).toBe(40);
    expect(dynamicSlippageBps(10, null, { maxMultiplier: 2 })).toBe(20);
    // A known thin volume is capped the same way; a deep pair is unaffected.
    expect(dynamicSlippageBps(10, 1e8, { maxMultiplier: 2 })).toBe(20);
    expect(dynamicSlippageBps(10, 1e8)).toBe(40);
    expect(dynamicSlippageBps(10, 5e10, { maxMultiplier: 2 })).toBe(10);
  });
});

describe('property tests (T29-T31)', () => {
  // Deterministic PRNG so a failure is reproducible.
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const randomSeries = (r: () => number): { rows: IndicatorRow[]; volumes: number[] } => {
    const n = 1 + Math.floor(r() * 60);
    const pick = () => {
      const k = r();
      if (k < 0.05) return Number.NaN;
      if (k < 0.1) return null;
      if (k < 0.15) return -1;
      return r() * 200;
    };
    const rows: IndicatorRow[] = Array.from({ length: n }, (_, i) => ({
      t: i * 300, close: r() < 0.1 ? pick() as number : 50 + r() * 100,
      ema9: pick(), ema21: pick(), ema50: pick(), rsi14: r() < 0.2 ? r() * 100 : pick(),
      macd: pick(), macdSignal: pick(), macdHist: pick(), atr14: pick(), volMa20: pick(),
      support: pick(), resistance: pick(),
    }));
    return { rows, volumes: Array.from({ length: n }, () => (r() < 0.1 ? Number.NaN : r() * 100)) };
  };

  it('T29 evaluateMarketAction only ever returns BUY/SELL/HOLD and never throws', () => {
    const r = rng(20261120);
    for (let i = 0; i < 1000; i++) {
      const { rows, volumes } = randomSeries(r);
      const out = evaluateMarketAction(rows, volumes);
      expect(['BUY', 'SELL', 'HOLD']).toContain(out.action);
      if (out.action === 'HOLD') expect(out.signal).toBeNull();
      else expect(out.signal).not.toBeNull();
    }
  });

  it('T30 combineDecision never returns BUY when economics failed or entries are blocked', () => {
    const r = rng(7);
    const actions: MarketAction[] = ['BUY', 'SELL', 'HOLD'];
    for (let i = 0; i < 1000; i++) {
      const rawAction = actions[Math.floor(r() * 3)];
      const econFailed = r() < 0.5;
      const riskBlocked = r() < 0.5;
      const quoteOk = r() < 0.9;
      const d = combineDecision({
        raw: {
          action: rawAction,
          reason: 'x',
          signal: rawAction === 'HOLD' ? null : { side: rawAction, strength: Math.floor(r() * 100), reasons: [] },
        },
        economics: { reason: econFailed ? 'net_reward_risk_below_minimum' : null },
        risk: { blockEntries: riskBlocked, reasons: riskBlocked ? ['kill_switch'] : [] },
        quote: { ok: quoteOk, ageSec: 1, spreadBps: 10 },
      });
      expect(['BUY', 'SELL', 'HOLD']).toContain(d.final_action);
      // A failed quote already forces HOLD; otherwise the BUY vetoes must hold on their own.
      if (econFailed || riskBlocked) expect(d.final_action).not.toBe('BUY');
    }
  });

  it('T31 evaluateMarketAction is a pure function of its inputs', () => {
    const r = rng(99);
    for (let i = 0; i < 100; i++) {
      const { rows, volumes } = randomSeries(r);
      expect(evaluateMarketAction(rows, volumes)).toEqual(evaluateMarketAction(rows, volumes));
    }
  });
});
