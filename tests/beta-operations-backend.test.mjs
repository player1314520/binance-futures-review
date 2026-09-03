import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_OIDC_ISSUER,
  canonicalJson,
  createCloudflareTempCredentialRequest,
  createGrantCodec,
  createR2SigV4HeadRequest,
  createRestoreLeaseCodec,
  validateGithubOidcClaims,
} from '../supabase/functions/beta-operations/core.mjs';
import { createBetaOperationsHandler } from '../supabase/functions/beta-operations/handler.mjs';
import {
  createRuntimeDependencies,
  readRuntimeConfig,
} from '../supabase/functions/beta-operations/runtime.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = 1_788_131_100;
const AUDIENCE = 'rv-beta-operations-prod';
const REPOSITORY = 'player1314520/trading-';
const REPOSITORY_ID = '123456789';
const REPOSITORY_OWNER_ID = '123456789';
const WORKFLOW_SHA = 'a'.repeat(40);

const POLICIES = Object.freeze({
  'beta-backup': Object.freeze({
    capability: 'beta-backup',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    workflowRef: `${REPOSITORY}/.github/workflows/beta-backup.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-backup.yml@refs/heads/main`,
    workflowSha: WORKFLOW_SHA,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    environment: 'beta-operations',
    eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    runnerEnvironment: 'github-hosted',
    job: 'backup',
    subject: `repo:${REPOSITORY}:environment:beta-operations`,
    audience: AUDIENCE,
  }),
  'beta-archive': Object.freeze({
    capability: 'beta-archive',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    workflowRef: `${REPOSITORY}/.github/workflows/beta-archive.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-archive.yml@refs/heads/main`,
    workflowSha: WORKFLOW_SHA,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    environment: 'beta-operations',
    eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    runnerEnvironment: 'github-hosted',
    job: 'archive',
    subject: `repo:${REPOSITORY}:environment:beta-operations`,
    audience: AUDIENCE,
  }),
  'beta-capacity-observe': Object.freeze({
    capability: 'beta-capacity-observe',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    workflowRef: `${REPOSITORY}/.github/workflows/beta-backup.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-backup.yml@refs/heads/main`,
    workflowSha: WORKFLOW_SHA,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    environment: 'beta-operations',
    eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    runnerEnvironment: 'github-hosted',
    job: 'backup',
    subject: `repo:${REPOSITORY}:environment:beta-operations`,
    audience: AUDIENCE,
  }),
  'beta-restore': Object.freeze({
    capability: 'beta-restore',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    workflowRef: `${REPOSITORY}/.github/workflows/beta-restore.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-restore.yml@refs/heads/main`,
    workflowSha: WORKFLOW_SHA,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    environment: 'beta-restore-operator',
    eventNames: Object.freeze(['workflow_dispatch']),
    runnerEnvironment: 'github-hosted',
    job: 'restore',
    subject: `repo:${REPOSITORY}:environment:beta-restore-operator`,
    audience: AUDIENCE,
  }),
});

function claims(capability = 'beta-backup', overrides = {}) {
  const policy = POLICIES[capability];
  return {
    iss: GITHUB_OIDC_ISSUER,
    aud: policy.audience,
    sub: policy.subject,
    repository: policy.repository,
    repository_id: policy.repositoryId,
    repository_owner_id: policy.repositoryOwnerId,
    repository_visibility: 'private',
    ref: policy.ref,
    workflow_ref: policy.workflowRef,
    workflow_sha: policy.workflowSha,
    environment: policy.environment,
    event_name: capability === 'beta-restore' ? 'workflow_dispatch' : 'schedule',
    runner_environment: policy.runnerEnvironment,
    run_id: '7612345678',
    run_attempt: '2',
    jti: `${capability}-oidc-jti-0001`,
    iat: NOW - 30,
    nbf: NOW - 30,
    exp: NOW + 300,
    ...overrides,
  };
}

function binding(capability = 'beta-backup') {
  const policy = POLICIES[capability];
  return {
    repository: policy.repository,
    ref: policy.ref,
    workflowRef: policy.workflowRef,
    jobWorkflowRef: policy.jobWorkflowRef,
    runId: '7612345678',
    runAttempt: '2',
    job: policy.job,
  };
}

function manifest() {
  const source = binding('beta-backup');
  return {
    format: 'review-workbench-beta-backup/1',
    createdAt: '2026-08-31T01:02:03.004Z',
    snapshotId: 'snapshot-20260831',
    generation: 17,
    nonce: 'a'.repeat(48),
    source: { view: 'beta_backup_v1', ...source },
    encryption: 'age',
    ageRecipientSha256: 'b'.repeat(64),
    ciphertext: {
      objectKey: 'beta-backups/runs/7612345678/attempt-2/20260831-010203004Z.ndjson.age',
      sha256: 'c'.repeat(64),
      bytes: 1234,
    },
    rowCounts: { trades: 2 },
    totalRows: 2,
  };
}

function restoreV2Page() {
  return {
    format: 'rv-restore-v2-export-page/1',
    view: 'rv2_restore_export_v2',
    readOnly: true,
    snapshotId: '20000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-31T01:02:03.004Z',
    rowCount: 3,
    rowCounts: { connections: 1, memberships: 1, tenants: 1 },
    rows: [
      { rowOrdinal: 0, rowData: { dataset: 'tenants', recordId: '30000000-0000-4000-8000-000000000001' } },
      { rowOrdinal: 1, rowData: { dataset: 'memberships', recordId: '30000000-0000-4000-8000-000000000002' } },
      { rowOrdinal: 2, rowData: { dataset: 'connections', recordId: '30000000-0000-4000-8000-000000000003' } },
    ],
    nextCursor: null,
  };
}

function restoreV2Manifest() {
  return {
    format: 'rv-restore-snapshot-manifest/2',
    snapshotId: '20000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-31T01:02:03.004Z',
    rowCount: 3,
    rowCounts: { connections: 1, memberships: 1, tenants: 1 },
    orderedContentRoot: 'a'.repeat(64),
    tenantLineageRoot: 'b'.repeat(64),
    plaintextStreamSha256: 'c'.repeat(64),
    externalJournalRoot: 'd'.repeat(64),
    credentialsIncluded: false,
  };
}

function deletionJournalProof() {
  return {
    format: 'rv-deletion-journal-range-proof/2',
    rangeStart: '1970-01-01T00:00:00.000Z',
    rangeEnd: '2026-08-31T01:03:00.000Z',
    firstPassRoot: 'e'.repeat(64),
    secondPassRoot: 'e'.repeat(64),
    objectCount: 0,
    snapshotJournalRoot: 'd'.repeat(64),
    events: [],
    storageClaim: 'private-r2-best-effort-append-only-not-worm',
  };
}

function capacityObservation(overrides = {}) {
  const observedAt = new Date(NOW * 1000).toISOString();
  const r2StandardBytes = 1024;
  const actionsMinutesUsed = '12.345';
  const actionsMinutesLimit = '2000.000';
  const backupObjectAgeSeconds = 3600;
  const smtpDeliveryFailures24h = 1;
  const material = 'rv-capacity-observation/1\0'
    + `${Date.parse(observedAt)}\0${r2StandardBytes}\0${12345}\0${2000000}\0`
    + `${backupObjectAgeSeconds}\0${smtpDeliveryFailures24h}`;
  return {
    format: 'rv-capacity-observation-request/1',
    binding: binding('beta-capacity-observe'),
    r2StandardBytes,
    actionsMinutesUsed,
    actionsMinutesLimit,
    backupObjectAgeSeconds,
    smtpDeliveryFailures24h,
    observedAt,
    evidenceSha256: createHash('sha256').update(material).digest('hex'),
    ...overrides,
  };
}

function request(url, {
  method = 'POST',
  token = null,
  json = undefined,
  headers = {},
} = {}) {
  const normalized = new Headers(headers);
  if (token) normalized.set('authorization', `Bearer ${token}`);
  if (json !== undefined) normalized.set('content-type', 'application/json');
  return new Request(url, {
    method,
    headers: normalized,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

async function body(response) {
  return await response.json();
}

test('GitHub OIDC claims are exact, private, short-lived and capability-bound', () => {
  const valid = validateGithubOidcClaims(claims(), POLICIES['beta-backup'], NOW);
  assert.deepEqual(valid.binding, binding());
  assert.equal(valid.capability, 'beta-backup');
  assert.equal(valid.oidcJti, 'beta-backup-oidc-jti-0001');

  const mutations = [
    ['iss', 'https://issuer.example'],
    ['aud', 'wrong-audience'],
    ['sub', `repo:${REPOSITORY}:ref:refs/heads/main`],
    ['repository', 'attacker/repo'],
    ['repository_id', '987654321'],
    ['repository_owner_id', '999999999'],
    ['repository_visibility', 'public'],
    ['ref', 'refs/heads/feature'],
    ['workflow_ref', POLICIES['beta-archive'].workflowRef],
    ['workflow_sha', 'b'.repeat(40)],
    ['environment', 'production'],
    ['event_name', 'pull_request'],
    ['runner_environment', 'self-hosted'],
    ['run_id', '0'],
    ['run_attempt', '0'],
    ['jti', 'bad jti'],
    ['nbf', NOW + 31],
    ['exp', NOW + 601],
  ];
  for (const [field, value] of mutations) {
    assert.throws(
      () => validateGithubOidcClaims(claims('beta-backup', { [field]: value }), POLICIES['beta-backup'], NOW),
      /OIDC/iu,
      field,
    );
  }
  assert.throws(
    () => validateGithubOidcClaims(claims('beta-backup'), POLICIES['beta-archive'], NOW),
    /OIDC/iu,
  );
});

test('single-job grant expires within 600 seconds and cannot cross capabilities', async () => {
  const codec = createGrantCodec(randomBytes(32));
  const authorization = validateGithubOidcClaims(claims(), POLICIES['beta-backup'], NOW);
  const issued = await codec.issue({ authorization, nowSeconds: NOW, ttlSeconds: 600 });
  assert.equal(issued.expiresIn, 300, 'grant cannot outlive the OIDC assertion');
  assert.equal((await codec.verify(issued.accessToken, {
    capability: 'beta-backup',
    nowSeconds: NOW + 1,
  })).binding.job, 'backup');
  assert.equal(await codec.verify(issued.accessToken, {
    capability: 'beta-archive',
    nowSeconds: NOW + 1,
  }), null);
  assert.equal(await codec.verify(issued.accessToken, {
    capability: 'beta-backup',
    nowSeconds: NOW + 301,
  }), null);
  assert.equal(await codec.verify(issued.accessToken + 'x', {
    capability: 'beta-backup',
    nowSeconds: NOW + 1,
  }), null);
});

test('Cloudflare temporary credential request is fixed-host, bucket/prefix-scoped and <=600s', () => {
  const built = createCloudflareTempCredentialRequest({
    accountId: 'a'.repeat(32),
    parentAccessKeyId: 'parent-access-key-01',
    bucket: 'private-beta-backups',
    prefix: 'beta-backups/runs/7612345678/attempt-2/',
    ttlSeconds: 600,
  });
  assert.equal(built.url,
    `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/r2/temp-access-credentials`);
  assert.deepEqual(built.body, {
    bucket: 'private-beta-backups',
    parentAccessKeyId: 'parent-access-key-01',
    permission: 'object-read-write',
    prefixes: ['beta-backups/runs/7612345678/attempt-2/'],
    ttlSeconds: 600,
  });
  assert.throws(() => createCloudflareTempCredentialRequest({
    accountId: 'a'.repeat(32),
    parentAccessKeyId: 'parent-access-key-01',
    bucket: 'private-beta-backups',
    prefix: '../escape/',
    ttlSeconds: 600,
  }), /prefix/iu);
  assert.throws(() => createCloudflareTempCredentialRequest({
    accountId: 'a'.repeat(32),
    parentAccessKeyId: 'parent-access-key-01',
    bucket: 'private-beta-backups',
    prefix: 'beta-backups/',
    ttlSeconds: 601,
  }), /600/iu);

  const oneObject = createCloudflareTempCredentialRequest({
    accountId: 'a'.repeat(32),
    parentAccessKeyId: 'parent-access-key-01',
    bucket: 'private-beta-backups',
    objects: ['beta-backups/runs/7612345678/attempt-2/ciphertext.ndjson.age'],
    permission: 'object-read-only',
    ttlSeconds: 60,
  });
  assert.deepEqual(oneObject.body.objects,
    ['beta-backups/runs/7612345678/attempt-2/ciphertext.ndjson.age']);
  assert.equal(oneObject.body.permission, 'object-read-only');
});

test('R2 HEAD is deterministic SigV4 over the fixed account endpoint and exact object', async () => {
  const secret = 'temporary-secret-value-0001';
  const built = await createR2SigV4HeadRequest({
    accountId: 'f'.repeat(32),
    bucket: 'private-beta-backups',
    objectKey: 'beta-backups/runs/7612345678/attempt-2/ciphertext.ndjson.age',
    credentials: {
      accessKeyId: 'temporary-access-key',
      secretAccessKey: secret,
      sessionToken: 'temporary-session-token-value-0001',
    },
    now: new Date('2026-08-31T01:02:03.000Z'),
  });
  assert.equal(built.method, 'HEAD');
  assert.equal(built.url,
    `https://${'f'.repeat(32)}.r2.cloudflarestorage.com/private-beta-backups/beta-backups/runs/7612345678/attempt-2/ciphertext.ndjson.age`);
  assert.match(built.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=temporary-access-key\/20260831\/auto\/s3\/aws4_request,/u);
  assert.equal(JSON.stringify(built).includes(secret), false);
  const changed = await createR2SigV4HeadRequest({
    accountId: 'f'.repeat(32),
    bucket: 'private-beta-backups',
    objectKey: 'beta-backups/runs/7612345678/attempt-2/other.ndjson.age',
    credentials: {
      accessKeyId: 'temporary-access-key',
      secretAccessKey: secret,
      sessionToken: 'temporary-session-token-value-0001',
    },
    now: new Date('2026-08-31T01:02:03.000Z'),
  });
  assert.notEqual(changed.headers.authorization, built.headers.authorization);
});

function runtimeEnvironment() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return new Map(Object.entries({
    SUPABASE_URL: 'https://' + ['abcdefghijklmnopqrst', 'supabase', 'co'].join('.'),
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-service-role-' + 's'.repeat(40),
    BETA_OPS_GRANT_HMAC_V1: Buffer.alloc(32, 1).toString('base64url'),
    BETA_OPS_RESTORE_TOMBSTONE_HMAC_V1: Buffer.alloc(32, 2).toString('base64url'),
    BETA_OPS_RESTORE_CLAIM_HMAC_V1: Buffer.alloc(32, 3).toString('base64url'),
    BETA_OPS_RESTORE_LEASE_HMAC_V1: Buffer.alloc(32, 4).toString('base64url'),
    BETA_OPS_BACKUP_SIGNING_PRIVATE_KEY_PKCS8_B64: pkcs8,
    BETA_OPS_GITHUB_REPOSITORY: REPOSITORY,
    BETA_OPS_GITHUB_REF: 'refs/heads/main',
    BETA_OPS_GITHUB_WORKFLOW_SHA: WORKFLOW_SHA,
    BETA_OPS_GITHUB_AUDIENCE: AUDIENCE,
    BETA_OPS_GITHUB_REPOSITORY_ID: REPOSITORY_ID,
    BETA_OPS_GITHUB_OWNER_ID: REPOSITORY_OWNER_ID,
    BETA_OPS_CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32),
    BETA_OPS_CLOUDFLARE_API_TOKEN: 'server-only-cloudflare-token-' + 'c'.repeat(32),
    BETA_OPS_R2_PARENT_ACCESS_KEY_ID: 'parent-access-key-01',
    BETA_OPS_R2_BUCKET: 'private-beta-backups',
    BETA_OPS_R2_PREFIX: 'beta-backups/',
    BETA_OPS_ARCHIVE_DOWNLOAD_HOST: 'archive-download.example',
    BETA_OPS_BACKUP_SIGNING_KEY_ID: 'backup-manifest-v1',
  }));
}

test('runtime config keeps four HMAC domains distinct and broker never returns the parent token', async () => {
  const environment = runtimeEnvironment();
  const config = readRuntimeConfig(name => environment.get(name));
  assert.ok(config);
  assert.deepEqual(config.policies['beta-archive'], {
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    ref: 'refs/heads/main',
    workflowSha: WORKFLOW_SHA,
    environment: 'beta-operations',
    eventNames: ['schedule', 'workflow_dispatch'],
    runnerEnvironment: 'github-hosted',
    subject: `repo:${REPOSITORY}:environment:beta-operations`,
    audience: AUDIENCE,
    capability: 'beta-archive',
    workflowRef: `${REPOSITORY}/.github/workflows/beta-archive.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-archive.yml@refs/heads/main`,
    job: 'archive',
  });
  assert.deepEqual(config.policies['beta-capacity-observe'], {
    ...config.policies['beta-backup'],
    capability: 'beta-capacity-observe',
  });
  assert.deepEqual(config.policies['beta-restore'], {
    ...config.policies['beta-backup'],
    capability: 'beta-restore',
    environment: 'beta-restore-operator',
    eventNames: ['workflow_dispatch'],
    subject: `repo:${REPOSITORY}:environment:beta-restore-operator`,
    workflowRef: `${REPOSITORY}/.github/workflows/beta-restore.yml@refs/heads/main`,
    jobWorkflowRef: `${REPOSITORY}/.github/workflows/beta-restore.yml@refs/heads/main`,
    job: 'restore',
  });
  const requests = [];
  const dependencies = createRuntimeDependencies(config, {
    verifyGithubOidc: async () => claims(),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        success: true,
        result: {
          accessKeyId: 'temporary-access-key',
          secretAccessKey: 'temporary-secret-value-0001',
          sessionToken: 'temporary-session-token-value-0001',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await dependencies.createR2TemporaryCredentials({
    bucket: 'private-beta-backups',
    prefix: 'beta-backups/runs/7612345678/attempt-2/',
    ttlSeconds: 300,
    context: { signal: new AbortController().signal },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${'f'.repeat(32)}/r2/temp-access-credentials`);
  assert.equal(JSON.parse(requests[0].init.body).prefixes[0],
    'beta-backups/runs/7612345678/attempt-2/');
  assert.equal(JSON.stringify(result).includes(environment.get('BETA_OPS_CLOUDFLARE_API_TOKEN')), false);
  assert.equal(JSON.stringify(result).includes('parent-access-key-01'), false);

  const duplicate = new Map(environment);
  duplicate.set('BETA_OPS_RESTORE_CLAIM_HMAC_V1', duplicate.get('BETA_OPS_GRANT_HMAC_V1'));
  assert.equal(readRuntimeConfig(name => duplicate.get(name)), null);
});

test('runtime independently HEADs the exact R2 object with read-only temporary credentials', async () => {
  const environment = runtimeEnvironment();
  const config = readRuntimeConfig(name => environment.get(name));
  const requests = [];
  const expectedKey = 'beta-backups/runs/7612345678/attempt-2/ciphertext.ndjson.age';
  const dependencies = createRuntimeDependencies(config, {
    verifyGithubOidc: async () => claims(),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/r2/temp-access-credentials')) {
        return new Response(JSON.stringify({
          success: true,
          result: {
            accessKeyId: 'temporary-access-key',
            secretAccessKey: 'temporary-secret-value-0001',
            sessionToken: 'temporary-session-token-value-0001',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, {
        status: 200,
        headers: {
          'content-length': '1234',
          'x-amz-meta-rv-sha256': 'c'.repeat(64),
        },
      });
    },
  });
  const evidence = await dependencies.inspectR2ObjectEvidence({
    authorization: { expiresAt: Math.floor(Date.now() / 1000) + 300 },
    bucket: 'private-beta-backups',
    objectKey: expectedKey,
    expectedBytes: 1234,
    expectedSha256: 'c'.repeat(64),
    context: { signal: new AbortController().signal },
  });
  assert.deepEqual(evidence, {
    verified: true,
    objectKey: expectedKey,
    bytes: 1234,
    sha256: 'c'.repeat(64),
  });
  const scope = JSON.parse(requests[0].init.body);
  assert.deepEqual(scope.objects, [expectedKey]);
  assert.equal(scope.permission, 'object-read-only');
  assert.equal(requests[1].init.method, 'HEAD');
  assert.match(requests[1].init.headers.authorization, /^AWS4-HMAC-SHA256 /u);
});

test('runtime restore broker calls only the same-project restore-v2 routes', async () => {
  const environment = runtimeEnvironment();
  const config = readRuntimeConfig(name => environment.get(name));
  const requests = [];
  const runtime = createRuntimeDependencies(config, {
    verifyGithubOidc: async () => claims('beta-restore'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const parsed = new URL(String(url));
      assert.equal(parsed.hostname, 'abcdefghijklmnopqrst.supabase.co');
      assert.match(parsed.pathname,
        /^\/functions\/v1\/restore-v2\/internal\/v2\/restore\/(?:publish|status)$/u);
      if (init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), {
          restoreId: '80000000-0000-4000-8000-000000000001',
          journalProof: { format: 'rv-deletion-journal-range-proof/2' },
        });
        return new Response(JSON.stringify({
          format: 'rv-restore-v2-publish-result/1',
          restoreId: '80000000-0000-4000-8000-000000000001',
          state: 'PUBLISHED', published: true, idempotent: false,
          credentialsRestored: 0, connectionState: 'RECONNECT_REQUIRED',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(parsed.searchParams.get('restore_id'),
        '80000000-0000-4000-8000-000000000001');
      return new Response(JSON.stringify({
        format: 'rv-restore-v2-status/1',
        restoreId: '80000000-0000-4000-8000-000000000001',
        state: 'PUBLISHED', published: true, credentialsRestored: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const publish = await runtime.invokeRestoreV2({
    operation: 'publish',
    body: {
      restoreId: '80000000-0000-4000-8000-000000000001',
      journalProof: { format: 'rv-deletion-journal-range-proof/2' },
    },
    context: { signal: new AbortController().signal },
  });
  assert.equal(publish.status, 200);
  const status = await runtime.invokeRestoreV2({
    operation: 'status',
    restoreId: '80000000-0000-4000-8000-000000000001',
    context: { signal: new AbortController().signal },
  });
  assert.equal(status.value.published, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.init.redirect === 'error'));
  assert.equal(JSON.stringify({ publish, status }).includes(
    environment.get('SUPABASE_SERVICE_ROLE_KEY')), false);
});

test('runtime exposes only tombstone/claim restore guards and narrow archive ingest RPCs', async () => {
  const environment = runtimeEnvironment();
  const config = readRuntimeConfig(name => environment.get(name));
  assert.ok(config);
  const rpcBodies = new Map();
  const rpcResults = {
    rv2_ops_apply_deletion_tombstones: { applied: true },
    rv2_ops_claim_restore_manifest: {
      accepted: true,
      first_use: true,
      lease_subject: 'tenant-fixture-01',
    },
    rv2_ops_ingest_archive_batch: {
      accepted: true,
      replayed: false,
      batch_sha256: 'a'.repeat(64),
      record_count: 1,
      total_batches: 1,
      source_file: 'fills.csv',
    },
    rv2_ops_attest_archive_payload: {
      accepted: true,
      replayed: false,
      archive_id: 'archive-1234',
      archive_sha256: 'c'.repeat(64),
      archive_bytes: 4096,
      evidence_source: 'WORKFLOW_OBSERVED',
      status: 'ATTESTED',
    },
    rv2_ops_fail_archive_claim: {
      accepted: true,
      replayed: false,
      archive_id: 'archive-1234',
      status: 'FAILED',
    },
    rv2_ops_finalize_archive: {
      accepted: true,
      replayed: false,
      archive_id: 'archive-1234',
      status: 'COMPLETED',
      finalize_sha256: 'f'.repeat(64),
      batch_set_sha256: 'b'.repeat(64),
      source_event_count: 1,
      inserted_count: 1,
      replayed_event_count: 0,
      conflict_count: 0,
      coverage_state: 'PARTIAL',
      gap_code: 'ARCHIVE_RECONCILIATION_PENDING',
      trusted_advanced: false,
    },
  };
  const dependencies = createRuntimeDependencies(config, {
    verifyGithubOidc: async () => claims(),
    fetch: async (url, init) => {
      const name = new URL(String(url)).pathname.split('/').at(-1);
      assert.ok(Object.hasOwn(rpcResults, name), name);
      rpcBodies.set(name, JSON.parse(init.body));
      return new Response(JSON.stringify(rpcResults[name]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const context = { signal: new AbortController().signal };
  await dependencies.applyDeletionTombstones({
    restoreId: 'restore-123',
    activeGeneration: 17,
    targetGeneration: 19,
    mode: 'new-generation',
    before: '2026-08-31T01:02:03.000Z',
    context,
  });
  const claimed = await dependencies.claimRestoreManifest({
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestNonce: 'a'.repeat(48),
    manifestSha256: 'c'.repeat(64),
    sourceRepository: REPOSITORY,
    sourceWorkflowRef: POLICIES['beta-backup'].workflowRef,
    sourceRunId: '7612345678',
    sourceRunAttempt: '2',
    context,
  });
  assert.deepEqual(claimed, {
    accepted: true,
    firstUse: true,
    leaseSubject: 'tenant-fixture-01',
  });
  assert.equal(Object.hasOwn(dependencies, 'importRestoreBatch'), false);
  assert.equal(Object.hasOwn(dependencies, 'finalizeRestore'), false);
  assert.equal(Object.hasOwn(dependencies, 'getRestoreStatus'), false);
  const attested = await dependencies.attestArchivePayload({
    authorization: { binding: { runId: '7612345678', runAttempt: '2' } },
    archiveId: 'archive-1234',
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 4096,
    context,
  });
  assert.deepEqual(attested, {
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 4096,
    evidenceSource: 'WORKFLOW_OBSERVED',
    status: 'ATTESTED',
  });
  const archive = await dependencies.ingestArchiveBatch({
    authorization: { binding: { runId: '7612345678', runAttempt: '2' } },
    archiveId: 'archive-1234',
    dataset: 'fills',
    batchIndex: 0,
    totalBatches: 1,
    sourceFile: 'fills.csv',
    records: [{ providerEventId: 'event-1' }],
    context,
  });
  assert.deepEqual(archive, {
    accepted: true,
    replayed: false,
    batchSha256: 'a'.repeat(64),
    recordCount: 1,
    totalBatches: 1,
    sourceFile: 'fills.csv',
  });
  const finalized = await dependencies.finalizeArchive({
    authorization: { binding: { runId: '7612345678', runAttempt: '2' } },
    archiveId: 'archive-1234',
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 4096,
    batchSetSha256: 'b'.repeat(64),
    rowCount: 1,
    context,
  });
  assert.deepEqual(finalized, {
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    status: 'COMPLETED',
    finalizeSha256: 'f'.repeat(64),
    batchSetSha256: 'b'.repeat(64),
    sourceEventCount: 1,
    insertedCount: 1,
    replayedEventCount: 0,
    conflictCount: 0,
    coverageState: 'PARTIAL',
    gapCode: 'ARCHIVE_RECONCILIATION_PENDING',
    trustedAdvanced: false,
  });
  const failed = await dependencies.failArchiveClaim({
    authorization: { binding: { runId: '7612345678', runAttempt: '2' } },
    archiveId: 'archive-1234',
    errorCode: 'ARCHIVE_PARSE_FAILED',
    context,
  });
  assert.deepEqual(failed, {
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    status: 'FAILED',
  });

  const exactKeys = (name, expected) => assert.deepEqual(
    Object.keys(rpcBodies.get(name)).sort(),
    expected.sort(),
    name,
  );
  exactKeys('rv2_ops_apply_deletion_tombstones', [
    'p_active_generation', 'p_before', 'p_mode', 'p_restore_id', 'p_target_generation',
  ]);
  exactKeys('rv2_ops_claim_restore_manifest', [
    'p_manifest_nonce', 'p_manifest_sha256', 'p_restore_id', 'p_source_repository',
    'p_source_run_attempt', 'p_source_run_id', 'p_source_workflow_ref', 'p_target_generation',
  ]);
  exactKeys('rv2_ops_ingest_archive_batch', [
    'p_archive_id', 'p_batch_index', 'p_dataset', 'p_records', 'p_run_attempt',
    'p_run_id', 'p_source_file', 'p_total_batches',
  ]);
  exactKeys('rv2_ops_attest_archive_payload', [
    'p_archive_bytes', 'p_archive_id', 'p_archive_sha256', 'p_run_attempt', 'p_run_id',
  ]);
  exactKeys('rv2_ops_fail_archive_claim', [
    'p_archive_id', 'p_error_code', 'p_run_attempt', 'p_run_id',
  ]);
  exactKeys('rv2_ops_finalize_archive', [
    'p_archive_bytes', 'p_archive_id', 'p_archive_sha256', 'p_batch_set_sha256',
    'p_row_count', 'p_run_attempt', 'p_run_id',
  ]);
});

test('database privilege failures fail closed without leaking backup rows', async () => {
  const environment = runtimeEnvironment();
  const config = readRuntimeConfig(name => environment.get(name));
  const runtime = createRuntimeDependencies(config, {
    verifyGithubOidc: async () => claims(),
    fetch: async () => new Response(JSON.stringify({
      message: 'permission denied',
      rows: [{ payload: 'sensitive-backup-row' }],
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const authorization = {
    capability: 'beta-backup',
    binding: binding('beta-backup'),
    oidcJtiSha256: 'a'.repeat(43),
  };
  await assert.rejects(
    runtime.readBackupPage({
      authorization,
      cursor: null,
      limit: 1000,
      view: 'beta_backup_v1',
      context: { signal: new AbortController().signal },
    }),
    error => error?.message === 'database unavailable'
      && !error.message.includes('sensitive-backup-row'),
  );

  const { handler } = makeHandler({ readBackupPage: runtime.readBackupPage });
  const { value: token } = await exchange(handler, 'beta-backup');
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/view?view=beta_backup_v1&limit=1000',
    { method: 'GET', token: token.access_token },
  ));
  const errorBody = await body(response);
  assert.equal(response.status, 503);
  assert.deepEqual(errorBody, { error: 'operation_unavailable' });
  assert.doesNotMatch(JSON.stringify(errorBody), /permission denied|sensitive-backup-row/iu);
});

function makeDependencies() {
  const codec = createGrantCodec(Buffer.alloc(32, 7));
  const restoreLeaseCodec = createRestoreLeaseCodec(Buffer.alloc(32, 8));
  const usedOidc = new Set();
  const usedRestore = new Set();
  const archiveBatches = new Set();
  const calls = [];
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    calls,
    deps: {
      nowSeconds: () => NOW,
      verifyGithubOidc: async token => {
        calls.push(['verifyGithubOidc', token.length]);
        if (token.includes('restore')) return claims('beta-restore');
        if (token.includes('archive')) return claims('beta-archive');
        if (token.includes('capacity')) return claims('beta-capacity-observe');
        return claims('beta-backup');
      },
      claimOidcJti: async value => {
        calls.push(['claimOidcJti', value.capability, value.oidcJti]);
        if (usedOidc.has(value.oidcJti)) return false;
        usedOidc.add(value.oidcJti);
        return true;
      },
      issueGrant: value => codec.issue(value),
      verifyGrant: (token, value) => codec.verify(token, value),
      createR2TemporaryCredentials: async value => {
        calls.push(['createR2TemporaryCredentials', value]);
        return {
          accessKeyId: 'temporary-access-key',
          secretAccessKey: 'temporary-secret-value-0001',
          sessionToken: 'temporary-session-token-value-0001',
          expiresIn: value.ttlSeconds,
        };
      },
      readBackupPage: async value => {
        calls.push(['readBackupPage', value]);
        return {
          format: 'beta-backup-page/1',
          view: 'beta_backup_v1',
          readOnly: true,
          snapshotId: 'snapshot-fixture',
          generation: 17,
          dataset: 'trades',
          rows: [{ id: 'trade-1' }],
          nextCursor: null,
        };
      },
      recordBackupPageEvidence: async value => {
        calls.push(['recordBackupPageEvidence', value]);
        return true;
      },
      readBackupV2Page: async value => {
        calls.push(['readBackupV2Page', value]);
        return restoreV2Page();
      },
      recordBackupV2PageEvidence: async value => {
        calls.push(['recordBackupV2PageEvidence', value]);
        return true;
      },
      claimBackupV2SigningEvidence: async value => {
        calls.push(['claimBackupV2SigningEvidence', value]);
        return true;
      },
      recordCapacityObservation: async value => {
        calls.push(['recordCapacityObservation', value]);
        return {
          format: 'rv-capacity-observation/1',
          recorded: true,
          replayed: false,
          observedAt: value.observedAt,
          externalUsageKnown: true,
          admissionAllowed: true,
          historyAllowed: true,
          maintenanceReadOnly: false,
          warningCodes: value.smtpDeliveryFailures24h > 0 ? ['SMTP_DELIVERY_FAILURES'] : [],
        };
      },
      inspectR2PrivateAccess: async value => {
        calls.push(['inspectR2PrivateAccess', value]);
        return { r2DevPublic: false, activeCustomDomains: [] };
      },
      signCanonicalManifest: async value => {
        calls.push(['signCanonicalManifest', value.keyId, value.canonicalManifest.length]);
        return sign(null, Buffer.from(value.canonicalManifest), privateKey).toString('base64url');
      },
      inspectR2ObjectEvidence: async value => {
        calls.push(['inspectR2ObjectEvidence', value]);
        return {
          verified: true,
          objectKey: value.objectKey,
          bytes: value.expectedBytes,
          sha256: value.expectedSha256,
        };
      },
      claimBackupSigningEvidence: async value => {
        calls.push(['claimBackupSigningEvidence', value]);
        return true;
      },
      verifyRestoreTombstoneSignature: async value => value.signature === 'sha256=' + '1'.repeat(64),
      applyDeletionTombstones: async value => {
        calls.push(['applyDeletionTombstones', value]);
        return { applied: true, tombstonesApplied: 2 };
      },
      verifyRestoreClaimSignature: async value => value.signature === 'sha256=' + '2'.repeat(64),
      claimRestoreManifest: async value => {
        calls.push(['claimRestoreManifest', value]);
        const key = `${value.manifestNonce}:${value.manifestSha256}`;
        if (usedRestore.has(key)) {
          return { accepted: false, firstUse: false, leaseSubject: null };
        }
        usedRestore.add(key);
        return { accepted: true, firstUse: true, leaseSubject: 'tenant-fixture-01' };
      },
      issueRestoreLease: value => restoreLeaseCodec.issue(value),
      verifyRestoreLease: (token, value) => restoreLeaseCodec.verify(token, value),
      invokeRestoreV2: async value => {
        calls.push(['invokeRestoreV2', value]);
        const restoreId = value.restoreId
          ?? value.body?.restoreId
          ?? '80000000-0000-4000-8000-000000000001';
        if (value.operation === 'claim') {
          return { status: 200, value: {
            format: 'rv-restore-v2-claim-result/1',
            restoreId,
            state: 'STAGING',
            published: false,
            manifestTrust: 'VERIFIED_V2',
            journalProofVerified: true,
            idempotent: false,
          } };
        }
        if (value.operation === 'stage') {
          return { status: 200, value: {
            format: 'rv-restore-v2-stage-result/1',
            restoreId,
            state: 'AWAITING_OWNER_CLAIMS',
            accepted: true,
            receivedBatches: 1,
            receivedRows: 3,
            graphVerified: true,
            ownerClaimsRequired: 1,
            credentialsAccepted: 0,
          } };
        }
        if (value.operation === 'publish') {
          return { status: 200, value: {
            format: 'rv-restore-v2-publish-result/1',
            restoreId,
            state: 'PUBLISHED',
            published: true,
            idempotent: false,
            credentialsRestored: 0,
            connectionState: 'RECONNECT_REQUIRED',
          } };
        }
        return { status: 200, value: {
          format: 'rv-restore-v2-status/1',
          restoreId,
          snapshotId: '20000000-0000-4000-8000-000000000001',
          state: 'PUBLISHABLE',
          published: false,
          blockingReasons: [],
          graphVerified: true,
          journalProofVerified: true,
          receivedBatches: 1,
          expectedBatches: 1,
          ownerClaimsRequired: 1,
          ownerClaimsCompleted: 1,
          credentialsRestored: 0,
          connectionStateAfterRestore: 'RECONNECT_REQUIRED',
        } };
      },
      createArchiveDownload: async value => {
        calls.push(['createArchiveDownload', value]);
        return {
          archiveId: 'archive-1234',
          archiveSha256: null,
          archiveBytes: null,
          downloadUrl: 'https://archive-download.example/one-time/opaque-ticket',
          expiresAt: new Date((NOW + 300) * 1000).toISOString(),
        };
      },
      attestArchivePayload: async value => {
        calls.push(['attestArchivePayload', value]);
        return {
          accepted: true,
          replayed: false,
          archiveId: value.archiveId,
          archiveSha256: value.archiveSha256,
          archiveBytes: value.archiveBytes,
          evidenceSource: 'WORKFLOW_OBSERVED',
          status: 'ATTESTED',
        };
      },
      failArchiveClaim: async value => {
        calls.push(['failArchiveClaim', value]);
        return {
          accepted: true,
          replayed: false,
          archiveId: value.archiveId,
          status: 'FAILED',
        };
      },
      ingestArchiveBatch: async value => {
        calls.push(['ingestArchiveBatch', value]);
        const key = `${value.archiveId}:${value.dataset}:${value.batchIndex}`;
        if (archiveBatches.has(key)) return { accepted: true, replayed: true };
        archiveBatches.add(key);
        return {
          accepted: true,
          replayed: false,
          batchSha256: 'a'.repeat(64),
          recordCount: value.records.length,
          totalBatches: value.totalBatches,
          sourceFile: value.sourceFile,
        };
      },
      finalizeArchive: async value => {
        calls.push(['finalizeArchive', value]);
        return {
          accepted: true,
          replayed: false,
          archiveId: value.archiveId,
          status: 'COMPLETED',
          finalizeSha256: 'f'.repeat(64),
          batchSetSha256: value.batchSetSha256,
          sourceEventCount: value.rowCount,
          insertedCount: value.rowCount,
          replayedEventCount: 0,
          conflictCount: 0,
          coverageState: 'PARTIAL',
          gapCode: 'ARCHIVE_RECONCILIATION_PENDING',
          trustedAdvanced: false,
        };
      },
    },
  };
}

function makeHandler(overrides = {}) {
  const state = makeDependencies();
  const handler = createBetaOperationsHandler({
    ...state.deps,
    ...overrides,
    policies: POLICIES,
    r2Bucket: 'private-beta-backups',
    r2Prefix: 'beta-backups/',
    archiveDownloadHost: 'archive-download.example',
    backupSigningKeyId: 'backup-manifest-v1',
  });
  return { ...state, handler };
}

async function exchange(handler, capability) {
  const context = binding(capability);
  const response = await handler(request('https://edge.example/beta-operations/internal/v1/token/exchange', {
    token: `${capability}-${'x'.repeat(64)}`,
    json: {
      format: 'beta-job-token-request/1',
      audience: AUDIENCE,
      binding: context,
      requested_ttl_seconds: 600,
      requested_capability: capability,
    },
  }));
  return { response, value: await body(response) };
}

async function claimRestoreLease(handler, {
  restoreId = 'restore-123',
  targetGeneration = 18,
  manifestNonce = 'a'.repeat(48),
  manifestSha256 = createHash('sha256').update('manifest').digest('hex'),
} = {}) {
  const claim = {
    format: 'beta-restore-manifest-claim/1',
    restoreId,
    targetGeneration,
    manifestNonce,
    manifestSha256,
    sourceRepository: REPOSITORY,
    sourceWorkflowRef: POLICIES['beta-backup'].workflowRef,
    sourceRunId: '7612345678',
    sourceRunAttempt: '2',
  };
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/manifest-claim',
    {
      headers: { 'x-beta-restore-claim-signature': 'sha256=' + '2'.repeat(64) },
      json: claim,
    },
  ));
  return { claim, response, value: await body(response) };
}

test('token exchange mints backup-only R2 credentials and rejects OIDC replay', async () => {
  const { handler, calls } = makeHandler();
  const first = await exchange(handler, 'beta-backup');
  assert.equal(first.response.status, 200);
  assert.equal(first.value.format, 'beta-job-token/1');
  assert.equal(first.value.expires_in, 300);
  assert.deepEqual(first.value.binding, binding('beta-backup'));
  assert.deepEqual(first.value.r2_credentials, {
    access_key_id: 'temporary-access-key',
    secret_access_key: 'temporary-secret-value-0001',
    session_token: 'temporary-session-token-value-0001',
    expires_in: 300,
  });
  assert.equal(first.value.r2_scope_prefix,
    'beta-backups/runs/7612345678/attempt-2/');
  const broker = calls.find(call => call[0] === 'createR2TemporaryCredentials');
  assert.equal(broker[1].bucket, 'private-beta-backups');
  assert.equal(broker[1].prefix, 'beta-backups/runs/7612345678/attempt-2/');
  assert.equal(broker[1].ttlSeconds, 300);

  const replay = await exchange(handler, 'beta-backup');
  assert.equal(replay.response.status, 401);
  assert.equal(replay.value.error, 'authentication_required');
});

test('archive exchange never receives R2 credentials and grant cannot use backup routes', async () => {
  const { handler, calls } = makeHandler();
  const archive = await exchange(handler, 'beta-archive');
  assert.equal(archive.response.status, 200);
  assert.equal(Object.hasOwn(archive.value, 'r2_credentials'), false);
  assert.equal(calls.some(call => call[0] === 'createR2TemporaryCredentials'), false);

  const denied = await handler(request(
    'https://edge.example/beta-operations/internal/v1/r2/private-attestation',
    { token: archive.value.access_token, json: { format: 'r2-private-access-request/1', bucket: 'private-beta-backups' } },
  ));
  assert.equal(denied.status, 401);
});

test('backup grant proxies only the fixed read-only view and private R2 attestation', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-backup');

  const page = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/view?view=beta_backup_v1&limit=1000',
    { method: 'GET', token: token.access_token },
  ));
  assert.equal(page.status, 200);
  assert.equal((await body(page)).readOnly, true);
  const viewCall = calls.find(call => call[0] === 'readBackupPage')[1];
  assert.deepEqual({ cursor: viewCall.cursor, limit: viewCall.limit, view: viewCall.view }, {
    cursor: null,
    limit: 1000,
    view: 'beta_backup_v1',
  });
  assert.equal(viewCall.authorization.capability, 'beta-backup');

  const attestation = await handler(request(
    'https://edge.example/beta-operations/internal/v1/r2/private-attestation',
    { token: token.access_token, json: { format: 'r2-private-access-request/1', bucket: 'private-beta-backups' } },
  ));
  assert.deepEqual(await body(attestation), {
    format: 'r2-private-access/1',
    bucket: 'private-beta-backups',
    checkedAt: new Date(NOW * 1000).toISOString(),
    r2DevPublic: false,
    activeCustomDomains: 0,
  });

  for (const url of [
    'https://edge.example/beta-operations/internal/v1/backup/view?view=other&limit=1000',
    'https://edge.example/beta-operations/internal/v1/backup/view?view=beta_backup_v1&limit=1000&url=https://evil.test',
  ]) {
    assert.equal((await handler(request(url, { method: 'GET', token: token.access_token }))).status, 400);
  }
});

test('restore-v2 backup uses a frozen 250-row page contract and persists every page receipt', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-backup');
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v2/backup/view'
      + '?view=rv2_restore_export_v2&limit=250',
    { method: 'GET', token: token.access_token },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), restoreV2Page());
  const read = calls.find(call => call[0] === 'readBackupV2Page')[1];
  assert.deepEqual({ cursor: read.cursor, limit: read.limit }, { cursor: null, limit: 250 });
  assert.equal(read.authorization.capability, 'beta-backup');
  const receipt = calls.find(call => call[0] === 'recordBackupV2PageEvidence')[1];
  assert.equal(receipt.page.snapshotId, restoreV2Page().snapshotId);
  assert.equal(receipt.cursor, null);

  for (const url of [
    'https://edge.example/beta-operations/internal/v2/backup/view?view=rv2_restore_export_v2&limit=249',
    'https://edge.example/beta-operations/internal/v2/backup/view?view=rv2_restore_export_v2&limit=250&url=https://evil.test',
    'https://edge.example/beta-operations/internal/v2/backup/view?view=rv2_restore_export_v2&limit=250&cursor=-1',
  ]) {
    assert.equal((await handler(request(url, {
      method: 'GET', token: token.access_token,
    }))).status, 400);
  }
});

test('deletion-journal grant is read-only, fixed-prefix and exact-job bound', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-backup');
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v2/r2/journal-credentials',
    {
      token: token.access_token,
      json: {
        format: 'rv-deletion-journal-r2-grant-request/2',
        binding: binding('beta-backup'),
      },
    },
  ));
  const value = await body(response);
  assert.equal(response.status, 200);
  assert.equal(value.prefix, 'deletion-journal/v2/');
  assert.deepEqual(value.binding, binding('beta-backup'));
  const grant = calls.filter(call => call[0] === 'createR2TemporaryCredentials').at(-1)[1];
  assert.deepEqual({
    bucket: grant.bucket,
    prefix: grant.prefix,
    permission: grant.permission,
  }, {
    bucket: 'private-beta-backups',
    prefix: 'deletion-journal/v2/',
    permission: 'object-read-only',
  });

  const substituted = await handler(request(
    'https://edge.example/beta-operations/internal/v2/r2/journal-credentials',
    {
      token: token.access_token,
      json: {
        format: 'rv-deletion-journal-r2-grant-request/2',
        binding: { ...binding('beta-backup'), runAttempt: '3' },
      },
    },
  ));
  assert.equal(substituted.status, 401);
});

test('restore OIDC is manual-only, cross-job isolated and mints exact-object read grants', async () => {
  const { handler, calls } = makeHandler();
  const restore = await exchange(handler, 'beta-restore');
  assert.equal(restore.response.status, 200);
  assert.deepEqual(restore.value.binding, binding('beta-restore'));
  assert.equal(Object.hasOwn(restore.value, 'r2_credentials'), false);

  const objectKey = 'beta-backups/runs/7612345678/attempt-2/20260831-010203004Z.manifest.json';
  const claimed = await handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/object-claim',
    {
      token: restore.value.access_token,
      json: {
        format: 'rv-restore-r2-object-claim/1',
        binding: binding('beta-restore'),
        objectKey,
      },
    },
  ));
  assert.equal(claimed.status, 200);
  const objectGrant = await body(claimed);
  assert.equal(objectGrant.objectKey, objectKey);
  assert.deepEqual(objectGrant.binding, binding('beta-restore'));
  const broker = calls.filter(call => call[0] === 'createR2TemporaryCredentials').at(-1)[1];
  assert.deepEqual({
    objects: broker.objects,
    prefix: broker.prefix,
    permission: broker.permission,
  }, {
    objects: [objectKey],
    prefix: undefined,
    permission: 'object-read-only',
  });

  const backupState = makeHandler();
  const { value: backup } = await exchange(backupState.handler, 'beta-backup');
  assert.equal((await backupState.handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/object-claim',
    {
      token: backup.access_token,
      json: {
        format: 'rv-restore-r2-object-claim/1',
        binding: binding('beta-backup'),
        objectKey,
      },
    },
  ))).status, 401);

  const wrongJob = makeHandler();
  const response = await wrongJob.handler(request(
    'https://edge.example/beta-operations/internal/v1/token/exchange',
    {
      token: `beta-backup-${'x'.repeat(64)}`,
      json: {
        format: 'beta-job-token-request/1',
        audience: AUDIENCE,
        binding: binding('beta-restore'),
        requested_ttl_seconds: 600,
        requested_capability: 'beta-restore',
      },
    },
  ));
  assert.equal(response.status, 401);
});

test('restore proxy binds claim, stage, final proof and status to the restore grant', async () => {
  const { handler, calls } = makeHandler();
  const { value: restore } = await exchange(handler, 'beta-restore');
  const restoreId = '80000000-0000-4000-8000-000000000001';
  const claim = await handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/claim',
    {
      token: restore.access_token,
      json: { envelope: { format: 'rv-restore-snapshot-envelope/2' }, journalProof: {} },
    },
  ));
  assert.equal(claim.status, 200);
  assert.equal((await body(claim)).state, 'STAGING');

  const stage = await handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/import',
    {
      token: restore.access_token,
      json: {
        restoreId,
        batchIndex: 0,
        totalBatches: 1,
        idempotencyKey: '90000000-0000-4000-8000-000000000001',
        rows: [],
      },
    },
  ));
  assert.equal(stage.status, 200);

  const finalProof = { ...deletionJournalProof(), effectiveTenantLineageRoot: 'a'.repeat(64) };
  const finalize = await handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/finalize',
    {
      token: restore.access_token,
      json: { restoreId, journalProof: finalProof },
    },
  ));
  assert.equal(finalize.status, 200);
  assert.equal((await body(finalize)).state, 'PUBLISHED');
  const publishCall = calls.find(call => call[0] === 'invokeRestoreV2'
    && call[1].operation === 'publish')[1];
  assert.deepEqual(publishCall.body, { restoreId, journalProof: finalProof });

  const status = await handler(request(
    `https://edge.example/beta-operations/internal/v2/restore/status?restore_id=${restoreId}`,
    { method: 'GET', token: restore.access_token },
  ));
  assert.equal(status.status, 200);
  assert.equal((await body(status)).state, 'PUBLISHABLE');

  const archiveState = makeHandler();
  const { value: archive } = await exchange(archiveState.handler, 'beta-archive');
  assert.equal((await archiveState.handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/finalize',
    { token: archive.access_token, json: { restoreId, journalProof: finalProof } },
  ))).status, 401);
});

test('restore target-nonempty quarantine is preserved and never rewritten as success', async () => {
  const { handler } = makeHandler({
    invokeRestoreV2: async () => ({
      status: 200,
      value: {
        format: 'rv-restore-v2-claim-result/1',
        restoreId: '80000000-0000-4000-8000-000000000001',
        state: 'QUARANTINED',
        published: false,
        blockingReasons: ['TARGET_PROJECT_NOT_EMPTY'],
      },
    }),
  });
  const { value: restore } = await exchange(handler, 'beta-restore');
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v2/restore/claim',
    {
      token: restore.access_token,
      json: { envelope: { format: 'rv-restore-snapshot-envelope/2' }, journalProof: {} },
    },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    format: 'rv-restore-v2-claim-result/1',
    restoreId: '80000000-0000-4000-8000-000000000001',
    state: 'QUARANTINED',
    published: false,
    blockingReasons: ['TARGET_PROJECT_NOT_EMPTY'],
  });
});

test('capacity observation accepts only PII-free aggregates under its exact no-R2 OIDC grant', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-capacity-observe');
  assert.deepEqual(Object.keys(token).sort(), [
    'access_token', 'binding', 'expires_in', 'format', 'token_type',
  ]);
  const observation = capacityObservation();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/capacity/observe',
    { token: token.access_token, json: observation },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    format: 'rv-capacity-observation/1',
    recorded: true,
    replayed: false,
    observedAt: observation.observedAt,
    externalUsageKnown: true,
    admissionAllowed: true,
    historyAllowed: true,
    maintenanceReadOnly: false,
    warningCodes: ['SMTP_DELIVERY_FAILURES'],
  });
  const recorded = calls.find(call => call[0] === 'recordCapacityObservation')[1];
  assert.deepEqual({
    r2StandardBytes: recorded.r2StandardBytes,
    actionsMinutesUsed: recorded.actionsMinutesUsed,
    actionsMinutesLimit: recorded.actionsMinutesLimit,
    backupObjectAgeSeconds: recorded.backupObjectAgeSeconds,
    smtpDeliveryFailures24h: recorded.smtpDeliveryFailures24h,
    observedAt: recorded.observedAt,
  }, {
    r2StandardBytes: 1024,
    actionsMinutesUsed: '12.345',
    actionsMinutesLimit: '2000.000',
    backupObjectAgeSeconds: 3600,
    smtpDeliveryFailures24h: 1,
    observedAt: observation.observedAt,
  });
  assert.equal(recorded.authorization.capability, 'beta-capacity-observe');
  assert.doesNotMatch(JSON.stringify(recorded), /tenantId|userId|connectionId|email/iu);
});

test('capacity observation rejects forged evidence, extra identity fields and archive grants', async () => {
  for (const invalid of [
    capacityObservation({ evidenceSha256: '0'.repeat(64) }),
    { ...capacityObservation(), userId: '10000000-0000-4000-8000-000000000001' },
    capacityObservation({ actionsMinutesUsed: '12.3450' }),
    capacityObservation({ observedAt: '2020-01-01T00:00:00.000Z' }),
  ]) {
    const { handler } = makeHandler();
    const { value: token } = await exchange(handler, 'beta-capacity-observe');
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/capacity/observe',
      { token: token.access_token, json: invalid },
    ));
    assert.equal(response.status, 400);
  }

  const { handler } = makeHandler();
  const { value: archive } = await exchange(handler, 'beta-archive');
  assert.equal((await handler(request(
    'https://edge.example/beta-operations/internal/v1/capacity/observe',
    { token: archive.access_token, json: capacityObservation() },
  ))).status, 401);

  const backupState = makeHandler();
  const { value: backup } = await exchange(backupState.handler, 'beta-backup');
  assert.equal((await backupState.handler(request(
    'https://edge.example/beta-operations/internal/v1/capacity/observe',
    { token: backup.access_token, json: capacityObservation() },
  ))).status, 401);
});

test('R2 attestation fails closed when any public route exists or provider inspection fails', async () => {
  for (const inspectR2PrivateAccess of [
    async () => ({ r2DevPublic: true, activeCustomDomains: [] }),
    async () => ({ r2DevPublic: false, activeCustomDomains: ['public.example'] }),
    async () => { throw new Error('provider unavailable'); },
  ]) {
    const { handler } = makeHandler({ inspectR2PrivateAccess });
    const { value: token } = await exchange(handler, 'beta-backup');
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/r2/private-attestation',
      { token: token.access_token, json: { format: 'r2-private-access-request/1', bucket: 'private-beta-backups' } },
    ));
    assert.equal(response.status, 503);
  }
});

test('backup proxy rejects credentials and fields outside the approved view schema', async () => {
  for (const rows of [
    [{ id: 'trade-1', apiSecret: 'must-never-leave-server' }],
    [{ id: 'trade-1', unreviewedColumn: 'no' }],
    [{ id: 'trade-1', payload: { accessToken: 'opaque-token' } }],
  ]) {
    const { handler } = makeHandler({
      readBackupPage: async () => ({
        format: 'beta-backup-page/1',
        view: 'beta_backup_v1',
        readOnly: true,
        snapshotId: 'snapshot-fixture',
        generation: 17,
        dataset: 'trades',
        rows,
        nextCursor: null,
      }),
    });
    const { value: token } = await exchange(handler, 'beta-backup');
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/backup/view?view=beta_backup_v1&limit=1000',
      { method: 'GET', token: token.access_token },
    ));
    assert.equal(response.status, 503);
    assert.doesNotMatch(JSON.stringify(await body(response)), /must-never|opaque-token/iu);
  }
});

test('reports use one explicit field contract across backup and restore', async () => {
  const report = {
    id: 'report-1',
    tenantId: 'tenant-1',
    connectionId: 'connection-1',
    reportId: 'report-1',
    reportType: 'WEEKLY',
    periodStart: '2026-08-24',
    periodEnd: '2026-08-30',
    sourceGeneration: 17,
    version: 1,
    payload: { title: 'weekly review' },
    payloadSha256: 'f'.repeat(64),
    createdBy: 'member-1',
    createdAt: '2026-08-31T01:00:00.000Z',
    updatedAt: '2026-08-31T01:00:00.000Z',
  };
  const { handler } = makeHandler({
    readBackupPage: async () => ({
      format: 'beta-backup-page/1',
      view: 'beta_backup_v1',
      readOnly: true,
      snapshotId: 'snapshot-fixture',
      generation: 17,
      dataset: 'reports',
      rows: [report],
      nextCursor: null,
    }),
  });
  const { value: token } = await exchange(handler, 'beta-backup');
  const backup = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/view?view=beta_backup_v1&limit=1000',
    { method: 'GET', token: token.access_token },
  ));
  assert.equal(backup.status, 200);
  assert.equal((await body(backup)).dataset, 'reports');

  const claimed = await claimRestoreLease(handler, { manifestNonce: 'b'.repeat(48) });
  assert.equal(claimed.response.status, 200);
  const restoreReport = { ...report };
  delete restoreReport.tenantId;
  const batch = {
    format: 'beta-restore-import-batch/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    mode: 'new-generation',
    dataset: 'reports',
    batchIndex: 0,
    totalBatches: 1,
    records: [restoreReport],
  };
  const idempotencyKey = 'restore-batch-'
    + createHash('sha256').update(canonicalJson(batch)).digest('hex');
  const imported = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/import-batch',
    {
      token: claimed.value.restoreLease,
      headers: { 'idempotency-key': idempotencyKey },
      json: batch,
    },
  ));
  assert.equal(imported.status, 503);
  assert.deepEqual(await body(imported), {
    format: 'beta-restore-not-ready/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestSha256: claimed.claim.manifestSha256,
    state: 'NOT_READY',
    published: false,
    reason: 'RESTORE_PROOF_INCOMPLETE',
    blockingReasons: [
      'TENANT_LINEAGE_UNVERIFIED',
      'AUTH_IDENTITY_MAPPING_UNVERIFIED',
      'EXTERNAL_DELETION_JOURNAL_UNAVAILABLE',
    ],
  });
});

test('manifest signing is canonical, job-bound and Ed25519-only', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-backup');
  const value = manifest();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'beta-backup-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: value,
      },
    },
  ));
  const envelope = await body(response);
  assert.equal(response.status, 200);
  assert.equal(envelope.algorithm, 'Ed25519');
  assert.equal(envelope.keyId, 'backup-manifest-v1');
  assert.match(envelope.signature, /^[A-Za-z0-9_-]{80,128}$/u);
  const evidence = calls.find(call => call[0] === 'claimBackupSigningEvidence');
  assert.equal(evidence[1].scopePrefix, 'beta-backups/runs/7612345678/attempt-2/');
  assert.equal(evidence[1].manifest.snapshotId, 'snapshot-20260831');
  assert.equal(evidence[1].objectEvidence.verified, true);

  const substituted = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'beta-backup-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: { ...value, generation: 18 },
      },
    },
  ));
  assert.equal(substituted.status, 400);
});

test('restore-v2 signing is domain-separated and requires page, journal and R2 evidence', async () => {
  let signedPayload = null;
  const { handler, calls } = makeHandler({
    signCanonicalManifest: async value => {
      signedPayload = value.canonicalManifest;
      return 'x'.repeat(86);
    },
  });
  const { value: token } = await exchange(handler, 'beta-backup');
  const value = restoreV2Manifest();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v2/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'rv-restore-v2-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: value,
        journalProof: deletionJournalProof(),
        ciphertext: {
          objectKey: 'beta-backups/runs/7612345678/attempt-2/snapshot.ndjson.age',
          sha256: 'f'.repeat(64),
          bytes: 4096,
        },
      },
    },
  ));
  const envelope = await body(response);
  assert.equal(response.status, 200);
  assert.equal(envelope.format, 'rv-restore-snapshot-envelope/2');
  assert.equal(envelope.algorithm, 'Ed25519');
  assert.equal(signedPayload, 'rv-restore-v2-manifest/1\0' + canonicalJson(value));
  const claim = calls.find(call => call[0] === 'claimBackupV2SigningEvidence')[1];
  assert.equal(claim.manifest.snapshotId, value.snapshotId);
  assert.equal(claim.journalProof.snapshotJournalRoot, value.externalJournalRoot);
  assert.equal(claim.objectEvidence.objectKey,
    'beta-backups/runs/7612345678/attempt-2/snapshot.ndjson.age');
});

test('restore-v2 routes reject an archive grant and fail closed before signing on missing evidence', async () => {
  const archiveState = makeHandler();
  const { value: archiveToken } = await exchange(archiveState.handler, 'beta-archive');
  assert.equal((await archiveState.handler(request(
    'https://edge.example/beta-operations/internal/v2/backup/view'
      + '?view=rv2_restore_export_v2&limit=250',
    { method: 'GET', token: archiveToken.access_token },
  ))).status, 401);

  let signed = false;
  const { handler } = makeHandler({
    claimBackupV2SigningEvidence: async () => false,
    signCanonicalManifest: async () => { signed = true; return 'x'.repeat(86); },
  });
  const { value: token } = await exchange(handler, 'beta-backup');
  const value = restoreV2Manifest();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v2/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'rv-restore-v2-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: value,
        journalProof: deletionJournalProof(),
        ciphertext: {
          objectKey: 'beta-backups/runs/7612345678/attempt-2/snapshot.ndjson.age',
          sha256: 'f'.repeat(64),
          bytes: 4096,
        },
      },
    },
  ));
  assert.equal(response.status, 503);
  assert.equal(signed, false);
});

test('restore first applies deletion tombstones then accepts one manifest nonce/digest once', async () => {
  const { handler, calls } = makeHandler();
  const tombstone = {
    format: 'beta-restore-tombstone/1',
    restoreId: 'restore-123',
    activeGeneration: 17,
    targetGeneration: 19,
    mode: 'new-generation',
    issuedAt: new Date((NOW - 30) * 1000).toISOString(),
    expiresAt: new Date((NOW + 300) * 1000).toISOString(),
    nonce: 'd'.repeat(32),
  };
  const applied = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/tombstone',
    {
      headers: { 'x-beta-tombstone-signature': 'sha256=' + '1'.repeat(64) },
      json: tombstone,
    },
  ));
  assert.deepEqual(await body(applied), {
    format: 'beta-restore-tombstone-result/1',
    applied: true,
    restoreId: 'restore-123',
    targetGeneration: 19,
  });
  assert.equal(calls.findIndex(call => call[0] === 'applyDeletionTombstones') >= 0, true);

  const { claim, response: first, value: firstValue } = await claimRestoreLease(handler, {
    targetGeneration: 19,
  });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(firstValue).sort(), [
    'accepted', 'firstUse', 'format', 'leaseExpiresAt', 'manifestNonce',
    'manifestSha256', 'replayDetected', 'restoreId', 'restoreLease', 'targetGeneration',
  ].sort());
  assert.deepEqual({
    ...firstValue,
    restoreLease: '<lease>',
    leaseExpiresAt: '<expiry>',
  }, {
    format: 'beta-restore-manifest-claim-result/1',
    accepted: true,
    firstUse: true,
    replayDetected: false,
    restoreId: 'restore-123',
    targetGeneration: 19,
    manifestNonce: claim.manifestNonce,
    manifestSha256: claim.manifestSha256,
    restoreLease: '<lease>',
    leaseExpiresAt: '<expiry>',
  });
  assert.match(firstValue.restoreLease, /^bgr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(firstValue.leaseExpiresAt, new Date((NOW + 600) * 1000).toISOString());
  const replay = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/manifest-claim',
    {
      headers: { 'x-beta-restore-claim-signature': 'sha256=' + '2'.repeat(64) },
      json: claim,
    },
  ));
  assert.equal(replay.status, 409);

  for (const invalid of [
    { ...tombstone, mode: 'overwrite' },
    { ...tombstone, targetGeneration: tombstone.activeGeneration },
  ]) {
    assert.equal((await handler(request(
      'https://edge.example/beta-operations/internal/v1/restore/tombstone',
      {
        headers: { 'x-beta-tombstone-signature': 'sha256=' + '1'.repeat(64) },
        json: invalid,
      },
    ))).status, 400);
  }
});

test('manifest signing fails closed when persisted snapshot and R2 object evidence is absent', async () => {
  const { handler } = makeHandler({ claimBackupSigningEvidence: async () => false });
  const { value: token } = await exchange(handler, 'beta-backup');
  const value = manifest();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'beta-backup-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: value,
      },
    },
  ));
  assert.equal(response.status, 503);
});

test('manifest signing fails closed before Ed25519 when independent R2 HEAD evidence mismatches', async () => {
  let signed = false;
  const { handler } = makeHandler({
    inspectR2ObjectEvidence: async value => ({
      verified: true,
      objectKey: value.objectKey,
      bytes: value.expectedBytes + 1,
      sha256: value.expectedSha256,
    }),
    signCanonicalManifest: async () => { signed = true; return 'x'.repeat(86); },
  });
  const { value: token } = await exchange(handler, 'beta-backup');
  const value = manifest();
  const response = await handler(request(
    'https://edge.example/beta-operations/internal/v1/backup/sign',
    {
      token: token.access_token,
      json: {
        format: 'beta-backup-sign-request/1',
        binding: binding('beta-backup'),
        canonicalManifest: canonicalJson(value),
        manifest: value,
      },
    },
  ));
  assert.equal(response.status, 503);
  assert.equal(signed, false);
});

test('restore import, finalize and fixed status fail closed until lineage and identity proof exists', async () => {
  const { handler, calls } = makeHandler();
  const claimed = await claimRestoreLease(handler);
  assert.equal(claimed.response.status, 200);
  const operationHeaders = { authorization: `Bearer ${claimed.value.restoreLease}` };
  const batch = {
    format: 'beta-restore-import-batch/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    mode: 'new-generation',
    dataset: 'trades',
    batchIndex: 0,
    totalBatches: 1,
    records: [{ id: 'trade-1', generation: 17 }],
  };
  const batchIdempotencyKey = 'restore-batch-'
    + createHash('sha256').update(canonicalJson(batch)).digest('hex');
  const first = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/import-batch',
    {
      headers: { ...operationHeaders, 'idempotency-key': batchIdempotencyKey },
      json: batch,
    },
  ));
  const firstBody = await body(first);
  assert.equal(first.status, 503);
  assert.deepEqual(firstBody, {
    format: 'beta-restore-not-ready/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestSha256: claimed.claim.manifestSha256,
    state: 'NOT_READY',
    published: false,
    reason: 'RESTORE_PROOF_INCOMPLETE',
    blockingReasons: [
      'TENANT_LINEAGE_UNVERIFIED',
      'AUTH_IDENTITY_MAPPING_UNVERIFIED',
      'EXTERNAL_DELETION_JOURNAL_UNAVAILABLE',
    ],
  });
  const changedBatch = { ...batch, records: [{ id: 'trade-2', generation: 17 }] };
  const changedIdempotencyKey = 'restore-batch-'
    + createHash('sha256').update(canonicalJson(changedBatch)).digest('hex');
  const conflict = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/import-batch',
    {
      headers: { ...operationHeaders, 'idempotency-key': changedIdempotencyKey },
      json: changedBatch,
    },
  ));
  assert.equal(conflict.status, 503);

  const tenantInjectedBatch = {
    ...batch,
    records: [{ id: 'trade-1', generation: 17, tenantId: 'attacker-tenant' }],
  };
  const tenantInjectedKey = 'restore-batch-'
    + createHash('sha256').update(canonicalJson(tenantInjectedBatch)).digest('hex');
  assert.equal((await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/import-batch',
    {
      headers: { ...operationHeaders, 'idempotency-key': tenantInjectedKey },
      json: tenantInjectedBatch,
    },
  ))).status, 400);

  const finalizeBody = {
    format: 'beta-restore-finalize/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestSha256: claimed.claim.manifestSha256,
    expectedBatchCount: 1,
    rowCounts: { trades: 1 },
  };
  const finalizeIdempotencyKey = 'restore-finalize-'
    + createHash('sha256').update(canonicalJson(finalizeBody)).digest('hex');

  const finalized = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/finalize',
    {
      headers: { ...operationHeaders, 'idempotency-key': finalizeIdempotencyKey },
      json: finalizeBody,
    },
  ));
  assert.equal(finalized.status, 503);
  assert.deepEqual(await body(finalized), {
    format: 'beta-restore-not-ready/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestSha256: claimed.claim.manifestSha256,
    state: 'NOT_READY',
    published: false,
    reason: 'RESTORE_PROOF_INCOMPLETE',
    blockingReasons: [
      'TENANT_LINEAGE_UNVERIFIED',
      'AUTH_IDENTITY_MAPPING_UNVERIFIED',
      'EXTERNAL_DELETION_JOURNAL_UNAVAILABLE',
    ],
  });

  const status = await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/status?restore_id=restore-123',
    { method: 'GET', headers: operationHeaders },
  ));
  assert.equal(status.status, 503);
  assert.deepEqual(await body(status), {
    format: 'beta-restore-not-ready/1',
    restoreId: 'restore-123',
    targetGeneration: 18,
    manifestSha256: claimed.claim.manifestSha256,
    state: 'NOT_READY',
    published: false,
    reason: 'RESTORE_PROOF_INCOMPLETE',
    blockingReasons: [
      'TENANT_LINEAGE_UNVERIFIED',
      'AUTH_IDENTITY_MAPPING_UNVERIFIED',
      'EXTERNAL_DELETION_JOURNAL_UNAVAILABLE',
    ],
  });
  assert.equal((await handler(request(
    'https://edge.example/beta-operations/internal/v1/restore/status?restore_id=restore-123&extra=1',
    { method: 'GET', headers: operationHeaders },
  ))).status, 400);
  assert.equal(calls.some(call => [
    'importRestoreBatch', 'finalizeRestore', 'getRestoreStatus',
  ].includes(call[0])), false);
});

test('archive returns a pre-authorized one-time URL and accepts only narrow idempotent batches', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-archive');
  const once = await handler(request(
    'https://edge.example/beta-operations/internal/v1/archive/request',
    {
      token: token.access_token,
      json: { format: 'beta-archive-url-request/1', binding: binding('beta-archive') },
    },
  ));
  assert.deepEqual(await body(once), {
    format: 'beta-one-time-archive/2',
    single_use: true,
    archive_id: 'archive-1234',
    expected_archive_sha256: null,
    expected_archive_bytes: null,
    digest_attestation_required: true,
    download_url: 'https://archive-download.example/one-time/opaque-ticket',
    expires_at: new Date((NOW + 300) * 1000).toISOString(),
  });

  const attestation = await handler(request(
    'https://edge.example/beta-operations/internal/v1/archive/attest',
    {
      token: token.access_token,
      json: {
        format: 'beta-archive-payload-attestation/1',
        archiveId: 'archive-1234',
        archiveSha256: 'c'.repeat(64),
        archiveBytes: 4096,
      },
    },
  ));
  assert.equal(attestation.status, 200);
  assert.deepEqual(await body(attestation), {
    format: 'beta-archive-payload-attestation-result/1',
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 4096,
    evidenceSource: 'WORKFLOW_OBSERVED',
    status: 'ATTESTED',
  });

  const batch = {
    format: 'beta-archive-batch/1',
    archiveId: 'archive-1234',
    batchIndex: 0,
    dataset: 'fills',
    records: [{ providerEventId: 'event-1', eventTime: '1788131100000', symbol: 'BTCUSDT', tradeId: '1' }],
    sourceFile: 'fills.csv',
    totalBatches: 1,
  };
  const accepted = await handler(request(
    'https://edge.example/beta-operations/internal/v1/archive/ingest',
    { token: token.access_token, json: batch },
  ));
  assert.deepEqual(await body(accepted), {
    format: 'beta-archive-batch-result/1',
    accepted: true,
    archiveId: 'archive-1234',
    batchIndex: 0,
    batchSha256: 'a'.repeat(64),
    dataset: 'fills',
    recordCount: 1,
    sourceFile: 'fills.csv',
    totalBatches: 1,
  });
  assert.equal(calls.find(call => call[0] === 'ingestArchiveBatch')[1].records.length, 1);

  for (const invalid of [
    { ...batch, dataset: 'users' },
    { ...batch, url: 'https://evil.test' },
    { ...batch, records: Array.from({ length: 251 }, () => batch.records[0]) },
    { ...batch, records: [{ ...batch.records[0], unknownField: 'no' }] },
    { ...batch, records: [{ providerEventId: 'event-1', eventTime: '1788131100000', symbol: 'BTCUSDT' }] },
  ]) {
    assert.equal((await handler(request(
      'https://edge.example/beta-operations/internal/v1/archive/ingest',
      { token: token.access_token, json: invalid },
    ))).status, 400);
  }

  const finalize = await handler(request(
    'https://edge.example/beta-operations/internal/v1/archive/finalize',
    {
      token: token.access_token,
      json: {
        format: 'beta-archive-finalize/1',
        archiveId: 'archive-1234',
        archiveSha256: 'c'.repeat(64),
        archiveBytes: 4096,
        batchSetSha256: 'b'.repeat(64),
        rowCount: 1,
      },
    },
  ));
  assert.equal(finalize.status, 200);
  assert.deepEqual(await body(finalize), {
    format: 'beta-archive-finalize-result/1',
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    status: 'COMPLETED',
    finalizeSha256: 'f'.repeat(64),
    batchSetSha256: 'b'.repeat(64),
    sourceEventCount: 1,
    insertedCount: 1,
    replayedEventCount: 0,
    conflictCount: 0,
    coverageState: 'PARTIAL',
    gapCode: 'ARCHIVE_RECONCILIATION_PENDING',
    trustedAdvanced: false,
  });
});

test('archive attestation is same-run replay-safe and digest conflicts fail closed', async () => {
  let persisted = null;
  const { handler, calls } = makeHandler({
    attestArchivePayload: async value => {
      calls.push(['attestArchivePayload', value]);
      if (persisted === null) {
        persisted = {
          archiveSha256: value.archiveSha256,
          archiveBytes: value.archiveBytes,
        };
        return {
          accepted: true,
          replayed: false,
          archiveId: value.archiveId,
          ...persisted,
          evidenceSource: 'WORKFLOW_OBSERVED',
          status: 'ATTESTED',
        };
      }
      const same = persisted.archiveSha256 === value.archiveSha256
        && persisted.archiveBytes === value.archiveBytes;
      return {
        accepted: same,
        replayed: same,
        archiveId: value.archiveId,
        ...persisted,
        evidenceSource: 'WORKFLOW_OBSERVED',
        status: same ? 'ATTESTED' : 'FAILED',
      };
    },
  });
  const { value: token } = await exchange(handler, 'beta-archive');
  const attest = async (archiveSha256, archiveBytes = 4096) => {
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/archive/attest',
      {
        token: token.access_token,
        json: {
          format: 'beta-archive-payload-attestation/1',
          archiveId: 'archive-1234',
          archiveSha256,
          archiveBytes,
        },
      },
    ));
    return { response, value: await body(response) };
  };

  const first = await attest('c'.repeat(64));
  assert.equal(first.response.status, 200);
  assert.equal(first.value.replayed, false);
  assert.equal(first.value.status, 'ATTESTED');

  const replay = await attest('c'.repeat(64));
  assert.equal(replay.response.status, 200);
  assert.equal(replay.value.replayed, true);
  assert.equal(replay.value.status, 'ATTESTED');

  const conflict = await attest('d'.repeat(64));
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.value, {
    format: 'beta-archive-payload-attestation-result/1',
    accepted: false,
    replayed: false,
    archiveId: 'archive-1234',
    archiveSha256: 'c'.repeat(64),
    archiveBytes: 4096,
    evidenceSource: 'WORKFLOW_OBSERVED',
    status: 'FAILED',
  });
  assert.equal(calls.filter(call => call[0] === 'attestArchivePayload').length, 3);

  for (const invalid of [
    { archiveSha256: 'not-a-digest', archiveBytes: 4096 },
    { archiveSha256: 'c'.repeat(64), archiveBytes: 0 },
    { archiveSha256: 'c'.repeat(64), archiveBytes: 4096, token: 'forbidden' },
  ]) {
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/archive/attest',
      {
        token: token.access_token,
        json: {
          format: 'beta-archive-payload-attestation/1',
          archiveId: 'archive-1234',
          ...invalid,
        },
      },
    ));
    assert.equal(response.status, 400);
  }
});

test('archive failure receipt accepts only a fixed error code and exact claim body', async () => {
  const { handler, calls } = makeHandler();
  const { value: token } = await exchange(handler, 'beta-archive');
  const failed = await handler(request(
    'https://edge.example/beta-operations/internal/v1/archive/fail',
    {
      token: token.access_token,
      json: {
        format: 'beta-archive-claim-failure/1',
        archiveId: 'archive-1234',
        errorCode: 'ARCHIVE_PARSE_FAILED',
      },
    },
  ));
  assert.equal(failed.status, 200);
  assert.deepEqual(await body(failed), {
    format: 'beta-archive-claim-failure-result/1',
    accepted: true,
    replayed: false,
    archiveId: 'archive-1234',
    status: 'FAILED',
  });
  assert.equal(calls.filter(call => call[0] === 'failArchiveClaim').length, 1);

  for (const json of [
    {
      format: 'beta-archive-claim-failure/1',
      archiveId: 'archive-1234',
      errorCode: 'SHELL_COMMAND_FAILED',
    },
    {
      format: 'beta-archive-claim-failure/1',
      archiveId: 'archive-1234',
      errorCode: 'ARCHIVE_PARSE_FAILED',
      detail: 'sensitive error text',
    },
  ]) {
    const response = await handler(request(
      'https://edge.example/beta-operations/internal/v1/archive/fail',
      { token: token.access_token, json },
    ));
    assert.equal(response.status, 400);
  }
});

test('Edge adapter uses GitHub JWKS and Cloudflare fixed API without a general proxy', () => {
  const runtimeSource = fs.readFileSync(path.join(
    REPO,
    'supabase/functions/beta-operations/runtime.mjs',
  ), 'utf8');
  const source = ['index.ts', 'runtime.mjs'].map(file => fs.readFileSync(path.join(
    REPO,
    'supabase/functions/beta-operations',
    file,
  ), 'utf8')).join('\n');
  assert.match(source, /createRemoteJWKSet/iu);
  assert.match(source, /jwtVerify/iu);
  assert.match(source, /token\.actions\.githubusercontent\.com\/\.well-known\/jwks/iu);
  assert.match(source, /api\.cloudflare\.com\/client\/v4\/accounts/iu);
  assert.match(source, /redirect:\s*'error'/u);
  assert.doesNotMatch(source, /request\.json\(\)[\s\S]{0,200}(?:url|method)/iu);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/u);
  assert.equal(runtimeSource.match(/capability:\s*'beta-archive'/gu)?.length, 1);
  assert.doesNotMatch(runtimeSource,
    /rv2_ops_(?:import_restore_batch|finalize_restore|get_restore_status)|(?:importRestoreBatch|finalizeRestore|getRestoreStatus)\s*\(/u);
  const handlerSource = fs.readFileSync(path.join(
    REPO,
    'supabase/functions/beta-operations/handler.mjs',
  ), 'utf8');
  assert.doesNotMatch(handlerSource, /state:\s*'PUBLISHED'|published:\s*true/gu);
  assert.match(handlerSource, /EXTERNAL_DELETION_JOURNAL_UNAVAILABLE/u);
});
