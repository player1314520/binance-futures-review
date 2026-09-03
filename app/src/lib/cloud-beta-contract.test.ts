import { describe, expect, it } from 'vitest';
import {
  CloudBetaContractError,
  normalizeCloudDatasetV1,
  normalizeCloudSyncV1,
} from './cloud-beta-contract';

const AS_OF = '2026-08-31T01:00:00.000Z';
const REVIEW_ID = '018f47a2-4bb0-7ee0-8000-111111111111';
const ACTION_ID = '018f47a2-4bb0-7ee0-8000-222222222222';
const JOURNAL_ID = '018f47a2-4bb0-7ee0-8000-333333333333';
const RULE_ID = '018f47a2-4bb0-7ee0-8000-444444444444';
const REPORT_ID = '018f47a2-4bb0-7ee0-8000-555555555555';
const TRADE_ID = 't_0123456789abcdef';

function coverage(state = 'VERIFIED') {
  return {
    state,
    attempted: AS_OF,
    fetched: '2026-08-31T00:59:00.000Z',
    committed: '2026-08-31T00:58:00.000Z',
    trusted: '2026-08-31T00:57:00.000Z',
    gaps: [],
  };
}

function capability(decision = 'ALLOW') {
  return { decision, reasonCodes: [] };
}

function dataset() {
  return {
    format: 'rv-cloud-dataset/1',
    generation: 7,
    asOf: AS_OF,
    coverage: {
      trades: coverage(),
      income: coverage(),
      orders: coverage(),
      algoOrders: coverage(),
      forceOrders: coverage(),
      balances: coverage(),
      positions: coverage(),
    },
    reconciliation: {
      protocol: 'rv-reconciliation/2',
      status: 'PASS',
      reasonCodes: [],
      checks: {
        eventIdentity: { status: 'PASS', reasonCodes: [] },
        generationClosure: { status: 'PASS', reasonCodes: [] },
      },
    },
    capabilities: {
      recordsBrowsable: capability(),
      observedTradeAnalytics: capability(),
      accountKpis: capability(),
      currentPositions: capability(),
      equityAnalytics: capability(),
      ledger: capability(),
      experiments: capability(),
      ai: capability(),
    },
    trades: [{
      id: '90071992547409930001',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      time: 1_777_771_140_000,
      price: '68000.25',
      qty: '0.010',
      commission: '0.272001',
      commissionAsset: 'USDT',
      realizedPnl: '12.50',
      realizedPnlAsset: 'USDT',
    }],
    tradeModels: [{
      tradeId: TRADE_ID,
      generation: 7,
      payloadSha256: 'a'.repeat(64),
      payload: {
        id: TRADE_ID, symbol: 'BTCUSDT', side: 'LONG', positionSide: 'BOTH',
        entryTime: 1_777_771_140_000, exitTime: 1_777_771_200_000,
        entryPrice: '68000.25', exitPrice: '68100', qty: '0.01', notional: '680.0025',
        realizedPnl: '1', realizedPnlAsset: 'USDT',
        commissionByAsset: [{ asset: 'USDT', amount: '0.54' }], source: 'binance',
      },
    }],
    reviews: [{
      reviewId: REVIEW_ID,
      tradeId: TRADE_ID,
      version: 2,
      updatedAt: AS_OF,
      payload: {
        saw: '突破后回踩', happened: '按计划退出', lesson: '等待确认', grade: 'B', reviewed: true,
      },
    }],
    actions: [{
      actionId: ACTION_ID,
      reviewId: REVIEW_ID,
      tradeId: TRADE_ID,
      status: 'OPEN',
      version: 3,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      payload: { text: '等待确认', experiment: null },
    }],
    journal: [{
      journalId: JOURNAL_ID,
      day: '2026-08-31',
      version: 1,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      payload: { note: '只做计划内交易', emotion: '冷静' },
    }],
    risk: [{
      ruleId: RULE_ID,
      status: 'ACTIVE',
      version: 1,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      payload: { text: '连续亏损三笔后停止', active: true },
    }],
    reports: [{
      reportId: REPORT_ID,
      reportType: 'WEEKLY',
      periodStart: '2026-08-25',
      periodEnd: '2026-08-31',
      sourceGeneration: 7,
      version: 1,
      createdAt: AS_OF,
      updatedAt: AS_OF,
      payload: { reviewRate: 1, completedActions: 0 },
    }],
  };
}

describe('rv-cloud-dataset/1', () => {
  it('normalizes and deep-freezes the exact trusted read model without numeric ID loss', () => {
    const input = dataset();
    const normalized = normalizeCloudDatasetV1(input);

    expect(normalized).toEqual(input);
    expect(normalized.trades[0].id).toBe('90071992547409930001');
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.coverage.trades)).toBe(true);
    expect(Object.isFrozen(normalized.reviews[0].payload)).toBe(true);
    expect(normalized.actions[0].actionId).toBe(ACTION_ID);
    expect(normalized.journal[0].day).toBe('2026-08-31');
    expect(normalized.risk[0].ruleId).toBe(RULE_ID);
    expect(normalized.reports[0].reportId).toBe(REPORT_ID);
  });

  it.each(['PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT'] as const)(
    'keeps verified rows browsable when coverage is %s',
    (state) => {
      const input: any = dataset();
      input.coverage.trades = coverage(state);
      input.reconciliation.status = state;
      input.reconciliation.reasonCodes = [`COVERAGE_${state}`];
      input.capabilities.observedTradeAnalytics = capability('DENY');
      input.capabilities.accountKpis = capability('DENY');
      input.capabilities.currentPositions = capability('DENY');
      input.capabilities.equityAnalytics = capability('DENY');
      input.capabilities.ledger = capability('DENY');
      input.capabilities.experiments = capability('DENY');
      input.capabilities.ai = capability('DENY');

      const normalized = normalizeCloudDatasetV1(input);
      expect(normalized.coverage.trades.state).toBe(state);
      expect(normalized.trades).toHaveLength(1);
      expect(normalized.capabilities.recordsBrowsable.decision).toBe('ALLOW');
    },
  );

  it('accepts explicit bounded gaps and nullable watermarks for unknown coverage', () => {
    const input: any = dataset();
    input.coverage.income = {
      state: 'UNKNOWN',
      attempted: AS_OF,
      fetched: null,
      committed: null,
      trusted: null,
      gaps: [{
        code: 'BINANCE_RETENTION_LIMIT',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-02T00:00:00.000Z',
      }],
    } as never;
    input.reconciliation.status = 'UNKNOWN';
    input.reconciliation.reasonCodes = ['INCOME_UNKNOWN'];

    expect(normalizeCloudDatasetV1(input).coverage.income.gaps).toHaveLength(1);
  });

  it('requires the complete seven-dataset USDⓈ-M coverage contract', () => {
    const incomplete: any = dataset();
    delete incomplete.coverage.balances;
    expect(() => normalizeCloudDatasetV1(incomplete)).toThrow(/CLOUD_DATASET_INVALID/);
    expect(Object.keys(normalizeCloudDatasetV1(dataset()).coverage).sort()).toEqual([
      'algoOrders', 'balances', 'forceOrders', 'income', 'orders', 'positions', 'trades',
    ]);
  });

  it.each([
    ['wrong format', { format: 'rv-cloud-dataset/0' }],
    ['unknown top-level field', { unexpected: true }],
    ['unsafe generation', { generation: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', (_label, mutation) => {
    expect(() => normalizeCloudDatasetV1({ ...dataset(), ...mutation }))
      .toThrow(CloudBetaContractError);
  });

  it('rejects unknown nested fields, invalid states and reversed trusted watermarks', () => {
    const extra = dataset();
    (extra.coverage.trades as Record<string, unknown>).secret = 'must-not-pass';
    expect(() => normalizeCloudDatasetV1(extra)).toThrow(/CLOUD_DATASET_INVALID/);

    const badState: any = dataset();
    badState.coverage.trades.state = 'FRESH';
    expect(() => normalizeCloudDatasetV1(badState)).toThrow(/CLOUD_DATASET_INVALID/);

    const reversed = dataset();
    reversed.coverage.trades.trusted = AS_OF;
    reversed.coverage.trades.committed = '2026-08-31T00:58:00.000Z';
    expect(() => normalizeCloudDatasetV1(reversed)).toThrow(/CLOUD_DATASET_INVALID/);
  });

  it('rejects unbounded or credential-shaped nested review payloads', () => {
    const unsafe: any = dataset();
    unsafe.reviews[0].payload = { apiSecret: 'never' };
    expect(() => normalizeCloudDatasetV1(unsafe)).toThrow(/CLOUD_DATASET_INVALID/);

    const tooMany = dataset();
    tooMany.trades = Array.from({ length: 10_001 }, () => dataset().trades[0]);
    expect(() => normalizeCloudDatasetV1(tooMany)).toThrow(/CLOUD_DATASET_INVALID/);
  });

  it.each(['actions', 'journal', 'risk', 'reports'] as const)(
    'requires and validates the server-owned %s collection',
    (name) => {
      const missing: any = dataset();
      delete missing[name];
      expect(() => normalizeCloudDatasetV1(missing)).toThrow(/CLOUD_DATASET_INVALID/);

      const unsafe: any = dataset();
      unsafe[name][0].payload = { refreshToken: 'must-not-cross-the-browser-boundary' };
      expect(() => normalizeCloudDatasetV1(unsafe)).toThrow(/CLOUD_DATASET_INVALID/);
    },
  );

  it('rejects action rows that are not bound to the same review trade identity', () => {
    const mismatched: any = dataset();
    mismatched.actions[0].tradeId = '2';
    expect(() => normalizeCloudDatasetV1(mismatched)).toThrow(/CLOUD_DATASET_INVALID/);
  });

  it('rejects numeric cloud decimals so provider precision is never rounded by JSON', () => {
    const numeric = dataset();
    numeric.trades[0].price = 68000.25 as never;
    expect(() => normalizeCloudDatasetV1(numeric)).toThrow(/CLOUD_DATASET_INVALID/);
  });

  it('requires explicit settlement and commission assets on every browsable fill', () => {
    const missing: any = dataset();
    delete missing.trades[0].commissionAsset;
    expect(() => normalizeCloudDatasetV1(missing)).toThrow(/CLOUD_DATASET_INVALID/);

    const mismatched: any = dataset();
    mismatched.trades[0].realizedPnlAsset = 'USDC';
    expect(() => normalizeCloudDatasetV1(mismatched)).toThrow(/CLOUD_DATASET_INVALID/);
  });

  it('preserves sorted per-asset commission evidence for USDT and USDC settlement', () => {
    const input: any = dataset();
    input.tradeModels[0].payload = {
      ...input.tradeModels[0].payload,
      symbol: 'BTCUSDC',
      realizedPnlAsset: 'USDC',
      commissionByAsset: [
        { asset: 'BNB', amount: '0.00001' },
        { asset: 'USDC', amount: '0.54' },
      ],
    };
    const payload = normalizeCloudDatasetV1(input).tradeModels[0].payload;
    expect(payload.realizedPnlAsset).toBe('USDC');
    expect(payload.commissionByAsset).toEqual(input.tradeModels[0].payload.commissionByAsset);
    expect(Object.isFrozen(payload.commissionByAsset)).toBe(true);
  });

  it('rejects ambiguous, mismatched, duplicated, or unsorted asset evidence', () => {
    const mismatched: any = dataset();
    mismatched.tradeModels[0].payload.realizedPnlAsset = 'USDC';
    expect(() => normalizeCloudDatasetV1(mismatched)).toThrow(/CLOUD_DATASET_INVALID/);

    for (const commissionByAsset of [
      [{ asset: 'USDT', amount: '0.1' }, { asset: 'BNB', amount: '0.2' }],
      [{ asset: 'USDT', amount: '0.1' }, { asset: 'USDT', amount: '0.2' }],
      [{ asset: 'BNB', amount: 0.2 }],
    ]) {
      const invalid: any = dataset();
      invalid.tradeModels[0].payload.commissionByAsset = commissionByAsset;
      expect(() => normalizeCloudDatasetV1(invalid)).toThrow(/CLOUD_DATASET_INVALID/);
    }
  });
});

describe('rv-cloud-sync/1', () => {
  it('accepts only the exact queued job receipt', () => {
    expect(normalizeCloudSyncV1({
      protocolVersion: 'rv-cloud-sync/1',
      status: 'QUEUED',
      jobId: '018f47a2-4bb0-7ee0-8000-0123456789ab',
    })).toEqual({
      protocolVersion: 'rv-cloud-sync/1',
      status: 'QUEUED',
      jobId: '018f47a2-4bb0-7ee0-8000-0123456789ab',
    });
  });

  it.each([
    { protocolVersion: 'rv-cloud-sync/0', status: 'QUEUED', jobId: '018f47a2-4bb0-7ee0-8000-0123456789ab' },
    { protocolVersion: 'rv-cloud-sync/1', status: 'STARTED', jobId: '018f47a2-4bb0-7ee0-8000-0123456789ab' },
    { protocolVersion: 'rv-cloud-sync/1', status: 'QUEUED', jobId: 'not-a-uuid' },
    { protocolVersion: 'rv-cloud-sync/1', status: 'QUEUED', jobId: '018f47a2-4bb0-7ee0-8000-0123456789ab', extra: true },
  ])('rejects a non-canonical sync envelope: %o', (input) => {
    expect(() => normalizeCloudSyncV1(input)).toThrow(/CLOUD_SYNC_INVALID/);
  });
});
