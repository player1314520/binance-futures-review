import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  PRODUCTION_OPERATIONS_MONITORING_CHECKS,
  PRODUCTION_OPERATIONS_COST_POLICY,
  PRODUCTION_OPERATIONS_TRAFFIC_CONTROL,
  createCanonicalProductionOperationsEvidence,
  createCanonicalProductionOperationsAttestation,
  computeInboxIdentityCommitment,
  parseCanonicalProductionOperationsEvidence,
  productionOperationsEvidenceSha256,
  verifyInboxIdentityCommitments,
} from '../scripts/production-operations-evidence.mjs';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');
const OPTIONS = Object.freeze({
  projectRef: 'abcdefghijklmnopqrst',
  appOrigin: 'https://binance-futures-review-web.vercel.app',
  sourceCommit: 'a'.repeat(40),
  liveReceiptSha256: 'b'.repeat(64),
  now: NOW,
});
const HMAC_KEY = Buffer.alloc(32, 7).toString('base64');

function evidence(overrides = {}) {
  const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const trafficControl = JSON.parse(JSON.stringify(PRODUCTION_OPERATIONS_TRAFFIC_CONTROL));
  const costPolicy = { ...PRODUCTION_OPERATIONS_COST_POLICY };
  const monitoring = {
    checks: [...PRODUCTION_OPERATIONS_MONITORING_CHECKS],
    latestSuccessAt: '2026-08-29T11:57:00.000Z',
  };
  const slotA = {
    slot: 'A', sourceType: 'controlled-inbox-observation',
    receivedAt: '2026-08-29T11:50:00.000Z', consumedAt: '2026-08-29T11:51:00.000Z',
    inboxIdentityCommitment: computeInboxIdentityCommitment('slot-a@example.test', HMAC_KEY),
    protectedRecordSha256: '1'.repeat(64),
  };
  const slotB = {
    slot: 'B', sourceType: 'controlled-inbox-observation',
    receivedAt: '2026-08-29T11:52:00.000Z', consumedAt: '2026-08-29T11:53:00.000Z',
    inboxIdentityCommitment: computeInboxIdentityCommitment('slot-b@example.test', HMAC_KEY),
    protectedRecordSha256: '2'.repeat(64),
  };
  const controlledInboxOtp = { slots: [
    { ...slotA, recordSha256: sha(slotA) },
    { ...slotB, recordSha256: sha(slotB) },
  ] };
  const sources = [
    { type: 'database-traffic-control-proof', collectedAt: '2026-08-29T11:55:00.000Z', recordSha256: sha({ trafficControl }) },
    { type: 'free-plan-policy', collectedAt: '2026-08-29T11:54:00.000Z', recordSha256: sha({ costPolicy }) },
    { type: 'monitoring-run', collectedAt: '2026-08-29T11:57:00.000Z', recordSha256: sha({ monitoring }) },
    { type: 'controlled-inbox-observation', collectedAt: '2026-08-29T11:56:00.000Z', recordSha256: sha({ controlledInboxOtp }) },
  ];
  return {
    format: 'rv-production-operations-evidence/2',
    projectRef: OPTIONS.projectRef,
    appOrigin: OPTIONS.appOrigin,
    sourceCommit: OPTIONS.sourceCommit,
    liveReceiptSha256: OPTIONS.liveReceiptSha256,
    collectedAt: '2026-08-29T11:58:00.000Z',
    sources,
    trafficControl,
    costPolicy,
    monitoring,
    controlledInboxOtp,
    ...overrides,
  };
}

test('operations evidence generator creates one strict canonical PII-free bundle and digest', () => {
  const canonical = createCanonicalProductionOperationsEvidence(evidence(), OPTIONS);
  const parsed = parseCanonicalProductionOperationsEvidence(canonical, OPTIONS);
  assert.equal(parsed.projectRef, OPTIONS.projectRef);
  assert.match(productionOperationsEvidenceSha256(canonical), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(canonical, /@|emailAddress|otpCode|recipient|accessToken|refreshToken/i);
  const attestationText = createCanonicalProductionOperationsAttestation(parsed, {
    keyId: 'rv-operations-protected-test-key',
    witnessedAt: '2026-08-29T12:00:00.000Z',
    canonicalEvidence: canonical,
  });
  const attestation = JSON.parse(attestationText);
  assert.equal(attestation.evidenceBundleSha256, productionOperationsEvidenceSha256(canonical));
  assert.equal(attestation.format, 'rv-production-operations-attestation/3');
  assert.deepEqual(attestation.trafficControl, parsed.trafficControl);
  assert.deepEqual(attestation.costPolicy, parsed.costPolicy);
  assert.throws(() => createCanonicalProductionOperationsAttestation(parsed, {
    keyId: 'rv-operations-protected-test-key',
    witnessedAt: '2026-08-29T12:00:00.000Z',
    canonicalEvidence: `${canonical}\n`,
  }), /canonical evidence bytes/);
});

test('protected signer helper requires keyed commitments for two distinct canonical identities', () => {
  const row = evidence();
  assert.equal(verifyInboxIdentityCommitments(
    row.controlledInboxOtp.slots,
    ['slot-a@example.test', 'slot-b@example.test'],
    HMAC_KEY,
  ), true);
  const mislabeledPlainSha = evidence();
  mislabeledPlainSha.controlledInboxOtp.slots[0].inboxIdentityCommitment = `hmac-sha256:v1:${crypto.createHash('sha256').update('slot-a@example.test').digest('hex')}`;
  assert.throws(() => verifyInboxIdentityCommitments(
    mislabeledPlainSha.controlledInboxOtp.slots,
    ['slot-a@example.test', 'slot-b@example.test'],
    HMAC_KEY,
  ), /commitment mismatch/);
  assert.throws(() => verifyInboxIdentityCommitments(
    row.controlledInboxOtp.slots,
    ['slot-a@example.test', 'slot-a@example.test'],
    HMAC_KEY,
  ), /distinct/);
  assert.throws(() => computeInboxIdentityCommitment('Slot-A@example.test', HMAC_KEY), /canonical lowercase/);
  assert.throws(() => computeInboxIdentityCommitment('slot-a@example.test', Buffer.alloc(16).toString('base64')), /at least 32/);
});

test('operations evidence rejects unsafe policy values, stale records, wrong bindings and noncanonical JSON', () => {
  const unsafeLimit = evidence();
  unsafeLimit.trafficControl.tokenBuckets[0].capacity = 999;
  assert.throws(() => createCanonicalProductionOperationsEvidence(unsafeLimit, OPTIONS), /exact policy/);

  const fakeIpBoundary = evidence();
  fakeIpBoundary.trafficControl.tokenBuckets[5].keyKind = 'forwarded-client-ip';
  assert.throws(() => createCanonicalProductionOperationsEvidence(fakeIpBoundary, OPTIONS), /exact policy/);

  const fakeProjectConcurrency = evidence();
  fakeProjectConcurrency.trafficControl.semaphore.scope = 'exact-production-project';
  assert.throws(() => createCanonicalProductionOperationsEvidence(fakeProjectConcurrency, OPTIONS), /exact policy/);

  const falseAttemptAccounting = evidence();
  falseAttemptAccounting.trafficControl.failedStatementConsumption = 'persisted';
  assert.throws(() => createCanonicalProductionOperationsEvidence(falseAttemptAccounting, OPTIONS), /transaction semantics/);

  const unfairStatus = evidence();
  unfairStatus.trafficControl.knownStatusFairness = 'shared-global-bucket';
  assert.throws(() => createCanonicalProductionOperationsEvidence(unfairStatus, OPTIONS), /transaction semantics/);

  const paidOrOverage = evidence();
  paidOrOverage.costPolicy.overageBilling = true;
  assert.throws(() => createCanonicalProductionOperationsEvidence(paidOrOverage, OPTIONS), /Free-plan cost policy/);

  const legacy = evidence({ format: 'rv-production-operations-evidence/1' });
  assert.throws(() => createCanonicalProductionOperationsEvidence(legacy, OPTIONS), /binding/i);

  const unsafeInbox = evidence();
  unsafeInbox.controlledInboxOtp.slots[1].slot = 'A';
  assert.throws(() => createCanonicalProductionOperationsEvidence(unsafeInbox, OPTIONS), /distinct/);

  const forgedSource = evidence();
  forgedSource.sources[0].recordSha256 = 'f'.repeat(64);
  assert.throws(() => createCanonicalProductionOperationsEvidence(forgedSource, OPTIONS), /source digest/);

  const stale = evidence({ collectedAt: '2026-08-29T08:00:00.000Z' });
  assert.throws(() => createCanonicalProductionOperationsEvidence(stale, OPTIONS), /stale/);

  assert.throws(() => createCanonicalProductionOperationsEvidence(evidence(), {
    ...OPTIONS,
    projectRef: 'z'.repeat(20),
  }), /binding/);

  const canonical = createCanonicalProductionOperationsEvidence(evidence(), OPTIONS);
  assert.throws(() => parseCanonicalProductionOperationsEvidence(`${canonical}\n`, OPTIONS), /canonical/);
});

test('operations evidence rejects reused inbox identities and protected observations after full digest recomputation', () => {
  const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const recompute = (row) => {
    row.controlledInboxOtp.slots = row.controlledInboxOtp.slots.map((slot) => {
      const { recordSha256: _old, ...manifest } = slot;
      return { ...manifest, recordSha256: sha(manifest) };
    });
    row.sources[3].recordSha256 = sha({ controlledInboxOtp: row.controlledInboxOtp });
    return row;
  };

  const sameBoth = evidence();
  sameBoth.controlledInboxOtp.slots[1].protectedRecordSha256 = sameBoth.controlledInboxOtp.slots[0].protectedRecordSha256;
  sameBoth.controlledInboxOtp.slots[1].inboxIdentityCommitment = sameBoth.controlledInboxOtp.slots[0].inboxIdentityCommitment;
  assert.throws(() => createCanonicalProductionOperationsEvidence(recompute(sameBoth), OPTIONS), /unique protected inbox/);

  const sameRecord = evidence();
  sameRecord.controlledInboxOtp.slots[1].protectedRecordSha256 = sameRecord.controlledInboxOtp.slots[0].protectedRecordSha256;
  assert.throws(() => createCanonicalProductionOperationsEvidence(recompute(sameRecord), OPTIONS), /unique protected inbox/);

  const sameIdentity = evidence();
  sameIdentity.controlledInboxOtp.slots[1].inboxIdentityCommitment = sameIdentity.controlledInboxOtp.slots[0].inboxIdentityCommitment;
  assert.throws(() => createCanonicalProductionOperationsEvidence(recompute(sameIdentity), OPTIONS), /unique protected inbox/);
});
