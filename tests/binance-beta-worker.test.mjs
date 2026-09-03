import assert from 'node:assert/strict';
import test from 'node:test';
import * as internal from '../supabase/functions/binance-beta/internal-handler.mjs';

const WORKER_SUBJECT = '67268a98-4aac-4bb7-8b07-56a1a7e14d3f';
const TENANT = '04908935-5d99-44b3-8680-e5305d0a7856';
const REQUESTED_BY = '72615777-336b-4823-a504-741f844f41cd';
const CONNECTION = '30cc92fe-52a9-4b6c-8ac2-3b9c2e0b6601';
const JOB = '25334423-6c9d-4e2e-a7b4-22a6ba0aecb2';
const ATTEMPT = '0202c8e7-e7ab-4cd8-9cac-da84a8ef92da';
const CLAIM_TOKEN = 'a8c9a6c3-216b-4eb1-b8ba-820b39318558';
const WORK_ID = 'cb393502-fbec-4cb0-8113-96c83564f435';
const EFFECT_LEASE_TOKEN = 'ec14da0a-f302-48db-b789-b8031c18559d';
const EFFECT_DIGEST = 'f'.repeat(64);
const CRON_TOKEN = 'c'.repeat(64);
const ARCHIVE_CRON_TOKEN = 'a'.repeat(64);
const NOW_ISO = '2027-01-15T08:00:00.000Z';

function claim(overrides = {}) {
  const value = {
    jobId: JOB,
    attemptId: ATTEMPT,
    claimToken: CLAIM_TOKEN,
    connectionId: CONNECTION,
    credentialVersion: 2,
    tenantId: TENANT,
    requestedBy: REQUESTED_BY,
    dataset: 'userTrades',
    partitionKey: 'BTCUSDT',
    query: { symbol: 'BTCUSDT', limit: 1000 },
    pageCursor: {},
    pageNumber: 0,
    previousPageDigest: null,
    envelope: {
      version: 1,
      credentialVersion: 2,
      nonce: 'nonce',
      ciphertext: 'private-ciphertext',
      keyRef: 'RV_BETA_CREDENTIAL_KEK_V1.wrap.wrapped',
      sha256: 'e'.repeat(64),
    },
    ...overrides,
  };
  if (overrides.dataset && !Object.hasOwn(overrides, 'query')) {
    const dataset = {
      userTrades: 'fills', allOrders: 'orders', allAlgoOrders: 'algo_orders',
      forceOrders: 'force_orders', account: 'balances', positionRisk: 'positions',
    }[overrides.dataset] ?? overrides.dataset;
    value.partitionKey = ['balances'].includes(dataset) ? 'account-wide' : 'BTCUSDT';
    value.query = {
      fills: { symbol: 'BTCUSDT', limit: 1000 },
      income: { symbol: 'BTCUSDT', limit: 1000 },
      orders: { symbol: 'BTCUSDT', limit: 1000 },
      algo_orders: { symbol: 'BTCUSDT', limit: 1000 },
      force_orders: { symbol: 'BTCUSDT', limit: 1000 },
      balances: {},
      positions: { symbol: 'BTCUSDT' },
    }[dataset];
  }
  return value;
}

function page(overrides = {}) {
  return {
    rows: [{ id: 7, symbol: 'BTCUSDT', buyer: true }],
    attemptedThrough: NOW_ISO,
    fetchedThrough: NOW_ISO,
    committedThrough: NOW_ISO,
    trustedThrough: null,
    coverageState: 'PARTIAL',
    gaps: [{ code: 'RETENTION_GAP', from: null, to: NOW_ISO }],
    nextCursor: null,
    hasMore: false,
    pageDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function canonicalEvent() {
  return {
    eventId: 'binance-usdm:userTrades:BTCUSDT:7',
    source: 'BINANCE',
    market: 'USD_M',
    sourceEndpoint: '/fapi/v1/userTrades',
    observedAt: NOW_ISO,
    payload: { tradeId: '7', symbol: 'BTCUSDT' },
  };
}

function postCommitEffect(dataset = 'fills') {
  return {
    protocol: 'rv-sync-post-commit/1',
    symbols: ['BTCUSDT'],
    ledgerShadow: ['fills', 'income'].includes(dataset) ? {
      projection: {
        protocol: 'rv-ledger-shadow-page/1',
        state: 'INCOMPLETE',
        dataset,
        eventCount: '1',
        reasonCodes: ['LEDGER_PROJECTION_UNAVAILABLE'],
      },
      reconciliation: {
        protocol: 'rv-reconciliation/2',
        stage: 'SHADOW',
        status: 'NOT_EVALUATED',
        realGeneration: false,
        generation: null,
        reasonCodes: ['ORACLE_NOT_AVAILABLE', 'PAGE_SCOPED_PROJECTION'],
        checks: {
          balancedEntries: 'NOT_EVALUATED',
          assetParity: 'NOT_EVALUATED',
          positionParity: 'NOT_EVALUATED',
        },
        diffs: [],
        projectionDigest: 'd'.repeat(64),
        summaryDigest: 'e'.repeat(64),
      },
      projectionDigest: 'd'.repeat(64),
    } : null,
  };
}

function memoryDependencies(overrides = {}) {
  const calls = {
    claim: [],
    decrypt: [],
    fetch: [],
    normalize: [],
    commit: [],
    fail: [],
    archiveClaim: [],
    archiveRun: [],
    archiveCommit: [],
    archiveFail: [],
    effectBuild: [],
    effectClaim: [],
    effectComplete: [],
    effectFail: [],
  };
  const deps = {
    deadlineMs: 1_000,
    workerSubject: WORKER_SUBJECT,
    syncCronToken: CRON_TOKEN,
    archiveCronToken: ARCHIVE_CRON_TOKEN,
    claimSyncJob: async (input) => {
      calls.claim.push(input);
      return claim();
    },
    decryptCredentialEnvelope: async (input) => {
      calls.decrypt.push(input);
      return { apiKey: 'A'.repeat(64), apiSecret: 'b'.repeat(64) };
    },
    fetchBinancePage: async (input) => {
      calls.fetch.push(input);
      return page();
    },
    normalizeSourceEvents: async (input) => {
      calls.normalize.push(input);
      return [canonicalEvent()];
    },
    commitSyncPage: async (input) => {
      calls.commit.push(input);
      return { jobId: JOB, status: 'COMPLETED', insertedCount: 1, replayedCount: 0 };
    },
    failSyncJob: async (input) => {
      calls.fail.push(input);
      return { jobId: JOB, status: 'FAILED', availableAt: null };
    },
    buildPostCommitEffect: async (input) => {
      calls.effectBuild.push(input);
      return postCommitEffect(input.dataset);
    },
    claimPostCommitWork: async (input) => {
      calls.effectClaim.push(input);
      return null;
    },
    completePostCommitWork: async (input) => {
      calls.effectComplete.push(input);
      return { accepted: true, replayed: false, status: 'COMPLETED' };
    },
    failPostCommitWork: async (input) => {
      calls.effectFail.push(input);
      return { accepted: true, replayed: false, status: 'QUEUED' };
    },
    createArchiveState: (input) => ({
      protocol: 'rv-binance-archive/1',
      dataset: input.dataset,
      startTime: input.startTime,
      endTime: input.endTime,
      requestEndpoint: 'tradeHistoryRequest',
      pollEndpoint: 'tradeHistoryPoll',
      monthlyQuota: 5,
      status: 'REQUEST_PENDING',
      pollCount: 0,
    }),
    claimArchiveJob: async (input) => {
      calls.archiveClaim.push(input);
      return {
        jobId: JOB,
        claimToken: CLAIM_TOKEN,
        connectionId: CONNECTION,
        credentialVersion: 2,
        tenantId: TENANT,
        dataset: 'fills',
        windowStart: '1767225600000',
        windowEnd: '1798761599000',
        state: null,
        envelope: claim().envelope,
      };
    },
    runArchiveStep: async (input) => {
      calls.archiveRun.push(input);
      return {
        protocol: 'rv-binance-archive/1',
        dataset: 'fills',
        startTime: '1767225600000',
        endTime: '1798761599000',
        requestEndpoint: 'tradeHistoryRequest',
        pollEndpoint: 'tradeHistoryPoll',
        monthlyQuota: 5,
        status: 'POLL_PENDING',
        pollCount: 0,
        downloadId: 'private_report_job_123',
      };
    },
    commitArchiveState: async (input) => {
      calls.archiveCommit.push(input);
      return { jobId: JOB, status: 'POLL_PENDING' };
    },
    failArchiveJob: async (input) => {
      calls.archiveFail.push(input);
      return { jobId: JOB, status: 'FAILED' };
    },
    ...overrides,
  };
  return { deps, calls };
}

function request(path, { body, token, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  return new Request(`https://edge.example.com${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

test('legacy OIDC and caller-selected job routes are absent from the internal HTTP surface', async () => {
  assert.equal(typeof internal.createBinanceBetaInternalHandler, 'function');
  const memory = memoryDependencies();
  const handler = internal.createBinanceBetaInternalHandler(memory.deps);
  for (const route of [
    '/internal/v1/oidc/exchange',
    '/internal/v1/sync/run',
    '/internal/v1/archive/run',
  ]) {
    const response = await handler(request(route, { body: { jobId: JOB }, token: 'x'.repeat(64) }));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(memory.calls.claim.length, 0);
  assert.equal(memory.calls.archiveClaim.length, 0);
});

test('worker handles exactly one claimed page and commits only normalized source events through one narrow RPC', async () => {
  assert.equal(typeof internal.runOneSyncPage, 'function');
  const memory = memoryDependencies();
  const result = await internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal });
  assert.deepEqual(result, {
    status: 'COMPLETED',
    jobId: JOB,
    insertedCount: 1,
    replayedCount: 0,
  });
  assert.deepEqual(memory.calls.claim, [{
    workerSubject: WORKER_SUBJECT,
    jobId: JOB,
    queueClass: 'BINANCE_USDM',
  }]);
  assert.equal(memory.calls.decrypt.length, 1);
  assert.equal(memory.calls.fetch.length, 1);
  assert.equal(memory.calls.fetch[0].endpoint, 'userTrades');
  assert.equal(memory.calls.normalize.length, 1);
  assert.equal(memory.calls.normalize[0].dataset, 'fills');
  assert.equal(memory.calls.normalize[0].sourceEndpoint, '/fapi/v1/userTrades');
  assert.deepEqual(memory.calls.normalize[0].rows, page().rows);
  assert.equal(memory.calls.commit.length, 1);
  assert.deepEqual(memory.calls.commit[0].events, [canonicalEvent()]);
  assert.equal(memory.calls.commit[0].workerSubject, WORKER_SUBJECT);
  assert.equal(memory.calls.commit[0].jobId, JOB);
  assert.equal(memory.calls.commit[0].attemptId, ATTEMPT);
  assert.equal(memory.calls.commit[0].claimToken, CLAIM_TOKEN);
  assert.equal(memory.calls.commit[0].credentialVersion, 2);
  assert.equal(memory.calls.commit[0].hasMore, false);
  assert.equal(memory.calls.commit[0].nextCursor, null);
  assert.equal(memory.calls.commit[0].pageDigest, 'a'.repeat(64));
  assert.deepEqual(memory.calls.commit[0].postCommitEffect, postCommitEffect());
  assert.equal(memory.calls.effectBuild.length, 1);
  const committedText = JSON.stringify(memory.calls.commit[0]);
  assert.doesNotMatch(committedText, /private-ciphertext|apiKey|apiSecret|tenantId|requestedBy/);
  assert.equal(memory.calls.fail.length, 0);
});

test('caller-forged PASS or capability ALLOW can never enter the transactional post-commit effect', async () => {
  for (const forged of [
    () => {
      const effect = postCommitEffect();
      return {
        ...effect,
        ledgerShadow: {
          ...effect.ledgerShadow,
          reconciliation: { ...effect.ledgerShadow.reconciliation, status: 'PASS' },
        },
      };
    },
    () => ({ ...postCommitEffect(), capability: 'ALLOW' }),
  ]) {
    const memory = memoryDependencies({ buildPostCommitEffect: async () => forged() });
    await assert.rejects(
      internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
      (error) => error?.code === 'NORMALIZATION_CONFLICT',
    );
    assert.equal(memory.calls.commit.length, 0);
    assert.equal(memory.calls.fail.length, 1);
  }
});

test('worker drains one durable post-commit effect before it can claim another source page', async () => {
  let memory;
  memory = memoryDependencies({
    claimPostCommitWork: async (input) => {
      memory.calls.effectClaim.push(input);
      return {
        workId: WORK_ID,
        jobId: JOB,
        connectionId: CONNECTION,
        credentialVersion: 2,
        attemptId: ATTEMPT,
        leaseToken: EFFECT_LEASE_TOKEN,
        workKind: 'SYNC_EFFECTS',
        inputDigest: EFFECT_DIGEST,
      };
    },
  });
  const result = await internal.runOneSyncPage(
    { jobId: JOB }, memory.deps, { signal: new AbortController().signal },
  );
  assert.deepEqual(result, {
    status: 'POST_COMMIT_COMPLETED',
    jobId: JOB,
    insertedCount: 0,
    replayedCount: 0,
  });
  assert.equal(memory.calls.claim.length, 0);
  assert.deepEqual(memory.calls.effectComplete, [{
    workerSubject: WORKER_SUBJECT,
    workId: WORK_ID,
    jobId: JOB,
    connectionId: CONNECTION,
    credentialVersion: 2,
    attemptId: ATTEMPT,
    leaseToken: EFFECT_LEASE_TOKEN,
    inputDigest: EFFECT_DIGEST,
  }]);
  assert.equal(memory.calls.effectFail.length, 0);
});

test('post-commit failure is re-queued with its own lease and never rewrites the committed source job', async () => {
  let memory;
  let effectClaims = 0;
  const effectError = Object.assign(new Error('private post-commit failure'), {
    code: 'UPSTREAM_UNAVAILABLE', retryable: true, retryAfterSeconds: 7,
  });
  memory = memoryDependencies({
    claimPostCommitWork: async (input) => {
      memory.calls.effectClaim.push(input);
      effectClaims += 1;
      if (effectClaims === 1) return null;
      return {
        workId: WORK_ID,
        jobId: JOB,
        connectionId: CONNECTION,
        credentialVersion: 2,
        attemptId: ATTEMPT,
        leaseToken: EFFECT_LEASE_TOKEN,
        workKind: 'SYNC_EFFECTS',
        inputDigest: EFFECT_DIGEST,
      };
    },
    completePostCommitWork: async (input) => {
      memory.calls.effectComplete.push(input);
      throw effectError;
    },
  });
  await assert.rejects(
    internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
    (error) => error === effectError,
  );
  assert.equal(memory.calls.commit.length, 1);
  assert.equal(memory.calls.fail.length, 0);
  assert.equal(memory.calls.effectFail.length, 1);
  assert.deepEqual(memory.calls.effectFail[0], {
    workerSubject: WORKER_SUBJECT,
    workId: WORK_ID,
    jobId: JOB,
    connectionId: CONNECTION,
    credentialVersion: 2,
    attemptId: ATTEMPT,
    leaseToken: EFFECT_LEASE_TOKEN,
    inputDigest: EFFECT_DIGEST,
    errorCode: 'UPSTREAM_UNAVAILABLE',
    retryable: true,
    retryAfterSeconds: 7,
  });
});

test('a full 1000-row page must persist a strictly advancing continuation instead of completing', async () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1), symbol: 'BTCUSDT' }));
  const memory = memoryDependencies({
    claimSyncJob: async () => claim({
      query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 },
      pageCursor: { fromId: '1' },
      pageNumber: 8,
      previousPageDigest: 'b'.repeat(64),
    }),
    fetchBinancePage: async () => page({
      rows,
      nextCursor: { fromId: '1001' },
      hasMore: true,
      pageDigest: 'c'.repeat(64),
    }),
    normalizeSourceEvents: async ({ rows: pageRows }) => pageRows.map((row) => ({
      ...canonicalEvent(),
      eventId: `binance-usdm:fills:BTCUSDT:${row.id}`,
      payload: { id: row.id, symbol: 'BTCUSDT' },
    })),
    commitSyncPage: async (input) => {
      memory.calls.commit.push(input);
      return { jobId: JOB, status: 'QUEUED', insertedCount: 1000, replayedCount: 0 };
    },
  });
  const result = await internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal });
  assert.equal(result.status, 'QUEUED');
  assert.deepEqual(memory.calls.commit[0].nextCursor, { fromId: '1001' });
  assert.equal(memory.calls.commit[0].hasMore, true);
  assert.equal(memory.calls.commit[0].pageDigest, 'c'.repeat(64));
});

test('full pages without continuation, non-advancing cursors, and repeated page digests fail closed', async () => {
  const fullRows = Array.from({ length: 1000 }, (_, index) => ({ id: String(index + 1), symbol: 'BTCUSDT' }));
  for (const pageMutation of [
    { nextCursor: null, hasMore: false, pageDigest: 'c'.repeat(64) },
    { nextCursor: { fromId: '1' }, hasMore: true, pageDigest: 'c'.repeat(64) },
    { nextCursor: { orderId: '1001' }, hasMore: true, pageDigest: 'c'.repeat(64) },
    { nextCursor: { fromId: '1001' }, hasMore: true, pageDigest: 'b'.repeat(64) },
  ]) {
    const memory = memoryDependencies({
      claimSyncJob: async () => claim({
        query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 },
        pageCursor: { fromId: '1' },
        pageNumber: 8,
        previousPageDigest: 'b'.repeat(64),
      }),
      fetchBinancePage: async () => page({ rows: fullRows, ...pageMutation }),
    });
    await assert.rejects(
      internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
      (error) => error?.code === 'PAGE_INVALID',
    );
    assert.equal(memory.calls.commit.length, 0);
    assert.equal(memory.calls.fail.length, 1);
  }
});

test('claim cursor must be the exact canonical cursor represented by the reviewed query', async () => {
  for (const overrides of [
    { pageCursor: { orderId: '1' }, query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 } },
    { pageCursor: { fromId: 1 }, query: { symbol: 'BTCUSDT', fromId: '1', limit: 1000 } },
    { pageCursor: { fromId: '01' }, query: { symbol: 'BTCUSDT', fromId: '01', limit: 1000 } },
  ]) {
    const memory = memoryDependencies({ claimSyncJob: async () => claim(overrides) });
    await assert.rejects(
      internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
      (error) => error?.code === 'PAGE_INVALID',
    );
    assert.equal(memory.calls.fetch.length, 0);
    assert.equal(memory.calls.commit.length, 0);
    // The untrusted claim never becomes a bound claim, so the worker must not
    // mutate an attacker-selected job through the failure RPC either.
    assert.equal(memory.calls.fail.length, 0);
  }
});

test('SQL data-plane dataset names resolve to fixed Binance GET endpoint aliases', async () => {
  const cases = [
    ['fills', 'userTrades', '/fapi/v1/userTrades'],
    ['income', 'income', '/fapi/v1/income'],
    ['orders', 'allOrders', '/fapi/v1/allOrders'],
    ['algo_orders', 'allAlgoOrders', '/fapi/v1/allAlgoOrders'],
    ['force_orders', 'forceOrders', '/fapi/v1/forceOrders'],
    ['balances', 'account', '/fapi/v3/account'],
    ['positions', 'positionRisk', '/fapi/v3/positionRisk'],
  ];
  for (const [dataset, endpoint, sourceEndpoint] of cases) {
    let normalizedInput = null;
    const memory = memoryDependencies({
      claimSyncJob: async () => claim({ dataset }),
      normalizeSourceEvents: async (input) => {
        normalizedInput = input;
        return [{ ...canonicalEvent(), sourceEndpoint: input.sourceEndpoint }];
      },
    });
    await internal.runOneSyncPage(
      { jobId: JOB },
      memory.deps,
      { signal: new AbortController().signal },
    );
    assert.equal(memory.calls.fetch[0].endpoint, endpoint);
    assert.equal(normalizedInput.dataset, dataset);
    assert.equal(normalizedInput.sourceEndpoint, sourceEndpoint);
  }
});

test('archive cron uses an independent token, claims one database-selected step, and returns only a redacted receipt', async () => {
  const memory = memoryDependencies();
  const handler = internal.createBinanceBetaInternalHandler(memory.deps);
  for (const candidate of [undefined, CRON_TOKEN, 'x'.repeat(64), `${ARCHIVE_CRON_TOKEN}x`]) {
    const headers = { 'Content-Type': 'application/json' };
    if (candidate) headers['x-rv-worker-token'] = candidate;
    const denied = await handler(new Request('https://edge.example.com/internal/v1/archive/cron', {
      method: 'POST', headers, body: JSON.stringify({ source: 'pg_cron' }),
    }));
    assert.equal(denied.status, 401);
  }
  const browser = await handler(new Request('https://edge.example.com/internal/v1/archive/cron', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rv-worker-token': ARCHIVE_CRON_TOKEN,
      Origin: 'https://binance-futures-review-web.vercel.app',
    },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(browser.status, 403);
  assert.equal(memory.calls.archiveClaim.length, 0);

  const malformed = await handler(new Request('https://edge.example.com/internal/v1/archive/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rv-worker-token': ARCHIVE_CRON_TOKEN },
    body: JSON.stringify({ source: 'pg_cron', jobId: JOB }),
  }));
  assert.equal(malformed.status, 400);

  const response = await handler(new Request('https://edge.example.com/functions/v1/binance-beta/internal/v1/archive/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rv-worker-token': ARCHIVE_CRON_TOKEN },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), {
    protocol: 'rv-binance-archive/1',
    dataset: 'fills',
    windowStart: '1767225600000',
    windowEnd: '1798761599000',
    status: 'POLL_PENDING',
    nextAction: 'POLL_ARCHIVE',
    archiveId: null,
    fallbackReason: null,
  });
  assert.deepEqual(memory.calls.archiveClaim, [{ workerSubject: WORKER_SUBJECT, jobId: null }]);
  assert.equal(memory.calls.archiveRun.length, 1);
  assert.equal(memory.calls.archiveRun[0].jobId, JOB);
  assert.equal(memory.calls.archiveRun[0].claimToken, CLAIM_TOKEN);
  assert.equal(memory.calls.archiveCommit.length, 1);
  assert.equal(memory.calls.archiveCommit[0].state.status, 'POLL_PENDING');
  assert.equal(memory.calls.archiveFail.length, 0);
  assert.doesNotMatch(text, new RegExp(`${ARCHIVE_CRON_TOKEN}|private_report|downloadId|https?:|ciphertext|apiKey|apiSecret|tenantId`, 'i'));
});

test('archive cron returns a bounded idle receipt when the database has no eligible leased job', async () => {
  const memory = memoryDependencies({ claimArchiveJob: async (input) => {
    memory.calls.archiveClaim.push(input);
    return null;
  } });
  const handler = internal.createBinanceBetaInternalHandler(memory.deps);
  const response = await handler(new Request('https://edge.example.com/internal/v1/archive/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rv-worker-token': ARCHIVE_CRON_TOKEN },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { status: 'IDLE', nextAction: 'WAIT' });
  assert.deepEqual(memory.calls.archiveClaim, [{ workerSubject: WORKER_SUBJECT, jobId: null }]);
  assert.equal(memory.calls.decrypt.length, 0);
  assert.equal(memory.calls.archiveRun.length, 0);
});

test('archive 429, 418, and auth failures preserve bounded retry and connection policy inputs', async () => {
  for (const scenario of [
    { code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 7 },
    { code: 'GLOBAL_CIRCUIT_OPEN', retryable: true, retryAfterSeconds: 31 },
    { code: 'AUTH_DISABLED', retryable: false, retryAfterSeconds: 0 },
  ]) {
    const error = Object.assign(new Error('private archive upstream detail'), scenario);
    const memory = memoryDependencies({ runArchiveStep: async (input) => {
      memory.calls.archiveRun.push(input);
      throw error;
    } });
    await assert.rejects(
      internal.runOneArchiveStep(
        { jobId: null }, memory.deps, { signal: new AbortController().signal },
      ),
      (caught) => caught === error,
    );
    assert.equal(memory.calls.archiveCommit.length, 0);
    assert.equal(memory.calls.archiveFail.length, 1);
    assert.equal(memory.calls.archiveFail[0].errorCode, scenario.code);
    assert.equal(memory.calls.archiveFail[0].retryable, scenario.retryable);
    assert.equal(memory.calls.archiveFail[0].retryAfterSeconds, scenario.retryAfterSeconds);
    assert.doesNotMatch(JSON.stringify(memory.calls.archiveFail[0]), /private archive upstream detail/iu);
  }
});

test('pg_cron route uses only its dedicated constant-time token and processes one unbound page', async () => {
  const memory = memoryDependencies();
  const handler = internal.createBinanceBetaInternalHandler(memory.deps);
  for (const candidate of [undefined, ARCHIVE_CRON_TOKEN, 'x'.repeat(64), `${CRON_TOKEN}x`]) {
    const headers = { 'Content-Type': 'application/json' };
    if (candidate) headers['x-rv-worker-token'] = candidate;
    const response = await handler(new Request('https://edge.example.com/internal/v1/sync/cron', {
      method: 'POST', headers, body: JSON.stringify({ source: 'pg_cron' }),
    }));
    assert.equal(response.status, 401);
  }
  assert.equal(memory.calls.claim.length, 0);

  const malformed = await handler(new Request('https://edge.example.com/internal/v1/sync/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rv-worker-token': CRON_TOKEN },
    body: JSON.stringify({ source: 'pg_cron', jobId: JOB }),
  }));
  assert.equal(malformed.status, 400);
  assert.equal(memory.calls.claim.length, 0);

  const browser = await handler(new Request('https://edge.example.com/internal/v1/sync/cron', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rv-worker-token': CRON_TOKEN,
      Origin: 'https://binance-futures-review-web.vercel.app',
    },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(browser.status, 403);

  const response = await handler(new Request('https://edge.example.com/functions/v1/binance-beta/internal/v1/sync/cron', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-rv-worker-token': CRON_TOKEN },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(memory.calls.claim.length, 1);
  assert.equal(memory.calls.claim[0].jobId, null);
  assert.equal(memory.calls.fetch.length, 1);
  assert.equal(memory.calls.commit.length, 1);
  assert.doesNotMatch(await response.text(), new RegExp(`${CRON_TOKEN}|private-ciphertext|apiKey|apiSecret`));
});

test('oversized or malformed page fails the claimed job once and never commits a partial page', async () => {
  assert.equal(typeof internal.runOneSyncPage, 'function');
  const memory = memoryDependencies({
    fetchBinancePage: async () => page({ rows: Array.from({ length: 1001 }, (_, id) => ({ id })) }),
  });
  await assert.rejects(
    internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
    (error) => error?.code === 'PAGE_INVALID',
  );
  assert.equal(memory.calls.commit.length, 0);
  assert.equal(memory.calls.fail.length, 1);
  assert.deepEqual(memory.calls.fail[0], {
    workerSubject: WORKER_SUBJECT,
    jobId: JOB,
    attemptId: ATTEMPT,
    claimToken: CLAIM_TOKEN,
    credentialVersion: 2,
    errorCode: 'PAGE_INVALID',
    retryable: false,
    retryAfterSeconds: 0,
  });
});

test('429, 418, auth disable, and 451 propagate only bounded failure classifications to the job RPC', async () => {
  assert.equal(typeof internal.runOneSyncPage, 'function');
  for (const scenario of [
    { code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 7 },
    { code: 'GLOBAL_CIRCUIT_OPEN', retryable: true, retryAfterSeconds: 31 },
    { code: 'AUTH_DISABLED', retryable: false, retryAfterSeconds: 0 },
    { code: 'GEO_RESTRICTED', retryable: false, retryAfterSeconds: 0 },
  ]) {
    const privateDetail = `${TENANT}:${REQUESTED_BY}:private-ciphertext:${'A'.repeat(64)}`;
    const error = Object.assign(new Error(privateDetail), scenario);
    const memory = memoryDependencies({ fetchBinancePage: async () => { throw error; } });
    await assert.rejects(
      internal.runOneSyncPage({ jobId: JOB }, memory.deps, { signal: new AbortController().signal }),
      (caught) => caught === error,
    );
    assert.equal(memory.calls.commit.length, 0);
    assert.equal(memory.calls.fail.length, 1);
    assert.equal(memory.calls.fail[0].errorCode, scenario.code);
    assert.equal(memory.calls.fail[0].retryable, scenario.retryable);
    assert.equal(memory.calls.fail[0].retryAfterSeconds, scenario.retryAfterSeconds);
    assert.doesNotMatch(JSON.stringify(memory.calls.fail[0]), new RegExp(`${TENANT}|${REQUESTED_BY}|private-ciphertext|${'A'.repeat(64)}`));
  }
});
