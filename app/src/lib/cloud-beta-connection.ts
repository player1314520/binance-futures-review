export const BINANCE_BETA_CONSENT_VERSION = 'rv-binance-beta-consent/1' as const;
export const BINANCE_CONNECTIONS_FORMAT = 'rv-binance-connections/1' as const;
export const BINANCE_CONNECTION_STATUS_FORMAT = 'rv-binance-connection-status/1' as const;
export const BINANCE_PERMISSION_EVIDENCE_VERSION = 'rv-binance-permission/1' as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/;
const CONNECTION_STATUSES = new Set([
  'PENDING', 'ACTIVE', 'SYNCING', 'PARTIAL', 'STALE',
  'UNKNOWN', 'CONFLICT', 'DISCONNECTED', 'ERROR',
]);
const COVERAGE_STATES = new Set(['VERIFIED', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT']);
const RECONCILIATION_STATUSES = new Set([
  'pending', 'running', 'match', 'diff', 'unknown', 'failed', 'superseded',
]);

export type CloudConnectionState =
  | 'PENDING' | 'ACTIVE' | 'SYNCING' | 'PARTIAL' | 'STALE'
  | 'UNKNOWN' | 'CONFLICT' | 'DISCONNECTED' | 'ERROR';

export type BinancePermissionEvidence = Readonly<{
  evidenceVersion: typeof BINANCE_PERMISSION_EVIDENCE_VERSION;
  provider: 'binance-usdm';
  readOnly: boolean;
  tradeDisabled: boolean;
  withdrawDisabled: boolean;
  internalTransferDisabled: boolean;
  universalTransferDisabled: boolean;
  checkedAt: string;
  evidenceDigest: string;
}>;

export type CloudConnection = Readonly<{
  connectionId: string;
  status: CloudConnectionState;
  credentialVersion: number;
  lastTrustedAt: string | null;
  nextDueAt: string | null;
  permissionEvidence: BinancePermissionEvidence | null;
}>;

export type CloudConnections = Readonly<{
  format: typeof BINANCE_CONNECTIONS_FORMAT;
  connections: readonly CloudConnection[];
}>;

export type CloudConnectionMutation = Readonly<{
  connectionId: string;
  status: CloudConnectionState;
  credentialVersion: number;
  permissionEvidence: BinancePermissionEvidence | null;
}>;

export type CloudConnectionCoverage = Readonly<{
  dataset: string;
  partitionKey: string;
  coverageState: 'VERIFIED' | 'PARTIAL' | 'STALE' | 'UNKNOWN' | 'CONFLICT';
  attemptedThrough: string | null;
  fetchedThrough: string | null;
  committedThrough: string | null;
  trustedThrough: string | null;
  openGapCount: number;
  currentGeneration: number;
  reconciliationStatus: 'pending' | 'running' | 'match' | 'diff' | 'unknown' | 'failed' | 'superseded';
  lastErrorCode: string | null;
}>;

export type CloudConnectionStatus = Readonly<{
  format: typeof BINANCE_CONNECTION_STATUS_FORMAT;
  connection: CloudConnection;
  coverage: readonly CloudConnectionCoverage[] | null;
  lastErrorCode: string | null;
}>;

export type CloudDisconnectReceipt = Readonly<{
  status: 'DISCONNECTED';
  receiptId: string;
}>;

export class CloudConnectionContractError extends Error {
  readonly code = 'CLOUD_CONNECTION_INVALID';

  constructor() {
    super('CLOUD_CONNECTION_INVALID');
  }
}

function invalid(): never {
  throw new CloudConnectionContractError();
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = plainRecord(value);
  if (!row || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())) invalid();
  return row;
}

function iso(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return value;
}

function code(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) invalid();
  return value;
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function normalizePermissionEvidence(value: unknown): BinancePermissionEvidence {
  const row = exact(value, [
    'evidenceVersion', 'provider', 'readOnly', 'tradeDisabled', 'withdrawDisabled',
    'internalTransferDisabled', 'universalTransferDisabled', 'checkedAt', 'evidenceDigest',
  ]);
  if (
    row.evidenceVersion !== BINANCE_PERMISSION_EVIDENCE_VERSION
    || row.provider !== 'binance-usdm'
    || typeof row.readOnly !== 'boolean'
    || typeof row.tradeDisabled !== 'boolean'
    || typeof row.withdrawDisabled !== 'boolean'
    || typeof row.internalTransferDisabled !== 'boolean'
    || typeof row.universalTransferDisabled !== 'boolean'
    || typeof row.evidenceDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(row.evidenceDigest)
  ) invalid();
  return Object.freeze({
    evidenceVersion: BINANCE_PERMISSION_EVIDENCE_VERSION,
    provider: 'binance-usdm',
    readOnly: row.readOnly,
    tradeDisabled: row.tradeDisabled,
    withdrawDisabled: row.withdrawDisabled,
    internalTransferDisabled: row.internalTransferDisabled,
    universalTransferDisabled: row.universalTransferDisabled,
    checkedAt: iso(row.checkedAt) as string,
    evidenceDigest: row.evidenceDigest,
  });
}

function affirmativeReadOnly(evidence: BinancePermissionEvidence | null): boolean {
  return Boolean(
    evidence?.readOnly
    && evidence.tradeDisabled
    && evidence.withdrawDisabled
    && evidence.internalTransferDisabled
    && evidence.universalTransferDisabled,
  );
}

function normalizeConnection(value: unknown): CloudConnection {
  const row = exact(value, [
    'connectionId', 'status', 'credentialVersion', 'lastTrustedAt', 'nextDueAt',
    'permissionEvidence',
  ]);
  if (
    typeof row.connectionId !== 'string'
    || !UUID_PATTERN.test(row.connectionId)
    || typeof row.status !== 'string'
    || !CONNECTION_STATUSES.has(row.status)
  ) invalid();
  const permissionEvidence = row.permissionEvidence === null
    ? null
    : normalizePermissionEvidence(row.permissionEvidence);
  if (row.status === 'ACTIVE' && !affirmativeReadOnly(permissionEvidence)) invalid();
  return Object.freeze({
    connectionId: row.connectionId,
    status: row.status as CloudConnectionState,
    credentialVersion: positiveVersion(row.credentialVersion),
    lastTrustedAt: iso(row.lastTrustedAt, true),
    nextDueAt: iso(row.nextDueAt, true),
    permissionEvidence,
  });
}

function normalizeCoverage(value: unknown): CloudConnectionCoverage {
  const row = exact(value, [
    'dataset', 'partitionKey', 'coverageState', 'attemptedThrough', 'fetchedThrough',
    'committedThrough', 'trustedThrough', 'openGapCount', 'currentGeneration',
    'reconciliationStatus', 'lastErrorCode',
  ]);
  if (
    typeof row.dataset !== 'string'
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(row.dataset)
    || typeof row.partitionKey !== 'string'
    || row.partitionKey.length < 1
    || row.partitionKey.length > 128
    || typeof row.coverageState !== 'string'
    || !COVERAGE_STATES.has(row.coverageState)
    || !Number.isSafeInteger(row.openGapCount)
    || Number(row.openGapCount) < 0
    || !Number.isSafeInteger(row.currentGeneration)
    || Number(row.currentGeneration) < 0
    || typeof row.reconciliationStatus !== 'string'
    || !RECONCILIATION_STATUSES.has(row.reconciliationStatus)
  ) invalid();
  const attemptedThrough = iso(row.attemptedThrough, true);
  const fetchedThrough = iso(row.fetchedThrough, true);
  const committedThrough = iso(row.committedThrough, true);
  const trustedThrough = iso(row.trustedThrough, true);
  const watermarks = [attemptedThrough, fetchedThrough, committedThrough, trustedThrough];
  for (let index = 1; index < watermarks.length; index += 1) {
    const earlier = watermarks[index - 1];
    const later = watermarks[index];
    if (later !== null && (earlier === null || Date.parse(later) > Date.parse(earlier))) invalid();
  }
  return Object.freeze({
    dataset: row.dataset,
    partitionKey: row.partitionKey,
    coverageState: row.coverageState as CloudConnectionCoverage['coverageState'],
    attemptedThrough,
    fetchedThrough,
    committedThrough,
    trustedThrough,
    openGapCount: Number(row.openGapCount),
    currentGeneration: Number(row.currentGeneration),
    reconciliationStatus: row.reconciliationStatus as CloudConnectionCoverage['reconciliationStatus'],
    lastErrorCode: code(row.lastErrorCode, true),
  });
}

export function normalizeCloudConnections(value: unknown): CloudConnections {
  const row = exact(value, ['format', 'connections']);
  if (row.format !== BINANCE_CONNECTIONS_FORMAT || !Array.isArray(row.connections) || row.connections.length > 10) {
    invalid();
  }
  const connections = row.connections.map(normalizeConnection);
  if (new Set(connections.map((entry) => entry.connectionId)).size !== connections.length) invalid();
  return Object.freeze({
    format: BINANCE_CONNECTIONS_FORMAT,
    connections: Object.freeze(connections),
  });
}

export function normalizeCloudConnectionMutation(value: unknown): CloudConnectionMutation {
  const row = exact(value, ['connectionId', 'status', 'credentialVersion', 'permissionEvidence']);
  if (
    typeof row.connectionId !== 'string'
    || !UUID_PATTERN.test(row.connectionId)
    || typeof row.status !== 'string'
    || !CONNECTION_STATUSES.has(row.status)
  ) invalid();
  const permissionEvidence = row.permissionEvidence === null
    ? null
    : normalizePermissionEvidence(row.permissionEvidence);
  if (row.status === 'ACTIVE' && !affirmativeReadOnly(permissionEvidence)) invalid();
  return Object.freeze({
    connectionId: row.connectionId,
    status: row.status as CloudConnectionState,
    credentialVersion: positiveVersion(row.credentialVersion),
    permissionEvidence,
  });
}

export function normalizeCloudConnectionStatus(value: unknown): CloudConnectionStatus {
  const row = exact(value, ['format', 'connection', 'coverage', 'lastErrorCode']);
  if (row.format !== BINANCE_CONNECTION_STATUS_FORMAT) invalid();
  if (row.coverage !== null && (!Array.isArray(row.coverage) || row.coverage.length > 256)) invalid();
  return Object.freeze({
    format: BINANCE_CONNECTION_STATUS_FORMAT,
    connection: normalizeConnection(row.connection),
    coverage: row.coverage === null
      ? null
      : Object.freeze((row.coverage as unknown[]).map(normalizeCoverage)),
    lastErrorCode: code(row.lastErrorCode, true),
  });
}

export function normalizeCloudDisconnect(value: unknown): CloudDisconnectReceipt {
  const row = exact(value, ['status', 'receiptId']);
  if (row.status !== 'DISCONNECTED' || typeof row.receiptId !== 'string' || !UUID_PATTERN.test(row.receiptId)) {
    invalid();
  }
  return Object.freeze({ status: 'DISCONNECTED', receiptId: row.receiptId });
}
