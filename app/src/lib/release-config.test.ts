import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_LIVE_GATE_CHECKS,
  PRODUCTION_LIVE_GATE_RECEIPT_FORMAT,
  PRODUCTION_LIVE_GATE_TEST_VERSION,
  ReleaseConfigError,
  buildReleaseDescriptor,
} from './release-config';

const REF = 'abcdefghijklmnopqrst';
const SHA = 'a'.repeat(40);
const PUBLISHABLE = `sb_publishable_${'A'.repeat(24)}`;
const NOW = Date.parse('2026-08-28T14:00:00.000Z');
const CONTRACT_SHA = 'd'.repeat(64);
const RECEIPT_SHA = 'c'.repeat(64);
const ATTESTATION_KEY_ID = 'rv-production-test-key';
const RECEIPT_SIGNATURE = 'A'.repeat(86);
const OPERATIONS_KEY_ID = 'rv-operations-test-key';
const OPERATIONS_SIGNATURE = 'C'.repeat(86);
const OPERATIONS_SHA = '6'.repeat(64);
const BETA_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const BETA_CONTRACT_SHA = '4'.repeat(64);
const BETA_RECEIPT_SHA = '5'.repeat(64);
const BETA_RECEIPT_SIGNATURE = 'E'.repeat(86);
const BETA_LIVE_KEY_ID = 'rv-invite-beta-live-test-key';
const BETA_OPERATIONS_KEY_ID = 'rv-invite-beta-operations-test-key';
const BETA_OPERATIONS_SIGNATURE = 'F'.repeat(86);
const BETA_OPERATIONS_SHA = '8'.repeat(64);
function receipt(overrides: Record<string, unknown> = {}) {
  const controlPlane = {
    format: 'rv-production-control-plane-evidence/2',
    projectRef: REF,
    appOrigin: 'https://binance-futures-review.vercel.app',
    collectedAt: '2026-08-28T13:45:00.000Z',
    auth: {
      signupDisabled: true,
      anonymousSignInsDisabled: true,
      emailOtpEnabled: true,
      phoneSignInsDisabled: true,
      emailAutoconfirmDisabled: true,
      otpLength: 6,
      otpExpirySeconds: 600,
      secureEmailChangeEnabled: true,
      refreshTokenRotationEnabled: true,
      refreshTokenReuseIntervalSeconds: 10,
      siteUrlBound: true,
      redirectAllowListBound: true,
    },
    magicLinkTemplate: { normalizedSha256: '1'.repeat(64), exactMatch: true },
    customSmtp: { configured: true },
    sendEmailHook: { disabled: true },
    trafficControl: {
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
    },
    cron: {
      wrapperOwner: 'postgres',
      jobs: [
        {
          jobName: 'rv-production-vault-maintenance',
          schedule: '*/5 * * * *',
          command: 'select private.rv_run_production_vault_maintenance();',
          owner: 'postgres',
          active: true,
          latestStatus: 'succeeded',
          latestSuccessAt: '2026-08-28T13:40:00.000Z',
          latestFailureAt: '2026-08-28T12:00:00.000Z',
        },
        {
          jobName: 'rv-pg-cron-run-details-retention',
          schedule: '17 3 * * *',
          command: "delete from cron.job_run_details\n    where end_time < now() - interval '7 days';",
          owner: 'postgres',
          active: true,
          latestStatus: 'succeeded',
          latestSuccessAt: '2026-08-27T13:45:00.000Z',
          latestFailureAt: null,
        },
      ],
    },
  };
  return {
    format: PRODUCTION_LIVE_GATE_RECEIPT_FORMAT,
    testVersion: PRODUCTION_LIVE_GATE_TEST_VERSION,
    attestationKeyId: ATTESTATION_KEY_ID,
    projectRef: REF,
    appOrigin: 'https://binance-futures-review.vercel.app',
    sourceCommit: SHA,
    contractSha256: CONTRACT_SHA,
    completedAt: '2026-08-28T13:50:00.000Z',
    controlCollectedAt: controlPlane.collectedAt,
    evidenceSha256: 'e'.repeat(64),
    freshOtpSessions: 2,
    manualReleaseBlockers: 'not-evaluated-by-live-gate',
    runnerNonceSha256: 'b'.repeat(64),
    controlPlane,
    cleanup: 'user-a-account-deleted+user-b-business-cleared',
    checks: PRODUCTION_LIVE_GATE_CHECKS,
    ...overrides,
  };
}

function operationsAttestation(overrides: Record<string, unknown> = {}) {
  return {
    format: 'rv-production-operations-attestation/3',
    keyId: OPERATIONS_KEY_ID,
    projectRef: REF,
    appOrigin: 'https://binance-futures-review.vercel.app',
    sourceCommit: SHA,
    liveReceiptSha256: RECEIPT_SHA,
    witnessedAt: '2026-08-28T13:55:00.000Z',
    operatorSeparation: 'independent-from-live-gate-signer',
    evidenceBundleSha256: '7'.repeat(64),
    evidenceCollectedAt: '2026-08-28T13:50:00.000Z',
    trafficControl: {
      accountingBoundary: 'postgres-transaction-commit',
      failedStatementConsumption: 'rolled-back',
      knownStatusFairness: 'known-capability-isolated-from-unknown-global',
      tokenBuckets: [
        { scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256', capacity: 120, refillTokens: 120, refillPeriodSeconds: 60 },
        { scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256', capacity: 120, refillTokens: 120, refillPeriodSeconds: 60 },
        { scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 },
        { scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 },
        { scope: 'deletion-status', enforcement: 'postgres-atomic-token-bucket', keyKind: 'recovery-capability-hmac-sha256', capacity: 10, refillTokens: 10, refillPeriodSeconds: 60 },
        { scope: 'deletion-status-global', enforcement: 'postgres-atomic-token-bucket', keyKind: 'global-fixed-sha256', capacity: 60, refillTokens: 60, refillPeriodSeconds: 60 },
      ],
      authOtp: { scope: 'auth-otp-send-and-verify', enforcement: 'supabase-auth-fixed-window', keyKind: 'project', windowSeconds: 3600, maxRequests: 6 },
      semaphore: { scope: 'user-facing-vault-database-transactions', enforcement: 'postgres-transaction-advisory-lock-semaphore', permits: 10, saturationResult: 'retryable-reject', trustedClientIp: false, edgeInvocationLimit: false },
    },
    costPolicy: { provider: 'supabase', plan: 'free', currency: 'USD', approvedRecurringCostMinor: 0, overageBilling: false, monetarySpendCapAvailable: false, monetaryAlertAvailable: false, paidAddons: false, quotaExhaustionBehavior: 'restrict-or-pause' },
    monitoring: {
      checks: [
        'auth-otp-delivery', 'free-plan-entitlement-and-no-paid-addons',
        'free-plan-quota-state', 'cron-maintenance', 'cron-retention',
        'edge-delete-health', 'edge-publish-health', 'db-admission-control-health',
      ],
      latestSuccessAt: '2026-08-28T13:49:00.000Z',
    },
    controlledInboxOtp: { slots: [
      { slot: 'A', sourceType: 'controlled-inbox-observation', receivedAt: '2026-08-28T13:44:00.000Z', consumedAt: '2026-08-28T13:46:00.000Z', inboxIdentityCommitment: `hmac-sha256:v1:${'a'.repeat(64)}`, protectedRecordSha256: '1'.repeat(64), recordSha256: '2'.repeat(64) },
      { slot: 'B', sourceType: 'controlled-inbox-observation', receivedAt: '2026-08-28T13:47:00.000Z', consumedAt: '2026-08-28T13:48:00.000Z', inboxIdentityCommitment: `hmac-sha256:v1:${'b'.repeat(64)}`, protectedRecordSha256: '3'.repeat(64), recordSha256: '4'.repeat(64) },
    ] },
    ...overrides,
  };
}

function encodedOperations(overrides: Record<string, unknown> = {}) {
  return btoa(JSON.stringify(operationsAttestation(overrides)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodedReceipt(overrides: Record<string, unknown> = {}) {
  return btoa(JSON.stringify(receipt(overrides)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const verification = {
  now: NOW,
  expectedContractSha256: CONTRACT_SHA,
  sha256Text: (value: string) => {
    if (value === JSON.stringify(receipt())) return RECEIPT_SHA;
    if (value === JSON.stringify(operationsAttestation())) return OPERATIONS_SHA;
    const slots = operationsAttestation().controlledInboxOtp.slots;
    for (const slot of slots) {
      const { recordSha256, ...manifest } = slot;
      if (value === JSON.stringify(manifest)) return recordSha256;
    }
    return 'f'.repeat(64);
  },
  expectedAttestationKeyId: ATTESTATION_KEY_ID,
  verifyReceiptAttestation: (value: string, signature: string) => (
    value === JSON.stringify(receipt()) && signature === RECEIPT_SIGNATURE
  ),
  expectedOperationsAttestationKeyId: OPERATIONS_KEY_ID,
  verifyOperationsAttestation: (value: string, signature: string) => (
    value === JSON.stringify(operationsAttestation()) && signature === OPERATIONS_SIGNATURE
  ),
};

function production(overrides: Record<string, string> = {}) {
  return {
    VITE_RELEASE_CHANNEL: 'production',
    VITE_BUILD_SHA: SHA,
    VERCEL_GIT_COMMIT_SHA: SHA,
    VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
    VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    VITE_EXPECTED_SUPABASE_PROJECT_REF: REF,
    VITE_APP_ORIGIN: 'https://binance-futures-review.vercel.app',
    VITE_PRODUCTION_LIVE_GATE_PROJECT_REF: REF,
    RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt(),
    RV_PRODUCTION_LIVE_GATE_SIGNATURE: RECEIPT_SIGNATURE,
    RV_PRODUCTION_OPERATIONS_ATTESTATION: encodedOperations(),
    RV_PRODUCTION_OPERATIONS_SIGNATURE: OPERATIONS_SIGNATURE,
    ...overrides,
  };
}

const BETA_CHECKS = [
  'two-user-isolation',
  'sync',
  'review',
  'disconnect',
  'deletion',
  'recovery',
] as const;

function betaReceipt(overrides: Record<string, unknown> = {}) {
  return {
    format: 'invite-beta-live/1',
    attestationKeyId: BETA_LIVE_KEY_ID,
    projectRef: REF,
    appOrigin: BETA_ORIGIN,
    sourceCommit: SHA,
    backendContractSha256: BETA_CONTRACT_SHA,
    completedAt: '2026-08-28T13:50:00.000Z',
    evidenceSha256: '9'.repeat(64),
    checks: BETA_CHECKS,
    ...overrides,
  };
}

function betaOperations(overrides: Record<string, unknown> = {}) {
  return {
    format: 'invite-beta-operations/1',
    keyId: BETA_OPERATIONS_KEY_ID,
    projectRef: REF,
    appOrigin: BETA_ORIGIN,
    sourceCommit: SHA,
    liveReceiptSha256: BETA_RECEIPT_SHA,
    witnessedAt: '2026-08-28T13:55:00.000Z',
    evidenceBundleSha256: '7'.repeat(64),
    checks: BETA_CHECKS,
    ...overrides,
  };
}

function encode(value: unknown) {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function inviteBeta(overrides: Record<string, string> = {}) {
  return {
    VITE_RELEASE_CHANNEL: 'production',
    VITE_BACKEND_MODE: 'invite-beta',
    VERCEL_GIT_COMMIT_SHA: SHA,
    VITE_BUILD_SHA: SHA,
    VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
    VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    VITE_EXPECTED_SUPABASE_PROJECT_REF: REF,
    VITE_APP_ORIGIN: BETA_ORIGIN,
    RV_INVITE_BETA_LIVE_RECEIPT: encode(betaReceipt()),
    RV_INVITE_BETA_LIVE_SIGNATURE: BETA_RECEIPT_SIGNATURE,
    RV_INVITE_BETA_OPERATIONS_ATTESTATION: encode(betaOperations()),
    RV_INVITE_BETA_OPERATIONS_SIGNATURE: BETA_OPERATIONS_SIGNATURE,
    ...overrides,
  };
}

const betaVerification = {
  now: NOW,
  sha256Text: (value: string) => {
    if (value === JSON.stringify(betaReceipt())) return BETA_RECEIPT_SHA;
    if (value === JSON.stringify(betaOperations())) return BETA_OPERATIONS_SHA;
    return '0'.repeat(64);
  },
  expectedInviteBetaContractSha256: BETA_CONTRACT_SHA,
  expectedInviteBetaLiveKeyId: BETA_LIVE_KEY_ID,
  verifyInviteBetaLiveAttestation: (value: string, signature: string) => (
    value === JSON.stringify(betaReceipt()) && signature === BETA_RECEIPT_SIGNATURE
  ),
  expectedInviteBetaOperationsKeyId: BETA_OPERATIONS_KEY_ID,
  verifyInviteBetaOperationsAttestation: (value: string, signature: string) => (
    value === JSON.stringify(betaOperations()) && signature === BETA_OPERATIONS_SIGNATURE
  ),
};

describe('release build binding', () => {
  it('emits an explicit local-demo marker without backend configuration', () => {
    expect(buildReleaseDescriptor({})).toEqual({
      format: 'rv-web-release/1',
      commit: null,
      product: 'Binance Futures Review Web',
      mode: 'local-demo',
      backendProjectRef: null,
      appOrigin: null,
      liveGateReceiptSha256: null,
      operationsAttestation: null,
    });
  });

  it('binds a production release to one commit, backend project and dedicated origin', () => {
    expect(buildReleaseDescriptor(production(), verification)).toEqual({
      format: 'rv-web-release/1',
      commit: SHA,
      product: 'Binance Futures Review Web',
      mode: 'production-vault',
      backendProjectRef: REF,
      appOrigin: 'https://binance-futures-review.vercel.app',
      liveGateReceiptSha256: RECEIPT_SHA,
      operationsAttestation: {
        keyId: OPERATIONS_KEY_ID,
        witnessedAt: '2026-08-28T13:55:00.000Z',
        evidenceBundleSha256: '7'.repeat(64),
        attestationSha256: OPERATIONS_SHA,
      },
    });
  });

  it('binds invite-beta to the one canonical origin and its independent evidence chain', () => {
    expect(buildReleaseDescriptor(inviteBeta(), betaVerification)).toEqual({
      format: 'rv-web-release/1',
      commit: SHA,
      product: 'Binance Futures Review Web',
      mode: 'invite-beta',
      backendProjectRef: REF,
      appOrigin: BETA_ORIGIN,
      liveGateReceiptSha256: BETA_RECEIPT_SHA,
      operationsAttestation: {
        keyId: BETA_OPERATIONS_KEY_ID,
        witnessedAt: '2026-08-28T13:55:00.000Z',
        evidenceBundleSha256: '7'.repeat(64),
        attestationSha256: BETA_OPERATIONS_SHA,
      },
    });
  });

  it.each([
    [{ VITE_APP_ORIGIN: 'https://binance-futures-review.vercel.app' }, /canonical origin/],
    [{ VITE_APP_ORIGIN: `${BETA_ORIGIN}/beta` }, /origin/],
    [{ RV_INVITE_BETA_LIVE_RECEIPT: encode(betaReceipt({ sourceCommit: 'b'.repeat(40) })) }, /当前构建提交/],
    [{ RV_INVITE_BETA_LIVE_RECEIPT: encode(betaReceipt({ backendContractSha256: '3'.repeat(64) })) }, /backend contract/],
    [{ RV_INVITE_BETA_LIVE_RECEIPT: encode(betaReceipt({ checks: BETA_CHECKS.slice(0, -1) })) }, /六项现场检查/],
    [{ RV_INVITE_BETA_LIVE_SIGNATURE: '' }, /Beta live Ed25519/],
    [{ RV_INVITE_BETA_OPERATIONS_ATTESTATION: '' }, /Beta operations/],
    [{ RV_INVITE_BETA_OPERATIONS_SIGNATURE: '' }, /Beta operations Ed25519/],
  ])('rejects an unsafe invite-beta build: %o', (overrides, message) => {
    expect(() => buildReleaseDescriptor(inviteBeta(overrides), betaVerification)).toThrow(message);
  });

  it('does not accept production-vault evidence or unconfigured Beta proof keys', () => {
    expect(() => buildReleaseDescriptor({
      ...inviteBeta({
        RV_INVITE_BETA_LIVE_RECEIPT: '',
        RV_INVITE_BETA_LIVE_SIGNATURE: '',
        RV_INVITE_BETA_OPERATIONS_ATTESTATION: '',
        RV_INVITE_BETA_OPERATIONS_SIGNATURE: '',
      }),
      ...production(),
      VITE_BACKEND_MODE: 'invite-beta',
      VITE_APP_ORIGIN: BETA_ORIGIN,
    }, betaVerification)).toThrow(/Beta live/);
    expect(() => buildReleaseDescriptor(inviteBeta(), {})).toThrow(/Beta.*公钥|Beta.*摘要/);
  });

  it('uses the Vercel provider SHA as authoritative when VITE_BUILD_SHA is absent', () => {
    expect(buildReleaseDescriptor(production({ VITE_BUILD_SHA: '' }), verification).commit).toBe(SHA);
  });

  it.each([
    [{ VERCEL_GIT_COMMIT_SHA: '' }, /VERCEL_GIT_COMMIT_SHA/],
    [{ VITE_BUILD_SHA: 'short' }, /不一致/],
    [{ VITE_EXPECTED_SUPABASE_PROJECT_REF: 'wrong' }, /20 位/],
    [{ VITE_SUPABASE_URL: 'https://otherprojectref123.supabase.co' }, /不一致/],
    [{ VITE_APP_ORIGIN: 'https://player1314520.github.io' }, /github\.io/],
    [{ VITE_APP_ORIGIN: 'https://example.com/path' }, /origin/],
    [{ VITE_SUPABASE_PUBLISHABLE_KEY: `sb_secret_${'A'.repeat(24)}` }, /service_role|管理密钥/],
    [{ VITE_PRODUCTION_LIVE_GATE_PROJECT_REF: 'z'.repeat(20) }, /live gate project ref/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: '' }, /canonical base64url/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ sourceCommit: 'b'.repeat(40) }) }, /当前构建提交/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ projectRef: 'z'.repeat(20) }) }, /控制面证据绑定/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ appOrigin: 'https://wrong.example' }) }, /控制面证据绑定/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ completedAt: '2026-08-26T00:00:00.000Z' }) }, /已过期/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ format: 'rv-production-live-gate-receipt/3' }) }, /内容无效/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ freshOtpSessions: 1 }) }, /内容无效/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ manualReleaseBlockers: 'complete' }) }, /内容无效/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ controlPlane: { ...(receipt().controlPlane as object), customSmtp: { configured: false } } }) }, /邮件控制面/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ controlPlane: { ...(receipt().controlPlane as object), trafficControl: { ...(receipt().controlPlane as { trafficControl: object }).trafficControl, publicTableDmlAndSelectDenied: false } } }) }, /流量控制/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ completedAt: '2026-08-28T14:01:00.000Z' }) }, /控制面证据与 live gate/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ cleanup: 'not-cleaned' }) }, /内容无效/],
    [{ RV_PRODUCTION_LIVE_GATE_SIGNATURE: '' }, /Ed25519/],
    [{ RV_PRODUCTION_LIVE_GATE_SIGNATURE: 'short' }, /Ed25519/],
    [{ RV_PRODUCTION_LIVE_GATE_SIGNATURE: 'B'.repeat(86) }, /签名无效/],
    [{ RV_PRODUCTION_LIVE_GATE_RECEIPT_SHA: RECEIPT_SHA }, /SHA-only/],
    [{ RV_PRODUCTION_OPERATIONS_ATTESTATION: '' }, /运营证明/],
    [{ RV_PRODUCTION_OPERATIONS_SIGNATURE: '' }, /运营 Ed25519/],
    [{ RV_PRODUCTION_OPERATIONS_SIGNATURE: 'D'.repeat(86) }, /运营 Ed25519 签名无效/],
  ])('rejects an unbound or unsafe production build: %o', (overrides, message) => {
    expect(() => buildReleaseDescriptor(production(overrides), verification)).toThrow(message);
  });

  it('rejects a receipt whose protocol/migration digest differs from the build source', () => {
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ contractSha256: '9'.repeat(64) }),
    }), verification)).toThrow(/协议与迁移源码/);
  });

  it('rejects a valid-looking receipt under a wrong fixed key contract', () => {
    expect(() => buildReleaseDescriptor(production(), {
      ...verification,
      expectedAttestationKeyId: 'rv-production-other-key',
    })).toThrow(/固定证明公钥/);
    expect(() => buildReleaseDescriptor(production(), {
      ...verification,
      verifyReceiptAttestation: () => false,
    })).toThrow(/签名无效/);
  });

  it('rejects a structurally valid canonical receipt whose signed content was changed', () => {
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_LIVE_GATE_RECEIPT: encodedReceipt({ evidenceSha256: '9'.repeat(64) }),
    }), verification)).toThrow(/签名无效/);
  });

  it.each([
    [{ format: 'rv-production-operations-attestation/2' }, /发布阻断项/],
    [{ controlledInboxOtp: { slots: [] } }, /OTP/],
    [{ trafficControl: {
      ...operationsAttestation().trafficControl,
      tokenBuckets: [
        { ...operationsAttestation().trafficControl.tokenBuckets[0], capacity: 999 },
        ...operationsAttestation().trafficControl.tokenBuckets.slice(1),
      ],
    } }, /精确策略/],
    [{ trafficControl: {
      ...operationsAttestation().trafficControl,
      semaphore: { ...operationsAttestation().trafficControl.semaphore, scope: 'exact-production-project' },
    } }, /精确策略/],
    [{ costPolicy: { ...operationsAttestation().costPolicy, overageBilling: true } }, /精确策略/],
    [{ monitoring: { checks: [], latestSuccessAt: '2026-08-28T13:49:00.000Z' } }, /发布阻断项/],
    [{ evidenceBundleSha256: 'not-a-digest' }, /发布阻断项/],
  ])('rejects incomplete or legacy independent operations evidence: %o', (operationsOverrides, message) => {
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_OPERATIONS_ATTESTATION: encodedOperations(operationsOverrides),
    }), verification)).toThrow(message);
  });

  it('rejects a valid-shaped operations attestation forged without the protected operator key', () => {
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_OPERATIONS_ATTESTATION: encodedOperations({ evidenceBundleSha256: '8'.repeat(64) }),
    }), verification)).toThrow(/运营 Ed25519 签名无效/);
  });

  it.each([
    ['identity commitment', (slots: ReturnType<typeof operationsAttestation>['controlledInboxOtp']['slots']) => [slots[0], { ...slots[1], inboxIdentityCommitment: slots[0].inboxIdentityCommitment }]],
    ['protected observation', (slots: ReturnType<typeof operationsAttestation>['controlledInboxOtp']['slots']) => [slots[0], { ...slots[1], protectedRecordSha256: slots[0].protectedRecordSha256 }]],
  ])('rejects duplicate inbox %s even when the signed structure is otherwise canonical', (_label, mutate) => {
    const slots = operationsAttestation().controlledInboxOtp.slots;
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_OPERATIONS_ATTESTATION: encodedOperations({
        controlledInboxOtp: { slots: mutate(slots) },
      }),
    }), verification)).toThrow(/两个独立受保护邮箱身份/);
  });

  it('does not accept ordinary Vite self-reported operations flags', () => {
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_OPERATIONS_ATTESTATION: '',
      VITE_RATE_LIMITS_OK: '1',
      VITE_BILLING_ALERTS_OK: '1',
      VITE_MONITORING_OK: '1',
      VITE_TWO_INBOX_OTP_OK: '1',
    }), verification)).toThrow(/运营证明/);
  });

  it('rejects a structurally valid v3 receipt once it is more than two hours old', () => {
    const old = structuredClone(receipt());
    old.completedAt = '2026-08-28T11:00:00.000Z';
    old.controlCollectedAt = '2026-08-28T10:55:00.000Z';
    old.controlPlane.collectedAt = old.controlCollectedAt;
    old.controlPlane.cron.jobs[0].latestSuccessAt = '2026-08-28T10:50:00.000Z';
    old.controlPlane.cron.jobs[0].latestFailureAt = '2026-08-28T09:00:00.000Z';
    old.controlPlane.cron.jobs[1].latestSuccessAt = '2026-08-27T10:55:00.000Z';
    const encoded = btoa(JSON.stringify(old)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_LIVE_GATE_RECEIPT: encoded,
    }), verification)).toThrow(/已过期/);
  });

  it('rejects nested v3 control-plane fields that are untyped or unknown', () => {
    const unsafe = structuredClone(receipt());
    unsafe.controlPlane.auth.refreshTokenRotationEnabled = 'true' as unknown as true;
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_LIVE_GATE_RECEIPT: btoa(JSON.stringify(unsafe))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    }), verification)).toThrow(/Auth 证据/);

    const unknown = structuredClone(receipt()) as ReturnType<typeof receipt> & { unexpected?: boolean };
    unknown.unexpected = true;
    expect(() => buildReleaseDescriptor(production({
      RV_PRODUCTION_LIVE_GATE_RECEIPT: btoa(JSON.stringify(unknown))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    }), verification)).toThrow(/字段不完整/);
  });

  it('does not allow a real backend to hide behind a local-demo marker', () => {
    expect(() => buildReleaseDescriptor({
      VITE_SUPABASE_URL: `https://${REF}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    })).toThrow(ReleaseConfigError);
  });
});
