import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudBetaAvailable,
  disconnectCloudBinanceConnection,
  listCloudBinanceConnections,
  loadBinanceSnapshot,
  resolveBinanceSourceMode,
  resolveSnapshotReviewScope,
  selectCloudConnection,
} from './binance-source';

const TOKEN_A = `rv1_${'a'.repeat(32)}`;
const TOKEN_B = `rv1_${'b'.repeat(32)}`;

function runtime(reviewScope: string | null | undefined, connected = true) {
  return {
    reviewScope,
    binance: { connected, state: connected ? 'connected' : 'unconfigured', canSync: connected },
  } as any;
}

function bundle(reviewScope: string | null | undefined, connected = true) {
  return {
    reviewScope,
    _meta: { connected },
  } as any;
}

describe('Binance snapshot review scope', () => {
  beforeEach(() => selectCloudConnection(null));
  it('returns one storage-safe scope only when both projections match', () => {
    expect(resolveSnapshotReviewScope(runtime(TOKEN_A), bundle(TOKEN_A)))
      .toBe(`binance-rv1-${'a'.repeat(32)}`);
  });

  for (const [name, statusScope, bundleScope] of [
    ['mismatched', TOKEN_A, TOKEN_B],
    ['missing status', undefined, TOKEN_A],
    ['missing bundle', TOKEN_A, undefined],
    ['null bundle', TOKEN_A, null],
  ] as const) {
    it(`fails closed for ${name} scope evidence`, () => {
      expect(() => resolveSnapshotReviewScope(
        runtime(statusScope),
        bundle(bundleScope),
      )).toThrowError(expect.objectContaining({ code: 'BINANCE_SCOPE_MISMATCH' }));
    });
  }

  it('fails closed when either projection is disconnected', () => {
    expect(() => resolveSnapshotReviewScope(runtime(TOKEN_A, false), bundle(TOKEN_A)))
      .toThrowError(expect.objectContaining({ code: 'BINANCE_NOT_CONNECTED' }));
    expect(() => resolveSnapshotReviewScope(runtime(TOKEN_A), bundle(TOKEN_A, false)))
      .toThrowError(expect.objectContaining({ code: 'BINANCE_NOT_CONNECTED' }));
  });
});

const CLOUD_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const TEST_PROJECT_REF = 'a'.repeat(20);
const SUPABASE_ORIGIN = `https://${TEST_PROJECT_REF}.supabase.co`;
const CONNECTION_ID = '018f47a2-4bb0-7ee0-8000-0123456789ab';
const REVIEW_ID = '018f47a2-4bb0-7ee0-8000-111111111111';
const ACTION_ID = '018f47a2-4bb0-7ee0-8000-222222222222';
const JOURNAL_ID = '018f47a2-4bb0-7ee0-8000-333333333333';
const RULE_ID = '018f47a2-4bb0-7ee0-8000-444444444444';
const REPORT_ID = '018f47a2-4bb0-7ee0-8000-555555555555';
const TRADE_ID = 't_0123456789abcdef';
const AS_OF = '2026-08-31T01:00:00.000Z';

function betaEnv() {
  return {
    VITE_RELEASE_CHANNEL: 'production',
    VITE_BACKEND_MODE: 'invite-beta',
    VITE_SUPABASE_URL: SUPABASE_ORIGIN,
    VITE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'A'.repeat(24)}`,
    VITE_EXPECTED_SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
    VITE_APP_ORIGIN: CLOUD_ORIGIN,
  };
}

function permissionEvidence() {
  return {
    evidenceVersion: 'rv-binance-permission/1', provider: 'binance-usdm',
    readOnly: true, tradeDisabled: true, withdrawDisabled: true,
    internalTransferDisabled: true, universalTransferDisabled: true,
    checkedAt: AS_OF, evidenceDigest: 'a'.repeat(64),
  };
}

function connection() {
  return {
    connectionId: CONNECTION_ID,
    status: 'PARTIAL',
    credentialVersion: 1,
    lastTrustedAt: null,
    nextDueAt: null,
    permissionEvidence: permissionEvidence(),
  };
}

function cloudDataset(state = 'PARTIAL') {
  const coverage = {
    state, attempted: AS_OF, fetched: AS_OF, committed: AS_OF,
    trusted: state === 'VERIFIED' ? AS_OF : null, gaps: [],
  };
  const denied = { decision: 'DENY', reasonCodes: [`COVERAGE_${state}`] };
  return {
    format: 'rv-cloud-dataset/1', generation: 3, asOf: AS_OF,
    coverage: {
      trades: coverage,
      income: coverage,
      orders: coverage,
      algoOrders: coverage,
      forceOrders: coverage,
      balances: coverage,
      positions: coverage,
    },
    reconciliation: {
      protocol: 'rv-reconciliation/2', status: state === 'VERIFIED' ? 'PASS' : state,
      reasonCodes: state === 'VERIFIED' ? [] : [`COVERAGE_${state}`], checks: {},
    },
    capabilities: {
      recordsBrowsable: { decision: 'LIMITED', reasonCodes: [`COVERAGE_${state}`] },
      observedTradeAnalytics: state === 'VERIFIED'
        ? { decision: 'ALLOW', reasonCodes: [] }
        : denied,
      accountKpis: denied,
      currentPositions: denied,
      equityAnalytics: denied,
      ledger: denied,
      experiments: denied,
      ai: denied,
    },
    trades: [{
      id: '90071992547409930001', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
      time: 1_777_771_140_000, price: '68000.25', qty: '0.010',
      commission: '0.272001', commissionAsset: 'USDT',
      realizedPnl: '12.50', realizedPnlAsset: 'USDT',
    }],
    tradeModels: [{
      tradeId: TRADE_ID, generation: 3, payloadSha256: 'a'.repeat(64),
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
      actionId: ACTION_ID, reviewId: REVIEW_ID, tradeId: TRADE_ID,
      status: 'OPEN', version: 3, createdAt: AS_OF, updatedAt: AS_OF,
      payload: { text: '等待确认', experiment: null },
    }],
    journal: [{
      journalId: JOURNAL_ID, day: '2026-08-31', version: 1,
      createdAt: AS_OF, updatedAt: AS_OF,
      payload: { note: '只做计划内交易', emotion: '冷静' },
    }],
    risk: [{
      ruleId: RULE_ID, status: 'ACTIVE', version: 1,
      createdAt: AS_OF, updatedAt: AS_OF,
      payload: { text: '连续亏损三笔后停止', active: true },
    }],
    reports: [{
      reportId: REPORT_ID, reportType: 'WEEKLY',
      periodStart: '2026-08-25', periodEnd: '2026-08-31', sourceGeneration: 3,
      version: 1, createdAt: AS_OF, updatedAt: AS_OF,
      payload: { reviewRate: 1 },
    }],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Binance source routing', () => {
  beforeEach(() => selectCloudConnection(null));

  it('keeps exact loopback on the existing runtime and fails closed for ordinary public local-demo', () => {
    expect(resolveBinanceSourceMode({
      origin: 'http://127.0.0.1:8790',
      env: betaEnv(),
    })).toBe('local-runtime');
    expect(resolveBinanceSourceMode({ origin: 'https://example.com', env: {} })).toBe('unavailable');
    expect(cloudBetaAvailable({ origin: 'https://example.com', env: betaEnv() })).toBe(false);
  });

  it('routes canonical invite-beta through Edge and keeps degraded records browse-only', async () => {
    const storageGet = vi.spyOn(Storage.prototype, 'getItem');
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/connections')) {
        return json({ format: 'rv-binance-connections/1', connections: [connection()] });
      }
      if (url.endsWith(`/${CONNECTION_ID}/status`)) {
        return json({
          format: 'rv-binance-connection-status/1',
          connection: connection(),
          coverage: null,
          lastErrorCode: 'SYNC_PARTIAL',
        });
      }
      if (url.endsWith('/v1/datasets/current')) return json(cloudDataset());
      throw new Error(`unexpected route: ${url}`);
    });

    const snapshot = await loadBinanceSnapshot({
      origin: CLOUD_ORIGIN,
      env: betaEnv(),
      fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    });

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toMatchObject({ id: TRADE_ID, pnl: 0, fee: 0 });
    expect(snapshot.access).toMatchObject({
      phase: 'BINANCE_BROWSE_ONLY',
      showRecords: true,
      showObservedAnalytics: false,
      showAccountKpis: false,
      showLedger: false,
      showEquity: false,
    });
    expect(snapshot.reviewScope).toBe(`binance-rv1-${'018f47a24bb07ee08000fedcbafedcba'}`);
    expect(snapshot.cloudWorkspace).toMatchObject({
      connectionId: CONNECTION_ID,
      generation: 3,
      reviewVersions: { [TRADE_ID]: 2 },
      actionVersions: { [ACTION_ID]: 3 },
      journalVersions: { '2026-08-31': 1 },
      riskVersions: { [RULE_ID]: 1 },
    });
    expect(snapshot.cloudWorkspace?.reviews[TRADE_ID]).toMatchObject({
      lesson: '等待确认', reviewed: true,
    });
    expect(snapshot.cloudWorkspace?.actions[ACTION_ID]).toMatchObject({
      id: ACTION_ID, sourceTradeId: TRADE_ID, text: '等待确认', status: 'open',
    });
    expect(snapshot.cloudWorkspace?.journal[0]).toMatchObject({ day: '2026-08-31', emotion: '冷静' });
    expect(snapshot.cloudWorkspace?.guards[0]).toMatchObject({ id: RULE_ID, active: true });
    expect(snapshot.cloudWorkspace?.reports[0].reportId).toBe(REPORT_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith(`${SUPABASE_ORIGIN}/`))).toBe(true);
    const datasetRequest = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/v1/datasets/current'));
    expect(new Headers(datasetRequest?.[1]?.headers).get('x-rv-connection-id')).toBe(CONNECTION_ID);
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('uses the generation-bound server trade id instead of pairing cloud fills in the browser', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/connections')) {
        return json({ format: 'rv-binance-connections/1', connections: [connection()] });
      }
      if (url.endsWith(`/${CONNECTION_ID}/status`)) {
        return json({
          format: 'rv-binance-connection-status/1', connection: connection(),
          coverage: null, lastErrorCode: null,
        });
      }
      if (url.endsWith('/v1/datasets/current')) return json(cloudDataset('VERIFIED'));
      throw new Error(`unexpected route: ${url}`);
    });
    const snapshot = await loadBinanceSnapshot({
      origin: CLOUD_ORIGIN, env: betaEnv(), fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    });
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toMatchObject({ id: TRADE_ID, symbol: 'BTCUSDT', pnl: 0.46 });
  });

  it('keeps records browsable but denies Classic analytics for a foreign commission asset', async () => {
    const mixedAsset: any = cloudDataset('VERIFIED');
    mixedAsset.tradeModels[0].payload.commissionByAsset = [
      { asset: 'BNB', amount: '0.00001' },
      { asset: 'USDT', amount: '0.54' },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/connections')) {
        return json({ format: 'rv-binance-connections/1', connections: [connection()] });
      }
      if (url.endsWith(`/${CONNECTION_ID}/status`)) {
        return json({
          format: 'rv-binance-connection-status/1', connection: connection(),
          coverage: null, lastErrorCode: null,
        });
      }
      if (url.endsWith('/v1/datasets/current')) return json(mixedAsset);
      throw new Error(`unexpected route: ${url}`);
    });
    const snapshot = await loadBinanceSnapshot({
      origin: CLOUD_ORIGIN, env: betaEnv(), fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toMatchObject({ id: TRADE_ID, pnl: 0, fee: 0 });
    expect(snapshot.access).toMatchObject({
      phase: 'BINANCE_BROWSE_ONLY',
      showRecords: true,
      showObservedAnalytics: false,
      showAccountKpis: false,
      showLedger: false,
    });
    expect(snapshot.access.reasonCodes).toContain('CLOUD_CROSS_ASSET_ANALYTICS_UNAVAILABLE');
    expect(snapshot.cloudWorkspace?.capabilities.experiments).toMatchObject({
      decision: 'DENY',
      reasonCodes: expect.arrayContaining(['CLOUD_CROSS_ASSET_ANALYTICS_UNAVAILABLE']),
    });
  });

  it('keeps USDT and USDC rows browsable but denies every account-level analytic', async () => {
    const mixedSettlement: any = cloudDataset('VERIFIED');
    mixedSettlement.trades.push({
      ...mixedSettlement.trades[0],
      id: '90071992547409930002',
      symbol: 'BTCUSDC',
      commissionAsset: 'USDC',
      realizedPnlAsset: 'USDC',
    });
    mixedSettlement.tradeModels.push({
      ...mixedSettlement.tradeModels[0],
      tradeId: 't_fedcba9876543210',
      payloadSha256: 'b'.repeat(64),
      payload: {
        ...mixedSettlement.tradeModels[0].payload,
        id: 't_fedcba9876543210',
        symbol: 'BTCUSDC',
        realizedPnlAsset: 'USDC',
        commissionByAsset: [{ asset: 'USDC', amount: '0.54' }],
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/connections')) {
        return json({ format: 'rv-binance-connections/1', connections: [connection()] });
      }
      if (url.endsWith(`/${CONNECTION_ID}/status`)) {
        return json({
          format: 'rv-binance-connection-status/1', connection: connection(),
          coverage: null, lastErrorCode: null,
        });
      }
      if (url.endsWith('/v1/datasets/current')) return json(mixedSettlement);
      throw new Error(`unexpected route: ${url}`);
    });
    const snapshot = await loadBinanceSnapshot({
      origin: CLOUD_ORIGIN, env: betaEnv(), fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    });
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.trades).toHaveLength(2);
    expect(snapshot.trades.map((trade) => ({ id: trade.id, pnl: trade.pnl, fee: trade.fee })))
      .toEqual([
        { id: TRADE_ID, pnl: 0, fee: 0 },
        { id: 't_fedcba9876543210', pnl: 0, fee: 0 },
      ]);
    expect(snapshot.access).toMatchObject({
      phase: 'BINANCE_BROWSE_ONLY',
      showObservedAnalytics: false,
      showAccountKpis: false,
      showPositions: false,
      showEquity: false,
      showLedger: false,
    });
    expect(snapshot.access.reasonCodes).toContain('CLOUD_MULTI_SETTLEMENT_ANALYTICS_UNAVAILABLE');
    expect(snapshot.cloudWorkspace?.capabilities.experiments).toMatchObject({
      decision: 'DENY',
      reasonCodes: expect.arrayContaining(['CLOUD_MULTI_SETTLEMENT_ANALYTICS_UNAVAILABLE']),
    });
  });

  it('keeps USDC settlement separate and derives Classic net only from USDC commission', async () => {
    const usdc: any = cloudDataset('VERIFIED');
    usdc.trades[0].symbol = 'BTCUSDC';
    usdc.trades[0].commissionAsset = 'USDC';
    usdc.trades[0].realizedPnlAsset = 'USDC';
    usdc.tradeModels[0].payload = {
      ...usdc.tradeModels[0].payload,
      symbol: 'BTCUSDC',
      realizedPnlAsset: 'USDC',
      commissionByAsset: [{ asset: 'USDC', amount: '0.54' }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/connections')) {
        return json({ format: 'rv-binance-connections/1', connections: [connection()] });
      }
      if (url.endsWith(`/${CONNECTION_ID}/status`)) {
        return json({
          format: 'rv-binance-connection-status/1', connection: connection(),
          coverage: null, lastErrorCode: null,
        });
      }
      if (url.endsWith('/v1/datasets/current')) return json(usdc);
      throw new Error(`unexpected route: ${url}`);
    });
    const snapshot = await loadBinanceSnapshot({
      origin: CLOUD_ORIGIN, env: betaEnv(), fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    });
    expect(snapshot.trades[0]).toMatchObject({
      symbol: 'BTCUSDC', currency: 'USDC', fee: 0.54, pnl: 0.46,
    });
  });

  it('does not call fetch for unconfigured local-demo or a copied beta build on the wrong origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const authSession = () => ({
      accessToken: 'signed-user-access-token',
      userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
    });
    await expect(loadBinanceSnapshot({
      origin: 'https://example.com', env: {}, fetchImpl, authSession,
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    await expect(loadBinanceSnapshot({
      origin: 'https://preview.example.com', env: betaEnv(), fetchImpl, authSession,
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists and disconnects only the authenticated connection through the fixed Edge origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        format: 'rv-binance-connections/1',
        connections: [connection()],
      }))
      .mockResolvedValueOnce(json({
        status: 'DISCONNECTED',
        receiptId: '018f47a2-4bb0-7ee0-8000-abcdefabcdef',
      }));
    const options = {
      origin: CLOUD_ORIGIN,
      env: betaEnv(),
      fetchImpl,
      authSession: () => ({
        accessToken: 'signed-user-access-token',
        userId: '018f47a2-4bb0-7ee0-8000-fedcbafedcba',
      }),
    };

    expect((await listCloudBinanceConnections(options)).connections[0].connectionId)
      .toBe(CONNECTION_ID);
    await disconnectCloudBinanceConnection(CONNECTION_ID, options);

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${SUPABASE_ORIGIN}/functions/v1/binance-beta/v1/connections`, 'GET'],
      [`${SUPABASE_ORIGIN}/functions/v1/binance-beta/v1/connections/${CONNECTION_ID}`, 'DELETE'],
    ]);
  });
});
