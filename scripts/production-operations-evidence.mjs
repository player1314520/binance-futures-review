import crypto from 'node:crypto';

export const PRODUCTION_OPERATIONS_EVIDENCE_FORMAT = 'rv-production-operations-evidence/2';
export const PRODUCTION_OPERATIONS_ATTESTATION_FORMAT = 'rv-production-operations-attestation/3';
export const PRODUCTION_OPERATIONS_EVIDENCE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
export const PRODUCTION_OPERATIONS_TRAFFIC_CONTROL = Object.freeze({
  accountingBoundary: 'postgres-transaction-commit',
  failedStatementConsumption: 'rolled-back',
  knownStatusFairness: 'known-capability-isolated-from-unknown-global',
  tokenBuckets: Object.freeze([
    Object.freeze({
      scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256',
      capacity: 120, refillTokens: 120, refillPeriodSeconds: 60,
    }),
    Object.freeze({
      scope: 'vault', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256',
      capacity: 120, refillTokens: 120, refillPeriodSeconds: 60,
    }),
    Object.freeze({
      scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-subject-sha256',
      capacity: 10, refillTokens: 10, refillPeriodSeconds: 60,
    }),
    Object.freeze({
      scope: 'destructive', enforcement: 'postgres-atomic-token-bucket', keyKind: 'verified-auth-session-sha256',
      capacity: 10, refillTokens: 10, refillPeriodSeconds: 60,
    }),
    Object.freeze({
      scope: 'deletion-status', enforcement: 'postgres-atomic-token-bucket', keyKind: 'recovery-capability-hmac-sha256',
      capacity: 10, refillTokens: 10, refillPeriodSeconds: 60,
    }),
    Object.freeze({
      scope: 'deletion-status-global', enforcement: 'postgres-atomic-token-bucket', keyKind: 'global-fixed-sha256',
      capacity: 60, refillTokens: 60, refillPeriodSeconds: 60,
    }),
  ]),
  authOtp: Object.freeze({
    scope: 'auth-otp-send-and-verify',
    enforcement: 'supabase-auth-fixed-window',
    keyKind: 'project',
    windowSeconds: 3600,
    maxRequests: 6,
  }),
  semaphore: Object.freeze({
    scope: 'user-facing-vault-database-transactions',
    enforcement: 'postgres-transaction-advisory-lock-semaphore',
    permits: 10,
    saturationResult: 'retryable-reject',
    trustedClientIp: false,
    edgeInvocationLimit: false,
  }),
});
export const PRODUCTION_OPERATIONS_COST_POLICY = Object.freeze({
  provider: 'supabase',
  plan: 'free',
  currency: 'USD',
  approvedRecurringCostMinor: 0,
  overageBilling: false,
  monetarySpendCapAvailable: false,
  monetaryAlertAvailable: false,
  paidAddons: false,
  quotaExhaustionBehavior: 'restrict-or-pause',
});
export const PRODUCTION_OPERATIONS_MONITORING_CHECKS = Object.freeze([
  'auth-otp-delivery',
  'free-plan-entitlement-and-no-paid-addons',
  'free-plan-quota-state',
  'cron-maintenance',
  'cron-retention',
  'edge-delete-health',
  'edge-publish-health',
  'db-admission-control-health',
]);
const SOURCE_TYPES = Object.freeze([
  'database-traffic-control-proof',
  'free-plan-policy',
  'monitoring-run',
  'controlled-inbox-observation',
]);
const INBOX_IDENTITY_DOMAIN = 'rv-production-inbox-identity/v1\0';

function decodeProtectedHmacKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyBase64)) {
    fail('IDENTITY', 'protected inbox HMAC key must be canonical base64');
  }
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length < 32 || key.toString('base64') !== keyBase64) {
    fail('IDENTITY', 'protected inbox HMAC key must contain at least 32 random bytes');
  }
  return key;
}

export function computeInboxIdentityCommitment(canonicalIdentity, keyBase64) {
  if (
    typeof canonicalIdentity !== 'string'
    || canonicalIdentity.length < 3
    || canonicalIdentity.length > 254
    || canonicalIdentity !== canonicalIdentity.trim().toLowerCase()
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(canonicalIdentity)
  ) fail('IDENTITY', 'inbox identity must be a canonical lowercase address');
  const digest = crypto.createHmac('sha256', decodeProtectedHmacKey(keyBase64))
    .update(INBOX_IDENTITY_DOMAIN, 'utf8')
    .update(canonicalIdentity, 'utf8')
    .digest('hex');
  return `hmac-sha256:v1:${digest}`;
}

export function verifyInboxIdentityCommitments(slots, identities, keyBase64) {
  if (!Array.isArray(slots) || slots.length !== 2 || !Array.isArray(identities) || identities.length !== 2) {
    fail('IDENTITY', 'exactly two inbox identities are required');
  }
  if (identities[0] === identities[1]) fail('IDENTITY', 'canonical inbox identities must be distinct');
  for (let index = 0; index < 2; index += 1) {
    if (slots[index]?.inboxIdentityCommitment !== computeInboxIdentityCommitment(identities[index], keyBase64)) {
      fail('IDENTITY', 'protected inbox identity commitment mismatch');
    }
  }
  return true;
}

export class ProductionOperationsEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionOperationsEvidenceError';
    this.code = code;
  }
}

function fail(code, message) { throw new ProductionOperationsEvidenceError(code, message); }
function sha256Canonical(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SCHEMA', `${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail('SCHEMA', `${label} has unknown or missing fields`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 64) fail('SCHEMA', `${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('SCHEMA', `${label} is invalid`);
  return parsed;
}
function boundTime(value, label, now, maxAgeMs) {
  const parsed = timestamp(value, label);
  if (parsed > now + CLOCK_SKEW_MS || parsed < now - maxAgeMs) fail('STALE', `${label} is stale or future`);
  return parsed;
}

export function canonicalProductionOperationsEvidence(value) {
  return JSON.stringify({
    format: value.format,
    projectRef: value.projectRef,
    appOrigin: value.appOrigin,
    sourceCommit: value.sourceCommit,
    liveReceiptSha256: value.liveReceiptSha256,
    collectedAt: value.collectedAt,
    sources: value.sources,
    trafficControl: value.trafficControl,
    costPolicy: value.costPolicy,
    monitoring: value.monitoring,
    controlledInboxOtp: value.controlledInboxOtp,
  });
}

export function validateProductionOperationsEvidence(raw, {
  projectRef,
  appOrigin,
  sourceCommit,
  liveReceiptSha256,
  now = Date.now(),
  maxAgeMs = PRODUCTION_OPERATIONS_EVIDENCE_MAX_AGE_MS,
} = {}) {
  const row = exact(raw, [
    'appOrigin', 'collectedAt', 'controlledInboxOtp', 'costPolicy',
    'format', 'liveReceiptSha256', 'monitoring', 'projectRef', 'trafficControl',
    'sourceCommit', 'sources',
  ], 'operations evidence');
  if (
    row.format !== PRODUCTION_OPERATIONS_EVIDENCE_FORMAT
    || row.projectRef !== projectRef
    || row.appOrigin !== appOrigin
    || row.sourceCommit !== sourceCommit
    || row.liveReceiptSha256 !== liveReceiptSha256
    || !/^[a-z0-9]{20}$/.test(row.projectRef)
    || !/^[0-9a-f]{40}$/.test(row.sourceCommit)
    || !/^[0-9a-f]{64}$/.test(row.liveReceiptSha256)
  ) fail('BINDING', 'operations evidence release binding is invalid');
  const collected = boundTime(row.collectedAt, 'operations collectedAt', now, maxAgeMs);

  if (!Array.isArray(row.sources) || row.sources.length !== SOURCE_TYPES.length) {
    fail('SCHEMA', 'operations evidence sources are incomplete');
  }
  const sources = row.sources.map((candidate, index) => {
    const source = exact(candidate, ['collectedAt', 'recordSha256', 'type'], 'operations evidence source');
    if (source.type !== SOURCE_TYPES[index]) fail('SCHEMA', 'operations evidence source type/order is invalid');
    const sourceTime = boundTime(source.collectedAt, 'source collectedAt', now, maxAgeMs);
    if (sourceTime > collected + CLOCK_SKEW_MS) fail('SCHEMA', 'source evidence is newer than bundle collection');
    if (!/^[0-9a-f]{64}$/.test(source.recordSha256)) fail('SCHEMA', 'source record digest is invalid');
    return Object.freeze({ type: source.type, collectedAt: source.collectedAt, recordSha256: source.recordSha256 });
  });

  const trafficControlRaw = exact(
    row.trafficControl,
    [
      'accountingBoundary', 'authOtp', 'failedStatementConsumption',
      'knownStatusFairness', 'semaphore', 'tokenBuckets',
    ],
    'traffic-control evidence',
  );
  for (const key of ['accountingBoundary', 'failedStatementConsumption', 'knownStatusFairness']) {
    if (trafficControlRaw[key] !== PRODUCTION_OPERATIONS_TRAFFIC_CONTROL[key]) {
      fail('POLICY', 'traffic-control transaction semantics differ from the reviewed exact policy');
    }
  }
  if (
    !Array.isArray(trafficControlRaw.tokenBuckets)
    || trafficControlRaw.tokenBuckets.length !== PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.tokenBuckets.length
  ) fail('SCHEMA', 'traffic-control token buckets are incomplete');
  const tokenBuckets = trafficControlRaw.tokenBuckets.map((candidate, index) => {
    const item = exact(candidate, [
      'capacity', 'enforcement', 'keyKind', 'refillPeriodSeconds', 'refillTokens', 'scope',
    ], 'traffic-control token bucket');
    const expected = PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.tokenBuckets[index];
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (item[key] !== expectedValue) {
        fail('POLICY', 'traffic-control token bucket differs from the reviewed exact policy');
      }
    }
    return expected;
  });
  const authOtp = exact(trafficControlRaw.authOtp, [
    'enforcement', 'keyKind', 'maxRequests', 'scope', 'windowSeconds',
  ], 'Auth OTP traffic control');
  for (const [key, expectedValue] of Object.entries(PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.authOtp)) {
    if (authOtp[key] !== expectedValue) fail('POLICY', 'Auth OTP traffic control differs from the reviewed exact policy');
  }
  const semaphore = exact(trafficControlRaw.semaphore, [
    'edgeInvocationLimit', 'enforcement', 'permits', 'saturationResult', 'scope', 'trustedClientIp',
  ], 'database semaphore evidence');
  for (const [key, expectedValue] of Object.entries(PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.semaphore)) {
    if (semaphore[key] !== expectedValue) fail('POLICY', 'database semaphore evidence differs from the reviewed exact policy');
  }
  const trafficControl = Object.freeze({
    accountingBoundary: PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.accountingBoundary,
    failedStatementConsumption: PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.failedStatementConsumption,
    knownStatusFairness: PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.knownStatusFairness,
    tokenBuckets: Object.freeze(tokenBuckets),
    authOtp: PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.authOtp,
    semaphore: PRODUCTION_OPERATIONS_TRAFFIC_CONTROL.semaphore,
  });

  const costPolicy = exact(row.costPolicy, [
    'approvedRecurringCostMinor', 'currency', 'monetaryAlertAvailable',
    'monetarySpendCapAvailable', 'overageBilling', 'paidAddons', 'plan',
    'provider', 'quotaExhaustionBehavior',
  ], 'Free-plan cost policy');
  for (const [key, expectedValue] of Object.entries(PRODUCTION_OPERATIONS_COST_POLICY)) {
    if (costPolicy[key] !== expectedValue) fail('POLICY', 'Free-plan cost policy differs from the reviewed exact policy');
  }

  const monitoring = exact(row.monitoring, ['checks', 'latestSuccessAt'], 'monitoring evidence');
  if (JSON.stringify(monitoring.checks) !== JSON.stringify(PRODUCTION_OPERATIONS_MONITORING_CHECKS)) {
    fail('POLICY', 'monitoring checklist is incomplete');
  }
  const monitoringSuccess = boundTime(monitoring.latestSuccessAt, 'monitoring latest success', now, 15 * 60 * 1000);
  if (monitoringSuccess > collected + CLOCK_SKEW_MS) fail('SCHEMA', 'monitoring success is newer than bundle collection');

  const inbox = exact(row.controlledInboxOtp, ['slots'], 'controlled inbox evidence');
  if (!Array.isArray(inbox.slots) || inbox.slots.length !== 2) fail('SCHEMA', 'two inbox slots are required');
  const slots = inbox.slots.map((candidate, index) => {
    const slot = exact(candidate, [
      'consumedAt', 'inboxIdentityCommitment', 'protectedRecordSha256', 'receivedAt', 'recordSha256', 'slot', 'sourceType',
    ], 'inbox slot evidence');
    const expectedSlot = index === 0 ? 'A' : 'B';
    if (
      slot.slot !== expectedSlot
      || slot.sourceType !== 'controlled-inbox-observation'
      || !/^hmac-sha256:v1:[0-9a-f]{64}$/.test(slot.inboxIdentityCommitment)
      || !/^[0-9a-f]{64}$/.test(slot.protectedRecordSha256)
      || !/^[0-9a-f]{64}$/.test(slot.recordSha256)
    ) {
      fail('SCHEMA', 'inbox slots must be distinct PII-free A/B observations');
    }
    const received = boundTime(slot.receivedAt, 'OTP receivedAt', now, maxAgeMs);
    const consumed = boundTime(slot.consumedAt, 'OTP consumedAt', now, maxAgeMs);
    if (consumed < received || consumed - received > 15 * 60 * 1000 || consumed > collected + CLOCK_SKEW_MS) {
      fail('POLICY', 'OTP receipt/consumption evidence is inconsistent');
    }
    const normalizedSlot = {
      slot: expectedSlot,
      sourceType: 'controlled-inbox-observation',
      receivedAt: slot.receivedAt,
      consumedAt: slot.consumedAt,
      inboxIdentityCommitment: slot.inboxIdentityCommitment,
      protectedRecordSha256: slot.protectedRecordSha256,
    };
    if (sha256Canonical(normalizedSlot) !== slot.recordSha256) {
      fail('DIGEST', 'OTP slot digest does not match its normalized protected-record manifest');
    }
    return Object.freeze({ ...normalizedSlot, recordSha256: slot.recordSha256 });
  });
  if (
    slots[0].inboxIdentityCommitment === slots[1].inboxIdentityCommitment
    || slots[0].protectedRecordSha256 === slots[1].protectedRecordSha256
  ) {
    fail('POLICY', 'inbox slots must bind two unique protected inbox identities and observations');
  }

  const sourceRecords = [
    { trafficControl },
    { costPolicy: PRODUCTION_OPERATIONS_COST_POLICY },
    { monitoring: { checks: PRODUCTION_OPERATIONS_MONITORING_CHECKS, latestSuccessAt: new Date(monitoringSuccess).toISOString() } },
    { controlledInboxOtp: { slots } },
  ];
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index].recordSha256 !== sha256Canonical(sourceRecords[index])) {
      fail('DIGEST', 'source digest does not match its normalized configuration record');
    }
  }

  return Object.freeze({
    format: PRODUCTION_OPERATIONS_EVIDENCE_FORMAT,
    projectRef,
    appOrigin,
    sourceCommit,
    liveReceiptSha256,
    collectedAt: new Date(collected).toISOString(),
    sources: Object.freeze(sources),
    trafficControl,
    costPolicy: PRODUCTION_OPERATIONS_COST_POLICY,
    monitoring: Object.freeze({
      checks: PRODUCTION_OPERATIONS_MONITORING_CHECKS,
      latestSuccessAt: new Date(monitoringSuccess).toISOString(),
    }),
    controlledInboxOtp: Object.freeze({ slots: Object.freeze(slots) }),
  });
}

export function parseCanonicalProductionOperationsEvidence(text, options) {
  if (typeof text !== 'string' || text.length < 512 || text.length > 32_768) fail('SCHEMA', 'operations evidence size is invalid');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('SCHEMA', 'operations evidence is not JSON'); }
  const normalized = validateProductionOperationsEvidence(raw, options);
  if (canonicalProductionOperationsEvidence(normalized) !== text) fail('CANONICAL', 'operations evidence is not canonical JSON');
  return normalized;
}

export function productionOperationsEvidenceSha256(canonicalText) {
  return crypto.createHash('sha256').update(canonicalText, 'utf8').digest('hex');
}

export function createCanonicalProductionOperationsEvidence(raw, options) {
  return canonicalProductionOperationsEvidence(validateProductionOperationsEvidence(raw, options));
}

export function createCanonicalProductionOperationsAttestation(evidence, {
  keyId,
  witnessedAt,
  canonicalEvidence,
}) {
  if (!/^rv-operations-[a-z0-9-]{8,80}$/.test(keyId ?? '')) fail('ATTESTATION', 'operations key id is invalid');
  timestamp(witnessedAt, 'operations witnessedAt');
  if (canonicalProductionOperationsEvidence(evidence) !== canonicalEvidence) {
    fail('ATTESTATION', 'operations signer did not receive the canonical evidence bytes');
  }
  return JSON.stringify({
    format: PRODUCTION_OPERATIONS_ATTESTATION_FORMAT,
    keyId,
    projectRef: evidence.projectRef,
    appOrigin: evidence.appOrigin,
    sourceCommit: evidence.sourceCommit,
    liveReceiptSha256: evidence.liveReceiptSha256,
    witnessedAt,
    operatorSeparation: 'independent-from-live-gate-signer',
    evidenceBundleSha256: productionOperationsEvidenceSha256(canonicalEvidence),
    evidenceCollectedAt: evidence.collectedAt,
    trafficControl: evidence.trafficControl,
    costPolicy: evidence.costPolicy,
    monitoring: evidence.monitoring,
    controlledInboxOtp: evidence.controlledInboxOtp,
  });
}
