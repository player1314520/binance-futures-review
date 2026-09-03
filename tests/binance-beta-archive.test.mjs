import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveReceipt,
  createArchiveState,
  fallbackArchiveToCsv,
  runArchiveStep,
} from '../supabase/functions/binance-beta/archive.mjs';
import {
  createRuntimeDependencies,
  readRuntimeConfig,
} from '../supabase/functions/binance-beta/runtime.mjs';
import { createBinanceBetaInternalHandler } from '../supabase/functions/binance-beta/internal-handler.mjs';
import { encryptCredentialEnvelope } from '../supabase/functions/binance-beta/crypto.mjs';

const ARCHIVE_ID = '7cbf0a6f-8fc7-42e0-bf3c-2be8d18ed516';
const START = '1767225600000';
const END = '1798761599000';
const NOW = 1_800_000_000_000;
const DOWNLOAD_ID = 'report_job_123456789';
const DOWNLOAD_URL = 'https://binance-user-report.example-cdn.com/private/report.zip?token=secret';
const JOB = '25334423-6c9d-4e2e-a7b4-22a6ba0aecb2';
const CLAIM = 'a8c9a6c3-216b-4eb1-b8ba-820b39318558';
const WORKER = '72615777-336b-4823-a504-741f844f41cd';
const TENANT = '04908935-5d99-44b3-8680-e5305d0a7856';
const CONNECTION = '30cc92fe-52a9-4b6c-8ac2-3b9c2e0b6601';

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
    RV_BETA_EDGE_WORKER_SUBJECT: WORKER,
  };
}

test('archive request contract is exact USD-M dataset mapping and a maximum one-year window', () => {
  for (const [dataset, requestEndpoint, pollEndpoint, monthlyQuota] of [
    ['fills', 'tradeHistoryRequest', 'tradeHistoryPoll', 5],
    ['orders', 'orderHistoryRequest', 'orderHistoryPoll', 10],
    ['income', 'incomeHistoryRequest', 'incomeHistoryPoll', 5],
  ]) {
    const state = createArchiveState({ dataset, startTime: START, endTime: END });
    assert.equal(state.dataset, dataset);
    assert.equal(state.requestEndpoint, requestEndpoint);
    assert.equal(state.pollEndpoint, pollEndpoint);
    assert.equal(state.monthlyQuota, monthlyQuota);
    assert.equal(state.status, 'REQUEST_PENDING');
    assert.equal(JSON.stringify(state).includes('url'), false);
  }
  for (const bad of [
    { dataset: 'algo_orders', startTime: START, endTime: END },
    { dataset: 'fills', startTime: END, endTime: START },
    { dataset: 'fills', startTime: '0', endTime: String(366n * 86_400_000n) },
    { dataset: 'fills', startTime: Number.MAX_SAFE_INTEGER + 1, endTime: END },
  ]) assert.throws(() => createArchiveState(bad), /ARCHIVE_/);
  const tampered = { ...createArchiveState({ dataset: 'fills', startTime: START, endTime: END }), monthlyQuota: 99 };
  assert.throws(() => archiveReceipt(tampered), /ARCHIVE_STATE_INVALID/);
});

test('one bounded request step stores only downloadId and never exposes a link', async () => {
  const calls = [];
  const state = createArchiveState({ dataset: 'fills', startTime: START, endTime: END });
  const next = await runArchiveStep(state, {
    nowMs: () => NOW,
    client: {
      get: async (endpoint, query) => {
        calls.push({ endpoint, query });
        return { avgCostTimestampOfLast30d: 5000, downloadId: DOWNLOAD_ID };
      },
    },
    stagePrivateLink: async () => { throw new Error('not expected'); },
  }, { apiKey: 'A'.repeat(64), apiSecret: 'b'.repeat(64) });
  assert.deepEqual(calls, [{
    endpoint: 'tradeHistoryRequest',
    query: { startTime: START, endTime: END },
  }]);
  assert.equal(next.status, 'POLL_PENDING');
  assert.equal(next.downloadId, DOWNLOAD_ID);
  assert.doesNotMatch(JSON.stringify(archiveReceipt(next)), /secret|https?:|downloadId/i);
});

test('polling processing is bounded and completed link is staged privately in the same step', async () => {
  const initial = createArchiveState({ dataset: 'orders', startTime: START, endTime: END });
  const requested = await runArchiveStep(initial, {
    nowMs: () => NOW,
    client: { get: async () => ({ downloadId: DOWNLOAD_ID }) },
    stagePrivateLink: async () => { throw new Error('not expected'); },
  }, {});
  const processing = await runArchiveStep(requested, {
    nowMs: () => NOW,
    client: { get: async () => ({
      downloadId: DOWNLOAD_ID,
      status: 'processing',
      notified: false,
      expirationTimestamp: NOW + 7 * 86_400_000,
      isExpired: 'false',
    }) },
    stagePrivateLink: async () => { throw new Error('not expected'); },
  }, {});
  assert.equal(processing.status, 'POLL_PENDING');
  assert.equal(processing.pollCount, 1);

  const stagedCalls = [];
  const staged = await runArchiveStep(processing, {
    nowMs: () => NOW,
    client: { get: async (endpoint, query) => {
      assert.equal(endpoint, 'orderHistoryPoll');
      assert.deepEqual(query, { downloadId: DOWNLOAD_ID });
      return {
        downloadId: DOWNLOAD_ID,
        status: 'completed',
        url: DOWNLOAD_URL,
        notified: false,
        expirationTimestamp: NOW + 7 * 86_400_000,
        isExpired: 'false',
      };
    } },
    stagePrivateLink: async (value) => {
      stagedCalls.push(value);
      return { archiveId: ARCHIVE_ID, status: 'STAGED' };
    },
  }, {});
  assert.equal(staged.status, 'STAGED');
  assert.equal(staged.archiveId, ARCHIVE_ID);
  assert.equal(Object.hasOwn(staged, 'downloadUrl'), false);
  assert.equal(stagedCalls[0].downloadUrl, DOWNLOAD_URL);
  assert.equal(stagedCalls[0].downloadId, DOWNLOAD_ID);
  assert.doesNotMatch(JSON.stringify(archiveReceipt(staged)), /secret|https?:|downloadId/i);
});

test('downloadId mismatch, expired/overlong link, unexpected schema, and missing private stager fail closed', async () => {
  const requested = {
    ...createArchiveState({ dataset: 'income', startTime: START, endTime: END }),
    status: 'POLL_PENDING',
    downloadId: DOWNLOAD_ID,
    pollCount: 0,
  };
  const response = {
    downloadId: DOWNLOAD_ID,
    status: 'completed',
    url: DOWNLOAD_URL,
    notified: false,
    expirationTimestamp: NOW + 60_000,
    isExpired: 'false',
  };
  for (const mutation of [
    { downloadId: 'other' },
    { expirationTimestamp: NOW + 7 * 86_400_000 + 1 },
    { url: 'http://127.0.0.1/private.zip' },
    { arbitrary: 'field' },
  ]) {
    await assert.rejects(
      runArchiveStep(requested, {
        nowMs: () => NOW,
        client: { get: async () => ({ ...response, ...mutation }) },
        stagePrivateLink: async () => ({ archiveId: ARCHIVE_ID, status: 'STAGED' }),
      }, {}),
      (error) => String(error?.code ?? '').startsWith('ARCHIVE_'),
    );
  }
  const expired = await runArchiveStep(requested, {
    nowMs: () => NOW,
    client: { get: async () => ({
      ...response,
      expirationTimestamp: NOW - 1,
      isExpired: 'true',
    }) },
    stagePrivateLink: async () => { throw new Error('not expected'); },
  }, {});
  assert.equal(expired.status, 'CSV_REQUIRED');
  assert.equal(expired.fallbackReason, 'LINK_EXPIRED');
  await assert.rejects(
    runArchiveStep(requested, {
      nowMs: () => NOW,
      client: { get: async () => response },
    }, {}),
    (error) => error?.code === 'ARCHIVE_PRIVATE_STAGER_REQUIRED',
  );
});

test('quota, unavailable coverage, and poll exhaustion produce an explicit CSV evidence fallback', () => {
  const state = createArchiveState({ dataset: 'fills', startTime: START, endTime: END });
  for (const reason of ['QUOTA_EXHAUSTED', 'COVERAGE_UNAVAILABLE', 'POLL_EXHAUSTED', 'LINK_EXPIRED']) {
    const fallback = fallbackArchiveToCsv(state, reason);
    assert.equal(fallback.status, 'CSV_REQUIRED');
    assert.equal(fallback.fallbackReason, reason);
    assert.equal(archiveReceipt(fallback).nextAction, 'UPLOAD_CSV_EVIDENCE');
  }
  assert.throws(() => fallbackArchiveToCsv(state, 'UPSTREAM_ERROR'), /ARCHIVE_/);
});

test('runtime polls only the fixed Binance GET endpoint and stages the secret link through one service RPC', async () => {
  const env = runtimeEnvironment();
  const calls = [];
  const expiresAtMs = Date.now() + 60_000;
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.hostname === 'fapi.binance.com') {
        assert.equal(url.pathname, '/fapi/v1/trade/asyn/id');
        assert.equal(url.searchParams.get('downloadId'), DOWNLOAD_ID);
        assert.equal(init.method, 'GET');
        return new Response(JSON.stringify({
          downloadId: DOWNLOAD_ID,
          status: 'completed',
          url: DOWNLOAD_URL,
          notified: false,
          expirationTimestamp: expiresAtMs,
          isExpired: 'false',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(url.pathname, '/rest/v1/rpc/rv2_service_stage_archive_link');
      return new Response(JSON.stringify([{ archive_id: ARCHIVE_ID, status: 'STAGED' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const base = createArchiveState({ dataset: 'fills', startTime: START, endTime: END });
  const result = await runtime.internalDeps.runArchiveStep({
    jobId: JOB,
    claimToken: CLAIM,
    credentialVersion: 2,
    credentials: { apiKey: 'A'.repeat(64), apiSecret: 'b'.repeat(64) },
    state: { ...base, status: 'POLL_PENDING', downloadId: DOWNLOAD_ID, pollCount: 0 },
  }, { signal: new AbortController().signal });
  assert.equal(result.status, 'STAGED');
  assert.equal(Object.hasOwn(result, 'downloadUrl'), false);
  const rpcBody = JSON.parse(calls[1].init.body);
  assert.equal(rpcBody.p_download_url, DOWNLOAD_URL);
  assert.equal(rpcBody.p_download_id, DOWNLOAD_ID);
  assert.equal(rpcBody.p_dataset, 'fills');
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  assert.doesNotMatch(JSON.stringify(result), /secret|https?:|downloadId/i);
});

test('archive Binance 418 opens the durable shared circuit before surfacing the bounded error', async () => {
  const env = runtimeEnvironment();
  const rpcBodies = [];
  const runtime = createRuntimeDependencies(readRuntimeConfig((key) => env[key]), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'fapi.binance.com') {
        return new Response('{}', {
          status: 418,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '31' },
        });
      }
      assert.equal(url.pathname, '/rest/v1/rpc/rv2_service_open_worker_circuit');
      rpcBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify([{
        circuit_open_until: '2026-08-31T12:00:31.000Z',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const state = createArchiveState({ dataset: 'fills', startTime: START, endTime: END });
  await assert.rejects(
    runtime.internalDeps.runArchiveStep({
      jobId: JOB,
      claimToken: CLAIM,
      credentialVersion: 2,
      credentials: { apiKey: 'A'.repeat(64), apiSecret: 'b'.repeat(64) },
      state,
    }, { signal: new AbortController().signal }),
    (error) => error?.code === 'GLOBAL_CIRCUIT_OPEN'
      && error.retryAfterSeconds === 31,
  );
  assert.deepEqual(rpcBodies, [{
    p_worker_subject: WORKER,
    p_error_code: 'GLOBAL_CIRCUIT_OPEN',
    p_retry_after_seconds: 31,
  }]);
});

test('internal archive HTTP route reaches persistent claim and commit RPCs with one bounded Binance GET', async () => {
  const env = runtimeEnvironment();
  const config = readRuntimeConfig((key) => env[key]);
  const envelope = await encryptCredentialEnvelope({
    tenantId: TENANT,
    connectionId: CONNECTION,
    credentialVersion: 2,
    apiKey: 'A'.repeat(64),
    apiSecret: 'b'.repeat(64),
    kekBytes: config.credentialKek,
  });
  const calls = [];
  const runtime = createRuntimeDependencies(config, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname.endsWith('/rv2_service_claim_archive_job')) {
        assert.equal(JSON.parse(init.body).p_job_id, null);
        return new Response(JSON.stringify([{
          job_id: JOB,
          tenant_id: TENANT,
          connection_id: CONNECTION,
          credential_version: 2,
          claim_token: CLAIM,
          dataset: 'fills',
          window_start: START,
          window_end: END,
          state: null,
          envelope_ciphertext: envelope.ciphertext,
          envelope_nonce: envelope.nonce,
          envelope_key_ref: envelope.keyRef,
          envelope_sha256: envelope.sha256,
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'fapi.binance.com') {
        assert.equal(url.pathname, '/fapi/v1/trade/asyn');
        assert.equal(url.searchParams.get('startTime'), START);
        assert.equal(url.searchParams.get('endTime'), END);
        return new Response(JSON.stringify({ downloadId: DOWNLOAD_ID }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/rv2_service_commit_archive_state')) {
        const body = JSON.parse(init.body);
        assert.equal(body.p_state.status, 'POLL_PENDING');
        assert.equal(body.p_state.downloadId, DOWNLOAD_ID);
        return new Response(JSON.stringify([{ job_id: JOB, status: 'POLL_PENDING' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected call ${url}`);
    },
  });
  const handler = createBinanceBetaInternalHandler(runtime.internalDeps);
  const response = await handler(new Request('https://edge.example.com/internal/v1/archive/cron', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rv-worker-token': env.RV_BETA_ARCHIVE_CRON_TOKEN,
    },
    body: JSON.stringify({ source: 'pg_cron' }),
  }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(JSON.parse(text).status, 'POLL_PENDING');
  assert.doesNotMatch(text, /downloadId|report_job|https?:|ciphertext|apiKey|apiSecret/i);
  assert.deepEqual(calls.map(({ url }) => url.pathname.split('/').at(-1)), [
    'rv2_service_claim_archive_job', 'asyn', 'rv2_service_commit_archive_state',
  ]);
});
