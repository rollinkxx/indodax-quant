import { describe, expect, it } from 'vitest';
import { combineDecision, emptyDecisionCounters, tallyDecision } from '../shared/decisionPipeline';
import type { MarketActionDecision } from '../shared/strategy';

const raw = (action: MarketActionDecision['action'], reason = 'x', signal: MarketActionDecision['signal'] = null): MarketActionDecision => ({ action, reason, signal });

describe('structured decision', () => {
  it('passes a BUY only when every gate is clear', () => {
    const d = combineDecision({
      raw: raw('BUY', 'buy_setup_confirmed', { side: 'BUY', strength: 80, reasons: [] }),
      economics: { reason: null, netRewardRiskRatio: 1.5 },
      risk: { blockEntries: false, reasons: [] },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
      feePct: 0.2,
      slippageBps: 10,
    });
    expect(d.final_action).toBe('BUY');
    expect(d.final_reason).toBe('buy_confirmed');
    expect(d.signal?.side).toBe('BUY');
    expect(d.spread_bps).toBe(20);
    expect(d.fee_rate).toBe(0.2);
    expect(d.expected_net_reward_risk).toBe(1.5);
  });

  it('blocks a BUY on a stale quote before any other gate', () => {
    const d = combineDecision({
      raw: raw('BUY', 'buy_setup_confirmed', { side: 'BUY', strength: 80, reasons: [] }),
      quote: { ok: false, ageSec: 900, spreadBps: null, reason: 'STALE_QUOTE' },
    });
    expect(d.final_action).toBe('HOLD');
    expect(d.final_reason).toBe('quote_STALE_QUOTE');
  });

  it('records the MTF block separately from the raw BUY', () => {
    const d = combineDecision({
      raw: raw('BUY', 'buy_setup_confirmed', { side: 'BUY', strength: 80, reasons: [] }),
      mtf: {
        action: { action: 'HOLD', signal: null, reason: 'mtf_blocked_mtf_against_trend' },
        mtf: { decision: null, blocked: 'mtf_against_trend', summary: {} as never },
      },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
    });
    expect(d.raw_action).toBe('BUY');
    expect(d.mtf_action).toBe('HOLD');
    expect(d.mtf_reason).toBe('mtf_blocked_mtf_against_trend');
    expect(d.final_action).toBe('HOLD');
  });

  it('blocks a BUY on economics with its own reason', () => {
    const d = combineDecision({
      raw: raw('BUY', 'buy_setup_confirmed', { side: 'BUY', strength: 80, reasons: [] }),
      economics: { reason: 'net_reward_risk_below_minimum', netRewardRiskRatio: 0.4 },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
    });
    expect(d.economics_action).toBe('HOLD');
    expect(d.economics_reason).toBe('net_reward_risk_below_minimum');
    expect(d.final_reason).toBe('economics_net_reward_risk_below_minimum');
  });

  it('blocks a BUY on risk', () => {
    const d = combineDecision({
      raw: raw('BUY', 'buy_setup_confirmed', { side: 'BUY', strength: 80, reasons: [] }),
      economics: { reason: null, netRewardRiskRatio: 1.5 },
      risk: { blockEntries: true, reasons: ['daily loss 3.2% >= 3%'] },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
    });
    expect(d.risk_action).toBe('HOLD');
    expect(d.final_reason).toContain('risk_');
  });

  it('never blocks a SELL exit on economics or risk', () => {
    const d = combineDecision({
      raw: raw('SELL', 'sell_cross_confirmed', { side: 'SELL', strength: 60, reasons: [] }),
      economics: { reason: 'net_reward_risk_below_minimum' },
      risk: { blockEntries: true, reasons: ['drawdown'] },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
    });
    expect(d.final_action).toBe('SELL');
  });

  it('keeps HOLD for no setup with a structured reason', () => {
    const d = combineDecision({ raw: raw('HOLD', 'no_fresh_setup'), quote: { ok: true, ageSec: 3, spreadBps: 20 } });
    expect(d.final_action).toBe('HOLD');
    expect(d.final_reason).toBe('no_fresh_setup');
  });
});

describe('decision counters', () => {
  it('separates raw from final counts and tallies block reasons', () => {
    const c = emptyDecisionCounters();
    tallyDecision(c, combineDecision({ raw: raw('BUY', 'buy', { side: 'BUY', strength: 80, reasons: [] }), quote: { ok: true, ageSec: 3, spreadBps: 20 } }));
    tallyDecision(c, combineDecision({
      raw: raw('BUY', 'buy', { side: 'BUY', strength: 80, reasons: [] }),
      mtf: { action: { action: 'HOLD', signal: null, reason: 'mtf_blocked_mtf_against_trend' }, mtf: { decision: null, blocked: 'x', summary: {} as never } },
      quote: { ok: true, ageSec: 3, spreadBps: 20 },
    }));
    tallyDecision(c, combineDecision({ raw: raw('BUY', 'buy', { side: 'BUY', strength: 80, reasons: [] }), quote: { ok: false, ageSec: 900, spreadBps: null, reason: 'STALE_QUOTE' } }));
    tallyDecision(c, combineDecision({ raw: raw('SELL', 'sell', { side: 'SELL', strength: 60, reasons: [] }), quote: { ok: true, ageSec: 3, spreadBps: 20 } }));
    expect(c.raw_buy_count).toBe(3);
    expect(c.raw_sell_count).toBe(1);
    expect(c.final_buy_count).toBe(1);
    expect(c.final_sell_count).toBe(1);
    expect(c.mtf_block_count).toBe(1);
    expect(c.stale_data_block_count).toBe(1);
  });
});
