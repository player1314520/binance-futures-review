import { describe, expect, it, vi } from 'vitest';
import { BINANCE_BETA_CONSENT_VERSION } from './cloud-beta-connection';
import { CloudBetaClient, CloudBetaClientError } from './cloud-beta-client';

const ORIGIN = `https://${'a'.repeat(20)}.supabase.co`;
const KEY = `sb_publishable_${'A'.repeat(24)}`;
const TOKEN = 'signed-user-access-token';
const CONNECTION_ID = '018f47a2-4bb0-7ee0-8000-0123456789ab';
const IDEMPOTENCY_KEY = '018f47a2-4bb0-7ee0-8000-abcdefabcdef';
const ACTION_ID = '018f47a2-4bb0-7ee0-8000-222222222222';
const RULE_ID = '018f47a2-4bb0-7ee0-8000-444444444444';
const TRADE_ID = 't_0123456789abcdef';
const RESTORE_ID = '77777777-7777-4777-8777-777777777777';
const AT = '2026-08-31T01:00:00.000Z';

function evidence() {
  return {
    evidenceVersion: 'rv-binance-permission/1',
    provider: 'binance-usdm',
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
    checkedAt: AT,
    evidenceDigest: 'a'.repeat(64),
  };
}

function entry() {
  return {
    connectionId: CONNECTION_ID,
    status: 'ACTIVE',
    credentialVersion: 1,
    lastTrustedAt: AT,
    nextDueAt: '2026-08-31T02:00:00.000Z',
    permissionEvidence: evidence(),
  };
}

function response(body: unknown, status = 200, url = ''): Response {
  const result = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  if (url) Object.defineProperty(result, 'url', { value: url });
  return result;
}

function client(fetchImpl: typeof fetch) {
  return new CloudBetaClient(
    { supabaseUrl: ORIGIN, publishableKey: KEY },
    { fetchImpl, accessToken: () => TOKEN, timeoutMs: 2_000 },
  );
}

describe('CloudBetaClient', () => {
  it('lists connections only through the configured Supabase Edge origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      format: 'rv-binance-connections/1',
      connections: [entry()],
    }));

    const listed = await client(fetchImpl).listConnections();

    expect(listed.connections).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/functions/v1/binance-beta/v1/connections`);
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init?.headers).get('apikey')).toBe(KEY);
  });

  it('sends credentials once with exact consent/idempotency fields and never writes browser storage', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const sessionSet = vi.spyOn(sessionStorage, 'setItem');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      connectionId: CONNECTION_ID,
      status: 'ACTIVE',
      credentialVersion: 1,
      permissionEvidence: evidence(),
    }, 201));

    await client(fetchImpl).createConnection({
      apiKey: 'readonly-api-key-123456',
      apiSecret: 'one-time-api-secret-123456',
      consentVersion: BINANCE_BETA_CONSENT_VERSION,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      apiKey: 'readonly-api-key-123456',
      apiSecret: 'one-time-api-secret-123456',
      consentVersion: BINANCE_BETA_CONSENT_VERSION,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('uses exact rotate, sync, status and disconnect routes', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        connectionId: CONNECTION_ID,
        status: 'ACTIVE',
        credentialVersion: 2,
        permissionEvidence: evidence(),
      }))
      .mockResolvedValueOnce(response({
        protocolVersion: 'rv-cloud-sync/1',
        status: 'QUEUED',
        jobId: IDEMPOTENCY_KEY,
      }, 202))
      .mockResolvedValueOnce(response({
        format: 'rv-binance-connection-status/1',
        connection: entry(),
        coverage: null,
        lastErrorCode: null,
      }))
      .mockResolvedValueOnce(response({ status: 'DISCONNECTED', receiptId: IDEMPOTENCY_KEY }));
    const api = client(fetchImpl);

    await api.rotateConnection(CONNECTION_ID, {
      apiKey: 'rotated-readonly-key-123',
      apiSecret: 'rotated-one-time-secret-123',
      consentVersion: BINANCE_BETA_CONSENT_VERSION,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await api.queueSync(CONNECTION_ID, IDEMPOTENCY_KEY);
    await api.getConnectionStatus(CONNECTION_ID);
    await api.disconnectConnection(CONNECTION_ID);

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${ORIGIN}/functions/v1/binance-beta/v1/connections/${CONNECTION_ID}/rotate`, 'POST'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/connections/${CONNECTION_ID}/sync`, 'POST'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/connections/${CONNECTION_ID}/status`, 'GET'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/connections/${CONNECTION_ID}`, 'DELETE'],
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it('recovers a restored owner only through the fixed user route without browser persistence', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const sessionSet = vi.spyOn(sessionStorage, 'setItem');
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      format: 'rv-restore-v2-owner-recovery/1',
      restoreId: RESTORE_ID,
      state: 'CLAIMED',
      claimed: true,
      idempotent: false,
      remainingOwnerClaims: 0,
      inviteClaimDisclosed: false,
      recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE',
    }));

    const recovered = await client(fetchImpl).recoverRestoredOwner(RESTORE_ID);

    expect(recovered).toEqual({
      format: 'rv-restore-v2-owner-recovery/1',
      restoreId: RESTORE_ID,
      state: 'CLAIMED',
      claimed: true,
      idempotent: false,
      remainingOwnerClaims: 0,
      inviteClaimDisclosed: false,
      recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/functions/v1/restore-v2/internal/v2/restore/owner-recover`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({ restoreId: RESTORE_ID });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init?.headers).get('apikey')).toBe(KEY);
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid restore id, a non-enumerating 404, or leaked invite material', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = client(fetchImpl);
    await expect(api.recoverRestoredOwner('not-a-restore-id')).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_INVALID',
    });
    await expect(api.recoverRestoredOwner(CONNECTION_ID)).rejects.toMatchObject({
      code: 'CLOUD_REQUEST_INVALID',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(response({ error: 'not_found' }, 404));
    await expect(api.recoverRestoredOwner(RESTORE_ID)).rejects.toMatchObject({
      code: 'CLOUD_RECOVERY_NOT_FOUND',
      status: 404,
    });

    fetchImpl.mockResolvedValueOnce(response({
      format: 'rv-restore-v2-owner-recovery/1',
      restoreId: RESTORE_ID,
      state: 'CLAIMED',
      claimed: true,
      idempotent: false,
      remainingOwnerClaims: 0,
      inviteClaimDisclosed: false,
      recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE',
      inviteClaim: 'c'.repeat(64),
    }));
    await expect(api.recoverRestoredOwner(RESTORE_ID)).rejects.toMatchObject({
      code: 'CLOUD_RESPONSE_INVALID',
    });
  });

  it('normalizes the current dataset from the one fixed data route', async () => {
    const capability = { decision: 'DENY', reasonCodes: ['BETA_GATE_LOCKED'] };
    const coverage = {
      state: 'UNKNOWN', attempted: AT, fetched: null, committed: null, trusted: null, gaps: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      format: 'rv-cloud-dataset/1',
      generation: 0,
      asOf: AT,
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
        protocol: 'rv-reconciliation/2', status: 'UNKNOWN',
        reasonCodes: ['BETA_GATE_LOCKED'], checks: {},
      },
      capabilities: {
        recordsBrowsable: { decision: 'LIMITED', reasonCodes: ['BETA_GATE_LOCKED'] },
        observedTradeAnalytics: capability,
        accountKpis: capability,
        currentPositions: capability,
        equityAnalytics: capability,
        ledger: capability,
        experiments: capability,
        ai: capability,
      },
      trades: [],
      tradeModels: [],
      reviews: [],
      actions: [],
      journal: [],
      risk: [],
      reports: [],
    }));

    expect((await client(fetchImpl).getCurrentDataset(CONNECTION_ID)).format).toBe('rv-cloud-dataset/1');
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${ORIGIN}/functions/v1/binance-beta/v1/datasets/current`,
    );
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('x-rv-connection-id'))
      .toBe(CONNECTION_ID);
  });

  it('writes review/action/journal/risk/report through fixed CAS routes without browser persistence', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        format: 'rv-cloud-review/1', tradeId: TRADE_ID, version: 1, updatedAt: AT,
      }))
      .mockResolvedValueOnce(response({
        format: 'rv-cloud-mutation/1', resource: 'action', resourceId: ACTION_ID,
        version: 4, updatedAt: AT,
      }))
      .mockResolvedValueOnce(response({
        format: 'rv-cloud-mutation/1', resource: 'journal', resourceId: '2026-08-31',
        version: 1, updatedAt: AT,
      }))
      .mockResolvedValueOnce(response({
        format: 'rv-cloud-mutation/1', resource: 'risk', resourceId: RULE_ID,
        version: 1, updatedAt: AT,
      }))
      .mockResolvedValueOnce(response({
        format: 'rv-cloud-mutation/1', resource: 'report',
        resourceId: '018f47a2-4bb0-7ee0-8000-555555555555', version: 1, updatedAt: AT,
      }));
    const api = client(fetchImpl);

    await api.upsertReview(CONNECTION_ID, TRADE_ID, {
      expectedVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      payload: {
        saw: '突破后回踩', happened: '按计划退出', lesson: '等待确认', grade: 'B', reviewed: true,
      },
    });
    await api.updateAction(CONNECTION_ID, ACTION_ID, {
      expectedVersion: 3,
      idempotencyKey: IDEMPOTENCY_KEY,
      reviewId: '018f47a2-4bb0-7ee0-8000-111111111111',
      tradeId: TRADE_ID,
      status: 'OPEN',
      payload: { text: '等待确认', experiment: null },
    });
    await api.upsertJournal(CONNECTION_ID, '2026-08-31', {
      expectedVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      payload: { note: '只做计划内交易', emotion: '冷静' },
    });
    await api.upsertRiskRule(CONNECTION_ID, RULE_ID, {
      expectedVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      status: 'ACTIVE',
      payload: { text: '连续亏损三笔后停止', active: true },
    });
    await api.upsertReport(CONNECTION_ID, {
      expectedVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      reportType: 'WEEKLY',
      periodStart: '2026-08-25',
      periodEnd: '2026-08-31',
      sourceGeneration: 7,
      payload: { reviewRate: 1, completedActions: 0 },
    });

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${ORIGIN}/functions/v1/binance-beta/v1/reviews/${TRADE_ID}`, 'PUT'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/actions/${ACTION_ID}`, 'PUT'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/journal/2026-08-31`, 'PUT'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/risk/${RULE_ID}`, 'PUT'],
      [`${ORIGIN}/functions/v1/binance-beta/v1/reports/current`, 'PUT'],
    ]);
    expect(fetchImpl.mock.calls.every(([, init]) => (
      new Headers(init?.headers).get('x-rv-connection-id') === CONNECTION_ID
    ))).toBe(true);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('rejects credential-shaped or oversized domain payloads before fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = client(fetchImpl);

    await expect(api.updateAction(CONNECTION_ID, ACTION_ID, {
      expectedVersion: 1,
      idempotencyKey: IDEMPOTENCY_KEY,
      reviewId: '018f47a2-4bb0-7ee0-8000-111111111111',
      tradeId: TRADE_ID,
      status: 'OPEN',
      payload: { text: 'safe', experiment: { apiSecret: 'never' } },
    })).rejects.toMatchObject({ code: 'CLOUD_REQUEST_INVALID' });
    await expect(api.upsertJournal(CONNECTION_ID, '2026-08-31', {
      expectedVersion: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      payload: { note: 'x'.repeat(4_001), emotion: '冷静' },
    })).rejects.toMatchObject({ code: 'CLOUD_REQUEST_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed without auth and rejects wrong-origin responses or unsafe config', async () => {
    const unauthenticated = new CloudBetaClient(
      { supabaseUrl: ORIGIN, publishableKey: KEY },
      { fetchImpl: vi.fn(), accessToken: () => null },
    );
    await expect(unauthenticated.listConnections()).rejects.toMatchObject({ code: 'CLOUD_AUTH_REQUIRED' });

    const redirected = vi.fn<typeof fetch>(async () => response(
      { format: 'rv-binance-connections/1', connections: [] },
      200,
      'https://evil.example/redirected',
    ));
    await expect(client(redirected).listConnections()).rejects.toMatchObject({
      code: 'CLOUD_ORIGIN_MISMATCH',
    });

    expect(() => new CloudBetaClient(
      { supabaseUrl: `${ORIGIN}/proxy`, publishableKey: KEY },
      { fetchImpl: vi.fn(), accessToken: () => TOKEN },
    )).toThrow(CloudBetaClientError);
  });
});
