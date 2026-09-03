import assert from 'node:assert/strict';
import test from 'node:test';
import * as edge from '../supabase/functions/binance-beta/handler.mjs';

const ORIGIN = 'https://binance-futures-review-web.vercel.app';
const SUBJECT = '0b344f98-1ced-48b1-9542-9399b937c3f9';
const OTHER_SUBJECT = '8dd6b13b-0aeb-44bb-b155-2800992d5d50';
const TENANT = 'c0bd919c-9807-4cab-9744-a0b9085c9257';
const CONNECTION = 'dd6c2ffd-55a8-402f-87e2-cedfb409a383';
const JOB = '519023d1-568f-4e3a-9c3c-149725089af4';
const RECEIPT = '944d2f27-b832-4897-a2e1-54be196176c4';
const BUSINESS_RECEIPT = '2c7ea03e-58a1-43ce-b268-146ca62f5f42';
const ACCOUNT_RECEIPT = '9aa5944c-64a8-4aad-afc8-cc852ed69687';
const IDEMPOTENCY = 'e498c43e-fb00-4410-8f7a-1c32cb8fd2d3';
const TRADE_ID = 't_0123456789abcdef';
const REVIEW_ID = '2c158906-4daf-4a03-aec5-2bc3e59370f4';
const ACTION_ID = '30cedf24-38ed-4ee8-bb39-e69be51bb753';
const RULE_ID = '4adb8ca4-b99f-4d7e-ad64-3ca8cf82a523';
const REPORT_ID = '7cb319ff-71d2-41d4-bb5c-3922ab65c73b';
const API_KEY = 'A'.repeat(64);
const API_SECRET = 'b'.repeat(64);
const CHECKED_AT = '2026-08-31T02:00:00.000Z';
const DIGEST = 'd'.repeat(64);
const PURGE_AFTER = '2026-09-30T02:05:00.000Z';
const RECOVERY_SECRET = `rvr1_${'r'.repeat(43)}`;

function jwtFor(subject = SUBJECT) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject })).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(64)}`;
}

const TOKEN = jwtFor();

const PERMISSION_CONCLUSION = Object.freeze({
  readOnly: true,
  tradeDisabled: true,
  withdrawDisabled: true,
  internalTransferDisabled: true,
  universalTransferDisabled: true,
});

const PERMISSION_EVIDENCE = Object.freeze({
  evidenceVersion: 'rv-binance-permission/1',
  provider: 'binance-usdm',
  ...PERMISSION_CONCLUSION,
  checkedAt: CHECKED_AT,
  evidenceDigest: DIGEST,
});

function safeConnection(overrides = {}) {
  return {
    connectionId: CONNECTION,
    status: 'ACTIVE',
    credentialVersion: 1,
    lastTrustedAt: CHECKED_AT,
    nextDueAt: null,
    permissionState: 'READ_ONLY_VERIFIED',
    permissionEvidence: PERMISSION_EVIDENCE,
    lastErrorCode: null,
    ...overrides,
  };
}

function memoryDependencies(overrides = {}) {
  const calls = {
    verify: 0,
    tenant: 0,
    list: 0,
    probe: 0,
    encrypt: [],
    save: [],
    enqueue: [],
    disconnect: [],
    status: [],
    dataset: [],
    trades: [],
    reviews: [],
    reviewWrites: [],
    actionWrites: [],
    journalWrites: [],
    riskWrites: [],
    reportWrites: [],
    destructive: [],
  };
  const connections = overrides.connections ?? [safeConnection()];
  const deps = {
    deadlineMs: 1_000,
    nowIso: () => CHECKED_AT,
    verifyUser: async (_token) => {
      calls.verify += 1;
      return { id: SUBJECT, is_anonymous: false };
    },
    getTenantContext: async (_token) => {
      calls.tenant += 1;
      return { tenantId: TENANT, memberRole: 'owner', membershipVersion: 4 };
    },
    deriveConnectionId: async () => CONNECTION,
    probeReadOnlyPermissions: async () => {
      calls.probe += 1;
      return PERMISSION_CONCLUSION;
    },
    permissionEvidenceDigest: async () => DIGEST,
    providerScopeHash: async () => 'a'.repeat(64),
    credentialRequestFingerprint: async () => 'f'.repeat(64),
    encryptCredentialEnvelope: async (input) => {
      calls.encrypt.push(input);
      return {
        version: 1,
        credentialVersion: input.credentialVersion,
        nonce: 'nonce',
        ciphertext: 'encrypted-credentials',
        keyRef: 'RV_BETA_CREDENTIAL_KEK_V1.wrap.wrapped',
        sha256: 'e'.repeat(64),
      };
    },
    createOrRotateConnection: async (input) => {
      calls.save.push(input);
      return {
        connectionId: input.connectionId,
        credentialVersion: input.expectedCredentialVersion + 1,
        status: 'ACTIVE',
        verifiedAt: CHECKED_AT,
        created: input.expectedCredentialVersion === 0,
      };
    },
    listConnections: async () => {
      calls.list += 1;
      return { format: 'rv-binance-connections/1', connections };
    },
    getDatasetStatus: async (input) => {
      calls.status.push(input);
      return {
        state: 'PARTIAL',
        attemptedThrough: CHECKED_AT,
        fetchedThrough: CHECKED_AT,
        committedThrough: CHECKED_AT,
        trustedThrough: null,
        currentGeneration: 3,
        gaps: [{ code: 'RETENTION_GAP', from: null, to: CHECKED_AT }],
      };
    },
    enqueueSync: async (input) => {
      calls.enqueue.push(input);
      return { jobId: JOB, status: 'QUEUED' };
    },
    disconnectConnection: async (input) => {
      calls.disconnect.push(input);
      return { connectionId: CONNECTION, status: 'DISCONNECTED', receiptId: RECEIPT };
    },
    getCurrentDataset: async (input) => {
      calls.dataset.push(input);
      return {
        format: 'rv-cloud-dataset/1',
        generation: 3,
        asOf: CHECKED_AT,
        coverage: {},
        reconciliation: {},
        capabilities: {},
        trades: [{ id: '7', symbol: 'BTCUSDT' }],
        tradeModels: [],
        reviews: [],
        actions: [],
        journal: [],
        risk: [],
        reports: [],
        income: [{ privateServerOnly: true }],
      };
    },
    getTrades: async (input) => {
      calls.trades.push(input);
      return {
        format: 'rv-cloud-trades/1',
        generation: 3,
        asOf: CHECKED_AT,
        trades: [{ id: '7', symbol: 'BTCUSDT' }],
      };
    },
    getReviews: async (input) => {
      calls.reviews.push(input);
      return {
        format: 'rv-cloud-reviews/1',
        reviews: [{ tradeId: TRADE_ID, version: 1, updatedAt: CHECKED_AT, payload: { lesson: 'wait' } }],
      };
    },
    upsertReview: async (input) => {
      calls.reviewWrites.push(input);
      return { tradeId: input.tradeId, version: input.expectedVersion + 1, updatedAt: CHECKED_AT };
    },
    upsertAction: async (input) => {
      calls.actionWrites.push(input);
      return { resourceId: input.actionId, version: input.expectedVersion + 1, updatedAt: CHECKED_AT };
    },
    upsertJournal: async (input) => {
      calls.journalWrites.push(input);
      return { resourceId: input.day, version: input.expectedVersion + 1, updatedAt: CHECKED_AT };
    },
    upsertRiskRule: async (input) => {
      calls.riskWrites.push(input);
      return { resourceId: input.ruleId, version: input.expectedVersion + 1, updatedAt: CHECKED_AT };
    },
    upsertReport: async (input) => {
      calls.reportWrites.push(input);
      return { resourceId: REPORT_ID, version: input.expectedVersion + 1, updatedAt: CHECKED_AT };
    },
    executeDestructiveOperation: async (input) => {
      calls.destructive.push(input);
      return {
        protocolVersion: 3,
        action: input.protocol.action,
        state: 'completed',
        receiptId: input.protocol.action === 'delete_account' ? ACCOUNT_RECEIPT : BUSINESS_RECEIPT,
        expiresAt: PURGE_AFTER,
      };
    },
    ...overrides,
  };
  delete deps.connections;
  return { deps, calls };
}

function request(path, {
  method = 'GET', body, origin = ORIGIN, token = TOKEN, contentType = 'application/json', headers: extraHeaders = {},
} = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = contentType;
  Object.assign(headers, extraHeaders);
  return new Request(`https://edge.example.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

function credentialBody(overrides = {}) {
  return {
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    consentVersion: 'rv-binance-beta-consent/1',
    idempotencyKey: IDEMPOTENCY,
    ...overrides,
  };
}

test('public handler hard-codes the canonical production Origin and rejects foreign requests before Auth', async () => {
  assert.equal(edge.CANONICAL_ORIGIN, ORIGIN);
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const options = await handler(request('/v1/connections', { method: 'OPTIONS', token: null }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PUT, DELETE, OPTIONS');
  assert.match(options.headers.get('Access-Control-Allow-Headers') ?? '', /x-rv-connection-id/i);
  assert.match(options.headers.get('Access-Control-Allow-Methods') ?? '', /PUT/);

  const foreign = await handler(request('/v1/connections', {
    method: 'GET',
    origin: 'https://evil.example.com',
  }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(memory.calls.verify, 0);
  assert.throws(
    () => edge.createBinanceBetaHandler({ ...memory.deps, allowedOrigin: 'https://evil.example.com' }),
    /canonical origin/i,
  );
});

test('unauthenticated mutations are rejected before any request body is read', async () => {
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  for (const [path, method] of [
    ['/v1/connections', 'POST'],
    [`/v1/reviews/${TRADE_ID}`, 'PUT'],
    [`/v1/actions/${ACTION_ID}`, 'PUT'],
    ['/v1/account', 'DELETE'],
  ]) {
    let readerCalls = 0;
    const signal = new AbortController().signal;
    const response = await handler({
      url: `https://edge.example.com${path}`,
      method,
      signal,
      headers: new Headers({
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'Content-Length': String(256 * 1024),
        ...(path.includes('/reviews/') || path.includes('/actions/')
          ? { 'x-rv-connection-id': CONNECTION }
          : {}),
      }),
      body: {
        getReader() {
          readerCalls += 1;
          throw new Error('unauthenticated body must not be read');
        },
      },
    });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(readerCalls, 0, `${method} ${path}`);
  }
  assert.equal(memory.calls.verify, 0);
  assert.equal(memory.calls.tenant, 0);
  assert.equal(memory.calls.save.length, 0);
  assert.equal(memory.calls.reviewWrites.length, 0);
  assert.equal(memory.calls.actionWrites.length, 0);
  assert.equal(memory.calls.destructive.length, 0);
});

test('dataset, trades, and reviews require a tenant-scoped connection header and expose bounded projections', async () => {
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);

  for (const path of ['/v1/datasets/current', '/v1/trades', '/v1/reviews']) {
    const missing = await handler(request(path));
    assert.equal(missing.status, 400);
  }
  assert.equal(memory.calls.verify, 0);

  const headers = { 'x-rv-connection-id': CONNECTION };
  const dataset = await handler(request('/v1/datasets/current', { headers }));
  assert.equal(dataset.status, 200);
  const datasetBody = await bodyOf(dataset);
  assert.deepEqual(datasetBody, {
    format: 'rv-cloud-dataset/1',
    generation: 3,
    asOf: CHECKED_AT,
    coverage: {},
    reconciliation: {},
    capabilities: {},
    trades: [{ id: '7', symbol: 'BTCUSDT' }],
    tradeModels: [],
    reviews: [],
    actions: [],
    journal: [],
    risk: [],
    reports: [],
    income: [{ privateServerOnly: true }],
  });
  assert.equal(Object.hasOwn(datasetBody, 'income'), true);

  const trades = await handler(request('/v1/trades', { headers }));
  assert.equal(trades.status, 200);
  assert.equal((await bodyOf(trades)).format, 'rv-cloud-trades/1');
  const reviews = await handler(request('/v1/reviews', { headers }));
  assert.equal(reviews.status, 200);
  assert.equal((await bodyOf(reviews)).format, 'rv-cloud-reviews/1');

  for (const call of [memory.calls.dataset[0], memory.calls.trades[0], memory.calls.reviews[0]]) {
    assert.equal(call.token, TOKEN);
    assert.equal(call.connectionId, CONNECTION);
    assert.equal(call.tenantId, TENANT);
  }
  assert.equal(memory.calls.tenant, 3);
  assert.equal(memory.calls.list, 3);
});

test('review PUT requires exact optimistic concurrency and idempotency fields', async () => {
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const headers = { 'x-rv-connection-id': CONNECTION };
  for (const body of [
    { expectedVersion: 0, idempotencyKey: IDEMPOTENCY, payload: {}, tenantId: TENANT },
    { expectedVersion: -1, idempotencyKey: IDEMPOTENCY, payload: {} },
    { expectedVersion: 0, idempotencyKey: 'bad', payload: {} },
    { expectedVersion: 0, idempotencyKey: IDEMPOTENCY, payload: { apiSecret: 'never' } },
  ]) {
    const response = await handler(request(`/v1/reviews/${TRADE_ID}`, { method: 'PUT', body, headers }));
    assert.equal(response.status, 400);
  }
  assert.equal(memory.calls.reviewWrites.length, 0);

  const reviewPayload = {
    saw: 'signal', happened: 'waited', lesson: 'wait', grade: 'A', reviewed: true,
  };
  const response = await handler(request(`/v1/reviews/${TRADE_ID}`, {
    method: 'PUT', headers, body: { expectedVersion: 0, idempotencyKey: IDEMPOTENCY, payload: reviewPayload },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), {
    format: 'rv-cloud-review/1', tradeId: TRADE_ID, version: 1, updatedAt: CHECKED_AT,
  });
  assert.deepEqual(memory.calls.reviewWrites, [{
    token: TOKEN,
    tenantId: TENANT,
    connectionId: CONNECTION,
    tradeId: TRADE_ID,
    expectedVersion: 0,
    idempotencyKey: IDEMPOTENCY,
    payload: reviewPayload,
  }]);
});

test('action, journal, risk, and report writes use exact tenant-scoped CAS contracts', async () => {
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const headers = { 'x-rv-connection-id': CONNECTION };
  const mutation = async (path, body) => {
    const response = await handler(request(path, { method: 'PUT', headers, body }));
    assert.equal(response.status, 200);
    return bodyOf(response);
  };
  assert.deepEqual(await mutation(`/v1/actions/${ACTION_ID}`, {
    expectedVersion: 3,
    idempotencyKey: IDEMPOTENCY,
    reviewId: REVIEW_ID,
    tradeId: TRADE_ID,
    status: 'DONE',
    payload: { text: 'wait for confirmation', experiment: null },
  }), {
    format: 'rv-cloud-mutation/1', resource: 'action', resourceId: ACTION_ID,
    version: 4, updatedAt: CHECKED_AT,
  });
  assert.deepEqual(await mutation('/v1/journal/2026-08-31', {
    expectedVersion: 1,
    idempotencyKey: JOB,
    payload: { note: 'followed plan', emotion: 'calm' },
  }), {
    format: 'rv-cloud-mutation/1', resource: 'journal', resourceId: '2026-08-31',
    version: 2, updatedAt: CHECKED_AT,
  });
  assert.deepEqual(await mutation(`/v1/risk/${RULE_ID}`, {
    expectedVersion: 2,
    idempotencyKey: RECEIPT,
    status: 'PAUSED',
    payload: { text: 'maximum one R', active: false },
  }), {
    format: 'rv-cloud-mutation/1', resource: 'risk', resourceId: RULE_ID,
    version: 3, updatedAt: CHECKED_AT,
  });
  assert.deepEqual(await mutation('/v1/reports/current', {
    expectedVersion: 0,
    idempotencyKey: BUSINESS_RECEIPT,
    reportType: 'WEEKLY',
    periodStart: '2026-08-24',
    periodEnd: '2026-08-30',
    sourceGeneration: 3,
    payload: { tradeCount: 2, lessons: ['wait'] },
  }), {
    format: 'rv-cloud-mutation/1', resource: 'report', resourceId: REPORT_ID,
    version: 1, updatedAt: CHECKED_AT,
  });

  assert.deepEqual(memory.calls.actionWrites[0], {
    token: TOKEN, tenantId: TENANT, connectionId: CONNECTION,
    actionId: ACTION_ID, reviewId: REVIEW_ID, tradeId: TRADE_ID,
    expectedVersion: 3, idempotencyKey: IDEMPOTENCY, status: 'DONE',
    payload: { text: 'wait for confirmation', experiment: null },
  });
  assert.equal(memory.calls.journalWrites[0].day, '2026-08-31');
  assert.equal(memory.calls.riskWrites[0].ruleId, RULE_ID);
  assert.equal(memory.calls.reportWrites[0].sourceGeneration, 3);

  for (const [path, body] of [
    [`/v1/actions/${ACTION_ID}`, {
      expectedVersion: 3, idempotencyKey: IDEMPOTENCY, reviewId: REVIEW_ID,
      tradeId: TRADE_ID, status: 'DONE', payload: { text: 'x', apiKey: 'never' },
    }],
    ['/v1/journal/2026-02-30', {
      expectedVersion: 0, idempotencyKey: IDEMPOTENCY, payload: { note: 'x', emotion: '' },
    }],
    [`/v1/risk/${RULE_ID}`, {
      expectedVersion: 0, idempotencyKey: IDEMPOTENCY, status: 'PAUSED',
      payload: { text: 'x', active: true },
    }],
    ['/v1/reports/current', {
      expectedVersion: 0, idempotencyKey: IDEMPOTENCY, reportType: 'WEEKLY',
      periodStart: '2026-08-31', periodEnd: '2026-08-01', sourceGeneration: 3, payload: {},
    }],
  ]) {
    assert.equal((await handler(request(path, { method: 'PUT', headers, body }))).status, 400);
  }
  assert.equal(memory.calls.actionWrites.length, 1);
  assert.equal(memory.calls.journalWrites.length, 1);
  assert.equal(memory.calls.riskWrites.length, 1);
  assert.equal(memory.calls.reportWrites.length, 1);
});

test('business and account deletion are separate owner-only fail-closed operations', async () => {
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const business = await handler(request('/v1/business-data', {
    method: 'DELETE',
    body: {
      protocolVersion: 3,
      action: 'clear_business_data',
      confirmation: 'DELETE_MY_REVIEW_DATA',
      requestId: IDEMPOTENCY,
      recoverySecret: RECOVERY_SECRET,
    },
  }));
  assert.equal(business.status, 200);
  assert.deepEqual(await bodyOf(business), {
    protocolVersion: 3,
    action: 'clear_business_data',
    state: 'completed',
    receiptId: BUSINESS_RECEIPT,
    expiresAt: PURGE_AFTER,
  });

  const account = await handler(request('/v1/account', {
    method: 'DELETE',
    body: {
      protocolVersion: 3,
      action: 'delete_account',
      confirmation: 'DELETE_MY_ACCOUNT',
      requestId: IDEMPOTENCY,
      recoverySecret: RECOVERY_SECRET,
    },
  }));
  assert.equal(account.status, 200);
  assert.deepEqual(await bodyOf(account), {
    protocolVersion: 3,
    action: 'delete_account',
    state: 'completed',
    receiptId: ACCOUNT_RECEIPT,
    expiresAt: PURGE_AFTER,
  });
  assert.deepEqual(memory.calls.destructive, [
    {
      token: TOKEN,
      protocol: {
        protocolVersion: 3,
        action: 'clear_business_data',
        confirmation: 'DELETE_MY_REVIEW_DATA',
        requestId: IDEMPOTENCY,
        recoverySecret: RECOVERY_SECRET,
      },
    },
    {
      token: TOKEN,
      protocol: {
        protocolVersion: 3,
        action: 'delete_account',
        confirmation: 'DELETE_MY_ACCOUNT',
        requestId: IDEMPOTENCY,
        recoverySecret: RECOVERY_SECRET,
      },
    },
  ]);

  const unsafe = memoryDependencies({
    executeDestructiveOperation: async () => {
      const error = new Error('recent OTP required');
      error.code = 'REAUTH_REQUIRED';
      throw error;
    },
  });
  const denied = await edge.createBinanceBetaHandler(unsafe.deps)(request('/v1/business-data', {
    method: 'DELETE', body: {
      protocolVersion: 3,
      action: 'clear_business_data',
      confirmation: 'DELETE_MY_REVIEW_DATA',
      requestId: IDEMPOTENCY,
      recoverySecret: RECOVERY_SECRET,
    },
  }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await bodyOf(denied), { error: 'recent_reauthentication_required' });

  const member = memoryDependencies({
    getTenantContext: async () => ({ tenantId: TENANT, memberRole: 'member', membershipVersion: 4 }),
  });
  assert.equal((await edge.createBinanceBetaHandler(member.deps)(request('/v1/account', {
    method: 'DELETE', body: {
      protocolVersion: 3,
      action: 'delete_account',
      confirmation: 'DELETE_MY_ACCOUNT',
      requestId: IDEMPOTENCY,
      recoverySecret: RECOVERY_SECRET,
    },
  }))).status, 401);
  assert.equal(member.calls.destructive.length, 0);
});

test('create accepts only the exact credential body, derives identity from verified JWT sub, and never echoes secrets', async () => {
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const badBodies = [
    { ...credentialBody(), user_id: SUBJECT },
    { ...credentialBody(), tenant_id: TENANT },
    { ...credentialBody(), unexpected: true },
    { ...credentialBody(), consentVersion: 'old' },
    { ...credentialBody(), idempotencyKey: 'not-a-uuid' },
    { ...credentialBody(), apiKey: '' },
  ];
  for (const badBody of badBodies) {
    const response = await handler(request('/v1/connections', { method: 'POST', body: badBody }));
    assert.equal(response.status, 400);
  }
  assert.equal(memory.calls.verify, badBodies.length);
  assert.equal(memory.calls.tenant, badBodies.length);
  assert.equal(memory.calls.encrypt.length, 0);

  const response = await handler(request('/functions/v1/binance-beta/v1/connections', {
    method: 'POST',
    body: credentialBody(),
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await bodyOf(response), {
    connectionId: CONNECTION,
    status: 'ACTIVE',
    credentialVersion: 1,
    permissionEvidence: PERMISSION_EVIDENCE,
  });
  assert.equal(memory.calls.verify, badBodies.length + 1);
  assert.equal(memory.calls.tenant, badBodies.length + 1);
  assert.equal(memory.calls.probe, 1);
  assert.equal(memory.calls.save.length, 1);
  assert.equal(memory.calls.save[0].subject, SUBJECT);
  assert.equal(memory.calls.save[0].tenantId, TENANT);
  assert.equal(memory.calls.save[0].expectedCredentialVersion, 0);
  assert.equal(memory.calls.save[0].idempotencyKey, IDEMPOTENCY);
  assert.equal(memory.calls.save[0].permissionState, 'READ_ONLY_VERIFIED');
  assert.deepEqual(memory.calls.save[0].permissionEvidence, PERMISSION_EVIDENCE);
  assert.doesNotMatch(JSON.stringify(memory.calls.save[0]), new RegExp(`${API_KEY}|${API_SECRET}`));
  assert.doesNotMatch(JSON.stringify(await bodyOf(new Response(JSON.stringify({ ok: true })))), /apiKey|apiSecret/);
});

test('JWT sub must match /auth/v1/user and no caller-supplied identity can reach service dependencies', async () => {
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  const memory = memoryDependencies({ verifyUser: async () => ({ id: OTHER_SUBJECT, is_anonymous: false }) });
  const response = await edge.createBinanceBetaHandler(memory.deps)(request('/v1/connections', {
    method: 'POST',
    body: credentialBody(),
  }));
  assert.equal(response.status, 401);
  assert.equal(memory.calls.save.length, 0);
  assert.equal(memory.calls.encrypt.length, 0);
});

test('list and status normalize only bounded safe fields and unknown connections are 404', async () => {
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  const connectionWithPrivateJunk = safeConnection({
    envelopeCiphertext: API_SECRET,
    tenantId: TENANT,
    requestedBy: SUBJECT,
  });
  const memory = memoryDependencies({ connections: [connectionWithPrivateJunk] });
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const listResponse = await handler(request('/v1/connections'));
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await bodyOf(listResponse), {
    format: 'rv-binance-connections/1',
    connections: [safeConnection()],
  });
  const listText = JSON.stringify(await bodyOf(new Response(JSON.stringify({
    format: 'rv-binance-connections/1', connections: [safeConnection()],
  }))));
  assert.doesNotMatch(listText, new RegExp(`${API_SECRET}|${TENANT}|${SUBJECT}`));

  const statusResponse = await handler(request(`/v1/connections/${CONNECTION}/status`));
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await bodyOf(statusResponse), {
    ...safeConnection(),
    coverage: {
      state: 'PARTIAL',
      attemptedThrough: CHECKED_AT,
      fetchedThrough: CHECKED_AT,
      committedThrough: CHECKED_AT,
      trustedThrough: null,
      currentGeneration: 3,
      gaps: [{ code: 'RETENTION_GAP', from: null, to: CHECKED_AT }],
    },
  });
  const unknown = 'a0214041-e012-45b7-91f7-ae9cd0248ed6';
  assert.equal((await handler(request(`/v1/connections/${unknown}/status`))).status, 404);
});

test('rotate, sync, and disconnect use the current tenant-scoped row and exact CAS/idempotency inputs', async () => {
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  const memory = memoryDependencies();
  const handler = edge.createBinanceBetaHandler(memory.deps);
  const rotate = await handler(request(`/v1/connections/${CONNECTION}/rotate`, {
    method: 'POST',
    body: credentialBody(),
  }));
  assert.equal(rotate.status, 200);
  assert.deepEqual(await bodyOf(rotate), {
    connectionId: CONNECTION,
    status: 'ACTIVE',
    credentialVersion: 2,
    permissionEvidence: PERMISSION_EVIDENCE,
  });
  assert.equal(memory.calls.encrypt[0].credentialVersion, 2);
  assert.equal(memory.calls.save[0].expectedCredentialVersion, 1);

  const sync = await handler(request(`/v1/connections/${CONNECTION}/sync`, {
    method: 'POST',
    body: { idempotencyKey: IDEMPOTENCY },
  }));
  assert.equal(sync.status, 202);
  assert.deepEqual(await bodyOf(sync), { status: 'QUEUED', jobId: JOB });
  assert.deepEqual(memory.calls.enqueue, [{
    token: TOKEN,
    connectionId: CONNECTION,
    dataset: 'positions',
    partitionKey: 'default',
    idempotencyKey: IDEMPOTENCY,
  }]);

  const disconnected = await handler(request(`/v1/connections/${CONNECTION}`, { method: 'DELETE' }));
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await bodyOf(disconnected), { status: 'DISCONNECTED', receiptId: RECEIPT });
  assert.deepEqual(memory.calls.disconnect, [{
    token: TOKEN,
    connectionId: CONNECTION,
    expectedCredentialVersion: 1,
  }]);
});

test('ADMIN and MEMBER contexts fail closed before every personal-tenant data or mutation dependency', async () => {
  for (const memberRole of ['admin', 'member']) {
    const memory = memoryDependencies({
      getTenantContext: async () => ({ tenantId: TENANT, memberRole, membershipVersion: 4 }),
    });
    const handler = edge.createBinanceBetaHandler(memory.deps);
    const candidates = [
      request('/v1/connections'),
      request(`/v1/connections/${CONNECTION}/status`),
      request('/v1/datasets/current', { headers: { 'x-rv-connection-id': CONNECTION } }),
      request('/v1/connections', { method: 'POST', body: credentialBody() }),
      request(`/v1/connections/${CONNECTION}/rotate`, { method: 'POST', body: credentialBody() }),
      request(`/v1/connections/${CONNECTION}/sync`, {
        method: 'POST', body: { idempotencyKey: IDEMPOTENCY },
      }),
      request(`/v1/connections/${CONNECTION}`, { method: 'DELETE' }),
    ];
    for (const candidate of candidates) {
      const response = await handler(candidate);
      assert.equal(response.status, 401, `${memberRole} ${candidate.method} ${candidate.url}`);
      assert.deepEqual(await bodyOf(response), { error: 'authentication_required' });
    }
    assert.equal(memory.calls.list, 0);
    assert.equal(memory.calls.probe, 0);
    assert.equal(memory.calls.encrypt.length, 0);
    assert.equal(memory.calls.save.length, 0);
    assert.equal(memory.calls.status.length, 0);
    assert.equal(memory.calls.dataset.length, 0);
    assert.equal(memory.calls.disconnect.length, 0);
    assert.equal(memory.calls.enqueue.length, 0);
  }
});

test('Binance/upstream failures map to bounded public codes, Retry-After, and no private detail', async () => {
  assert.equal(typeof edge.createBinanceBetaHandler, 'function');
  for (const scenario of [
    { code: 'PERMISSION_UNSAFE', status: 422, body: { error: 'read_only_key_required' } },
    { code: 'AUTH_DISABLED', status: 422, body: { error: 'credentials_rejected' } },
    { code: 'GEO_RESTRICTED', status: 451, body: { error: 'geo_restricted' } },
    { code: 'RATE_LIMITED', status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 9 },
    { code: 'GLOBAL_CIRCUIT_OPEN', status: 503, body: { error: 'sync_temporarily_paused' }, retryAfterSeconds: 31 },
  ]) {
    const privateDetail = `${API_KEY}:${API_SECRET}:${SUBJECT}:${TENANT}:ciphertext`;
    const error = Object.assign(new Error(privateDetail), {
      code: scenario.code,
      retryAfterSeconds: scenario.retryAfterSeconds ?? 0,
    });
    const memory = memoryDependencies({ probeReadOnlyPermissions: async () => { throw error; } });
    const response = await edge.createBinanceBetaHandler(memory.deps)(request('/v1/connections', {
      method: 'POST',
      body: credentialBody(),
    }));
    const text = await response.text();
    assert.equal(response.status, scenario.status);
    assert.deepEqual(JSON.parse(text), scenario.body);
    assert.doesNotMatch(text, new RegExp(`${API_KEY}|${API_SECRET}|${SUBJECT}|${TENANT}|ciphertext`));
    if (scenario.retryAfterSeconds) assert.equal(response.headers.get('Retry-After'), String(scenario.retryAfterSeconds));
  }
});
