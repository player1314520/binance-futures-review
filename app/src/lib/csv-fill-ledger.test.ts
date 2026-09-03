import { describe, expect, it } from 'vitest';
import * as engine from '@rv/engine';
import {
  CsvFillLedgerError,
  createCsvFillLedger,
  mergeCsvFillBatch,
  MAX_LEDGER_CANONICAL_BYTES,
  normalizeCsvFillLedger,
  readCsvFillLedgerExtension,
  replayCsvFillLedger,
  serializeCsvFillLedger,
  verifyCsvFillLedgerIntegrity,
  withCsvFillLedger,
  type CsvFillInput,
  type CsvImportEvidence,
} from './csv-fill-ledger';
import { MAX_FUPAN_FILE_BYTES } from './import-file-limits';

const evidence = (overrides: Partial<CsvImportEvidence> = {}): CsvImportEvidence => ({
  fills: true,
  orders: false,
  pnlReported: true,
  fees: true,
  income: false,
  ledger: false,
  klines: false,
  timePrecision: 'ms',
  dropped: 0,
  ...overrides,
});

// This is the only fixture allowed to use exchange Trade IDs as a cross-batch
// same-millisecond clock. A source label, Fee/PnL columns, or numeric ID alone
// must never be enough.
const binanceUsdmEvidence = (): CsvImportEvidence => evidence({
  source: 'binance-export',
  adapterId: 'builtin/binance-usdm-futures-csv/1',
  executionOrderEvidence: {
    version: 'rv-binance-usdm-csv-execution-order/1',
    adapterId: 'builtin/binance-usdm-futures-csv/1',
    headerSchema: 'date(utc)|symbol|side|price|quantity|fee|realized profit|trade id',
  },
});

const fill = (overrides: Partial<CsvFillInput> = {}): CsvFillInput => ({
  providerTradeId: 'trade-1',
  orderId: 'order-1',
  time: 1_700_000_000_000,
  symbol: 'BTCUSDT',
  side: 'BUY',
  positionSide: 'BOTH',
  price: 100,
  qty: 1,
  fee: 1,
  feeAsset: 'USDT',
  pnl: 0,
  ...overrides,
});

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code });
  await expect(promise).rejects.not.toThrow(/BTCUSDT|trade-1|order-1/);
};

describe('CSV fill ledger', () => {
  it('derives a deterministic PII-free scope and IDs for a fresh browser batch', async () => {
    const batch = { fills: [fill(), fill({ providerTradeId: 'trade-2', time: 1_700_000_060_000 })], evidence: evidence() };
    const first = await createCsvFillLedger(null, batch);
    const repeated = await createCsvFillLedger(null, batch);
    const different = await createCsvFillLedger(null, {
      ...batch,
      fills: [fill(), fill({ providerTradeId: 'trade-2', time: 1_700_000_120_000 })],
    });

    expect(first.ledger.accountScope).toMatch(/^csv-content:[0-9a-f]{64}$/);
    expect(first.ledger.accountScope).not.toMatch(/BTCUSDT|trade-1|order-1/);
    expect(repeated.ledger.scopeDigest).toBe(first.ledger.scopeDigest);
    expect(repeated.ledger.fills.map((row) => row.sourceRef))
      .toEqual(first.ledger.fills.map((row) => row.sourceRef));
    expect(repeated.trades.map((trade) => trade.id)).toEqual(first.trades.map((trade) => trade.id));
    expect(different.ledger.scopeDigest).not.toBe(first.ledger.scopeDigest);
  });

  it('replays all fills globally so an open in batch A closes as LONG in batch B', async () => {
    const first = await createCsvFillLedger('account-a', {
      fills: [fill()], evidence: evidence(),
    });
    const merged = await mergeCsvFillBatch(first.ledger, {
      fills: [fill({ providerTradeId: 'trade-2', orderId: 'order-2', time: 1_700_000_060_000, side: 'SELL', price: 110, pnl: 10 })],
      evidence: evidence(),
    });

    expect(merged.addedFills).toBe(1);
    expect(merged.openPositions).toBe(0);
    expect(merged.trades).toHaveLength(1);
    expect(merged.trades[0]).toMatchObject({ side: 'LONG', pnl: 8 });
  });

  it('accepts an open-only batch and exposes aggregated gates through meta and contract', async () => {
    const result = await createCsvFillLedger('account-a', {
      fills: [fill()],
      contract: {
        version: 'rv-result/1',
        canonical: { version: 'rv-canonical-trade/1', recordType: 'trade', count: 0 },
        provenance: {
          version: 'rv-provenance/1', source: 'binance-export', adapterId: 'builtin/csv-sniffer',
          fieldOrigins: {} as never,
          coverage: { status: 'complete', accepted: 1, dropped: 0 },
        },
        capabilities: {
          version: 'rv-capabilities/1', sources: ['binance-export'],
          values: evidence({ dropped: 0 }), unavailable: ['orders', 'income', 'ledger', 'klines'],
        },
        diagnostics: {
          version: 'rv-diagnostics/1', count: 0, countsByCode: {}, items: [],
        },
      },
      meta: { source: 'binance-export', dropped: 0 },
    });
    expect(result.trades).toEqual([]);
    expect(result.openPositions).toBe(1);
    expect(result.meta).toMatchObject({ fills: 1, openPositions: 1, dropped: 0 });
    expect(result.contract).toMatchObject({
      provenance: { coverage: { status: 'complete', accepted: 0, dropped: 0 } },
      capabilities: { values: { fills: true, orders: false } },
      diagnostics: { count: 0 },
    });
  });

  it('uses provider trade ID as the only cross-batch fill identity and never orderId', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: 'trade-1', orderId: 'shared-order', qty: 0.4 }),
        fill({ providerTradeId: 'trade-2', orderId: 'shared-order', qty: 0.6 }),
      ],
      evidence: evidence(),
    });
    expect(initial.ledger.fills).toHaveLength(2);

    const duplicate = await mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: 'trade-1', orderId: 'shared-order', qty: 0.4 })],
      evidence: evidence({ fees: false }),
    });
    expect(duplicate.addedFills).toBe(0);
    expect(duplicate.ledger.fills).toHaveLength(2);
    expect(duplicate.ledger.evidence.fees).toBe(false);
  });

  it('persists only new rows for overlapping ID batches and adds no batch for a duplicate subset', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: 'trade-1', time: 1000 }),
        fill({ providerTradeId: 'trade-2', time: 2000 }),
      ],
      evidence: evidence(),
    });
    const mixed = await mergeCsvFillBatch(initial.ledger, {
      fills: [
        fill({ providerTradeId: 'trade-1', time: 1000 }),
        fill({ providerTradeId: 'trade-3', time: 3000 }),
      ],
      evidence: evidence(),
    });
    expect(mixed.addedFills).toBe(1);
    expect(mixed.ledger.batches).toHaveLength(2);
    expect(mixed.ledger.batches[1]).toMatchObject({ rowCount: 2 });
    expect(mixed.ledger.batches[1].rows).toHaveLength(1);
    expect(mixed.ledger.batches[1].rowPlan).toEqual([
      initial.ledger.fills.find((item) => item.providerTradeId === 'trade-1')!.sourceRef,
      0,
    ]);
    expect(await verifyCsvFillLedgerIntegrity(mixed.ledger, 'account-a')).toEqual(mixed.ledger);

    const beforeBatchCount = mixed.ledger.batches.length;
    const subset = await mergeCsvFillBatch(mixed.ledger, {
      fills: [fill({ providerTradeId: 'trade-2', time: 2000 })],
      evidence: evidence({ fees: false }),
    });
    expect(subset.addedFills).toBe(0);
    expect(subset.ledger.batches).toHaveLength(beforeBatchCount);
    expect(subset.ledger.evidence.fees).toBe(false);
    expect(await verifyCsvFillLedgerIntegrity(subset.ledger, 'account-a')).toEqual(subset.ledger);
  });

  it('rejects the whole mixed batch when one provider ID conflicts', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill()], evidence: evidence(),
    });
    const original = serializeCsvFillLedger(initial.ledger);
    const candidate = {
      fills: [
        fill({ providerTradeId: 'trade-1', price: 999 }),
        fill({ providerTradeId: null, time: 1_700_000_120_000 }),
      ],
      evidence: evidence(),
    };
    await expectCode(mergeCsvFillBatch(initial.ledger, candidate), 'PROVIDER_TRADE_ID_CONFLICT');
    expect(serializeCsvFillLedger(initial.ledger)).toBe(original);
  });

  it('preserves repeated no-ID economic facts by row index and exact batch replay is idempotent', async () => {
    const rows = [
      fill({ providerTradeId: null, orderId: 'same-order' }),
      fill({ providerTradeId: null, orderId: 'same-order' }),
    ];
    const initial = await createCsvFillLedger('account-a', { fills: rows, evidence: evidence() });
    expect(initial.ledger.fills).toHaveLength(2);
    expect(new Set(initial.ledger.fills.map((item) => item.sourceRef)).size).toBe(2);

    const repeated = await mergeCsvFillBatch(initial.ledger, {
      fills: rows, evidence: evidence({ orders: false }),
    });
    expect(repeated.duplicateBatch).toBe(true);
    expect(repeated.addedFills).toBe(0);
    expect(repeated.ledger.fills).toHaveLength(2);
    expect(repeated.ledger.evidence.dropped).toBe(0);
  });

  it('never promotes a generic per-file id into a provider trade identity', async () => {
    const generic = fill({ providerTradeId: null, id: 1 });
    const initial = await createCsvFillLedger('account-a', {
      fills: [generic], evidence: evidence(),
    });
    expect(initial.ledger.fills[0].providerTradeId).toBeNull();
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: null, id: 2, time: generic.time, qty: 2 })],
      evidence: evidence(),
    }), 'AMBIGUOUS_EXECUTION_ORDER');
  });

  it('rejects different no-ID batches whose closed intervals overlap in the same position book', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: null, time: 1000 }),
        fill({ providerTradeId: null, time: 2000, side: 'SELL' }),
      ],
      evidence: evidence(),
    });
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: null, time: 1500, qty: 2 })],
      evidence: evidence(),
    }), 'AMBIGUOUS_NO_ID_OVERLAP');

    const appended = await mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: null, time: 2001, qty: 2 })],
      evidence: evidence(),
    });
    expect(appended.ledger.fills).toHaveLength(3);
  });

  it('also rejects overlap when only one of the two batches lacks IDs', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ time: 1000 })], evidence: evidence(),
    });
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: null, time: 1000 })], evidence: evidence(),
    }), 'AMBIGUOUS_EXECUTION_ORDER');
  });

  it('sorts the global ledger deterministically, including same-time rows', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: 'z', time: 3000, side: 'SELL', price: 110, pnl: 10 })],
      evidence: evidence(),
    });
    const merged = await mergeCsvFillBatch(initial.ledger, {
      fills: [
        fill({ providerTradeId: 'b', time: 1000, qty: 0.5 }),
        fill({ providerTradeId: 'a', time: 1000, qty: 0.5 }),
      ],
      evidence: evidence(),
    });
    expect(merged.trades).toHaveLength(1);
    expect(merged.trades[0].side).toBe('LONG');
    expect(replayCsvFillLedger(merged.ledger).trades).toEqual(merged.trades);
  });

  it('uses lossless decimal trade-ID order across batches and survives reverse import', async () => {
    const binanceEvidence = binanceUsdmEvidence();
    const base = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: '100', time: 1000, side: 'BUY', price: 100, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    const laterImportedFirst = await mergeCsvFillBatch(base.ledger, {
      fills: [fill({ providerTradeId: '102', time: 2000, side: 'BUY', price: 105, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    const reverse = await mergeCsvFillBatch(laterImportedFirst.ledger, {
      fills: [fill({ providerTradeId: '101', time: 2000, side: 'SELL', price: 110, qty: 2, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    expect(reverse.trades.map((trade) => [trade.side, trade.qty])).toEqual([
      ['LONG', 1],
      ['SHORT', 1],
    ]);

    const earlierImportedFirst = await mergeCsvFillBatch(base.ledger, {
      fills: [fill({ providerTradeId: '101', time: 2000, side: 'SELL', price: 110, qty: 2, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    const forward = await mergeCsvFillBatch(earlierImportedFirst.ledger, {
      fills: [fill({ providerTradeId: '102', time: 2000, side: 'BUY', price: 105, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    expect(forward.trades).toEqual(reverse.trades);
  });

  it('accepts the strict built-in Binance USD-M fixture through its result contract', async () => {
    const statement = (tradeId: string, time: string, side: 'BUY' | 'SELL', price: number, qty: number) => (
      [
        'Date(UTC),Symbol,Side,Price,Quantity,Fee,Realized Profit,Trade Id',
        `${time},BTCUSDT,${side},${price},${qty},0 USDT,0,${tradeId}`,
      ].join('\n')
    );
    const toBatch = (text: string) => {
      const parsed = engine.parseStatementBatch(text);
      if ('error' in parsed) throw new Error(parsed.error);
      return {
        fills: parsed.fills,
        contract: parsed.contract,
        meta: parsed.meta,
        diagnostics: parsed.diagnostics,
      };
    };
    const base = await createCsvFillLedger('account-a', toBatch(statement('100', '2026-07-01 00:00:00', 'BUY', 100, 1)));
    const later = await mergeCsvFillBatch(
      base.ledger,
      toBatch(statement('102', '2026-07-01 00:00:01', 'BUY', 105, 1)),
    );
    const merged = await mergeCsvFillBatch(
      later.ledger,
      toBatch(statement('101', '2026-07-01 00:00:01', 'SELL', 110, 2)),
    );
    expect(merged.trades.map((trade) => [trade.side, trade.qty])).toEqual([
      ['LONG', 1],
      ['SHORT', 1],
    ]);
  });

  it('preserves original row order for same-batch no-ID fills', async () => {
    const result = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: '100', time: 1000, side: 'BUY', fee: 0, pnl: null }),
        fill({ providerTradeId: null, time: 2000, side: 'SELL', price: 110, qty: 2, fee: 0, pnl: null }),
        fill({ providerTradeId: null, time: 2000, side: 'BUY', price: 105, fee: 0, pnl: null }),
      ],
      evidence: evidence(),
    });
    expect(result.trades.map((trade) => [trade.side, trade.qty])).toEqual([
      ['LONG', 1],
      ['SHORT', 1],
    ]);
  });

  it('rejects cross-batch same-millisecond execution without common decimal IDs', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: 'opaque-a', time: 2000 })], evidence: evidence(),
    });
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: 'opaque-b', time: 2000, side: 'SELL' })],
      evidence: evidence(),
    }), 'AMBIGUOUS_EXECUTION_ORDER');

    const other = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: 'opaque-b', time: 2000, side: 'SELL' })],
      evidence: evidence(),
    });
    const structurallyCombined = {
      ...initial.ledger,
      fills: [...initial.ledger.fills, ...other.ledger.fills],
      batches: [...initial.ledger.batches, ...other.ledger.batches],
    };
    await expectCode(
      verifyCsvFillLedgerIntegrity(structurallyCombined, 'account-a'),
      'AMBIGUOUS_EXECUTION_ORDER',
    );
  });

  it('does not trust numeric IDs from generic CSV sources across batches', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: '101', time: 2000 })], evidence: evidence({ source: 'generic-sniffed' }),
    });
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: '102', time: 2000, side: 'SELL' })],
      evidence: evidence({ source: 'generic-sniffed' }),
    }), 'AMBIGUOUS_EXECUTION_ORDER');
  });

  it('does not trust a generic Fee/PnL CSV merely relabelled as a Binance export', async () => {
    // A generic header can have Trade ID, Time, Fee and PnL. Until the strict
    // built-in USD-M adapter emits its marker, its decimal values remain opaque.
    const genericFeePnlEvidence = evidence({
      source: 'binance-export',
      adapterId: 'builtin/csv-sniffer',
    });
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: '101', time: 2000 })], evidence: genericFeePnlEvidence,
    });
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: '102', time: 2000, side: 'SELL' })],
      evidence: genericFeePnlEvidence,
    }), 'AMBIGUOUS_EXECUTION_ORDER');
  });

  it('preserves opaque leading zeros and rejects decimal-order collisions across Binance batches', async () => {
    const binanceEvidence = binanceUsdmEvidence();
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: '0002', time: 2000 })], evidence: binanceEvidence,
    });
    expect(initial.ledger.fills[0].providerTradeId).toBe('0002');
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: '2', time: 2000, side: 'SELL' })],
      evidence: binanceEvidence,
    }), 'AMBIGUOUS_EXECUTION_ORDER');

    const sameBatch = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: '0002', time: 2000, side: 'BUY' }),
        fill({ providerTradeId: '2', time: 2000, side: 'SELL' }),
      ],
      evidence: binanceEvidence,
    });
    expect(sameBatch.ledger.fills.map((item) => item.providerTradeId).sort()).toEqual(['0002', '2']);
  });

  it('preserves leading zeros and orders decimal IDs beyond Number.MAX_SAFE_INTEGER exactly', async () => {
    const binanceEvidence = binanceUsdmEvidence();
    const base = await createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: '1', time: 1000, side: 'BUY', fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    const first = await mergeCsvFillBatch(base.ledger, {
      fills: [fill({ providerTradeId: '000900719925474099312345', time: 2000, side: 'SELL', qty: 2, fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    const result = await mergeCsvFillBatch(first.ledger, {
      fills: [fill({ providerTradeId: '900719925474099312346', time: 2000, side: 'BUY', fee: 0, pnl: null })],
      evidence: binanceEvidence,
    });
    expect(result.ledger.fills.some((item) => item.providerTradeId === '000900719925474099312345')).toBe(true);
    expect(result.trades.map((trade) => trade.side)).toEqual(['LONG', 'SHORT']);
  });

  it('never upgrades aggregate evidence and retains no-added downgrade evidence', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill()], evidence: evidence({ timePrecision: 'ms' }),
    });
    const degraded = await mergeCsvFillBatch(initial.ledger, {
      fills: [fill()],
      evidence: evidence({ fees: false, pnlReported: false, timePrecision: 'day' }),
    });
    expect(degraded.addedFills).toBe(0);
    expect(degraded.ledger.evidence).toMatchObject({
      fees: false, pnlReported: false, timePrecision: 'mixed', dropped: 0,
    });
  });

  it('rejects incomplete batches atomically before they can downgrade or mutate the ledger', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill()], evidence: evidence(),
    });
    const before = serializeCsvFillLedger(initial.ledger);
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: 'trade-2', time: 2000 })],
      evidence: evidence({ dropped: 1 }),
    }), 'BATCH_INCOMPLETE');
    await expectCode(mergeCsvFillBatch(initial.ledger, {
      fills: [fill({ providerTradeId: 'trade-3', time: 3000 })],
      evidence: evidence({
        diagnostics: [{ index: 0, code: 'invalid_fill', field: 'row', severity: 'error' }],
      }),
    }), 'BATCH_INCOMPLETE');
    expect(serializeCsvFillLedger(initial.ledger)).toBe(before);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects dangerous diagnostic code %s before classification',
    async (code) => {
      await expectCode(createCsvFillLedger('account-a', {
        fills: [fill()],
        evidence: evidence({
          diagnostics: [{ index: 0, code, field: 'row', severity: 'warning' }] as never,
        }),
      }), 'INVALID_EVIDENCE');
    },
  );

  it('classifies diagnostics with an own-key map whose totals close to the item count', async () => {
    const result = await createCsvFillLedger('account-a', {
      fills: [fill()],
      evidence: evidence({
        diagnostics: [
          { index: 0, code: 'invalid_fill', field: 'row', severity: 'warning' },
          { index: 1, code: 'invalid_fill', field: 'row', severity: 'info' },
          { index: 2, code: 'empty_symbol', field: 'symbol', severity: 'warning' },
        ],
      }),
    });
    const report = result.contract.diagnostics;

    expect(report.countsByCode).toEqual({ empty_symbol: 1, invalid_fill: 2 });
    expect(Object.prototype.hasOwnProperty.call(report.countsByCode, 'invalid_fill')).toBe(true);
    expect(Object.values(report.countsByCode).reduce((sum, count) => sum + count, 0))
      .toBe(report.count);
    expect(report.count).toBe(report.items.length);
  });

  it('blocks historical replay when old canonical trades are not an identical subset', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [
        fill({ providerTradeId: 'open', time: 1000 }),
        fill({ providerTradeId: 'close', time: 2000, side: 'SELL', price: 110, pnl: 10 }),
      ],
      evidence: evidence(),
    });
    const historical = initial.trades.map((trade) => ({ ...trade, pnl: trade.pnl + 1 }));
    expect(() => replayCsvFillLedger(initial.ledger, { historicalTrades: historical }))
      .toThrow(expect.objectContaining({ code: 'HISTORICAL_REPLAY_CONFLICT' }));
    expect(replayCsvFillLedger(initial.ledger, { historicalTrades: initial.trades }).trades)
      .toEqual(initial.trades);
  });

  it('normalizes canonical serialized data, binds account scope, and round-trips an archive extension', async () => {
    const initial = await createCsvFillLedger('account-a', {
      fills: [fill()], evidence: evidence(),
    });
    const parsed = JSON.parse(serializeCsvFillLedger(initial.ledger));
    const normalized = normalizeCsvFillLedger(parsed, 'account-a');
    expect(normalized).toEqual(initial.ledger);
    expect(() => normalizeCsvFillLedger(parsed, 'account-b'))
      .toThrow(expect.objectContaining({ code: 'ACCOUNT_SCOPE_MISMATCH' }));

    const archive = withCsvFillLedger({ format: 'fupan/1', trades: [] }, initial.ledger);
    expect(readCsvFillLedgerExtension(archive, 'account-a')).toEqual(initial.ledger);
    expect(readCsvFillLedgerExtension({ format: 'fupan/1' }, 'account-a')).toBeNull();
    expect(await verifyCsvFillLedgerIntegrity(parsed, 'account-a')).toEqual(initial.ledger);

    const tampered = structuredClone(parsed);
    tampered.batches[0].rows[0].price = 123456;
    await expectCode(verifyCsvFillLedgerIntegrity(tampered, 'account-a'), 'LEDGER_INTEGRITY_FAILURE');
  });

  it('enforces an independent whole-ledger byte budget below the .fupan envelope limit', async () => {
    expect(MAX_LEDGER_CANONICAL_BYTES).toBe(MAX_FUPAN_FILE_BYTES - (2 * 1024 * 1024));
    const initial = await createCsvFillLedger('account-a', { fills: [fill()], evidence: evidence() });
    const parsed = JSON.parse(serializeCsvFillLedger(initial.ledger));
    const wideRow = {
      providerTradeId: 't'.repeat(128),
      orderId: 'o'.repeat(128),
      time: 1_700_000_000_000,
      symbol: 'BTCUSDT'.padEnd(32, 'X'),
      side: 'BUY',
      positionSide: 'BOTH',
      price: 1,
      qty: 1,
      fee: 0,
      feeAsset: 'USDT',
      pnl: 0,
    };
    const makeBatch = (suffix: string) => ({
      digest: suffix.repeat(64),
      hasUnidentifiedFills: false,
      rowCount: 10_000,
      rows: Array.from({ length: 10_000 }, () => ({ ...wideRow })),
      rowPlan: Array.from({ length: 10_000 }, (_, index) => index),
      intervals: [],
      evidence: parsed.batches[0].evidence,
    });
    const near = {
      ...parsed,
      batches: [makeBatch('a')],
      fills: [{ ...parsed.fills[0], batchDigest: 'a'.repeat(64), rowIndex: 0 }],
      evidence: parsed.evidence,
    };
    expect(() => normalizeCsvFillLedger(near, 'account-a')).not.toThrow();

    const over = {
      ...near,
      batches: [makeBatch('a'), makeBatch('b'), makeBatch('c')],
    };
    expect(() => normalizeCsvFillLedger(over, 'account-a'))
      .toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });

  it('rejects resource abuse and never includes submitted values in errors', async () => {
    const oversizedId = `private-${'x'.repeat(200)}`;
    await expect(createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: oversizedId })], evidence: evidence(),
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof CsvFillLedgerError
      && error.code === 'RESOURCE_LIMIT'
      && !error.message.includes(oversizedId)
    ));
    await expectCode(createCsvFillLedger('account-a', {
      fills: [fill({ providerTradeId: Number.MAX_SAFE_INTEGER + 1 })], evidence: evidence(),
    }), 'INVALID_FILL');
  });
});
