import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adaptServiceClaim,
  adaptSourceEventsForCommit,
  canonicalBrowserDataset,
  createRuntimeDependencies,
  readRuntimeConfig,
} from '../supabase/functions/binance-beta/runtime.mjs';

const TENANT = '04908935-5d99-44b3-8680-e5305d0a7856';
const REQUESTED_BY = '72615777-336b-4823-a504-741f844f41cd';
const CONNECTION = '30cc92fe-52a9-4b6c-8ac2-3b9c2e0b6601';
const JOB = '25334423-6c9d-4e2e-a7b4-22a6ba0aecb2';
const ATTEMPT = '0202c8e7-e7ab-4cd8-9cac-da84a8ef92da';
const CLAIM = 'a8c9a6c3-216b-4eb1-b8ba-820b39318558';

function runtimeEnvironment() {
  return {
    APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon.'.concat('a'.repeat(40)),
    SUPABASE_SERVICE_ROLE_KEY: 'service.'.concat('s'.repeat(40)),
    RV_BETA_CREDENTIAL_KEK_V1: Buffer.alloc(32, 7).toString('base64url'),
    RV_BETA_SCOPE_HMAC_V1: Buffer.alloc(32, 8).toString('base64url'),
    RV_BETA_SYNC_CRON_TOKEN: 'c'.repeat(64),
    RV_BETA_ARCHIVE_CRON_TOKEN: 'a'.repeat(64),
    RV_BETA_EDGE_WORKER_SUBJECT: REQUESTED_BY,
  };
}

test('browser and SQL datasets converge on the seven reviewed canonical names', () => {
  assert.equal(canonicalBrowserDataset('trades'), 'fills');
  assert.equal(canonicalBrowserDataset('fills'), 'fills');
  assert.equal(canonicalBrowserDataset('income'), 'income');
  assert.equal(canonicalBrowserDataset('orders'), 'orders');
  assert.equal(canonicalBrowserDataset('algo_orders'), 'algo_orders');
  assert.equal(canonicalBrowserDataset('force_orders'), 'force_orders');
  assert.equal(canonicalBrowserDataset('balances'), 'balances');
  assert.equal(canonicalBrowserDataset('positions'), 'positions');
  for (const value of ['userTrades', 'allOrders', 'https://evil.example/x', '', null]) {
    assert.throws(() => canonicalBrowserDataset(value), /dataset/i);
  }
});

test('service claim adapter accepts one SQL row and emits the private worker shape only', () => {
  const value = adaptServiceClaim([{
    job_id: JOB,
    tenant_id: TENANT,
    requested_by: REQUESTED_BY,
    connection_id: CONNECTION,
    provider: 'binance',
    provider_scope_hash: 'a'.repeat(64),
    credential_version: 2,
    dataset: 'fills',
    partition_key: 'BTCUSDT',
    queue_class: 'INTERACTIVE',
    attempt_id: ATTEMPT,
    claim_token: CLAIM,
    lease_expires_at: '2027-01-15T08:02:00.000Z',
    envelope_ciphertext: 'ciphertext',
    envelope_nonce: 'nonce',
    envelope_key_ref: 'RV_BETA_CREDENTIAL_KEK_V1.wrap.wrapped',
    envelope_sha256: 'e'.repeat(64),
    permission_state: 'READ_ONLY_VERIFIED',
    permission_evidence: { evidenceVersion: 'rv-binance-permission/1' },
    page_cursor: { fromId: '9007199254740993' },
    page_number: 4,
    previous_page_digest: 'd'.repeat(64),
  }]);
  assert.equal(value.dataset, 'fills');
  assert.deepEqual(value.query, { symbol: 'BTCUSDT', fromId: '9007199254740993', limit: 1000 });
  assert.deepEqual(value.pageCursor, { fromId: '9007199254740993' });
  assert.equal(value.pageNumber, 4);
  assert.equal(value.previousPageDigest, 'd'.repeat(64));
  assert.deepEqual(value.envelope, {
    version: 1,
    credentialVersion: 2,
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    keyRef: 'RV_BETA_CREDENTIAL_KEK_V1.wrap.wrapped',
    sha256: 'e'.repeat(64),
  });
  assert.equal(Object.hasOwn(value, 'providerScopeHash'), false);
  assert.throws(() => adaptServiceClaim([], {}), /claim/i);
  assert.throws(() => adaptServiceClaim([{ dataset: 'evil' }], {}), /claim/i);
  assert.throws(() => adaptServiceClaim([{
    job_id: JOB,
    tenant_id: TENANT,
    requested_by: REQUESTED_BY,
    connection_id: CONNECTION,
    provider: 'binance',
    provider_scope_hash: 'a'.repeat(64),
    credential_version: 2,
    dataset: 'fills',
    partition_key: 'default',
    queue_class: 'INTERACTIVE',
    attempt_id: ATTEMPT,
    claim_token: CLAIM,
    envelope_sha256: 'e'.repeat(64),
    permission_state: 'READ_ONLY_VERIFIED',
    permission_evidence: {},
    page_cursor: {},
    page_number: 0,
    previous_page_digest: null,
  }]), /symbol partition/i);
});

test('commit adapter exposes only the three-field immutable source-event RPC contract', async () => {
  const values = await adaptSourceEventsForCommit([{
    eventId: 'binance-usdm:fills:BTCUSDT:7',
    source: 'BINANCE',
    market: 'USD_M',
    sourceEndpoint: '/fapi/v1/userTrades',
    observedAt: '2027-01-15T08:00:00.000Z',
    payload: { id: '7', time: '1800000000000', price: '0.100000000000000001', symbol: 'BTCUSDT' },
  }]);
  assert.deepEqual(Object.keys(values[0]).sort(), ['eventTime', 'payload', 'providerEventId']);
  assert.equal(values[0].payload.id, '7');
  assert.equal(values[0].payload.time, '1800000000000');
  assert.equal(values[0].payload.price, '0.100000000000000001');
  assert.doesNotMatch(JSON.stringify(values), /tenantId|requestedBy|apiKey|apiSecret/);
  const numericUpstream = await adaptSourceEventsForCommit([{
      eventId: 'binance-usdm:fills:BTCUSDT:7',
      observedAt: '2027-01-15T08:00:00.000Z',
      payload: { id: 7, symbol: 'BTCUSDT' },
    }]);
  assert.equal(numericUpstream[0].payload.id, '7');
  await assert.rejects(
    adaptSourceEventsForCommit([{
      eventId: 'binance-usdm:fills:BTCUSDT:7',
      observedAt: '2027-01-15T08:00:00.000Z',
      payload: { id: Number.MAX_SAFE_INTEGER + 1, symbol: 'BTCUSDT' },
    }]),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
});

test('runtime canonicalizes every provider number to an exact string and rejects unsafe or fractional JSON numbers', async () => {
  const env = runtimeEnvironment();
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async () => { throw new Error('network not expected'); },
  });
  const [event] = await runtime.internalDeps.normalizeSourceEvents({
    dataset: 'fills',
    partitionKey: 'BTCUSDT',
    sourceEndpoint: '/fapi/v1/userTrades',
    rows: [{
      id: 7,
      orderId: 9_007_199_254_740_991,
      time: 1_800_000_000_000,
      symbol: 'BTCUSDT',
      pair: 'BTCUSDT',
      qty: '0.300000000000000001',
      price: '12.3400',
      quoteQty: '3.70200000000000001234',
      baseQty: '0',
      clientOrderId: 'review-import_42-A',
      commission: '0',
      commissionAsset: 'USDT',
      realizedPnl: '0',
      marginAsset: 'USDT',
      side: 'BUY',
      positionSide: 'BOTH',
    }],
    observedThrough: '2027-01-15T08:00:00.000Z',
  });
  assert.equal(event.eventId, 'binance-usdm:fills:BTCUSDT:7');
  assert.equal(event.payload.id, '7');
  assert.equal(event.payload.time, '1800000000000');
  assert.equal(event.payload.qty, '0.300000000000000001');
  assert.equal(event.payload.price, '12.34');
  assert.equal(event.payload.commissionAsset, 'USDT');
  assert.equal(event.payload.realizedPnlAsset, 'USDT');
  assert.deepEqual(Object.keys(event.payload).sort(), [
    'baseQty', 'commission', 'commissionAsset', 'id', 'pair', 'positionSide',
    'price', 'qty', 'quoteQty', 'realizedPnl', 'realizedPnlAsset', 'side',
    'symbol', 'time',
  ]);
  await assert.rejects(
    runtime.internalDeps.normalizeSourceEvents({
      dataset: 'fills',
      partitionKey: 'BTCUSDT',
      sourceEndpoint: '/fapi/v1/userTrades',
      rows: [{ id: Number.MAX_SAFE_INTEGER + 1, symbol: 'BTCUSDT' }],
      observedThrough: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
  await assert.rejects(
    runtime.internalDeps.normalizeSourceEvents({
      dataset: 'fills',
      partitionKey: 'BTCUSDT',
      sourceEndpoint: '/fapi/v1/userTrades',
      rows: [{ id: 7, symbol: 'BTCUSDT', price: 0.1 }],
      observedThrough: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
  await assert.rejects(
    runtime.internalDeps.normalizeSourceEvents({
      dataset: 'fills',
      partitionKey: 'BTCUSDT',
      sourceEndpoint: '/fapi/v1/userTrades',
      rows: [{
        id: '7', time: '1800000000000', symbol: 'BTCUSDT', qty: '1', price: '1',
        commission: '0', commissionAsset: 'USDT', realizedPnl: '0',
        side: 'BUY', positionSide: 'BOTH',
      }],
      observedThrough: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
  await assert.rejects(
    runtime.internalDeps.normalizeSourceEvents({
      dataset: 'fills',
      partitionKey: 'BTCUSDT',
      sourceEndpoint: '/fapi/v1/userTrades',
      rows: [{
        id: '8', time: '1800000000001', symbol: 'BTCUSDT', pair: 'BTCUSDT',
        qty: '1', price: '1', quoteQty: '1', baseQty: '0', commission: '0',
        commissionAsset: 'BNB', realizedPnl: '0', marginAsset: 'USDC',
        side: 'BUY', positionSide: 'BOTH',
      }],
      observedThrough: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
});

test('account-wide force orders and positions retain USD-M product proof and symbol-qualified identity', async () => {
  const env = runtimeEnvironment();
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async () => { throw new Error('network not expected'); },
  });
  const [force] = await runtime.internalDeps.normalizeSourceEvents({
    dataset: 'force_orders',
    partitionKey: 'default',
    sourceEndpoint: '/fapi/v1/forceOrders',
    rows: [{
      orderId: '9007199254740993', symbol: 'BTCUSDT', pair: 'BTCUSDT',
      cumBase: '0', side: 'SELL', positionSide: 'LONG', status: 'FILLED',
      time: '1800000000000', updateTime: '1800000000001',
    }],
    observedThrough: '2027-01-15T08:00:00.000Z',
  });
  assert.equal(force.eventId, 'binance-usdm:force_orders:default:BTCUSDT:9007199254740993');
  assert.equal(force.payload.settlementAsset, 'USDT');

  const [position] = await runtime.internalDeps.normalizeSourceEvents({
    dataset: 'positions',
    partitionKey: 'default',
    sourceEndpoint: '/fapi/v3/positionRisk',
    rows: [{
      symbol: 'ETHUSDC', positionSide: 'BOTH', positionAmt: '1', entryPrice: '2500',
      breakEvenPrice: '2501', markPrice: '2510', unRealizedProfit: '10',
      liquidationPrice: '1000', leverage: '5', marginType: 'cross', notional: '2510',
      updateTime: '1800000000002',
    }],
    observedThrough: '2027-01-15T08:00:00.000Z',
  });
  assert.equal(position.eventId, 'binance-usdm:positions:default:ETHUSDC:BOTH:1800000000002');
  assert.equal(position.payload.settlementAsset, 'USDC');

  await assert.rejects(
    runtime.internalDeps.normalizeSourceEvents({
      dataset: 'force_orders',
      partitionKey: 'default',
      sourceEndpoint: '/fapi/v1/forceOrders',
      rows: [{
        orderId: '7', symbol: 'BTCUSD_PERP', pair: 'BTCUSD_PERP', cumBase: '0',
        side: 'SELL', positionSide: 'LONG', status: 'FILLED',
        time: '1800000000000', updateTime: '1800000000001',
      }],
      observedThrough: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error?.code === 'NORMALIZATION_CONFLICT',
  );
});

test('runtime derives a deterministic continuation for every full reviewed Binance page', async () => {
  const env = runtimeEnvironment();
  let rows = [];
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async () => new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const credentials = { apiKey: 'A'.repeat(64), apiSecret: 'b'.repeat(64) };
  const context = { signal: new AbortController().signal };
  for (const scenario of [
    { endpoint: 'userTrades', key: 'id', query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 }, next: { fromId: '1001' } },
    { endpoint: 'allOrders', key: 'orderId', query: { symbol: 'BTCUSDT', orderId: '1', limit: 1000 }, next: { orderId: '1001' } },
    { endpoint: 'allAlgoOrders', key: 'algoId', query: { symbol: 'BTCUSDT', algoId: '1', limit: 1000 }, next: { algoId: '1001' } },
    { endpoint: 'income', key: 'tranId', query: { page: '4', limit: 1000 }, next: { page: '5' } },
    { endpoint: 'forceOrders', key: 'time', query: { startTime: '1', limit: 1000 }, next: { startTime: '1001' } },
  ]) {
    rows = Array.from({ length: 1000 }, (_, index) => ({
      [scenario.key]: index + 1,
      symbol: 'BTCUSDT',
      time: index + 1,
    }));
    const page = await runtime.internalDeps.fetchBinancePage({
      endpoint: scenario.endpoint,
      query: scenario.query,
      credentials,
    }, context);
    assert.equal(page.rows.length, 1000);
    assert.equal(typeof page.rows[999][scenario.key], 'string');
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.nextCursor, scenario.next);
    assert.match(page.pageDigest, /^[0-9a-f]{64}$/);
  }
  rows = [{ id: 1, symbol: 'BTCUSDT', time: 1 }];
  const finalPage = await runtime.internalDeps.fetchBinancePage({
    endpoint: 'userTrades',
    query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 },
    credentials,
  }, context);
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.nextCursor, null);
});

test('runtime config is exact-host, independent-secret, and fail-closed', () => {
  const valid = runtimeEnvironment();
  const bytes = valid.RV_BETA_CREDENTIAL_KEK_V1;
  const config = readRuntimeConfig((key) => valid[key]);
  assert.equal(config.allowedOrigin, valid.APP_ORIGIN);
  assert.notDeepEqual(config.credentialKek, config.scopeHmacKey);
  assert.equal(config.syncCronToken, valid.RV_BETA_SYNC_CRON_TOKEN);
  assert.equal(config.archiveCronToken, valid.RV_BETA_ARCHIVE_CRON_TOKEN);
  assert.notEqual(config.syncCronToken, config.archiveCronToken);
  for (const mutation of [
    { APP_ORIGIN: 'https://evil.example' },
    { SUPABASE_URL: 'http://example.supabase.co' },
    { RV_BETA_SCOPE_HMAC_V1: bytes },
    { RV_BETA_SYNC_CRON_TOKEN: '' },
    { RV_BETA_ARCHIVE_CRON_TOKEN: '' },
    { RV_BETA_ARCHIVE_CRON_TOKEN: valid.RV_BETA_SYNC_CRON_TOKEN },
  ]) {
    const bad = { ...valid, ...mutation };
    assert.equal(readRuntimeConfig((key) => bad[key]), null);
  }
});

test('runtime public data/review adapters use narrow RPCs and destructive aliases delegate to the OTP orchestrator', async () => {
  const env = runtimeEnvironment();
  const config = readRuntimeConfig((key) => env[key]);
  const calls = [];
  const responses = {
    rv2_get_current_dataset: { format: 'rv-cloud-dataset/1', generation: 0 },
    rv2_get_trades: { format: 'rv-cloud-trades/1', generation: 0, asOf: '2027-01-15T08:00:00.000Z', trades: [] },
    rv2_get_reviews: { format: 'rv-cloud-reviews/1', reviews: [] },
    rv2_upsert_review: [{ trade_id: 't_0123456789abcdef', version: 2, updated_at: '2027-01-15T08:00:00.000Z' }],
    rv2_upsert_action: [{ resource_id: JOB, version: 2, updated_at: '2027-01-15T08:00:00.000Z' }],
    rv2_upsert_journal: [{ resource_id: '2027-01-15', version: 2, updated_at: '2027-01-15T08:00:00.000Z' }],
    rv2_upsert_risk_rule: [{ resource_id: JOB, version: 2, updated_at: '2027-01-15T08:00:00.000Z' }],
    rv2_upsert_report: [{ resource_id: JOB, version: 1, updated_at: '2027-01-15T08:00:00.000Z' }],
  };
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === '/functions/v1/delete-account') {
      const protocol = JSON.parse(init.body);
      return new Response(JSON.stringify({
        protocolVersion: 3,
        action: protocol.action,
        state: 'completed',
        receiptId: JOB,
        expiresAt: '2027-02-14T08:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const rpc = url.pathname.split('/').at(-1);
    return new Response(JSON.stringify(responses[rpc]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const runtime = createRuntimeDependencies(config, {
    fetch,
  });
  const context = { signal: new AbortController().signal };
  const token = `user.${'u'.repeat(64)}.signature`;
  const scoped = { token, tenantId: TENANT, connectionId: CONNECTION };
  await runtime.publicDeps.getCurrentDataset(scoped, context);
  await runtime.publicDeps.getTrades(scoped, context);
  await runtime.publicDeps.getReviews(scoped, context);
  await runtime.publicDeps.upsertReview({
    ...scoped, tradeId: 't_0123456789abcdef', expectedVersion: 1, idempotencyKey: JOB,
    payload: { saw: '', happened: '', lesson: 'wait', grade: 'A', reviewed: true },
  }, context);
  await runtime.publicDeps.upsertAction({
    ...scoped, actionId: JOB, reviewId: JOB, tradeId: 't_0123456789abcdef',
    status: 'DONE', expectedVersion: 1, idempotencyKey: JOB,
    payload: { text: 'wait', experiment: null },
  }, context);
  await runtime.publicDeps.upsertJournal({
    ...scoped, day: '2027-01-15', expectedVersion: 1, idempotencyKey: JOB,
    payload: { note: 'wait', emotion: 'calm' },
  }, context);
  await runtime.publicDeps.upsertRiskRule({
    ...scoped, ruleId: JOB, status: 'ACTIVE', expectedVersion: 1, idempotencyKey: JOB,
    payload: { text: 'one R', active: true },
  }, context);
  await runtime.publicDeps.upsertReport({
    ...scoped, reportType: 'WEEKLY', periodStart: '2027-01-11', periodEnd: '2027-01-17',
    sourceGeneration: 3, expectedVersion: 0, idempotencyKey: JOB, payload: { tradeCount: 1 },
  }, context);
  const deletionProtocol = {
    protocolVersion: 3,
    action: 'clear_business_data',
    confirmation: 'DELETE_MY_REVIEW_DATA',
    requestId: JOB,
    recoverySecret: `rvr1_${'r'.repeat(43)}`,
  };
  await runtime.publicDeps.executeDestructiveOperation({ token, protocol: deletionProtocol }, context);

  assert.deepEqual(calls.slice(0, 8).map((entry) => entry.url.pathname.split('/').at(-1)), [
    'rv2_get_current_dataset', 'rv2_get_trades', 'rv2_get_reviews', 'rv2_upsert_review',
    'rv2_upsert_action', 'rv2_upsert_journal', 'rv2_upsert_risk_rule', 'rv2_upsert_report',
  ]);
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    p_connection_id: CONNECTION,
    p_trade_id: 't_0123456789abcdef',
    p_expected_version: 1,
    p_idempotency_key: JOB,
    p_payload: { saw: '', happened: '', lesson: 'wait', grade: 'A', reviewed: true },
  });
  assert.deepEqual(JSON.parse(calls[4].init.body), {
    p_connection_id: CONNECTION, p_action_id: JOB, p_review_id: JOB,
    p_trade_id: 't_0123456789abcdef', p_status: 'DONE', p_expected_version: 1,
    p_idempotency_key: JOB, p_payload: { text: 'wait', experiment: null },
  });
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[8].url.pathname, '/functions/v1/delete-account');
  assert.equal(calls[8].init.method, 'POST');
  assert.equal(calls[8].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[8].init.headers.apikey, env.SUPABASE_ANON_KEY);
  assert.equal(calls[8].init.headers.Origin, env.APP_ORIGIN);
  assert.deepEqual(JSON.parse(calls[8].init.body), deletionProtocol);
});

test('manual sync reaches SQL as positions/default and fills/default is impossible', async () => {
  const env = runtimeEnvironment();
  const calls = [];
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify([{ job_id: JOB, status: 'QUEUED' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const context = { signal: new AbortController().signal };
  const token = `user.${'u'.repeat(64)}.signature`;
  await runtime.publicDeps.enqueueSync({
    token,
    connectionId: CONNECTION,
    dataset: 'positions',
    partitionKey: 'default',
    idempotencyKey: JOB,
  }, context);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    p_connection_id: CONNECTION,
    p_dataset: 'positions',
    p_partition_key: 'default',
    p_idempotency_key: JOB,
  });
  await assert.rejects(
    runtime.publicDeps.enqueueSync({
      token,
      connectionId: CONNECTION,
      dataset: 'trades',
      partitionKey: 'default',
      idempotencyKey: JOB,
    }, context),
    (error) => error?.code === 'REQUEST_INVALID',
  );
  assert.equal(calls.length, 1);
});

test('runtime REST adapter preserves browser JWT context and maps control-plane statuses', async () => {
  const env = runtimeEnvironment();
  const config = readRuntimeConfig((key) => env[key]);
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({
      format: 'rv-binance-connections/1',
      connections: [{
        connectionId: CONNECTION,
        status: 'RATE_LIMITED',
        credentialVersion: 2,
        lastTrustedAt: null,
        nextDueAt: null,
        permissionState: 'READ_ONLY_VERIFIED',
        permissionEvidence: null,
        lastErrorCode: 'RATE_LIMITED',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const runtime = createRuntimeDependencies(config, {
    fetch,
  });
  assert.match(await runtime.publicDeps.permissionEvidenceDigest({
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
  }, { signal: new AbortController().signal }), /^[0-9a-f]{64}$/);
  const token = `user.${'u'.repeat(64)}.signature`;
  const result = await runtime.publicDeps.listConnections(token, { signal: new AbortController().signal });
  assert.equal(result.connections[0].status, 'STALE');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].input).pathname, '/rest/v1/rpc/rv2_list_connections');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers.apikey, env.SUPABASE_ANON_KEY);
  assert.notEqual(calls[0].init.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
});

test('credential write RPC binds stable connection AAD, consent, lowercase provider, and service role', async () => {
  const env = runtimeEnvironment();
  const config = readRuntimeConfig((key) => env[key]);
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify([{
      connection_id: CONNECTION,
      credential_version: 1,
      status: 'ACTIVE',
      permission_state: 'READ_ONLY_VERIFIED',
      permission_evidence: null,
      verified_at: '2027-01-15T08:00:00.000Z',
      created: true,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const runtime = createRuntimeDependencies(config, {
    fetch,
  });
  await runtime.publicDeps.createOrRotateConnection({
    subject: REQUESTED_BY,
    tenantId: TENANT,
    connectionId: CONNECTION,
    providerScopeHash: 'a'.repeat(64),
    permissionState: 'READ_ONLY_VERIFIED',
    permissionEvidence: { evidenceVersion: 'rv-binance-permission/1' },
    consentVersion: 'rv-binance-beta-consent/1',
    envelopeCiphertext: 'ciphertext',
    envelopeNonce: 'nonce',
    envelopeKeyRef: 'RV_BETA_CREDENTIAL_KEK_V1.wrap.wrapped',
    envelopeSha256: 'e'.repeat(64),
    expectedCredentialVersion: 0,
    idempotencyKey: JOB,
    requestFingerprint: 'f'.repeat(64),
  }, { signal: new AbortController().signal });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.p_connection_id, CONNECTION);
  assert.equal(body.p_provider, 'binance');
  assert.equal(body.p_consent_version, 'rv-binance-beta-consent/1');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.equal(calls[0].init.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
});

test('post-commit outbox adapter preserves UUID attempt binding across claim, complete, and fail RPCs', async () => {
  const env = runtimeEnvironment();
  const config = readRuntimeConfig((key) => env[key]);
  const workId = 'cb393502-fbec-4cb0-8113-96c83564f435';
  const attemptId = '0202c8e7-e7ab-4cd8-9cac-da84a8ef92da';
  const leaseToken = 'ec14da0a-f302-48db-b789-b8031c18559d';
  const inputDigest = 'f'.repeat(64);
  const calls = [];
  const runtime = createRuntimeDependencies(config, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const rpc = url.pathname.split('/').at(-1);
      calls.push({ rpc, body: JSON.parse(init.body), headers: init.headers });
      const value = rpc === 'rv2_service_claim_post_commit_work'
        ? [{
          work_id: workId,
          job_id: JOB,
          connection_id: CONNECTION,
          credential_version: 2,
          attempt_id: attemptId,
          lease_token: leaseToken,
          work_kind: 'SYNC_EFFECTS',
          input_digest: inputDigest,
        }]
        : [{ accepted: true, replayed: false, status: rpc.includes('complete') ? 'COMPLETED' : 'QUEUED' }];
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const context = { signal: new AbortController().signal };
  const claim = await runtime.internalDeps.claimPostCommitWork({
    workerSubject: REQUESTED_BY,
    jobId: JOB,
  }, context);
  assert.equal(claim.attemptId, attemptId);
  const binding = {
    workerSubject: REQUESTED_BY,
    workId,
    jobId: JOB,
    connectionId: CONNECTION,
    credentialVersion: 2,
    attemptId,
    leaseToken,
    inputDigest,
  };
  await runtime.internalDeps.completePostCommitWork(binding, context);
  await runtime.internalDeps.failPostCommitWork({
    ...binding,
    errorCode: 'UPSTREAM_UNAVAILABLE',
    retryable: true,
    retryAfterSeconds: 7,
  }, context);
  assert.deepEqual(calls.map(({ rpc }) => rpc), [
    'rv2_service_claim_post_commit_work',
    'rv2_service_complete_post_commit_work',
    'rv2_service_fail_post_commit_work',
  ]);
  assert.deepEqual(calls[0].body, {
    p_worker_subject: REQUESTED_BY,
    p_job_id: JOB,
    p_lease_seconds: 120,
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.body.p_attempt_id, attemptId);
    assert.equal(call.body.p_input_digest, inputDigest);
    assert.equal(call.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  }
});

test('every successful source page emits an exact durable effect, including an explicit no-op', async () => {
  const env = runtimeEnvironment();
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async () => { throw new Error('network not expected'); },
  });
  assert.deepEqual(await runtime.internalDeps.buildPostCommitEffect({
    dataset: 'balances',
    events: [{ payload: { asset: 'USDT', balance: '1' } }],
  }), {
    protocol: 'rv-sync-post-commit/1',
    symbols: [],
    ledgerShadow: null,
  });
});

test('index is a deployable Deno entrypoint and never embeds a credential or arbitrary proxy', async () => {
  const text = await readFile(new URL('../supabase/functions/binance-beta/index.ts', import.meta.url), 'utf8');
  const runtimeText = await readFile(new URL('../supabase/functions/binance-beta/runtime.mjs', import.meta.url), 'utf8');
  assert.match(text, /Deno\.serve\(/);
  assert.match(text, /createBinanceBetaHandler/);
  assert.match(text, /createBinanceBetaInternalHandler/);
  assert.match(text, /readRuntimeConfig/);
  assert.match(text, /binance-beta\/internal\/v1\/sync\/cron/);
  assert.match(text, /binance-beta\/internal\/v1\/archive\/cron/);
  assert.doesNotMatch(text, /oidc\/exchange|sync\/run|archive\/run|npm:jose|workerGrant/i);
  assert.doesNotMatch(runtimeText, /GITHUB_OIDC|WORKER_GRANT|RV_BETA_GITHUB_|RV_BETA_CRON_TOKEN/);
  assert.doesNotMatch(text, /https:\/\/evil|apiSecret\s*[:=]\s*['"][^'"]+/i);
});
