import assert from 'node:assert/strict';
import test from 'node:test';
import * as binance from '../supabase/functions/binance-beta/binance-client.mjs';
import * as credentialCrypto from '../supabase/functions/binance-beta/crypto.mjs';

const TENANT_A = '72aaf514-a41d-4b92-88cf-38d53cce2a77';
const TENANT_B = '85e93cb0-5e32-4a73-9958-c868c68e593f';
const CONNECTION_A = 'e93c55e7-5eb3-4a7c-8c9f-d9400f2733f7';
const API_KEY = 'A'.repeat(64);
const API_SECRET = 'b'.repeat(64);
const KEK = new Uint8Array(32).fill(17);

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

test('credential envelope uses a fresh DEK, AES-GCM AAD binding, and a versioned KEK wrapper', async () => {
  assert.equal(typeof credentialCrypto.encryptCredentialEnvelope, 'function');
  assert.equal(typeof credentialCrypto.decryptCredentialEnvelope, 'function');
  const input = {
    tenantId: TENANT_A,
    connectionId: CONNECTION_A,
    credentialVersion: 1,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    kekBytes: KEK,
  };
  const first = await credentialCrypto.encryptCredentialEnvelope(input);
  const second = await credentialCrypto.encryptCredentialEnvelope(input);

  assert.deepEqual(Object.keys(first).sort(), [
    'ciphertext',
    'credentialVersion',
    'keyRef',
    'nonce',
    'sha256',
    'version',
  ]);
  assert.equal(first.version, 1);
  assert.equal(first.credentialVersion, 1);
  assert.match(first.keyRef, /^RV_BETA_CREDENTIAL_KEK_V1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.keyRef, second.keyRef);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(`${API_KEY}|${API_SECRET}`));

  assert.deepEqual(await credentialCrypto.decryptCredentialEnvelope({
    tenantId: TENANT_A,
    connectionId: CONNECTION_A,
    envelope: first,
    kekBytes: KEK,
  }), { apiKey: API_KEY, apiSecret: API_SECRET });
  await assert.rejects(
    credentialCrypto.decryptCredentialEnvelope({
      tenantId: TENANT_B,
      connectionId: CONNECTION_A,
      envelope: first,
      kekBytes: KEK,
    }),
    (error) => error?.code === 'CREDENTIAL_UNWRAP_FAILED'
      && !String(error.message).includes(API_KEY)
      && !String(error.message).includes(API_SECRET),
  );
});

test('provider scope and permission evidence digests are domain-separated and contain no credential', async () => {
  assert.equal(typeof credentialCrypto.providerScopeHash, 'function');
  assert.equal(typeof credentialCrypto.permissionEvidenceDigest, 'function');
  const first = await credentialCrypto.providerScopeHash(API_KEY, KEK);
  const second = await credentialCrypto.providerScopeHash(`${API_KEY}x`, KEK);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);

  const conclusion = {
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
  };
  const digest = await credentialCrypto.permissionEvidenceDigest(conclusion);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(digest, new RegExp(API_KEY));
});

test('permission proof requires every read and dangerous capability field with exact booleans', () => {
  assert.equal(typeof binance.validateReadOnlyPermissions, 'function');
  const safe = {
    ipRestrict: false,
    createTime: 1_623_840_271_000,
    enableReading: true,
    enableWithdrawals: false,
    enableInternalTransfer: false,
    permitsUniversalTransfer: false,
    enableSpotAndMarginTrading: false,
    enableFutures: false,
    enableMargin: false,
    enableVanillaOptions: false,
    enableFixApiTrade: false,
    enableFixReadOnly: false,
    enablePortfolioMarginTrading: false,
  };
  assert.deepEqual(binance.validateReadOnlyPermissions(safe), {
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
  });

  for (const mutation of [
    { enableReading: false },
    { enableWithdrawals: true },
    { enableInternalTransfer: true },
    { permitsUniversalTransfer: true },
    { enableSpotAndMarginTrading: true },
    { enableFutures: true },
    { enableMargin: true },
    { enableVanillaOptions: true },
    { enableReading: 'true' },
    { enableFixApiTrade: true },
    { enablePortfolioMarginTrading: true },
  ]) {
    assert.throws(
      () => binance.validateReadOnlyPermissions({ ...safe, ...mutation }),
      (error) => error?.code === 'PERMISSION_UNSAFE'
        || error?.code === 'PERMISSION_AMBIGUOUS',
    );
  }
  for (const missing of Object.keys(safe)) {
    const incomplete = { ...safe };
    delete incomplete[missing];
    assert.throws(
      () => binance.validateReadOnlyPermissions(incomplete),
      (error) => error?.code === 'PERMISSION_AMBIGUOUS',
    );
  }
  assert.throws(
    () => binance.validateReadOnlyPermissions({ ...safe, enableTrading: false }),
    (error) => error?.code === 'PERMISSION_AMBIGUOUS',
  );
});

test('read-only verification also proves one USD-M USER_DATA GET succeeds', async () => {
  assert.equal(typeof binance.createBinanceClient, 'function');
  const calls = [];
  const permissions = {
    ipRestrict: false,
    createTime: 1_623_840_271_000,
    enableReading: true,
    enableWithdrawals: false,
    enableInternalTransfer: false,
    enableMargin: false,
    enableFutures: false,
    permitsUniversalTransfer: false,
    enableVanillaOptions: false,
    enableFixApiTrade: false,
    enableFixReadOnly: false,
    enableSpotAndMarginTrading: false,
    enablePortfolioMarginTrading: false,
  };
  const client = binance.createBinanceClient({
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path === '/sapi/v1/account/apiRestrictions') return jsonResponse(permissions);
      if (path === '/fapi/v3/account') return jsonResponse({ assets: [], positions: [] });
      throw new Error('unexpected path');
    },
    nowMs: () => 1_800_000_000_000,
  });
  assert.deepEqual(await client.verifyReadOnly({ apiKey: API_KEY, apiSecret: API_SECRET }), {
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
  });
  assert.deepEqual(calls, ['/sapi/v1/account/apiRestrictions', '/fapi/v3/account']);
});

test('Binance client exposes only audited GET endpoint keys on the two exact hosts', async () => {
  assert.equal(typeof binance.createBinanceClient, 'function');
  assert.deepEqual(binance.BINANCE_HOSTS, ['api.binance.com', 'fapi.binance.com']);
  assert.deepEqual(binance.BINANCE_ENDPOINTS, {
    apiRestrictions: ['api.binance.com', '/sapi/v1/account/apiRestrictions'],
    time: ['fapi.binance.com', '/fapi/v1/time'],
    userTrades: ['fapi.binance.com', '/fapi/v1/userTrades'],
    income: ['fapi.binance.com', '/fapi/v1/income'],
    allOrders: ['fapi.binance.com', '/fapi/v1/allOrders'],
    allAlgoOrders: ['fapi.binance.com', '/fapi/v1/allAlgoOrders'],
    forceOrders: ['fapi.binance.com', '/fapi/v1/forceOrders'],
    account: ['fapi.binance.com', '/fapi/v3/account'],
    positionRisk: ['fapi.binance.com', '/fapi/v3/positionRisk'],
    orderHistoryRequest: ['fapi.binance.com', '/fapi/v1/order/asyn'],
    orderHistoryPoll: ['fapi.binance.com', '/fapi/v1/order/asyn/id'],
    tradeHistoryRequest: ['fapi.binance.com', '/fapi/v1/trade/asyn'],
    tradeHistoryPoll: ['fapi.binance.com', '/fapi/v1/trade/asyn/id'],
    incomeHistoryRequest: ['fapi.binance.com', '/fapi/v1/income/asyn'],
    incomeHistoryPoll: ['fapi.binance.com', '/fapi/v1/income/asyn/id'],
  });
  const calls = [];
  const client = binance.createBinanceClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse([]);
    },
    nowMs: () => 1_800_000_000_000,
  });
  await client.get('userTrades', { symbol: 'BTCUSDT', limit: 100 }, {
    apiKey: API_KEY,
    apiSecret: API_SECRET,
  });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.protocol, 'https:');
  assert.equal(requestUrl.hostname, 'fapi.binance.com');
  assert.equal(requestUrl.pathname, '/fapi/v1/userTrades');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['X-MBX-APIKEY'], API_KEY);
  assert.match(requestUrl.searchParams.get('signature'), /^[0-9a-f]{64}$/);
  assert.equal(requestUrl.searchParams.get('timestamp'), '1800000000000');

  for (const [endpoint, query] of [
    ['https://evil.example.com/fapi/v1/userTrades', {}],
    ['userTrades', { url: 'https://evil.example.com' }],
    ['userTrades', { method: 'POST' }],
    ['userTrades', { symbol: ['BTCUSDT'] }],
    ['userTrades', { symbol: 'BTCUSDT', fromId: Number.MAX_SAFE_INTEGER + 1 }],
    ['userTrades', { symbol: 'BTCUSDT', limit: 0.1 }],
    ['time', { symbol: 'BTCUSDT' }],
  ]) {
    await assert.rejects(
      client.get(endpoint, query, { apiKey: API_KEY, apiSecret: API_SECRET }),
      (error) => error?.code === 'ENDPOINT_FORBIDDEN' || error?.code === 'QUERY_FORBIDDEN',
    );
  }
  assert.equal(calls.length, 1);
});

test('Binance client preserves int64 JSON tokens before JavaScript Number can round them', async () => {
  const credentials = { apiKey: API_KEY, apiSecret: API_SECRET };
  const exact = binance.createBinanceClient({
    fetch: async () => new Response(
      '[{"id":9223372036854775807,"orderId":9007199254740993,"time":1800000000000,"symbol":"BTCUSDT"}]',
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
    nowMs: () => 1_800_000_000_000,
  });
  assert.deepEqual(await exact.get('userTrades', { symbol: 'BTCUSDT' }, credentials), [{
    id: '9223372036854775807',
    orderId: '9007199254740993',
    time: '1800000000000',
    symbol: 'BTCUSDT',
  }]);

  for (const raw of [
    '[{"id":1.5,"symbol":"BTCUSDT"}]',
    '[{"id":1e3,"symbol":"BTCUSDT"}]',
    '[{"id":1,"id":2,"symbol":"BTCUSDT"}]',
    `${'['.repeat(18)}0${']'.repeat(18)}`,
  ]) {
    const rejected = binance.createBinanceClient({
      fetch: async () => new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      nowMs: () => 1_800_000_000_000,
    });
    await assert.rejects(
      rejected.get('userTrades', { symbol: 'BTCUSDT' }, credentials),
      (error) => error?.code === 'UPSTREAM_UNAVAILABLE',
    );
  }
});

test('Binance client retries -1021 exactly once after time sync and classifies 429, 418, auth, and 451', async () => {
  assert.equal(typeof binance.createBinanceClient, 'function');
  const calls = [];
  const queue = [
    jsonResponse({ code: -1021, msg: 'timestamp outside recvWindow' }, { status: 400 }),
    jsonResponse({ serverTime: 1_800_000_000_250 }),
    jsonResponse([{ id: 1 }]),
  ];
  const client = binance.createBinanceClient({
    fetch: async (input) => {
      calls.push(new URL(String(input)).pathname);
      return queue.shift();
    },
    nowMs: () => 1_800_000_000_000,
  });
  assert.deepEqual(await client.get('userTrades', { symbol: 'BTCUSDT' }, {
    apiKey: API_KEY,
    apiSecret: API_SECRET,
  }), [{ id: '1' }]);
  assert.deepEqual(calls, ['/fapi/v1/userTrades', '/fapi/v1/time', '/fapi/v1/userTrades']);

  for (const scenario of [
    { response: jsonResponse({}, { status: 429, headers: { 'Retry-After': '7' } }), code: 'RATE_LIMITED', retryAfter: 7 },
    { response: jsonResponse({}, { status: 418, headers: { 'Retry-After': '31' } }), code: 'GLOBAL_CIRCUIT_OPEN', retryAfter: 31 },
    { response: jsonResponse({ code: -2015 }, { status: 401 }), code: 'AUTH_DISABLED', retryAfter: 0 },
    { response: jsonResponse({}, { status: 451 }), code: 'GEO_RESTRICTED', retryAfter: 0 },
  ]) {
    const events = [];
    const failing = binance.createBinanceClient({
      fetch: async () => scenario.response,
      nowMs: () => 1_800_000_000_000,
      onGlobalCircuit: (seconds) => events.push(['circuit', seconds]),
      onAuthDisabled: () => events.push(['auth']),
    });
    await assert.rejects(
      failing.get('userTrades', { symbol: 'BTCUSDT' }, { apiKey: API_KEY, apiSecret: API_SECRET }),
      (error) => error?.code === scenario.code
        && error.retryAfterSeconds === scenario.retryAfter
        && !/timestamp outside|API_KEY|API_SECRET/.test(String(error.message)),
    );
    if (scenario.code === 'GLOBAL_CIRCUIT_OPEN') assert.deepEqual(events, [['circuit', 31]]);
    if (scenario.code === 'AUTH_DISABLED') assert.deepEqual(events, [['auth']]);
  }
});
