// A signal exit records which SELL signal caused it. Before this, all 16 SELL orders stored
// signal_id NULL (BUY: 16/16 filled) so exit-signal quality could not be measured at all.
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../worker/src/pipeline';
import { env } from './fakes';
import { NOW, setup } from './pipelineSetup';

const run = (o: ReturnType<typeof setup>) => runPipeline(env(), {
  scheduledTime: NOW * 1000, trigger: 'cron', fetchImpl: o.f, now: () => NOW * 1000,
});

const openPosition = (over: Record<string, unknown> = {}) => ({
  id: 5, pair_id: 'btcidr', qty: 1, entry_price: 1000, cost_basis: 1000,
  stop_loss: 500, take_profit: 2000, opened_at: new Date((NOW - 600) * 1000).toISOString(), ...over,
});

const closeCall = (o: ReturnType<typeof setup>) => o.rpcs.find((x) => x.fn === 'paper_close_position');

describe('signal_id on the SELL order', () => {
  it('records the SELL signal that triggered the exit', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [],
      pendingSells: [{ id: 999, pair_id: 'btcidr', side: 'SELL', strength: 80 }],
      tickerBid: 1000,
    });
    await run(o);

    const close = closeCall(o);
    expect(close).toBeTruthy();
    expect(close!.body.p_reason).toBe('SIGNAL');
    expect(close!.body.p_signal_id).toBe(999);
  });

  it('takes the signal id from the fresh signal when both sources know the pair', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [{
        id: 4242, pair_id: 'btcidr', side: 'SELL', price: 1000, strength: 80, reasons: ['test'],
        indicators: {}, candle_time: new Date((NOW - 300) * 1000).toISOString(),
      }],
      tickerBid: 1000,
    });
    await run(o);

    const close = closeCall(o);
    expect(close!.body.p_signal_id).toBe(4242);
  });

  it('leaves signal_id null for a stop loss', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [],
      tickerBid: 400,
    });
    await run(o);

    const close = closeCall(o);
    expect(close!.body.p_reason).toBe('STOP_LOSS');
    expect(close!.body.p_signal_id).toBeNull();
  });

  it('leaves signal_id null for a take profit', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [],
      tickerBid: 2100,
    });
    await run(o);

    const close = closeCall(o);
    expect(close!.body.p_reason).toBe('TAKE_PROFIT');
    expect(close!.body.p_signal_id).toBeNull();
  });
});

describe('deploy order independence', () => {
  it('still closes the position when the database has not taken the signal_id migration', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [],
      pendingSells: [{ id: 999, pair_id: 'btcidr', side: 'SELL', strength: 80 }],
      tickerBid: 400,
      closeRejectsSignalId: true,
    });
    const r = await run(o);

    const closes = o.rpcs.filter((x) => x.fn === 'paper_close_position');
    // First attempt carries the signal id and is rejected by the old signature; the retry drops it.
    expect(closes).toHaveLength(2);
    expect(closes[0].body.p_signal_id).toBeNull();
    expect(closes[1].body.p_signal_id).toBeUndefined();
    expect(closes[1].body.p_reason).toBe('STOP_LOSS');
    expect(r.status).toBe('SUCCESS');
  });

  it('does not retry a close that fails for another reason', async () => {
    const o = setup({
      mtfMode: 'off',
      openPositions: [openPosition()],
      newSignals: [],
      tickerBid: 400,
      closeResult: { ok: false, reason: 'duplicate' },
    });
    await run(o);
    expect(o.rpcs.filter((x) => x.fn === 'paper_close_position')).toHaveLength(1);
  });
});
