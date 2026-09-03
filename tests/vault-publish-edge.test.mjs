import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PUBLISH_PROTOCOL_VERSION,
  PublishProtocolError,
  buildVaultSignatureManifest,
  parsePublishRequest,
  verifyEd25519Signature,
} from '../supabase/functions/publish-vault-head/protocol.mjs';
import { createPublishVaultHeadHandler } from '../supabase/functions/publish-vault-head/handler.mjs';

const ORIGIN = 'https://review.example.com';
const USER_A = '92bf60cf-6964-4dcc-b2f4-dd14b82b0741';
const USER_B = 'ae9634b8-05de-4f69-a43c-cc1b7672c92e';
const SESSION_ID = '874706c6-9221-45e6-ae68-4c532a9baef9';
const WORKSPACE_ID = 'e8614b3f-0da6-4fe5-ae4d-96353ca09e8f';
const OBJECT_1 = 'a5810db0-9183-478d-a111-f989adbe62f5';
const OBJECT_2 = 'd5af4758-ae9a-4603-9624-59b982aa465b';
const OBJECT_2B = 'f76636b8-49db-40df-b9f9-20f16202659a';
const DIGEST_1 = '1'.repeat(64);
const DIGEST_2 = '2'.repeat(64);
const DIGEST_2B = '3'.repeat(64);
function jwtFor(claims = {}) {
  const payload = Buffer.from(JSON.stringify({
    sub: USER_A,
    session_id: SESSION_ID,
    role: 'authenticated',
    aud: 'authenticated',
    is_anonymous: false,
    ...claims,
  })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature-value-at-least-thirty-two-chars`;
}

const TOKEN = jwtFor();

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');

function candidate({
  objectId = OBJECT_1,
  generation = 1,
  digest = DIGEST_1,
  parentObjectId = null,
  parentDigest = null,
  signature,
} = {}) {
  const unsigned = {
    object_id: objectId,
    generation,
    envelope_version: 1,
    ciphertext_sha256: digest,
    parent_object_id: parentObjectId,
    parent_ciphertext_sha256: parentDigest,
  };
  const manifest = buildVaultSignatureManifest({
    userId: USER_A,
    workspaceId: WORKSPACE_ID,
    objectId,
    generation,
    envelopeVersion: 1,
    ciphertextSha256: digest,
    parentObjectId,
    parentCiphertextSha256: parentDigest,
  });
  return {
    ...unsigned,
    signature: signature ?? sign(null, Buffer.from(manifest), privateKey).toString('base64url'),
  };
}

function jsonRequest(body, { origin = ORIGIN, token = TOKEN } = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://edge.example.com/publish-vault-head', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function publishBody(overrides = {}) {
  return {
    protocolVersion: PUBLISH_PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    objectId: OBJECT_1,
    expectedGeneration: 0,
    ...overrides,
  };
}

function memoryDependencies(overrides = {}) {
  const calls = { verify: 0, publish: [] };
  const state = {
    workspace: {
      signing_algorithm: 'ed25519-v1',
      signing_public_key: PUBLIC_KEY_SPKI,
    },
    candidates: new Map([[OBJECT_1, candidate()]]),
    head: null,
    parentDigests: new Map(),
  };
  const deps = {
    allowedOrigin: ORIGIN,
    deadlineMs: 1_000,
    verifyUser: async (_jwt, { signal } = {}) => {
      if (signal?.aborted) throw new PublishProtocolError('DEADLINE_EXCEEDED', 'deadline exceeded');
      calls.verify += 1;
      return { id: USER_A, is_anonymous: false };
    },
    getPublishContext: async (_subject, _sessionId, _workspaceId, objectId) => {
      const selected = state.candidates.get(objectId) ?? null;
      if (!state.workspace || !selected) return null;
      return {
        ...state.workspace,
        ...selected,
        head_object_id: state.head?.object_id ?? null,
        head_generation: state.head?.generation ?? null,
        head_updated_at: state.head?.updated_at ?? null,
        head_ciphertext_sha256: state.head
          ? state.parentDigests.get(state.head.object_id) ?? null
          : null,
      };
    },
    publishHead: async (subject, sessionId, workspaceId, expectedGeneration, objectId) => {
      calls.publish.push({ subject, sessionId, workspaceId, expectedGeneration, objectId });
      const selected = state.candidates.get(objectId);
      const currentGeneration = state.head?.generation ?? 0;
      if (currentGeneration !== expectedGeneration) {
        throw new PublishProtocolError('CONFLICT', 'publish conflict');
      }
      state.head = {
        object_id: objectId,
        generation: selected.generation,
        updated_at: '2026-08-28T00:00:00.000Z',
      };
      state.parentDigests.set(objectId, selected.ciphertext_sha256);
      return state.head;
    },
    ...overrides,
  };
  return { deps, calls, state };
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

test('manifest is the exact nine-line no-trailing-newline signed contract', async () => {
  const manifest = buildVaultSignatureManifest({
    userId: USER_A,
    workspaceId: WORKSPACE_ID,
    objectId: OBJECT_2,
    generation: 2,
    envelopeVersion: 1,
    ciphertextSha256: DIGEST_2,
    parentObjectId: OBJECT_1,
    parentCiphertextSha256: DIGEST_1,
  });
  assert.equal(manifest, [
    'rv-vault-object-signature/1', USER_A, WORKSPACE_ID, OBJECT_2, '2', '1',
    DIGEST_2, OBJECT_1, DIGEST_1,
  ].join('\n'));
  assert.equal(manifest.split('\n').length, 9);
  assert.equal(manifest.endsWith('\n'), false);

  const signature = sign(null, Buffer.from(manifest), privateKey).toString('base64url');
  assert.equal(signature.length, 86);
  assert.equal(await verifyEd25519Signature(PUBLIC_KEY_SPKI, signature, manifest), true);
  assert.equal(await verifyEd25519Signature(PUBLIC_KEY_SPKI, signature, `${manifest}x`), false);
});

test('parser accepts only the exact version, fields, UUIDs, and safe generation', () => {
  assert.deepEqual(parsePublishRequest(JSON.stringify(publishBody())), publishBody());
  for (const body of [
    {},
    { ...publishBody(), protocolVersion: 1 },
    { ...publishBody(), protocolVersion: 'rv-vault-publish/2' },
    { ...publishBody(), expectedGeneration: -1 },
    { ...publishBody(), expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...publishBody(), userId: USER_A },
    { ...publishBody(), workspaceId: 'not-a-uuid' },
  ]) assert.throws(() => parsePublishRequest(JSON.stringify(body)), /invalid publish request/i);
});

test('strict Origin, OPTIONS, content type, and streaming body limit fail before Auth', async () => {
  const { deps, calls } = memoryDependencies();
  const handler = createPublishVaultHeadHandler(deps);
  const options = await handler(new Request('https://edge.example.com/publish-vault-head', {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Headers': 'authorization, apikey, content-type',
    },
  }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(options.headers.get('access-control-allow-headers'), 'authorization, apikey, content-type');

  const foreign = await handler(jsonRequest(publishBody(), { origin: 'https://evil.example.com' }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);

  const chunked = new Request('https://edge.example.com/publish-vault-head', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal((await handler(chunked)).status, 413);
  assert.equal(calls.verify, 0);
});

test('valid root signature publishes generation one and returns a bounded public shape', async () => {
  const { deps, calls } = memoryDependencies();
  const response = await createPublishVaultHeadHandler(deps)(jsonRequest(publishBody()));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    protocolVersion: PUBLISH_PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    objectId: OBJECT_1,
    generation: 1,
    updatedAt: '2026-08-28T00:00:00.000Z',
  });
  assert.deepEqual(calls.publish, [{
    subject: USER_A,
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    expectedGeneration: 0,
    objectId: OBJECT_1,
  }]);
});

test('JWT subject and session_id are strictly bound before any service-role publish', async () => {
  for (const token of [
    jwtFor({ session_id: undefined }),
    jwtFor({ session_id: 'not-a-uuid' }),
    jwtFor({ sub: USER_B }),
    jwtFor({ role: 'anon' }),
    jwtFor({ aud: 'anon' }),
    jwtFor({ is_anonymous: true }),
  ]) {
    const memory = memoryDependencies();
    const response = await createPublishVaultHeadHandler(memory.deps)(jsonRequest(publishBody(), { token }));
    assert.equal(response.status, 401);
    assert.equal(memory.calls.publish.length, 0);
  }
});

test('tampered signature, digest, parent, stale replay, and foreign subject fail closed', async () => {
  const invalidSignature = memoryDependencies();
  invalidSignature.state.candidates.set(OBJECT_1, candidate({ signature: 'A'.repeat(86) }));
  const signatureResponse = await createPublishVaultHeadHandler(invalidSignature.deps)(jsonRequest(publishBody()));
  assert.equal(signatureResponse.status, 422);
  assert.equal(invalidSignature.calls.publish.length, 0);

  const chain = memoryDependencies();
  chain.state.head = { object_id: OBJECT_1, generation: 1, updated_at: '2026-08-28T00:00:00.000Z' };
  chain.state.parentDigests.set(OBJECT_1, DIGEST_1);
  chain.state.candidates.set(OBJECT_2, candidate({
    objectId: OBJECT_2,
    generation: 2,
    digest: DIGEST_2,
    parentObjectId: OBJECT_1,
    parentDigest: DIGEST_1,
  }));
  const success = await createPublishVaultHeadHandler(chain.deps)(jsonRequest(publishBody({
    objectId: OBJECT_2,
    expectedGeneration: 1,
  })));
  assert.equal(success.status, 200);

  const replay = await createPublishVaultHeadHandler(chain.deps)(jsonRequest(publishBody({
    objectId: OBJECT_2,
    expectedGeneration: 1,
  })));
  assert.equal(replay.status, 409);

  const wrongParent = memoryDependencies();
  wrongParent.state.head = { object_id: OBJECT_1, generation: 1, updated_at: '2026-08-28T00:00:00.000Z' };
  wrongParent.state.parentDigests.set(OBJECT_1, DIGEST_1);
  wrongParent.state.candidates.set(OBJECT_2, candidate({
    objectId: OBJECT_2,
    generation: 2,
    digest: DIGEST_2,
    parentObjectId: OBJECT_1,
    parentDigest: 'f'.repeat(64),
  }));
  assert.equal((await createPublishVaultHeadHandler(wrongParent.deps)(jsonRequest(publishBody({
    objectId: OBJECT_2, expectedGeneration: 1,
  })))).status, 409);
  assert.equal(wrongParent.calls.publish.length, 0);

  const foreign = memoryDependencies({ verifyUser: async () => ({ id: USER_B, is_anonymous: false }) });
  foreign.state.workspace = null;
  assert.equal((await createPublishVaultHeadHandler(foreign.deps)(jsonRequest(publishBody()))).status, 401);
});

test('two concurrent valid successors have exactly one CAS winner', async () => {
  const memory = memoryDependencies();
  memory.state.head = { object_id: OBJECT_1, generation: 1, updated_at: '2026-08-28T00:00:00.000Z' };
  memory.state.parentDigests.set(OBJECT_1, DIGEST_1);
  memory.state.candidates.set(OBJECT_2, candidate({
    objectId: OBJECT_2, generation: 2, digest: DIGEST_2,
    parentObjectId: OBJECT_1, parentDigest: DIGEST_1,
  }));
  memory.state.candidates.set(OBJECT_2B, candidate({
    objectId: OBJECT_2B, generation: 2, digest: DIGEST_2B,
    parentObjectId: OBJECT_1, parentDigest: DIGEST_1,
  }));
  const handler = createPublishVaultHeadHandler(memory.deps);
  const results = await Promise.all([
    handler(jsonRequest(publishBody({ objectId: OBJECT_2, expectedGeneration: 1 }))),
    handler(jsonRequest(publishBody({ objectId: OBJECT_2B, expectedGeneration: 1 }))),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
});

test('deadline aborts a stalled Auth verification and returns no secret detail', async () => {
  const { deps } = memoryDependencies({
    deadlineMs: 20,
    verifyUser: async (_jwt, { signal }) => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new PublishProtocolError('DEADLINE_EXCEEDED', 'private')), { once: true });
    }),
  });
  const response = await createPublishVaultHeadHandler(deps)(jsonRequest(publishBody()));
  assert.equal(response.status, 503);
  assert.deepEqual(await responseJson(response), { error: 'publish_unavailable' });
});

test('database capacity and token refusals return one bounded retryable public response', async () => {
  const privateDetail = `${USER_A}:${WORKSPACE_ID}:private-capacity-detail`;
  const { deps } = memoryDependencies({
    getPublishContext: async () => {
      throw new PublishProtocolError('RATE_LIMITED', privateDetail);
    },
  });
  const response = await createPublishVaultHeadHandler(deps)(jsonRequest(publishBody()));
  const body = await response.text();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '1');
  assert.deepEqual(JSON.parse(body), { error: 'rate_limited' });
  assert.doesNotMatch(body, new RegExp(`${USER_A}|${WORKSPACE_ID}|private-capacity-detail`, 'i'));
});

test('Edge wiring manually verifies JWT, keeps service role server-only, bounds fetches, and disables gateway JWT only here', async () => {
  const index = await readFile(new URL('../supabase/functions/publish-vault-head/index.ts', import.meta.url), 'utf8');
  const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(index, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(index, /\/auth\/v1\/user/);
  assert.match(index, /rv_service_publish_vault_head/);
  assert.match(index, /code === 'P0004' \|\| code === 'P0005'/);
  assert.match(await readFile(new URL('../supabase/functions/publish-vault-head/handler.mjs', import.meta.url), 'utf8'), /Retry-After': '1'/);
  assert.match(index, /p_session_id:\s*sessionId/);
  assert.match(index, /AbortController|AbortSignal/);
  assert.match(index, /readBoundedJson/);
  assert.doesNotMatch(index, /console\.(log|error)[\s\S]{0,120}(token|user|secret|key)/i);
  assert.doesNotMatch(index, /Access-Control-Allow-Origin["']?:\s*["']\*/i);
  assert.match(config, /\[functions\.publish-vault-head\][\s\S]*verify_jwt\s*=\s*false/i);
});
