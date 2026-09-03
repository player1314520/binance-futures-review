// Strict browser-side DTO boundary for the protected loopback API.
// The versioned JSON files under tests/ are a review ledger only; production
// code deliberately contains no fixture loader or filesystem dependency.

import { normalizeBundleQualityV2 } from './data-quality-v2.js';

const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_:-]{0,127}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REVIEW_SCOPE_PATTERN = /^rv1_[0-9a-f]{32}$/u;
const MAX_REASON_CODES = 64;
const MAX_DATASET_ROWS = 1_000_000;
const MAX_JSON_NODES = 2_000_000;
const MAX_FUTURE_EVIDENCE_MS = 5 * 60 * 1000;
const PUBLIC_TOKEN_PATTERN = /^[A-Z0-9][A-Z0-9_.:-]{0,63}$/;
const PUBLIC_ID_PATTERN = /^(0|[1-9]\d{0,19})$/;
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const STATUS_PHASES = Object.freeze(new Set([
  'BOOTSTRAP',
  'READY',
  'SYNCING',
  'PARTIAL',
  'BLOCKED',
  'ERROR',
  'MIGRATION_REQUIRED',
]));
const SYNC_STATES = Object.freeze(new Set([
  'IDLE',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'BLOCKED',
  'ERROR',
]));
const SYNC_PHASES = Object.freeze(new Set([
  'IDLE',
  'PREPARE',
  'INCOME',
  'FILLS',
  'ORDERS',
  'RECONCILIATION',
  'COMMIT',
  'COMPLETE',
  'BLOCKED',
  'ERROR',
]));
const BINANCE_STATES = Object.freeze(new Set([
  'unconfigured',
  'verifying',
  'connected',
  'auth_error',
  'geo_blocked',
  'unavailable',
  'store_error',
]));
const PROFILE_VERDICTS = Object.freeze(new Set([
  'PASS',
  'FAIL',
  'UNKNOWN',
  'STALE',
]));
const PROFILE_CHECKS = Object.freeze([
  'fills',
  'orders',
  'positions',
  'accountConfig',
]);
const RECONCILIATION_V2_CHECKS = Object.freeze([
  'ordinaryOrders',
  'algoOrders',
  'flatBoundaries',
  'modes',
  'income',
  'windowLineage',
]);
const RECONCILIATION_V2_CONSTRAINTS = Object.freeze(new Set([
  'CANCELLED',
  'CREDENTIAL_SCOPE_CHANGED',
  'GEO_RESTRICTED',
  'INSUFFICIENT_HISTORY',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
]));
const ACCEPTANCE_SCENARIOS = Object.freeze({
  paginationBoundary: 'PASS',
  endpointIdentity: 'PASS',
  incomeDelay: 'UNKNOWN_EXPECTED',
  flatBoundaryDrift: 'FAIL_CLOSED',
  modeDrift: 'FAIL_CLOSED',
  cancellation: 'UNKNOWN_EXPECTED',
  rateLimit: 'UNKNOWN_EXPECTED',
  geoRestriction: 'UNKNOWN_EXPECTED',
  permission: 'UNKNOWN_EXPECTED',
  credentialSwitch: 'UNKNOWN_EXPECTED',
});
const ACCEPTANCE_DATASETS = Object.freeze([
  'fills',
  'ordinaryOrders',
  'algoOrders',
  'income',
  'positions',
]);
const ACCEPTANCE_DATASET_STATES = Object.freeze(new Set([
  'COMPLETE',
  'PARTIAL',
  'UNKNOWN',
]));
const COVERAGE_STATES = Object.freeze(new Set([
  'complete',
  'partial',
  'missing',
  'unknown',
]));
const BUNDLE_REQUIRED_FIELDS = Object.freeze([
  'updatedAt',
  'symbols',
  'fills',
  'income',
  'orders',
  'done',
  'coverage',
  '_meta',
]);
const BUNDLE_OPTIONAL_FIELDS = Object.freeze([
  'reviewScope',
  'syncWindow',
  'providerCoverage',
  'reconciliation',
  'ledgerShadowDiagnostic',
]);
const FILL_FIELDS = Object.freeze([
  'id',
  'symbol',
  'pair',
  'side',
  'positionSide',
  'time',
  'price',
  'qty',
  'baseQty',
  'commission',
  'commissionAsset',
  'realizedPnl',
  'marginAsset',
]);
const INCOME_FIELDS = Object.freeze([
  'tranId',
  'symbol',
  'incomeType',
  'income',
  'asset',
  'time',
]);
const ORDER_FIELDS = Object.freeze([
  'orderId',
  'symbol',
  'pair',
  'time',
  'updateTime',
  'cumBase',
]);
const ERROR_CLASSIFICATION = Object.freeze({
  ACCEPTANCE_ALREADY_RUNNING: ['RETRYABLE', true],
  ACCEPTANCE_CANCELLED: ['CAPABILITY_NEUTRAL', false],
  ACCEPTANCE_RUN_NOT_FOUND: ['CAPABILITY_NEUTRAL', false],
  RATE_LIMITED: ['RETRYABLE', true],
  RUNTIME_BUSY: ['RETRYABLE', true],
  SYNC_BUSY: ['RETRYABLE', true],
  REQUEST_TIMEOUT: ['RETRYABLE', true],
  NETWORK_ERROR: ['RETRYABLE', true],
  BINANCE_GEO_BLOCKED: ['TERMINAL', false],
  BINANCE_PERMISSION_DENIED: ['TERMINAL', false],
  INTERNAL_ERROR: ['TERMINAL', false],
  INVALID_REQUEST: ['TERMINAL', false],
  JSON_REQUIRED: ['TERMINAL', false],
  LOCAL_ROUTE_NOT_FOUND: ['TERMINAL', false],
  METHOD_NOT_ALLOWED: ['TERMINAL', false],
  MIGRATION_REQUIRED: ['TERMINAL', false],
  SESSION_REQUIRED: ['TERMINAL', false],
});

function invalid(code) {
  throw new TypeError(code);
}

function plainRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_error) {
    return false;
  }
}

function snapshotRecord(value, allowedFields, options = {}) {
  const allowed = new Set(allowedFields);
  const required = new Set(options.required ?? allowedFields);
  try {
    if (!plainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) return null;
    if ([...required].some((key) => !Object.hasOwn(descriptors, key))) return null;
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch (_error) {
    return null;
  }
}

function denseArray(value, maxLength = MAX_REASON_CODES) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length)
      || length < 0
      || length > maxLength
      || keys.length !== length + 1
      || keys.some((key) => typeof key !== 'string')
    ) return null;
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch (_error) {
    return null;
  }
}

function reasonCodes(value) {
  const source = denseArray(value, MAX_REASON_CODES);
  if (
    !source
    || source.some((code) => typeof code !== 'string' || !REASON_CODE_PATTERN.test(code))
  ) return null;
  const stable = [...new Set(source)].sort();
  return stable.length === source.length
    && stable.every((code, index) => code === source[index])
    ? stable
    : null;
}

function safeInteger(value, options = {}) {
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function safeTimestamp(value, nullable = false) {
  return (nullable && value === null) || safeInteger(value);
}

function safeJsonClone(value) {
  let nodes = 0;
  function visit(item, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > 24) invalid('INVALID_LOOPBACK_BUNDLE');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 4096) invalid('INVALID_LOOPBACK_BUNDLE');
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('INVALID_LOOPBACK_BUNDLE');
      return item;
    }
    const array = denseArray(item, MAX_DATASET_ROWS);
    if (array) return array.map((entry) => visit(entry, depth + 1));
    if (!plainRecord(item)) invalid('INVALID_LOOPBACK_BUNDLE');
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(item);
    } catch (_error) {
      invalid('INVALID_LOOPBACK_BUNDLE');
    }
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string') || keys.length > 512) {
      invalid('INVALID_LOOPBACK_BUNDLE');
    }
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) invalid('INVALID_LOOPBACK_BUNDLE');
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  }
  return visit(value, 0);
}

function cloneTokenArray(value, errorCode) {
  const source = denseArray(value, MAX_DATASET_ROWS);
  if (!source || source.some((entry) => typeof entry !== 'string' || !TOKEN_PATTERN.test(entry))) {
    invalid(errorCode);
  }
  return [...source];
}

function cloneRows(value, fields, required, validator) {
  const source = denseArray(value, MAX_DATASET_ROWS);
  if (!source) invalid('INVALID_LOOPBACK_BUNDLE');
  return source.map((row) => {
    const record = snapshotRecord(row, fields, { required });
    if (!record) invalid('INVALID_LOOPBACK_BUNDLE');
    const cloned = safeJsonClone(record);
    if (typeof validator === 'function' && !validator(cloned)) invalid('INVALID_LOOPBACK_BUNDLE');
    return Object.freeze(cloned);
  });
}

function finiteDecimal(value, minimum = null, inclusive = true) {
  const valid = typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string'
      && value.length <= 128
      && value === value.trim()
      && DECIMAL_PATTERN.test(value)
      && Number.isFinite(Number(value));
  if (!valid) return false;
  if (minimum === null) return true;
  const number = Number(value);
  return inclusive ? number >= minimum : number > minimum;
}

function publicIdentifier(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string'
    && PUBLIC_ID_PATTERN.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n;
}

function publicToken(value) {
  return typeof value === 'string' && PUBLIC_TOKEN_PATTERN.test(value);
}

function usdtSymbol(value) {
  return publicToken(value) && value.endsWith('USDT');
}

function validEpoch(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function optional(value, field, predicate) {
  return !Object.hasOwn(value, field) || predicate(value[field]);
}

function validFillRow(row) {
  return publicIdentifier(row.id)
    && usdtSymbol(row.symbol)
    && ['BUY', 'SELL'].includes(row.side)
    && validEpoch(row.time)
    && finiteDecimal(row.price, 0, false)
    && finiteDecimal(row.qty, 0, false)
    && finiteDecimal(row.commission, 0)
    && finiteDecimal(row.realizedPnl)
    && optional(row, 'pair', usdtSymbol)
    && optional(row, 'positionSide', (value) => ['BOTH', 'LONG', 'SHORT'].includes(value))
    && optional(row, 'baseQty', (value) => finiteDecimal(value, 0, false))
    && optional(row, 'commissionAsset', (value) => value === 'USDT')
    && optional(row, 'marginAsset', (value) => value === 'USDT');
}

function validIncomeRow(row) {
  return publicIdentifier(row.tranId)
    && publicToken(row.incomeType)
    && finiteDecimal(row.income)
    && publicToken(row.asset)
    && validEpoch(row.time)
    && optional(row, 'symbol', usdtSymbol);
}

function validOrderRow(row) {
  return publicIdentifier(row.orderId)
    && usdtSymbol(row.symbol)
    && (
      (Object.hasOwn(row, 'time') && validEpoch(row.time))
      || (Object.hasOwn(row, 'updateTime') && validEpoch(row.updateTime))
    )
    && optional(row, 'pair', usdtSymbol)
    && optional(row, 'cumBase', (value) => finiteDecimal(value, 0))
    && optional(row, 'time', validEpoch)
    && optional(row, 'updateTime', validEpoch);
}

function normalizeRange(value) {
  const range = snapshotRecord(value, ['start', 'endExclusive']);
  if (
    !range
    || !safeInteger(range.start)
    || !safeInteger(range.endExclusive)
    || range.endExclusive < range.start
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({ ...range });
}

function normalizeSyncWindowV1(value, now) {
  const required = [
    'protocol',
    'mode',
    'symbolScope',
    'startTime',
    'endTimeExclusive',
    'successfulThrough',
    'configuredHistoryDays',
  ];
  const source = snapshotRecord(value, [...required, 'reasonCodes'], { required });
  if (
    !source
    || source.protocol !== 'rv-binance-sync-window/1'
    || !['incremental', 'prewarm'].includes(source.mode)
    || ![
      'income-discovered',
      'income-position-discovered',
      'income-open-orders-discovered',
      'income-position-open-orders-discovered',
    ].includes(source.symbolScope)
    || !safeInteger(source.startTime)
    || !safeInteger(source.endTimeExclusive)
    || !safeInteger(source.successfulThrough)
    || source.startTime > source.successfulThrough
    || source.endTimeExclusive !== source.successfulThrough + 1
    || source.successfulThrough > now + MAX_FUTURE_EVIDENCE_MS
    || !safeInteger(source.configuredHistoryDays, { min: 1, max: 3_650 })
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  const reasons = Object.hasOwn(source, 'reasonCodes')
    ? reasonCodes(source.reasonCodes)
    : [];
  if (!reasons) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    ...Object.fromEntries(required.map((field) => [field, source[field]])),
    ...(Object.hasOwn(source, 'reasonCodes') ? { reasonCodes: Object.freeze(reasons) } : {}),
  });
}

function normalizeProviderDatasetV1(value, now) {
  const required = ['protocol', 'status', 'reasonCodes'];
  const optionalFields = [
    'retentionFloor',
    'observedAt',
    'windows',
    'pages',
    'rows',
    'deduplicatedRows',
    'requested',
    'effective',
    'terminalReasons',
  ];
  const source = snapshotRecord(value, [...required, ...optionalFields], { required });
  const reasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || source.protocol !== 'rv-provider-dataset-coverage/1'
    || !['complete', 'partial', 'missing'].includes(source.status)
    || !reasons
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  const output = {
    protocol: source.protocol,
    status: source.status,
    reasonCodes: Object.freeze(reasons),
  };
  for (const field of ['retentionFloor', 'observedAt']) {
    if (Object.hasOwn(source, field)) {
      if (!safeInteger(source[field]) || source[field] > now + MAX_FUTURE_EVIDENCE_MS) {
        invalid('INVALID_LOOPBACK_BUNDLE');
      }
      output[field] = source[field];
    }
  }
  for (const field of ['windows', 'pages', 'rows', 'deduplicatedRows']) {
    if (Object.hasOwn(source, field)) {
      if (!safeInteger(source[field])) invalid('INVALID_LOOPBACK_BUNDLE');
      output[field] = source[field];
    }
  }
  for (const field of ['requested', 'effective']) {
    if (Object.hasOwn(source, field)) output[field] = normalizeRange(source[field]);
  }
  if (Object.hasOwn(source, 'terminalReasons')) {
    const terminalReasons = reasonCodes(source.terminalReasons);
    if (!terminalReasons) invalid('INVALID_LOOPBACK_BUNDLE');
    output.terminalReasons = Object.freeze(terminalReasons);
  }
  return Object.freeze(output);
}

function normalizeProviderCoverageV1(value, now) {
  const source = snapshotRecord(value, ['protocol', 'datasets']);
  const datasets = source && snapshotRecord(source.datasets, [
    'fills',
    'orders',
    'income',
    'positions',
  ]);
  if (!source || source.protocol !== 'rv-provider-coverage/1' || !datasets) {
    invalid('INVALID_LOOPBACK_BUNDLE');
  }
  return Object.freeze({
    protocol: source.protocol,
    datasets: Object.freeze(Object.fromEntries(
      Object.entries(datasets).map(([name, dataset]) => [
        name,
        normalizeProviderDatasetV1(dataset, now),
      ]),
    )),
  });
}

function normalizeReconciliationRange(value) {
  if (value === null) return null;
  const range = snapshotRecord(value, ['startTime', 'endTimeExclusive']);
  if (
    !range
    || !safeInteger(range.startTime)
    || !safeInteger(range.endTimeExclusive)
    || range.endTimeExclusive <= range.startTime
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({ ...range });
}

function normalizeReconciliationV1Check(value) {
  const source = snapshotRecord(value, ['status', 'commonRange', 'rows', 'reasonCodes']);
  const rows = source && snapshotRecord(source.rows, ['left', 'right']);
  const reasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || !['PASS', 'FAIL', 'UNKNOWN'].includes(source.status)
    || !rows
    || !safeInteger(rows.left)
    || !safeInteger(rows.right)
    || !reasons
    || (source.status === 'PASS' ? reasons.length !== 0 : reasons.length === 0)
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    status: source.status,
    commonRange: normalizeReconciliationRange(source.commonRange),
    rows: Object.freeze({ ...rows }),
    reasonCodes: Object.freeze(reasons),
  });
}

function normalizeReconciliationV1(value, now) {
  const source = snapshotRecord(value, ['protocol', 'status', 'generatedAt', 'checks', 'reasonCodes']);
  const names = ['fillsOrders', 'fillsIncome', 'fillsPositions', 'incomeWallet'];
  const checksSource = source && snapshotRecord(source.checks, names);
  const reasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || source.protocol !== 'rv-reconciliation/1'
    || !['PASS', 'FAIL', 'UNKNOWN'].includes(source.status)
    || !safeInteger(source.generatedAt)
    || source.generatedAt > now + MAX_FUTURE_EVIDENCE_MS
    || !checksSource
    || !reasons
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  const checks = Object.fromEntries(names.map((name) => [name, normalizeReconciliationV1Check(checksSource[name])]));
  const statuses = Object.values(checks).map((check) => check.status);
  const derivedStatus = statuses.includes('FAIL')
    ? 'FAIL'
    : statuses.every((status) => status === 'PASS') ? 'PASS' : 'UNKNOWN';
  const derivedReasons = [...new Set(Object.values(checks).flatMap((check) => check.reasonCodes))].sort();
  if (
    source.status !== derivedStatus
    || derivedReasons.length !== reasons.length
    || derivedReasons.some((code, index) => code !== reasons[index])
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    protocol: source.protocol,
    status: source.status,
    generatedAt: source.generatedAt,
    checks: Object.freeze(checks),
    reasonCodes: Object.freeze(reasons),
  });
}

function normalizeReconciliationV2Window(value) {
  const source = snapshotRecord(value, [
    'startTime',
    'endTimeExclusive',
    'successfulThrough',
  ]);
  if (
    !source
    || !safeInteger(source.startTime)
    || !safeInteger(source.endTimeExclusive)
    || !safeInteger(source.successfulThrough)
    || source.startTime >= source.endTimeExclusive
    || source.successfulThrough < source.startTime
    || source.successfulThrough >= source.endTimeExclusive
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({ ...source });
}

function normalizeReconciliationV2Check(value, name) {
  const endpoint = name === 'ordinaryOrders'
    ? '/fapi/v1/allOrders'
    : name === 'algoOrders'
      ? '/fapi/v1/allAlgoOrders'
      : null;
  const source = snapshotRecord(
    value,
    endpoint ? ['endpoint', 'status', 'reasonCodes'] : ['status', 'reasonCodes'],
  );
  const reasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || !['PASS', 'FAIL', 'UNKNOWN'].includes(source.status)
    || !reasons
    || (endpoint && source.endpoint !== endpoint)
    || (source.status === 'PASS' ? reasons.length !== 0 : reasons.length === 0)
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    ...(endpoint ? { endpoint } : {}),
    status: source.status,
    reasonCodes: Object.freeze(reasons),
  });
}

function normalizeReconciliationV2(value, now, syncWindow) {
  const source = snapshotRecord(value, [
    'protocol',
    'status',
    'generatedAt',
    'lineageWindow',
    'checks',
    'reasonCodes',
  ]);
  const topReasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || source.protocol !== 'rv-reconciliation/2'
    || !['PASS', 'FAIL', 'UNKNOWN'].includes(source.status)
    || !safeInteger(source.generatedAt)
    || source.generatedAt > now + MAX_FUTURE_EVIDENCE_MS
    || !topReasons
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  const lineageWindow = normalizeReconciliationV2Window(source.lineageWindow);
  if (
    !syncWindow
    || lineageWindow.startTime !== syncWindow.startTime
    || lineageWindow.endTimeExclusive !== syncWindow.endTimeExclusive
    || lineageWindow.successfulThrough !== syncWindow.successfulThrough
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  const checksSource = snapshotRecord(source.checks, RECONCILIATION_V2_CHECKS);
  if (!checksSource) invalid('INVALID_LOOPBACK_BUNDLE');
  const checks = Object.fromEntries(RECONCILIATION_V2_CHECKS.map((name) => [
    name,
    normalizeReconciliationV2Check(checksSource[name], name),
  ]));
  const checkReasons = [...new Set(
    Object.values(checks).flatMap((check) => check.reasonCodes),
  )].sort();
  if (checkReasons.some((code) => !topReasons.includes(code))) invalid('INVALID_LOOPBACK_BUNDLE');
  const extraReasons = topReasons.filter((code) => !checkReasons.includes(code));
  if (extraReasons.some((code) => !RECONCILIATION_V2_CONSTRAINTS.has(code))) {
    invalid('INVALID_LOOPBACK_BUNDLE');
  }
  const statuses = Object.values(checks).map((check) => check.status);
  const derivedStatus = statuses.includes('FAIL')
    ? 'FAIL'
    : statuses.some((status) => status !== 'PASS') || extraReasons.length > 0
      ? 'UNKNOWN'
      : 'PASS';
  if (source.status !== derivedStatus) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    protocol: source.protocol,
    status: derivedStatus,
    generatedAt: source.generatedAt,
    lineageWindow,
    checks: Object.freeze(checks),
    reasonCodes: Object.freeze(topReasons),
  });
}

function reconciliationProtocol(value) {
  try {
    if (!plainRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocol');
    return descriptor
      && descriptor.enumerable === true
      && Object.hasOwn(descriptor, 'value')
      && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch (_error) {
    return null;
  }
}

function normalizeLedgerShadowDiagnosticV1(value) {
  const source = snapshotRecord(value, [
    'protocol',
    'status',
    'capturedSourceEvents',
    'canonicalEvents',
    'activeClaims',
    'postingCandidates',
    'reasonCodes',
    'canPromoteLedger',
    'blocksBrowseRefresh',
  ]);
  const reasons = source && reasonCodes(source.reasonCodes);
  if (
    !source
    || source.protocol !== 'rv-ledger-stage1b-shadow/1'
    || !['EMPTY', 'MATCH', 'UNKNOWN', 'DIFF'].includes(source.status)
    || !safeInteger(source.capturedSourceEvents)
    || !safeInteger(source.canonicalEvents)
    || !safeInteger(source.activeClaims)
    || !safeInteger(source.postingCandidates)
    || !reasons
    || source.canPromoteLedger !== false
    || source.blocksBrowseRefresh !== false
    || (['EMPTY', 'MATCH'].includes(source.status) ? reasons.length !== 0 : reasons.length === 0)
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  return Object.freeze({
    ...source,
    reasonCodes: Object.freeze(reasons),
  });
}

export function normalizeRuntimeStatusV1(value) {
  const source = snapshotRecord(value, [
    'protocol',
    'phase',
    'updatedAt',
    'rows',
    'failedWindows',
    'cooldownUntil',
    'reviewScope',
    'sync',
    'binance',
  ], { required: [
    'protocol',
    'phase',
    'updatedAt',
    'rows',
    'failedWindows',
    'cooldownUntil',
    'sync',
    'binance',
  ] });
  if (
    !source
    || source.protocol !== 'rv-loopback-status/1'
    || !STATUS_PHASES.has(source.phase)
    || !safeTimestamp(source.updatedAt)
    || !safeInteger(source.rows)
    || !safeInteger(source.failedWindows)
    || !safeTimestamp(source.cooldownUntil)
  ) invalid('INVALID_LOOPBACK_STATUS');

  const sync = snapshotRecord(source.sync, [
    'state',
    'phase',
    'startedAt',
    'updatedAt',
    'fills',
    'reasonCodes',
  ]);
  const syncReasons = sync && reasonCodes(sync.reasonCodes);
  if (
    !sync
    || !SYNC_STATES.has(sync.state)
    || !SYNC_PHASES.has(sync.phase)
    || !safeTimestamp(sync.startedAt, true)
    || !safeTimestamp(sync.updatedAt)
    || !safeInteger(sync.fills)
    || !syncReasons
  ) invalid('INVALID_LOOPBACK_STATUS');

  const binance = snapshotRecord(source.binance, ['connected', 'state', 'canSync']);
  if (
    !binance
    || typeof binance.connected !== 'boolean'
    || !BINANCE_STATES.has(binance.state)
    || typeof binance.canSync !== 'boolean'
    || (binance.connected && binance.state !== 'connected')
    || (binance.canSync && !binance.connected)
  ) invalid('INVALID_LOOPBACK_STATUS');

  const hasReviewScope = Object.hasOwn(source, 'reviewScope');
  if (
    hasReviewScope
    && (
      (source.reviewScope !== null
        && (
          typeof source.reviewScope !== 'string'
          || !REVIEW_SCOPE_PATTERN.test(source.reviewScope)
        ))
      || (binance.connected && source.reviewScope === null)
      || (!binance.connected && source.reviewScope !== null)
    )
  ) invalid('INVALID_LOOPBACK_STATUS');

  const normalized = {
    protocol: source.protocol,
    phase: source.phase,
    updatedAt: source.updatedAt,
    rows: source.rows,
    failedWindows: source.failedWindows,
    cooldownUntil: source.cooldownUntil,
    sync: Object.freeze({ ...sync, reasonCodes: Object.freeze(syncReasons) }),
    binance: Object.freeze({ ...binance }),
  };
  if (hasReviewScope) normalized.reviewScope = source.reviewScope;
  return Object.freeze(normalized);
}

export function normalizeBundleResponseV1(value, options = {}) {
  const fields = [...BUNDLE_REQUIRED_FIELDS, ...BUNDLE_OPTIONAL_FIELDS];
  const source = snapshotRecord(value, fields, { required: BUNDLE_REQUIRED_FIELDS });
  if (!source || !safeTimestamp(source.updatedAt)) invalid('INVALID_LOOPBACK_BUNDLE');
  const coverage = snapshotRecord(source.coverage, [
    'fills',
    'orders',
    'income',
    'positions',
  ]);
  if (!coverage || Object.values(coverage).some((state) => !COVERAGE_STATES.has(state))) {
    invalid('INVALID_LOOPBACK_BUNDLE');
  }
  const meta = snapshotRecord(source._meta, [
    'dataStatus',
    'connected',
    'canSync',
    'syncState',
    'quality',
    'legacyMigrationAvailable',
  ]);
  if (
    !meta
    || !['CURRENT', 'CACHED_ONLY', 'LEGACY_UNBOUND', 'EMPTY'].includes(meta.dataStatus)
    || typeof meta.connected !== 'boolean'
    || typeof meta.canSync !== 'boolean'
    || !['idle', 'running', 'ok', 'error', 'blocked'].includes(meta.syncState)
    || typeof meta.legacyMigrationAvailable !== 'boolean'
    || (meta.canSync && !meta.connected)
    || meta.legacyMigrationAvailable !== (meta.dataStatus === 'LEGACY_UNBOUND')
  ) invalid('INVALID_LOOPBACK_BUNDLE');

  const now = Object.hasOwn(options, 'now') ? options.now : Date.now();
  if (!safeTimestamp(now)) invalid('INVALID_LOOPBACK_BUNDLE');
  const symbols = cloneTokenArray(source.symbols, 'INVALID_LOOPBACK_BUNDLE');
  const done = cloneTokenArray(source.done, 'INVALID_LOOPBACK_BUNDLE');
  if (symbols.some((symbol) => !usdtSymbol(symbol)) || done.some((symbol) => !usdtSymbol(symbol))) {
    invalid('INVALID_LOOPBACK_BUNDLE');
  }
  const normalized = {
    updatedAt: source.updatedAt,
    symbols: Object.freeze(symbols),
    fills: cloneRows(source.fills, FILL_FIELDS, [
      'id', 'symbol', 'side', 'time', 'price', 'qty', 'commission', 'realizedPnl',
    ], validFillRow),
    income: cloneRows(source.income, INCOME_FIELDS, [
      'tranId', 'incomeType', 'income', 'asset', 'time',
    ], validIncomeRow),
    orders: cloneRows(source.orders, ORDER_FIELDS, ['orderId', 'symbol'], validOrderRow),
    done: Object.freeze(done),
    coverage: Object.freeze({ ...coverage }),
  };
  if (Object.hasOwn(source, 'reviewScope')) {
    if (
      (source.reviewScope !== null
        && (typeof source.reviewScope !== 'string'
          || !REVIEW_SCOPE_PATTERN.test(source.reviewScope)))
      || (meta.connected && source.reviewScope === null)
      || (!meta.connected && source.reviewScope !== null)
    ) invalid('INVALID_LOOPBACK_BUNDLE');
    normalized.reviewScope = source.reviewScope;
  }
  if (Object.hasOwn(source, 'syncWindow')) {
    normalized.syncWindow = normalizeSyncWindowV1(source.syncWindow, now);
  }
  if (Object.hasOwn(source, 'providerCoverage')) {
    normalized.providerCoverage = normalizeProviderCoverageV1(source.providerCoverage, now);
  }
  if (Object.hasOwn(source, 'reconciliation')) {
    const protocol = reconciliationProtocol(source.reconciliation);
    if (protocol === 'rv-reconciliation/1') {
      normalized.reconciliation = normalizeReconciliationV1(source.reconciliation, now);
    } else if (protocol === 'rv-reconciliation/2') {
      normalized.reconciliation = normalizeReconciliationV2(
        source.reconciliation,
        now,
        normalized.syncWindow,
      );
    } else {
      invalid('INVALID_LOOPBACK_BUNDLE');
    }
  }
  if (Object.hasOwn(source, 'ledgerShadowDiagnostic')) {
    normalized.ledgerShadowDiagnostic = normalizeLedgerShadowDiagnosticV1(
      source.ledgerShadowDiagnostic,
    );
  }
  const quality = normalizeBundleQualityV2(value, options);
  if (
    quality.capabilities.recordsBrowsable.decision === 'DENY'
    && [normalized.symbols, normalized.fills, normalized.income, normalized.orders, normalized.done]
      .some((rows) => rows.length > 0)
  ) invalid('INVALID_LOOPBACK_BUNDLE');
  normalized._meta = Object.freeze({
    dataStatus: meta.dataStatus,
    connected: meta.connected,
    canSync: meta.canSync,
    syncState: meta.syncState,
    quality,
    legacyMigrationAvailable: meta.legacyMigrationAvailable,
  });
  normalized.fills = Object.freeze(normalized.fills);
  normalized.income = Object.freeze(normalized.income);
  normalized.orders = Object.freeze(normalized.orders);
  return Object.freeze(normalized);
}

export function normalizeProfileEvaluationV1(value) {
  const source = snapshotRecord(value, [
    'protocol',
    'verdict',
    'confirmable',
    'proposalId',
    'expiresAt',
    'checks',
  ]);
  if (
    !source
    || source.protocol !== 'rv-binance-account-profile-proposal-evaluation/1'
    || !PROFILE_VERDICTS.has(source.verdict)
    || typeof source.confirmable !== 'boolean'
    || typeof source.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(source.expiresAt))
  ) invalid('INVALID_PROFILE_EVALUATION');
  if (
    source.confirmable !== (source.verdict === 'PASS')
    || (source.confirmable
      ? typeof source.proposalId !== 'string' || !/^[0-9a-f]{32}$/u.test(source.proposalId)
      : source.proposalId !== null)
  ) invalid('INVALID_PROFILE_EVALUATION');
  const checksSource = snapshotRecord(source.checks, PROFILE_CHECKS);
  if (!checksSource) invalid('INVALID_PROFILE_EVALUATION');
  const checks = {};
  for (const name of PROFILE_CHECKS) {
    const check = snapshotRecord(checksSource[name], ['verdict', 'rows', 'reasonCodes']);
    const reasons = check && reasonCodes(check.reasonCodes);
    if (
      !check
      || !PROFILE_VERDICTS.has(check.verdict)
      || !safeInteger(check.rows, { max: 1_000_000_000 })
      || !reasons
    ) invalid('INVALID_PROFILE_EVALUATION');
    checks[name] = Object.freeze({ ...check, reasonCodes: Object.freeze(reasons) });
  }
  return Object.freeze({
    protocol: source.protocol,
    verdict: source.verdict,
    confirmable: source.confirmable,
    proposalId: source.proposalId,
    expiresAt: source.expiresAt,
    checks: Object.freeze(checks),
  });
}

export function normalizeProfileEvaluationRequestV1(value) {
  const source = snapshotRecord(value, ['apiKey', 'apiSecret']);
  if (
    !source
    || typeof source.apiKey !== 'string'
    || source.apiKey.length < 1
    || source.apiKey.length > 1024
    || typeof source.apiSecret !== 'string'
    || source.apiSecret.length < 1
    || source.apiSecret.length > 1024
  ) invalid('INVALID_PROFILE_EVALUATION_REQUEST');
  return { apiKey: source.apiKey, apiSecret: source.apiSecret };
}

export function normalizeProfileConfirmationV1(value) {
  const source = snapshotRecord(value, ['confirmed']);
  if (!source || source.confirmed !== true) invalid('INVALID_PROFILE_CONFIRMATION');
  return Object.freeze({ confirmed: true });
}

export function normalizeProfileConfirmationRequestV1(value) {
  const source = snapshotRecord(value, [
    'apiKey',
    'apiSecret',
    'proposalId',
    'confirmed',
  ]);
  if (
    !source
    || typeof source.apiKey !== 'string'
    || source.apiKey.length < 1
    || source.apiKey.length > 1024
    || typeof source.apiSecret !== 'string'
    || source.apiSecret.length < 1
    || source.apiSecret.length > 1024
    || typeof source.proposalId !== 'string'
    || !/^[0-9a-f]{32}$/u.test(source.proposalId)
    || source.confirmed !== true
  ) invalid('INVALID_PROFILE_CONFIRMATION_REQUEST');
  return {
    apiKey: source.apiKey,
    apiSecret: source.apiSecret,
    proposalId: source.proposalId,
    confirmed: true,
  };
}

export function normalizeSyncRecentV1(value) {
  const started = snapshotRecord(value, ['started']);
  if (started && started.started === true) {
    return Object.freeze({ state: 'STARTED', reasonCodes: Object.freeze([]) });
  }
  const busy = snapshotRecord(value, ['started', 'busy']);
  if (busy && busy.started === false && busy.busy === true) {
    return Object.freeze({
      state: 'BUSY',
      reasonCodes: Object.freeze(['SYNC_BUSY']),
    });
  }
  const blocked = snapshotRecord(value, ['started', 'error']);
  if (blocked && blocked.started === false) {
    const map = {
      migration_required: 'MIGRATION_REQUIRED',
      not_connected: 'BINANCE_NOT_CONNECTED',
    };
    if (Object.hasOwn(map, blocked.error)) {
      return Object.freeze({
        state: 'BLOCKED',
        reasonCodes: Object.freeze([map[blocked.error]]),
      });
    }
  }
  invalid('INVALID_SYNC_RESPONSE');
}

export function normalizeBinanceAcceptanceRequestV1(value) {
  const source = snapshotRecord(value, ['confirmed']);
  if (!source || source.confirmed !== true) invalid('INVALID_BINANCE_ACCEPTANCE_REQUEST');
  return Object.freeze({ confirmed: true });
}

export function normalizeBinanceAcceptanceV1(value) {
  const source = snapshotRecord(value, [
    'protocol',
    'runState',
    'coverageState',
    'evidenceState',
  ]);
  if (!source || source.protocol !== 'rv-binance-acceptance/1') {
    invalid('INVALID_BINANCE_ACCEPTANCE');
  }

  const run = snapshotRecord(source.runState, [
    'status',
    'synthetic',
    'startedAt',
    'completedAt',
  ]);
  if (
    !run
    || !['RUNNING', 'COMPLETED', 'FAILED'].includes(run.status)
    || run.synthetic !== true
    || !safeTimestamp(run.startedAt)
    || (
      run.status === 'RUNNING'
        ? run.completedAt !== null
        : !safeTimestamp(run.completedAt) || run.completedAt < run.startedAt
    )
  ) invalid('INVALID_BINANCE_ACCEPTANCE');

  const coverage = snapshotRecord(source.coverageState, [
    'status',
    'endpointIdentity',
    'scenarios',
    'datasets',
    'reasonCodes',
  ], { required: ['status', 'endpointIdentity', 'reasonCodes'] });
  const coverageReasons = coverage && reasonCodes(coverage.reasonCodes);
  const endpoints = coverage && snapshotRecord(coverage.endpointIdentity, [
    'ordinaryOrders',
    'algoOrders',
  ]);
  if (
    !coverage
    || !['PENDING', 'PARTIAL', 'UNKNOWN'].includes(coverage.status)
    || !coverageReasons
    || !endpoints
    || endpoints.ordinaryOrders !== '/fapi/v1/allOrders'
    || endpoints.algoOrders !== '/fapi/v1/allAlgoOrders'
  ) invalid('INVALID_BINANCE_ACCEPTANCE');

  let scenarios;
  let datasets;
  if (coverage.status === 'PARTIAL') {
    scenarios = snapshotRecord(coverage.scenarios, Object.keys(ACCEPTANCE_SCENARIOS));
    datasets = snapshotRecord(coverage.datasets, ACCEPTANCE_DATASETS);
    if (
      !scenarios
      || !datasets
      || Object.entries(ACCEPTANCE_SCENARIOS).some(([name, expected]) => scenarios[name] !== expected)
      || Object.values(datasets).some((state) => !ACCEPTANCE_DATASET_STATES.has(state))
    ) invalid('INVALID_BINANCE_ACCEPTANCE');
  } else if (Object.hasOwn(coverage, 'scenarios') || Object.hasOwn(coverage, 'datasets')) {
    invalid('INVALID_BINANCE_ACCEPTANCE');
  }

  const evidence = snapshotRecord(source.evidenceState, [
    'status',
    'protocols',
    'reconciliationStatus',
    'dataQualityStatus',
    'strongCapabilities',
    'ledger',
    'reasonCodes',
  ], { required: [
    'status',
    'protocols',
    'strongCapabilities',
    'ledger',
    'reasonCodes',
  ] });
  const evidenceReasons = evidence && reasonCodes(evidence.reasonCodes);
  const protocols = evidence && snapshotRecord(evidence.protocols, [
    'reconciliation',
    'dataQuality',
  ]);
  if (
    !evidence
    || !['PENDING', 'SYNTHETIC', 'UNKNOWN'].includes(evidence.status)
    || !evidenceReasons
    || !protocols
    || protocols.reconciliation !== 'rv-reconciliation/2'
    || protocols.dataQuality !== 'rv-data-quality/3'
    || evidence.strongCapabilities !== 'DENY'
    || evidence.ledger !== 'DENY'
  ) invalid('INVALID_BINANCE_ACCEPTANCE');
  const hasEvidenceResults = Object.hasOwn(evidence, 'reconciliationStatus')
    || Object.hasOwn(evidence, 'dataQualityStatus');
  if (evidence.status === 'SYNTHETIC') {
    if (
      !Object.hasOwn(evidence, 'reconciliationStatus')
      || !Object.hasOwn(evidence, 'dataQualityStatus')
      || !['PASS', 'FAIL', 'UNKNOWN'].includes(evidence.reconciliationStatus)
      || !['VALID', 'PARTIAL', 'FAILED'].includes(evidence.dataQualityStatus)
    ) invalid('INVALID_BINANCE_ACCEPTANCE');
  } else if (hasEvidenceResults) {
    invalid('INVALID_BINANCE_ACCEPTANCE');
  }

  const stateTuple = `${run.status}/${coverage.status}/${evidence.status}`;
  if (![
    'RUNNING/PENDING/PENDING',
    'COMPLETED/PARTIAL/SYNTHETIC',
    'FAILED/UNKNOWN/UNKNOWN',
  ].includes(stateTuple)) invalid('INVALID_BINANCE_ACCEPTANCE');
  if (
    run.status === 'RUNNING'
    && (
      coverageReasons.length !== 0
      || evidenceReasons.length !== 1
      || evidenceReasons[0] !== 'SYNTHETIC_EVIDENCE_ONLY'
    )
  ) invalid('INVALID_BINANCE_ACCEPTANCE');
  if (
    run.status === 'COMPLETED'
    && (
      !coverageReasons.includes('SYNTHETIC_EVIDENCE_ONLY')
      || !evidenceReasons.includes('SYNTHETIC_EVIDENCE_ONLY')
      || coverageReasons.length !== evidenceReasons.length
      || coverageReasons.some((code, index) => code !== evidenceReasons[index])
      || !Object.values(datasets).some((status) => status !== 'COMPLETE')
      || (
        evidence.reconciliationStatus === 'PASS'
        && evidence.dataQualityStatus === 'VALID'
      )
    )
  ) invalid('INVALID_BINANCE_ACCEPTANCE');
  if (
    run.status === 'FAILED'
    && (
      !coverageReasons.includes('SYNTHETIC_SUITE_FAILED')
      || !evidenceReasons.includes('SYNTHETIC_SUITE_FAILED')
    )
  ) invalid('INVALID_BINANCE_ACCEPTANCE');

  const normalizedCoverage = {
    status: coverage.status,
    endpointIdentity: Object.freeze({ ...endpoints }),
  };
  if (scenarios) normalizedCoverage.scenarios = Object.freeze({ ...scenarios });
  if (datasets) normalizedCoverage.datasets = Object.freeze({ ...datasets });
  normalizedCoverage.reasonCodes = Object.freeze(coverageReasons);

  const normalizedEvidence = {
    status: evidence.status,
    protocols: Object.freeze({ ...protocols }),
  };
  if (evidence.status === 'SYNTHETIC') {
    normalizedEvidence.reconciliationStatus = evidence.reconciliationStatus;
    normalizedEvidence.dataQualityStatus = evidence.dataQualityStatus;
  }
  normalizedEvidence.strongCapabilities = 'DENY';
  normalizedEvidence.ledger = 'DENY';
  normalizedEvidence.reasonCodes = Object.freeze(evidenceReasons);

  return Object.freeze({
    protocol: source.protocol,
    runState: Object.freeze({ ...run }),
    coverageState: Object.freeze(normalizedCoverage),
    evidenceState: Object.freeze(normalizedEvidence),
  });
}

export function normalizeLoopbackErrorV1(value, status = 0) {
  const source = snapshotRecord(value, ['error']);
  const candidate = source && typeof source.error === 'string' && REASON_CODE_PATTERN.test(source.error)
    ? source.error
    : '';
  const classification = ERROR_CLASSIFICATION[candidate];
  const code = classification ? candidate : 'UNRECOGNIZED_LOOPBACK_ERROR';
  return Object.freeze({
    protocol: 'rv-loopback-error/1',
    code,
    classification: classification?.[0] ?? 'TERMINAL',
    retryable: classification?.[1] ?? false,
    status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
  });
}
