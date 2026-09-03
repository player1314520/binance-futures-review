import {
  canonicalJson,
  createCloudflareTempCredentialRequest,
  createGrantCodec,
  createR2SigV4HeadRequest,
  createRestoreLeaseCodec,
} from './core.mjs';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

function exactHttpsOrigin(raw, hostPredicate = () => true) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || !hostPredicate(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function opaque(value, minimum = 16, maximum = 8192) {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum
    && !/\s/u.test(value);
}

function decodeBase64Url(value, expectedLength = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    return expectedLength === null || bytes.byteLength === expectedLength ? bytes : null;
  } catch {
    return null;
  }
}

function decodeBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    return bytes.byteLength >= minimum && bytes.byteLength <= maximum ? bytes : null;
  } catch {
    return null;
  }
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}

export function readRuntimeConfig(getEnv) {
  if (typeof getEnv !== 'function') return null;
  const supabaseUrl = exactHttpsOrigin(
    getEnv('SUPABASE_URL') ?? '',
    host => host.endsWith('.supabase.co'),
  );
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const grantHmacKey = decodeBase64Url(getEnv('BETA_OPS_GRANT_HMAC_V1') ?? '', 32);
  const restoreTombstoneHmacKey = decodeBase64Url(
    getEnv('BETA_OPS_RESTORE_TOMBSTONE_HMAC_V1') ?? '',
    32,
  );
  const restoreClaimHmacKey = decodeBase64Url(
    getEnv('BETA_OPS_RESTORE_CLAIM_HMAC_V1') ?? '',
    32,
  );
  const restoreLeaseHmacKey = decodeBase64Url(
    getEnv('BETA_OPS_RESTORE_LEASE_HMAC_V1') ?? '',
    32,
  );
  const signingPrivateKeyPkcs8 = decodeBase64(
    getEnv('BETA_OPS_BACKUP_SIGNING_PRIVATE_KEY_PKCS8_B64') ?? '',
    48,
    2048,
  );
  const repository = getEnv('BETA_OPS_GITHUB_REPOSITORY') ?? '';
  const ref = getEnv('BETA_OPS_GITHUB_REF') ?? '';
  const releaseSha = getEnv('BETA_OPS_GITHUB_WORKFLOW_SHA') ?? '';
  const audience = getEnv('BETA_OPS_GITHUB_AUDIENCE') ?? '';
  const repositoryId = getEnv('BETA_OPS_GITHUB_REPOSITORY_ID') ?? '';
  const repositoryOwnerId = getEnv('BETA_OPS_GITHUB_OWNER_ID') ?? '';
  const cloudflareAccountId = getEnv('BETA_OPS_CLOUDFLARE_ACCOUNT_ID') ?? '';
  const cloudflareApiToken = getEnv('BETA_OPS_CLOUDFLARE_API_TOKEN') ?? '';
  const cloudflareParentAccessKeyId = getEnv('BETA_OPS_R2_PARENT_ACCESS_KEY_ID') ?? '';
  const r2Bucket = getEnv('BETA_OPS_R2_BUCKET') ?? '';
  const r2Prefix = getEnv('BETA_OPS_R2_PREFIX') ?? '';
  const archiveDownloadHost = getEnv('BETA_OPS_ARCHIVE_DOWNLOAD_HOST') ?? '';
  const backupSigningKeyId = getEnv('BETA_OPS_BACKUP_SIGNING_KEY_ID') ?? '';
  if (!supabaseUrl
    || !opaque(serviceRoleKey, 32)
    || !grantHmacKey
    || !restoreTombstoneHmacKey
    || !restoreClaimHmacKey
    || !restoreLeaseHmacKey
    || !signingPrivateKeyPkcs8
    || sameBytes(grantHmacKey, restoreTombstoneHmacKey)
    || sameBytes(grantHmacKey, restoreClaimHmacKey)
    || sameBytes(grantHmacKey, restoreLeaseHmacKey)
    || sameBytes(restoreTombstoneHmacKey, restoreClaimHmacKey)
    || sameBytes(restoreTombstoneHmacKey, restoreLeaseHmacKey)
    || sameBytes(restoreClaimHmacKey, restoreLeaseHmacKey)
    || repository !== 'player1314520/trading-'
    || ref !== 'refs/heads/main'
    || !/^[0-9a-f]{40}$/u.test(releaseSha)
    || !/^[A-Za-z0-9:/._-]{3,256}$/u.test(audience)
    || !/^[1-9][0-9]{0,19}$/u.test(repositoryId)
    || !/^[1-9][0-9]{0,19}$/u.test(repositoryOwnerId)
    || !/^[a-f0-9]{32}$/u.test(cloudflareAccountId)
    || !opaque(cloudflareApiToken, 32)
    || !/^[A-Za-z0-9_-]{8,128}$/u.test(cloudflareParentAccessKeyId)
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(r2Bucket)
    || r2Bucket.includes('..')
    || !/^[a-z0-9][a-z0-9/_-]{1,510}\/$/u.test(r2Prefix)
    || r2Prefix.startsWith('/')
    || r2Prefix.includes('..')
    || !/^[a-z0-9.-]{4,253}$/u.test(archiveDownloadHost)
    || !/^[A-Za-z0-9._-]{3,64}$/u.test(backupSigningKeyId)) return null;
  const common = Object.freeze({
    repository,
    repositoryId,
    repositoryOwnerId,
    ref,
    workflowSha: releaseSha,
    environment: 'beta-operations',
    eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    runnerEnvironment: 'github-hosted',
    subject: `repo:${repository}:environment:beta-operations`,
    audience,
  });
  const restoreCommon = Object.freeze({
    ...common,
    environment: 'beta-restore-operator',
    eventNames: Object.freeze(['workflow_dispatch']),
    subject: `repo:${repository}:environment:beta-restore-operator`,
  });
  const policies = Object.freeze({
    'beta-backup': Object.freeze({
      ...common,
      capability: 'beta-backup',
      workflowRef: `${repository}/.github/workflows/beta-backup.yml@${ref}`,
      jobWorkflowRef: `${repository}/.github/workflows/beta-backup.yml@${ref}`,
      job: 'backup',
    }),
    'beta-archive': Object.freeze({
      ...common,
      capability: 'beta-archive',
      workflowRef: `${repository}/.github/workflows/beta-archive.yml@${ref}`,
      jobWorkflowRef: `${repository}/.github/workflows/beta-archive.yml@${ref}`,
      job: 'archive',
    }),
    'beta-capacity-observe': Object.freeze({
      ...common,
      capability: 'beta-capacity-observe',
      workflowRef: `${repository}/.github/workflows/beta-backup.yml@${ref}`,
      jobWorkflowRef: `${repository}/.github/workflows/beta-backup.yml@${ref}`,
      job: 'backup',
    }),
    'beta-restore': Object.freeze({
      ...restoreCommon,
      capability: 'beta-restore',
      workflowRef: `${repository}/.github/workflows/beta-restore.yml@${ref}`,
      jobWorkflowRef: `${repository}/.github/workflows/beta-restore.yml@${ref}`,
      job: 'restore',
    }),
  });
  return Object.freeze({
    supabaseUrl,
    serviceRoleKey,
    grantHmacKey,
    restoreTombstoneHmacKey,
    restoreClaimHmacKey,
    restoreLeaseHmacKey,
    signingPrivateKeyPkcs8,
    policies,
    cloudflareAccountId,
    cloudflareApiToken,
    cloudflareParentAccessKeyId,
    r2Bucket,
    r2Prefix,
    archiveDownloadHost,
    backupSigningKeyId,
  });
}

async function readBoundedJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('upstream unavailable');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel('response too large');
        throw new Error('upstream unavailable');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } finally {
    reader.releaseLock();
  }
}

function signalOf(input) {
  return input?.context?.signal;
}

function rowValue(value) {
  if (Array.isArray(value) && value.length === 1) return value[0];
  return value;
}

async function importHmacKey(bytes) {
  return await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function decodeHex(value) {
  if (!/^[0-9a-f]{64}$/u.test(value ?? '')) return null;
  return Uint8Array.from(value.match(/../gu), pair => Number.parseInt(pair, 16));
}

function timingSafeEqual(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function createRuntimeDependencies(config, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  if (typeof options.verifyGithubOidc !== 'function') {
    throw new TypeError('GitHub OIDC verifier required');
  }
  const grantCodec = createGrantCodec(config.grantHmacKey);
  const restoreLeaseCodec = createRestoreLeaseCodec(config.restoreLeaseHmacKey);
  const signingKeyPromise = crypto.subtle.importKey(
    'pkcs8',
    config.signingPrivateKeyPkcs8,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const tombstoneHmacPromise = importHmacKey(config.restoreTombstoneHmacKey);
  const claimHmacPromise = importHmacKey(config.restoreClaimHmacKey);

  async function rpc(name, body, input, maximumBytes = MAX_RESPONSE_BYTES) {
    const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      body: JSON.stringify(body),
      signal: signalOf(input),
    });
    const value = await readBoundedJson(response, maximumBytes);
    if (!response.ok) throw new Error('database unavailable');
    return rowValue(value);
  }

  async function cloudflare(path, method, body, input) {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}${path}`, {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.cloudflareApiToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signalOf(input),
    });
    const value = await readBoundedJson(response, 256 * 1024);
    if (!response.ok || value?.success !== true || !value.result) throw new Error('Cloudflare unavailable');
    return value.result;
  }

  async function verifyHmac(payload, signature, keyPromise) {
    const supplied = decodeHex(String(signature).slice('sha256='.length));
    if (!supplied) return false;
    const expected = new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      await keyPromise,
      encoder.encode(canonicalJson(payload)),
    ));
    return timingSafeEqual(expected, supplied);
  }

  async function mintR2Credentials(scope, input) {
    const request = createCloudflareTempCredentialRequest({
      accountId: config.cloudflareAccountId,
      parentAccessKeyId: config.cloudflareParentAccessKeyId,
      bucket: config.r2Bucket,
      prefix: scope.prefix ?? null,
      objects: scope.objects ?? null,
      permission: scope.permission,
      ttlSeconds: scope.ttlSeconds,
    });
    const result = await cloudflare('/r2/temp-access-credentials', 'POST', request.body, input);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(result.accessKeyId ?? '')
      || !/^\S{16,512}$/u.test(result.secretAccessKey ?? '')
      || !/^\S{16,8192}$/u.test(result.sessionToken ?? '')) {
      throw new Error('temporary R2 credential unavailable');
    }
    return {
      accessKeyId: result.accessKeyId,
      secretAccessKey: result.secretAccessKey,
      sessionToken: result.sessionToken,
      expiresIn: scope.ttlSeconds,
    };
  }

  return Object.freeze({
    policies: config.policies,
    r2Bucket: config.r2Bucket,
    r2Prefix: config.r2Prefix,
    archiveDownloadHost: config.archiveDownloadHost,
    backupSigningKeyId: config.backupSigningKeyId,
    deadlineMs: 25_000,
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    verifyGithubOidc: options.verifyGithubOidc,
    issueGrant: input => grantCodec.issue(input),
    verifyGrant: (token, input) => grantCodec.verify(token, input),
    issueRestoreLease: input => restoreLeaseCodec.issue(input),
    verifyRestoreLease: (token, input) => restoreLeaseCodec.verify(token, input),
    async claimOidcJti(input) {
      const result = await rpc('rv2_ops_claim_oidc_jti', {
        p_capability: input.capability,
        p_oidc_jti: input.oidcJti,
        p_expires_at: new Date(input.expiresAt * 1000).toISOString(),
        p_binding: input.binding,
      }, input, 32 * 1024);
      return result?.claimed === true && result?.first_use === true;
    },
    async createR2TemporaryCredentials(input) {
      if (input.bucket !== config.r2Bucket) throw new Error('R2 bucket unavailable');
      const permission = input.permission ?? 'object-read-write';
      if (permission !== 'object-read-write' && permission !== 'object-read-only') {
        throw new Error('R2 permission unavailable');
      }
      return await mintR2Credentials({
        prefix: input.prefix ?? null,
        objects: input.objects ?? null,
        permission,
        ttlSeconds: input.ttlSeconds,
      }, input);
    },
    async invokeRestoreV2(input) {
      const routes = Object.freeze({
        claim: Object.freeze({ method: 'POST', path: '/internal/v2/restore/claim' }),
        stage: Object.freeze({ method: 'POST', path: '/internal/v2/restore/stage' }),
        publish: Object.freeze({ method: 'POST', path: '/internal/v2/restore/publish' }),
        status: Object.freeze({ method: 'GET', path: '/internal/v2/restore/status' }),
      });
      const route = routes[input.operation];
      if (!route) throw new Error('restore operation unavailable');
      const url = new URL(`${config.supabaseUrl}/functions/v1/restore-v2${route.path}`);
      if (input.operation === 'status') {
        if (!/^[0-9a-f-]{36}$/u.test(input.restoreId ?? '')) {
          throw new Error('restore operation unavailable');
        }
        url.searchParams.set('restore_id', input.restoreId);
      }
      const response = await fetchImpl(url.toString(), {
        method: route.method,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          ...(route.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: route.method === 'POST' ? JSON.stringify(input.body) : undefined,
        signal: signalOf(input),
      });
      const value = await readBoundedJson(response, MAX_RESPONSE_BYTES);
      if (![200, 400, 401, 409, 503].includes(response.status)) {
        throw new Error('restore operation unavailable');
      }
      return Object.freeze({ status: response.status, value });
    },
    async readBackupPage(input) {
      const result = await rpc('rv2_ops_read_backup_page', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_cursor: input.cursor,
        p_limit: input.limit,
        p_view: input.view,
      }, input);
      return result?.page ?? result;
    },
    async recordBackupPageEvidence(input) {
      const result = await rpc('rv2_ops_record_backup_page_evidence', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_oidc_jti_sha256: input.authorization.oidcJtiSha256,
        p_request_cursor: input.cursor,
        p_page: input.page,
      }, input, 32 * 1024);
      return result?.recorded === true;
    },
    async readBackupV2Page(input) {
      const result = await rpc('rv2_restore_v2_read_backup_page', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_cursor: input.cursor,
        p_limit: input.limit,
      }, input);
      return result?.page ?? result;
    },
    async recordBackupV2PageEvidence(input) {
      const result = await rpc('rv2_restore_v2_record_backup_page_evidence', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_request_cursor: input.cursor,
        p_page: input.page,
      }, input, 32 * 1024);
      return result?.recorded === true;
    },
    async claimBackupV2SigningEvidence(input) {
      const result = await rpc('rv2_restore_v2_claim_backup_signing_evidence', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_scope_prefix: input.scopePrefix,
        p_manifest: input.manifest,
        p_journal_proof: input.journalProof,
        p_object_key: input.objectEvidence.objectKey,
        p_object_bytes: input.objectEvidence.bytes,
        p_object_sha256: input.objectEvidence.sha256,
      }, input, 32 * 1024);
      return result?.verified === true
        && result?.claimed === true
        && result?.firstUse === true;
    },
    async recordCapacityObservation(input) {
      const result = await rpc('rv2_service_record_capacity_observation', {
        p_r2_standard_bytes: input.r2StandardBytes,
        p_actions_minutes_used: input.actionsMinutesUsed,
        p_actions_minutes_limit: input.actionsMinutesLimit,
        p_backup_object_age_seconds: input.backupObjectAgeSeconds,
        p_smtp_delivery_failures_24h: input.smtpDeliveryFailures24h,
        p_evidence_sha256: input.evidenceSha256,
        p_observed_at: input.observedAt,
      }, input, 32 * 1024);
      return result;
    },
    async inspectR2PrivateAccess(input) {
      const bucket = encodeURIComponent(config.r2Bucket);
      const [managed, custom] = await Promise.all([
        cloudflare(`/r2/buckets/${bucket}/domains/managed`, 'GET', undefined, input),
        cloudflare(`/r2/buckets/${bucket}/domains/custom`, 'GET', undefined, input),
      ]);
      if ((managed.enabled !== true && managed.enabled !== false)
        || !Array.isArray(custom.domains)) throw new Error('Cloudflare privacy state unavailable');
      return {
        r2DevPublic: managed.enabled,
        // Any configured custom domain is unsafe here, including a pending
        // domain that could become active after this request.
        activeCustomDomains: custom.domains,
      };
    },
    async inspectR2ObjectEvidence(input) {
      if (input.bucket !== config.r2Bucket) throw new Error('R2 bucket unavailable');
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const ttlSeconds = Math.min(60, input.authorization.expiresAt - nowSeconds);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw new Error('R2 evidence grant expired');
      }
      const credentials = await mintR2Credentials({
        prefix: null,
        objects: [input.objectKey],
        permission: 'object-read-only',
        ttlSeconds,
      }, input);
      const signed = await createR2SigV4HeadRequest({
        accountId: config.cloudflareAccountId,
        bucket: config.r2Bucket,
        objectKey: input.objectKey,
        credentials,
        now: new Date(nowSeconds * 1000),
      });
      const response = await fetchImpl(signed.url, {
        method: signed.method,
        redirect: 'error',
        headers: signed.headers,
        signal: signalOf(input),
      });
      if (!response.ok || response.status !== 200) throw new Error('R2 object evidence unavailable');
      const bytes = Number(response.headers.get('content-length'));
      const sha256 = response.headers.get('x-amz-meta-rv-sha256') ?? '';
      const verified = Number.isSafeInteger(bytes)
        && bytes > 0
        && bytes === input.expectedBytes
        && /^[0-9a-f]{64}$/u.test(sha256)
        && sha256 === input.expectedSha256;
      return {
        verified,
        objectKey: input.objectKey,
        bytes,
        sha256,
      };
    },
    async claimBackupSigningEvidence(input) {
      const result = await rpc('rv2_ops_claim_backup_signing_evidence', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_oidc_jti_sha256: input.authorization.oidcJtiSha256,
        p_scope_prefix: input.scopePrefix,
        p_snapshot_id: input.manifest.snapshotId,
        p_generation: input.manifest.generation,
        p_row_counts: input.manifest.rowCounts,
        p_object_key: input.objectEvidence.objectKey,
        p_object_bytes: input.objectEvidence.bytes,
        p_object_sha256: input.objectEvidence.sha256,
      }, input, 32 * 1024);
      return result?.verified === true
        && result?.claimed === true
        && result?.first_use === true
        && result?.snapshot_verified === true
        && result?.object_verified === true
        && result?.object_key === input.objectEvidence.objectKey
        && result?.object_bytes === input.objectEvidence.bytes
        && result?.object_sha256 === input.objectEvidence.sha256;
    },
    async signCanonicalManifest(input) {
      const signature = await crypto.subtle.sign(
        'Ed25519',
        await signingKeyPromise,
        encoder.encode(input.canonicalManifest),
      );
      let binary = '';
      for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    },
    async verifyRestoreTombstoneSignature(input) {
      return await verifyHmac(input.payload, input.signature, tombstoneHmacPromise);
    },
    async applyDeletionTombstones(input) {
      return await rpc('rv2_ops_apply_deletion_tombstones', {
        p_restore_id: input.restoreId,
        p_active_generation: input.activeGeneration,
        p_target_generation: input.targetGeneration,
        p_mode: input.mode,
        p_before: input.before,
      }, input, 32 * 1024);
    },
    async verifyRestoreClaimSignature(input) {
      return await verifyHmac(input.payload, input.signature, claimHmacPromise);
    },
    async claimRestoreManifest(input) {
      const result = await rpc('rv2_ops_claim_restore_manifest', {
        p_restore_id: input.restoreId,
        p_target_generation: input.targetGeneration,
        p_manifest_nonce: input.manifestNonce,
        p_manifest_sha256: input.manifestSha256,
        p_source_repository: input.sourceRepository,
        p_source_workflow_ref: input.sourceWorkflowRef,
        p_source_run_id: input.sourceRunId,
        p_source_run_attempt: input.sourceRunAttempt,
      }, input, 32 * 1024);
      return {
        accepted: result?.accepted === true,
        firstUse: result?.first_use === true,
        leaseSubject: result?.lease_subject,
      };
    },
    async createArchiveDownload(input) {
      const result = await rpc('rv2_ops_claim_archive_download', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
      }, input, 32 * 1024);
      return {
        archiveId: result?.archive_id,
        archiveSha256: result?.archive_sha256,
        archiveBytes: result?.archive_bytes,
        downloadUrl: result?.download_url,
        expiresAt: result?.expires_at,
      };
    },
    async attestArchivePayload(input) {
      const result = await rpc('rv2_ops_attest_archive_payload', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_archive_id: input.archiveId,
        p_archive_sha256: input.archiveSha256,
        p_archive_bytes: input.archiveBytes,
      }, input, 32 * 1024);
      return {
        accepted: result?.accepted === true,
        replayed: result?.replayed === true,
        archiveId: result?.archive_id,
        archiveSha256: result?.archive_sha256 ?? null,
        archiveBytes: result?.archive_bytes ?? null,
        evidenceSource: result?.evidence_source ?? null,
        status: result?.status,
      };
    },
    async failArchiveClaim(input) {
      const result = await rpc('rv2_ops_fail_archive_claim', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_archive_id: input.archiveId,
        p_error_code: input.errorCode,
      }, input, 32 * 1024);
      return {
        accepted: result?.accepted === true,
        replayed: result?.replayed === true,
        archiveId: result?.archive_id,
        status: result?.status,
      };
    },
    async ingestArchiveBatch(input) {
      const result = await rpc('rv2_ops_ingest_archive_batch', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_archive_id: input.archiveId,
        p_dataset: input.dataset,
        p_batch_index: input.batchIndex,
        p_total_batches: input.totalBatches,
        p_source_file: input.sourceFile,
        p_records: input.records,
      }, input, 64 * 1024);
      return {
        accepted: result?.accepted === true,
        replayed: result?.replayed === true,
        batchSha256: result?.batch_sha256,
        recordCount: result?.record_count,
        totalBatches: result?.total_batches,
        sourceFile: result?.source_file,
      };
    },
    async finalizeArchive(input) {
      const result = await rpc('rv2_ops_finalize_archive', {
        p_run_id: input.authorization.binding.runId,
        p_run_attempt: input.authorization.binding.runAttempt,
        p_archive_id: input.archiveId,
        p_archive_sha256: input.archiveSha256,
        p_archive_bytes: input.archiveBytes,
        p_batch_set_sha256: input.batchSetSha256,
        p_row_count: input.rowCount,
      }, input, 32 * 1024);
      return {
        accepted: result?.accepted === true,
        replayed: result?.replayed === true,
        archiveId: result?.archive_id,
        status: result?.status,
        finalizeSha256: result?.finalize_sha256,
        batchSetSha256: result?.batch_set_sha256,
        sourceEventCount: result?.source_event_count,
        insertedCount: result?.inserted_count,
        replayedEventCount: result?.replayed_event_count,
        conflictCount: result?.conflict_count,
        coverageState: result?.coverage_state,
        gapCode: result?.gap_code,
        trustedAdvanced: result?.trusted_advanced === true,
      };
    },
  });
}
