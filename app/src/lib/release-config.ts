import { ProductionConfigError, readProductionConfig } from './production-config';

export const RELEASE_DESCRIPTOR_FORMAT = 'rv-web-release/1' as const;
export const PRODUCTION_LIVE_GATE_RECEIPT_FORMAT = 'rv-production-live-gate-receipt/4' as const;
export const PRODUCTION_LIVE_GATE_TEST_VERSION = 'production-vault-live/9' as const;
export const PRODUCTION_LIVE_GATE_CONTRACT_DOMAIN = 'rv-production-live-contract/5' as const;
export const PRODUCTION_OPERATIONS_ATTESTATION_FORMAT = 'rv-production-operations-attestation/3' as const;
export const INVITE_BETA_LIVE_RECEIPT_FORMAT = 'invite-beta-live/1' as const;
export const INVITE_BETA_OPERATIONS_ATTESTATION_FORMAT = 'invite-beta-operations/1' as const;
export const INVITE_BETA_CANONICAL_ORIGIN = 'https://binance-futures-review-web.vercel.app' as const;
export const INVITE_BETA_LIVE_CHECKS = Object.freeze([
  'two-user-isolation',
  'sync',
  'review',
  'disconnect',
  'deletion',
  'recovery',
] as const);
export const PRODUCTION_LIVE_GATE_CONTRACT_FILES = Object.freeze([
  'app/production-live-attestation.mjs',
  'app/production-live-contract.mjs',
  'app/src/lib/release-config.ts',
  'app/src/lib/vault-crypto.ts',
  'app/src/lib/vault-repository.ts',
  'app/src/lib/vault-signing.ts',
  'app/vite.config.ts',
  'scripts/production-operations-evidence.mjs',
  'scripts/run-production-operations-attestation.mjs',
  'scripts/run-production-vault-live.mjs',
  'scripts/verify-production-control-plane.mjs',
  'supabase/config.toml',
  'supabase/functions/delete-account/handler.mjs',
  'supabase/functions/delete-account/index.ts',
  'supabase/functions/delete-account/protocol.mjs',
  'supabase/functions/publish-vault-head/handler.mjs',
  'supabase/functions/publish-vault-head/index.ts',
  'supabase/functions/publish-vault-head/protocol.mjs',
  'supabase/migrations/20260829000100_production_vault.sql',
  'supabase/migrations/20260830000100_vault_objects_device_fkey_index.sql',
  'supabase/migrations/20260830000200_free_plan_admission_controls.sql',
  'supabase/migrations/20260830000300_status_fairness_and_admission_truth.sql',
  'supabase/migrations/20260830000400_close_status_lookup_admission_gap.sql',
  'supabase/templates/magic-link.html',
  'tests/production-vault-live.spec.mjs',
] as const);
// The private source repository still contains a legacy Supabase migration
// chain. Its production-vault baseline is isolated there and is materialized at
// the standard path only by the privacy-gated public exporter.
export const PRODUCTION_LIVE_GATE_SOURCE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'supabase/migrations/20260829000100_production_vault.sql':
    'supabase/production-vault/migrations/20260829000100_production_vault.sql',
  'supabase/migrations/20260830000100_vault_objects_device_fkey_index.sql':
    'supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
  'supabase/migrations/20260830000200_free_plan_admission_controls.sql':
    'supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
  'supabase/migrations/20260830000300_status_fairness_and_admission_truth.sql':
    'supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
  'supabase/migrations/20260830000400_close_status_lookup_admission_gap.sql':
    'supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
});
export const PRODUCTION_LIVE_GATE_CHECKS = Object.freeze([
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
] as const);

const RECEIPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CONTROL_EVIDENCE_MAX_GAP_MS = 15 * 60 * 1000;

const EXPECTED_CONTROL_CRON_JOBS = Object.freeze([
  Object.freeze({
    jobName: 'rv-production-vault-maintenance',
    schedule: '*/5 * * * *',
    command: 'select private.rv_run_production_vault_maintenance();',
    maximumSuccessAgeMs: 10 * 60 * 1000,
  }),
  Object.freeze({
    jobName: 'rv-pg-cron-run-details-retention',
    schedule: '17 3 * * *',
    command: "delete from cron.job_run_details\n    where end_time < now() - interval '7 days';",
    maximumSuccessAgeMs: 36 * 60 * 60 * 1000,
  }),
]);
const EXPECTED_CONTROL_TRAFFIC = Object.freeze({
  enforcement: 'postgres-database-boundary',
  migrationCount: 5,
  limiterTableOwner: 'postgres',
  limiterTableRlsForced: true,
  privateExecuteDenied: true,
  privateTableAccessDenied: true,
  publicTableDmlAndSelectDenied: true,
  authenticatedReadRpcCount: 4,
  readRpcBypassDenied: true,
  servicePublishContextRpcCount: 1,
  servicePublishContextBypassDenied: true,
  vaultAdmissionWrapperCount: 9,
  destructiveAdmissionWrapperCount: 1,
  semaphoreWrapperCount: 15,
  exactWrapperSetsMatch: true,
  functionSecurityContractMatch: true,
  tokenBucketContractMatch: true,
  semaphoreContractMatch: true,
  statusFairnessContractMatch: true,
});
const EXPECTED_OPERATIONS_TRAFFIC_CONTROL = Object.freeze({
  accountingBoundary: 'postgres-transaction-commit',
  failedStatementConsumption: 'rolled-back',
  knownStatusFairness: 'known-capability-isolated-from-unknown-global',
  tokenBuckets: Object.freeze([
    Object.freeze({ scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256', capacity: 120, refillTokens: 120, refillPeriodSeconds: 60 }),
    Object.freeze({ scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256', capacity: 120, refillTokens: 120, refillPeriodSeconds: 60 }),
    Object.freeze({ scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 }),
    Object.freeze({ scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 }),
    Object.freeze({ scope: 'deletion-status', enforcement: 'postgres-atomic-token-bucket', keyKind: 'recovery-capability-hmac-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 }),
    Object.freeze({ scope: 'deletion-status-global', enforcement: 'postgres-atomic-token-bucket', keyKind: 'global-fixed-sha256', capacity: 60, refillTokens: 60, refillPeriodSeconds: 60 }),
  ]),
  authOtp: Object.freeze({ scope: 'auth-otp-send-and-verify', enforcement: 'supabase-auth-fixed-window', keyKind: 'project', windowSeconds: 3600, maxRequests: 6 }),
  semaphore: Object.freeze({ scope: 'user-facing-vault-database-transactions', enforcement: 'postgres-transaction-advisory-lock-semaphore', permits: 10, saturationResult: 'retryable-reject', trustedClientIp: false, edgeInvocationLimit: false }),
});
const EXPECTED_OPERATIONS_COST_POLICY = Object.freeze({
  provider: 'supabase', plan: 'free', currency: 'USD', approvedRecurringCostMinor: 0,
  overageBilling: false, monetarySpendCapAvailable: false, monetaryAlertAvailable: false,
  paidAddons: false, quotaExhaustionBehavior: 'restrict-or-pause',
});
const EXPECTED_OPERATIONS_MONITORING_CHECKS = Object.freeze([
  'auth-otp-delivery', 'free-plan-entitlement-and-no-paid-addons',
  'free-plan-quota-state', 'cron-maintenance', 'cron-retention',
  'edge-delete-health', 'edge-publish-health', 'db-admission-control-health',
]);

type ReleaseVerificationOptions = Readonly<{
  now?: number;
  sha256Text?: (value: string) => string;
  expectedContractSha256?: string;
  expectedAttestationKeyId?: string;
  verifyReceiptAttestation?: (canonicalReceipt: string, signature: string) => boolean;
  expectedOperationsAttestationKeyId?: string;
  verifyOperationsAttestation?: (canonicalAttestation: string, signature: string) => boolean;
  expectedInviteBetaContractSha256?: string;
  expectedInviteBetaLiveKeyId?: string;
  verifyInviteBetaLiveAttestation?: (canonicalReceipt: string, signature: string) => boolean;
  expectedInviteBetaOperationsKeyId?: string;
  verifyInviteBetaOperationsAttestation?: (canonicalAttestation: string, signature: string) => boolean;
}>;

export type ReleaseDescriptor = Readonly<{
  format: typeof RELEASE_DESCRIPTOR_FORMAT;
  commit: string | null;
  product: 'Binance Futures Review Web';
  mode: 'local-demo' | 'production-vault' | 'invite-beta';
  backendProjectRef: string | null;
  appOrigin: string | null;
  liveGateReceiptSha256: string | null;
  operationsAttestation: Readonly<{
    keyId: string;
    witnessedAt: string;
    evidenceBundleSha256: string;
    attestationSha256: string;
  }> | null;
}>;

export class ReleaseConfigError extends Error {
  readonly code = 'RELEASE_CONFIG_INVALID';
}

function exactHttpsOrigin(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ReleaseConfigError(`${field} 必须是 HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) throw new ReleaseConfigError(`${field} 必须是 HTTPS origin`);
  return parsed;
}

function decodeCanonicalLiveGateReceipt(value: string): Readonly<{
  canonicalReceipt: string;
  attestationKeyId: string;
  projectRef: string;
  appOrigin: string;
  sourceCommit: string;
  contractSha256: string;
  completedAt: string;
  controlCollectedAt: string;
  evidenceSha256: string;
}> {
  if (!/^[A-Za-z0-9_-]{64,8192}$/.test(value)) {
    throw new ReleaseConfigError('生产 live gate 回执必须是受限 canonical base64url');
  }
  let text: string;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseConfigError('生产 live gate 回执无法解码');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReleaseConfigError('生产 live gate 回执不是 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReleaseConfigError('生产 live gate 回执结构无效');
  }
  const row = parsed as Record<string, unknown>;
  const expectedKeys = [
    'appOrigin', 'attestationKeyId', 'checks', 'cleanup', 'completedAt',
    'contractSha256', 'controlCollectedAt', 'controlPlane', 'evidenceSha256',
    'format', 'freshOtpSessions', 'manualReleaseBlockers', 'projectRef',
    'runnerNonceSha256', 'sourceCommit', 'testVersion',
  ];
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(expectedKeys)) {
    throw new ReleaseConfigError('生产 live gate 回执字段不完整');
  }
  if (
    row.format !== PRODUCTION_LIVE_GATE_RECEIPT_FORMAT
    || row.testVersion !== PRODUCTION_LIVE_GATE_TEST_VERSION
    || row.cleanup !== 'user-a-account-deleted+user-b-business-cleared'
    || !Array.isArray(row.checks)
    || JSON.stringify(row.checks) !== JSON.stringify(PRODUCTION_LIVE_GATE_CHECKS)
    || typeof row.projectRef !== 'string'
    || typeof row.appOrigin !== 'string'
    || typeof row.sourceCommit !== 'string'
    || typeof row.contractSha256 !== 'string'
    || typeof row.completedAt !== 'string'
    || typeof row.evidenceSha256 !== 'string'
    || typeof row.attestationKeyId !== 'string'
    || typeof row.runnerNonceSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.runnerNonceSha256)
    || row.freshOtpSessions !== 2
    || row.manualReleaseBlockers !== 'not-evaluated-by-live-gate'
  ) throw new ReleaseConfigError('生产 live gate 回执内容无效');

  const exactObject = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ReleaseConfigError(`${label}结构无效`);
    }
    const object = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())) {
      throw new ReleaseConfigError(`${label}字段不完整`);
    }
    return object;
  };
  const control = exactObject(row.controlPlane, [
    'appOrigin', 'auth', 'collectedAt', 'cron', 'customSmtp', 'format',
    'magicLinkTemplate', 'projectRef', 'sendEmailHook', 'trafficControl',
  ], '生产控制面证据');
  if (
    control.format !== 'rv-production-control-plane-evidence/2'
    || control.projectRef !== row.projectRef
    || control.appOrigin !== row.appOrigin
    || typeof control.collectedAt !== 'string'
    || row.controlCollectedAt !== control.collectedAt
  ) throw new ReleaseConfigError('生产控制面证据绑定无效');
  const auth = exactObject(control.auth, [
    'anonymousSignInsDisabled', 'emailAutoconfirmDisabled', 'emailOtpEnabled',
    'otpExpirySeconds', 'otpLength', 'phoneSignInsDisabled', 'redirectAllowListBound',
    'refreshTokenReuseIntervalSeconds', 'refreshTokenRotationEnabled',
    'secureEmailChangeEnabled', 'signupDisabled', 'siteUrlBound',
  ], '生产 Auth 证据');
  if (
    auth.signupDisabled !== true
    || auth.anonymousSignInsDisabled !== true
    || auth.emailOtpEnabled !== true
    || auth.phoneSignInsDisabled !== true
    || auth.emailAutoconfirmDisabled !== true
    || auth.otpLength !== 6
    || auth.otpExpirySeconds !== 600
    || auth.secureEmailChangeEnabled !== true
    || auth.refreshTokenRotationEnabled !== true
    || auth.refreshTokenReuseIntervalSeconds !== 10
    || auth.siteUrlBound !== true
    || auth.redirectAllowListBound !== true
  ) throw new ReleaseConfigError('生产 Auth 证据内容无效');
  const template = exactObject(control.magicLinkTemplate, ['exactMatch', 'normalizedSha256'], '生产邮件模板证据');
  const smtp = exactObject(control.customSmtp, ['configured'], '生产 SMTP 证据');
  const hook = exactObject(control.sendEmailHook, ['disabled'], '生产邮件 hook 证据');
  if (
    template.exactMatch !== true
    || typeof template.normalizedSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(template.normalizedSha256)
    || smtp.configured !== true
    || hook.disabled !== true
  ) throw new ReleaseConfigError('生产邮件控制面证据内容无效');
  const traffic = exactObject(control.trafficControl, [
    'authenticatedReadRpcCount', 'destructiveAdmissionWrapperCount',
    'enforcement', 'exactWrapperSetsMatch', 'functionSecurityContractMatch',
    'limiterTableOwner', 'limiterTableRlsForced', 'migrationCount',
    'privateExecuteDenied', 'privateTableAccessDenied',
    'publicTableDmlAndSelectDenied', 'readRpcBypassDenied',
    'semaphoreContractMatch', 'semaphoreWrapperCount',
    'servicePublishContextBypassDenied', 'servicePublishContextRpcCount',
    'statusFairnessContractMatch', 'tokenBucketContractMatch',
    'vaultAdmissionWrapperCount',
  ], '生产数据库流量控制证据');
  for (const [key, expected] of Object.entries(EXPECTED_CONTROL_TRAFFIC)) {
    if (traffic[key] !== expected) throw new ReleaseConfigError('生产数据库流量控制证据内容无效');
  }
  const cron = exactObject(control.cron, ['jobs', 'wrapperOwner'], '生产 cron 证据');
  if (cron.wrapperOwner !== 'postgres' || !Array.isArray(cron.jobs) || cron.jobs.length !== 2) {
    throw new ReleaseConfigError('生产 cron 证据内容无效');
  }
  const cronJobs = cron.jobs as unknown[];
  const collectedAt = Date.parse(control.collectedAt);
  if (!Number.isFinite(collectedAt) || new Date(collectedAt).toISOString() !== control.collectedAt) {
    throw new ReleaseConfigError('生产控制面证据时间无效');
  }
  const canonicalJobs = EXPECTED_CONTROL_CRON_JOBS.map((expected, index) => {
    const job = exactObject(cronJobs[index], [
      'active', 'command', 'jobName', 'latestFailureAt', 'latestStatus',
      'latestSuccessAt', 'owner', 'schedule',
    ], '生产 cron 作业证据');
    const success = typeof job.latestSuccessAt === 'string' ? Date.parse(job.latestSuccessAt) : Number.NaN;
    const failure = job.latestFailureAt === null
      ? null
      : typeof job.latestFailureAt === 'string' ? Date.parse(job.latestFailureAt) : Number.NaN;
    if (
      job.jobName !== expected.jobName
      || job.schedule !== expected.schedule
      || job.command !== expected.command
      || job.owner !== 'postgres'
      || job.active !== true
      || job.latestStatus !== 'succeeded'
      || !Number.isFinite(success)
      || new Date(success).toISOString() !== job.latestSuccessAt
      || success > collectedAt + RECEIPT_CLOCK_SKEW_MS
      || success < collectedAt - expected.maximumSuccessAgeMs
      || (failure !== null && (
        !Number.isFinite(failure)
        || new Date(failure).toISOString() !== job.latestFailureAt
        || failure > success
      ))
    ) throw new ReleaseConfigError('生产 cron 作业未满足运行与新鲜度合同');
    return {
      jobName: job.jobName,
      schedule: job.schedule,
      command: job.command,
      owner: job.owner,
      active: job.active,
      latestStatus: job.latestStatus,
      latestSuccessAt: job.latestSuccessAt,
      latestFailureAt: job.latestFailureAt,
    };
  });
  const canonicalControl = {
    format: control.format,
    projectRef: control.projectRef,
    appOrigin: control.appOrigin,
    collectedAt: control.collectedAt,
    auth: {
      signupDisabled: auth.signupDisabled,
      anonymousSignInsDisabled: auth.anonymousSignInsDisabled,
      emailOtpEnabled: auth.emailOtpEnabled,
      phoneSignInsDisabled: auth.phoneSignInsDisabled,
      emailAutoconfirmDisabled: auth.emailAutoconfirmDisabled,
      otpLength: auth.otpLength,
      otpExpirySeconds: auth.otpExpirySeconds,
      secureEmailChangeEnabled: auth.secureEmailChangeEnabled,
      refreshTokenRotationEnabled: auth.refreshTokenRotationEnabled,
      refreshTokenReuseIntervalSeconds: auth.refreshTokenReuseIntervalSeconds,
      siteUrlBound: auth.siteUrlBound,
      redirectAllowListBound: auth.redirectAllowListBound,
    },
    magicLinkTemplate: {
      normalizedSha256: template.normalizedSha256,
      exactMatch: template.exactMatch,
    },
    customSmtp: { configured: smtp.configured },
    sendEmailHook: { disabled: hook.disabled },
    trafficControl: EXPECTED_CONTROL_TRAFFIC,
    cron: { wrapperOwner: cron.wrapperOwner, jobs: canonicalJobs },
  };
  const canonical = JSON.stringify({
    format: row.format,
    testVersion: row.testVersion,
    attestationKeyId: row.attestationKeyId,
    projectRef: row.projectRef,
    appOrigin: row.appOrigin,
    sourceCommit: row.sourceCommit,
    contractSha256: row.contractSha256,
    completedAt: row.completedAt,
    controlCollectedAt: row.controlCollectedAt,
    evidenceSha256: row.evidenceSha256,
    freshOtpSessions: row.freshOtpSessions,
    manualReleaseBlockers: row.manualReleaseBlockers,
    runnerNonceSha256: row.runnerNonceSha256,
    controlPlane: canonicalControl,
    cleanup: row.cleanup,
    checks: row.checks,
  });
  if (canonical !== text) throw new ReleaseConfigError('生产 live gate 回执不是 canonical JSON');
  return Object.freeze({
    canonicalReceipt: canonical,
    attestationKeyId: row.attestationKeyId,
    projectRef: row.projectRef,
    appOrigin: row.appOrigin,
    sourceCommit: row.sourceCommit,
    contractSha256: row.contractSha256,
    completedAt: row.completedAt,
    controlCollectedAt: control.collectedAt,
    evidenceSha256: row.evidenceSha256,
  });
}

function decodeCanonicalOperationsAttestation(value: string): Readonly<{
  canonicalAttestation: string;
  keyId: string;
  projectRef: string;
  appOrigin: string;
  sourceCommit: string;
  liveReceiptSha256: string;
  witnessedAt: string;
  evidenceBundleSha256: string;
  evidenceCollectedAt: string;
  monitoringLatestSuccessAt: string;
  inboxSlots: ReadonlyArray<Readonly<{
    slot: unknown;
    sourceType: unknown;
    receivedAt: unknown;
    consumedAt: unknown;
    inboxIdentityCommitment: unknown;
    protectedRecordSha256: unknown;
    recordSha256: unknown;
  }>>;
  latestInboxConsumedAt: string;
}> {
  if (!/^[A-Za-z0-9_-]{128,8192}$/.test(value)) {
    throw new ReleaseConfigError('生产运营证明必须是受限 canonical base64url');
  }
  let text: string;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    throw new ReleaseConfigError('生产运营证明无法解码');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ReleaseConfigError('生产运营证明不是 JSON'); }
  const exactObject = (candidate: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ReleaseConfigError(`${label}结构无效`);
    }
    const object = candidate as Record<string, unknown>;
    if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())) {
      throw new ReleaseConfigError(`${label}字段不完整`);
    }
    return object;
  };
  const row = exactObject(parsed, [
    'appOrigin', 'controlledInboxOtp', 'costPolicy',
    'evidenceBundleSha256', 'evidenceCollectedAt', 'format', 'keyId',
    'liveReceiptSha256', 'monitoring', 'operatorSeparation', 'projectRef',
    'sourceCommit', 'trafficControl', 'witnessedAt',
  ], '生产运营证明');
  const inbox = exactObject(row.controlledInboxOtp, ['slots'], '双邮箱 OTP 运营证据');
  if (!Array.isArray(inbox.slots) || inbox.slots.length !== 2) {
    throw new ReleaseConfigError('双邮箱 OTP 运营证据不完整');
  }
  const slots = inbox.slots.map((candidate, index) => {
    const slot = exactObject(candidate, [
      'consumedAt', 'inboxIdentityCommitment', 'protectedRecordSha256', 'receivedAt', 'recordSha256', 'slot', 'sourceType',
    ], '邮箱槽位证据');
    const received = typeof slot.receivedAt === 'string' ? Date.parse(slot.receivedAt) : Number.NaN;
    const consumed = typeof slot.consumedAt === 'string' ? Date.parse(slot.consumedAt) : Number.NaN;
    if (
      slot.slot !== (index === 0 ? 'A' : 'B')
      || slot.sourceType !== 'controlled-inbox-observation'
      || typeof slot.inboxIdentityCommitment !== 'string'
      || !/^hmac-sha256:v1:[0-9a-f]{64}$/.test(slot.inboxIdentityCommitment)
      || typeof slot.protectedRecordSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(slot.protectedRecordSha256)
      || typeof slot.recordSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(slot.recordSha256)
      || !Number.isFinite(received)
      || !Number.isFinite(consumed)
      || new Date(received).toISOString() !== slot.receivedAt
      || new Date(consumed).toISOString() !== slot.consumedAt
      || consumed < received
      || consumed - received > 15 * 60 * 1000
    ) throw new ReleaseConfigError('双邮箱 OTP 运营证据不完整');
    return {
      slot: slot.slot,
      sourceType: slot.sourceType,
      receivedAt: slot.receivedAt,
      consumedAt: slot.consumedAt,
      inboxIdentityCommitment: slot.inboxIdentityCommitment,
      protectedRecordSha256: slot.protectedRecordSha256,
      recordSha256: slot.recordSha256,
    };
  });
  if (
    slots[0].inboxIdentityCommitment === slots[1].inboxIdentityCommitment
    || slots[0].protectedRecordSha256 === slots[1].protectedRecordSha256
  ) throw new ReleaseConfigError('双邮箱 OTP 证据未绑定两个独立受保护邮箱身份与观察记录');
  const trafficControlRaw = exactObject(
    row.trafficControl,
    [
      'accountingBoundary', 'authOtp', 'failedStatementConsumption',
      'knownStatusFairness', 'semaphore', 'tokenBuckets',
    ],
    '数据库流量控制证据',
  );
  for (const key of ['accountingBoundary', 'failedStatementConsumption', 'knownStatusFairness'] as const) {
    if (trafficControlRaw[key] !== EXPECTED_OPERATIONS_TRAFFIC_CONTROL[key]) {
      throw new ReleaseConfigError('数据库流量控制事务语义不符合精确策略');
    }
  }
  if (
    !Array.isArray(trafficControlRaw.tokenBuckets)
    || trafficControlRaw.tokenBuckets.length !== EXPECTED_OPERATIONS_TRAFFIC_CONTROL.tokenBuckets.length
  ) throw new ReleaseConfigError('数据库流量控制证据不完整');
  const tokenBuckets = trafficControlRaw.tokenBuckets.map((candidate, index) => {
    const item = exactObject(candidate, [
      'capacity', 'enforcement', 'keyKind', 'refillPeriodSeconds', 'refillTokens', 'scope',
    ], '数据库令牌桶证据');
    const expected = EXPECTED_OPERATIONS_TRAFFIC_CONTROL.tokenBuckets[index];
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (item[key] !== expectedValue) throw new ReleaseConfigError('数据库令牌桶证据不符合精确策略');
    }
    return expected;
  });
  const authOtp = exactObject(trafficControlRaw.authOtp, [
    'enforcement', 'keyKind', 'maxRequests', 'scope', 'windowSeconds',
  ], 'Auth OTP 限流证据');
  for (const [key, expectedValue] of Object.entries(EXPECTED_OPERATIONS_TRAFFIC_CONTROL.authOtp)) {
    if (authOtp[key] !== expectedValue) throw new ReleaseConfigError('Auth OTP 限流证据不符合精确策略');
  }
  const semaphore = exactObject(trafficControlRaw.semaphore, [
    'edgeInvocationLimit', 'enforcement', 'permits', 'saturationResult', 'scope', 'trustedClientIp',
  ], '数据库事务闸门证据');
  for (const [key, expectedValue] of Object.entries(EXPECTED_OPERATIONS_TRAFFIC_CONTROL.semaphore)) {
    if (semaphore[key] !== expectedValue) throw new ReleaseConfigError('数据库事务闸门证据不符合精确策略');
  }
  const costPolicy = exactObject(row.costPolicy, [
    'approvedRecurringCostMinor', 'currency', 'monetaryAlertAvailable',
    'monetarySpendCapAvailable', 'overageBilling', 'paidAddons', 'plan',
    'provider', 'quotaExhaustionBehavior',
  ], '免费方案费用证据');
  for (const [key, expectedValue] of Object.entries(EXPECTED_OPERATIONS_COST_POLICY)) {
    if (costPolicy[key] !== expectedValue) throw new ReleaseConfigError('免费方案费用证据不符合精确策略');
  }
  const monitoring = exactObject(row.monitoring, ['checks', 'latestSuccessAt'], '生产监控证据');
  const evidenceCollectedAt = typeof row.evidenceCollectedAt === 'string'
    ? Date.parse(row.evidenceCollectedAt) : Number.NaN;
  const monitoringLatestSuccessAt = typeof monitoring.latestSuccessAt === 'string'
    ? Date.parse(monitoring.latestSuccessAt) : Number.NaN;
  if (
    row.format !== PRODUCTION_OPERATIONS_ATTESTATION_FORMAT
    || typeof row.keyId !== 'string'
    || typeof row.projectRef !== 'string'
    || typeof row.appOrigin !== 'string'
    || typeof row.sourceCommit !== 'string'
    || typeof row.liveReceiptSha256 !== 'string'
    || typeof row.witnessedAt !== 'string'
    || typeof row.evidenceCollectedAt !== 'string'
    || !Number.isFinite(evidenceCollectedAt)
    || new Date(evidenceCollectedAt).toISOString() !== row.evidenceCollectedAt
    || !Number.isFinite(monitoringLatestSuccessAt)
    || new Date(monitoringLatestSuccessAt).toISOString() !== monitoring.latestSuccessAt
    || row.operatorSeparation !== 'independent-from-live-gate-signer'
    || JSON.stringify(monitoring.checks) !== JSON.stringify(EXPECTED_OPERATIONS_MONITORING_CHECKS)
    || typeof row.evidenceBundleSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.evidenceBundleSha256)
  ) throw new ReleaseConfigError('生产运营证明存在未完成的发布阻断项');
  const canonical = JSON.stringify({
    format: row.format,
    keyId: row.keyId,
    projectRef: row.projectRef,
    appOrigin: row.appOrigin,
    sourceCommit: row.sourceCommit,
    liveReceiptSha256: row.liveReceiptSha256,
    witnessedAt: row.witnessedAt,
    operatorSeparation: row.operatorSeparation,
    evidenceBundleSha256: row.evidenceBundleSha256,
    evidenceCollectedAt: row.evidenceCollectedAt,
    trafficControl: {
      accountingBoundary: EXPECTED_OPERATIONS_TRAFFIC_CONTROL.accountingBoundary,
      failedStatementConsumption: EXPECTED_OPERATIONS_TRAFFIC_CONTROL.failedStatementConsumption,
      knownStatusFairness: EXPECTED_OPERATIONS_TRAFFIC_CONTROL.knownStatusFairness,
      tokenBuckets,
      authOtp: EXPECTED_OPERATIONS_TRAFFIC_CONTROL.authOtp,
      semaphore: EXPECTED_OPERATIONS_TRAFFIC_CONTROL.semaphore,
    },
    costPolicy: EXPECTED_OPERATIONS_COST_POLICY,
    monitoring: { checks: monitoring.checks, latestSuccessAt: monitoring.latestSuccessAt },
    controlledInboxOtp: { slots },
  });
  if (canonical !== text) throw new ReleaseConfigError('生产运营证明不是 canonical JSON');
  return Object.freeze({
    canonicalAttestation: canonical,
    keyId: row.keyId as string,
    projectRef: row.projectRef as string,
    appOrigin: row.appOrigin as string,
    sourceCommit: row.sourceCommit as string,
    liveReceiptSha256: row.liveReceiptSha256 as string,
    witnessedAt: row.witnessedAt as string,
    evidenceBundleSha256: row.evidenceBundleSha256 as string,
    evidenceCollectedAt: row.evidenceCollectedAt as string,
    monitoringLatestSuccessAt: monitoring.latestSuccessAt as string,
    inboxSlots: slots,
    latestInboxConsumedAt: new Date(Math.max(
      Date.parse(slots[0].consumedAt as string),
      Date.parse(slots[1].consumedAt as string),
    )).toISOString(),
  });
}

type InviteBetaLiveReceipt = Readonly<{
  canonicalReceipt: string;
  attestationKeyId: string;
  projectRef: string;
  appOrigin: string;
  sourceCommit: string;
  backendContractSha256: string;
  completedAt: string;
  evidenceSha256: string;
}>;

type InviteBetaOperationsAttestation = Readonly<{
  canonicalAttestation: string;
  keyId: string;
  projectRef: string;
  appOrigin: string;
  sourceCommit: string;
  liveReceiptSha256: string;
  witnessedAt: string;
  evidenceBundleSha256: string;
}>;

function decodeInviteBetaJson(value: string, label: string): { row: Record<string, unknown>; canonical: string } {
  if (!/^[A-Za-z0-9_-]{64,8192}$/.test(value)) {
    throw new ReleaseConfigError(`${label}必须是受限 canonical base64url`);
  }
  let text: string;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ReleaseConfigError(`${label}无法解码`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReleaseConfigError(`${label}不是 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReleaseConfigError(`${label}结构无效`);
  }
  return { row: parsed as Record<string, unknown>, canonical: JSON.stringify(parsed) };
}

function exactInviteBetaKeys(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ReleaseConfigError(`${label}字段不完整`);
  }
}

function validInviteBetaIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{3,128}$/.test(value);
}

function exactInviteBetaChecks(value: unknown): boolean {
  return Array.isArray(value)
    && JSON.stringify(value) === JSON.stringify(INVITE_BETA_LIVE_CHECKS);
}

function decodeInviteBetaLiveReceipt(value: string): InviteBetaLiveReceipt {
  const decoded = decodeInviteBetaJson(value, 'Beta live 回执');
  const row = decoded.row;
  exactInviteBetaKeys(row, [
    'appOrigin',
    'attestationKeyId',
    'backendContractSha256',
    'checks',
    'completedAt',
    'evidenceSha256',
    'format',
    'projectRef',
    'sourceCommit',
  ], 'Beta live 回执');
  if (
    row.format !== INVITE_BETA_LIVE_RECEIPT_FORMAT
    || !validInviteBetaIdentity(row.attestationKeyId)
    || typeof row.projectRef !== 'string'
    || typeof row.appOrigin !== 'string'
    || typeof row.sourceCommit !== 'string'
    || typeof row.backendContractSha256 !== 'string'
    || typeof row.completedAt !== 'string'
    || typeof row.evidenceSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.backendContractSha256)
    || !/^[0-9a-f]{64}$/.test(row.evidenceSha256)
  ) throw new ReleaseConfigError('Beta live 回执内容无效');
  if (!exactInviteBetaChecks(row.checks)) {
    throw new ReleaseConfigError('Beta live 回执必须精确包含六项现场检查');
  }
  return Object.freeze({
    canonicalReceipt: decoded.canonical,
    attestationKeyId: row.attestationKeyId,
    projectRef: row.projectRef,
    appOrigin: row.appOrigin,
    sourceCommit: row.sourceCommit,
    backendContractSha256: row.backendContractSha256,
    completedAt: row.completedAt,
    evidenceSha256: row.evidenceSha256,
  });
}

function decodeInviteBetaOperations(value: string): InviteBetaOperationsAttestation {
  const decoded = decodeInviteBetaJson(value, 'Beta operations 证明');
  const row = decoded.row;
  exactInviteBetaKeys(row, [
    'appOrigin',
    'checks',
    'evidenceBundleSha256',
    'format',
    'keyId',
    'liveReceiptSha256',
    'projectRef',
    'sourceCommit',
    'witnessedAt',
  ], 'Beta operations 证明');
  if (
    row.format !== INVITE_BETA_OPERATIONS_ATTESTATION_FORMAT
    || !validInviteBetaIdentity(row.keyId)
    || typeof row.projectRef !== 'string'
    || typeof row.appOrigin !== 'string'
    || typeof row.sourceCommit !== 'string'
    || typeof row.liveReceiptSha256 !== 'string'
    || typeof row.witnessedAt !== 'string'
    || typeof row.evidenceBundleSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.liveReceiptSha256)
    || !/^[0-9a-f]{64}$/.test(row.evidenceBundleSha256)
  ) throw new ReleaseConfigError('Beta operations 证明内容无效');
  if (!exactInviteBetaChecks(row.checks)) {
    throw new ReleaseConfigError('Beta operations 证明必须精确包含六项现场检查');
  }
  return Object.freeze({
    canonicalAttestation: decoded.canonical,
    keyId: row.keyId,
    projectRef: row.projectRef,
    appOrigin: row.appOrigin,
    sourceCommit: row.sourceCommit,
    liveReceiptSha256: row.liveReceiptSha256,
    witnessedAt: row.witnessedAt,
    evidenceBundleSha256: row.evidenceBundleSha256,
  });
}

function validFreshIso(value: string, now: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === value
    && timestamp <= now + RECEIPT_CLOCK_SKEW_MS
    && timestamp >= now - RECEIPT_MAX_AGE_MS;
}

function buildInviteBetaDescriptor(
  env: Record<string, string | undefined>,
  verification: ReleaseVerificationOptions,
  commit: string,
  projectRef: string,
  appOrigin: URL,
): ReleaseDescriptor {
  if (appOrigin.origin !== INVITE_BETA_CANONICAL_ORIGIN) {
    throw new ReleaseConfigError(`Beta 应用地址必须是精确 canonical origin：${INVITE_BETA_CANONICAL_ORIGIN}`);
  }
  const receipt = decodeInviteBetaLiveReceipt((env.RV_INVITE_BETA_LIVE_RECEIPT ?? '').trim());
  if (receipt.projectRef !== projectRef) throw new ReleaseConfigError('Beta live 回执 project ref 不一致');
  if (receipt.appOrigin !== appOrigin.origin) throw new ReleaseConfigError('Beta live 回执应用 origin 不一致');
  if (receipt.sourceCommit !== commit) throw new ReleaseConfigError('Beta live 回执未绑定当前构建提交');
  if (
    !/^[0-9a-f]{64}$/.test(verification.expectedInviteBetaContractSha256 ?? '')
    || receipt.backendContractSha256 !== verification.expectedInviteBetaContractSha256
  ) throw new ReleaseConfigError('Beta live 回执未绑定当前 backend contract 摘要');
  if (
    !verification.expectedInviteBetaLiveKeyId
    || receipt.attestationKeyId !== verification.expectedInviteBetaLiveKeyId
  ) throw new ReleaseConfigError('Beta live 回执未绑定仓库固定证明公钥');
  const now = verification.now ?? Date.now();
  if (!validFreshIso(receipt.completedAt, now)) {
    throw new ReleaseConfigError('Beta live 回执已过期或时间无效');
  }
  const signature = (env.RV_INVITE_BETA_LIVE_SIGNATURE ?? '').trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || !verification.verifyInviteBetaLiveAttestation) {
    throw new ReleaseConfigError('Beta live Ed25519 签名缺失或格式无效');
  }
  let signatureValid = false;
  try {
    signatureValid = verification.verifyInviteBetaLiveAttestation(
      receipt.canonicalReceipt,
      signature,
    ) === true;
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new ReleaseConfigError('Beta live Ed25519 签名无效');
  if (!verification.sha256Text) throw new ReleaseConfigError('Beta live 回执缺少摘要器');
  const liveReceiptSha256 = verification.sha256Text(receipt.canonicalReceipt);
  if (!/^[0-9a-f]{64}$/.test(liveReceiptSha256)) {
    throw new ReleaseConfigError('Beta live 回执摘要无效');
  }

  const operations = decodeInviteBetaOperations(
    (env.RV_INVITE_BETA_OPERATIONS_ATTESTATION ?? '').trim(),
  );
  if (
    !verification.expectedInviteBetaOperationsKeyId
    || operations.keyId !== verification.expectedInviteBetaOperationsKeyId
    || operations.projectRef !== projectRef
    || operations.appOrigin !== appOrigin.origin
    || operations.sourceCommit !== commit
    || operations.liveReceiptSha256 !== liveReceiptSha256
  ) throw new ReleaseConfigError('Beta operations 证明未绑定固定公钥、当前发布或 live 回执');
  if (!validFreshIso(operations.witnessedAt, now)) {
    throw new ReleaseConfigError('Beta operations 证明已过期或时间无效');
  }
  const operationsSignature = (env.RV_INVITE_BETA_OPERATIONS_SIGNATURE ?? '').trim();
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(operationsSignature)
    || !verification.verifyInviteBetaOperationsAttestation
  ) throw new ReleaseConfigError('Beta operations Ed25519 签名缺失或格式无效');
  let operationsSignatureValid = false;
  try {
    operationsSignatureValid = verification.verifyInviteBetaOperationsAttestation(
      operations.canonicalAttestation,
      operationsSignature,
    ) === true;
  } catch {
    operationsSignatureValid = false;
  }
  if (!operationsSignatureValid) throw new ReleaseConfigError('Beta operations Ed25519 签名无效');
  const attestationSha256 = verification.sha256Text(operations.canonicalAttestation);
  if (!/^[0-9a-f]{64}$/.test(attestationSha256)) {
    throw new ReleaseConfigError('Beta operations 证明摘要无效');
  }
  return Object.freeze({
    format: RELEASE_DESCRIPTOR_FORMAT,
    commit,
    product: 'Binance Futures Review Web',
    mode: 'invite-beta',
    backendProjectRef: projectRef,
    appOrigin: appOrigin.origin,
    liveGateReceiptSha256: liveReceiptSha256,
    operationsAttestation: Object.freeze({
      keyId: operations.keyId,
      witnessedAt: operations.witnessedAt,
      evidenceBundleSha256: operations.evidenceBundleSha256,
      attestationSha256,
    }),
  });
}

export function buildReleaseDescriptor(
  env: Record<string, string | undefined>,
  verification: ReleaseVerificationOptions = {},
): ReleaseDescriptor {
  const channel = (env.VITE_RELEASE_CHANNEL ?? '').trim() || 'local';
  const viteCommit = (env.VITE_BUILD_SHA ?? '').trim();
  const providerCommit = (env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
  if (channel === 'local') {
    const commit = viteCommit || providerCommit;
    if (
      (env.VITE_SUPABASE_URL ?? '').trim()
      || (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim()
      || (env.VITE_EXPECTED_SUPABASE_PROJECT_REF ?? '').trim()
      || (env.VITE_APP_ORIGIN ?? '').trim()
      || (env.VITE_PRODUCTION_LIVE_GATE_PROJECT_REF ?? '').trim()
      || (env.RV_PRODUCTION_LIVE_GATE_RECEIPT_SHA ?? '').trim()
      || (env.VITE_BACKEND_MODE ?? '').trim()
      || (env.RV_INVITE_BETA_LIVE_RECEIPT ?? '').trim()
      || (env.RV_INVITE_BETA_LIVE_SIGNATURE ?? '').trim()
      || (env.RV_INVITE_BETA_OPERATIONS_ATTESTATION ?? '').trim()
      || (env.RV_INVITE_BETA_OPERATIONS_SIGNATURE ?? '').trim()
    ) throw new ReleaseConfigError('连接生产后端时必须显式设置 VITE_RELEASE_CHANNEL=production');
    if (commit && !/^[0-9a-f]{40}$/.test(commit)) {
      throw new ReleaseConfigError('构建提交必须是完整 40 位小写 Git SHA');
    }
    return Object.freeze({
      format: RELEASE_DESCRIPTOR_FORMAT,
      commit: commit || null,
      product: 'Binance Futures Review Web',
      mode: 'local-demo',
      backendProjectRef: null,
      appOrigin: null,
      liveGateReceiptSha256: null,
      operationsAttestation: null,
    });
  }
  if (channel !== 'production') throw new ReleaseConfigError('未知发布通道');
  if (!/^[0-9a-f]{40}$/.test(providerCommit)) {
    throw new ReleaseConfigError('Vercel 生产构建必须由 VERCEL_GIT_COMMIT_SHA 绑定完整 40 位小写 Git SHA');
  }
  if (viteCommit && viteCommit !== providerCommit) {
    throw new ReleaseConfigError('VITE_BUILD_SHA 与 Vercel 权威提交不一致');
  }
  const commit = providerCommit;

  let production;
  try {
    production = readProductionConfig(env);
  } catch (error) {
    if (error instanceof ProductionConfigError) throw new ReleaseConfigError(error.message);
    throw error;
  }
  if (!production) throw new ReleaseConfigError('生产构建必须配置 Supabase URL 与 publishable key');
  const projectRef = (env.VITE_EXPECTED_SUPABASE_PROJECT_REF ?? '').trim();
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new ReleaseConfigError('生产构建必须绑定精确 20 位 Supabase project ref');
  }
  const supabaseOrigin = exactHttpsOrigin(production.supabaseUrl, 'Supabase URL');
  if (supabaseOrigin.hostname !== `${projectRef}.supabase.co`) {
    throw new ReleaseConfigError('Supabase URL 与预期 project ref 不一致');
  }
  const appOrigin = exactHttpsOrigin(env.VITE_APP_ORIGIN ?? '', '应用地址');
  if (appOrigin.hostname === 'github.io' || appOrigin.hostname.endsWith('.github.io')) {
    throw new ReleaseConfigError('认证生产站禁止使用共享 github.io origin');
  }
  const backendMode = (env.VITE_BACKEND_MODE ?? '').trim() || 'production-vault';
  if (backendMode === 'invite-beta') {
    return buildInviteBetaDescriptor(env, verification, commit, projectRef, appOrigin);
  }
  if (backendMode !== 'production-vault') throw new ReleaseConfigError('未知生产后端模式');
  const liveGateRef = (env.VITE_PRODUCTION_LIVE_GATE_PROJECT_REF ?? '').trim();
  if (liveGateRef !== projectRef) {
    throw new ReleaseConfigError('生产 live gate project ref 与发布后端不一致');
  }
  if ((env.RV_PRODUCTION_LIVE_GATE_RECEIPT_SHA ?? '').trim()) {
    throw new ReleaseConfigError('旧 SHA-only live gate 变量已禁用，必须使用受保护 Ed25519 签名');
  }
  const encodedReceipt = (env.RV_PRODUCTION_LIVE_GATE_RECEIPT ?? '').trim();
  const receipt = decodeCanonicalLiveGateReceipt(encodedReceipt);
  if (receipt.projectRef !== projectRef) throw new ReleaseConfigError('生产 live gate 回执 project ref 不一致');
  if (receipt.appOrigin !== appOrigin.origin) throw new ReleaseConfigError('生产 live gate 回执应用 origin 不一致');
  if (receipt.sourceCommit !== commit) throw new ReleaseConfigError('生产 live gate 回执未绑定当前构建提交');
  if (!/^[0-9a-f]{64}$/.test(receipt.contractSha256) || !/^[0-9a-f]{64}$/.test(receipt.evidenceSha256)) {
    throw new ReleaseConfigError('生产 live gate 回执摘要无效');
  }
  if (
    !/^[0-9a-f]{64}$/.test(verification.expectedContractSha256 ?? '')
    || receipt.contractSha256 !== verification.expectedContractSha256
  ) throw new ReleaseConfigError('生产 live gate 回执未绑定当前协议与迁移源码');
  if (
    !verification.expectedAttestationKeyId
    || receipt.attestationKeyId !== verification.expectedAttestationKeyId
  ) throw new ReleaseConfigError('生产 live gate 回执未绑定仓库固定证明公钥');
  const completedAt = Date.parse(receipt.completedAt);
  const now = verification.now ?? Date.now();
  if (
    !Number.isFinite(completedAt)
    || new Date(completedAt).toISOString() !== receipt.completedAt
    || completedAt > now + RECEIPT_CLOCK_SKEW_MS
    || completedAt < now - RECEIPT_MAX_AGE_MS
  ) throw new ReleaseConfigError('生产 live gate 回执已过期或时间无效');
  const controlCollectedAt = Date.parse(receipt.controlCollectedAt);
  if (
    controlCollectedAt > completedAt + RECEIPT_CLOCK_SKEW_MS
    || controlCollectedAt < completedAt - CONTROL_EVIDENCE_MAX_GAP_MS
  ) throw new ReleaseConfigError('生产控制面证据与 live gate 完成时间不一致');
  const signature = (env.RV_PRODUCTION_LIVE_GATE_SIGNATURE ?? '').trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || !verification.verifyReceiptAttestation) {
    throw new ReleaseConfigError('生产构建缺少受保护 Ed25519 live gate 签名');
  }
  let signatureValid = false;
  try {
    signatureValid = verification.verifyReceiptAttestation(receipt.canonicalReceipt, signature) === true;
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new ReleaseConfigError('生产 live gate Ed25519 签名无效');
  if (!verification.sha256Text) throw new ReleaseConfigError('生产构建缺少 live gate 回执摘要器');
  const liveGateReceipt = verification.sha256Text(receipt.canonicalReceipt);
  if (!/^[0-9a-f]{64}$/.test(liveGateReceipt)) {
    throw new ReleaseConfigError('生产 live gate 回执摘要无效');
  }
  const operations = decodeCanonicalOperationsAttestation(
    (env.RV_PRODUCTION_OPERATIONS_ATTESTATION ?? '').trim(),
  );
  if (
    operations.keyId !== verification.expectedOperationsAttestationKeyId
    || operations.projectRef !== projectRef
    || operations.appOrigin !== appOrigin.origin
    || operations.sourceCommit !== commit
    || operations.liveReceiptSha256 !== liveGateReceipt
  ) throw new ReleaseConfigError('生产运营证明未绑定固定公钥、当前发布或 live gate 回执');
  const operationsWitnessedAt = Date.parse(operations.witnessedAt);
  const operationsEvidenceAt = Date.parse(operations.evidenceCollectedAt);
  const operationsMonitoringAt = Date.parse(operations.monitoringLatestSuccessAt);
  const operationsInboxAt = Date.parse(operations.latestInboxConsumedAt);
  if (
    !Number.isFinite(operationsWitnessedAt)
    || new Date(operationsWitnessedAt).toISOString() !== operations.witnessedAt
    || operationsWitnessedAt > now + RECEIPT_CLOCK_SKEW_MS
    || operationsWitnessedAt < now - RECEIPT_MAX_AGE_MS
    || operationsEvidenceAt > operationsWitnessedAt + RECEIPT_CLOCK_SKEW_MS
    || operationsEvidenceAt < now - RECEIPT_MAX_AGE_MS
    || operationsMonitoringAt > operationsEvidenceAt + RECEIPT_CLOCK_SKEW_MS
    || operationsMonitoringAt < now - 15 * 60 * 1000
    || operationsInboxAt > operationsEvidenceAt + RECEIPT_CLOCK_SKEW_MS
    || operationsInboxAt < now - RECEIPT_MAX_AGE_MS
  ) throw new ReleaseConfigError('生产运营证明已过期或时间无效');
  for (const slot of operations.inboxSlots) {
    const manifest = JSON.stringify({
      slot: slot.slot,
      sourceType: slot.sourceType,
      receivedAt: slot.receivedAt,
      consumedAt: slot.consumedAt,
      inboxIdentityCommitment: slot.inboxIdentityCommitment,
      protectedRecordSha256: slot.protectedRecordSha256,
    });
    if (verification.sha256Text(manifest) !== slot.recordSha256) {
      throw new ReleaseConfigError('双邮箱 OTP 槽位摘要未绑定受保护邮箱身份承诺');
    }
  }
  const operationsSignature = (env.RV_PRODUCTION_OPERATIONS_SIGNATURE ?? '').trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(operationsSignature) || !verification.verifyOperationsAttestation) {
    throw new ReleaseConfigError('生产构建缺少独立受保护运营 Ed25519 签名');
  }
  let operationsSignatureValid = false;
  try {
    operationsSignatureValid = verification.verifyOperationsAttestation(
      operations.canonicalAttestation,
      operationsSignature,
    ) === true;
  } catch {
    operationsSignatureValid = false;
  }
  if (!operationsSignatureValid) throw new ReleaseConfigError('生产运营 Ed25519 签名无效');
  const operationsAttestationSha256 = verification.sha256Text(operations.canonicalAttestation);
  if (!/^[0-9a-f]{64}$/.test(operationsAttestationSha256)) {
    throw new ReleaseConfigError('生产运营证明摘要无效');
  }
  return Object.freeze({
    format: RELEASE_DESCRIPTOR_FORMAT,
    commit,
    product: 'Binance Futures Review Web',
    mode: 'production-vault',
    backendProjectRef: projectRef,
    appOrigin: appOrigin.origin,
    liveGateReceiptSha256: liveGateReceipt,
    operationsAttestation: Object.freeze({
      keyId: operations.keyId,
      witnessedAt: operations.witnessedAt,
      evidenceBundleSha256: operations.evidenceBundleSha256,
      attestationSha256: operationsAttestationSha256,
    }),
  });
}
