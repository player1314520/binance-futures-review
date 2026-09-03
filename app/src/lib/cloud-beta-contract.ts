export const CLOUD_DATASET_FORMAT = 'rv-cloud-dataset/1' as const;
export const CLOUD_SYNC_PROTOCOL = 'rv-cloud-sync/1' as const;

const COVERAGE_NAMES = [
  'trades',
  'income',
  'orders',
  'algoOrders',
  'forceOrders',
  'balances',
  'positions',
] as const;
const CAPABILITY_NAMES = [
  'recordsBrowsable',
  'observedTradeAnalytics',
  'accountKpis',
  'currentPositions',
  'equityAnalytics',
  'ledger',
  'experiments',
  'ai',
] as const;
const COVERAGE_STATES = new Set(['VERIFIED', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT']);
const RECONCILIATION_STATES = new Set(['PASS', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT']);
const CAPABILITY_DECISIONS = new Set(['ALLOW', 'LIMITED', 'DENY']);
const CHECK_STATES = new Set(['PASS', 'FAIL', 'UNKNOWN']);
const MAX_RECORDS = 10_000;
const MAX_REASON_CODES = 128;
const MAX_GAPS = 256;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 128;
const MAX_JSON_ARRAY = 512;
const MAX_JSON_STRING = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/;
const DECIMAL_ID_PATTERN = /^[0-9]{1,64}$/;
const SERVER_TRADE_ID_PATTERN = /^t_[0-9a-f]{16}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const SECRET_KEY_PATTERN = /(?:api.?secret|api.?key|authorization|credential|password|private.?key|refresh.?token|access.?token)/i;

export type CloudCoverageState = 'VERIFIED' | 'PARTIAL' | 'STALE' | 'UNKNOWN' | 'CONFLICT';
export type CloudCapabilityDecision = 'ALLOW' | 'LIMITED' | 'DENY';

export type CloudCoverageGap = Readonly<{
  code: string;
  from: string | null;
  to: string | null;
}>;

export type CloudCoverage = Readonly<{
  state: CloudCoverageState;
  attempted: string | null;
  fetched: string | null;
  committed: string | null;
  trusted: string | null;
  gaps: readonly CloudCoverageGap[];
}>;

export type CloudCapability = Readonly<{
  decision: CloudCapabilityDecision;
  reasonCodes: readonly string[];
}>;

export type CloudTradeRecord = Readonly<{
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  time: number;
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  realizedPnlAsset: 'USDT' | 'USDC';
}>;

export type CloudTradeModelRecord = Readonly<{
  tradeId: string;
  generation: number;
  payloadSha256: string;
  payload: Readonly<{
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    positionSide: 'BOTH' | 'LONG' | 'SHORT';
    entryTime: number;
    exitTime: number;
    entryPrice: string;
    exitPrice: string;
    qty: string;
    notional: string;
    realizedPnl: string;
    realizedPnlAsset: 'USDT' | 'USDC';
    commissionByAsset: readonly Readonly<{
      asset: string;
      amount: string;
    }>[];
    source: 'binance';
  }>;
}>;

export type CloudReviewRecord = Readonly<{
  reviewId: string;
  tradeId: string;
  version: number;
  updatedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type CloudActionRecord = Readonly<{
  actionId: string;
  reviewId: string;
  tradeId: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  version: number;
  createdAt: string;
  updatedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type CloudJournalRecord = Readonly<{
  journalId: string;
  day: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type CloudRiskRecord = Readonly<{
  ruleId: string;
  status: 'ACTIVE' | 'PAUSED' | 'RETIRED';
  version: number;
  createdAt: string;
  updatedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type CloudReportRecord = Readonly<{
  reportId: string;
  reportType: 'WEEKLY' | 'MONTHLY';
  periodStart: string;
  periodEnd: string;
  sourceGeneration: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type CloudDatasetV1 = Readonly<{
  format: typeof CLOUD_DATASET_FORMAT;
  generation: number;
  asOf: string;
  coverage: Readonly<Record<(typeof COVERAGE_NAMES)[number], CloudCoverage>>;
  reconciliation: Readonly<{
    protocol: 'rv-reconciliation/2';
    status: 'PASS' | 'PARTIAL' | 'STALE' | 'UNKNOWN' | 'CONFLICT';
    reasonCodes: readonly string[];
    checks: Readonly<Record<string, Readonly<{
      status: 'PASS' | 'FAIL' | 'UNKNOWN';
      reasonCodes: readonly string[];
    }>>>;
  }>;
  capabilities: Readonly<Record<(typeof CAPABILITY_NAMES)[number], CloudCapability>>;
  trades: readonly CloudTradeRecord[];
  tradeModels: readonly CloudTradeModelRecord[];
  reviews: readonly CloudReviewRecord[];
  actions: readonly CloudActionRecord[];
  journal: readonly CloudJournalRecord[];
  risk: readonly CloudRiskRecord[];
  reports: readonly CloudReportRecord[];
}>;

export type CloudSyncV1 = Readonly<{
  protocolVersion: typeof CLOUD_SYNC_PROTOCOL;
  status: 'QUEUED';
  jobId: string;
}>;

export class CloudBetaContractError extends Error {
  readonly code: 'CLOUD_DATASET_INVALID' | 'CLOUD_SYNC_INVALID';

  constructor(code: 'CLOUD_DATASET_INVALID' | 'CLOUD_SYNC_INVALID') {
    super(code);
    this.code = code;
  }
}

function invalidDataset(): never {
  throw new CloudBetaContractError('CLOUD_DATASET_INVALID');
}

function invalidSync(): never {
  throw new CloudBetaContractError('CLOUD_SYNC_INVALID');
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const row = plainRecord(value);
  if (!row) invalidDataset();
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(row);
  if (
    required.some((key) => !Object.hasOwn(row, key))
    || keys.some((key) => !allowed.has(key))
  ) invalidDataset();
  return row;
}

function iso(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') invalidDataset();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) invalidDataset();
  return value;
}

function reasonCodes(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > MAX_REASON_CODES
    || value.some((item) => typeof item !== 'string' || !REASON_CODE_PATTERN.test(item))
    || new Set(value).size !== value.length
  ) invalidDataset();
  return Object.freeze([...value]) as readonly string[];
}

function finiteDecimal(value: unknown, positive: boolean): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value) || value.length > 128) invalidDataset();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || (positive && numeric <= 0)) invalidDataset();
  return value;
}

function safeJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) invalidDataset();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidDataset();
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING) invalidDataset();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) invalidDataset();
    return Object.freeze(value.map((item) => safeJson(item, depth + 1)));
  }
  const source = plainRecord(value);
  if (!source) invalidDataset();
  const keys = Object.keys(source);
  if (keys.length > MAX_JSON_KEYS || keys.some((key) => SECRET_KEY_PATTERN.test(key))) invalidDataset();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = safeJson(source[key], depth + 1);
  return Object.freeze(normalized);
}

function normalizeGap(value: unknown): CloudCoverageGap {
  const row = exactRecord(value, ['code', 'from', 'to']);
  if (typeof row.code !== 'string' || !REASON_CODE_PATTERN.test(row.code)) invalidDataset();
  const from = iso(row.from, true);
  const to = iso(row.to, true);
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) invalidDataset();
  return Object.freeze({ code: row.code, from, to });
}

function normalizeCoverage(value: unknown): CloudCoverage {
  const row = exactRecord(value, ['state', 'attempted', 'fetched', 'committed', 'trusted', 'gaps']);
  if (typeof row.state !== 'string' || !COVERAGE_STATES.has(row.state)) invalidDataset();
  const attempted = iso(row.attempted, true);
  const fetched = iso(row.fetched, true);
  const committed = iso(row.committed, true);
  const trusted = iso(row.trusted, true);
  const watermarks = [attempted, fetched, committed, trusted];
  for (let index = 1; index < watermarks.length; index += 1) {
    const earlier = watermarks[index - 1];
    const later = watermarks[index];
    if (later !== null && (earlier === null || Date.parse(later) > Date.parse(earlier))) invalidDataset();
  }
  if (!Array.isArray(row.gaps) || row.gaps.length > MAX_GAPS) invalidDataset();
  return Object.freeze({
    state: row.state as CloudCoverageState,
    attempted,
    fetched,
    committed,
    trusted,
    gaps: Object.freeze(row.gaps.map(normalizeGap)),
  });
}

function normalizeCapability(value: unknown): CloudCapability {
  const row = exactRecord(value, ['decision', 'reasonCodes']);
  if (typeof row.decision !== 'string' || !CAPABILITY_DECISIONS.has(row.decision)) invalidDataset();
  return Object.freeze({
    decision: row.decision as CloudCapabilityDecision,
    reasonCodes: reasonCodes(row.reasonCodes),
  });
}

function normalizeTrade(value: unknown): CloudTradeRecord {
  const row = exactRecord(
    value,
    [
      'id', 'symbol', 'side', 'time', 'price', 'qty', 'commission', 'commissionAsset',
      'realizedPnl', 'realizedPnlAsset',
    ],
    ['positionSide'],
  );
  if (
    typeof row.id !== 'string'
    || !DECIMAL_ID_PATTERN.test(row.id)
    || typeof row.symbol !== 'string'
    || !/^[A-Z0-9]{2,24}(?:USDT|USDC)$/.test(row.symbol)
    || (row.side !== 'BUY' && row.side !== 'SELL')
    || !Number.isSafeInteger(row.time)
    || Number(row.time) < 0
    || typeof row.commissionAsset !== 'string'
    || !/^[A-Z0-9]{2,16}$/.test(row.commissionAsset)
    || !['USDT', 'USDC'].includes(String(row.realizedPnlAsset))
    || !row.symbol.endsWith(String(row.realizedPnlAsset))
    || (Object.hasOwn(row, 'positionSide') && !['BOTH', 'LONG', 'SHORT'].includes(String(row.positionSide)))
  ) invalidDataset();
  const normalized: CloudTradeRecord = {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    time: Number(row.time),
    price: finiteDecimal(row.price, true),
    qty: finiteDecimal(row.qty, true),
    commission: finiteDecimal(row.commission, false),
    commissionAsset: row.commissionAsset,
    realizedPnl: finiteDecimal(row.realizedPnl, false),
    realizedPnlAsset: row.realizedPnlAsset as 'USDT' | 'USDC',
    ...(Object.hasOwn(row, 'positionSide')
      ? { positionSide: row.positionSide as 'BOTH' | 'LONG' | 'SHORT' }
      : {}),
  };
  return Object.freeze(normalized);
}

function normalizeReview(value: unknown): CloudReviewRecord {
  const row = exactRecord(value, ['reviewId', 'tradeId', 'version', 'updatedAt', 'payload']);
  if (
    typeof row.reviewId !== 'string'
    || !UUID_PATTERN.test(row.reviewId)
    || typeof row.tradeId !== 'string'
    || !SERVER_TRADE_ID_PATTERN.test(row.tradeId)
    || !Number.isSafeInteger(row.version)
    || Number(row.version) < 1
  ) invalidDataset();
  const payload = safeJson(row.payload);
  if (!plainRecord(payload)) invalidDataset();
  return Object.freeze({
    reviewId: row.reviewId.toLowerCase(),
    tradeId: row.tradeId,
    version: Number(row.version),
    updatedAt: iso(row.updatedAt) as string,
    payload: payload as Readonly<Record<string, unknown>>,
  });
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidDataset();
  return Number(value);
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidDataset();
  return value.toLowerCase();
}

function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalidDataset();
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    invalidDataset();
  }
  return value;
}

function objectPayload(value: unknown): Readonly<Record<string, unknown>> {
  const payload = safeJson(value);
  if (!plainRecord(payload)) invalidDataset();
  return payload as Readonly<Record<string, unknown>>;
}

function normalizeAction(value: unknown): CloudActionRecord {
  const row = exactRecord(value, [
    'actionId', 'reviewId', 'tradeId', 'status', 'version',
    'createdAt', 'updatedAt', 'payload',
  ]);
  if (
    typeof row.tradeId !== 'string'
    || !SERVER_TRADE_ID_PATTERN.test(row.tradeId)
    || !['OPEN', 'DONE', 'CANCELLED'].includes(String(row.status))
  ) invalidDataset();
  const createdAt = iso(row.createdAt) as string;
  const updatedAt = iso(row.updatedAt) as string;
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidDataset();
  return Object.freeze({
    actionId: uuid(row.actionId),
    reviewId: uuid(row.reviewId),
    tradeId: row.tradeId,
    status: row.status as CloudActionRecord['status'],
    version: version(row.version),
    createdAt,
    updatedAt,
    payload: objectPayload(row.payload),
  });
}

function normalizeTradeModel(value: unknown): CloudTradeModelRecord {
  const row = exactRecord(value, ['tradeId', 'generation', 'payload', 'payloadSha256']);
  const payload = exactRecord(row.payload, [
    'id', 'symbol', 'side', 'positionSide', 'entryTime', 'exitTime',
    'entryPrice', 'exitPrice', 'qty', 'notional', 'realizedPnl',
    'realizedPnlAsset', 'commissionByAsset', 'source',
  ]);
  if (!Array.isArray(payload.commissionByAsset) || payload.commissionByAsset.length > 16) {
    invalidDataset();
  }
  const commissionByAsset = payload.commissionByAsset.map((value) => {
    const commission = exactRecord(value, ['asset', 'amount']);
    if (typeof commission.asset !== 'string' || !/^[A-Z0-9]{2,16}$/.test(commission.asset)) {
      invalidDataset();
    }
    return Object.freeze({
      asset: commission.asset,
      amount: finiteDecimal(commission.amount, false),
    });
  });
  const commissionAssets = commissionByAsset.map((entry) => entry.asset);
  if (
    typeof row.tradeId !== 'string' || !SERVER_TRADE_ID_PATTERN.test(row.tradeId)
    || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1
    || typeof row.payloadSha256 !== 'string' || !SHA256_PATTERN.test(row.payloadSha256)
    || payload.id !== row.tradeId
    || typeof payload.symbol !== 'string' || !/^[A-Z0-9]{2,24}(?:USDT|USDC)$/.test(payload.symbol)
    || !['LONG', 'SHORT'].includes(String(payload.side))
    || !['BOTH', 'LONG', 'SHORT'].includes(String(payload.positionSide))
    || !Number.isSafeInteger(payload.entryTime) || !Number.isSafeInteger(payload.exitTime)
    || Number(payload.entryTime) < 0 || Number(payload.exitTime) < Number(payload.entryTime)
    || !['USDT', 'USDC'].includes(String(payload.realizedPnlAsset))
    || !payload.symbol.endsWith(String(payload.realizedPnlAsset))
    || new Set(commissionAssets).size !== commissionAssets.length
    || commissionAssets.some((asset, index) => index > 0 && commissionAssets[index - 1] >= asset)
    || payload.source !== 'binance'
  ) invalidDataset();
  const normalizedPayload = Object.freeze({
    id: row.tradeId,
    symbol: payload.symbol,
    side: payload.side as 'LONG' | 'SHORT',
    positionSide: payload.positionSide as 'BOTH' | 'LONG' | 'SHORT',
    entryTime: Number(payload.entryTime),
    exitTime: Number(payload.exitTime),
    entryPrice: finiteDecimal(payload.entryPrice, true),
    exitPrice: finiteDecimal(payload.exitPrice, true),
    qty: finiteDecimal(payload.qty, true),
    notional: finiteDecimal(payload.notional, true),
    realizedPnl: finiteDecimal(payload.realizedPnl, false),
    realizedPnlAsset: payload.realizedPnlAsset as 'USDT' | 'USDC',
    commissionByAsset: Object.freeze(commissionByAsset),
    source: 'binance' as const,
  });
  return Object.freeze({
    tradeId: row.tradeId,
    generation: Number(row.generation),
    payloadSha256: row.payloadSha256,
    payload: normalizedPayload,
  });
}

function normalizeJournal(value: unknown): CloudJournalRecord {
  const row = exactRecord(value, [
    'journalId', 'day', 'version', 'createdAt', 'updatedAt', 'payload',
  ]);
  const createdAt = iso(row.createdAt) as string;
  const updatedAt = iso(row.updatedAt) as string;
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidDataset();
  return Object.freeze({
    journalId: uuid(row.journalId),
    day: day(row.day),
    version: version(row.version),
    createdAt,
    updatedAt,
    payload: objectPayload(row.payload),
  });
}

function normalizeRisk(value: unknown): CloudRiskRecord {
  const row = exactRecord(value, [
    'ruleId', 'status', 'version', 'createdAt', 'updatedAt', 'payload',
  ]);
  if (!['ACTIVE', 'PAUSED', 'RETIRED'].includes(String(row.status))) invalidDataset();
  const createdAt = iso(row.createdAt) as string;
  const updatedAt = iso(row.updatedAt) as string;
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidDataset();
  return Object.freeze({
    ruleId: uuid(row.ruleId),
    status: row.status as CloudRiskRecord['status'],
    version: version(row.version),
    createdAt,
    updatedAt,
    payload: objectPayload(row.payload),
  });
}

function normalizeReport(value: unknown): CloudReportRecord {
  const row = exactRecord(value, [
    'reportId', 'reportType', 'periodStart', 'periodEnd', 'sourceGeneration',
    'version', 'createdAt', 'updatedAt', 'payload',
  ]);
  if (
    !['WEEKLY', 'MONTHLY'].includes(String(row.reportType))
    || !Number.isSafeInteger(row.sourceGeneration)
    || Number(row.sourceGeneration) < 1
  ) invalidDataset();
  const periodStart = day(row.periodStart);
  const periodEnd = day(row.periodEnd);
  if (periodEnd < periodStart) invalidDataset();
  const createdAt = iso(row.createdAt) as string;
  const updatedAt = iso(row.updatedAt) as string;
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidDataset();
  return Object.freeze({
    reportId: uuid(row.reportId),
    reportType: row.reportType as CloudReportRecord['reportType'],
    periodStart,
    periodEnd,
    sourceGeneration: Number(row.sourceGeneration),
    version: version(row.version),
    createdAt,
    updatedAt,
    payload: objectPayload(row.payload),
  });
}

export function normalizeCloudDatasetV1(value: unknown): CloudDatasetV1 {
  const source = exactRecord(
    value,
    [
      'format', 'generation', 'asOf', 'coverage', 'reconciliation', 'capabilities',
      'trades', 'tradeModels', 'reviews', 'actions', 'journal', 'risk', 'reports',
    ],
    ['income', 'orders', 'algoOrders', 'forceOrders', 'balances', 'positions'],
  );
  if (
    source.format !== CLOUD_DATASET_FORMAT
    || !Number.isSafeInteger(source.generation)
    || Number(source.generation) < 0
  ) invalidDataset();

  const coverageSource = exactRecord(source.coverage, COVERAGE_NAMES);
  const normalizedCoverage = Object.fromEntries(
    COVERAGE_NAMES.map((name) => [name, normalizeCoverage(coverageSource[name])]),
  ) as Record<(typeof COVERAGE_NAMES)[number], CloudCoverage>;

  const reconciliationSource = exactRecord(
    source.reconciliation,
    ['protocol', 'status', 'reasonCodes', 'checks'],
  );
  if (
    reconciliationSource.protocol !== 'rv-reconciliation/2'
    || typeof reconciliationSource.status !== 'string'
    || !RECONCILIATION_STATES.has(reconciliationSource.status)
  ) invalidDataset();
  const checksSource = plainRecord(reconciliationSource.checks);
  if (!checksSource || Object.keys(checksSource).length > 32) invalidDataset();
  const checks: Record<string, Readonly<{ status: 'PASS' | 'FAIL' | 'UNKNOWN'; reasonCodes: readonly string[] }>> = {};
  for (const [name, rawCheck] of Object.entries(checksSource)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) invalidDataset();
    const check = exactRecord(rawCheck, ['status', 'reasonCodes']);
    if (typeof check.status !== 'string' || !CHECK_STATES.has(check.status)) invalidDataset();
    checks[name] = Object.freeze({
      status: check.status as 'PASS' | 'FAIL' | 'UNKNOWN',
      reasonCodes: reasonCodes(check.reasonCodes),
    });
  }

  const capabilitiesSource = exactRecord(source.capabilities, CAPABILITY_NAMES);
  const capabilities = Object.fromEntries(
    CAPABILITY_NAMES.map((name) => [name, normalizeCapability(capabilitiesSource[name])]),
  ) as Record<(typeof CAPABILITY_NAMES)[number], CloudCapability>;

  if (!Array.isArray(source.trades) || source.trades.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.tradeModels) || source.tradeModels.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.reviews) || source.reviews.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.actions) || source.actions.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.journal) || source.journal.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.risk) || source.risk.length > MAX_RECORDS) invalidDataset();
  if (!Array.isArray(source.reports) || source.reports.length > MAX_RECORDS) invalidDataset();
  const reviews = source.reviews.map(normalizeReview);
  const tradeModels = source.tradeModels.map(normalizeTradeModel);
  const actions = source.actions.map(normalizeAction);
  const journal = source.journal.map(normalizeJournal);
  const risk = source.risk.map(normalizeRisk);
  const reports = source.reports.map(normalizeReport);
  const reviewTrade = new Map(reviews.map((entry) => [entry.reviewId, entry.tradeId]));
  if (actions.some((entry) => reviewTrade.get(entry.reviewId) !== entry.tradeId)) invalidDataset();
  for (const values of [
    reviews.map((entry) => entry.reviewId),
    reviews.map((entry) => entry.tradeId),
    tradeModels.map((entry) => entry.tradeId),
    actions.map((entry) => entry.actionId),
    journal.map((entry) => entry.journalId),
    journal.map((entry) => entry.day),
    risk.map((entry) => entry.ruleId),
    reports.map((entry) => entry.reportId),
  ]) {
    if (new Set(values).size !== values.length) invalidDataset();
  }
  if (reports.some((entry) => entry.sourceGeneration > Number(source.generation))) invalidDataset();
  if (tradeModels.some((entry) => entry.generation !== Number(source.generation))) invalidDataset();
  const modelIds = new Set(tradeModels.map((entry) => entry.tradeId));
  if (reviews.some((entry) => !modelIds.has(entry.tradeId))) invalidDataset();
  for (const key of ['income', 'orders', 'algoOrders', 'forceOrders', 'balances', 'positions']) {
    if (!Object.hasOwn(source, key)) continue;
    const rows = source[key];
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS) invalidDataset();
    rows.forEach((entry) => safeJson(entry));
  }
  const normalized: CloudDatasetV1 = {
    format: CLOUD_DATASET_FORMAT,
    generation: Number(source.generation),
    asOf: iso(source.asOf) as string,
    coverage: Object.freeze(normalizedCoverage),
    reconciliation: Object.freeze({
      protocol: 'rv-reconciliation/2',
      status: reconciliationSource.status as 'PASS' | 'PARTIAL' | 'STALE' | 'UNKNOWN' | 'CONFLICT',
      reasonCodes: reasonCodes(reconciliationSource.reasonCodes),
      checks: Object.freeze(checks),
    }),
    capabilities: Object.freeze(capabilities),
    trades: Object.freeze(source.trades.map(normalizeTrade)),
    tradeModels: Object.freeze(tradeModels),
    reviews: Object.freeze(reviews),
    actions: Object.freeze(actions),
    journal: Object.freeze(journal),
    risk: Object.freeze(risk),
    reports: Object.freeze(reports),
  };
  return Object.freeze(normalized);
}

export function normalizeCloudSyncV1(value: unknown): CloudSyncV1 {
  const source = plainRecord(value);
  if (
    !source
    || Object.keys(source).length !== 3
    || !Object.hasOwn(source, 'protocolVersion')
    || !Object.hasOwn(source, 'status')
    || !Object.hasOwn(source, 'jobId')
    || source.protocolVersion !== CLOUD_SYNC_PROTOCOL
    || source.status !== 'QUEUED'
    || typeof source.jobId !== 'string'
    || !UUID_PATTERN.test(source.jobId)
  ) invalidSync();
  return Object.freeze({
    protocolVersion: CLOUD_SYNC_PROTOCOL,
    status: 'QUEUED',
    jobId: source.jobId,
  });
}
