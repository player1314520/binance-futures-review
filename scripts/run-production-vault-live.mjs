import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_LIVE_ATTESTATION_KEY_ID,
  assertProductionLiveAttestationProvisioned,
  signProductionLiveGateAttestation,
} from '../app/production-live-attestation.mjs';
import {
  ProductionControlPlaneError,
  canonicalProductionControlPlaneEvidence,
  collectProductionControlPlaneEvidence,
} from './verify-production-control-plane.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_FORMAT = 'rv-production-live-gate-receipt/4';
const TEST_VERSION = 'production-vault-live/9';
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGEMENT_RESPONSE_MAX_BYTES = 32 * 1024;
const MANAGEMENT_QUERY_TIMEOUT_MS = 8_000;
const SEMAPHORE_OBSERVATION_TIMEOUT_MS = 2_800;
const SEMAPHORE_OBSERVATION_REQUEST_TIMEOUT_MS = 1_200;
const SEMAPHORE_OBSERVATION_INTERVAL_MS = 100;
const SEMAPHORE_OBSERVATION_MAX_ATTEMPTS = 4;
const DATA_PLANE_REQUEST_TIMEOUT_MS = 3_000;

export const PRODUCTION_SEMAPHORE_HOLDER_QUERY = String.raw`with held_slots as materialized (
  select pg_catalog.pg_advisory_xact_lock(187904819, slot_id)
    from pg_catalog.generate_series(0, 9) as slots(slot_id)
)
select count(*) as held_slot_count, pg_catalog.pg_sleep(3)
  from held_slots;`;

export const PRODUCTION_SEMAPHORE_OBSERVATION_QUERY = String.raw`select exists (
  select 1
    from pg_catalog.pg_locks as l
   where l.locktype = 'advisory'
     and l.database = (
       select d.oid
         from pg_catalog.pg_database as d
        where d.datname = pg_catalog.current_database()
     )
     and l.classid = 187904819::oid
     and l.objid::bigint between 0 and 9
     and l.objsubid = 2
     and l.mode = 'ExclusiveLock'
     and l.granted
   group by l.pid
  having count(*) = 10
     and count(distinct l.objid) = 10
) as all_slots_held;`;
export const PRODUCTION_LIVE_REQUIRED_KEYS = Object.freeze([
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
  'RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN',
  'RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64',
]);
export const PRODUCTION_LIVE_FORBIDDEN_OPERATIONS_SECRET_KEYS = Object.freeze([
  'RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE',
  'RV_PRODUCTION_OPERATIONS_SIGN_ACK',
  'RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B',
]);
export const PRODUCTION_LIVE_CLEANUP_KEYS = Object.freeze([
  ...new Set([
    ...PRODUCTION_LIVE_REQUIRED_KEYS,
    ...PRODUCTION_LIVE_FORBIDDEN_OPERATIONS_SECRET_KEYS,
    'RV_PRODUCTION_VAULT_LIVE_REQUIRED',
    'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE',
    'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE_SHA',
    'RV_PRODUCTION_LIVE_RECEIPT_OUTPUT_FILE',
    'RV_PRODUCTION_LIVE_RUNNER_NONCE',
  ]),
]);
const EXPECTED_CHECKS = Object.freeze([
  'anonymous-and-direct-write-denial',
  'two-user-rls-isolation',
  'signed-history-and-tamper-denial',
  'cas-single-winner',
  'maximum-envelope-transport',
  'workspace-deletion-reconciled',
  'business-deletion-reconciled',
  'account-deletion-reconciled',
  'survivor-preserved-and-cleaned',
  'revoked-session-all-vault-operation-denial',
  'database-rate-rejection-and-semaphore-deployment',
]);

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

class ProductionSemaphoreLiveError extends Error {
  constructor(code) {
    super(`production database semaphore live proof failed (${code})`);
    this.name = 'ProductionSemaphoreLiveError';
    this.code = code;
  }
}

function semaphoreFail(code) {
  throw new ProductionSemaphoreLiveError(code);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedJson(response, { maximumBytes = MANAGEMENT_RESPONSE_MAX_BYTES } = {}) {
  const contentType = response?.headers?.get?.('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) semaphoreFail('RESPONSE_INVALID');
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes) {
      semaphoreFail('RESPONSE_TOO_LARGE');
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    semaphoreFail('RESPONSE_INVALID');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) semaphoreFail('RESPONSE_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ProductionSemaphoreLiveError) throw error;
    semaphoreFail('RESPONSE_INVALID');
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(text);
  } catch {
    semaphoreFail('RESPONSE_INVALID');
  }
}

async function boundedJsonRequest(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      semaphoreFail(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED');
    }
    if (!response || typeof response.status !== 'number' || response.redirected === true) {
      semaphoreFail('RESPONSE_INVALID');
    }
    const body = await readBoundedJson(response);
    return Object.freeze({ ok: response.ok, status: response.status, body });
  } finally {
    clearTimeout(timer);
  }
}

async function managementSqlRequest({
  fetchImpl,
  projectRef,
  managementToken,
  query,
  readOnly,
  timeoutMs,
}) {
  const response = await boundedJsonRequest(
    fetchImpl,
    `https://api.supabase.com/v1/projects/${projectRef}/database/query${readOnly ? '/read-only' : ''}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${managementToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
    timeoutMs,
  );
  if (response.status !== 201) semaphoreFail('MANAGEMENT_SQL_REJECTED');
  return response.body;
}

function parseFreshUserBSession(userId, token, nowMilliseconds) {
  if (!UUID_PATTERN.test(userId ?? '') || typeof token !== 'string') {
    semaphoreFail('USER_SESSION_INVALID');
  }
  if (token.length < 32 || token.length > 16_384 || /\s/.test(token)) {
    semaphoreFail('USER_SESSION_INVALID');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1].length > 16_384) semaphoreFail('USER_SESSION_INVALID');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    semaphoreFail('USER_SESSION_INVALID');
  }
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const authenticatedAudience = payload?.aud === 'authenticated'
    || (Array.isArray(payload?.aud) && payload.aud.includes('authenticated'));
  const recentOtp = Array.isArray(payload?.amr) && payload.amr.some((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && entry.method === 'otp'
    && Number.isInteger(entry.timestamp)
    && entry.timestamp <= nowSeconds + 30
    && nowSeconds - entry.timestamp <= 120
  ));
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.role !== 'authenticated'
    || String(payload.sub ?? '').toLowerCase() !== userId.toLowerCase()
    || !authenticatedAudience
    || payload.is_anonymous !== false
    || !UUID_PATTERN.test(String(payload.session_id ?? ''))
    || !Number.isInteger(payload.iat)
    || payload.iat > nowSeconds + 30
    || nowSeconds - payload.iat > 120
    || !recentOtp
    || !Number.isFinite(payload.exp)
    || Number(payload.exp) <= nowSeconds + 300
  ) semaphoreFail('USER_SESSION_NOT_FRESH');
  return String(payload.session_id).toLowerCase();
}

function assertPublishableKey(value) {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 4096
    || /\s/.test(value)
    || /^sb_secret_|service[_-]?role/i.test(value)
  ) semaphoreFail('INPUT_INVALID');
  if (value.startsWith('sb_publishable_')) return;
  const parts = value.split('.');
  let payload;
  try {
    payload = parts.length === 3
      ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      : null;
  } catch {
    semaphoreFail('INPUT_INVALID');
  }
  if (!payload || typeof payload !== 'object' || payload.role !== 'anon') {
    semaphoreFail('INPUT_INVALID');
  }
}

function validateSemaphoreLiveInputs({
  projectRef,
  managementToken,
  supabaseUrl,
  publishableKey,
  userBId,
  userBAccessToken,
  fetchImpl,
  now,
}) {
  if (!PROJECT_REF_PATTERN.test(projectRef ?? '')) semaphoreFail('INPUT_INVALID');
  if (
    typeof managementToken !== 'string'
    || managementToken.length < 20
    || managementToken.length > 4096
    || /\s/.test(managementToken)
  ) semaphoreFail('INPUT_INVALID');
  assertPublishableKey(publishableKey);
  if (typeof fetchImpl !== 'function' || !Number.isFinite(now)) semaphoreFail('INPUT_INVALID');
  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    semaphoreFail('INPUT_INVALID');
  }
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.port
    || parsedUrl.pathname !== '/'
    || parsedUrl.search
    || parsedUrl.hash
    || parsedUrl.hostname !== `${projectRef}.supabase.co`
  ) semaphoreFail('INPUT_INVALID');
  return Object.freeze({
    supabaseOrigin: parsedUrl.origin,
    sessionId: parseFreshUserBSession(userBId, userBAccessToken, now),
  });
}

async function rawListWorkspaces({
  fetchImpl,
  supabaseOrigin,
  publishableKey,
  userBAccessToken,
  sessionId,
}) {
  return await boundedJsonRequest(
    fetchImpl,
    `${supabaseOrigin}/rest/v1/rpc/rv_list_workspaces`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${userBAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_limit: 16, p_session_id: sessionId }),
    },
    DATA_PLANE_REQUEST_TIMEOUT_MS,
  );
}

export async function verifyProductionDatabaseSemaphoreLive({
  projectRef,
  managementToken,
  supabaseUrl,
  publishableKey,
  userBId,
  userBAccessToken,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  const { supabaseOrigin, sessionId } = validateSemaphoreLiveInputs({
    projectRef,
    managementToken,
    supabaseUrl,
    publishableKey,
    userBId,
    userBAccessToken,
    fetchImpl,
    now,
  });

  let holderSettled = false;
  const holderOutcomePromise = managementSqlRequest({
    fetchImpl,
    projectRef,
    managementToken,
    query: PRODUCTION_SEMAPHORE_HOLDER_QUERY,
    readOnly: true,
    timeoutMs: MANAGEMENT_QUERY_TIMEOUT_MS,
  }).then(
    (body) => {
      holderSettled = true;
      return Object.freeze({ ok: true, body });
    },
    (error) => {
      holderSettled = true;
      return Object.freeze({ ok: false, error });
    },
  );

  let preReleaseError = null;
  try {
    const observationDeadline = Date.now() + SEMAPHORE_OBSERVATION_TIMEOUT_MS;
    let allSlotsHeld = false;
    let observationAttempts = 0;
    while (
      !holderSettled
      && Date.now() < observationDeadline
      && observationAttempts < SEMAPHORE_OBSERVATION_MAX_ATTEMPTS
    ) {
      observationAttempts += 1;
      const rows = await managementSqlRequest({
        fetchImpl,
        projectRef,
        managementToken,
        query: PRODUCTION_SEMAPHORE_OBSERVATION_QUERY,
        readOnly: true,
        timeoutMs: SEMAPHORE_OBSERVATION_REQUEST_TIMEOUT_MS,
      });
      if (
        !Array.isArray(rows)
        || rows.length !== 1
        || !rows[0]
        || typeof rows[0] !== 'object'
        || Array.isArray(rows[0])
        || JSON.stringify(Object.keys(rows[0]).sort()) !== JSON.stringify(['all_slots_held'])
        || typeof rows[0].all_slots_held !== 'boolean'
      ) semaphoreFail('LOCK_OBSERVATION_INVALID');
      if (rows[0].all_slots_held === true) {
        allSlotsHeld = true;
        break;
      }
      await delay(SEMAPHORE_OBSERVATION_INTERVAL_MS);
    }
    if (!allSlotsHeld || holderSettled) semaphoreFail('LOCKS_NOT_OBSERVED');

    const rejected = await rawListWorkspaces({
      fetchImpl,
      supabaseOrigin,
      publishableKey,
      userBAccessToken,
      sessionId,
    });
    if (rejected.ok || rejected.body?.code !== 'P0005') {
      semaphoreFail('P0005_NOT_OBSERVED');
    }
  } catch (error) {
    preReleaseError = error instanceof ProductionSemaphoreLiveError
      ? error
      : new ProductionSemaphoreLiveError('UNEXPECTED_FAILURE');
  }

  // Always await the bounded holder request. Success below is tested only after
  // COMMIT has naturally released every transaction-scoped advisory lock.
  const holderOutcome = await holderOutcomePromise;
  if (preReleaseError) throw preReleaseError;
  if (!holderOutcome.ok) semaphoreFail('LOCK_HOLDER_FAILED');

  const released = await rawListWorkspaces({
    fetchImpl,
    supabaseOrigin,
    publishableKey,
    userBAccessToken,
    sessionId,
  });
  if (!released.ok || released.status !== 200 || !Array.isArray(released.body)) {
    semaphoreFail('LOCK_RELEASE_NOT_PROVEN');
  }
  return Object.freeze({ p0005Observed: true, released: true });
}

function exactCleanSourceCommit(expected) {
  const gitEnvironment = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }).filter(([, value]) => typeof value === 'string' && value.length > 0));
  const runGit = (args) => spawnSync('git', ['-C', REPOSITORY_ROOT, ...args], {
    encoding: 'utf8',
    env: gitEnvironment,
    maxBuffer: 16 * 1024 * 1024,
  });
  const head = runGit(['rev-parse', '--verify', 'HEAD']);
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (
    head.status !== 0
    || status.status !== 0
    || String(head.stdout).trim() !== expected
    || String(status.stdout) !== ''
  ) throw new Error('source commit is not the exact clean HEAD');
}

function readUnsignedReceipt({ receiptPath, runnerNonce, controlPlaneEvidence }) {
  const stat = fs.lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 256 || stat.size > 16_384) {
    throw new Error('unsigned receipt candidate is not a bounded regular file');
  }
  const bytes = fs.readFileSync(receiptPath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const receipt = JSON.parse(text);
  const expectedKeys = [
    'appOrigin', 'attestationKeyId', 'checks', 'cleanup', 'completedAt',
    'contractSha256', 'controlCollectedAt', 'controlPlane', 'evidenceSha256',
    'format', 'freshOtpSessions', 'manualReleaseBlockers', 'projectRef',
    'runnerNonceSha256', 'sourceCommit', 'testVersion',
  ];
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)
    || JSON.stringify(receipt) !== text
    || receipt.format !== RECEIPT_FORMAT
    || receipt.testVersion !== TEST_VERSION
    || receipt.attestationKeyId !== PRODUCTION_LIVE_ATTESTATION_KEY_ID
    || receipt.projectRef !== process.env.RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF
    || receipt.appOrigin !== process.env.RV_PRODUCTION_VAULT_APP_ORIGIN?.replace(/\/$/, '')
    || receipt.sourceCommit !== process.env.RV_PRODUCTION_VAULT_SOURCE_COMMIT
    || !/^[0-9a-f]{64}$/.test(receipt.contractSha256)
    || !/^[0-9a-f]{64}$/.test(receipt.evidenceSha256)
    || receipt.runnerNonceSha256 !== sha256Text(runnerNonce)
    || receipt.freshOtpSessions !== 2
    || receipt.manualReleaseBlockers !== 'not-evaluated-by-live-gate'
    || receipt.controlCollectedAt !== controlPlaneEvidence.collectedAt
    || JSON.stringify(receipt.controlPlane) !== canonicalProductionControlPlaneEvidence(controlPlaneEvidence)
    || receipt.cleanup !== 'user-a-account-deleted+user-b-business-cleared'
    || JSON.stringify(receipt.checks) !== JSON.stringify(EXPECTED_CHECKS)
  ) throw new Error('unsigned receipt candidate does not match the runner contract');
  const completedAt = Date.parse(receipt.completedAt);
  if (
    !Number.isFinite(completedAt)
    || new Date(completedAt).toISOString() !== receipt.completedAt
    || Math.abs(Date.now() - completedAt) > 5 * 60 * 1000
  ) throw new Error('unsigned receipt candidate is not fresh');
  return text;
}

function removeRunnerTemp(receiptPath, tempDirectory) {
  try {
    if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
  } catch {}
  try {
    fs.rmdirSync(tempDirectory);
  } catch {}
}

export function clearProductionLiveProcessEnvironment(environment = process.env) {
  for (const key of PRODUCTION_LIVE_CLEANUP_KEYS) delete environment[key];
}

async function runGate() {
  const missingCount = PRODUCTION_LIVE_REQUIRED_KEYS.filter((key) => !(process.env[key]?.trim())).length;
  if (missingCount > 0) {
    process.stderr.write(
      `Production vault live gate refused: ${missingCount} required process variables are missing.\n`,
    );
    return 2;
  }
  if (PRODUCTION_LIVE_FORBIDDEN_OPERATIONS_SECRET_KEYS.some((key) => process.env[key])) {
    process.stderr.write('Production vault live gate refused: operations signer secrets share its process scope.\n');
    return 1;
  }

  try {
    assertProductionLiveAttestationProvisioned();
  } catch {
    process.stderr.write('Production vault live gate refused: protected attestation key is not provisioned.\n');
    return 1;
  }
  try {
    // Validate custody before any Management API call or disposable-user
    // mutation. The preflight signature is discarded and authorizes nothing.
    signProductionLiveGateAttestation(
      'rv-production-live-attestation-key-preflight/1',
      process.env.RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64,
    );
  } catch {
    process.stderr.write('Production vault live gate refused: protected attestation key is invalid.\n');
    return 1;
  }

  let controlPlaneEvidence;
  try {
    controlPlaneEvidence = await collectProductionControlPlaneEvidence({
      projectRef: process.env.RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF,
      appOrigin: process.env.RV_PRODUCTION_VAULT_APP_ORIGIN,
      managementToken: process.env.RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN,
      repositoryRoot: REPOSITORY_ROOT,
    });
  } catch (error) {
    const code = error instanceof ProductionControlPlaneError ? error.code : 'UNEXPECTED_FAILURE';
    process.stderr.write(`Production vault live gate refused: control-plane verification failed (${code}).\n`);
    return 1;
  }

  try {
    await verifyProductionDatabaseSemaphoreLive({
      projectRef: process.env.RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF,
      managementToken: process.env.RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN,
      supabaseUrl: process.env.RV_PRODUCTION_VAULT_URL,
      publishableKey: process.env.RV_PRODUCTION_VAULT_PUBLISHABLE_KEY,
      userBId: process.env.RV_PRODUCTION_VAULT_TEST_USER_B_ID,
      userBAccessToken: process.env.RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN,
    });
  } catch {
    process.stderr.write('Production vault live gate refused: database semaphore live proof failed.\n');
    return 1;
  }

  const canonicalControlPlaneEvidence = canonicalProductionControlPlaneEvidence(controlPlaneEvidence);
  const encodedControlPlaneEvidence = Buffer.from(canonicalControlPlaneEvidence, 'utf8').toString('base64url');
  const controlPlaneEvidenceSha256 = sha256Text(canonicalControlPlaneEvidence);
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-production-live-'));
  const receiptPath = path.join(tempDirectory, 'unsigned-receipt.json');
  const runnerNonce = crypto.randomBytes(32).toString('hex');
  const childEnvironment = { ...process.env };
  delete childEnvironment.RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN;
  delete childEnvironment.RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64;
  delete childEnvironment.RV_PRODUCTION_CONTROL_PLANE_EVIDENCE;
  delete childEnvironment.RV_PRODUCTION_CONTROL_PLANE_EVIDENCE_SHA;
  delete childEnvironment.RV_PRODUCTION_LIVE_RECEIPT_OUTPUT_FILE;
  delete childEnvironment.RV_PRODUCTION_LIVE_RUNNER_NONCE;

  try {
    const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const result = spawnSync(executable, [
      'exec', 'vitest', 'run', 'tests/production-vault-live.spec.mjs',
      '--environment', 'node', '--testTimeout=300000', '--hookTimeout=300000',
    ], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...childEnvironment,
        RV_PRODUCTION_VAULT_LIVE_REQUIRED: '1',
        RV_PRODUCTION_CONTROL_PLANE_EVIDENCE: encodedControlPlaneEvidence,
        RV_PRODUCTION_CONTROL_PLANE_EVIDENCE_SHA: controlPlaneEvidenceSha256,
        RV_PRODUCTION_LIVE_RECEIPT_OUTPUT_FILE: receiptPath,
        RV_PRODUCTION_LIVE_RUNNER_NONCE: runnerNonce,
      },
      stdio: 'inherit',
      shell: false,
    });
    if (result.error || result.status !== 0) {
      process.stderr.write('Production vault live gate did not complete successfully.\n');
      return 1;
    }

    exactCleanSourceCommit(process.env.RV_PRODUCTION_VAULT_SOURCE_COMMIT);
    const canonicalReceipt = readUnsignedReceipt({ receiptPath, runnerNonce, controlPlaneEvidence });
    const signature = signProductionLiveGateAttestation(
      canonicalReceipt,
      process.env.RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64,
    );
    const encodedReceipt = Buffer.from(canonicalReceipt, 'utf8').toString('base64url');
    process.stdout.write('PRODUCTION_LIVE_GATE_ATTESTATION_BEGIN\n');
    process.stdout.write(`RV_PRODUCTION_LIVE_GATE_RECEIPT=${encodedReceipt}\n`);
    process.stdout.write(`RV_PRODUCTION_LIVE_GATE_SIGNATURE=${signature}\n`);
    process.stdout.write('PRODUCTION_LIVE_GATE_ATTESTATION_END\n');
    return 0;
  } catch {
    process.stderr.write('Production vault live gate refused: unsigned receipt or attestation was invalid.\n');
    return 1;
  } finally {
    removeRunnerTemp(receiptPath, tempDirectory);
  }
}

export async function main() {
  try {
    return await runGate();
  } finally {
    clearProductionLiveProcessEnvironment();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
