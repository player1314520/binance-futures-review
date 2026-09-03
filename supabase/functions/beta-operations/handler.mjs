import {
  BINDING_FIELDS,
  BetaOperationsError,
  canonicalJson,
  exactObject,
  validateBinding,
  validateGithubOidcClaims,
  validateOperationsPolicy,
} from './core.mjs';

const TOKEN_PATTERN = /^\S{16,16384}$/u;
const RESTORE_LEASE_PATTERN = /^\S{16,8192}$/u;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESTORE_V2_SIGNATURE_DOMAIN = 'rv-restore-v2-manifest/1\0';
const ARCHIVE_DATASETS = new Set([
  'fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions',
]);
const ARCHIVE_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries({
  fills: {
    required: ['providerEventId', 'eventTime', 'symbol', 'tradeId'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'orderId', 'tradeId', 'side', 'positionSide', 'price', 'qty', 'realizedPnl', 'commission', 'commissionAsset', 'buyer', 'maker'],
  },
  income: {
    required: ['providerEventId', 'eventTime', 'transactionId', 'incomeType', 'asset'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'transactionId', 'incomeType', 'income', 'asset', 'info', 'tradeId'],
  },
  orders: {
    required: ['providerEventId', 'eventTime', 'symbol', 'orderId', 'status'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'orderId', 'clientOrderId', 'side', 'positionSide', 'type', 'status', 'updateTime', 'price', 'avgPrice', 'origQty', 'executedQty', 'reduceOnly', 'closePosition'],
  },
  algo_orders: {
    required: ['providerEventId', 'eventTime', 'symbol', 'algoId', 'algoStatus'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'algoId', 'clientAlgoId', 'side', 'positionSide', 'orderType', 'algoStatus', 'createTime', 'updateTime', 'triggerPrice', 'price', 'quantity'],
  },
  force_orders: {
    required: ['providerEventId', 'eventTime', 'symbol', 'orderId', 'status'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'orderId', 'side', 'positionSide', 'status', 'updateTime', 'price', 'avgPrice', 'origQty', 'executedQty', 'autoCloseType'],
  },
  balances: {
    required: ['providerEventId', 'eventTime', 'asset'],
    allowed: ['providerEventId', 'eventTime', 'asset', 'balance', 'crossWalletBalance', 'crossUnPnl', 'availableBalance', 'maxWithdrawAmount', 'marginAvailable', 'updateTime'],
  },
  positions: {
    required: ['providerEventId', 'eventTime', 'symbol', 'positionSide'],
    allowed: ['providerEventId', 'eventTime', 'symbol', 'positionSide', 'positionAmt', 'entryPrice', 'breakEvenPrice', 'markPrice', 'unRealizedProfit', 'liquidationPrice', 'leverage', 'marginType', 'isolatedMargin', 'notional', 'updateTime'],
  },
}).map(([dataset, schema]) => [dataset, Object.freeze({
  required: Object.freeze(schema.required),
  allowed: Object.freeze(new Set(schema.allowed)),
})])));
const BACKUP_DATASET_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
  trades: ['id', 'tenantId', 'connectionId', 'tradeId', 'orderId', 'symbol', 'side', 'positionSide', 'time', 'price', 'qty', 'commission', 'commissionAsset', 'realizedPnl', 'buyer', 'maker', 'generation'],
  income: ['id', 'tenantId', 'connectionId', 'transactionId', 'symbol', 'incomeType', 'income', 'asset', 'time', 'info', 'tradeId', 'generation'],
  orders: ['id', 'tenantId', 'connectionId', 'orderId', 'clientOrderId', 'symbol', 'side', 'positionSide', 'type', 'status', 'time', 'updateTime', 'price', 'avgPrice', 'origQty', 'executedQty', 'reduceOnly', 'closePosition', 'generation'],
  algo_orders: ['id', 'tenantId', 'connectionId', 'algoId', 'clientAlgoId', 'symbol', 'side', 'positionSide', 'orderType', 'algoStatus', 'createTime', 'updateTime', 'triggerPrice', 'price', 'quantity', 'generation'],
  force_orders: ['id', 'tenantId', 'connectionId', 'orderId', 'symbol', 'side', 'positionSide', 'status', 'time', 'updateTime', 'price', 'avgPrice', 'origQty', 'executedQty', 'autoCloseType', 'generation'],
  balances: ['id', 'tenantId', 'connectionId', 'asset', 'balance', 'crossWalletBalance', 'crossUnPnl', 'availableBalance', 'maxWithdrawAmount', 'marginAvailable', 'updateTime', 'generation'],
  positions: ['id', 'tenantId', 'connectionId', 'symbol', 'positionSide', 'positionAmt', 'entryPrice', 'breakEvenPrice', 'markPrice', 'unRealizedProfit', 'liquidationPrice', 'leverage', 'marginType', 'isolatedMargin', 'notional', 'updateTime', 'generation'],
  reviews: ['id', 'tenantId', 'connectionId', 'reviewId', 'tradeId', 'version', 'payload', 'payloadSha256', 'createdBy', 'createdAt', 'updatedAt'],
  actions: ['id', 'tenantId', 'connectionId', 'actionId', 'reviewId', 'status', 'version', 'payload', 'createdBy', 'createdAt', 'updatedAt'],
  journal_entries: ['id', 'tenantId', 'connectionId', 'journalId', 'journalDay', 'version', 'payload', 'createdBy', 'createdAt', 'updatedAt'],
  risk_rules: ['id', 'tenantId', 'connectionId', 'ruleId', 'status', 'version', 'payload', 'createdBy', 'createdAt', 'updatedAt'],
  reports: ['id', 'tenantId', 'connectionId', 'reportId', 'reportType', 'periodStart', 'periodEnd', 'sourceGeneration', 'version', 'payload', 'payloadSha256', 'createdBy', 'createdAt', 'updatedAt'],
  source_events: ['id', 'tenantId', 'connectionId', 'eventId', 'syncJobId', 'dataset', 'providerEventId', 'eventTime', 'eventBody', 'eventSha256', 'sourceObservedAt'],
  generations: ['id', 'tenantId', 'connectionId', 'generation', 'generationId', 'sourceJobIds', 'coverage', 'reconciliation', 'capabilities', 'manifestSha256', 'status', 'publishedAt'],
  connections: ['id', 'tenantId', 'connectionId', 'provider', 'providerScopeHash', 'status', 'permissionState', 'consentVersion', 'verifiedAt', 'lastTrustedAt', 'currentGeneration', 'disconnectReceiptId', 'disconnectedAt', 'createdAt', 'updatedAt'],
  memberships: ['id', 'tenantId', 'userId', 'memberRole', 'status', 'membershipVersion', 'createdAt', 'updatedAt'],
  tenants: ['id', 'tenantId', 'status', 'deletionReceiptId', 'createdAt', 'deletedAt'],
  ledger_generations: ['id', 'tenantId', 'connectionId', 'generation', 'status', 'projectionSha256', 'reasonCodes', 'createdAt', 'updatedAt'],
  reconciliation_generations: ['id', 'tenantId', 'connectionId', 'generation', 'state', 'status', 'reasonCodes', 'checks', 'createdAt', 'updatedAt'],
  deletion_tombstones: ['id', 'tenantId', 'receiptId', 'deletedAt'],
}).map(([dataset, fields]) => [dataset, Object.freeze(new Set(fields))])));
const FORBIDDEN_BACKUP_FIELDS = new Set([
  'credential', 'credentials', 'apikey', 'secretkey', 'dek', 'wrappeddek',
  'authsecret', 'temporaryurl', 'tempurl', 'accesstoken', 'refreshtoken',
  'password', 'servicerole', 'servicerolekey', 'privatekey', 'encryptionkey',
  'envelopeciphertext', 'envelopenonce', 'envelopekeyref', 'ciphertext', 'nonce', 'keyref',
]);
const REQUIRED_DEPENDENCIES = Object.freeze([
  'nowSeconds',
  'verifyGithubOidc',
  'claimOidcJti',
  'issueGrant',
  'verifyGrant',
  'createR2TemporaryCredentials',
  'readBackupPage',
  'recordBackupPageEvidence',
  'readBackupV2Page',
  'recordBackupV2PageEvidence',
  'claimBackupV2SigningEvidence',
  'recordCapacityObservation',
  'inspectR2PrivateAccess',
  'signCanonicalManifest',
  'inspectR2ObjectEvidence',
  'claimBackupSigningEvidence',
  'verifyRestoreTombstoneSignature',
  'applyDeletionTombstones',
  'verifyRestoreClaimSignature',
  'claimRestoreManifest',
  'issueRestoreLease',
  'verifyRestoreLease',
  'invokeRestoreV2',
  'createArchiveDownload',
  'attestArchivePayload',
  'failArchiveClaim',
  'ingestArchiveBatch',
  'finalizeArchive',
]);

function invariant(condition, code, message) {
  if (!condition) throw new BetaOperationsError(code, message);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function routePath(request) {
  const url = new URL(request.url);
  if (url.hash || url.pathname.includes('%')) return null;
  const suffixes = [
    '/internal/v1/token/exchange',
    '/internal/v1/backup/view',
    '/internal/v1/r2/private-attestation',
    '/internal/v1/backup/sign',
    '/internal/v2/backup/view',
    '/internal/v2/backup/sign',
    '/internal/v2/r2/journal-credentials',
    '/internal/v1/capacity/observe',
    '/internal/v1/restore/tombstone',
    '/internal/v1/restore/manifest-claim',
    '/internal/v1/restore/import-batch',
    '/internal/v1/restore/finalize',
    '/internal/v1/restore/status',
    '/internal/v2/restore/object-claim',
    '/internal/v2/restore/claim',
    '/internal/v2/restore/import',
    '/internal/v2/restore/finalize',
    '/internal/v2/restore/status',
    '/internal/v1/archive/request',
    '/internal/v1/archive/attest',
    '/internal/v1/archive/fail',
    '/internal/v1/archive/ingest',
    '/internal/v1/archive/finalize',
  ];
  for (const suffix of suffixes) {
    if (url.pathname === suffix || url.pathname.endsWith(`/beta-operations${suffix}`)) return suffix;
  }
  if (/\/(?:beta-operations\/)?internal\/v1\/restore\/[A-Za-z0-9_-]{8,128}\/status$/u.test(url.pathname)) {
    return '/internal/v1/restore/status';
  }
  return null;
}

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function restoreNotReadyResponse(restoreId, lease) {
  return jsonResponse(503, {
    format: 'beta-restore-not-ready/1',
    restoreId,
    targetGeneration: lease.targetGeneration,
    manifestSha256: lease.manifestSha256,
    state: 'NOT_READY',
    published: false,
    reason: 'RESTORE_PROOF_INCOMPLETE',
    blockingReasons: [
      'TENANT_LINEAGE_UNVERIFIED',
      'AUTH_IDENTITY_MAPPING_UNVERIFIED',
      'EXTERNAL_DELETION_JOURNAL_UNAVAILABLE',
    ],
  });
}

function errorResponse(error) {
  const code = String(error?.code ?? 'UPSTREAM_UNAVAILABLE');
  if (code === 'REQUEST_INVALID') return jsonResponse(400, { error: 'invalid_request' });
  if (code === 'AUTH_INVALID' || code === 'OIDC_CLAIMS_INVALID') {
    return jsonResponse(401, { error: 'authentication_required' });
  }
  if (code === 'REPLAY_DETECTED') return jsonResponse(409, { error: 'replay_detected' });
  if (code === 'IDEMPOTENCY_CONFLICT') return jsonResponse(409, { error: 'idempotency_conflict' });
  return jsonResponse(503, { error: 'operation_unavailable' });
}

async function readBoundedJson(request, maximumBytes) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  invariant(/^application\/json(?:;\s*charset=utf-8)?$/u.test(contentType),
    'REQUEST_INVALID', 'application/json required');
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    invariant(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maximumBytes,
      'REQUEST_INVALID', 'request body invalid');
  }
  invariant(request.body, 'REQUEST_INVALID', 'request body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      invariant(size <= maximumBytes, 'REQUEST_INVALID', 'request body invalid');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof BetaOperationsError) throw error;
    throw new BetaOperationsError('REQUEST_INVALID', 'request body invalid');
  } finally {
    reader.releaseLock();
  }
}

function bearer(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/u);
  invariant(match && TOKEN_PATTERN.test(match[1]), 'AUTH_INVALID', 'authentication required');
  return match[1];
}

function safeObject(value, depth = 0) {
  invariant(depth <= 8, 'REQUEST_INVALID', 'value nesting invalid');
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), 'REQUEST_INVALID', 'number invalid');
    return true;
  }
  if (typeof value === 'string') {
    invariant(value.length <= 32_768 && !/[\u0000]/u.test(value), 'REQUEST_INVALID', 'text invalid');
    return true;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= 1_000, 'REQUEST_INVALID', 'array invalid');
    value.forEach(item => safeObject(item, depth + 1));
    return true;
  }
  invariant(plainRecord(value), 'REQUEST_INVALID', 'object invalid');
  for (const [key, item] of Object.entries(value)) {
    invariant(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key), 'REQUEST_INVALID', 'field invalid');
    invariant(!/(?:secret|credential|api[_-]?key|api[_-]?secret|service[_-]?role|wrapped[_-]?dek|temporary[_-]?url)/iu.test(key),
      'REQUEST_INVALID', 'forbidden field');
    safeObject(item, depth + 1);
  }
  return true;
}

function safeBackupValue(value, depth = 0) {
  invariant(depth <= 32, 'UPSTREAM_UNAVAILABLE', 'backup value invalid');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') {
    invariant(value.length <= 1_000_000
      && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)
      && !/\bsb_secret_[A-Za-z0-9_-]{16,}\b/u.test(value)
      && !/\bsk-[A-Za-z0-9_-]{16,}\b/u.test(value)
      && !/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u.test(value),
    'UPSTREAM_UNAVAILABLE', 'backup value invalid');
    return true;
  }
  if (Array.isArray(value)) {
    invariant(value.length <= 1_000, 'UPSTREAM_UNAVAILABLE', 'backup value invalid');
    value.forEach(item => safeBackupValue(item, depth + 1));
    return true;
  }
  invariant(plainRecord(value) && Object.keys(value).length <= 256,
    'UPSTREAM_UNAVAILABLE', 'backup value invalid');
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    invariant(!FORBIDDEN_BACKUP_FIELDS.has(normalized),
      'UPSTREAM_UNAVAILABLE', 'backup value invalid');
    safeBackupValue(child, depth + 1);
  }
  return true;
}

function validateBackupPage(value) {
  invariant(exactObject(value, [
    'format', 'view', 'readOnly', 'snapshotId', 'generation', 'dataset', 'rows', 'nextCursor',
  ]), 'UPSTREAM_UNAVAILABLE', 'backup view invalid');
  invariant(value.format === 'beta-backup-page/1'
    && value.view === 'beta_backup_v1'
    && value.readOnly === true
    && ID_PATTERN.test(value.snapshotId ?? '')
    && Number.isSafeInteger(value.generation)
    && value.generation >= 0
    && Object.hasOwn(BACKUP_DATASET_FIELDS, value.dataset ?? '')
    && Array.isArray(value.rows)
    && value.rows.length <= 1_000
    && (value.nextCursor === null
      || (typeof value.nextCursor === 'string' && value.nextCursor.length <= 512)),
  'UPSTREAM_UNAVAILABLE', 'backup view invalid');
  const approvedFields = BACKUP_DATASET_FIELDS[value.dataset];
  value.rows.forEach(row => {
    invariant(plainRecord(row)
      && Object.keys(row).every(key => approvedFields.has(key)),
    'UPSTREAM_UNAVAILABLE', 'backup view invalid');
    safeBackupValue(row);
  });
  return value;
}

function validateBackupV2Page(value) {
  invariant(exactObject(value, [
    'format', 'view', 'readOnly', 'snapshotId', 'createdAt', 'rowCount',
    'rowCounts', 'rows', 'nextCursor',
  ]), 'UPSTREAM_UNAVAILABLE', 'restore v2 backup view invalid');
  invariant(value.format === 'rv-restore-v2-export-page/1'
    && value.view === 'rv2_restore_export_v2'
    && value.readOnly === true
    && UUID_PATTERN.test(value.snapshotId ?? '')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
    && new Date(Date.parse(value.createdAt)).toISOString() === value.createdAt
    && Number.isSafeInteger(value.rowCount) && value.rowCount > 0
    && plainRecord(value.rowCounts)
    && Array.isArray(value.rows) && value.rows.length <= 250
    && (value.nextCursor === null
      || (Number.isSafeInteger(value.nextCursor) && value.nextCursor >= 0)),
  'UPSTREAM_UNAVAILABLE', 'restore v2 backup view invalid');
  let total = 0;
  for (const [dataset, count] of Object.entries(value.rowCounts)) {
    invariant(/^[a-z][a-z0-9_]{0,63}$/u.test(dataset)
      && Number.isSafeInteger(count) && count > 0,
    'UPSTREAM_UNAVAILABLE', 'restore v2 backup view invalid');
    total += count;
  }
  invariant(total === value.rowCount, 'UPSTREAM_UNAVAILABLE', 'restore v2 backup view invalid');
  let previous = -1;
  for (const item of value.rows) {
    invariant(exactObject(item, ['rowOrdinal', 'rowData'])
      && Number.isSafeInteger(item.rowOrdinal) && item.rowOrdinal >= 0
      && item.rowOrdinal > previous && plainRecord(item.rowData),
    'UPSTREAM_UNAVAILABLE', 'restore v2 backup view invalid');
    previous = item.rowOrdinal;
    safeBackupValue(item.rowData);
  }
  return value;
}

function validateRestoreV2Manifest(value) {
  invariant(exactObject(value, [
    'format', 'snapshotId', 'createdAt', 'rowCount', 'rowCounts',
    'orderedContentRoot', 'tenantLineageRoot', 'plaintextStreamSha256',
    'externalJournalRoot', 'credentialsIncluded',
  ]), 'REQUEST_INVALID', 'restore v2 backup manifest invalid');
  invariant(value.format === 'rv-restore-snapshot-manifest/2'
    && UUID_PATTERN.test(value.snapshotId ?? '')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
    && new Date(Date.parse(value.createdAt)).toISOString() === value.createdAt
    && Number.isSafeInteger(value.rowCount) && value.rowCount > 0
    && plainRecord(value.rowCounts)
    && value.credentialsIncluded === false,
  'REQUEST_INVALID', 'restore v2 backup manifest invalid');
  let total = 0;
  for (const [dataset, count] of Object.entries(value.rowCounts)) {
    invariant(/^[a-z][a-z0-9_]{0,63}$/u.test(dataset)
      && Number.isSafeInteger(count) && count > 0,
    'REQUEST_INVALID', 'restore v2 backup manifest invalid');
    total += count;
  }
  invariant(total === value.rowCount, 'REQUEST_INVALID', 'restore v2 backup manifest invalid');
  for (const field of [
    'orderedContentRoot', 'tenantLineageRoot', 'plaintextStreamSha256', 'externalJournalRoot',
  ]) invariant(SHA256_PATTERN.test(value[field] ?? ''),
    'REQUEST_INVALID', 'restore v2 backup manifest invalid');
  return value;
}

function validateDeletionJournalProof(value, snapshotCreatedAt, externalJournalRoot) {
  invariant(exactObject(value, [
    'format', 'rangeStart', 'rangeEnd', 'firstPassRoot', 'secondPassRoot',
    'objectCount', 'snapshotJournalRoot', 'events', 'storageClaim',
  ]) && value.format === 'rv-deletion-journal-range-proof/2'
    && SHA256_PATTERN.test(value.firstPassRoot ?? '')
    && value.secondPassRoot === value.firstPassRoot
    && value.snapshotJournalRoot === externalJournalRoot
    && Number.isSafeInteger(value.objectCount) && value.objectCount >= 0
    && Array.isArray(value.events)
    && value.events.length <= 1_000_000
    && value.storageClaim === 'private-r2-best-effort-append-only-not-worm',
  'REQUEST_INVALID', 'restore v2 deletion journal proof invalid');
  const start = Date.parse(value.rangeStart);
  const end = Date.parse(value.rangeEnd);
  const snapshot = Date.parse(snapshotCreatedAt);
  invariant(Number.isFinite(start) && Number.isFinite(end)
    && new Date(start).toISOString() === value.rangeStart
    && new Date(end).toISOString() === value.rangeEnd
    && start <= snapshot && snapshot <= end,
  'REQUEST_INVALID', 'restore v2 deletion journal proof invalid');
  safeBackupValue(value.events);
  return value;
}

function capacityDecimalMillis(value, allowZero) {
  invariant(typeof value === 'string'
    && /^(?:0|[1-9][0-9]{0,7})(?:[.][0-9]{1,3})?$/u.test(value),
  'REQUEST_INVALID', 'capacity observation invalid');
  const [whole, fraction = ''] = value.split('.');
  const scaled = Number(whole) * 1_000 + Number(fraction.padEnd(3, '0'));
  invariant(Number.isSafeInteger(scaled)
    && scaled <= 10_000_000_000
    && (allowZero ? scaled >= 0 : scaled > 0),
  'REQUEST_INVALID', 'capacity observation invalid');
  return scaled;
}

async function validateCapacityObservation(value, expectedBinding, nowSeconds) {
  invariant(exactObject(value, [
    'format', 'binding', 'r2StandardBytes', 'actionsMinutesUsed',
    'actionsMinutesLimit', 'backupObjectAgeSeconds',
    'smtpDeliveryFailures24h', 'observedAt', 'evidenceSha256',
  ]) && value.format === 'rv-capacity-observation-request/1',
  'REQUEST_INVALID', 'capacity observation invalid');
  validateBinding(value.binding, expectedBinding);
  const usedMillis = capacityDecimalMillis(value.actionsMinutesUsed, true);
  const limitMillis = capacityDecimalMillis(value.actionsMinutesLimit, false);
  const observedAt = Date.parse(value.observedAt);
  invariant(Number.isSafeInteger(value.r2StandardBytes)
    && value.r2StandardBytes >= 0 && value.r2StandardBytes <= 10 * 1024 ** 4
    && (value.backupObjectAgeSeconds === null
      || (Number.isSafeInteger(value.backupObjectAgeSeconds)
        && value.backupObjectAgeSeconds >= 0
        && value.backupObjectAgeSeconds <= 315_576_000))
    && Number.isSafeInteger(value.smtpDeliveryFailures24h)
    && value.smtpDeliveryFailures24h >= 0
    && value.smtpDeliveryFailures24h <= 1_000_000
    && Number.isFinite(observedAt)
    && new Date(observedAt).toISOString() === value.observedAt
    && observedAt >= (nowSeconds - 86_400) * 1_000
    && observedAt <= (nowSeconds + 300) * 1_000
    && SHA256_PATTERN.test(value.evidenceSha256 ?? ''),
  'REQUEST_INVALID', 'capacity observation invalid');
  const material = 'rv-capacity-observation/1\0'
    + `${observedAt}\0${value.r2StandardBytes}\0${usedMillis}\0${limitMillis}\0`
    + `${value.backupObjectAgeSeconds ?? -1}\0${value.smtpDeliveryFailures24h}`;
  invariant(await sha256Hex(material) === value.evidenceSha256,
    'REQUEST_INVALID', 'capacity observation evidence mismatch');
  return Object.freeze({
    r2StandardBytes: value.r2StandardBytes,
    actionsMinutesUsed: value.actionsMinutesUsed,
    actionsMinutesLimit: value.actionsMinutesLimit,
    backupObjectAgeSeconds: value.backupObjectAgeSeconds,
    smtpDeliveryFailures24h: value.smtpDeliveryFailures24h,
    evidenceSha256: value.evidenceSha256,
    observedAt: value.observedAt,
  });
}

function validateManifest(value, expectedBinding, r2Prefix) {
  invariant(exactObject(value, [
    'format', 'createdAt', 'snapshotId', 'generation', 'nonce', 'source', 'encryption',
    'ageRecipientSha256', 'ciphertext', 'rowCounts', 'totalRows',
  ]), 'REQUEST_INVALID', 'backup manifest invalid');
  invariant(value.format === 'review-workbench-beta-backup/1'
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
    && new Date(Date.parse(value.createdAt)).toISOString() === value.createdAt
    && ID_PATTERN.test(value.snapshotId ?? '')
    && Number.isSafeInteger(value.generation)
    && value.generation >= 0
    && /^[0-9a-f]{48,128}$/u.test(value.nonce ?? '')
    && value.encryption === 'age'
    && SHA256_PATTERN.test(value.ageRecipientSha256 ?? ''),
  'REQUEST_INVALID', 'backup manifest invalid');
  invariant(exactObject(value.source, ['view', ...BINDING_FIELDS])
    && value.source.view === 'beta_backup_v1', 'REQUEST_INVALID', 'backup source invalid');
  validateBinding(Object.fromEntries(BINDING_FIELDS.map(field => [field, value.source[field]])), expectedBinding);
  invariant(exactObject(value.ciphertext, ['objectKey', 'sha256', 'bytes'])
    && typeof value.ciphertext.objectKey === 'string'
    && value.ciphertext.objectKey.startsWith(r2Prefix)
    && !value.ciphertext.objectKey.includes('..')
    && !value.ciphertext.objectKey.includes('\\')
    && SHA256_PATTERN.test(value.ciphertext.sha256 ?? '')
    && Number.isSafeInteger(value.ciphertext.bytes)
    && value.ciphertext.bytes > 0,
  'REQUEST_INVALID', 'backup ciphertext invalid');
  invariant(plainRecord(value.rowCounts), 'REQUEST_INVALID', 'backup row counts invalid');
  let totalRows = 0;
  for (const [dataset, count] of Object.entries(value.rowCounts)) {
    invariant(/^[a-z][a-z0-9_-]{0,63}$/u.test(dataset)
      && Number.isSafeInteger(count)
      && count >= 0, 'REQUEST_INVALID', 'backup row count invalid');
    totalRows += count;
  }
  invariant(Number.isSafeInteger(value.totalRows) && value.totalRows === totalRows,
    'REQUEST_INVALID', 'backup total rows invalid');
  safeObject(value);
  return value;
}

function validateTemporaryCredentials(value, maximumTtl) {
  invariant(plainRecord(value)
    && /^[A-Za-z0-9_-]{8,128}$/u.test(value.accessKeyId ?? '')
    && /^\S{16,512}$/u.test(value.secretAccessKey ?? '')
    && /^\S{16,8192}$/u.test(value.sessionToken ?? '')
    && Number.isSafeInteger(value.expiresIn)
    && value.expiresIn > 0
    && value.expiresIn <= maximumTtl,
  'UPSTREAM_UNAVAILABLE', 'temporary R2 credential invalid');
  return value;
}

function validateArchiveBatch(value) {
  invariant(exactObject(value, [
    'format', 'archiveId', 'batchIndex', 'dataset', 'records', 'sourceFile', 'totalBatches',
  ]), 'REQUEST_INVALID', 'archive batch invalid');
  invariant(value.format === 'beta-archive-batch/1'
    && ID_PATTERN.test(value.archiveId ?? '')
    && Number.isSafeInteger(value.batchIndex)
    && value.batchIndex >= 0
    && value.batchIndex < 100_000
    && ARCHIVE_DATASETS.has(value.dataset)
    && Array.isArray(value.records)
    && value.records.length <= 250
    && value.sourceFile === `${value.dataset}.csv`
    && Number.isSafeInteger(value.totalBatches)
    && value.totalBatches > 0
    && value.totalBatches <= 100_000
    && value.batchIndex < value.totalBatches,
  'REQUEST_INVALID', 'archive batch invalid');
  for (const row of value.records) {
    const schema = ARCHIVE_SCHEMAS[value.dataset];
    invariant(plainRecord(row)
      && /^[A-Za-z0-9_.:@/-]{1,192}$/u.test(row.providerEventId ?? '')
      && /^[1-9][0-9]{9,15}$/u.test(row.eventTime ?? '')
      && Object.keys(row).every(key => schema.allowed.has(key))
      && schema.required.every(key => typeof row[key] === 'string' && row[key].length > 0)
      && (!Object.hasOwn(row, 'symbol')
        || row.symbol === ''
        || /^[A-Z0-9]{3,32}$/u.test(row.symbol)),
    'REQUEST_INVALID', 'archive record invalid');
    safeObject(row);
  }
  return value;
}

function validateArchiveFinalize(value) {
  invariant(exactObject(value, [
    'format', 'archiveId', 'archiveSha256', 'archiveBytes', 'batchSetSha256', 'rowCount',
  ]), 'REQUEST_INVALID', 'archive finalize invalid');
  invariant(value.format === 'beta-archive-finalize/1'
    && ID_PATTERN.test(value.archiveId ?? '')
    && SHA256_PATTERN.test(value.archiveSha256 ?? '')
    && Number.isSafeInteger(value.archiveBytes)
    && value.archiveBytes > 0
    && value.archiveBytes <= 32 * 1024 * 1024
    && SHA256_PATTERN.test(value.batchSetSha256 ?? '')
    && Number.isSafeInteger(value.rowCount)
    && value.rowCount >= 0
    && value.rowCount <= 100_000,
  'REQUEST_INVALID', 'archive finalize invalid');
  return value;
}

function validateRestoreTombstone(value, nowSeconds) {
  invariant(exactObject(value, [
    'format', 'restoreId', 'activeGeneration', 'targetGeneration', 'mode',
    'issuedAt', 'expiresAt', 'nonce',
  ]), 'REQUEST_INVALID', 'restore tombstone invalid');
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  invariant(value.format === 'beta-restore-tombstone/1'
    && ID_PATTERN.test(value.restoreId ?? '')
    && Number.isSafeInteger(value.activeGeneration)
    && value.activeGeneration >= 0
    && Number.isSafeInteger(value.targetGeneration)
    && value.targetGeneration > value.activeGeneration
    && value.mode === 'new-generation'
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && new Date(issuedAt).toISOString() === value.issuedAt
    && new Date(expiresAt).toISOString() === value.expiresAt
    && issuedAt <= nowSeconds * 1000 + 30_000
    && expiresAt > nowSeconds * 1000
    && expiresAt - issuedAt <= 600_000
    && /^[0-9a-f]{32,128}$/u.test(value.nonce ?? ''),
  'REQUEST_INVALID', 'restore tombstone invalid');
  return value;
}

function validateRestoreClaim(value, policy) {
  invariant(exactObject(value, [
    'format', 'restoreId', 'targetGeneration', 'manifestNonce', 'manifestSha256',
    'sourceRepository', 'sourceWorkflowRef', 'sourceRunId', 'sourceRunAttempt',
  ]), 'REQUEST_INVALID', 'restore manifest claim invalid');
  invariant(value.format === 'beta-restore-manifest-claim/1'
    && ID_PATTERN.test(value.restoreId ?? '')
    && Number.isSafeInteger(value.targetGeneration)
    && value.targetGeneration > 0
    && /^[0-9a-f]{48,128}$/u.test(value.manifestNonce ?? '')
    && SHA256_PATTERN.test(value.manifestSha256 ?? '')
    && value.sourceRepository === policy.repository
    && value.sourceWorkflowRef === policy.workflowRef
    && /^[1-9][0-9]{0,19}$/u.test(value.sourceRunId ?? '')
    && /^[1-9][0-9]{0,9}$/u.test(value.sourceRunAttempt ?? ''),
  'REQUEST_INVALID', 'restore manifest claim invalid');
  return value;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateRestoreImportBatch(value) {
  invariant(exactObject(value, [
    'format', 'restoreId', 'targetGeneration', 'mode', 'dataset', 'batchIndex',
    'totalBatches', 'records',
  ]), 'REQUEST_INVALID', 'restore batch invalid');
  invariant(value.format === 'beta-restore-import-batch/1'
    && ID_PATTERN.test(value.restoreId ?? '')
    && Number.isSafeInteger(value.targetGeneration)
    && value.targetGeneration > 0
    && value.mode === 'new-generation'
    && Object.hasOwn(BACKUP_DATASET_FIELDS, value.dataset ?? '')
    && Number.isSafeInteger(value.batchIndex)
    && value.batchIndex >= 0
    && Number.isSafeInteger(value.totalBatches)
    && value.totalBatches > 0
    && value.totalBatches <= 100_000
    && value.batchIndex < value.totalBatches
    && Array.isArray(value.records)
    && value.records.length > 0
    && value.records.length <= 250,
  'REQUEST_INVALID', 'restore batch invalid');
  const fields = BACKUP_DATASET_FIELDS[value.dataset];
  for (const row of value.records) {
    invariant(plainRecord(row)
      && !Object.hasOwn(row, 'tenantId')
      && !Object.hasOwn(row, 'userId')
      && Object.keys(row).every(key => fields.has(key)),
      'REQUEST_INVALID', 'restore record invalid');
    try { safeBackupValue(row); } catch {
      throw new BetaOperationsError('REQUEST_INVALID', 'restore record invalid');
    }
  }
  return value;
}

function validateRestoreFinalize(value) {
  invariant(exactObject(value, [
    'format', 'restoreId', 'targetGeneration', 'manifestSha256', 'expectedBatchCount', 'rowCounts',
  ])
    && value.format === 'beta-restore-finalize/1'
    && ID_PATTERN.test(value.restoreId ?? '')
    && Number.isSafeInteger(value.targetGeneration)
    && value.targetGeneration > 0
    && SHA256_PATTERN.test(value.manifestSha256 ?? '')
    && Number.isSafeInteger(value.expectedBatchCount)
    && value.expectedBatchCount >= 0
    && value.expectedBatchCount <= 500_000
    && plainRecord(value.rowCounts)
    && Object.entries(value.rowCounts).every(([dataset, count]) => (
      Object.hasOwn(BACKUP_DATASET_FIELDS, dataset)
      && Number.isSafeInteger(count)
      && count >= 0
      && count <= 500_000
    )),
  'REQUEST_INVALID', 'restore finalize invalid');
  return value;
}

function validateRestoreObjectClaim(value, expectedBinding, r2Prefix) {
  invariant(exactObject(value, ['format', 'binding', 'objectKey'])
    && value.format === 'rv-restore-r2-object-claim/1'
    && typeof value.objectKey === 'string'
    && value.objectKey.length <= 1024
    && value.objectKey.startsWith(r2Prefix)
    && /^runs\/[1-9][0-9]{0,19}\/attempt-[1-9][0-9]{0,9}\/[0-9]{8}-[0-9]{9}Z\.(?:manifest\.json|ndjson\.age)$/u
      .test(value.objectKey.slice(r2Prefix.length)),
  'REQUEST_INVALID', 'restore R2 object claim invalid');
  validateBinding(value.binding, expectedBinding);
  return value;
}

function assertRestoreProxyResult(result) {
  invariant(plainRecord(result)
    && [200, 400, 401, 409, 503].includes(result.status)
    && plainRecord(result.value),
  'UPSTREAM_UNAVAILABLE', 'restore operation unavailable');
  const serialized = JSON.stringify(result.value);
  invariant(serialized.length <= 2 * 1024 * 1024
    && !/"(?:secret|credentialEnvelope|wrappedDek|serviceRoleKey|privateKey|accessToken|refreshToken)"\s*:/iu
      .test(serialized),
  'UPSTREAM_UNAVAILABLE', 'restore operation unavailable');
  return result;
}

export function createBetaOperationsHandler(deps) {
  invariant(plainRecord(deps), 'CONFIG_INVALID', 'operations dependencies missing');
  for (const name of REQUIRED_DEPENDENCIES) {
    invariant(typeof deps[name] === 'function', 'CONFIG_INVALID', `missing dependency: ${name}`);
  }
  invariant(plainRecord(deps.policies)
    && exactObject(deps.policies, [
      'beta-backup', 'beta-archive', 'beta-capacity-observe', 'beta-restore',
    ]),
  'CONFIG_INVALID', 'operations policies invalid');
  const policies = Object.freeze({
    'beta-backup': validateOperationsPolicy(deps.policies['beta-backup']),
    'beta-archive': validateOperationsPolicy(deps.policies['beta-archive']),
    'beta-capacity-observe': validateOperationsPolicy(
      deps.policies['beta-capacity-observe'],
    ),
    'beta-restore': validateOperationsPolicy(deps.policies['beta-restore']),
  });
  invariant(typeof deps.r2Bucket === 'string'
    && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(deps.r2Bucket)
    && !deps.r2Bucket.includes('..'), 'CONFIG_INVALID', 'R2 bucket invalid');
  invariant(typeof deps.r2Prefix === 'string'
    && deps.r2Prefix.endsWith('/')
    && !deps.r2Prefix.startsWith('/')
    && !deps.r2Prefix.includes('..'), 'CONFIG_INVALID', 'R2 prefix invalid');
  invariant(typeof deps.archiveDownloadHost === 'string'
    && /^[a-z0-9.-]{4,253}$/u.test(deps.archiveDownloadHost)
    && !/^\d+(?:\.\d+){3}$/u.test(deps.archiveDownloadHost),
  'CONFIG_INVALID', 'archive download host invalid');
  invariant(/^[A-Za-z0-9._-]{3,64}$/u.test(deps.backupSigningKeyId ?? ''),
    'CONFIG_INVALID', 'backup signing key invalid');
  const deadlineMs = deps.deadlineMs ?? 25_000;
  invariant(Number.isSafeInteger(deadlineMs) && deadlineMs >= 1_000 && deadlineMs <= 30_000,
    'CONFIG_INVALID', 'operations deadline invalid');

  async function authorize(request, capability) {
    const authorization = await deps.verifyGrant(bearer(request), {
      capability,
      nowSeconds: deps.nowSeconds(),
    });
    invariant(authorization, 'AUTH_INVALID', 'authentication required');
    return authorization;
  }

  async function authorizeOneOf(request, capabilities) {
    const token = bearer(request);
    for (const capability of capabilities) {
      const authorization = await deps.verifyGrant(token, {
        capability,
        nowSeconds: deps.nowSeconds(),
      });
      if (authorization) return authorization;
    }
    throw new BetaOperationsError('AUTH_INVALID', 'authentication required');
  }

  async function exchange(request, context) {
    const assertion = bearer(request);
    const value = await readBoundedJson(request, 32 * 1024);
    invariant(exactObject(value, [
      'format', 'audience', 'binding', 'requested_ttl_seconds', 'requested_capability',
    ]), 'REQUEST_INVALID', 'token request invalid');
    invariant(value.format === 'beta-job-token-request/1'
      && ['beta-backup', 'beta-archive', 'beta-capacity-observe', 'beta-restore']
        .includes(value.requested_capability)
      && Number.isSafeInteger(value.requested_ttl_seconds)
      && value.requested_ttl_seconds > 0
      && value.requested_ttl_seconds <= 600,
    'REQUEST_INVALID', 'token request invalid');
    const policy = policies[value.requested_capability];
    invariant(value.audience === policy.audience, 'OIDC_CLAIMS_INVALID', 'GitHub OIDC claims invalid');
    const verifiedClaims = await deps.verifyGithubOidc(assertion, {
      issuer: 'https://token.actions.githubusercontent.com',
      audience: policy.audience,
      algorithms: ['RS256'],
    }, context);
    const authorization = validateGithubOidcClaims(verifiedClaims, policy, deps.nowSeconds());
    validateBinding(value.binding, authorization.binding);
    const firstUse = await deps.claimOidcJti({
      capability: authorization.capability,
      oidcJti: authorization.oidcJti,
      expiresAt: authorization.expiresAt,
      binding: authorization.binding,
      context,
    });
    invariant(firstUse === true, 'OIDC_CLAIMS_INVALID', 'GitHub OIDC assertion replayed');
    const grant = await deps.issueGrant({
      authorization,
      nowSeconds: deps.nowSeconds(),
      ttlSeconds: value.requested_ttl_seconds,
      context,
    });
    invariant(plainRecord(grant)
      && TOKEN_PATTERN.test(grant.accessToken ?? '')
      && Number.isSafeInteger(grant.expiresIn)
      && grant.expiresIn > 0
      && grant.expiresIn <= 600,
    'UPSTREAM_UNAVAILABLE', 'grant issuance failed');
    const response = {
      format: 'beta-job-token/1',
      access_token: grant.accessToken,
      token_type: 'Bearer',
      expires_in: grant.expiresIn,
      binding: authorization.binding,
    };
    if (authorization.capability === 'beta-backup') {
      const scopePrefix = `${deps.r2Prefix}runs/${authorization.binding.runId}/attempt-${authorization.binding.runAttempt}/`;
      const credentials = validateTemporaryCredentials(await deps.createR2TemporaryCredentials({
        bucket: deps.r2Bucket,
        prefix: scopePrefix,
        ttlSeconds: grant.expiresIn,
        authorization,
        context,
      }), grant.expiresIn);
      response.r2_credentials = {
        access_key_id: credentials.accessKeyId,
        secret_access_key: credentials.secretAccessKey,
        session_token: credentials.sessionToken,
        expires_in: credentials.expiresIn,
      };
      response.r2_scope_prefix = scopePrefix;
    }
    return jsonResponse(200, response);
  }

  async function backupView(request, context) {
    const authorization = await authorize(request, 'beta-backup');
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    invariant(keys.every(key => ['view', 'limit', 'cursor'].includes(key))
      && new Set(keys).size === keys.length
      && url.searchParams.get('view') === 'beta_backup_v1'
      && url.searchParams.get('limit') === '1000',
    'REQUEST_INVALID', 'backup view request invalid');
    const cursor = url.searchParams.has('cursor') ? url.searchParams.get('cursor') : null;
    invariant(cursor === null
      || (cursor.length > 0 && cursor.length <= 512 && !/[\r\n]/u.test(cursor)),
    'REQUEST_INVALID', 'backup cursor invalid');
    const page = validateBackupPage(await deps.readBackupPage({
      view: 'beta_backup_v1',
      limit: 1000,
      cursor,
      authorization,
      context,
    }));
    invariant(await deps.recordBackupPageEvidence({
      authorization,
      page,
      cursor,
      context,
    }) === true, 'UPSTREAM_UNAVAILABLE', 'backup snapshot evidence unavailable');
    return jsonResponse(200, page);
  }

  async function backupV2View(request, context) {
    const authorization = await authorize(request, 'beta-backup');
    const url = new URL(request.url);
    const keys = [...url.searchParams.keys()];
    invariant(keys.every(key => ['view', 'limit', 'cursor'].includes(key))
      && new Set(keys).size === keys.length
      && url.searchParams.get('view') === 'rv2_restore_export_v2'
      && url.searchParams.get('limit') === '250',
    'REQUEST_INVALID', 'restore v2 backup view request invalid');
    const cursorText = url.searchParams.has('cursor') ? url.searchParams.get('cursor') : null;
    invariant(cursorText === null || /^(?:0|[1-9][0-9]{0,18})$/u.test(cursorText),
      'REQUEST_INVALID', 'restore v2 backup cursor invalid');
    const cursor = cursorText === null ? null : Number(cursorText);
    invariant(cursor === null || Number.isSafeInteger(cursor),
      'REQUEST_INVALID', 'restore v2 backup cursor invalid');
    const page = validateBackupV2Page(await deps.readBackupV2Page({
      limit: 250, cursor, authorization, context,
    }));
    invariant(await deps.recordBackupV2PageEvidence({
      authorization, page, cursor, context,
    }) === true, 'UPSTREAM_UNAVAILABLE', 'restore v2 backup snapshot evidence unavailable');
    return jsonResponse(200, page);
  }

  async function journalCredentials(request, context) {
    const authorization = await authorizeOneOf(request, ['beta-backup', 'beta-restore']);
    const value = await readBoundedJson(request, 8 * 1024);
    invariant(exactObject(value, ['format', 'binding'])
      && value.format === 'rv-deletion-journal-r2-grant-request/2',
    'REQUEST_INVALID', 'deletion journal R2 grant invalid');
    validateBinding(value.binding, authorization.binding);
    const ttlSeconds = Math.min(600, authorization.expiresAt - deps.nowSeconds());
    invariant(Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0,
      'AUTH_INVALID', 'single-job grant expired');
    const credentials = validateTemporaryCredentials(await deps.createR2TemporaryCredentials({
      bucket: deps.r2Bucket,
      prefix: 'deletion-journal/v2/',
      permission: 'object-read-only',
      ttlSeconds,
      authorization,
      context,
    }), ttlSeconds);
    return jsonResponse(200, {
      format: 'rv-deletion-journal-r2-grant/2',
      prefix: 'deletion-journal/v2/',
      expiresIn: credentials.expiresIn,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      binding: authorization.binding,
    });
  }

  async function capacityObserve(request, context) {
    const authorization = await authorize(request, 'beta-capacity-observe');
    const observation = await validateCapacityObservation(
      await readBoundedJson(request, 32 * 1024),
      authorization.binding,
      deps.nowSeconds(),
    );
    const result = await deps.recordCapacityObservation({
      authorization,
      ...observation,
      context,
    });
    invariant(exactObject(result, [
      'format', 'recorded', 'replayed', 'observedAt', 'externalUsageKnown',
      'admissionAllowed', 'historyAllowed', 'maintenanceReadOnly', 'warningCodes',
    ]) && result.format === 'rv-capacity-observation/1'
      && result.recorded === true
      && typeof result.replayed === 'boolean'
      && result.observedAt === observation.observedAt
      && result.externalUsageKnown === true
      && typeof result.admissionAllowed === 'boolean'
      && typeof result.historyAllowed === 'boolean'
      && typeof result.maintenanceReadOnly === 'boolean'
      && Array.isArray(result.warningCodes)
      && result.warningCodes.length <= 32
      && result.warningCodes.every(code => /^[A-Z0-9_]{3,64}$/u.test(code)),
    'UPSTREAM_UNAVAILABLE', 'capacity observation unavailable');
    return jsonResponse(200, result);
  }

  async function privateAttestation(request, context) {
    const authorization = await authorizeOneOf(request, ['beta-backup', 'beta-restore']);
    const value = await readBoundedJson(request, 8 * 1024);
    invariant(exactObject(value, ['format', 'bucket'])
      && value.format === 'r2-private-access-request/1'
      && value.bucket === deps.r2Bucket,
    'REQUEST_INVALID', 'R2 attestation request invalid');
    let inspection;
    try {
      inspection = await deps.inspectR2PrivateAccess({ bucket: deps.r2Bucket, authorization, context });
    } catch {
      throw new BetaOperationsError('UPSTREAM_UNAVAILABLE', 'R2 inspection unavailable');
    }
    invariant(plainRecord(inspection)
      && inspection.r2DevPublic === false
      && Array.isArray(inspection.activeCustomDomains)
      && inspection.activeCustomDomains.length === 0,
    'UPSTREAM_UNAVAILABLE', 'R2 privacy cannot be proven');
    return jsonResponse(200, {
      format: 'r2-private-access/1',
      bucket: deps.r2Bucket,
      checkedAt: new Date(deps.nowSeconds() * 1000).toISOString(),
      r2DevPublic: false,
      activeCustomDomains: 0,
    });
  }

  async function signManifest(request, context) {
    const authorization = await authorize(request, 'beta-backup');
    const value = await readBoundedJson(request, 1024 * 1024);
    invariant(exactObject(value, ['format', 'binding', 'canonicalManifest', 'manifest'])
      && value.format === 'beta-backup-sign-request/1'
      && typeof value.canonicalManifest === 'string'
      && value.canonicalManifest.length <= 1024 * 1024,
    'REQUEST_INVALID', 'backup signing request invalid');
    validateBinding(value.binding, authorization.binding);
    const verifiedManifest = validateManifest(value.manifest, authorization.binding, deps.r2Prefix);
    invariant(value.canonicalManifest === canonicalJson(verifiedManifest),
      'REQUEST_INVALID', 'backup canonical manifest mismatch');
    const scopePrefix = `${deps.r2Prefix}runs/${authorization.binding.runId}/attempt-${authorization.binding.runAttempt}/`;
    invariant(verifiedManifest.ciphertext.objectKey.startsWith(scopePrefix),
      'REQUEST_INVALID', 'backup object is outside the job scope');
    const objectEvidence = await deps.inspectR2ObjectEvidence({
      authorization,
      bucket: deps.r2Bucket,
      objectKey: verifiedManifest.ciphertext.objectKey,
      expectedBytes: verifiedManifest.ciphertext.bytes,
      expectedSha256: verifiedManifest.ciphertext.sha256,
      context,
    });
    invariant(exactObject(objectEvidence, ['verified', 'objectKey', 'bytes', 'sha256'])
      && objectEvidence.verified === true
      && objectEvidence.objectKey === verifiedManifest.ciphertext.objectKey
      && objectEvidence.bytes === verifiedManifest.ciphertext.bytes
      && objectEvidence.sha256 === verifiedManifest.ciphertext.sha256,
    'UPSTREAM_UNAVAILABLE', 'R2 object evidence unavailable');
    invariant(await deps.claimBackupSigningEvidence({
      authorization,
      manifest: verifiedManifest,
      canonicalManifest: value.canonicalManifest,
      scopePrefix,
      objectEvidence,
      context,
    }) === true, 'UPSTREAM_UNAVAILABLE', 'backup signing evidence unavailable');
    const signature = await deps.signCanonicalManifest({
      keyId: deps.backupSigningKeyId,
      canonicalManifest: value.canonicalManifest,
      authorization,
      context,
    });
    invariant(/^[A-Za-z0-9_-]{80,128}$/u.test(signature ?? ''),
      'UPSTREAM_UNAVAILABLE', 'backup signing failed');
    return jsonResponse(200, {
      format: 'review-workbench-beta-signed-manifest/1',
      algorithm: 'Ed25519',
      keyId: deps.backupSigningKeyId,
      manifest: verifiedManifest,
      signature,
    });
  }

  async function signManifestV2(request, context) {
    const authorization = await authorize(request, 'beta-backup');
    const value = await readBoundedJson(request, 2 * 1024 * 1024);
    invariant(exactObject(value, [
      'format', 'binding', 'canonicalManifest', 'manifest', 'journalProof', 'ciphertext',
    ]) && value.format === 'rv-restore-v2-sign-request/1'
      && typeof value.canonicalManifest === 'string'
      && value.canonicalManifest.length <= 1024 * 1024,
    'REQUEST_INVALID', 'restore v2 backup signing request invalid');
    validateBinding(value.binding, authorization.binding);
    const manifest = validateRestoreV2Manifest(value.manifest);
    invariant(value.canonicalManifest === canonicalJson(manifest),
      'REQUEST_INVALID', 'restore v2 canonical manifest mismatch');
    const journalProof = validateDeletionJournalProof(
      value.journalProof,
      manifest.createdAt,
      manifest.externalJournalRoot,
    );
    const scopePrefix = `${deps.r2Prefix}runs/${authorization.binding.runId}/attempt-${authorization.binding.runAttempt}/`;
    invariant(exactObject(value.ciphertext, ['objectKey', 'sha256', 'bytes'])
      && typeof value.ciphertext.objectKey === 'string'
      && value.ciphertext.objectKey.startsWith(scopePrefix)
      && !value.ciphertext.objectKey.includes('..')
      && !value.ciphertext.objectKey.includes('\\')
      && SHA256_PATTERN.test(value.ciphertext.sha256 ?? '')
      && Number.isSafeInteger(value.ciphertext.bytes)
      && value.ciphertext.bytes > 0,
    'REQUEST_INVALID', 'restore v2 backup ciphertext invalid');
    const objectEvidence = await deps.inspectR2ObjectEvidence({
      authorization,
      bucket: deps.r2Bucket,
      objectKey: value.ciphertext.objectKey,
      expectedBytes: value.ciphertext.bytes,
      expectedSha256: value.ciphertext.sha256,
      context,
    });
    invariant(exactObject(objectEvidence, ['verified', 'objectKey', 'bytes', 'sha256'])
      && objectEvidence.verified === true
      && objectEvidence.objectKey === value.ciphertext.objectKey
      && objectEvidence.bytes === value.ciphertext.bytes
      && objectEvidence.sha256 === value.ciphertext.sha256,
    'UPSTREAM_UNAVAILABLE', 'restore v2 R2 object evidence unavailable');
    invariant(await deps.claimBackupV2SigningEvidence({
      authorization,
      manifest,
      journalProof,
      scopePrefix,
      objectEvidence,
      context,
    }) === true, 'UPSTREAM_UNAVAILABLE', 'restore v2 backup signing evidence unavailable');
    const signature = await deps.signCanonicalManifest({
      keyId: deps.backupSigningKeyId,
      canonicalManifest: RESTORE_V2_SIGNATURE_DOMAIN + value.canonicalManifest,
      authorization,
      context,
    });
    invariant(/^[A-Za-z0-9_-]{80,128}$/u.test(signature ?? ''),
      'UPSTREAM_UNAVAILABLE', 'restore v2 backup signing failed');
    return jsonResponse(200, {
      format: 'rv-restore-snapshot-envelope/2',
      algorithm: 'Ed25519',
      keyId: deps.backupSigningKeyId,
      manifest,
      signature,
    });
  }

  async function restoreTombstone(request, context) {
    const value = validateRestoreTombstone(
      await readBoundedJson(request, 32 * 1024),
      deps.nowSeconds(),
    );
    const signature = request.headers.get('x-beta-tombstone-signature') ?? '';
    invariant(SIGNATURE_PATTERN.test(signature), 'AUTH_INVALID', 'restore authentication invalid');
    invariant(await deps.verifyRestoreTombstoneSignature({ payload: value, signature, context }) === true,
      'AUTH_INVALID', 'restore authentication invalid');
    const applied = await deps.applyDeletionTombstones({
      restoreId: value.restoreId,
      activeGeneration: value.activeGeneration,
      targetGeneration: value.targetGeneration,
      mode: value.mode,
      before: value.issuedAt,
      context,
    });
    invariant(applied?.applied === true, 'UPSTREAM_UNAVAILABLE', 'deletion tombstones unavailable');
    return jsonResponse(200, {
      format: 'beta-restore-tombstone-result/1',
      applied: true,
      restoreId: value.restoreId,
      targetGeneration: value.targetGeneration,
    });
  }

  async function restoreClaim(request, context) {
    const value = validateRestoreClaim(
      await readBoundedJson(request, 32 * 1024),
      policies['beta-backup'],
    );
    const signature = request.headers.get('x-beta-restore-claim-signature') ?? '';
    invariant(SIGNATURE_PATTERN.test(signature), 'AUTH_INVALID', 'restore authentication invalid');
    invariant(await deps.verifyRestoreClaimSignature({ payload: value, signature, context }) === true,
      'AUTH_INVALID', 'restore authentication invalid');
    const claimed = await deps.claimRestoreManifest({ ...value, context });
    invariant(claimed?.accepted === true
      && claimed.firstUse === true
      && /^[A-Za-z0-9_-]{8,128}$/u.test(claimed.leaseSubject ?? ''),
    'REPLAY_DETECTED', 'restore manifest replayed');
    const lease = await deps.issueRestoreLease({
      restoreId: value.restoreId,
      targetGeneration: value.targetGeneration,
      manifestSha256: value.manifestSha256,
      leaseSubject: claimed.leaseSubject,
      nowSeconds: deps.nowSeconds(),
      ttlSeconds: 600,
      context,
    });
    invariant(plainRecord(lease)
      && RESTORE_LEASE_PATTERN.test(lease.restoreLease ?? '')
      && Number.isSafeInteger(lease.expiresAt)
      && lease.expiresAt > deps.nowSeconds()
      && lease.expiresAt <= deps.nowSeconds() + 600,
    'UPSTREAM_UNAVAILABLE', 'restore lease unavailable');
    return jsonResponse(200, {
      format: 'beta-restore-manifest-claim-result/1',
      accepted: true,
      firstUse: true,
      replayDetected: false,
      restoreId: value.restoreId,
      targetGeneration: value.targetGeneration,
      manifestNonce: value.manifestNonce,
      manifestSha256: value.manifestSha256,
      restoreLease: lease.restoreLease,
      leaseExpiresAt: new Date(lease.expiresAt * 1000).toISOString(),
    });
  }

  async function authorizeRestore(request, context) {
    const token = bearer(request);
    invariant(RESTORE_LEASE_PATTERN.test(token), 'AUTH_INVALID', 'restore authentication invalid');
    const lease = await deps.verifyRestoreLease(token, {
      nowSeconds: deps.nowSeconds(),
      context,
    });
    invariant(lease, 'AUTH_INVALID', 'restore authentication invalid');
    return lease;
  }

  async function restoreImportBatch(request, context) {
    const value = validateRestoreImportBatch(
      await readBoundedJson(request, 8 * 1024 * 1024),
    );
    const lease = await authorizeRestore(request, context);
    invariant(lease.restoreId === value.restoreId
      && lease.targetGeneration === value.targetGeneration,
    'AUTH_INVALID', 'restore lease binding mismatch');
    const batchSha256 = await sha256Hex(canonicalJson(value));
    const idempotencyKey = `restore-batch-${batchSha256}`;
    invariant(request.headers.get('idempotency-key') === idempotencyKey,
      'REQUEST_INVALID', 'restore idempotency key invalid');
    // Restore remains deliberately disabled until the signed backup carries a
    // server-verifiable tenant lineage/content root and Auth identities have a
    // separately verified mapping in the target project. Do not stage rows
    // that cannot later be attributed without trusting caller-supplied IDs.
    return restoreNotReadyResponse(value.restoreId, lease);
  }

  async function restoreFinalize(request, context) {
    const value = validateRestoreFinalize(await readBoundedJson(request, 32 * 1024));
    const lease = await authorizeRestore(request, context);
    invariant(lease.restoreId === value.restoreId
      && lease.targetGeneration === value.targetGeneration
      && lease.manifestSha256 === value.manifestSha256,
    'AUTH_INVALID', 'restore lease binding mismatch');
    const idempotencyKey = `restore-finalize-${await sha256Hex(canonicalJson(value))}`;
    invariant(request.headers.get('idempotency-key') === idempotencyKey,
      'REQUEST_INVALID', 'restore idempotency key invalid');
    return restoreNotReadyResponse(value.restoreId, lease);
  }

  async function restoreStatus(request, context) {
    const url = new URL(request.url);
    const pathMatch = url.pathname.match(/\/restore\/([A-Za-z0-9_-]{8,128})\/status$/u);
    const restoreId = pathMatch?.[1] ?? url.searchParams.get('restore_id');
    invariant(ID_PATTERN.test(restoreId ?? '')
      && (pathMatch
        ? !url.search
        : [...url.searchParams.keys()].length === 1
          && url.searchParams.has('restore_id')),
    'REQUEST_INVALID', 'restore status invalid');
    const lease = await authorizeRestore(request, context);
    invariant(lease.restoreId === restoreId, 'AUTH_INVALID', 'restore lease binding mismatch');
    return restoreNotReadyResponse(restoreId, lease);
  }

  async function restoreObjectClaim(request, context) {
    const authorization = await authorize(request, 'beta-restore');
    const value = validateRestoreObjectClaim(
      await readBoundedJson(request, 16 * 1024),
      authorization.binding,
      deps.r2Prefix,
    );
    const ttlSeconds = Math.min(600, authorization.expiresAt - deps.nowSeconds());
    invariant(Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0,
      'AUTH_INVALID', 'single-job grant expired');
    const credentials = validateTemporaryCredentials(await deps.createR2TemporaryCredentials({
      bucket: deps.r2Bucket,
      objects: [value.objectKey],
      permission: 'object-read-only',
      ttlSeconds,
      authorization,
      context,
    }), ttlSeconds);
    return jsonResponse(200, {
      format: 'rv-restore-r2-object-grant/1',
      bucket: deps.r2Bucket,
      objectKey: value.objectKey,
      expiresIn: credentials.expiresIn,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      binding: authorization.binding,
    });
  }

  async function restoreV2Proxy(request, context, operation) {
    const authorization = await authorize(request, 'beta-restore');
    let input;
    if (operation === 'status') {
      const url = new URL(request.url);
      invariant([...url.searchParams.keys()].join(',') === 'restore_id'
        && UUID_PATTERN.test(url.searchParams.get('restore_id') ?? ''),
      'REQUEST_INVALID', 'restore status invalid');
      input = {
        operation,
        restoreId: url.searchParams.get('restore_id'),
        authorization,
        context,
      };
    } else {
      input = {
        operation,
        body: await readBoundedJson(
          request,
          operation === 'stage' ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
        ),
        authorization,
        context,
      };
    }
    const result = assertRestoreProxyResult(await deps.invokeRestoreV2(input));
    return jsonResponse(result.status, result.value);
  }

  async function archiveRequest(request, context) {
    const authorization = await authorize(request, 'beta-archive');
    const value = await readBoundedJson(request, 32 * 1024);
    invariant(exactObject(value, ['format', 'binding'])
      && value.format === 'beta-archive-url-request/1',
    'REQUEST_INVALID', 'archive request invalid');
    validateBinding(value.binding, authorization.binding);
    const oneTime = await deps.createArchiveDownload({ authorization, context });
    invariant(plainRecord(oneTime)
      && ID_PATTERN.test(oneTime.archiveId ?? '')
      && ((oneTime.archiveSha256 === null && oneTime.archiveBytes === null)
        || (SHA256_PATTERN.test(oneTime.archiveSha256 ?? '')
          && Number.isSafeInteger(oneTime.archiveBytes)
          && oneTime.archiveBytes > 0
          && oneTime.archiveBytes <= 32 * 1024 * 1024))
      && typeof oneTime.downloadUrl === 'string'
      && typeof oneTime.expiresAt === 'string',
    'UPSTREAM_UNAVAILABLE', 'archive URL unavailable');
    let url;
    try { url = new URL(oneTime.downloadUrl); } catch {
      throw new BetaOperationsError('UPSTREAM_UNAVAILABLE', 'archive URL unavailable');
    }
    const expiresAt = Date.parse(oneTime.expiresAt);
    invariant(url.protocol === 'https:'
      && url.hostname === deps.archiveDownloadHost
      && !url.username
      && !url.password
      && url.port === ''
      && !url.hash
      && Number.isFinite(expiresAt)
      && expiresAt > deps.nowSeconds() * 1000
      && expiresAt <= Math.min(authorization.expiresAt, deps.nowSeconds() + 600) * 1000,
    'UPSTREAM_UNAVAILABLE', 'archive URL unavailable');
    return jsonResponse(200, {
      format: 'beta-one-time-archive/2',
      single_use: true,
      archive_id: oneTime.archiveId,
      expected_archive_sha256: oneTime.archiveSha256,
      expected_archive_bytes: oneTime.archiveBytes,
      digest_attestation_required: true,
      download_url: oneTime.downloadUrl,
      expires_at: oneTime.expiresAt,
    });
  }

  async function archiveAttest(request, context) {
    const authorization = await authorize(request, 'beta-archive');
    const value = await readBoundedJson(request, 32 * 1024);
    invariant(exactObject(value, [
      'format', 'archiveId', 'archiveSha256', 'archiveBytes',
    ])
      && value.format === 'beta-archive-payload-attestation/1'
      && ID_PATTERN.test(value.archiveId ?? '')
      && SHA256_PATTERN.test(value.archiveSha256 ?? '')
      && Number.isSafeInteger(value.archiveBytes)
      && value.archiveBytes > 0
      && value.archiveBytes <= 32 * 1024 * 1024,
    'REQUEST_INVALID', 'archive payload attestation invalid');
    const result = await deps.attestArchivePayload({ ...value, authorization, context });
    invariant(plainRecord(result)
      && typeof result.accepted === 'boolean'
      && typeof result.replayed === 'boolean'
      && result.archiveId === value.archiveId
      && (result.status === 'ATTESTED' || result.status === 'FAILED')
      && result.accepted === (result.status === 'ATTESTED')
      && (result.archiveSha256 === null || SHA256_PATTERN.test(result.archiveSha256))
      && (result.archiveBytes === null
        || (Number.isSafeInteger(result.archiveBytes) && result.archiveBytes > 0))
      && (result.evidenceSource === null
        || ['UPSTREAM_ATTESTED', 'WORKFLOW_OBSERVED'].includes(result.evidenceSource)),
    'UPSTREAM_UNAVAILABLE', 'archive payload attestation unavailable');
    return jsonResponse(result.accepted ? 200 : 409, {
      format: 'beta-archive-payload-attestation-result/1',
      accepted: result.accepted,
      replayed: result.replayed,
      archiveId: result.archiveId,
      archiveSha256: result.archiveSha256,
      archiveBytes: result.archiveBytes,
      evidenceSource: result.evidenceSource,
      status: result.status,
    });
  }

  async function archiveFail(request, context) {
    const authorization = await authorize(request, 'beta-archive');
    const value = await readBoundedJson(request, 32 * 1024);
    invariant(exactObject(value, ['format', 'archiveId', 'errorCode'])
      && value.format === 'beta-archive-claim-failure/1'
      && ID_PATTERN.test(value.archiveId ?? '')
      && [
        'ARCHIVE_DOWNLOAD_FAILED', 'ARCHIVE_PAYLOAD_INVALID',
        'ARCHIVE_PARSE_FAILED', 'ARCHIVE_INGEST_FAILED',
        'ARCHIVE_FINALIZE_FAILED', 'ARCHIVE_WORKFLOW_FAILED',
      ].includes(value.errorCode),
    'REQUEST_INVALID', 'archive claim failure invalid');
    const result = await deps.failArchiveClaim({ ...value, authorization, context });
    invariant(result?.accepted === true
      && typeof result.replayed === 'boolean'
      && result.archiveId === value.archiveId
      && result.status === 'FAILED',
    'UPSTREAM_UNAVAILABLE', 'archive claim failure unavailable');
    return jsonResponse(200, {
      format: 'beta-archive-claim-failure-result/1',
      accepted: true,
      replayed: result.replayed,
      archiveId: result.archiveId,
      status: 'FAILED',
    });
  }

  async function archiveIngest(request, context) {
    const authorization = await authorize(request, 'beta-archive');
    const value = validateArchiveBatch(await readBoundedJson(request, 8 * 1024 * 1024));
    const result = await deps.ingestArchiveBatch({ ...value, authorization, context });
    invariant(result?.accepted === true
      && SHA256_PATTERN.test(result.batchSha256 ?? '')
      && result.recordCount === value.records.length
      && result.totalBatches === value.totalBatches
      && result.sourceFile === value.sourceFile,
    'UPSTREAM_UNAVAILABLE', 'archive ingest unavailable');
    return jsonResponse(200, {
      format: 'beta-archive-batch-result/1',
      accepted: true,
      archiveId: value.archiveId,
      batchIndex: value.batchIndex,
      batchSha256: result.batchSha256,
      dataset: value.dataset,
      recordCount: result.recordCount,
      sourceFile: result.sourceFile,
      totalBatches: result.totalBatches,
    });
  }

  async function archiveFinalize(request, context) {
    const authorization = await authorize(request, 'beta-archive');
    const value = validateArchiveFinalize(await readBoundedJson(request, 32 * 1024));
    const result = await deps.finalizeArchive({ ...value, authorization, context });
    invariant(plainRecord(result)
      && result.archiveId === value.archiveId
      && (result.status === 'COMPLETED' || result.status === 'CONFLICT')
      && result.accepted === (result.status === 'COMPLETED')
      && typeof result.replayed === 'boolean'
      && SHA256_PATTERN.test(result.finalizeSha256 ?? '')
      && result.batchSetSha256 === value.batchSetSha256
      && Number.isSafeInteger(result.sourceEventCount)
      && result.sourceEventCount >= 0
      && Number.isSafeInteger(result.insertedCount)
      && result.insertedCount >= 0
      && Number.isSafeInteger(result.replayedEventCount)
      && result.replayedEventCount >= 0
      && Number.isSafeInteger(result.conflictCount)
      && result.conflictCount >= 0
      && (result.coverageState === 'PARTIAL' || result.coverageState === 'CONFLICT')
      && (result.gapCode === 'ARCHIVE_RECONCILIATION_PENDING'
        || result.gapCode === 'ARCHIVE_PROVIDER_IDENTITY_CONFLICT')
      && result.trustedAdvanced === false,
    'UPSTREAM_UNAVAILABLE', 'archive finalize unavailable');
    return jsonResponse(200, {
      format: 'beta-archive-finalize-result/1',
      accepted: result.accepted,
      replayed: result.replayed,
      archiveId: result.archiveId,
      status: result.status,
      finalizeSha256: result.finalizeSha256,
      batchSetSha256: result.batchSetSha256,
      sourceEventCount: result.sourceEventCount,
      insertedCount: result.insertedCount,
      replayedEventCount: result.replayedEventCount,
      conflictCount: result.conflictCount,
      coverageState: result.coverageState,
      gapCode: result.gapCode,
      trustedAdvanced: false,
    });
  }

  async function dispatch(request, route, context) {
    if (route === '/internal/v1/token/exchange') return await exchange(request, context);
    if (route === '/internal/v1/backup/view') return await backupView(request, context);
    if (route === '/internal/v2/backup/view') return await backupV2View(request, context);
    if (route === '/internal/v2/r2/journal-credentials') return await journalCredentials(request, context);
    if (route === '/internal/v1/capacity/observe') return await capacityObserve(request, context);
    if (route === '/internal/v1/r2/private-attestation') return await privateAttestation(request, context);
    if (route === '/internal/v1/backup/sign') return await signManifest(request, context);
    if (route === '/internal/v2/backup/sign') return await signManifestV2(request, context);
    if (route === '/internal/v1/restore/tombstone') return await restoreTombstone(request, context);
    if (route === '/internal/v1/restore/manifest-claim') return await restoreClaim(request, context);
    if (route === '/internal/v1/restore/import-batch') return await restoreImportBatch(request, context);
    if (route === '/internal/v1/restore/finalize') return await restoreFinalize(request, context);
    if (route === '/internal/v1/restore/status') return await restoreStatus(request, context);
    if (route === '/internal/v2/restore/object-claim') return await restoreObjectClaim(request, context);
    if (route === '/internal/v2/restore/claim') return await restoreV2Proxy(request, context, 'claim');
    if (route === '/internal/v2/restore/import') return await restoreV2Proxy(request, context, 'stage');
    if (route === '/internal/v2/restore/finalize') return await restoreV2Proxy(request, context, 'publish');
    if (route === '/internal/v2/restore/status') return await restoreV2Proxy(request, context, 'status');
    if (route === '/internal/v1/archive/request') return await archiveRequest(request, context);
    if (route === '/internal/v1/archive/attest') return await archiveAttest(request, context);
    if (route === '/internal/v1/archive/fail') return await archiveFail(request, context);
    if (route === '/internal/v1/archive/ingest') return await archiveIngest(request, context);
    return await archiveFinalize(request, context);
  }

  return async function handle(request) {
    try {
      if (request.headers.has('origin')) return jsonResponse(403, { error: 'forbidden' });
      const route = routePath(request);
      if (!route) return jsonResponse(404, { error: 'not_found' });
      const expectedMethod = route === '/internal/v1/backup/view'
        || route === '/internal/v2/backup/view'
        || route === '/internal/v1/restore/status'
        || route === '/internal/v2/restore/status' ? 'GET' : 'POST';
      if (request.method !== expectedMethod) return jsonResponse(405, { error: 'method_not_allowed' });
      if (route !== '/internal/v1/backup/view'
        && route !== '/internal/v2/backup/view'
        && route !== '/internal/v1/restore/status'
        && route !== '/internal/v2/restore/status'
        && new URL(request.url).search) {
        throw new BetaOperationsError('REQUEST_INVALID', 'query parameters forbidden');
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal.reason ?? 'request aborted');
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort('operations deadline exceeded');
          reject(new BetaOperationsError('UPSTREAM_UNAVAILABLE', 'operations deadline exceeded'));
        }, deadlineMs);
      });
      try {
        return await Promise.race([
          dispatch(request, route, Object.freeze({ signal: controller.signal })),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}
