import { archiveReceipt } from './archive.mjs';

export const INTERNAL_PROTOCOL_VERSION = 'rv-binance-beta-internal/1';

const DEFAULT_DEADLINE_MS = 25_000;
const MAX_BODY_BYTES = 512;
const MAX_PAGE_ROWS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CRON_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]{3,32}$/;
const DATASET_ROUTES = Object.freeze({
  // The first seven names are the persisted rv2 dataset contract. The legacy
  // Binance endpoint names remain accepted only as in-process aliases while
  // old queued test fixtures drain; every downstream write uses the canonical
  // rv2 name.
  fills: Object.freeze({ dataset: 'fills', endpoint: 'userTrades', sourceEndpoint: '/fapi/v1/userTrades' }),
  income: Object.freeze({ dataset: 'income', endpoint: 'income', sourceEndpoint: '/fapi/v1/income' }),
  orders: Object.freeze({ dataset: 'orders', endpoint: 'allOrders', sourceEndpoint: '/fapi/v1/allOrders' }),
  algo_orders: Object.freeze({ dataset: 'algo_orders', endpoint: 'allAlgoOrders', sourceEndpoint: '/fapi/v1/allAlgoOrders' }),
  force_orders: Object.freeze({ dataset: 'force_orders', endpoint: 'forceOrders', sourceEndpoint: '/fapi/v1/forceOrders' }),
  balances: Object.freeze({ dataset: 'balances', endpoint: 'account', sourceEndpoint: '/fapi/v3/account' }),
  positions: Object.freeze({ dataset: 'positions', endpoint: 'positionRisk', sourceEndpoint: '/fapi/v3/positionRisk' }),
  userTrades: Object.freeze({ dataset: 'fills', endpoint: 'userTrades', sourceEndpoint: '/fapi/v1/userTrades' }),
  allOrders: Object.freeze({ dataset: 'orders', endpoint: 'allOrders', sourceEndpoint: '/fapi/v1/allOrders' }),
  allAlgoOrders: Object.freeze({ dataset: 'algo_orders', endpoint: 'allAlgoOrders', sourceEndpoint: '/fapi/v1/allAlgoOrders' }),
  forceOrders: Object.freeze({ dataset: 'force_orders', endpoint: 'forceOrders', sourceEndpoint: '/fapi/v1/forceOrders' }),
  account: Object.freeze({ dataset: 'balances', endpoint: 'account', sourceEndpoint: '/fapi/v3/account' }),
  positionRisk: Object.freeze({ dataset: 'positions', endpoint: 'positionRisk', sourceEndpoint: '/fapi/v3/positionRisk' }),
});
const COVERAGE_STATES = new Set(['COMPLETE', 'PARTIAL', 'STALE', 'UNKNOWN', 'EMPTY', 'CONFLICT']);
const SAFE_FAILURE_CODES = new Set([
  'RATE_LIMITED', 'GLOBAL_CIRCUIT_OPEN', 'AUTH_DISABLED', 'GEO_RESTRICTED',
  'TIMESTAMP_INVALID', 'UPSTREAM_UNAVAILABLE', 'PAGE_INVALID',
  'NORMALIZATION_CONFLICT', 'CREDENTIAL_UNWRAP_FAILED',
]);
const REQUIRED_DEPENDENCIES = Object.freeze([
  'claimSyncJob',
  'decryptCredentialEnvelope',
  'fetchBinancePage',
  'normalizeSourceEvents',
  'buildPostCommitEffect',
  'commitSyncPage',
  'claimPostCommitWork',
  'completePostCommitWork',
  'failPostCommitWork',
  'failSyncJob',
  'createArchiveState',
  'claimArchiveJob',
  'runArchiveStep',
  'commitArchiveState',
  'failArchiveJob',
]);

export class BinanceBetaInternalError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BinanceBetaInternalError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.retryAfterSeconds = Number.isSafeInteger(options.retryAfterSeconds)
      ? options.retryAfterSeconds
      : 0;
  }
}

function exactObject(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validIsoOrNull(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(Date.parse(value)).toISOString() === value;
}

function payloadUsesExactJson(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'undefined') return false;
  if (Array.isArray(value)) return value.length <= MAX_PAGE_ROWS
    && value.every((child) => payloadUsesExactJson(child, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).length <= 256
    && Object.entries(value).every(([key, child]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
      && !['apiKey', 'apiSecret', 'ciphertext', 'tenantId', 'userId', 'requestedBy'].includes(key)
      && payloadUsesExactJson(child, depth + 1));
}

function validQueryInteger(value) {
  return typeof value === 'string'
    && /^\d{1,128}$/u.test(value)
    && BigInt(value).toString() === value;
}

function validateClaimCursor(dataset, query, cursor) {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
  const allowed = {
    fills: new Set(['fromId', 'startTime']),
    income: new Set(['page', 'startTime']),
    orders: new Set(['orderId', 'startTime']),
    algo_orders: new Set(['algoId', 'startTime']),
    force_orders: new Set(['startTime']),
    balances: new Set(),
    positions: new Set(),
  }[dataset];
  if (!allowed) return false;
  const keys = Object.keys(cursor);
  if (keys.length > 1 || keys.some((key) => !allowed.has(key) || !validQueryInteger(cursor[key]))) return false;
  const queryCursorKeys = [...allowed].filter((key) => Object.hasOwn(query, key));
  if (queryCursorKeys.length !== keys.length) return false;
  if (keys.length === 0) return true;
  const [key] = keys;
  return queryCursorKeys[0] === key && query[key] === cursor[key];
}

function validateClaimQuery(route, partitionKey, query) {
  const allowed = {
    fills: new Set(['symbol', 'startTime', 'endTime', 'fromId', 'limit']),
    income: new Set(['symbol', 'incomeType', 'startTime', 'endTime', 'page', 'limit']),
    orders: new Set(['symbol', 'orderId', 'startTime', 'endTime', 'limit']),
    algo_orders: new Set(['symbol', 'algoId', 'startTime', 'endTime', 'limit']),
    force_orders: new Set(['symbol', 'autoCloseType', 'startTime', 'endTime', 'limit']),
    balances: new Set(['omitZeroBalances']),
    positions: new Set(['symbol']),
  }[route.dataset];
  if (!allowed || Object.keys(query).some((key) => !allowed.has(key))) return false;
  if (['fills', 'orders', 'algo_orders'].includes(route.dataset)) {
    if (!SYMBOL_PATTERN.test(partitionKey) || query.symbol !== partitionKey) return false;
  }
  if (Object.hasOwn(query, 'symbol') && !SYMBOL_PATTERN.test(query.symbol ?? '')) return false;
  for (const key of ['startTime', 'endTime', 'fromId', 'orderId', 'algoId', 'page']) {
    if (Object.hasOwn(query, key) && !validQueryInteger(query[key])) return false;
  }
  if (['fills', 'income', 'orders', 'algo_orders', 'force_orders'].includes(route.dataset)
    && query.limit !== MAX_PAGE_ROWS) return false;
  if (Object.hasOwn(query, 'omitZeroBalances') && typeof query.omitZeroBalances !== 'boolean') return false;
  return true;
}

async function readBoundedJson(request, signal, route) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/u.test(contentType)) {
    throw new BinanceBetaInternalError('REQUEST_INVALID', 'application/json required');
  }
  const declaredText = request.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
      throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid internal request');
    }
  }
  if (!request.body) throw new BinanceBetaInternalError('REQUEST_INVALID', 'request body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new BinanceBetaInternalError('DEADLINE_EXCEEDED', 'internal deadline exceeded');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel('request too large');
        throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid internal request');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value = JSON.parse(text);
    if (route === '/internal/v1/sync/cron' || route === '/internal/v1/archive/cron') {
      if (!exactObject(value, ['source']) || value.source !== 'pg_cron') {
        throw new Error('invalid scheduler request');
      }
      return Object.freeze({ source: 'pg_cron' });
    }
    if (!exactObject(value, ['jobId'])) throw new Error('unexpected fields');
    if (!(value.jobId === null || UUID_PATTERN.test(value.jobId ?? ''))) throw new Error('invalid job id');
    return Object.freeze({ jobId: value.jobId === null ? null : value.jobId.toLowerCase() });
  } catch (error) {
    if (error instanceof BinanceBetaInternalError) throw error;
    throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid internal request');
  } finally {
    reader.releaseLock();
  }
}

function routePath(request) {
  const url = new URL(request.url);
  if (url.search || url.hash || url.pathname.includes('%')) return null;
  const suffixes = [
    '/internal/v1/sync/cron', '/internal/v1/archive/cron',
  ];
  for (const suffix of suffixes) {
    if (url.pathname === suffix || url.pathname.endsWith(`/binance-beta${suffix}`)) return suffix;
  }
  return null;
}

function constantTimeCronTokenMatches(candidate, expected) {
  // The configured token has one public, fixed length. Iterate the full fixed
  // width even for a malformed candidate so no matching prefix is exposed.
  const width = 64;
  let difference = String(candidate ?? '').length ^ width;
  for (let index = 0; index < width; index += 1) {
    difference |= (String(candidate ?? '').charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function normalizeGap(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.code !== 'string'
    || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    || !validIsoOrNull(value.from ?? null)
    || !validIsoOrNull(value.to ?? null)
  ) throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid Binance page');
  return Object.freeze({ code: value.code, from: value.from ?? null, to: value.to ?? null });
}

function normalizeClaim(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid job claim');
  }
  if (
    !UUID_PATTERN.test(value.jobId ?? '')
    || !UUID_PATTERN.test(value.attemptId ?? '')
    || !UUID_PATTERN.test(value.claimToken ?? '')
    || !UUID_PATTERN.test(value.connectionId ?? '')
    || !UUID_PATTERN.test(value.tenantId ?? '')
    || !UUID_PATTERN.test(value.requestedBy ?? '')
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !Object.hasOwn(DATASET_ROUTES, value.dataset)
    || typeof value.partitionKey !== 'string'
    || value.partitionKey.length < 1
    || value.partitionKey.length > 128
    || !value.query
    || typeof value.query !== 'object'
    || Array.isArray(value.query)
    || !value.envelope
    || typeof value.envelope !== 'object'
    || Array.isArray(value.envelope)
    || value.envelope.credentialVersion !== value.credentialVersion
    || !value.pageCursor
    || typeof value.pageCursor !== 'object'
    || Array.isArray(value.pageCursor)
    || !Number.isSafeInteger(value.pageNumber)
    || value.pageNumber < 0
    || !(value.previousPageDigest === null || HEX_64_PATTERN.test(value.previousPageDigest ?? ''))
  ) throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid job claim');
  const route = DATASET_ROUTES[value.dataset];
  if (route.dataset === 'fills' && !SYMBOL_PATTERN.test(value.partitionKey)) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'audited symbol partition required');
  }
  if (route.dataset === 'fills' && value.query.symbol !== value.partitionKey) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'audited symbol partition required');
  }
  if (!validateClaimQuery(route, value.partitionKey, value.query)) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid reviewed Binance query');
  }
  if (!validateClaimCursor(route.dataset, value.query, value.pageCursor)) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid persisted page cursor');
  }
  return Object.freeze({
    jobId: value.jobId.toLowerCase(),
    attemptId: value.attemptId.toLowerCase(),
    claimToken: value.claimToken.toLowerCase(),
    connectionId: value.connectionId.toLowerCase(),
    credentialVersion: value.credentialVersion,
    tenantId: value.tenantId.toLowerCase(),
    requestedBy: value.requestedBy.toLowerCase(),
    dataset: route.dataset,
    endpoint: route.endpoint,
    sourceEndpoint: route.sourceEndpoint,
    partitionKey: value.partitionKey,
    query: Object.freeze({ ...value.query }),
    pageCursor: Object.freeze({ ...value.pageCursor }),
    pageNumber: value.pageNumber,
    previousPageDigest: value.previousPageDigest,
    envelope: Object.freeze({ ...value.envelope }),
  });
}

function cursorAdvances(dataset, previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next) || Object.keys(next).length !== 1) return false;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.keys(previous).length > 1) return false;
  const [[nextKey, nextValue]] = Object.entries(next);
  if (!/^\d{1,128}$/u.test(nextValue ?? '')) {
    return false;
  }
  const transitions = {
    fills: { '': 'fromId', startTime: 'fromId', fromId: 'fromId' },
    income: { '': 'page', startTime: 'page', page: 'page' },
    orders: { '': 'orderId', startTime: 'orderId', orderId: 'orderId' },
    algo_orders: { '': 'algoId', startTime: 'algoId', algoId: 'algoId' },
    force_orders: { '': 'startTime', startTime: 'startTime' },
  }[dataset];
  const previousKey = Object.keys(previous)[0] ?? '';
  if (!transitions || transitions[previousKey] !== nextKey) return false;
  if (previousKey !== nextKey) return BigInt(nextValue) > 0n;
  const previousValue = previous[nextKey];
  return /^\d{1,128}$/u.test(previousValue ?? '') && BigInt(nextValue) > BigInt(previousValue);
}

function normalizePage(value) {
  const dateKeys = ['attemptedThrough', 'fetchedThrough', 'committedThrough', 'trustedThrough'];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Array.isArray(value.rows)
    || value.rows.length > MAX_PAGE_ROWS
    || dateKeys.some((key) => !validIsoOrNull(value[key] ?? null))
    || !COVERAGE_STATES.has(String(value.coverageState ?? ''))
    || !Array.isArray(value.gaps)
    || value.gaps.length > 32
    || typeof value.hasMore !== 'boolean'
    || !HEX_64_PATTERN.test(value.pageDigest ?? '')
    || !(value.nextCursor === null || (value.nextCursor && typeof value.nextCursor === 'object' && !Array.isArray(value.nextCursor)))
  ) throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid Binance page');
  return Object.freeze({
    rows: Object.freeze([...value.rows]),
    attemptedThrough: value.attemptedThrough ?? null,
    fetchedThrough: value.fetchedThrough ?? null,
    committedThrough: value.committedThrough ?? null,
    trustedThrough: value.trustedThrough ?? null,
    coverageState: value.coverageState,
    gaps: Object.freeze(value.gaps.map(normalizeGap)),
    nextCursor: value.nextCursor === null ? null : Object.freeze({ ...value.nextCursor }),
    hasMore: value.hasMore,
    pageDigest: value.pageDigest,
  });
}

function normalizedSymbols(events) {
  return [...new Set(events
    .map((event) => event.payload.symbol)
    .filter((symbol) => typeof symbol === 'string' && SYMBOL_PATTERN.test(symbol)))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizePostCommitEffect(value, dataset, events) {
  const symbols = normalizedSymbols(events);
  const ledgerRequired = ['fills', 'income'].includes(dataset);
  if (value === null) throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'post-commit effect missing');
  if (!exactObject(value, ['protocol', 'symbols', 'ledgerShadow'])
    || value.protocol !== 'rv-sync-post-commit/1'
    || !Array.isArray(value.symbols)
    || value.symbols.length > 256
    || value.symbols.some((symbol) => typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol))
    || JSON.stringify(value.symbols) !== JSON.stringify(symbols)) {
    throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'post-commit effect invalid');
  }
  if (!ledgerRequired) {
    if (value.ledgerShadow !== null) {
      throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'post-commit ledger scope invalid');
    }
  } else {
    const shadow = value.ledgerShadow;
    const reconciliationKeys = [
      'protocol', 'stage', 'status', 'realGeneration', 'generation', 'reasonCodes',
      'checks', 'diffs', 'projectionDigest', 'summaryDigest',
    ];
    if (!exactObject(shadow, ['projection', 'reconciliation', 'projectionDigest'])
      || !HEX_64_PATTERN.test(shadow.projectionDigest ?? '')
      || !shadow.projection
      || typeof shadow.projection !== 'object'
      || Array.isArray(shadow.projection)
      || !['rv-ledger-projection/1', 'rv-ledger-shadow-page/1'].includes(shadow.projection.protocol)
      || !payloadUsesExactJson(shadow.projection)
      || JSON.stringify(shadow.projection).length > 1_048_576
      || !exactObject(shadow.reconciliation, reconciliationKeys)
      || shadow.reconciliation.protocol !== 'rv-reconciliation/2'
      || shadow.reconciliation.stage !== 'SHADOW'
      || shadow.reconciliation.status !== 'NOT_EVALUATED'
      || shadow.reconciliation.realGeneration !== false
      || shadow.reconciliation.generation !== null
      || shadow.reconciliation.projectionDigest !== shadow.projectionDigest
      || !HEX_64_PATTERN.test(shadow.reconciliation.summaryDigest ?? '')
      || !Array.isArray(shadow.reconciliation.reasonCodes)
      || shadow.reconciliation.reasonCodes.length > 16
      || !shadow.reconciliation.reasonCodes.includes('ORACLE_NOT_AVAILABLE')
      || !shadow.reconciliation.reasonCodes.includes('PAGE_SCOPED_PROJECTION')
      || !exactObject(shadow.reconciliation.checks, ['balancedEntries', 'assetParity', 'positionParity'])
      || !Array.isArray(shadow.reconciliation.diffs)
      || shadow.reconciliation.diffs.length !== 0
      || !payloadUsesExactJson(shadow.reconciliation)
      || JSON.stringify(shadow.reconciliation).length > 65_536) {
      throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'post-commit ledger invalid');
    }
  }
  return Object.freeze({
    protocol: value.protocol,
    symbols: Object.freeze([...value.symbols]),
    ledgerShadow: value.ledgerShadow === null ? null : Object.freeze({
      projection: value.ledgerShadow.projection,
      reconciliation: value.ledgerShadow.reconciliation,
      projectionDigest: value.ledgerShadow.projectionDigest,
    }),
  });
}

function normalizePostCommitClaim(value, requestedJobId) {
  if (!exactObject(value, [
    'workId', 'jobId', 'connectionId', 'credentialVersion', 'attemptId',
    'leaseToken', 'workKind', 'inputDigest',
  ])
    || !UUID_PATTERN.test(value.workId ?? '')
    || !UUID_PATTERN.test(value.jobId ?? '')
    || !UUID_PATTERN.test(value.connectionId ?? '')
    || !UUID_PATTERN.test(value.leaseToken ?? '')
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !UUID_PATTERN.test(value.attemptId ?? '')
    || value.workKind !== 'SYNC_EFFECTS'
    || !HEX_64_PATTERN.test(value.inputDigest ?? '')
    || (requestedJobId !== null && value.jobId.toLowerCase() !== requestedJobId)) {
    throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid post-commit claim');
  }
  return Object.freeze({
    workId: value.workId.toLowerCase(),
    jobId: value.jobId.toLowerCase(),
    connectionId: value.connectionId.toLowerCase(),
    credentialVersion: value.credentialVersion,
    attemptId: value.attemptId.toLowerCase(),
    leaseToken: value.leaseToken.toLowerCase(),
    workKind: value.workKind,
    inputDigest: value.inputDigest,
  });
}

function normalizePostCommitResult(value, statuses) {
  if (!exactObject(value, ['accepted', 'replayed', 'status'])
    || value.accepted !== true
    || typeof value.replayed !== 'boolean'
    || !statuses.includes(value.status)) {
    throw new BinanceBetaInternalError('UPSTREAM_UNAVAILABLE', 'invalid post-commit response');
  }
  return Object.freeze({ accepted: true, replayed: value.replayed, status: value.status });
}

function normalizeEvent(value, claim) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.eventId !== 'string'
    || value.eventId.length < 1
    || value.eventId.length > 256
    || value.source !== 'BINANCE'
    || value.market !== 'USD_M'
    || value.sourceEndpoint !== claim.sourceEndpoint
    || !validIsoOrNull(value.observedAt)
    || value.observedAt === null
    || !payloadUsesExactJson(value.payload)
    || ['apiKey', 'apiSecret', 'ciphertext', 'tenantId', 'userId', 'requestedBy']
      .some((key) => Object.hasOwn(value, key))
  ) throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'canonical source event invalid');
  return Object.freeze({
    eventId: value.eventId,
    source: 'BINANCE',
    market: 'USD_M',
    sourceEndpoint: value.sourceEndpoint,
    observedAt: value.observedAt,
    payload: Object.freeze({ ...value.payload }),
  });
}

function failureFrom(error) {
  const code = SAFE_FAILURE_CODES.has(String(error?.code)) ? String(error.code) : 'UPSTREAM_UNAVAILABLE';
  const retryable = code === 'UPSTREAM_UNAVAILABLE' ? true : error?.retryable === true;
  const rawRetryAfter = Number(error?.retryAfterSeconds);
  const retryAfterSeconds = Number.isSafeInteger(rawRetryAfter) && rawRetryAfter > 0
    ? Math.min(rawRetryAfter, 3600)
    : 0;
  return Object.freeze({ code, retryable, retryAfterSeconds });
}

function normalizeCommit(value, claim) {
  if (
    !value
    || typeof value !== 'object'
    || value.jobId !== claim.jobId
    || !['QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED'].includes(value.status)
    || !Number.isSafeInteger(value.insertedCount)
    || value.insertedCount < 0
    || !Number.isSafeInteger(value.replayedCount)
    || value.replayedCount < 0
  ) throw new BinanceBetaInternalError('UPSTREAM_UNAVAILABLE', 'invalid commit response', { retryable: true });
  return Object.freeze({
    status: value.status,
    jobId: value.jobId,
    insertedCount: value.insertedCount,
    replayedCount: value.replayedCount,
  });
}

function normalizeArchiveClaim(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !UUID_PATTERN.test(value.jobId ?? '')
    || !UUID_PATTERN.test(value.claimToken ?? '')
    || !UUID_PATTERN.test(value.connectionId ?? '')
    || !UUID_PATTERN.test(value.tenantId ?? '')
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !['fills', 'orders', 'income'].includes(value.dataset)
    || !/^\d{1,128}$/u.test(value.windowStart ?? '')
    || !/^\d{1,128}$/u.test(value.windowEnd ?? '')
    || !(value.state === null || (value.state && typeof value.state === 'object' && !Array.isArray(value.state)))
    || !value.envelope
    || typeof value.envelope !== 'object'
    || Array.isArray(value.envelope)
    || value.envelope.credentialVersion !== value.credentialVersion
  ) throw new BinanceBetaInternalError('PAGE_INVALID', 'invalid archive job claim');
  return Object.freeze({
    jobId: value.jobId.toLowerCase(),
    claimToken: value.claimToken.toLowerCase(),
    connectionId: value.connectionId.toLowerCase(),
    credentialVersion: value.credentialVersion,
    tenantId: value.tenantId.toLowerCase(),
    dataset: value.dataset,
    windowStart: value.windowStart,
    windowEnd: value.windowEnd,
    state: value.state === null ? null : Object.freeze({ ...value.state }),
    envelope: Object.freeze({ ...value.envelope }),
  });
}

export async function runOneArchiveStep(input, deps, context) {
  if (!deps || typeof deps !== 'object' || !UUID_PATTERN.test(deps.workerSubject ?? '')) {
    throw new TypeError('archive worker dependencies required');
  }
  for (const name of [
    'createArchiveState', 'claimArchiveJob', 'decryptCredentialEnvelope', 'runArchiveStep',
    'commitArchiveState', 'failArchiveJob',
  ]) if (typeof deps[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
  if (!(input?.jobId === null || UUID_PATTERN.test(input?.jobId ?? ''))) {
    throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid archive job id');
  }
  let claim = null;
  try {
    const rawClaim = await deps.claimArchiveJob({
      workerSubject: deps.workerSubject,
      jobId: input.jobId,
    }, context);
    if (rawClaim === null) return Object.freeze({ status: 'IDLE', nextAction: 'WAIT' });
    claim = normalizeArchiveClaim(rawClaim);
    if (input.jobId !== null && claim.jobId !== input.jobId) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'claimed archive job mismatch');
    }
    const credentials = await deps.decryptCredentialEnvelope({
      tenantId: claim.tenantId,
      connectionId: claim.connectionId,
      envelope: claim.envelope,
    }, context);
    const initialState = claim.state ?? deps.createArchiveState({
      dataset: claim.dataset,
      startTime: claim.windowStart,
      endTime: claim.windowEnd,
    });
    const state = await deps.runArchiveStep({
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      credentialVersion: claim.credentialVersion,
      credentials,
      state: initialState,
    }, context);
    const committed = await deps.commitArchiveState({
      workerSubject: deps.workerSubject,
      jobId: claim.jobId,
      claimToken: claim.claimToken,
      credentialVersion: claim.credentialVersion,
      state,
    }, context);
    if (!committed || committed.jobId !== claim.jobId || committed.status !== state.status) {
      throw new BinanceBetaInternalError('UPSTREAM_UNAVAILABLE', 'archive state commit unavailable', { retryable: true });
    }
    return archiveReceipt(state);
  } catch (error) {
    if (claim) {
      const failure = failureFrom(error);
      await deps.failArchiveJob({
        workerSubject: deps.workerSubject,
        jobId: claim.jobId,
        claimToken: claim.claimToken,
        credentialVersion: claim.credentialVersion,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryAfterSeconds,
      }, context);
    }
    throw error;
  }
}

export async function runOneSyncPage(input, deps, context) {
  if (!deps || typeof deps !== 'object' || !UUID_PATTERN.test(deps.workerSubject ?? '')) {
    throw new TypeError('worker dependencies required');
  }
  for (const name of [
    'claimSyncJob', 'decryptCredentialEnvelope', 'fetchBinancePage', 'normalizeSourceEvents',
    'buildPostCommitEffect', 'commitSyncPage', 'claimPostCommitWork',
    'completePostCommitWork', 'failPostCommitWork', 'failSyncJob',
  ]) {
    if (typeof deps[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
  }
  if (!(input?.jobId === null || UUID_PATTERN.test(input?.jobId ?? ''))) {
    throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid job id');
  }
  const pendingEffect = await runOnePostCommitWork(input, deps, context);
  if (pendingEffect.status !== 'IDLE') return pendingEffect;
  let claimed = null;
  let sourceCommitted = false;
  try {
    const rawClaim = await deps.claimSyncJob({
      workerSubject: deps.workerSubject,
      jobId: input.jobId,
      queueClass: 'BINANCE_USDM',
    }, context);
    if (rawClaim === null) return Object.freeze({ status: 'IDLE', jobId: null, insertedCount: 0, replayedCount: 0 });
    claimed = normalizeClaim(rawClaim);
    if (input.jobId !== null && claimed.jobId !== input.jobId) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'claimed job mismatch');
    }
    const credentials = await deps.decryptCredentialEnvelope({
      tenantId: claimed.tenantId,
      connectionId: claimed.connectionId,
      envelope: claimed.envelope,
    }, context);
    const page = normalizePage(await deps.fetchBinancePage({
      dataset: claimed.dataset,
      partitionKey: claimed.partitionKey,
      endpoint: claimed.endpoint,
      query: claimed.query,
      pageCursor: claimed.pageCursor,
      previousPageDigest: claimed.previousPageDigest,
      credentials,
    }, context));
    if (page.rows.length === MAX_PAGE_ROWS && !page.hasMore) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'full Binance page requires continuation');
    }
    if (page.hasMore && !cursorAdvances(claimed.dataset, claimed.pageCursor, page.nextCursor)) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'Binance cursor did not advance');
    }
    if (!page.hasMore && page.nextCursor !== null) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'unexpected Binance continuation');
    }
    if (page.pageDigest === claimed.previousPageDigest) {
      throw new BinanceBetaInternalError('PAGE_INVALID', 'repeated Binance page');
    }
    const rawEvents = await deps.normalizeSourceEvents({
      dataset: claimed.dataset,
      partitionKey: claimed.partitionKey,
      sourceEndpoint: claimed.sourceEndpoint,
      rows: page.rows,
      observedThrough: page.fetchedThrough,
    }, context);
    if (!Array.isArray(rawEvents) || rawEvents.length > MAX_PAGE_ROWS) {
      throw new BinanceBetaInternalError('NORMALIZATION_CONFLICT', 'canonical source event page invalid');
    }
    const events = Object.freeze(rawEvents.map((value) => normalizeEvent(value, claimed)));
    const postCommitEffect = normalizePostCommitEffect(
      await deps.buildPostCommitEffect({ dataset: claimed.dataset, events }, context),
      claimed.dataset,
      events,
    );
    const committed = await deps.commitSyncPage({
      workerSubject: deps.workerSubject,
      jobId: claimed.jobId,
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      credentialVersion: claimed.credentialVersion,
      events,
      attemptedThrough: page.attemptedThrough,
      fetchedThrough: page.fetchedThrough,
      committedThrough: page.committedThrough,
      trustedThrough: page.trustedThrough,
      coverageState: page.coverageState,
      gaps: page.gaps,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      pageDigest: page.pageDigest,
      postCommitEffect,
    }, context);
    const result = normalizeCommit(committed, claimed);
    sourceCommitted = true;
    // Best-effort immediate drain reduces latency, while the transactionally
    // persisted work remains reclaimable if this Edge invocation stops here.
    await runOnePostCommitWork({ jobId: claimed.jobId }, deps, context);
    return result;
  } catch (error) {
    if (claimed && !sourceCommitted) {
      const failure = failureFrom(error);
      await deps.failSyncJob({
        workerSubject: deps.workerSubject,
        jobId: claimed.jobId,
        attemptId: claimed.attemptId,
        claimToken: claimed.claimToken,
        credentialVersion: claimed.credentialVersion,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryAfterSeconds,
      }, context);
    }
    throw error;
  }
}

export async function runOnePostCommitWork(input, deps, context) {
  if (!deps || typeof deps !== 'object' || !UUID_PATTERN.test(deps.workerSubject ?? '')) {
    throw new TypeError('worker dependencies required');
  }
  for (const name of ['claimPostCommitWork', 'completePostCommitWork', 'failPostCommitWork']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
  }
  if (!(input?.jobId === null || UUID_PATTERN.test(input?.jobId ?? ''))) {
    throw new BinanceBetaInternalError('REQUEST_INVALID', 'invalid job id');
  }
  const raw = await deps.claimPostCommitWork({
    workerSubject: deps.workerSubject,
    jobId: input.jobId,
  }, context);
  if (raw === null) {
    return Object.freeze({ status: 'IDLE', jobId: null, insertedCount: 0, replayedCount: 0 });
  }
  const work = normalizePostCommitClaim(raw, input.jobId);
  const binding = {
    workerSubject: deps.workerSubject,
    workId: work.workId,
    jobId: work.jobId,
    connectionId: work.connectionId,
    credentialVersion: work.credentialVersion,
    attemptId: work.attemptId,
    leaseToken: work.leaseToken,
    inputDigest: work.inputDigest,
  };
  try {
    const completed = normalizePostCommitResult(
      await deps.completePostCommitWork(binding, context),
      ['COMPLETED'],
    );
    return Object.freeze({
      status: 'POST_COMMIT_COMPLETED',
      jobId: work.jobId,
      insertedCount: 0,
      replayedCount: completed.replayed ? 1 : 0,
    });
  } catch (error) {
    const failure = failureFrom(error);
    try {
      normalizePostCommitResult(await deps.failPostCommitWork({
        ...binding,
        errorCode: failure.code,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryAfterSeconds,
      }, context), ['QUEUED', 'FAILED']);
    } catch {
      // Preserve the original bounded failure. The lease expiry remains the
      // final retry mechanism if the failure-recording RPC is unavailable.
    }
    throw error;
  }
}

function jsonResponse(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function publicError(error) {
  const code = String(error?.code ?? 'UPSTREAM_UNAVAILABLE');
  if (code === 'AUTH_INVALID') return [401, 'authentication_required'];
  if (code === 'REQUEST_INVALID') return [400, 'invalid_request'];
  if (code === 'RATE_LIMITED') return [429, 'rate_limited'];
  if (code === 'GEO_RESTRICTED') return [451, 'geo_restricted'];
  if (code === 'AUTH_DISABLED') return [422, 'credentials_rejected'];
  if (code === 'GLOBAL_CIRCUIT_OPEN') return [503, 'sync_temporarily_paused'];
  return [503, 'sync_unavailable'];
}

export function createBinanceBetaInternalHandler(deps) {
  if (!deps || typeof deps !== 'object' || !UUID_PATTERN.test(deps.workerSubject ?? '')) {
    throw new TypeError('internal dependencies required');
  }
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof deps[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
  }
  if (!CRON_TOKEN_PATTERN.test(deps.syncCronToken ?? '')) throw new TypeError('sync cron token required');
  if (!CRON_TOKEN_PATTERN.test(deps.archiveCronToken ?? '')) throw new TypeError('archive cron token required');
  if (deps.syncCronToken === deps.archiveCronToken) throw new TypeError('independent cron tokens required');
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 30_000) {
    throw new TypeError('invalid internal deadline');
  }
  return async function handleInternal(request) {
    if (request.headers.has('origin')) return jsonResponse(403, { error: 'forbidden' });
    const route = routePath(request);
    if (!route) return jsonResponse(404, { error: 'not_found' });
    if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason ?? 'request aborted');
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('internal deadline'), deadlineMs);
    const context = Object.freeze({ signal: controller.signal });
    try {
      const expectedToken = route === '/internal/v1/sync/cron'
        ? deps.syncCronToken
        : deps.archiveCronToken;
      if (!constantTimeCronTokenMatches(request.headers.get('x-rv-worker-token'), expectedToken)) {
        throw new BinanceBetaInternalError('AUTH_INVALID', 'scheduler token invalid');
      }
      await readBoundedJson(request, controller.signal, route);
      return jsonResponse(200, route === '/internal/v1/archive/cron'
        ? await runOneArchiveStep({ jobId: null }, deps, context)
        : await runOneSyncPage({ jobId: null }, deps, context));
    } catch (error) {
      const [status, code] = publicError(error);
      const retryAfter = Number(error?.retryAfterSeconds);
      return jsonResponse(
        status,
        { error: code },
        status === 429 && Number.isSafeInteger(retryAfter) && retryAfter > 0
          ? { 'Retry-After': String(Math.min(retryAfter, 3600)) }
          : {},
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }
  };
}
