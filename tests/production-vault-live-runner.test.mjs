import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../scripts/run-production-vault-live.mjs', import.meta.url));
const runnerModule = await import('../scripts/run-production-vault-live.mjs');
const livePrefix = 'RV_PRODUCTION_VAULT_';
const projectRef = 'abcdefghijklmnopqrst';
const userBId = '00000000-0000-4000-8000-000000000002';
const userBSessionId = '10000000-0000-4000-8000-000000000002';

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function freshUserBJwt(now) {
  const nowSeconds = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    aud: 'authenticated',
    role: 'authenticated',
    sub: userBId,
    session_id: userBSessionId,
    is_anonymous: false,
    iat: nowSeconds,
    exp: nowSeconds + 900,
    amr: [{ method: 'otp', timestamp: nowSeconds }],
  })}.test-signature`;
}

function liveSemaphoreInputs(fetchImpl, now = Date.UTC(2026, 7, 30, 12, 0, 0)) {
  return {
    projectRef,
    managementToken: 'sbp_test_management_marker_1234567890',
    supabaseUrl: `https://${projectRef}.supabase.co`,
    publishableKey: 'sb_publishable_test_marker_1234567890',
    userBId,
    userBAccessToken: freshUserBJwt(now),
    fetchImpl,
    now,
  };
}

function cleanEnvironment(overrides = {}) {
  return Object.fromEntries([
    ...Object.entries(process.env).filter(([key]) => (
      !key.startsWith(livePrefix)
      && key !== 'RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN'
      && key !== 'RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64'
      && !key.startsWith('RV_PRODUCTION_CONTROL_PLANE_')
    )),
    ...Object.entries(overrides),
  ]);
}

test('required production live runner fails before Vitest when variables are absent', () => {
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment(),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refused: 12 required process variables are missing/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SKIP production vault live gate/i);
});

test('required production live runner never echoes supplied secret values', () => {
  const marker = 'private-live-runner-marker-do-not-echo';
  const managementMarker = 'private-management-token-marker-do-not-echo';
  const attestationMarker = 'private-attestation-key-marker-do-not-echo';
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment({
      RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN: marker,
      RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN: managementMarker,
      RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64: attestationMarker,
    }),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refused: 9 required process variables are missing/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(managementMarker));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(attestationMarker));
});

test('required production live runner requires Management API evidence instead of self-reported flags', () => {
  const oldRequired = {
    RV_PRODUCTION_VAULT_URL: 'unread-placeholder',
    RV_PRODUCTION_VAULT_PUBLISHABLE_KEY: 'public-browser-key-placeholder',
    RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
    RV_PRODUCTION_VAULT_APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
    RV_PRODUCTION_VAULT_TEST_USER_A_ID: '00000000-0000-4000-8000-000000000001',
    RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN: 'token-a-placeholder',
    RV_PRODUCTION_VAULT_TEST_USER_B_ID: '00000000-0000-4000-8000-000000000002',
    RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN: 'token-b-placeholder',
    RV_PRODUCTION_VAULT_SOURCE_COMMIT: 'a'.repeat(40),
    RV_PRODUCTION_VAULT_LIVE_ACK: 'ack-placeholder',
    RV_AUTH_OK: '1',
    RV_SMTP_OK: '1',
    RV_CRON_OK: '1',
  };
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment(oldRequired),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refused: 2 required process variables are missing/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /token-a-placeholder|token-b-placeholder/);
});

test('runner rejects invalid custody material before Management API access', () => {
  const marker = 'private-attestation-material-that-must-never-echo';
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment({
      RV_PRODUCTION_VAULT_URL: 'unread-placeholder',
      RV_PRODUCTION_VAULT_PUBLISHABLE_KEY: 'public-browser-key-placeholder',
      RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
      RV_PRODUCTION_VAULT_APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
      RV_PRODUCTION_VAULT_TEST_USER_A_ID: '00000000-0000-4000-8000-000000000001',
      RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN: 'token-a-placeholder',
      RV_PRODUCTION_VAULT_TEST_USER_B_ID: '00000000-0000-4000-8000-000000000002',
      RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN: 'token-b-placeholder',
      RV_PRODUCTION_VAULT_SOURCE_COMMIT: 'a'.repeat(40),
      RV_PRODUCTION_VAULT_LIVE_ACK: 'ack-placeholder',
      RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN: 'management-placeholder-token',
      RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64: marker,
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /attestation key is invalid/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /api\.supabase\.com|VITE_PRODUCTION_LIVE_GATE_/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(marker));
});

test('live runner rejects operations signing secrets in the same process without echoing them', () => {
  const operationsMarker = 'private-operations-marker-that-must-never-echo';
  const liveMarker = 'private-live-marker-that-must-never-echo';
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment({
      RV_PRODUCTION_VAULT_URL: 'unread-placeholder',
      RV_PRODUCTION_VAULT_PUBLISHABLE_KEY: 'public-browser-key-placeholder',
      RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
      RV_PRODUCTION_VAULT_APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
      RV_PRODUCTION_VAULT_TEST_USER_A_ID: '00000000-0000-4000-8000-000000000001',
      RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN: 'token-a-placeholder',
      RV_PRODUCTION_VAULT_TEST_USER_B_ID: '00000000-0000-4000-8000-000000000002',
      RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN: 'token-b-placeholder',
      RV_PRODUCTION_VAULT_SOURCE_COMMIT: 'a'.repeat(40),
      RV_PRODUCTION_VAULT_LIVE_ACK: 'ack-placeholder',
      RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN: 'management-placeholder-token',
      RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64: liveMarker,
      RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64: operationsMarker,
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operations signer secrets share its process scope/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(`${operationsMarker}|${liveMarker}`));
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /api\.supabase\.com/);
});

test('private attestation material is removed from the Vitest child and spec cannot emit signed VITE markers', () => {
  const runnerSource = fs.readFileSync(runner, 'utf8');
  const specSource = fs.readFileSync(fileURLToPath(new URL('./production-vault-live.spec.mjs', import.meta.url)), 'utf8');
  assert.match(runnerSource, /delete childEnvironment\.RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN/);
  assert.match(runnerSource, /delete childEnvironment\.RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64/);
  assert.ok(
    runnerSource.indexOf('await verifyProductionDatabaseSemaphoreLive({')
      < runnerSource.indexOf("const result = spawnSync(executable"),
    'database semaphore proof must complete in the parent before Vitest starts',
  );
  assert.doesNotMatch(specSource, /VITE_PRODUCTION_LIVE_GATE_(?:RECEIPT|SIGNATURE)=/);
  assert.match(specSource, /fs\.openSync\(config\.receiptOutputFile, 'wx'/);
});

test('live semaphore SQL holds the exact ten transaction slots and observes one complete holder', () => {
  const holder = runnerModule.PRODUCTION_SEMAPHORE_HOLDER_QUERY;
  const observation = runnerModule.PRODUCTION_SEMAPHORE_OBSERVATION_QUERY;
  assert.match(holder, /^with held_slots as materialized/);
  assert.match(holder, /generate_series\(0, 9\)/);
  assert.match(holder, /pg_advisory_xact_lock\(187904819, slot_id\)/);
  assert.match(holder, /pg_sleep\(3\)/);
  assert.match(holder, /select count\(\*\) as held_slot_count/);
  assert.doesNotMatch(holder, /\bbegin\b|\bcommit\b|\bdo\b|pg_try_advisory|pg_sleep\((?:[4-9]|[1-9][0-9])/i);
  assert.match(observation, /from pg_catalog\.pg_locks/);
  assert.match(observation, /classid = 187904819::oid/);
  assert.match(observation, /objid::bigint between 0 and 9/);
  assert.match(observation, /objsubid = 2/);
  assert.match(observation, /group by l\.pid[\s\S]*count\(distinct l\.objid\) = 10/);
});

test('live semaphore proof observes P0005 before natural release and succeeds afterward', async () => {
  const holder = deferred();
  const calls = [];
  let rpcAttempt = 0;
  const fetchImpl = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, query: parsedBody.query ?? null });
    if (url.endsWith('/database/query/read-only')) {
      if (parsedBody.query === runnerModule.PRODUCTION_SEMAPHORE_HOLDER_QUERY) return await holder.promise;
      return jsonResponse([{ all_slots_held: true }], 201);
    }
    assert.match(url, /\/rest\/v1\/rpc\/rv_list_workspaces$/);
    rpcAttempt += 1;
    if (rpcAttempt === 1) {
      holder.resolve(jsonResponse([], 201));
      return jsonResponse({ code: 'P0005', message: 'bounded rejection' }, 400);
    }
    return jsonResponse([], 200);
  };

  const result = await runnerModule.verifyProductionDatabaseSemaphoreLive(liveSemaphoreInputs(fetchImpl));
  assert.deepEqual(result, { p0005Observed: true, released: true });
  assert.deepEqual(calls.map((call) => (
    call.query === runnerModule.PRODUCTION_SEMAPHORE_HOLDER_QUERY ? 'holder'
      : call.query === runnerModule.PRODUCTION_SEMAPHORE_OBSERVATION_QUERY ? 'observe'
        : 'rpc'
  )), ['holder', 'observe', 'rpc', 'rpc']);
  assert.equal(calls[0].query, runnerModule.PRODUCTION_SEMAPHORE_HOLDER_QUERY);
  assert.equal(calls[1].query, runnerModule.PRODUCTION_SEMAPHORE_OBSERVATION_QUERY);
  assert.match(calls[0].headers.Authorization, /^Bearer sbp_test_management_marker_/);
  assert.match(calls[1].headers.Authorization, /^Bearer sbp_test_management_marker_/);
  assert.doesNotMatch(JSON.stringify(calls.slice(2)), /sbp_test_management_marker_/);
  assert.equal(rpcAttempt, 2);
});

test('live semaphore proof awaits holder cleanup before failing a wrong rejection', async () => {
  const holder = deferred();
  const wrongRejectionSeen = deferred();
  let rpcAttempt = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/database/query/read-only')) {
      const parsedBody = JSON.parse(init.body);
      if (parsedBody.query === runnerModule.PRODUCTION_SEMAPHORE_HOLDER_QUERY) return await holder.promise;
      return jsonResponse([{ all_slots_held: true }], 201);
    }
    rpcAttempt += 1;
    wrongRejectionSeen.resolve();
    return jsonResponse({ code: 'P0004', message: 'wrong rejection' }, 400);
  };

  let settled = false;
  const observed = runnerModule.verifyProductionDatabaseSemaphoreLive(liveSemaphoreInputs(fetchImpl))
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    )
    .finally(() => { settled = true; });
  await wrongRejectionSeen.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'proof failed before the lock-holder request naturally completed');
  holder.resolve(jsonResponse([], 201));
  const outcome = await observed;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /P0005_NOT_OBSERVED/);
  assert.equal(rpcAttempt, 1, 'release-success probe must not run after a failed P0005 assertion');
});

test('runner finally cleanup contract removes every required and internal process variable', () => {
  const environment = Object.fromEntries(
    runnerModule.PRODUCTION_LIVE_CLEANUP_KEYS.map((key) => [key, `marker-${key}`]),
  );
  for (const key of runnerModule.PRODUCTION_LIVE_REQUIRED_KEYS) {
    assert.ok(runnerModule.PRODUCTION_LIVE_CLEANUP_KEYS.includes(key), `${key} is missing from cleanup`);
  }
  for (const key of runnerModule.PRODUCTION_LIVE_FORBIDDEN_OPERATIONS_SECRET_KEYS) {
    assert.ok(runnerModule.PRODUCTION_LIVE_CLEANUP_KEYS.includes(key), `${key} is missing from cleanup`);
  }
  runnerModule.clearProductionLiveProcessEnvironment(environment);
  assert.deepEqual(environment, {});
  const runnerSource = fs.readFileSync(runner, 'utf8');
  assert.match(runnerSource, /finally\s*\{\s*clearProductionLiveProcessEnvironment\(\)/s);
});
