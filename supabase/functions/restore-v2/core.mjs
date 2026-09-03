import {
  createHash,
  createHmac,
  sign as ed25519Sign,
  timingSafeEqual,
  verify as ed25519Verify,
} from 'node:crypto';

export const MANIFEST_V2_FORMAT = 'rv-restore-snapshot-manifest/2';
export const ENVELOPE_V2_FORMAT = 'rv-restore-snapshot-envelope/2';
export const MANIFEST_SIGNATURE_DOMAIN = 'rv-restore-v2-manifest/1\0';
export const ROW_CONTENT_DOMAIN = 'rv-restore-v2-ordered-content/1\0';
export const TENANT_LINEAGE_DOMAIN = 'rv-restore-v2-tenant-lineage/1\0';
export const EFFECTIVE_TENANT_LINEAGE_DOMAIN = 'rv-restore-v2-effective-tenant-lineage/1\0';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATASET = /^[a-z][a-z0-9_]{0,63}$/u;
const FORBIDDEN = /(?:credentials|credential(?:envelope|ciphertext|secret|key)|api[_-]?(?:key|secret)|secret[_-]?key|wrapped[_-]?dek|\bdek\b|service[_-]?role|private[_-]?key|access[_-]?token|refresh[_-]?token|password|envelope[_-]?(?:ciphertext|nonce|key)|temporary[_-]?url)/iu;
const DATASET_RULES = Object.freeze({
  tenants: Object.freeze({ required: ['status', 'createdAt'], principals: false, connections: false }),
  memberships: Object.freeze({ required: ['memberRole', 'status', 'membershipVersion', 'recoveryTagHash', 'createdAt', 'updatedAt'], principals: true, connections: false }),
  connections: Object.freeze({ required: ['provider', 'providerScopeHash', 'consentVersion', 'currentGeneration', 'createdAt', 'updatedAt'], principals: false, connections: true }),
  source_events: Object.freeze({ required: ['eventId', 'syncJobId', 'dataset', 'providerEventId', 'eventTime', 'eventBody', 'eventSha256', 'sourceObservedAt'], principals: false, connections: true }),
  generations: Object.freeze({ required: ['generation', 'credentialVersion', 'sourceJobIds', 'coverage', 'reconciliation', 'capabilities', 'sourceRootSha256', 'sourceEventCount', 'projectionSha256', 'tradeModelCount', 'manifestSha256', 'status', 'publishedAt'], principals: false, connections: true }),
  trade_identities: Object.freeze({ required: ['tradeId', 'idProtocol', 'sourceLineageSha256', 'firstGeneration', 'firstSeenAt'], principals: false, connections: true }),
  trade_read_models: Object.freeze({ required: ['tradeId', 'generation', 'modelProtocol', 'payload', 'payloadSha256', 'projectedAt'], principals: false, connections: true }),
  reviews: Object.freeze({ required: ['tradeId', 'tradeGeneration', 'sourceLineageSha256', 'version', 'payload', 'payloadSha256', 'createdAt', 'updatedAt'], principals: true, connections: true }),
  actions: Object.freeze({ required: ['tradeId', 'reviewLineageId', 'status', 'version', 'payload', 'createdAt', 'updatedAt'], principals: true, connections: true }),
  journal_entries: Object.freeze({ required: ['journalDay', 'version', 'payload', 'createdAt', 'updatedAt'], principals: true, connections: true }),
  risk_rules: Object.freeze({ required: ['status', 'version', 'payload', 'createdAt', 'updatedAt'], principals: true, connections: true }),
  reports: Object.freeze({ required: ['reportType', 'periodStart', 'periodEnd', 'sourceGeneration', 'version', 'payload', 'payloadSha256', 'createdAt', 'updatedAt'], principals: true, connections: true }),
  ledger_generations: Object.freeze({ required: ['generation', 'status', 'projectionSha256', 'reasonCodes', 'createdAt', 'updatedAt'], principals: false, connections: true }),
  reconciliation_generations: Object.freeze({ required: ['generation', 'state', 'status', 'reasonCodes', 'checks', 'createdAt', 'updatedAt'], principals: false, connections: true }),
});

function invariant(condition, message, code = 'RESTORE_V2_INVALID') {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isSafeInteger(value), 'unsafe numbers are forbidden');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    invariant(!value.includes('\u0000'), 'NUL text is forbidden');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  invariant(plainRecord(value), 'unsupported canonical JSON value');
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value, label) {
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed) && new Date(parsed).toISOString() === value, `${label} is invalid`);
  return parsed;
}

function uuid(value, label) {
  invariant(UUID.test(value ?? ''), `${label} is invalid`);
  return value;
}

function assertSafeValue(value, path = '$', depth = 0) {
  invariant(depth <= 32, 'restore value nesting is invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    invariant(Number.isSafeInteger(value), `unsafe number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= 100_000, `array too large at ${path}`);
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  invariant(plainRecord(value), `unsupported value at ${path}`);
  invariant(Object.keys(value).length <= 256, `object too large at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    invariant(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key), `field is invalid at ${path}`);
    invariant(!FORBIDDEN.test(key), `credential or forbidden field at ${path}.${key}`,
      'CREDENTIAL_FIELD_FORBIDDEN');
    assertSafeValue(child, `${path}.${key}`, depth + 1);
  }
}

function normalizeRow(row, ordinal) {
  invariant(plainRecord(row), 'restore row must be an object');
  const allowed = new Set([
    'dataset', 'recordId', 'tenantLineageId', 'connectionLineageId',
    'principalLineageId', 'payload',
  ]);
  invariant(Object.keys(row).every(key => allowed.has(key)), 'restore row contains unsupported fields');
  invariant(DATASET.test(row.dataset ?? '') && DATASET_RULES[row.dataset], 'restore dataset is unsupported');
  uuid(row.recordId, 'record lineage');
  uuid(row.tenantLineageId, 'tenant lineage');
  const rule = DATASET_RULES[row.dataset];
  if (rule.connections) uuid(row.connectionLineageId, 'connection lineage');
  else invariant(row.connectionLineageId === undefined, 'connection lineage is not allowed');
  if (rule.principals) uuid(row.principalLineageId, 'principal lineage');
  else invariant(row.principalLineageId === undefined, 'principal lineage is not allowed');
  invariant(plainRecord(row.payload), 'restore payload must be an object');
  rule.required.forEach(key => invariant(Object.hasOwn(row.payload, key), `restore ${row.dataset} row is missing ${key}`));
  assertSafeValue(row.payload);
  const normalized = {
    ordinal,
    dataset: row.dataset,
    recordId: row.recordId,
    tenantLineageId: row.tenantLineageId,
    ...(row.connectionLineageId ? { connectionLineageId: row.connectionLineageId } : {}),
    ...(row.principalLineageId ? { principalLineageId: row.principalLineageId } : {}),
    payload: row.payload,
  };
  return Object.freeze(normalized);
}

function lineageRoot(tenantIds, domain = TENANT_LINEAGE_DOMAIN) {
  const sorted = [...new Set(tenantIds)].sort();
  return sha256(domain + sorted.map(id => `${id}\n`).join(''));
}

export function validateRestoreGraph(rows) {
  invariant(Array.isArray(rows) && rows.length > 0 && rows.length <= 1_000_000,
    'restore rows are empty or too large');
  const normalized = rows.map((row, index) => normalizeRow(row, index));
  const recordIds = new Set();
  const tenants = new Set();
  const principals = new Map();
  const connections = new Map();
  const generations = new Set();
  const tradeIdentities = new Map();
  const tradeReadModels = new Map();
  const reviewRows = new Map();
  for (const row of normalized) {
    invariant(!recordIds.has(row.recordId), 'duplicate record lineage');
    recordIds.add(row.recordId);
    if (row.dataset === 'tenants') {
      invariant(row.recordId === row.tenantLineageId, 'tenant record lineage mismatch');
      tenants.add(row.tenantLineageId);
    }
  }
  for (const row of normalized) {
    invariant(tenants.has(row.tenantLineageId), 'dangling or cross-tenant reference');
    if (row.dataset === 'memberships') {
      invariant(row.recordId === row.principalLineageId, 'principal record lineage mismatch');
      principals.set(row.principalLineageId, row.tenantLineageId);
      invariant(row.payload.memberRole === 'OWNER' && row.payload.status === 'ACTIVE',
        'personal beta membership must be an active owner');
      invariant(SHA256.test(row.payload.recoveryTagHash ?? ''), 'recovery tag hash invalid');
    }
    if (row.dataset === 'connections') {
      invariant(row.recordId === row.connectionLineageId, 'connection record lineage mismatch');
      connections.set(row.connectionLineageId, row.tenantLineageId);
      invariant(row.payload.provider === 'binance', 'connection provider invalid');
      invariant(SHA256.test(row.payload.providerScopeHash ?? ''), 'connection scope hash invalid');
    }
    if (row.dataset === 'generations') {
      invariant(Number.isSafeInteger(row.payload.generation) && row.payload.generation > 0,
        'generation invalid');
      invariant(Number.isSafeInteger(row.payload.credentialVersion)
        && row.payload.credentialVersion > 0
        && Array.isArray(row.payload.sourceJobIds)
        && row.payload.sourceJobIds.length > 0
        && row.payload.sourceJobIds.length <= 128
        && row.payload.sourceJobIds.every(value => UUID.test(value ?? ''))
        && SHA256.test(row.payload.sourceRootSha256 ?? '')
        && Number.isSafeInteger(row.payload.sourceEventCount)
        && row.payload.sourceEventCount >= 0
        && SHA256.test(row.payload.projectionSha256 ?? '')
        && Number.isSafeInteger(row.payload.tradeModelCount)
        && row.payload.tradeModelCount >= 0
        && SHA256.test(row.payload.manifestSha256 ?? '')
        && ['PUBLISHED', 'SUPERSEDED', 'REVOKED'].includes(row.payload.status)
        && Number.isFinite(iso(row.payload.publishedAt, 'generation publication time')),
      'generation audit evidence invalid');
      generations.add(`${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.generation}`);
    }
    if (row.dataset === 'trade_identities') {
      invariant(/^t_[0-9a-f]{16}$/u.test(row.payload.tradeId ?? ''), 'trade identity invalid');
      invariant(row.payload.idProtocol === 'rv2-trade-id/1'
        && SHA256.test(row.payload.sourceLineageSha256 ?? '')
        && Number.isSafeInteger(row.payload.firstGeneration)
        && row.payload.firstGeneration > 0, 'trade identity invalid');
      tradeIdentities.set(
        `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.tradeId}`,
        row,
      );
    }
    if (row.dataset === 'trade_read_models') {
      invariant(/^t_[0-9a-f]{16}$/u.test(row.payload.tradeId ?? '')
        && Number.isSafeInteger(row.payload.generation) && row.payload.generation > 0
        && row.payload.modelProtocol === 'rv2-trade-read-model/1'
        && SHA256.test(row.payload.payloadSha256 ?? ''), 'trade read model invalid');
      tradeReadModels.set(
        `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.tradeId}|${row.payload.generation}`,
        row,
      );
    }
    if (row.dataset === 'reviews') reviewRows.set(row.recordId, row);
  }
  for (const row of normalized) {
    if (row.connectionLineageId) {
      invariant(connections.has(row.connectionLineageId), 'dangling connection reference');
      invariant(connections.get(row.connectionLineageId) === row.tenantLineageId,
        'cross-tenant connection reference', 'CROSS_TENANT_REFERENCE');
    }
    if (row.principalLineageId) {
      invariant(principals.has(row.principalLineageId), 'dangling principal reference');
      invariant(principals.get(row.principalLineageId) === row.tenantLineageId,
        'cross-tenant principal reference', 'CROSS_TENANT_REFERENCE');
    }
    if (row.dataset === 'actions' && row.payload.reviewLineageId !== null) {
      uuid(row.payload.reviewLineageId, 'review lineage');
      invariant(reviewRows.has(row.payload.reviewLineageId), 'dangling review foreign key');
      invariant(reviewRows.get(row.payload.reviewLineageId).tenantLineageId === row.tenantLineageId,
        'cross-tenant review reference', 'CROSS_TENANT_REFERENCE');
      invariant(reviewRows.get(row.payload.reviewLineageId).payload.tradeId === row.payload.tradeId,
        'action trade/review reference mismatch');
    }
    if (row.dataset === 'trade_read_models') {
      invariant(tradeIdentities.has(
        `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.tradeId}`,
      ), 'dangling trade identity foreign key');
      invariant(generations.has(
        `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.generation}`,
      ), 'dangling generation foreign key');
    }
    if (row.dataset === 'trade_identities') {
      invariant(generations.has(
        `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.firstGeneration}`,
      ), 'dangling first generation foreign key');
    }
    if (row.dataset === 'reviews') {
      const identityKey = `${row.tenantLineageId}|${row.connectionLineageId}|${row.payload.tradeId}`;
      const modelKey = `${identityKey}|${row.payload.tradeGeneration}`;
      invariant(tradeIdentities.has(identityKey) && tradeReadModels.has(modelKey),
        'dangling trade read model foreign key');
      invariant(tradeIdentities.get(identityKey).payload.sourceLineageSha256
        === row.payload.sourceLineageSha256, 'review source lineage mismatch');
    }
  }
  const membershipsByTenant = new Map();
  for (const row of normalized.filter(item => item.dataset === 'memberships')) {
    membershipsByTenant.set(
      row.tenantLineageId,
      (membershipsByTenant.get(row.tenantLineageId) ?? 0) + 1,
    );
  }
  for (const tenantId of tenants) invariant((membershipsByTenant.get(tenantId) ?? 0) === 1,
    'personal beta tenant requires exactly one active owner membership');
  return Object.freeze({
    rows: Object.freeze(normalized),
    tenantIds: Object.freeze([...tenants].sort()),
    principalCount: principals.size,
    connectionCount: connections.size,
  });
}

export function buildSnapshotV2({ snapshotId, createdAt, rows, externalJournalRoot }) {
  uuid(snapshotId, 'snapshot ID');
  iso(createdAt, 'snapshot creation time');
  invariant(SHA256.test(externalJournalRoot ?? ''), 'external journal root is invalid');
  const graph = validateRestoreGraph(rows);
  const streamLines = graph.rows.map(row => canonicalJson({
    dataset: row.dataset,
    recordId: row.recordId,
    tenantLineageId: row.tenantLineageId,
    ...(row.connectionLineageId ? { connectionLineageId: row.connectionLineageId } : {}),
    ...(row.principalLineageId ? { principalLineageId: row.principalLineageId } : {}),
    payload: row.payload,
  }) + '\n');
  const orderedLines = graph.rows.map((row, index) => (
    `${index}:${row.dataset}:${sha256(streamLines[index])}\n`
  ));
  const rowCounts = {};
  graph.rows.forEach(row => { rowCounts[row.dataset] = (rowCounts[row.dataset] ?? 0) + 1; });
  const plaintext = streamLines.join('');
  const manifest = Object.freeze({
    format: MANIFEST_V2_FORMAT,
    snapshotId,
    createdAt,
    rowCount: graph.rows.length,
    rowCounts: Object.freeze(Object.fromEntries(Object.entries(rowCounts).sort())),
    orderedContentRoot: sha256(ROW_CONTENT_DOMAIN + orderedLines.join('')),
    tenantLineageRoot: lineageRoot(graph.tenantIds),
    plaintextStreamSha256: sha256(plaintext),
    externalJournalRoot,
    credentialsIncluded: false,
  });
  return Object.freeze({ manifest, plaintext, rows: graph.rows });
}

function validateManifestV2(manifest) {
  invariant(plainRecord(manifest), 'manifest is invalid');
  const keys = [
    'format', 'snapshotId', 'createdAt', 'rowCount', 'rowCounts',
    'orderedContentRoot', 'tenantLineageRoot', 'plaintextStreamSha256',
    'externalJournalRoot', 'credentialsIncluded',
  ].sort();
  invariant(Object.keys(manifest).sort().join(',') === keys.join(','), 'manifest fields are invalid');
  invariant(manifest.format === MANIFEST_V2_FORMAT, 'manifest format is invalid');
  uuid(manifest.snapshotId, 'snapshot ID');
  iso(manifest.createdAt, 'snapshot creation time');
  invariant(Number.isSafeInteger(manifest.rowCount) && manifest.rowCount > 0, 'manifest row count invalid');
  invariant(plainRecord(manifest.rowCounts), 'manifest row counts invalid');
  const total = Object.entries(manifest.rowCounts).reduce((sum, [dataset, count]) => {
    invariant(Boolean(DATASET_RULES[dataset]) && Number.isSafeInteger(count) && count >= 0,
      'manifest dataset count invalid');
    return sum + count;
  }, 0);
  invariant(total === manifest.rowCount, 'manifest row total mismatch');
  for (const key of ['orderedContentRoot', 'tenantLineageRoot', 'plaintextStreamSha256', 'externalJournalRoot']) {
    invariant(SHA256.test(manifest[key] ?? ''), `manifest ${key} invalid`);
  }
  invariant(manifest.credentialsIncluded === false, 'credential restoration is forbidden');
  return manifest;
}

export function signManifestV2(manifest, { privateKey, keyId }) {
  validateManifestV2(manifest);
  invariant(/^[A-Za-z0-9._-]{3,64}$/u.test(keyId ?? ''), 'manifest key ID invalid');
  const bytes = Buffer.from(MANIFEST_SIGNATURE_DOMAIN + canonicalJson(manifest), 'utf8');
  return Object.freeze({
    format: ENVELOPE_V2_FORMAT,
    algorithm: 'Ed25519',
    keyId,
    manifest,
    signature: ed25519Sign(null, bytes, privateKey).toString('base64url'),
  });
}

export function verifyManifestEnvelope(envelope, { publicKey, expectedKeyId } = {}) {
  if (envelope?.format === 'review-workbench-beta-signed-manifest/1'
      || envelope?.manifest?.format === 'review-workbench-beta-backup/1') {
    return Object.freeze({ trust: 'LEGACY_UNTRUSTED', publishable: false });
  }
  invariant(plainRecord(envelope)
    && Object.keys(envelope).sort().join(',') === 'algorithm,format,keyId,manifest,signature',
  'manifest envelope fields invalid');
  invariant(envelope.format === ENVELOPE_V2_FORMAT && envelope.algorithm === 'Ed25519',
    'manifest envelope format invalid');
  invariant(envelope.keyId === expectedKeyId && Boolean(publicKey), 'manifest key is not trusted');
  invariant(/^[A-Za-z0-9_-]{80,128}$/u.test(envelope.signature ?? ''), 'manifest signature invalid');
  const manifest = validateManifestV2(envelope.manifest);
  const signature = Buffer.from(envelope.signature, 'base64url');
  const bytes = Buffer.from(MANIFEST_SIGNATURE_DOMAIN + canonicalJson(manifest), 'utf8');
  invariant(signature.length === 64 && ed25519Verify(null, bytes, publicKey, signature),
    'manifest signature authenticity failed');
  return Object.freeze({ trust: 'VERIFIED_V2', publishable: true, manifest });
}

function validateDeletionEvent(event) {
  invariant(plainRecord(event)
    && Object.keys(event).sort().join(',')
      === 'committedAt,eventId,operation,tenantLineageId', 'deletion event invalid');
  uuid(event.eventId, 'deletion event ID');
  uuid(event.tenantLineageId, 'deletion tenant lineage');
  invariant(['DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT'].includes(event.operation),
    'deletion operation invalid');
  iso(event.committedAt, 'deletion commit time');
  return event;
}

export function applyDeletionJournal(rows, proof, { snapshotCreatedAt, restoreStartedAt }) {
  const graph = validateRestoreGraph(rows);
  invariant(plainRecord(proof), 'external deletion journal proof missing',
    'EXTERNAL_JOURNAL_PROOF_MISSING');
  invariant(SHA256.test(proof.firstPassRoot ?? '')
    && proof.firstPassRoot === proof.secondPassRoot, 'two-pass journal roots differ');
  const rangeStart = iso(proof.rangeStart, 'journal range start');
  const rangeEnd = iso(proof.rangeEnd, 'journal range end');
  invariant(rangeStart <= iso(snapshotCreatedAt, 'snapshot creation time')
    && rangeEnd >= iso(restoreStartedAt, 'restore start time')
    && rangeEnd >= rangeStart, 'deletion journal range proof is incomplete');
  invariant(Array.isArray(proof.events), 'deletion journal events invalid');
  const seen = new Set();
  const deleted = new Set();
  for (const event of proof.events) {
    validateDeletionEvent(event);
    invariant(!seen.has(event.eventId), 'duplicate deletion journal event');
    seen.add(event.eventId);
    const at = Date.parse(event.committedAt);
    invariant(at >= rangeStart && at <= rangeEnd, 'deletion event outside proven range');
    if (at >= Date.parse(snapshotCreatedAt)) deleted.add(event.tenantLineageId);
  }
  const effectiveRows = graph.rows.filter(row => !deleted.has(row.tenantLineageId));
  const survivingTenantIds = graph.tenantIds.filter(id => !deleted.has(id));
  return Object.freeze({
    rows: Object.freeze(effectiveRows),
    deletedTenantLineageIds: Object.freeze([...deleted].sort()),
    effectiveTenantLineageRoot: lineageRoot(survivingTenantIds, EFFECTIVE_TENANT_LINEAGE_DOMAIN),
    journalRoot: proof.firstPassRoot,
  });
}

export function createRecoveryTag({ email, emailVerified, principalLineageId, pepper }) {
  invariant(emailVerified === true, 'server-verified email is required');
  invariant(typeof email === 'string' && email.length >= 3 && email.length <= 320
    && email === email.trim(), 'verified email is invalid');
  uuid(principalLineageId, 'principal lineage');
  const key = Buffer.isBuffer(pepper) ? pepper : Buffer.from(pepper ?? '');
  invariant(key.length >= 32 && key.length <= 128, 'recovery pepper invalid');
  const normalized = email.normalize('NFKC').toLowerCase();
  return createHmac('sha256', key)
    .update(`rv-restore-v2-recovery/1\0${principalLineageId}\0${normalized}`, 'utf8')
    .digest('hex');
}

export function constantTimeTagMatch(left, right) {
  invariant(SHA256.test(left ?? '') && SHA256.test(right ?? ''), 'recovery tag invalid');
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function issueOwnerInviteState(state, {
  restoreId,
  principalLineageId,
  deliveryId,
  nonce,
  now,
}, pepper) {
  uuid(restoreId, 'restore ID');
  uuid(principalLineageId, 'principal lineage');
  uuid(deliveryId, 'invite delivery ID');
  uuid(nonce, 'invite nonce');
  const issuedAt = iso(now, 'invite issue time');
  const current = state ? structuredClone(state) : {
    state: 'PENDING_INVITE', generation: 0, recoveryTagHash: '0'.repeat(64),
  };
  invariant(['PENDING_INVITE', 'INVITED'].includes(current.state),
    'owner invite cannot be issued after claim');
  if (current.state === 'INVITED' && current.deliveryId === deliveryId) {
    return Object.freeze({ state: Object.freeze(current), token: current.token, idempotent: true });
  }
  const key = Buffer.isBuffer(pepper) ? pepper : Buffer.from(pepper ?? '');
  invariant(key.length >= 32 && key.length <= 128, 'invite pepper invalid');
  invariant(SHA256.test(current.recoveryTagHash ?? ''), 'recovery tag hash invalid');
  const generation = current.generation + 1;
  const token = createHmac('sha256', key).update(
    `rv-restore-v2-owner-invite/1\0${restoreId}\0${principalLineageId}\0${generation}\0${nonce}\0${current.recoveryTagHash}`,
    'utf8',
  ).digest('hex');
  const next = Object.freeze({
    state: 'INVITED', generation, deliveryId, nonce, token,
    tokenHash: sha256(token),
    recoveryTagHash: current.recoveryTagHash,
    issuedAt: now,
    expiresAt: new Date(issuedAt + 10 * 60 * 1000).toISOString(),
    claimedUserId: null,
  });
  return Object.freeze({ state: next, token, idempotent: false });
}

export function claimOwnerInviteState(state, { token, userId, now }) {
  invariant(plainRecord(state) && state.state === 'INVITED', 'owner invite is not claimable');
  uuid(userId, 'claimed user');
  const currentTime = iso(now, 'claim time');
  invariant(currentTime <= iso(state.expiresAt, 'invite expiry'), 'owner invite expired');
  invariant(SHA256.test(token ?? '') && constantTimeTagMatch(sha256(token), state.tokenHash),
    'owner invite mismatch');
  return Object.freeze({
    ...state,
    state: 'CLAIMED',
    claimedUserId: userId,
    claimedAt: now,
  });
}

export function evaluatePublishReadiness({
  projectEmpty,
  manifestTrust,
  graphVerified,
  journalProofVerified,
  survivingOwnerClaims,
}) {
  const blockingReasons = [];
  if (!projectEmpty) blockingReasons.push('TARGET_PROJECT_NOT_EMPTY');
  if (manifestTrust !== 'VERIFIED_V2') blockingReasons.push(
    manifestTrust === 'LEGACY_UNTRUSTED' ? 'LEGACY_UNTRUSTED' : 'MANIFEST_UNVERIFIED',
  );
  if (!graphVerified) blockingReasons.push('GRAPH_UNVERIFIED');
  if (!journalProofVerified) blockingReasons.push('EXTERNAL_JOURNAL_PROOF_MISSING');
  if (!plainRecord(survivingOwnerClaims)
      || !Number.isSafeInteger(survivingOwnerClaims.required)
      || !Number.isSafeInteger(survivingOwnerClaims.completed)
      || survivingOwnerClaims.required < 1
      || survivingOwnerClaims.completed !== survivingOwnerClaims.required) {
    blockingReasons.push('OWNER_RECOVERY_INCOMPLETE');
  }
  if (blockingReasons.length === 0) return Object.freeze({ state: 'PUBLISHABLE', blockingReasons: [] });
  const state = blockingReasons.includes('TARGET_PROJECT_NOT_EMPTY')
    || blockingReasons.includes('LEGACY_UNTRUSTED')
    || blockingReasons.includes('GRAPH_UNVERIFIED')
    ? 'QUARANTINED'
    : 'NOT_READY';
  return Object.freeze({ state, blockingReasons: Object.freeze(blockingReasons) });
}

export function simulateAtomicPublish({ before, operations, failAt = null }) {
  const draft = structuredClone(before);
  try {
    operations.forEach((operation, index) => {
      operation(draft);
      if (failAt === index) throw new Error('simulated publish failure');
    });
    return Object.freeze({ committed: true, state: draft });
  } catch (error) {
    return Object.freeze({ committed: false, state: structuredClone(before), error });
  }
}
