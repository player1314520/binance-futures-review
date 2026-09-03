import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  applyDeletionJournal,
  buildSnapshotV2,
  createRecoveryTag,
  evaluatePublishReadiness,
  issueOwnerInviteState,
  claimOwnerInviteState,
  signManifestV2,
  validateRestoreGraph,
  verifyManifestEnvelope,
} from '../supabase/functions/restore-v2/core.mjs';

const OWNER_TAG = 'a'.repeat(64);

function fixtureRows() {
  return [
    {
      dataset: 'tenants',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      recordId: '10000000-0000-4000-8000-000000000001',
      payload: { status: 'ACTIVE', createdAt: '2026-08-31T00:00:00.000Z' },
    },
    {
      dataset: 'memberships',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      principalLineageId: '20000000-0000-4000-8000-000000000001',
      recordId: '20000000-0000-4000-8000-000000000001',
      payload: {
        memberRole: 'OWNER', status: 'ACTIVE', membershipVersion: 1,
        recoveryTagHash: OWNER_TAG,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    },
    {
      dataset: 'connections',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      connectionLineageId: '30000000-0000-4000-8000-000000000001',
      recordId: '30000000-0000-4000-8000-000000000001',
      payload: {
        provider: 'binance', providerScopeHash: 'b'.repeat(64),
        consentVersion: 'rv-binance-beta-consent/1', currentGeneration: 0,
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    },
    {
      dataset: 'generations',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      connectionLineageId: '30000000-0000-4000-8000-000000000001',
      recordId: '30500000-0000-4000-8000-000000000001',
      payload: {
        generation: 1, credentialVersion: 1,
        sourceJobIds: ['30600000-0000-4000-8000-000000000001'],
        coverage: {}, reconciliation: {}, capabilities: {},
        sourceRootSha256: '1'.repeat(64), sourceEventCount: 1,
        projectionSha256: '2'.repeat(64), tradeModelCount: 1,
        manifestSha256: 'f'.repeat(64), status: 'PUBLISHED',
        publishedAt: '2026-08-31T00:00:00.000Z',
      },
    },
    {
      dataset: 'trade_identities',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      connectionLineageId: '30000000-0000-4000-8000-000000000001',
      recordId: '31000000-0000-4000-8000-000000000001',
      payload: {
        tradeId: 't_0123456789abcdef', idProtocol: 'rv2-trade-id/1',
        sourceLineageSha256: 'd'.repeat(64), firstGeneration: 1,
        firstSeenAt: '2026-08-31T00:00:00.000Z',
      },
    },
    {
      dataset: 'trade_read_models',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      connectionLineageId: '30000000-0000-4000-8000-000000000001',
      recordId: '32000000-0000-4000-8000-000000000001',
      payload: {
        tradeId: 't_0123456789abcdef', generation: 1,
        modelProtocol: 'rv2-trade-read-model/1', payload: { symbol: 'BTCUSDT' },
        payloadSha256: 'e'.repeat(64), projectedAt: '2026-08-31T00:00:00.000Z',
      },
    },
    {
      dataset: 'reviews',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      connectionLineageId: '30000000-0000-4000-8000-000000000001',
      principalLineageId: '20000000-0000-4000-8000-000000000001',
      recordId: '40000000-0000-4000-8000-000000000001',
      payload: {
        tradeId: 't_0123456789abcdef', tradeGeneration: 1,
        sourceLineageSha256: 'd'.repeat(64),
        version: 1, payload: { note: 'discipline' },
        payloadSha256: 'c'.repeat(64),
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      },
    },
  ];
}

test('snapshot v2 binds exact order, content, tenant lineage and plaintext stream', () => {
  const first = buildSnapshotV2({
    snapshotId: '50000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-31T01:00:00.000Z',
    rows: fixtureRows(),
    externalJournalRoot: 'd'.repeat(64),
  });
  const reordered = buildSnapshotV2({
    snapshotId: '50000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-31T01:00:00.000Z',
    rows: [...fixtureRows()].reverse(),
    externalJournalRoot: 'd'.repeat(64),
  });
  assert.notEqual(first.manifest.orderedContentRoot, reordered.manifest.orderedContentRoot);
  assert.notEqual(first.manifest.plaintextStreamSha256, reordered.manifest.plaintextStreamSha256);
  assert.equal(first.manifest.tenantLineageRoot, reordered.manifest.tenantLineageRoot);
  assert.throws(() => validateRestoreGraph([
    ...fixtureRows().slice(0, 3),
    { ...fixtureRows()[3], payload: { ...fixtureRows()[3].payload, secretKey: 'nope' } },
  ]), /credential|forbidden/iu);
});

test('manifest v2 uses a domain-separated Ed25519 signature and v1 is legacy-untrusted', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const snapshot = buildSnapshotV2({
    snapshotId: '50000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-31T01:00:00.000Z',
    rows: fixtureRows(),
    externalJournalRoot: 'd'.repeat(64),
  });
  const envelope = signManifestV2(snapshot.manifest, {
    privateKey,
    keyId: 'restore-v2-key-1',
  });
  assert.equal(verifyManifestEnvelope(envelope, {
    publicKey,
    expectedKeyId: 'restore-v2-key-1',
  }).trust, 'VERIFIED_V2');
  assert.equal(verifyManifestEnvelope({
    format: 'review-workbench-beta-signed-manifest/1',
    manifest: {}, signature: 'x', algorithm: 'Ed25519', keyId: 'old',
  }).trust, 'LEGACY_UNTRUSTED');
  assert.throws(() => verifyManifestEnvelope({
    ...envelope,
    manifest: { ...envelope.manifest, orderedContentRoot: 'e'.repeat(64) },
  }, { publicKey, expectedKeyId: 'restore-v2-key-1' }), /signature|authentic/iu);
});

test('graph rejects dangling, cross-tenant and credential-bearing rows', () => {
  assert.throws(() => validateRestoreGraph(fixtureRows().filter(row => row.dataset !== 'connections')),
    /connection|dangling/iu);
  const crossTenant = fixtureRows();
  crossTenant[3] = {
    ...crossTenant[3],
    tenantLineageId: '10000000-0000-4000-8000-000000000099',
  };
  assert.throws(() => validateRestoreGraph(crossTenant), /tenant|cross/iu);
  const injected = fixtureRows();
  injected[2] = { ...injected[2], payload: { ...injected[2].payload, wrappedDek: 'x' } };
  assert.throws(() => validateRestoreGraph(injected), /credential|forbidden/iu);
});

test('personal beta restore rejects shared roles and a second membership in one tenant', () => {
  const member = {
    ...fixtureRows()[1],
    principalLineageId: '20000000-0000-4000-8000-000000000002',
    recordId: '20000000-0000-4000-8000-000000000002',
    payload: {
      ...fixtureRows()[1].payload,
      memberRole: 'MEMBER',
      recoveryTagHash: 'b'.repeat(64),
    },
  };
  assert.throws(() => validateRestoreGraph([...fixtureRows(), member]),
    /personal|membership|owner/iu);

  const secondOwner = {
    ...member,
    payload: { ...member.payload, memberRole: 'OWNER' },
  };
  assert.throws(() => validateRestoreGraph([...fixtureRows(), secondOwner]),
    /personal|membership|owner/iu);
});

test('external deletion journal removes a deleted tenant and prevents disaster resurrection', () => {
  const rows = fixtureRows();
  assert.throws(() => applyDeletionJournal(rows, {
    firstPassRoot: '1'.repeat(64), secondPassRoot: '2'.repeat(64),
    rangeStart: '2026-08-31T00:00:00.000Z', rangeEnd: '2026-08-31T02:00:00.000Z',
    events: [],
  }, { snapshotCreatedAt: '2026-08-31T01:00:00.000Z', restoreStartedAt: '2026-08-31T02:00:00.000Z' }), /two-pass|root/iu);
  const event = {
    eventId: '60000000-0000-4000-8000-000000000001',
    tenantLineageId: '10000000-0000-4000-8000-000000000001',
    operation: 'DELETE_ACCOUNT',
    committedAt: '2026-08-31T01:30:00.000Z',
  };
  const proof = {
    firstPassRoot: 'f'.repeat(64), secondPassRoot: 'f'.repeat(64),
    rangeStart: '2026-08-31T00:00:00.000Z', rangeEnd: '2026-08-31T02:00:00.000Z',
    events: [event],
  };
  const applied = applyDeletionJournal(rows, proof, {
    snapshotCreatedAt: '2026-08-31T01:00:00.000Z',
    restoreStartedAt: '2026-08-31T02:00:00.000Z',
  });
  assert.equal(applied.rows.length, 0);
  assert.match(applied.effectiveTenantLineageRoot, /^[0-9a-f]{64}$/u);
});

test('a tombstone added after claim changes the final effective lineage before publish', () => {
  const rows = fixtureRows();
  const base = {
    firstPassRoot: 'e'.repeat(64), secondPassRoot: 'e'.repeat(64),
    rangeStart: '2026-08-30T00:00:00.000Z', rangeEnd: '2026-08-31T01:05:00.000Z',
    events: [],
  };
  const claimed = applyDeletionJournal(rows, base, {
    snapshotCreatedAt: '2026-08-31T01:00:00.000Z',
    restoreStartedAt: '2026-08-31T01:05:00.000Z',
  });
  assert.equal(claimed.rows.length, rows.length);
  const final = applyDeletionJournal(rows, {
    ...base,
    rangeEnd: '2026-08-31T01:10:00.000Z',
    events: [{
      eventId: '60000000-0000-4000-8000-000000000002',
      tenantLineageId: '10000000-0000-4000-8000-000000000001',
      operation: 'DELETE_ACCOUNT',
      committedAt: '2026-08-31T01:07:00.000Z',
    }],
  }, {
    snapshotCreatedAt: '2026-08-31T01:00:00.000Z',
    restoreStartedAt: '2026-08-31T01:10:00.000Z',
  });
  assert.equal(final.rows.length, 0);
  assert.notEqual(final.effectiveTenantLineageRoot, claimed.effectiveTenantLineageRoot);
});

test('recovery tag requires a server-verified email and publish fails closed', () => {
  assert.throws(() => createRecoveryTag({
    email: 'owner@example.test', emailVerified: false,
    principalLineageId: '20000000-0000-4000-8000-000000000001',
    pepper: Buffer.alloc(32, 1),
  }), /verified/iu);
  const tag = createRecoveryTag({
    email: 'OWNER@EXAMPLE.TEST', emailVerified: true,
    principalLineageId: '20000000-0000-4000-8000-000000000001',
    pepper: Buffer.alloc(32, 1),
  });
  assert.match(tag, /^[0-9a-f]{64}$/u);
  const notEmpty = evaluatePublishReadiness({
    projectEmpty: false, manifestTrust: 'VERIFIED_V2', graphVerified: true,
    journalProofVerified: true, survivingOwnerClaims: { required: 1, completed: 1 },
  });
  assert.equal(notEmpty.state, 'QUARANTINED');
  assert.ok(notEmpty.blockingReasons.includes('TARGET_PROJECT_NOT_EMPTY'));
  const missingClaim = evaluatePublishReadiness({
    projectEmpty: true, manifestTrust: 'VERIFIED_V2', graphVerified: true,
    journalProofVerified: true, survivingOwnerClaims: { required: 1, completed: 0 },
  });
  assert.equal(missingClaim.state, 'NOT_READY');
  const ready = evaluatePublishReadiness({
    projectEmpty: true, manifestTrust: 'VERIFIED_V2', graphVerified: true,
    journalProofVerified: true, survivingOwnerClaims: { required: 1, completed: 1 },
  });
  assert.equal(ready.state, 'PUBLISHABLE');
});

test('owner invites expire, rotate on resend and allow only one state transition', () => {
  const base = { state: 'PENDING_INVITE', generation: 0, recoveryTagHash: 'a'.repeat(64) };
  const common = {
    restoreId: '80000000-0000-4000-8000-000000000001',
    principalLineageId: '20000000-0000-4000-8000-000000000001',
    now: '2026-08-31T01:00:00.000Z',
  };
  const first = issueOwnerInviteState(base, {
    ...common,
    deliveryId: '90000000-0000-4000-8000-000000000001',
    nonce: '90000000-0000-4000-8000-000000000011',
  }, Buffer.alloc(32, 5));
  const retry = issueOwnerInviteState(first.state, {
    ...common,
    deliveryId: '90000000-0000-4000-8000-000000000001',
    nonce: '90000000-0000-4000-8000-000000000099',
  }, Buffer.alloc(32, 5));
  assert.equal(retry.idempotent, true);
  assert.equal(retry.token, first.token);
  const rotated = issueOwnerInviteState(first.state, {
    ...common,
    deliveryId: '90000000-0000-4000-8000-000000000002',
    nonce: '90000000-0000-4000-8000-000000000012',
  }, Buffer.alloc(32, 5));
  assert.notEqual(rotated.token, first.token);
  assert.throws(() => claimOwnerInviteState(rotated.state, {
    token: first.token,
    userId: '70000000-0000-4000-8000-000000000001',
    now: '2026-08-31T01:05:00.000Z',
  }), /mismatch/iu);
  assert.throws(() => claimOwnerInviteState(rotated.state, {
    token: rotated.token,
    userId: '70000000-0000-4000-8000-000000000001',
    now: '2026-08-31T01:10:00.001Z',
  }), /expired/iu);
  const claimed = claimOwnerInviteState(rotated.state, {
    token: rotated.token,
    userId: '70000000-0000-4000-8000-000000000001',
    now: '2026-08-31T01:09:59.999Z',
  });
  assert.equal(claimed.state, 'CLAIMED');
  assert.throws(() => claimOwnerInviteState(claimed, {
    token: rotated.token,
    userId: '70000000-0000-4000-8000-000000000002',
    now: '2026-08-31T01:09:59.999Z',
  }), /not claimable/iu);
});
