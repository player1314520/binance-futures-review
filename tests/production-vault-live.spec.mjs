import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, test } from 'vitest';
import { productionLiveContractSha256 } from '../app/production-live-contract.mjs';
import { PRODUCTION_LIVE_ATTESTATION_KEY_ID } from '../app/production-live-attestation.mjs';
import {
  PRODUCTION_LIVE_GATE_CHECKS,
  PRODUCTION_LIVE_GATE_CONTRACT_DOMAIN,
  PRODUCTION_LIVE_GATE_CONTRACT_FILES,
  PRODUCTION_LIVE_GATE_RECEIPT_FORMAT,
  PRODUCTION_LIVE_GATE_SOURCE_OVERRIDES,
  PRODUCTION_LIVE_GATE_TEST_VERSION,
} from '../app/src/lib/release-config.ts';
import {
  canonicalProductionControlPlaneEvidence,
  parseCanonicalProductionControlPlaneEvidence,
} from '../scripts/verify-production-control-plane.mjs';
import {
  decryptVaultPayload,
  deserializeVaultEnvelope,
  encryptVaultPayload,
  serializeVaultEnvelope,
} from '../app/src/lib/vault-crypto.ts';
import {
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  SupabaseVaultRepository,
  VaultRepositoryError,
} from '../app/src/lib/vault-repository.ts';
import {
  VAULT_PUBLISH_PROTOCOL_VERSION,
  VAULT_SIGNING_ALGORITHM,
  generateVaultSigningKeyPair,
  sha256Hex,
  signVaultObject,
  verifyVaultObjectSignature,
} from '../app/src/lib/vault-signing.ts';

const ENVIRONMENT_KEYS = Object.freeze([
  'RV_PRODUCTION_VAULT_URL',
  'RV_PRODUCTION_VAULT_PUBLISHABLE_KEY',
  'RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF',
  'RV_PRODUCTION_VAULT_APP_ORIGIN',
  'RV_PRODUCTION_VAULT_TEST_USER_A_ID',
  'RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN',
  'RV_PRODUCTION_VAULT_TEST_USER_B_ID',
  'RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN',
  'RV_PRODUCTION_VAULT_SOURCE_COMMIT',
  'RV_PRODUCTION_VAULT_LIVE_ACK',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_PLANE_EVIDENCE_KEY = 'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE';
const CONTROL_PLANE_EVIDENCE_SHA_KEY = 'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE_SHA';
const RECEIPT_OUTPUT_FILE_KEY = 'RV_PRODUCTION_LIVE_RECEIPT_OUTPUT_FILE';
const RUNNER_NONCE_KEY = 'RV_PRODUCTION_LIVE_RUNNER_NONCE';

const configuredKeys = ENVIRONMENT_KEYS.filter((key) => Boolean(process.env[key]?.trim()));
const liveRunRequired = process.env.RV_PRODUCTION_VAULT_LIVE_REQUIRED === '1';

function decodeJwtPayload(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'test access tokens must be Supabase JWTs');
  const padded = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
  try {
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    return payload;
  } catch {
    assert.fail('test access tokens must contain a valid JWT payload');
  }
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim() ?? '';
  assert.ok(value, `missing required live-test environment variable: ${name}`);
  return value;
}

function exactCleanSourceCommit() {
  const expected = requireEnvironment('RV_PRODUCTION_VAULT_SOURCE_COMMIT');
  assert.match(expected, /^[0-9a-f]{40}$/, 'live gate source commit must be a full lowercase Git SHA');
  const runGit = (args) => spawnSync('git', ['-C', REPOSITORY_ROOT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const head = runGit(['rev-parse', '--verify', 'HEAD']);
  assert.equal(head.status, 0, 'live gate cannot verify the source commit');
  assert.equal(String(head.stdout).trim(), expected, 'live gate source commit does not match HEAD');
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(status.status, 0, 'live gate cannot inspect the source worktree');
  assert.equal(String(status.stdout), '', 'live gate requires a clean exact source commit');
  return expected;
}

function parseTestIdentity(label, expectedUserId, token) {
  assert.match(expectedUserId, UUID_PATTERN, `${label} expected user id must be a UUID`);
  assert.ok(token.length >= 32 && token.length <= 16_384 && !/\s/.test(token), `${label} token is invalid`);
  const payload = decodeJwtPayload(token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authenticatedAudience = payload.aud === 'authenticated'
    || (Array.isArray(payload.aud) && payload.aud.includes('authenticated'));
  const recentOtp = Array.isArray(payload.amr) && payload.amr.some((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && entry.method === 'otp'
    && Number.isInteger(entry.timestamp)
    && entry.timestamp <= nowSeconds + 30
    && nowSeconds - entry.timestamp <= 120
  ));
  assert.equal(payload.role, 'authenticated', `${label} token must have role=authenticated`);
  assert.equal(payload.sub, expectedUserId.toLowerCase(), `${label} token subject does not match the declared test user`);
  assert.equal(authenticatedAudience, true, `${label} token must have the authenticated audience`);
  assert.equal(payload.is_anonymous, false, `${label} token must not be anonymous`);
  assert.match(String(payload.session_id ?? ''), UUID_PATTERN, `${label} token must name a session`);
  assert.ok(Number.isInteger(payload.iat) && payload.iat <= nowSeconds + 30 && nowSeconds - payload.iat <= 120, `${label} token must be issued by a fresh OTP verification`);
  assert.equal(recentOtp, true, `${label} token must contain an OTP AMR timestamp from the last two minutes`);
  assert.ok(Number.isFinite(payload.exp) && Number(payload.exp) > nowSeconds + 300, `${label} token is expired or too close to expiry`);
  return Object.freeze({
    userId: expectedUserId.toLowerCase(),
    sessionId: String(payload.session_id).toLowerCase(),
    token,
  });
}

function parseLiveConfig() {
  for (const key of ENVIRONMENT_KEYS) requireEnvironment(key);

  const rawUrl = requireEnvironment('RV_PRODUCTION_VAULT_URL');
  const expectedProjectRef = requireEnvironment('RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF');
  assert.match(expectedProjectRef, PROJECT_REF_PATTERN, 'expected project ref must be the exact 20-character Supabase ref');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    assert.fail('RV_PRODUCTION_VAULT_URL is not a URL');
  }
  assert.equal(url.protocol, 'https:', 'live tests require HTTPS');
  assert.equal(url.username, '', 'live-test URL must not contain credentials');
  assert.equal(url.password, '', 'live-test URL must not contain credentials');
  assert.equal(url.pathname, '/', 'live-test URL must be the project origin only');
  assert.equal(url.search, '', 'live-test URL must not contain a query');
  assert.equal(url.hash, '', 'live-test URL must not contain a fragment');
  assert.equal(url.hostname, `${expectedProjectRef}.supabase.co`, 'URL hostname does not match the separately declared project ref');

  const appOriginRaw = requireEnvironment('RV_PRODUCTION_VAULT_APP_ORIGIN');
  let appOrigin;
  try {
    appOrigin = new URL(appOriginRaw);
  } catch {
    assert.fail('RV_PRODUCTION_VAULT_APP_ORIGIN is not a URL');
  }
  assert.equal(appOrigin.protocol, 'https:', 'application origin must use HTTPS');
  assert.equal(appOrigin.username, '', 'application origin must not contain credentials');
  assert.equal(appOrigin.password, '', 'application origin must not contain credentials');
  assert.equal(appOrigin.port, '', 'production application origin must not use a custom port');
  assert.equal(appOrigin.pathname, '/', 'application origin must be an origin without a path');
  assert.equal(appOrigin.search, '', 'application origin must not contain a query');
  assert.equal(appOrigin.hash, '', 'application origin must not contain a fragment');
  assert.equal(appOrigin.origin, appOriginRaw.replace(/\/$/, ''), 'application origin must be canonical');
  assert.ok(
    appOrigin.hostname !== 'github.io' && !appOrigin.hostname.endsWith('.github.io'),
    'authenticated production application must not use the shared GitHub Pages origin',
  );

  const publishableKey = requireEnvironment('RV_PRODUCTION_VAULT_PUBLISHABLE_KEY');
  assert.ok(publishableKey.length >= 20 && publishableKey.length <= 4096 && !/\s/.test(publishableKey), 'publishable key is invalid');
  assert.doesNotMatch(publishableKey, /^sb_secret_|service[_-]?role/i, 'service/admin credentials are forbidden in this test');
  if (!publishableKey.startsWith('sb_publishable_')) {
    assert.equal(decodeJwtPayload(publishableKey).role, 'anon', 'legacy browser key must have role=anon');
  }

  const userA = parseTestIdentity(
    'user A',
    requireEnvironment('RV_PRODUCTION_VAULT_TEST_USER_A_ID'),
    requireEnvironment('RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN'),
  );
  const userB = parseTestIdentity(
    'user B',
    requireEnvironment('RV_PRODUCTION_VAULT_TEST_USER_B_ID'),
    requireEnvironment('RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN'),
  );
  assert.notEqual(userA.userId, userB.userId, 'live gate requires two different Auth users');
  assert.notEqual(userA.token, userB.token, 'live gate requires two different access tokens');

  const controlPlane = parseCanonicalProductionControlPlaneEvidence(
    requireEnvironment(CONTROL_PLANE_EVIDENCE_KEY),
    requireEnvironment(CONTROL_PLANE_EVIDENCE_SHA_KEY),
    {
      projectRef: expectedProjectRef,
      appOrigin: appOrigin.origin,
      now: Date.now(),
    },
  );
  const receiptOutputFile = requireEnvironment(RECEIPT_OUTPUT_FILE_KEY);
  assert.equal(path.isAbsolute(receiptOutputFile), true, 'runner receipt output must be an absolute path');
  const runnerNonce = requireEnvironment(RUNNER_NONCE_KEY);
  assert.match(runnerNonce, /^[0-9a-f]{64}$/, 'runner nonce must be a fresh 32-byte lowercase hex value');

  assert.equal(
    requireEnvironment('RV_PRODUCTION_VAULT_LIVE_ACK'),
    `NEW_DEDICATED_DISPOSABLE_PROJECT:${expectedProjectRef}:DELETE_TEST_USER_A_ACCOUNT_AND_CLEAR_USER_B_DATA`,
    'destructive acknowledgement must name the exact new disposable project ref',
  );

  return Object.freeze({
    supabaseUrl: url.origin,
    publishableKey,
    projectRef: expectedProjectRef,
    appOrigin: appOrigin.origin,
    sourceCommit: exactCleanSourceCommit(),
    contractSha256: productionLiveContractSha256({
      repositoryRoot: REPOSITORY_ROOT,
      domain: PRODUCTION_LIVE_GATE_CONTRACT_DOMAIN,
      relativePaths: PRODUCTION_LIVE_GATE_CONTRACT_FILES,
      sourceOverrides: PRODUCTION_LIVE_GATE_SOURCE_OVERRIDES,
    }),
    receiptOutputFile,
    runnerNonce,
    controlPlane,
    userA,
    userB,
  });
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  assert.ok(!Number.isFinite(declared) || declared <= MAX_RESPONSE_BYTES, 'live-test response exceeds its declared size limit');
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= MAX_RESPONSE_BYTES, 'live-test response exceeds its streamed size limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } finally {
    reader.releaseLock();
  }
}

async function restRequest(config, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('live-test timeout'), REQUEST_TIMEOUT_MS);
  const token = options.token ?? config.publishableKey;
  try {
    const headers = {
      Accept: 'application/json',
      apikey: config.publishableKey,
      Authorization: `Bearer ${token}`,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    return Object.freeze({
      ok: response.ok,
      status: response.status,
      body: await readBoundedJson(response),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function edgeRequest(config, body, token = null, functionName = 'delete-account') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('live-test timeout'), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/json',
      apikey: config.publishableKey,
      'Content-Type': 'application/json',
      Origin: config.appOrigin,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${config.supabaseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    return Object.freeze({
      status: response.status,
      body: await readBoundedJson(response),
    });
  } finally {
    clearTimeout(timer);
  }
}

function deletionRecovery(identity, operation, workspaceId = null) {
  return Object.freeze({
    operation,
    requestId: crypto.randomUUID(),
    recoverySecret: `rvr1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`,
    subjectHint: identity.userId,
    ...(operation === 'delete_workspace' ? { workspaceId } : {}),
  });
}

function deletionMutation(recovery) {
  const confirmations = {
    delete_workspace: 'DELETE_THIS_WORKSPACE',
    clear_business_data: 'DELETE_MY_REVIEW_DATA',
    delete_account: 'DELETE_MY_ACCOUNT',
  };
  return {
    protocolVersion: 3,
    action: recovery.operation,
    confirmation: confirmations[recovery.operation],
    requestId: recovery.requestId,
    recoverySecret: recovery.recoverySecret,
    ...(recovery.operation === 'delete_workspace' ? { workspaceId: recovery.workspaceId } : {}),
  };
}

async function executeDeletion(config, identity, recovery) {
  const response = await edgeRequest(config, deletionMutation(recovery), identity.token);
  assert.equal(response.status, 200, `${recovery.operation} Edge flow returned ${response.status}`);
  assert.deepEqual(
    Object.keys(response.body ?? {}).sort(),
    ['action', 'expiresAt', 'protocolVersion', 'receiptId', 'state'],
  );
  assert.equal(response.body.protocolVersion, 3);
  assert.equal(response.body.action, recovery.operation);
  assert.equal(response.body.state, 'completed');
  assert.match(String(response.body.receiptId ?? ''), UUID_PATTERN);
  assert.ok(Number.isFinite(Date.parse(String(response.body.expiresAt ?? ''))));
  return response.body;
}

// Stop consuming the first response immediately after headers and never parse
// its receipt. The capability status below must determine whether the
// destructive operation committed. This models a dropped response body, not
// every possible packet-loss timing.
async function dispatchDeletionWithoutUsingResponse(config, identity, recovery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('live-test timeout'), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.supabaseUrl}/functions/v1/delete-account`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        apikey: config.publishableKey,
        Authorization: `Bearer ${identity.token}`,
        'Content-Type': 'application/json',
        Origin: config.appOrigin,
      },
      body: JSON.stringify(deletionMutation(recovery)),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.body) await response.body.cancel('simulate dropped mutation response body');
  } catch {
    // A response-loss simulation must still continue to the definitive probe.
  } finally {
    clearTimeout(timer);
  }
}

async function queryDeletion(config, recovery) {
  return await edgeRequest(config, {
    protocolVersion: 3,
    action: 'deletion_status',
    operation: recovery.operation,
    requestId: recovery.requestId,
    recoverySecret: recovery.recoverySecret,
    subjectHint: recovery.subjectHint,
    ...(recovery.operation === 'delete_workspace' ? { workspaceId: recovery.workspaceId } : {}),
  });
}

async function clearBusinessData(config, identity) {
  const recovery = deletionRecovery(identity, 'clear_business_data');
  return await executeDeletion(config, identity, recovery);
}

async function revokeLocalAuthSession(config, identity) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${identity.token}`,
    },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.body) await response.body.cancel('logout response body is not used');
  assert.ok([200, 204].includes(response.status), `session revocation returned ${response.status}`);
}

function repository(config, identity) {
  return new SupabaseVaultRepository({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.publishableKey,
    getAccessToken: () => identity.token,
    timeoutMs: REQUEST_TIMEOUT_MS,
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', config.appOrigin);
      return await fetch(input, { ...init, headers });
    },
  });
}

function randomHex(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

async function signedUpload({
  identity,
  keyPair,
  writeCapability,
  workspaceId,
  deviceId,
  objectId,
  generation,
  encryptedEnvelope,
  parentObjectId = null,
  parentCiphertextSha256 = null,
  signatureTransform = (value) => value,
}) {
  const ciphertextSha256 = await sha256Hex(encryptedEnvelope);
  const manifest = {
    userId: identity.userId,
    workspaceId,
    objectId,
    generation,
    envelopeVersion: 1,
    ciphertextSha256,
    parentObjectId,
    parentCiphertextSha256,
  };
  const signature = signatureTransform(await signVaultObject(keyPair.privateKeyPkcs8, manifest));
  return Object.freeze({
    workspaceId,
    deviceId,
    objectId,
    generation,
    encryptedEnvelope,
    ciphertextSha256,
    signature,
    parentObjectId,
    parentCiphertextSha256,
    writeCapability,
    manifest,
  });
}

function aadFor(identity, workspaceId, generation) {
  return Object.freeze({
    user: identity.userId,
    workspace: workspaceId,
    kind: 'workspace-snapshot',
    logicalKey: 'production-live-gate/binance-usdm',
    generation,
    schemaVersion: 1,
  });
}

function changeCiphertextByte(value) {
  assert.ok(typeof value === 'string' && value.length >= 4);
  const index = Math.floor(value.length / 2);
  const replacement = value[index] === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

async function expectAuthenticationFailure(promise) {
  await assert.rejects(promise, (error) => (
    error?.name === 'VaultCryptoError'
    && error?.code === 'VAULT_AUTHENTICATION_FAILED'
  ));
}

if (configuredKeys.length === 0 && !liveRunRequired) {
  test.skip('SKIP production vault live gate: no dedicated-project environment variables were supplied', () => {});
} else {
  describe.sequential('new dedicated Supabase production vault live gate', () => {
    let cleanupConfig = null;
    let accountADeleted = false;
    let businessBCleared = false;

    afterAll(async () => {
      if (!cleanupConfig) return;
      const cleanupTargets = [];
      if (!accountADeleted) cleanupTargets.push(cleanupConfig.userA);
      if (!businessBCleared) cleanupTargets.push(cleanupConfig.userB);
      const results = await Promise.allSettled(
        cleanupTargets.map((identity) => clearBusinessData(cleanupConfig, identity)),
      );
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'live-gate cleanup did not clear remaining disposable users');
      }
    });

    test('rejects unauthorized writes, verifies committed signed history, isolates two users, enforces CAS, transports the maximum envelope, and live-gates workspace/business/account deletion', async () => {
      const config = parseLiveConfig();
      cleanupConfig = config;
      const repoA = repository(config, config.userA);
      const repoB = repository(config, config.userB);
      const [keyPairA, keyPairB] = await Promise.all([
        generateVaultSigningKeyPair(),
        generateVaultSigningKeyPair(),
      ]);
      const writeCapabilityA = randomHex();
      const writeCapabilityB = randomHex();

      const anonymousRead = await restRequest(config, 'workspaces?select=workspace_id&limit=1');
      assert.ok([401, 403].includes(anonymousRead.status), `anonymous table read unexpectedly returned ${anonymousRead.status}`);
      const anonymousRpc = await restRequest(config, 'rpc/rv_bootstrap_workspace', {
        method: 'POST',
        body: {
          p_workspace_id: crypto.randomUUID(),
          p_signing_algorithm: VAULT_SIGNING_ALGORITHM,
          p_signing_public_key: keyPairA.publicKeySpki,
          p_write_capability: writeCapabilityA,
        },
      });
      assert.ok([401, 403].includes(anonymousRpc.status), `anonymous RPC unexpectedly returned ${anonymousRpc.status}`);
      const anonymousRecovery = deletionRecovery(config.userA, 'clear_business_data');
      const anonymousDestructiveAction = await edgeRequest(
        config,
        deletionMutation(anonymousRecovery),
      );
      assert.equal(anonymousDestructiveAction.status, 401, 'destructive Edge action accepted a missing JWT');
      const malformedDestructiveAction = await edgeRequest(
        config,
        deletionMutation(anonymousRecovery),
        'not-a-valid-user-jwt-not-a-valid-user-jwt',
      );
      assert.equal(malformedDestructiveAction.status, 401, 'destructive Edge action accepted an invalid JWT');
      const unknownStatusCapability = await edgeRequest(config, {
        protocolVersion: 3,
        action: 'deletion_status',
        operation: 'delete_account',
        requestId: crypto.randomUUID(),
        recoverySecret: `rvr1_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`,
        subjectHint: config.userA.userId,
      });
      assert.equal(unknownStatusCapability.status, 404, 'unknown deletion-status capability did not fail closed');
      assert.deepEqual(unknownStatusCapability.body, { error: 'deletion_request_not_found' });

      const workspaceId = crypto.randomUUID();
      const deviceId = crypto.randomUUID();
      const firstObjectId = crypto.randomUUID();
      const runMarker = crypto.randomUUID();
      const secretA = `live-test-user-a-${crypto.randomUUID()}`;
      const secretB = `live-test-user-b-${crypto.randomUUID()}`;

      await Promise.all([
        repoA.bootstrapWorkspace({
          workspaceId,
          signingAlgorithm: VAULT_SIGNING_ALGORITHM,
          signingPublicKey: keyPairA.publicKeySpki,
          writeCapability: writeCapabilityA,
        }),
        repoB.bootstrapWorkspace({
          workspaceId,
          signingAlgorithm: VAULT_SIGNING_ALGORITHM,
          signingPublicKey: keyPairB.publicKeySpki,
          writeCapability: writeCapabilityB,
        }),
      ]);

      const directReadProbes = [
        ['profiles', 'user_id'],
        ['workspaces', 'signing_public_key'],
        ['devices', 'device_id'],
        ['vault_objects', 'ciphertext'],
        ['vault_heads', 'object_id'],
        ['vault_head_history', 'object_id'],
        ['destructive_operation_requests', 'request_id,operation,status,receipt_id,expires_at'],
      ];
      for (const [relation, selectedColumn] of directReadProbes) {
        const directRead = await restRequest(config, `${relation}?select=${selectedColumn}&limit=1`, {
          token: config.userA.token,
        });
        assert.ok(
          [401, 403].includes(directRead.status),
          `authenticated direct ${relation} read bypass unexpectedly returned ${directRead.status}`,
        );
      }

      await assert.rejects(
        repoA.registerDevice({ workspaceId, deviceId, writeCapability: '0'.repeat(64) }),
        (error) => error instanceof VaultRepositoryError && error.code === 'FORBIDDEN',
        'wrong write capability registered a device',
      );
      await Promise.all([
        repoA.registerDevice({ workspaceId, deviceId, writeCapability: writeCapabilityA }),
        repoB.registerDevice({ workspaceId, deviceId, writeCapability: writeCapabilityB }),
      ]);

      const directInsert = await restRequest(config, 'vault_objects', {
        method: 'POST',
        token: config.userA.token,
        body: {},
      });
      assert.ok([401, 403].includes(directInsert.status), `authenticated direct object insert unexpectedly returned ${directInsert.status}`);

      const firstAadA = aadFor(config.userA, workspaceId, 1);
      const firstAadB = aadFor(config.userB, workspaceId, 1);
      const [firstEnvelopeA, firstEnvelopeB] = await Promise.all([
        encryptVaultPayload({ owner: 'A', runMarker, generation: 1 }, secretA, firstAadA),
        encryptVaultPayload({ owner: 'B', runMarker, generation: 1 }, secretB, firstAadB),
      ]);
      const [firstUploadA, firstUploadB] = await Promise.all([
        signedUpload({
          identity: config.userA,
          keyPair: keyPairA,
          writeCapability: writeCapabilityA,
          workspaceId,
          deviceId,
          objectId: firstObjectId,
          generation: 1,
          encryptedEnvelope: serializeVaultEnvelope(firstEnvelopeA),
        }),
        signedUpload({
          identity: config.userB,
          keyPair: keyPairB,
          writeCapability: writeCapabilityB,
          workspaceId,
          deviceId,
          objectId: firstObjectId,
          generation: 1,
          encryptedEnvelope: serializeVaultEnvelope(firstEnvelopeB),
        }),
      ]);
      await Promise.all([repoA.uploadGeneration(firstUploadA), repoB.uploadGeneration(firstUploadB)]);
      await Promise.all([
        repoA.publishHead({ workspaceId, objectId: firstObjectId, expectedGeneration: 0 }),
        repoB.publishHead({ workspaceId, objectId: firstObjectId, expectedGeneration: 0 }),
      ]);

      const [firstActiveA, firstActiveB] = await Promise.all([
        repoA.readActiveGeneration(workspaceId),
        repoB.readActiveGeneration(workspaceId),
      ]);
      assert.ok(firstActiveA && firstActiveB);
      assert.equal(firstActiveA.head.objectId, firstObjectId);
      assert.equal(firstActiveB.head.objectId, firstObjectId);
      assert.equal(await verifyVaultObjectSignature(
        keyPairA.publicKeySpki,
        firstUploadA.manifest,
        firstActiveA.object.signature,
      ), true);
      assert.equal(await verifyVaultObjectSignature(
        keyPairB.publicKeySpki,
        firstUploadB.manifest,
        firstActiveB.object.signature,
      ), true);
      assert.deepEqual(
        await decryptVaultPayload(deserializeVaultEnvelope(firstActiveA.object.encryptedEnvelope), secretA, firstAadA),
        { owner: 'A', runMarker, generation: 1 },
      );
      assert.deepEqual(
        await decryptVaultPayload(deserializeVaultEnvelope(firstActiveB.object.encryptedEnvelope), secretB, firstAadB),
        { owner: 'B', runMarker, generation: 1 },
      );
      await expectAuthenticationFailure(
        decryptVaultPayload(deserializeVaultEnvelope(firstActiveA.object.encryptedEnvelope), secretB, firstAadA),
      );

      const secondAadA = aadFor(config.userA, workspaceId, 2);
      const candidateIds = [crypto.randomUUID(), crypto.randomUUID()];
      const candidateEnvelopes = await Promise.all(candidateIds.map((objectId) => encryptVaultPayload(
        { owner: 'A', runMarker, generation: 2, objectId },
        secretA,
        secondAadA,
      )));

      const invalidSignatureObjectId = crypto.randomUUID();
      const invalidSignatureUpload = await signedUpload({
        identity: config.userA,
        keyPair: keyPairA,
        writeCapability: writeCapabilityA,
        workspaceId,
        deviceId,
        objectId: invalidSignatureObjectId,
        generation: 2,
        encryptedEnvelope: serializeVaultEnvelope(await encryptVaultPayload(
          { owner: 'A', runMarker, generation: 2, invalid: true }, secretA, secondAadA,
        )),
        parentObjectId: firstObjectId,
        parentCiphertextSha256: firstUploadA.ciphertextSha256,
        signatureTransform: (value) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`,
      });
      await repoA.uploadGeneration(invalidSignatureUpload);
      const invalidSignaturePublish = await edgeRequest(config, {
        protocolVersion: VAULT_PUBLISH_PROTOCOL_VERSION,
        workspaceId,
        objectId: invalidSignatureObjectId,
        expectedGeneration: 1,
      }, config.userA.token, 'publish-vault-head');
      assert.equal(invalidSignaturePublish.status, 422, 'tampered signature was published');

      const wrongParentUpload = await signedUpload({
        identity: config.userA,
        keyPair: keyPairA,
        writeCapability: writeCapabilityA,
        workspaceId,
        deviceId,
        objectId: crypto.randomUUID(),
        generation: 2,
        encryptedEnvelope: serializeVaultEnvelope(candidateEnvelopes[0]),
        parentObjectId: firstObjectId,
        parentCiphertextSha256: 'f'.repeat(64),
      });
      await assert.rejects(
        repoA.uploadGeneration(wrongParentUpload),
        (error) => error instanceof VaultRepositoryError && ['NOT_FOUND', 'CONFLICT'].includes(error.code),
        'wrong parent digest was uploaded',
      );

      const wrongCapabilityUpload = await signedUpload({
        identity: config.userA,
        keyPair: keyPairA,
        writeCapability: '0'.repeat(64),
        workspaceId,
        deviceId,
        objectId: crypto.randomUUID(),
        generation: 2,
        encryptedEnvelope: serializeVaultEnvelope(candidateEnvelopes[0]),
        parentObjectId: firstObjectId,
        parentCiphertextSha256: firstUploadA.ciphertextSha256,
      });
      await assert.rejects(
        repoA.uploadGeneration(wrongCapabilityUpload),
        (error) => error instanceof VaultRepositoryError && error.code === 'FORBIDDEN',
        'wrong write capability uploaded a generation',
      );

      const signedCandidates = await Promise.all(candidateIds.map((objectId, index) => signedUpload({
        identity: config.userA,
        keyPair: keyPairA,
        writeCapability: writeCapabilityA,
        workspaceId,
        deviceId,
        objectId,
        generation: 2,
        encryptedEnvelope: serializeVaultEnvelope(candidateEnvelopes[index]),
        parentObjectId: firstObjectId,
        parentCiphertextSha256: firstUploadA.ciphertextSha256,
      })));
      await Promise.all(signedCandidates.map((upload) => repoA.uploadGeneration(upload)));
      const race = await Promise.allSettled(candidateIds.map((objectId) => repoA.publishHead({
        workspaceId,
        objectId,
        expectedGeneration: 1,
      })));
      const winners = race.filter((result) => result.status === 'fulfilled');
      const losers = race.filter((result) => result.status === 'rejected');
      assert.equal(winners.length, 1, 'exactly one concurrent CAS publisher must win');
      assert.equal(losers.length, 1, 'exactly one concurrent CAS publisher must lose');
      assert.ok(losers[0].reason instanceof VaultRepositoryError);
      assert.equal(losers[0].reason.code, 'CONFLICT');

      const activeA = await repoA.readActiveGeneration(workspaceId);
      assert.ok(activeA);
      assert.equal(activeA.head.generation, 2);
      assert.ok(candidateIds.includes(activeA.head.objectId));
      const winningUpload = signedCandidates.find((upload) => upload.objectId === activeA.head.objectId);
      assert.ok(winningUpload);
      assert.equal(await verifyVaultObjectSignature(
        keyPairA.publicKeySpki,
        winningUpload.manifest,
        activeA.object.signature,
      ), true);
      await assert.rejects(
        repoA.publishHead({ workspaceId, objectId: activeA.head.objectId, expectedGeneration: 1 }),
        (error) => error instanceof VaultRepositoryError && error.code === 'CONFLICT',
        'stale publish replay did not conflict',
      );
      const recoveredHead = await repoA.readActiveGeneration(workspaceId);
      assert.equal(recoveredHead?.head.objectId, winningUpload.objectId, 'head reload cannot resolve an unknown publish result');
      assert.equal(recoveredHead?.object.ciphertextSha256, winningUpload.ciphertextSha256);
      const committedHistory = await repoA.readGenerationHistory(workspaceId, { limit: 8 });
      assert.deepEqual(
        committedHistory.map((object) => object.objectId),
        [winningUpload.objectId, firstObjectId],
        'history must contain only committed CAS winners in newest-first order',
      );
      const losingObjectId = candidateIds.find((objectId) => objectId !== winningUpload.objectId);
      assert.ok(losingObjectId && !committedHistory.some((object) => object.objectId === losingObjectId));
      const activeEnvelopeA = deserializeVaultEnvelope(activeA.object.encryptedEnvelope);
      const activePayloadA = await decryptVaultPayload(activeEnvelopeA, secretA, secondAadA);
      assert.equal(activePayloadA.owner, 'A');
      assert.equal(activePayloadA.objectId, activeA.head.objectId);

      await expectAuthenticationFailure(decryptVaultPayload(
        activeEnvelopeA,
        `wrong-secret-${crypto.randomUUID()}`,
        secondAadA,
      ));
      await expectAuthenticationFailure(decryptVaultPayload({
        ...activeEnvelopeA,
        payload: {
          ...activeEnvelopeA.payload,
          ciphertext: changeCiphertextByte(activeEnvelopeA.payload.ciphertext),
        },
      }, secretA, secondAadA));

      // This is deliberately not published because random bytes are not a valid
      // client envelope. It verifies the worst-case PostgREST upload path only.
      const maximumEnvelope = new Uint8Array(MAX_ENCRYPTED_ENVELOPE_BYTES);
      maximumEnvelope.fill(0xa5);
      const maximumUploadInput = await signedUpload({
        identity: config.userA,
        keyPair: keyPairA,
        writeCapability: writeCapabilityA,
        workspaceId,
        deviceId,
        objectId: crypto.randomUUID(),
        generation: 3,
        encryptedEnvelope: maximumEnvelope,
        parentObjectId: winningUpload.objectId,
        parentCiphertextSha256: winningUpload.ciphertextSha256,
      });
      const maximumUpload = await repoA.uploadGeneration(maximumUploadInput, { timeoutMs: REQUEST_TIMEOUT_MS });
      assert.equal(maximumUpload.generation, 3);
      maximumEnvelope.fill(0);

      const workspaceDeletionRecovery = deletionRecovery(
        config.userA,
        'delete_workspace',
        workspaceId,
      );
      await dispatchDeletionWithoutUsingResponse(
        config,
        config.userA,
        workspaceDeletionRecovery,
      );
      const workspaceStatus = await queryDeletion(config, workspaceDeletionRecovery);
      assert.equal(workspaceStatus.status, 200);
      assert.equal(workspaceStatus.body.operation, 'delete_workspace');
      assert.equal(workspaceStatus.body.state, 'completed');
      assert.match(String(workspaceStatus.body.receiptId ?? ''), UUID_PATTERN);
      const workspaceReplay = await executeDeletion(
        config,
        config.userA,
        workspaceDeletionRecovery,
      );
      assert.equal(workspaceReplay.receiptId, workspaceStatus.body.receiptId);
      assert.deepEqual(await repoA.listWorkspaces(), []);

      const survivorAfterWorkspaceDelete = await repoB.readActiveGeneration(workspaceId);
      assert.ok(survivorAfterWorkspaceDelete, 'workspace deletion crossed the tenant boundary');
      assert.deepEqual(
        await decryptVaultPayload(
          deserializeVaultEnvelope(survivorAfterWorkspaceDelete.object.encryptedEnvelope),
          secretB,
          firstAadB,
        ),
        { owner: 'B', runMarker, generation: 1 },
      );

      const businessWorkspaceId = crypto.randomUUID();
      await repoA.bootstrapWorkspace({
        workspaceId: businessWorkspaceId,
        signingAlgorithm: VAULT_SIGNING_ALGORITHM,
        signingPublicKey: keyPairA.publicKeySpki,
        writeCapability: writeCapabilityA,
      });
      assert.equal((await repoA.listWorkspaces()).length, 1);
      const businessRecovery = deletionRecovery(config.userA, 'clear_business_data');
      await dispatchDeletionWithoutUsingResponse(config, config.userA, businessRecovery);
      const businessStatus = await queryDeletion(config, businessRecovery);
      assert.equal(businessStatus.status, 200);
      assert.equal(businessStatus.body.operation, 'clear_business_data');
      assert.equal(businessStatus.body.state, 'completed');
      assert.match(String(businessStatus.body.receiptId ?? ''), UUID_PATTERN);
      const businessReplay = await executeDeletion(config, config.userA, businessRecovery);
      assert.equal(businessReplay.receiptId, businessStatus.body.receiptId);
      assert.deepEqual(await repoA.listWorkspaces(), []);

      const authUserA = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${config.userA.token}`,
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const authUserABody = await readBoundedJson(authUserA);
      assert.equal(authUserA.status, 200, 'business-data RPC must not delete the Auth account');
      assert.equal(authUserABody?.id, config.userA.userId);

      const accountRecovery = deletionRecovery(config.userA, 'delete_account');
      await dispatchDeletionWithoutUsingResponse(config, config.userA, accountRecovery);
      const accountStatus = await queryDeletion(config, accountRecovery);
      assert.equal(accountStatus.status, 200);
      assert.equal(accountStatus.body.operation, 'delete_account');
      assert.equal(accountStatus.body.state, 'completed');
      assert.match(String(accountStatus.body.receiptId ?? ''), UUID_PATTERN);
      accountADeleted = true;

      const deletedAuthProbe = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${config.userA.token}`,
        },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.ok([401, 403].includes(deletedAuthProbe.status), 'account deletion left test user A active');

      const survivorB = await repoB.readActiveGeneration(workspaceId);
      assert.ok(survivorB, 'account deletion crossed the tenant boundary');
      assert.deepEqual(
        await decryptVaultPayload(deserializeVaultEnvelope(survivorB.object.encryptedEnvelope), secretB, firstAadB),
        { owner: 'B', runMarker, generation: 1 },
      );

      const rateLimitProbeStartedAt = performance.now();
      let firstExplicitBucketRejectionMs = null;
      for (let batch = 0; batch < 20 && firstExplicitBucketRejectionMs === null; batch += 1) {
        const rateLimitProbeResults = await Promise.all(Array.from({ length: 8 }, async () => {
          const result = await restRequest(config, 'rpc/rv_list_workspaces', {
            method: 'POST',
            token: config.userB.token,
            body: {
              p_limit: 1,
              p_session_id: config.userB.sessionId,
            },
          });
          return { result, completedAt: performance.now() };
        }));
        for (const { result, completedAt } of rateLimitProbeResults) {
          const remoteCode = result.body?.code;
          assert.equal(
            result.ok || remoteCode === 'P0004' || remoteCode === 'P0005',
            true,
            'raw read-RPC admission probe returned an unexpected response',
          );
          if (!result.ok && remoteCode === 'P0004' && firstExplicitBucketRejectionMs === null) {
            firstExplicitBucketRejectionMs = completedAt - rateLimitProbeStartedAt;
          }
        }
        if (performance.now() - rateLimitProbeStartedAt >= 20_000) break;
      }
      assert.notEqual(
        firstExplicitBucketRejectionMs,
        null,
        'batched raw read-RPC probes did not return the explicit P0004 token-bucket rejection',
      );
      assert.ok(
        firstExplicitBucketRejectionMs < 20_000,
        'explicit P0004 token-bucket rejection was not observed within 20 seconds',
      );

      const userBCleanupReceipt = await clearBusinessData(config, config.userB);
      businessBCleared = true;

      await revokeLocalAuthSession(config, config.userB);
      const revokedRead = await restRequest(config, 'rpc/rv_list_workspaces', {
        method: 'POST',
        token: config.userB.token,
        body: {
          p_limit: 16,
          p_session_id: config.userB.sessionId,
        },
      });
      assert.notEqual(revokedRead.status, 200, 'revoked Auth session retained read-RPC access');

      const revokedWriteBodies = [
        ['rpc/rv_bootstrap_workspace', {
          p_workspace_id: crypto.randomUUID(),
          p_signing_algorithm: VAULT_SIGNING_ALGORITHM,
          p_signing_public_key: keyPairB.publicKeySpki,
          p_write_capability: writeCapabilityB,
          p_session_id: config.userB.sessionId,
        }],
        ['rpc/rv_register_device', {
          p_workspace_id: crypto.randomUUID(),
          p_device_id: crypto.randomUUID(),
          p_write_capability: writeCapabilityB,
          p_session_id: config.userB.sessionId,
        }],
        ['rpc/rv_upload_vault_generation', {
          p_workspace_id: crypto.randomUUID(),
          p_device_id: crypto.randomUUID(),
          p_object_id: crypto.randomUUID(),
          p_generation: 1,
          p_envelope_version: 1,
          p_ciphertext: 'A'.repeat(24),
          p_ciphertext_sha256: '0'.repeat(64),
          p_signature: 'A'.repeat(86),
          p_parent_object_id: null,
          p_parent_ciphertext_sha256: null,
          p_write_capability: writeCapabilityB,
          p_session_id: config.userB.sessionId,
        }],
      ];
      const revokedWriteStatuses = [];
      for (const [path, body] of revokedWriteBodies) {
        const result = await restRequest(config, path, {
          method: 'POST',
          token: config.userB.token,
          body,
        });
        assert.notEqual(result.status, 200, `revoked Auth session executed ${path}`);
        revokedWriteStatuses.push(result.status);
      }
      const revokedPublish = await edgeRequest(config, {
        protocolVersion: VAULT_PUBLISH_PROTOCOL_VERSION,
        workspaceId: crypto.randomUUID(),
        objectId: crypto.randomUUID(),
        expectedGeneration: 0,
      }, config.userB.token, 'publish-vault-head');
      assert.ok(
        [401, 403].includes(revokedPublish.status),
        `revoked Auth session reached vault publish (${revokedPublish.status})`,
      );
      const revokedSessionMutation = await edgeRequest(
        config,
        deletionMutation(deletionRecovery(config.userB, 'clear_business_data')),
        config.userB.token,
      );
      assert.ok(
        [401, 403].includes(revokedSessionMutation.status),
        `revoked Auth session executed a destructive action (${revokedSessionMutation.status})`,
      );
      assert.ok(
        ['authentication_required', 'recent_reauthentication_required'].includes(
          String(revokedSessionMutation.body?.error ?? ''),
        ),
        'revoked Auth session returned an unexpected public error',
      );

      const evidenceSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify({
        controlPlane: JSON.parse(canonicalProductionControlPlaneEvidence(config.controlPlane)),
        live: {
          runMarker,
          freshOtpSessions: 2,
          workspaceDeletionReceiptId: workspaceStatus.body.receiptId,
          businessDeletionReceiptId: businessStatus.body.receiptId,
          accountDeletionReceiptId: accountStatus.body.receiptId,
          userBCleanupReceiptId: userBCleanupReceipt.receiptId,
          revokedReadStatus: revokedRead.status,
          revokedWriteStatuses,
          revokedPublishStatus: revokedPublish.status,
          revokedSessionDenialStatus: revokedSessionMutation.status,
        },
      })));
      const receipt = {
        format: PRODUCTION_LIVE_GATE_RECEIPT_FORMAT,
        testVersion: PRODUCTION_LIVE_GATE_TEST_VERSION,
        attestationKeyId: PRODUCTION_LIVE_ATTESTATION_KEY_ID,
        projectRef: config.projectRef,
        appOrigin: config.appOrigin,
        sourceCommit: config.sourceCommit,
        contractSha256: config.contractSha256,
        completedAt: new Date().toISOString(),
        controlCollectedAt: config.controlPlane.collectedAt,
        evidenceSha256,
        freshOtpSessions: 2,
        manualReleaseBlockers: 'not-evaluated-by-live-gate',
        runnerNonceSha256: await sha256Hex(new TextEncoder().encode(config.runnerNonce)),
        controlPlane: config.controlPlane,
        cleanup: 'user-a-account-deleted+user-b-business-cleared',
        checks: PRODUCTION_LIVE_GATE_CHECKS,
      };
      const canonicalReceipt = JSON.stringify(receipt);
      const handle = fs.openSync(config.receiptOutputFile, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, canonicalReceipt, { encoding: 'utf8' });
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    }, 300_000);
  });
}
