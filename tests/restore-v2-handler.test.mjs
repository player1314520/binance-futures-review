import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  createRestoreV2Handler,
  RestoreV2Error,
} from '../supabase/functions/restore-v2/handler.mjs';
import { createRestoreV2Runtime } from '../supabase/functions/restore-v2/runtime.mjs';

const OWNER_RECOVERY_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const TEST_SUPABASE_URL = `https://${'a'.repeat(20)}.supabase.co`;

function request(path, {
  method = 'POST', token = 'service-token-value', body = {}, origin,
  accessControlRequestMethod, accessControlRequestHeaders,
} = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (origin !== undefined) headers.origin = origin;
  if (accessControlRequestMethod !== undefined) {
    headers['access-control-request-method'] = accessControlRequestMethod;
  }
  if (accessControlRequestHeaders !== undefined) {
    headers['access-control-request-headers'] = accessControlRequestHeaders;
  }
  return new Request(`https://project.supabase.co/functions/v1/restore-v2${path}`, {
    method,
    headers,
    body: ['GET', 'OPTIONS'].includes(method) ? undefined : JSON.stringify(body),
  });
}

function monitoredRequest(path, {
  method = 'POST', token, bodyText = '{', declaredBytes = 7 * 1024 * 1024,
  origin, functionPrefix = '/functions/v1/restore-v2',
} = {}) {
  const headers = {
    'content-type': 'application/json',
    'content-length': String(declaredBytes),
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (origin !== undefined) headers.origin = origin;
  const value = new Request(`https://project.supabase.co${functionPrefix}${path}`, {
    method,
    headers,
    body: bodyText,
  });
  let readerCalls = 0;
  const stream = value.body;
  const originalGetReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, 'getReader', {
    configurable: true,
    value: (...args) => {
      readerCalls += 1;
      return originalGetReader(...args);
    },
  });
  return Object.freeze({ request: value, readerCalls: () => readerCalls });
}

function dependencies(overrides = {}) {
  return {
    ownerRecoveryOrigin: OWNER_RECOVERY_ORIGIN,
    verifyServiceRole: async token => token === 'service-token-value',
    verifyUserToken: async token => token === 'user-token-value'
      ? { userId: '70000000-0000-4000-8000-000000000001', email: 'owner@example.test', emailVerified: true }
      : null,
    getVerifiedRecoveryTag: async subject => ({
      subject,
      principalLineageId: '20000000-0000-4000-8000-000000000001',
      recoveryTag: 'a'.repeat(64),
    }),
    createDeletionIntent: async () => ({ state: 'PENDING_JOURNAL' }),
    attestDeletionJournal: async () => ({ state: 'JOURNALED' }),
    executeDeletion: async () => ({ state: 'DELETED' }),
    claimRestore: async () => ({ state: 'STAGING' }),
    stageRestoreBatch: async () => ({ state: 'STAGING', accepted: true }),
    issueOwnerInvite: async () => ({ state: 'INVITED' }),
    claimOwner: async input => ({ state: 'CLAIMED', claimedUserId: input.user.userId }),
    recoverOwner: async () => ({
      format: 'rv-restore-v2-owner-recovery/1', state: 'CLAIMED', claimed: true,
      idempotent: false, remainingOwnerClaims: 0, inviteClaimDisclosed: false,
    }),
    publishRestore: async () => ({ state: 'PUBLISHED', published: true, credentialsRestored: 0 }),
    getRestoreStatus: async () => ({ state: 'NOT_READY', published: false }),
    ...overrides,
  };
}

test('recovery tag is derived from Auth identity and body email is rejected', async () => {
  const handler = createRestoreV2Handler(dependencies());
  const rejected = await handler(request('/internal/v2/recovery/tag', {
    body: { subject: '70000000-0000-4000-8000-000000000001', email: 'attacker@example.test' },
  }));
  assert.equal(rejected.status, 400);
  const accepted = await handler(request('/internal/v2/recovery/tag', {
    body: { subject: '70000000-0000-4000-8000-000000000001' },
  }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.has('access-control-allow-origin'), false);
});

test('owner recovery claim binds the verified new auth uid and cannot accept body identity', async () => {
  let seen;
  const handler = createRestoreV2Handler(dependencies({
    claimOwner: async input => { seen = input; return { state: 'CLAIMED', claimedUserId: input.user.userId }; },
  }));
  const response = await handler(request('/internal/v2/restore/owner-claim', {
    token: 'user-token-value',
    body: {
      restoreId: '80000000-0000-4000-8000-000000000001',
      principalLineageId: '20000000-0000-4000-8000-000000000001',
      inviteClaim: 'b'.repeat(64),
    },
  }));
  assert.equal(response.status, 200);
  assert.equal(seen.user.userId, '70000000-0000-4000-8000-000000000001');
  assert.equal(seen.user.emailVerified, true);
});

test('owner self-recovery accepts only exact restoreId under a verified user JWT', async () => {
  let seen;
  const handler = createRestoreV2Handler(dependencies({
    recoverOwner: async input => {
      seen = input;
      return {
        format: 'rv-restore-v2-owner-recovery/1', state: 'CLAIMED', claimed: true,
        idempotent: false, remainingOwnerClaims: 0, inviteClaimDisclosed: false,
      };
    },
  }));
  const denied = await handler(request('/internal/v2/restore/owner-recover', {
    token: 'service-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    body: { restoreId: '80000000-0000-4000-8000-000000000001' },
  }));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), OWNER_RECOVERY_ORIGIN);
  assert.equal(denied.headers.has('access-control-allow-credentials'), false);
  const extraIdentity = await handler(request('/internal/v2/restore/owner-recover', {
    token: 'user-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    body: {
      restoreId: '80000000-0000-4000-8000-000000000001',
      subject: '70000000-0000-4000-8000-000000000099',
    },
  }));
  assert.equal(extraIdentity.status, 400);
  const accepted = await handler(request('/internal/v2/restore/owner-recover', {
    token: 'user-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    body: { restoreId: '80000000-0000-4000-8000-000000000001' },
  }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('access-control-allow-origin'), OWNER_RECOVERY_ORIGIN);
  assert.equal(accepted.headers.get('vary'), 'Origin');
  assert.equal(accepted.headers.has('access-control-allow-credentials'), false);
  assert.deepEqual(seen, {
    restoreId: '80000000-0000-4000-8000-000000000001',
    user: {
      userId: '70000000-0000-4000-8000-000000000001',
      email: 'owner@example.test',
      emailVerified: true,
    },
  });
  assert.equal((await accepted.json()).inviteClaimDisclosed, false);
  assert.equal(accepted.headers.get('access-control-allow-origin'), OWNER_RECOVERY_ORIGIN);
  assert.equal(accepted.headers.get('vary'), 'Origin');
  assert.equal(accepted.headers.has('access-control-allow-credentials'), false);
});

test('owner self-recovery response fails closed if invite material escapes a dependency', async () => {
  const handler = createRestoreV2Handler(dependencies({
    recoverOwner: async () => ({
      state: 'CLAIMED', inviteClaim: 'c'.repeat(64), inviteClaimDisclosed: false,
    }),
  }));
  const response = await handler(request('/internal/v2/restore/owner-recover', {
    token: 'user-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    body: { restoreId: '80000000-0000-4000-8000-000000000001' },
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'OPERATION_UNAVAILABLE');
});

test('owner self-recovery hides absent, cross-user and ambiguous matches behind one 404', async () => {
  const bodies = [];
  for (const simulated of ['ABSENT', 'CROSS_USER', 'AMBIGUOUS']) {
    const handler = createRestoreV2Handler(dependencies({
      recoverOwner: async () => {
        throw new RestoreV2Error('RESOURCE_NOT_FOUND', simulated);
      },
    }));
    const response = await handler(request('/internal/v2/restore/owner-recover', {
      token: 'user-token-value',
      origin: OWNER_RECOVERY_ORIGIN,
      body: { restoreId: '80000000-0000-4000-8000-000000000001' },
    }));
    assert.equal(response.status, 404);
    bodies.push(await response.json());
  }
  assert.deepEqual(bodies, [
    { error: 'not_found', code: 'RESOURCE_NOT_FOUND' },
    { error: 'not_found', code: 'RESOURCE_NOT_FOUND' },
    { error: 'not_found', code: 'RESOURCE_NOT_FOUND' },
  ]);
});

test('restore runtime forwards only JWT-derived subject to the owner recovery RPC', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const calls = [];
  const env = new Map([
    ['SUPABASE_URL', TEST_SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value-that-is-long-enough'],
    ['SUPABASE_ANON_KEY', 'anonymous-key-value-that-is-long-enough'],
    ['RESTORE_V2_MANIFEST_KEY_ID', 'restore-v2-test-key'],
    ['RESTORE_V2_MANIFEST_PUBLIC_KEY_PEM', publicKey.export({ type: 'spki', format: 'pem' })],
    ['RESTORE_V2_USER_ORIGIN', OWNER_RECOVERY_ORIGIN],
  ]);
  const runtime = createRestoreV2Runtime({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        format: 'rv-restore-v2-owner-recovery/1', state: 'CLAIMED', claimed: true,
        idempotent: false, remainingOwnerClaims: 0, inviteClaimDisclosed: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await runtime.recoverOwner({
    restoreId: '80000000-0000-4000-8000-000000000001',
    user: { userId: '70000000-0000-4000-8000-000000000001' },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/rv2_restore_v2_recover_owner_by_verified_subject$/u);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_restore_id: '80000000-0000-4000-8000-000000000001',
    p_subject: '70000000-0000-4000-8000-000000000001',
  });
  assert.doesNotMatch(calls[0].options.body, /email|invite/iu);
});

test('restore runtime maps owner recovery mismatch and ambiguity to the same result', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const env = new Map([
    ['SUPABASE_URL', TEST_SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value-that-is-long-enough'],
    ['SUPABASE_ANON_KEY', 'anonymous-key-value-that-is-long-enough'],
    ['RESTORE_V2_MANIFEST_KEY_ID', 'restore-v2-test-key'],
    ['RESTORE_V2_MANIFEST_PUBLIC_KEY_PEM', publicKey.export({ type: 'spki', format: 'pem' })],
    ['RESTORE_V2_USER_ORIGIN', OWNER_RECOVERY_ORIGIN],
  ]);
  for (const databaseCode of ['P0002', '40001']) {
    const runtime = createRestoreV2Runtime({
      env,
      fetchImpl: async () => new Response(JSON.stringify({ code: databaseCode }), {
        status: databaseCode === '40001' ? 409 : 400,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      runtime.recoverOwner({
        restoreId: '80000000-0000-4000-8000-000000000001',
        user: { userId: '70000000-0000-4000-8000-000000000001' },
      }),
      error => error?.code === 'RESOURCE_NOT_FOUND',
    );
  }
});

test('restore runtime refuses a missing or drifted owner recovery Origin binding', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const base = new Map([
    ['SUPABASE_URL', TEST_SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', 'service-role-key-value-that-is-long-enough'],
    ['SUPABASE_ANON_KEY', 'anonymous-key-value-that-is-long-enough'],
    ['RESTORE_V2_MANIFEST_KEY_ID', 'restore-v2-test-key'],
    ['RESTORE_V2_MANIFEST_PUBLIC_KEY_PEM', publicKey.export({ type: 'spki', format: 'pem' })],
    ['RESTORE_V2_USER_ORIGIN', OWNER_RECOVERY_ORIGIN],
  ]);
  const missing = new Map(base);
  missing.delete('RESTORE_V2_USER_ORIGIN');
  const drifted = new Map(base);
  drifted.set('RESTORE_V2_USER_ORIGIN', 'https://preview.invalid');
  for (const env of [missing, drifted]) {
    assert.throws(
      () => createRestoreV2Runtime({ env, fetchImpl: async () => new Response() }),
      error => error?.code === 'OPERATION_UNAVAILABLE',
    );
  }
});

test('service routes authenticate before reading or parsing an untrusted near-limit body', async () => {
  let serviceChecks = 0;
  let stageCalls = 0;
  const handler = createRestoreV2Handler(dependencies({
    verifyServiceRole: async token => {
      serviceChecks += 1;
      return token === 'service-token-value';
    },
    stageRestoreBatch: async () => {
      stageCalls += 1;
      return { state: 'STAGING', accepted: true };
    },
  }));

  const missing = monitoredRequest('/internal/v2/restore/stage');
  const missingResponse = await handler(missing.request);
  assert.equal(missingResponse.status, 401);
  assert.equal(missing.readerCalls(), 0);
  assert.equal(serviceChecks, 0);
  assert.equal(stageCalls, 0);

  const wrong = monitoredRequest('/internal/v2/restore/stage', {
    token: 'wrong-service-token-value',
  });
  const wrongResponse = await handler(wrong.request);
  assert.equal(wrongResponse.status, 401);
  assert.equal(wrong.readerCalls(), 0);
  assert.equal(serviceChecks, 1);
  assert.equal(stageCalls, 0);
});

test('user routes authenticate before reading or parsing an untrusted body', async () => {
  let userChecks = 0;
  let ownerClaimCalls = 0;
  let ownerRecoverCalls = 0;
  const handler = createRestoreV2Handler(dependencies({
    verifyUserToken: async token => {
      userChecks += 1;
      return token === 'user-token-value'
        ? {
            userId: '70000000-0000-4000-8000-000000000001',
            email: 'owner@example.test',
            emailVerified: true,
          }
        : null;
    },
    claimOwner: async () => {
      ownerClaimCalls += 1;
      return { state: 'CLAIMED' };
    },
    recoverOwner: async () => {
      ownerRecoverCalls += 1;
      return {
        format: 'rv-restore-v2-owner-recovery/1', state: 'CLAIMED', claimed: true,
        idempotent: false, remainingOwnerClaims: 0, inviteClaimDisclosed: false,
      };
    },
  }));

  const missingClaim = monitoredRequest('/internal/v2/restore/owner-claim', {
    declaredBytes: 7 * 1024 * 1024,
  });
  const missingClaimResponse = await handler(missingClaim.request);
  assert.equal(missingClaimResponse.status, 401);
  assert.equal(missingClaim.readerCalls(), 0);
  assert.equal(userChecks, 0);
  assert.equal(ownerClaimCalls, 0);

  const missingRecover = monitoredRequest('/internal/v2/restore/owner-recover', {
    origin: OWNER_RECOVERY_ORIGIN,
    declaredBytes: 7 * 1024 * 1024,
  });
  const missingRecoverResponse = await handler(missingRecover.request);
  assert.equal(missingRecoverResponse.status, 401);
  assert.equal(missingRecoverResponse.headers.get('access-control-allow-origin'),
    OWNER_RECOVERY_ORIGIN);
  assert.equal(missingRecover.readerCalls(), 0);
  assert.equal(userChecks, 0);
  assert.equal(ownerRecoverCalls, 0);

  const wrongRecover = monitoredRequest('/internal/v2/restore/owner-recover', {
    token: 'wrong-user-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    declaredBytes: 7 * 1024 * 1024,
  });
  const wrongRecoverResponse = await handler(wrongRecover.request);
  assert.equal(wrongRecoverResponse.status, 401);
  assert.equal(wrongRecover.readerCalls(), 0);
  assert.equal(userChecks, 1);
  assert.equal(ownerRecoverCalls, 0);
});

test('owner self-recovery enforces its 1024-byte cap only after user authentication', async () => {
  let userChecks = 0;
  let recoverCalls = 0;
  const handler = createRestoreV2Handler(dependencies({
    verifyUserToken: async () => {
      userChecks += 1;
      return {
        userId: '70000000-0000-4000-8000-000000000001',
        email: 'owner@example.test',
        emailVerified: true,
      };
    },
    recoverOwner: async () => {
      recoverCalls += 1;
      return { state: 'CLAIMED', inviteClaimDisclosed: false };
    },
  }));
  const oversized = monitoredRequest('/internal/v2/restore/owner-recover', {
    token: 'user-token-value',
    origin: OWNER_RECOVERY_ORIGIN,
    bodyText: '{}',
    declaredBytes: 1025,
  });
  const response = await handler(oversized.request);
  assert.equal(response.status, 400);
  assert.equal(oversized.readerCalls(), 0);
  assert.equal(userChecks, 1);
  assert.equal(recoverCalls, 0);
});

test('unknown routes and wrong methods reject without auth or body reads', async () => {
  let serviceChecks = 0;
  let userChecks = 0;
  const handler = createRestoreV2Handler(dependencies({
    verifyServiceRole: async () => { serviceChecks += 1; return true; },
    verifyUserToken: async () => { userChecks += 1; return null; },
  }));
  for (const candidate of [
    monitoredRequest('/not-a-route', { token: 'service-token-value' }),
    monitoredRequest('/internal/v2/restore/%73tage', { token: 'service-token-value' }),
    monitoredRequest('/internal/v2/restore/stage', {
      token: 'service-token-value', functionPrefix: '/x/restore-v2',
    }),
    monitoredRequest('/internal/v2/restore/stage', {
      method: 'PUT', token: 'service-token-value',
    }),
  ]) {
    const response = await handler(candidate.request);
    assert.ok([400, 404].includes(response.status));
    assert.equal(candidate.readerCalls(), 0);
  }
  assert.equal(serviceChecks, 0);
  assert.equal(userChecks, 0);
});

test('membership staging rejects non-owner rows idempotently before any database call', async () => {
  let calls = 0;
  const handler = createRestoreV2Handler(dependencies({
    stageRestoreBatch: async () => {
      calls += 1;
      return { state: 'STAGING', accepted: true, idempotent: calls > 1 };
    },
  }));
  const base = {
    restoreId: '80000000-0000-4000-8000-000000000001',
    batchIndex: 0,
    totalBatches: 1,
    idempotencyKey: '90000000-0000-4000-8000-000000000001',
  };
  const invalidPayloads = [
    { memberRole: 'MEMBER', status: 'ACTIVE' },
    { memberRole: 'owner', status: 'ACTIVE' },
    { memberRole: 1, status: 'ACTIVE' },
    { memberRole: 'OWNER', status: 'INACTIVE' },
    { status: 'ACTIVE' },
  ];
  for (const payload of invalidPayloads) {
    const body = { ...base, rows: [{ dataset: 'memberships', payload }] };
    const first = await handler(request('/internal/v2/restore/stage', { body }));
    const replay = await handler(request('/internal/v2/restore/stage', { body }));
    assert.equal(first.status, 400);
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), await first.json());
  }
  assert.equal(calls, 0);

  const owner = {
    ...base,
    rows: [{
      dataset: 'memberships',
      payload: { memberRole: 'OWNER', status: 'ACTIVE' },
    }],
  };
  const accepted = await handler(request('/internal/v2/restore/stage', { body: owner }));
  const acceptedReplay = await handler(request('/internal/v2/restore/stage', { body: owner }));
  assert.equal(accepted.status, 200);
  assert.equal(acceptedReplay.status, 200);
  assert.equal((await accepted.json()).idempotent, false);
  assert.equal((await acceptedReplay.json()).idempotent, true);
  assert.equal(calls, 2);
});

test('publish is service-only and legacy v1 stays LEGACY_UNTRUSTED', async () => {
  const handler = createRestoreV2Handler(dependencies());
  const denied = await handler(request('/internal/v2/restore/publish', {
    token: 'user-token-value',
    body: {
      restoreId: '80000000-0000-4000-8000-000000000001',
      journalProof: {},
    },
  }));
  assert.equal(denied.status, 401);
  const legacy = await handler(request('/internal/v2/restore/claim', {
    body: {
      envelope: { format: 'review-workbench-beta-signed-manifest/1' },
      journalProof: {},
    },
  }));
  assert.equal(legacy.status, 409);
  assert.equal((await legacy.json()).code, 'LEGACY_UNTRUSTED');
});

test('publish requires and forwards a final journal proof', async () => {
  let seen;
  const handler = createRestoreV2Handler(dependencies({
    publishRestore: async input => {
      seen = input;
      return { state: 'PUBLISHED', published: true, credentialsRestored: 0 };
    },
  }));
  const missing = await handler(request('/internal/v2/restore/publish', {
    body: { restoreId: '80000000-0000-4000-8000-000000000001' },
  }));
  assert.equal(missing.status, 400);
  const accepted = await handler(request('/internal/v2/restore/publish', {
    body: {
      restoreId: '80000000-0000-4000-8000-000000000001',
      journalProof: { format: 'rv-deletion-journal-range-proof/2' },
    },
  }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(seen.journalProof, { format: 'rv-deletion-journal-range-proof/2' });
});

test('only exact owner-recover opens bounded CORS to the canonical web origin', async () => {
  const handler = createRestoreV2Handler(dependencies());
  const preflight = await handler(request('/internal/v2/restore/owner-recover', {
    method: 'OPTIONS',
    origin: OWNER_RECOVERY_ORIGIN,
    accessControlRequestMethod: 'POST',
    accessControlRequestHeaders: 'Authorization, ApiKey, Content-Type',
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), OWNER_RECOVERY_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(preflight.headers.get('access-control-allow-headers'),
    'apikey, authorization, content-type');
  assert.equal(preflight.headers.get('access-control-max-age'), '600');
  assert.equal(preflight.headers.get('vary'), 'Origin');
  assert.equal(preflight.headers.has('access-control-allow-credentials'), false);

  for (const origin of [undefined, 'https://attacker.invalid']) {
    const denied = await handler(request('/internal/v2/restore/owner-recover', {
      token: 'user-token-value', origin,
      body: { restoreId: '80000000-0000-4000-8000-000000000001' },
    }));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has('access-control-allow-origin'), false);
  }

  const extraHeader = await handler(request('/internal/v2/restore/owner-recover', {
    method: 'OPTIONS',
    origin: OWNER_RECOVERY_ORIGIN,
    accessControlRequestMethod: 'POST',
    accessControlRequestHeaders: 'authorization, content-type, x-client-info',
  }));
  assert.equal(extraHeader.status, 400);

  for (const target of [
    '/internal/v2/restore/status',
    '/internal/v2/restore/owner-claim',
    '/internal/v2/restore/owner-%72ecover',
    '/not-a-route',
  ]) {
    const response = await handler(request(target, {
      method: 'OPTIONS',
      origin: OWNER_RECOVERY_ORIGIN,
      accessControlRequestMethod: 'POST',
      accessControlRequestHeaders: 'authorization, apikey, content-type',
    }));
    assert.ok([404, 405].includes(response.status));
    assert.equal(response.headers.has('access-control-allow-origin'), false);
  }
});
