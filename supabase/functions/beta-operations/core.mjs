export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const MAX_GRANT_TTL_SECONDS = 600;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CAPABILITIES = new Set([
  'beta-backup',
  'beta-archive',
  'beta-capacity-observe',
  'beta-restore',
]);
const BINDING_FIELDS = Object.freeze([
  'repository',
  'ref',
  'workflowRef',
  'jobWorkflowRef',
  'runId',
  'runAttempt',
  'job',
]);

export class BetaOperationsError extends Error {
  constructor(code, message = 'beta operation rejected') {
    super(message);
    this.name = 'BetaOperationsError';
    this.code = code;
  }
}

function invariant(condition, code, message) {
  if (!condition) throw new BetaOperationsError(code, message);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactObject(value, fields) {
  return plainRecord(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function exactText(value, pattern, maximum = 1024) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && pattern.test(value);
}

function validRepository(value) {
  return exactText(value, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 256);
}

function validRef(value) {
  return exactText(value, /^refs\/(?:heads|tags)\/[^~^:?*[\]\\\s]+$/u, 512);
}

function validWorkflowRef(value, repository, ref, file) {
  return value === `${repository}/.github/workflows/${file}@${ref}`;
}

function validRunId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);
}

function validRunAttempt(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/u.test(value);
}

function validJti(value) {
  return exactText(value, /^[A-Za-z0-9._:-]{8,256}$/u, 256);
}

function invalidOidc() {
  throw new BetaOperationsError('OIDC_CLAIMS_INVALID', 'GitHub OIDC claims invalid');
}

export function validateOperationsPolicy(policy) {
  if (!plainRecord(policy) || !CAPABILITIES.has(policy.capability)) invalidOidc();
  const expected = Object.freeze({
    'beta-backup': Object.freeze({
      file: 'beta-backup.yml', job: 'backup', environment: 'beta-operations',
      eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    }),
    'beta-archive': Object.freeze({
      file: 'beta-archive.yml', job: 'archive', environment: 'beta-operations',
      eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    }),
    'beta-capacity-observe': Object.freeze({
      file: 'beta-backup.yml', job: 'backup', environment: 'beta-operations',
      eventNames: Object.freeze(['schedule', 'workflow_dispatch']),
    }),
    'beta-restore': Object.freeze({
      file: 'beta-restore.yml', job: 'restore', environment: 'beta-restore-operator',
      eventNames: Object.freeze(['workflow_dispatch']),
    }),
  })[policy.capability];
  if (
    !validRepository(policy.repository)
    || !validRef(policy.ref)
    || !validWorkflowRef(policy.workflowRef, policy.repository, policy.ref, expected.file)
    || policy.jobWorkflowRef !== policy.workflowRef
    || !/^[0-9a-f]{40}$/u.test(policy.workflowSha ?? '')
    || !/^[1-9][0-9]{0,19}$/u.test(policy.repositoryId ?? '')
    || !/^[1-9][0-9]{0,19}$/u.test(policy.repositoryOwnerId ?? '')
    || policy.environment !== expected.environment
    || !Array.isArray(policy.eventNames)
    || policy.eventNames.length < 1
    || policy.eventNames.length > 2
    || policy.eventNames.some((value, index) => value !== expected.eventNames[index])
    || policy.eventNames.length !== expected.eventNames.length
    || new Set(policy.eventNames).size !== policy.eventNames.length
    || policy.runnerEnvironment !== 'github-hosted'
    || policy.job !== expected.job
    || policy.subject !== `repo:${policy.repository}:environment:${expected.environment}`
    || !exactText(policy.audience, /^[A-Za-z0-9:/._-]{3,256}$/u, 256)
  ) invalidOidc();
  return policy;
}

export function validateGithubOidcClaims(
  claims,
  rawPolicy,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const policy = validateOperationsPolicy(rawPolicy);
  if (!plainRecord(claims) || !Number.isSafeInteger(nowSeconds)) invalidOidc();
  const issuedAt = Number(claims.iat);
  const notBefore = Number(claims.nbf);
  const expiresAt = Number(claims.exp);
  const reusableConfigured = policy.reusableWorkflowRef !== undefined
    || policy.reusableWorkflowSha !== undefined;
  const reusableValid = !reusableConfigured || (
    typeof policy.reusableWorkflowRef === 'string'
    && policy.reusableWorkflowRef.length <= 1024
    && /^[0-9a-f]{40}$/u.test(policy.reusableWorkflowSha ?? '')
    && claims.job_workflow_ref === policy.reusableWorkflowRef
    && claims.job_workflow_sha === policy.reusableWorkflowSha
  );
  if (
    claims.iss !== GITHUB_OIDC_ISSUER
    || claims.aud !== policy.audience
    || claims.sub !== policy.subject
    || claims.repository !== policy.repository
    || claims.repository_id !== policy.repositoryId
    || claims.repository_owner_id !== policy.repositoryOwnerId
    || claims.repository_visibility !== 'private'
    || claims.ref !== policy.ref
    || claims.workflow_ref !== policy.workflowRef
    || claims.workflow_sha !== policy.workflowSha
    || claims.environment !== policy.environment
    || !policy.eventNames.includes(claims.event_name)
    || claims.runner_environment !== policy.runnerEnvironment
    || !reusableValid
    || !validRunId(claims.run_id)
    || !validRunAttempt(claims.run_attempt)
    || !validJti(claims.jti)
    || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(notBefore)
    || !Number.isSafeInteger(expiresAt)
    || issuedAt > nowSeconds + 30
    || notBefore > nowSeconds + 30
    || notBefore < issuedAt - 30
    || expiresAt <= nowSeconds
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_GRANT_TTL_SECONDS
  ) invalidOidc();
  const binding = Object.freeze({
    repository: policy.repository,
    ref: policy.ref,
    workflowRef: policy.workflowRef,
    jobWorkflowRef: policy.jobWorkflowRef,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    job: policy.job,
  });
  return Object.freeze({
    capability: policy.capability,
    audience: policy.audience,
    subject: policy.subject,
    oidcJti: claims.jti,
    binding,
    issuedAt,
    notBefore,
    expiresAt,
  });
}

export function validateBinding(value, expected = null) {
  invariant(exactObject(value, BINDING_FIELDS), 'REQUEST_INVALID', 'job binding invalid');
  invariant(validRepository(value.repository), 'REQUEST_INVALID', 'job binding invalid');
  invariant(validRef(value.ref), 'REQUEST_INVALID', 'job binding invalid');
  invariant(exactText(value.workflowRef, /^.{1,1024}$/u), 'REQUEST_INVALID', 'job binding invalid');
  invariant(value.jobWorkflowRef === value.workflowRef, 'REQUEST_INVALID', 'job binding invalid');
  invariant(validRunId(value.runId), 'REQUEST_INVALID', 'job binding invalid');
  invariant(validRunAttempt(value.runAttempt), 'REQUEST_INVALID', 'job binding invalid');
  invariant(value.job === 'backup' || value.job === 'archive' || value.job === 'restore',
    'REQUEST_INVALID', 'job binding invalid');
  if (expected) {
    invariant(
      BINDING_FIELDS.every(field => value[field] === expected[field]),
      'OIDC_CLAIMS_INVALID',
      'GitHub OIDC binding mismatch',
    );
  }
  return Object.freeze(Object.fromEntries(BINDING_FIELDS.map(field => [field, value[field]])));
}

export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'REQUEST_INVALID', 'canonical JSON invalid');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  invariant(plainRecord(value), 'REQUEST_INVALID', 'canonical JSON invalid');
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid encoding');
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function sha256Base64Url(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function importHmacKey(keyBytes) {
  invariant(keyBytes instanceof Uint8Array && keyBytes.byteLength === 32,
    'CONFIG_INVALID', 'grant HMAC key invalid');
  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function hmac(key, value) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function timingSafeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function createGrantCodec(keyBytes) {
  const keyPromise = importHmacKey(keyBytes);
  return Object.freeze({
    async issue({ authorization, nowSeconds, ttlSeconds }) {
      invariant(plainRecord(authorization), 'CONFIG_INVALID', 'grant authorization invalid');
      invariant(Number.isSafeInteger(nowSeconds), 'CONFIG_INVALID', 'grant time invalid');
      invariant(Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= MAX_GRANT_TTL_SECONDS,
        'REQUEST_INVALID', 'grant TTL invalid');
      const expiresIn = Math.min(ttlSeconds, authorization.expiresAt - nowSeconds);
      invariant(expiresIn > 0, 'OIDC_CLAIMS_INVALID', 'GitHub OIDC assertion expired');
      const payload = Object.freeze({
        v: 1,
        capability: authorization.capability,
        binding: validateBinding(authorization.binding),
        oidcJtiSha256: await sha256Base64Url(authorization.oidcJti),
        iat: nowSeconds,
        exp: nowSeconds + expiresIn,
      });
      const encoded = base64Url(encoder.encode(canonicalJson(payload)));
      const unsigned = `bgo1.${encoded}`;
      const signature = base64Url(await hmac(await keyPromise, unsigned));
      return Object.freeze({
        accessToken: `${unsigned}.${signature}`,
        expiresIn,
        expiresAt: payload.exp,
        binding: payload.binding,
        capability: payload.capability,
      });
    },
    async verify(token, { capability, nowSeconds }) {
      try {
        if (!CAPABILITIES.has(capability) || !Number.isSafeInteger(nowSeconds)) return null;
        const parts = typeof token === 'string' ? token.split('.') : [];
        if (parts.length !== 3 || parts[0] !== 'bgo1') return null;
        const expected = await hmac(await keyPromise, `${parts[0]}.${parts[1]}`);
        if (!timingSafeEqual(expected, decodeBase64Url(parts[2]))) return null;
        const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[1])));
        if (
          !exactObject(payload, ['v', 'capability', 'binding', 'oidcJtiSha256', 'iat', 'exp'])
          || payload.v !== 1
          || payload.capability !== capability
          || !/^[A-Za-z0-9_-]{43}$/u.test(payload.oidcJtiSha256 ?? '')
          || !Number.isSafeInteger(payload.iat)
          || !Number.isSafeInteger(payload.exp)
          || payload.exp <= nowSeconds
          || payload.exp <= payload.iat
          || payload.exp - payload.iat > MAX_GRANT_TTL_SECONDS
        ) return null;
        return Object.freeze({
          capability: payload.capability,
          binding: validateBinding(payload.binding),
          expiresAt: payload.exp,
          oidcJtiSha256: payload.oidcJtiSha256,
        });
      } catch {
        return null;
      }
    },
  });
}

export function createRestoreLeaseCodec(keyBytes) {
  const keyPromise = importHmacKey(keyBytes);
  return Object.freeze({
    async issue({
      restoreId,
      targetGeneration,
      manifestSha256,
      leaseSubject,
      nowSeconds,
      ttlSeconds,
    }) {
      invariant(typeof restoreId === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(restoreId),
        'CONFIG_INVALID', 'restore lease invalid');
      invariant(Number.isSafeInteger(targetGeneration) && targetGeneration > 0,
        'CONFIG_INVALID', 'restore lease invalid');
      invariant(typeof manifestSha256 === 'string' && /^[0-9a-f]{64}$/u.test(manifestSha256),
        'CONFIG_INVALID', 'restore lease invalid');
      invariant(typeof leaseSubject === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(leaseSubject),
        'CONFIG_INVALID', 'restore lease invalid');
      invariant(Number.isSafeInteger(nowSeconds)
        && Number.isSafeInteger(ttlSeconds)
        && ttlSeconds > 0
        && ttlSeconds <= MAX_GRANT_TTL_SECONDS,
      'CONFIG_INVALID', 'restore lease invalid');
      const payload = Object.freeze({
        v: 1,
        restoreId,
        targetGeneration,
        manifestSha256,
        leaseSubject,
        iat: nowSeconds,
        exp: nowSeconds + ttlSeconds,
      });
      const encoded = base64Url(encoder.encode(canonicalJson(payload)));
      const unsigned = `bgr1.${encoded}`;
      const signature = base64Url(await hmac(await keyPromise, unsigned));
      return Object.freeze({
        restoreLease: `${unsigned}.${signature}`,
        expiresAt: payload.exp,
        expiresIn: ttlSeconds,
      });
    },
    async verify(token, { nowSeconds }) {
      try {
        if (!Number.isSafeInteger(nowSeconds)) return null;
        const parts = typeof token === 'string' ? token.split('.') : [];
        if (parts.length !== 3 || parts[0] !== 'bgr1') return null;
        const expected = await hmac(await keyPromise, `${parts[0]}.${parts[1]}`);
        if (!timingSafeEqual(expected, decodeBase64Url(parts[2]))) return null;
        const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[1])));
        if (!exactObject(payload, [
          'v', 'restoreId', 'targetGeneration', 'manifestSha256', 'leaseSubject', 'iat', 'exp',
        ])
          || payload.v !== 1
          || !/^[A-Za-z0-9_-]{8,128}$/u.test(payload.restoreId ?? '')
          || !Number.isSafeInteger(payload.targetGeneration)
          || payload.targetGeneration < 1
          || !/^[0-9a-f]{64}$/u.test(payload.manifestSha256 ?? '')
          || !/^[A-Za-z0-9_-]{8,128}$/u.test(payload.leaseSubject ?? '')
          || !Number.isSafeInteger(payload.iat)
          || !Number.isSafeInteger(payload.exp)
          || payload.exp <= nowSeconds
          || payload.exp <= payload.iat
          || payload.exp - payload.iat > MAX_GRANT_TTL_SECONDS) return null;
        return Object.freeze({
          restoreId: payload.restoreId,
          targetGeneration: payload.targetGeneration,
          manifestSha256: payload.manifestSha256,
          leaseSubject: payload.leaseSubject,
          expiresAt: payload.exp,
        });
      } catch {
        return null;
      }
    },
  });
}

export function createCloudflareTempCredentialRequest({
  accountId,
  parentAccessKeyId,
  bucket,
  prefix = null,
  objects = null,
  permission = 'object-read-write',
  ttlSeconds,
}) {
  invariant(typeof accountId === 'string' && /^[a-f0-9]{32}$/u.test(accountId),
    'CONFIG_INVALID', 'Cloudflare account invalid');
  invariant(exactText(parentAccessKeyId, /^[A-Za-z0-9_-]{8,128}$/u, 128),
    'CONFIG_INVALID', 'Cloudflare parent access key invalid');
  invariant(typeof bucket === 'string'
    && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)
    && !bucket.includes('..'), 'CONFIG_INVALID', 'R2 bucket invalid');
  const prefixValid = typeof prefix === 'string'
    && prefix.length > 0
    && prefix.length <= 512
    && prefix.endsWith('/')
    && !prefix.startsWith('/')
    && !prefix.includes('..')
    && !prefix.includes('\\');
  const objectsValid = Array.isArray(objects)
    && objects.length > 0
    && objects.length <= 2
    && objects.every(value => typeof value === 'string'
      && value.length > 0
      && value.length <= 1024
      && !value.startsWith('/')
      && !value.includes('..')
      && !value.includes('\\'));
  invariant((prefixValid ? 1 : 0) + (objectsValid ? 1 : 0) === 1,
    'CONFIG_INVALID', 'exactly one R2 prefix or object scope is required');
  invariant(permission === 'object-read-write' || permission === 'object-read-only',
    'CONFIG_INVALID', 'R2 temporary permission invalid');
  invariant(Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 600,
    'REQUEST_INVALID', 'R2 credential TTL must be within 600 seconds');
  const body = {
    bucket,
    parentAccessKeyId,
    permission,
    ttlSeconds,
  };
  if (prefixValid) body.prefixes = Object.freeze([prefix]);
  else body.objects = Object.freeze([...objects]);
  return Object.freeze({
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    body: Object.freeze(body),
  });
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, character => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function createR2SigV4HeadRequest({
  accountId,
  bucket,
  objectKey,
  credentials,
  now = new Date(),
}) {
  invariant(typeof accountId === 'string' && /^[a-f0-9]{32}$/u.test(accountId),
    'CONFIG_INVALID', 'Cloudflare account invalid');
  invariant(typeof bucket === 'string'
    && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)
    && !bucket.includes('..'), 'CONFIG_INVALID', 'R2 bucket invalid');
  invariant(typeof objectKey === 'string'
    && objectKey.length > 0
    && objectKey.length <= 1024
    && !objectKey.startsWith('/')
    && !objectKey.includes('..')
    && !objectKey.includes('\\'), 'REQUEST_INVALID', 'R2 object key invalid');
  invariant(plainRecord(credentials)
    && exactText(credentials.accessKeyId, /^[A-Za-z0-9_-]{8,128}$/u, 128)
    && exactText(credentials.secretAccessKey, /^\S{16,512}$/u, 512)
    && exactText(credentials.sessionToken, /^\S{16,8192}$/u, 8192),
  'UPSTREAM_UNAVAILABLE', 'temporary R2 credential invalid');
  invariant(now instanceof Date && Number.isFinite(now.getTime()), 'CONFIG_INVALID', 'signing time invalid');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${awsEncode(bucket)}/${objectKey.split('/').map(awsEncode).join('/')}`;
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const date = timestamp.slice(0, 8);
  const payloadHash = await sha256Hex(new Uint8Array());
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${timestamp}`,
    `x-amz-security-token:${credentials.sessionToken}`,
    '',
  ].join('\n');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token';
  const canonicalRequest = [
    'HEAD', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const credentialScope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = await hmacSha256(encoder.encode(`AWS4${credentials.secretAccessKey}`), date);
  const kRegion = await hmacSha256(kDate, 'auto');
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = [...await hmacSha256(kSigning, stringToSign)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({
    url: `https://${host}${canonicalUri}`,
    method: 'HEAD',
    headers: Object.freeze({
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      'x-amz-security-token': credentials.sessionToken,
    }),
  });
}

export { BINDING_FIELDS };
