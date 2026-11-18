import { describe, expect, it } from 'vitest';
import { extractSchemaContract, parseExposedSchema, missingSchemaObjects } from '../shared/schemaContract';

describe('schema contract extraction', () => {
  it('finds RPCs and tables across select/update/rpc call sites, including generic type arguments', () => {
    const contract = extractSchemaContract([
      {
        path: 'pipeline.ts',
        text: [
          "await db.rpc<BeginRun>('begin_run', { p_scheduled });",
          "await db.rpc('run_retention');",
          "await db.rpc<SignalRow[]>('get_pending_sell_signals', { p_pairs });",
          "await db.select<Record<string, unknown>>('market_pairs', 'select=id');",
          "await db.update('paper_positions', `id=eq.${id}`, { stop_loss: 1 });",
        ].join('\n'),
      },
    ]);
    expect(contract.rpcs).toEqual(['begin_run', 'get_pending_sell_signals', 'run_retention']);
    expect(contract.tables).toEqual(['market_pairs', 'paper_positions']);
  });

  it('deduplicates repeated references across files', () => {
    const contract = extractSchemaContract([
      { path: 'a.ts', text: "db.rpc('begin_run')" },
      { path: 'b.ts', text: "db.rpc('begin_run')" },
    ]);
    expect(contract.rpcs).toEqual(['begin_run']);
  });
});

describe('PostgREST OpenAPI parsing', () => {
  it('separates RPC paths from table paths and ignores the root', () => {
    const exposed = parseExposedSchema({
      paths: {
        '/': {},
        '/rpc/begin_run': {},
        '/rpc/get_pending_sell_signals': {},
        '/market_pairs': {},
        '/trading_signals': {},
      },
    });
    expect([...exposed.rpcs].sort()).toEqual(['begin_run', 'get_pending_sell_signals']);
    expect([...exposed.tables].sort()).toEqual(['market_pairs', 'trading_signals']);
  });

  it('tolerates a missing paths object', () => {
    const exposed = parseExposedSchema({});
    expect(exposed.rpcs.size).toBe(0);
    expect(exposed.tables.size).toBe(0);
  });
});

describe('missing object detection', () => {
  it('reports a missing RPC that the Worker calls (the pending-SELL regression)', () => {
    const contract = { rpcs: ['begin_run', 'get_pending_sell_signals'], tables: ['paper_positions'] };
    const exposed = { rpcs: new Set(['begin_run']), tables: new Set(['paper_positions']) };
    expect(missingSchemaObjects(contract, exposed)).toEqual(['function: get_pending_sell_signals']);
  });

  it('reports missing tables and returns nothing when the contract is satisfied', () => {
    const contract = { rpcs: ['begin_run'], tables: ['paper_positions', 'trading_signals'] };
    expect(missingSchemaObjects(contract, { rpcs: new Set(['begin_run']), tables: new Set(['paper_positions']) }))
      .toEqual(['table: trading_signals']);
    expect(missingSchemaObjects(contract, { rpcs: new Set(['begin_run']), tables: new Set(['paper_positions', 'trading_signals']) }))
      .toEqual([]);
  });
});
