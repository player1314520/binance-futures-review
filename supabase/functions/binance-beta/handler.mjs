export const CANONICAL_ORIGIN = 'https://binance-futures-review-web.vercel.app';
export const CONSENT_VERSION = 'rv-binance-beta-consent/1';
export const CONNECTIONS_FORMAT = 'rv-binance-connections/1';
export const DATASET_FORMAT = 'rv-cloud-dataset/1';
export const TRADES_FORMAT = 'rv-cloud-trades/1';
export const REVIEWS_FORMAT = 'rv-cloud-reviews/1';
export const REVIEW_FORMAT = 'rv-cloud-review/1';
export const MUTATION_FORMAT = 'rv-cloud-mutation/1';

const MAX_BODY_BYTES = 256 * 1_024;
const DEFAULT_DEADLINE_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9]{16,256}$/;
const JWT_PART_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRADE_ID_PATTERN = /^t_[0-9a-f]{16}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECOVERY_SECRET_PATTERN = /^rvr1_[A-Za-z0-9_-]{43}$/;
const SECRET_KEY_PATTERN = /(?:api.?secret|api.?key|authorization|credential|password|private.?key|refresh.?token|access.?token)/i;
const MAX_PUBLIC_ROWS = 10_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 128;
const MAX_JSON_ARRAY = 10_000;
const MAX_JSON_STRING = 16 * 1024;
const CONNECTION_STATUSES = new Set([
  'PENDING', 'ACTIVE', 'SYNCING', 'PARTIAL', 'STALE', 'UNKNOWN',
  'CONFLICT', 'DISCONNECTED', 'ERROR',
]);
const PERMISSION_STATES = new Set(['UNKNOWN', 'READ_ONLY_VERIFIED', 'INSUFFICIENT', 'FAILED']);
const COVERAGE_STATES = new Set(['COMPLETE', 'PARTIAL', 'STALE', 'UNKNOWN', 'EMPTY', 'CONFLICT']);
const REQUIRED_DEPENDENCIES = Object.freeze([
  'nowIso',
  'verifyUser',
  'getTenantContext',
  'deriveConnectionId',
  'probeReadOnlyPermissions',
  'permissionEvidenceDigest',
  'providerScopeHash',
  'credentialRequestFingerprint',
  'encryptCredentialEnvelope',
  'createOrRotateConnection',
  'listConnections',
  'getDatasetStatus',
  'getCurrentDataset',
  'getTrades',
  'getReviews',
  'upsertReview',
  'upsertAction',
  'upsertJournal',
  'upsertRiskRule',
  'upsertReport',
  'executeDestructiveOperation',
  'enqueueSync',
  'disconnectConnection',
]);

export class BinanceBetaEdgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BinanceBetaEdgeError';
    this.code = code;
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CANONICAL_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-rv-connection-id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function jsonResponse(status, value, cors = true, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...(cors ? corsHeaders() : {}),
      ...extraHeaders,
    },
  });
}

function publicError(error) {
  const code = String(error?.code ?? 'UPSTREAM_UNAVAILABLE');
  if (code === 'AUTH_INVALID') return [401, { error: 'authentication_required' }];
  if (code === 'FORBIDDEN') return [403, { error: 'forbidden' }];
  if (code === 'REAUTH_REQUIRED') return [403, { error: 'recent_reauthentication_required' }];
  if (code === 'REQUEST_INVALID') return [400, { error: 'invalid_request' }];
  if (code === 'REQUEST_TOO_LARGE') return [413, { error: 'invalid_request' }];
  if (code === 'CONTENT_TYPE_INVALID') return [415, { error: 'invalid_request' }];
  if (code === 'NOT_FOUND') return [404, { error: 'connection_not_found' }];
  if (code === 'DELETION_REQUEST_NOT_FOUND') return [404, { error: 'deletion_request_not_found' }];
  if (code === 'DELETION_REQUEST_EXPIRED') return [410, { error: 'deletion_request_expired' }];
  if (code === 'METHOD_NOT_ALLOWED') return [405, { error: 'method_not_allowed' }];
  if (code === 'IDEMPOTENCY_CONFLICT' || code === 'CONFLICT') return [409, { error: 'idempotency_conflict' }];
  if (code === 'PERMISSION_UNSAFE' || code === 'PERMISSION_AMBIGUOUS') {
    return [422, { error: 'read_only_key_required' }];
  }
  if (code === 'AUTH_DISABLED') return [422, { error: 'credentials_rejected' }];
  if (code === 'GEO_RESTRICTED') return [451, { error: 'geo_restricted' }];
  if (code === 'RATE_LIMITED') return [429, { error: 'rate_limited' }];
  if (code === 'GLOBAL_CIRCUIT_OPEN') return [503, { error: 'sync_temporarily_paused' }];
  return [503, { error: 'service_unavailable' }];
}

function canonicalPath(url) {
  if (url.search || url.hash || url.pathname.includes('%')) return null;
  const prefixes = ['/functions/v1/binance-beta', '/binance-beta', ''];
  for (const prefix of prefixes) {
    if (url.pathname.startsWith(`${prefix}/v1/`)) return url.pathname.slice(prefix.length);
    if (url.pathname === `${prefix}/v1/connections`) return '/v1/connections';
  }
  return null;
}

function routeFor(request) {
  const path = canonicalPath(new URL(request.url));
  if (!path) return null;
  if (path === '/v1/connections') return { kind: request.method === 'POST' ? 'create' : 'list' };
  if (path === '/v1/datasets/current') return { kind: 'dataset' };
  if (path === '/v1/trades') return { kind: 'trades' };
  if (path === '/v1/reviews') return { kind: 'reviews' };
  if (path === '/v1/business-data') return { kind: 'business-data' };
  if (path === '/v1/account') return { kind: 'account' };
  const review = path.match(/^\/v1\/reviews\/(t_[0-9a-f]{16})$/u);
  if (review) return { kind: 'review', tradeId: review[1] };
  const actionMutation = path.match(/^\/v1\/actions\/([0-9a-f-]{36})$/i);
  if (actionMutation && UUID_PATTERN.test(actionMutation[1])) {
    return { kind: 'action', actionId: actionMutation[1].toLowerCase() };
  }
  const journal = path.match(/^\/v1\/journal\/(\d{4}-\d{2}-\d{2})$/u);
  if (journal) return { kind: 'journal', day: journal[1] };
  const risk = path.match(/^\/v1\/risk\/([0-9a-f-]{36})$/i);
  if (risk && UUID_PATTERN.test(risk[1])) {
    return { kind: 'risk', ruleId: risk[1].toLowerCase() };
  }
  if (path === '/v1/reports/current') return { kind: 'report' };
  const match = path.match(/^\/v1\/connections\/([0-9a-f-]{36})(?:\/(rotate|sync|status))?$/i);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  const action = match[2] ?? 'connection';
  return { kind: action, connectionId: match[1].toLowerCase() };
}

function allowedMethods(route) {
  if (!route) return [];
  if (route.kind === 'create' || route.kind === 'list') return ['GET', 'POST', 'OPTIONS'];
  if (route.kind === 'rotate' || route.kind === 'sync') return ['POST', 'OPTIONS'];
  if (['review', 'action', 'journal', 'risk', 'report'].includes(route.kind)) return ['PUT', 'OPTIONS'];
  if (route.kind === 'business-data' || route.kind === 'account') return ['DELETE', 'OPTIONS'];
  if (route.kind === 'dataset' || route.kind === 'trades' || route.kind === 'reviews') return ['GET', 'OPTIONS'];
  if (route.kind === 'status') return ['GET', 'OPTIONS'];
  return ['DELETE', 'OPTIONS'];
}

async function readBoundedBody(request, signal) {
  const declaredText = request.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid request length');
    }
    if (declared > MAX_BODY_BYTES) throw new BinanceBetaEdgeError('REQUEST_TOO_LARGE', 'request too large');
  }
  if (!request.body) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'request body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw new BinanceBetaEdgeError('DEADLINE_EXCEEDED', 'request deadline exceeded');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel('request too large');
        throw new BinanceBetaEdgeError('REQUEST_TOO_LARGE', 'request too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof BinanceBetaEdgeError) throw error;
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid request body');
  } finally {
    reader.releaseLock();
  }
}

function exactObject(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

async function parseJsonBody(request, signal, expectedKeys) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/^application\/json(?:;\s*charset=utf-8)?$/u.test(contentType)) {
    throw new BinanceBetaEdgeError('CONTENT_TYPE_INVALID', 'application/json required');
  }
  let value;
  try {
    value = JSON.parse(await readBoundedBody(request, signal));
  } catch (error) {
    if (error instanceof BinanceBetaEdgeError) throw error;
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid JSON body');
  }
  if (!exactObject(value, expectedKeys)) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'unexpected request fields');
  return value;
}

async function parseCredentialBody(request, signal) {
  const value = await parseJsonBody(
    request,
    signal,
    ['apiKey', 'apiSecret', 'consentVersion', 'idempotencyKey'],
  );
  if (
    !CREDENTIAL_PATTERN.test(value.apiKey ?? '')
    || !CREDENTIAL_PATTERN.test(value.apiSecret ?? '')
    || value.consentVersion !== CONSENT_VERSION
    || !UUID_PATTERN.test(value.idempotencyKey ?? '')
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid credential request');
  return Object.freeze(value);
}

async function parseSyncBody(request, signal) {
  const value = await parseJsonBody(request, signal, ['idempotencyKey']);
  if (!UUID_PATTERN.test(value.idempotencyKey ?? '')) {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid sync request');
  }
  return Object.freeze(value);
}

function publicJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_JSON_STRING) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
    return Object.freeze(value.map((entry) => publicJson(entry, depth + 1)));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_JSON_KEYS || keys.some((key) => SECRET_KEY_PATTERN.test(key))) {
    throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'unsafe public response');
  }
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, publicJson(value[key], depth + 1)])));
}

function publicPayload(value) {
  const normalized = publicJson(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'review payload must be an object');
  }
  return normalized;
}

function requestPayload(value, keys, maximumBytes) {
  let payload;
  try {
    payload = publicPayload(value);
  } catch {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid mutation payload');
  }
  if (!exactObject(payload, keys)) {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'unexpected mutation payload fields');
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maximumBytes) {
    throw new BinanceBetaEdgeError('REQUEST_TOO_LARGE', 'mutation payload too large');
  }
  return payload;
}

function validText(value, maximum, required = false) {
  return typeof value === 'string'
    && value.length <= maximum
    && !value.includes('\0')
    && (!required || value.trim().length > 0);
}

function validDay(value) {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function mutationMetadata(value) {
  if (
    !Number.isSafeInteger(value.expectedVersion)
    || value.expectedVersion < 0
    || !UUID_PATTERN.test(value.idempotencyKey ?? '')
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid mutation metadata');
  return Object.freeze({
    expectedVersion: value.expectedVersion,
    idempotencyKey: value.idempotencyKey.toLowerCase(),
  });
}

async function parseReviewBody(request, signal) {
  const value = await parseJsonBody(request, signal, ['expectedVersion', 'idempotencyKey', 'payload']);
  const metadata = mutationMetadata(value);
  const payload = requestPayload(value.payload, ['saw', 'happened', 'lesson', 'grade', 'reviewed'], 4 * 1_024);
  if (
    !validText(payload.saw, 600)
    || !validText(payload.happened, 600)
    || !validText(payload.lesson, 600)
    || !['A', 'B', 'C', 'D'].includes(payload.grade)
    || typeof payload.reviewed !== 'boolean'
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid review payload');
  return Object.freeze({
    ...metadata,
    payload,
  });
}

async function parseActionBody(request, signal) {
  const value = await parseJsonBody(
    request,
    signal,
    ['expectedVersion', 'idempotencyKey', 'reviewId', 'tradeId', 'status', 'payload'],
  );
  const metadata = mutationMetadata(value);
  const payload = requestPayload(value.payload, ['text', 'experiment'], 64 * 1_024);
  if (
    !UUID_PATTERN.test(value.reviewId ?? '')
    || !TRADE_ID_PATTERN.test(value.tradeId ?? '')
    || !['OPEN', 'DONE', 'CANCELLED'].includes(value.status)
    || !validText(payload.text, 600, true)
    || !(payload.experiment === null || (
      typeof payload.experiment === 'object'
      && !Array.isArray(payload.experiment)
    ))
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid action request');
  return Object.freeze({
    ...metadata,
    reviewId: value.reviewId.toLowerCase(),
    tradeId: value.tradeId,
    status: value.status,
    payload,
  });
}

async function parseJournalBody(request, signal) {
  const value = await parseJsonBody(request, signal, ['expectedVersion', 'idempotencyKey', 'payload']);
  const metadata = mutationMetadata(value);
  const payload = requestPayload(value.payload, ['note', 'emotion'], 8 * 1_024);
  if (!validText(payload.note, 4_000, true) || !validText(payload.emotion, 80)) {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid journal request');
  }
  return Object.freeze({ ...metadata, payload });
}

async function parseRiskBody(request, signal) {
  const value = await parseJsonBody(
    request,
    signal,
    ['expectedVersion', 'idempotencyKey', 'status', 'payload'],
  );
  const metadata = mutationMetadata(value);
  const payload = requestPayload(value.payload, ['text', 'active'], 4 * 1_024);
  if (
    !['ACTIVE', 'PAUSED', 'RETIRED'].includes(value.status)
    || !validText(payload.text, 600, true)
    || typeof payload.active !== 'boolean'
    || payload.active !== (value.status === 'ACTIVE')
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid risk request');
  return Object.freeze({ ...metadata, status: value.status, payload });
}

async function parseReportBody(request, signal) {
  const value = await parseJsonBody(
    request,
    signal,
    [
      'expectedVersion', 'idempotencyKey', 'reportType', 'periodStart',
      'periodEnd', 'sourceGeneration', 'payload',
    ],
  );
  const metadata = mutationMetadata(value);
  let payload;
  try {
    payload = publicPayload(value.payload);
  } catch {
    throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid report payload');
  }
  if (
    !['WEEKLY', 'MONTHLY'].includes(value.reportType)
    || !validDay(value.periodStart)
    || !validDay(value.periodEnd)
    || value.periodEnd < value.periodStart
    || !Number.isSafeInteger(value.sourceGeneration)
    || value.sourceGeneration < 1
    || new TextEncoder().encode(JSON.stringify(payload)).byteLength > 256 * 1_024
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid report request');
  return Object.freeze({
    ...metadata,
    reportType: value.reportType,
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    sourceGeneration: value.sourceGeneration,
    payload,
  });
}

async function parseDeletionBody(request, signal, routeKind) {
  const value = await parseJsonBody(
    request,
    signal,
    ['protocolVersion', 'action', 'confirmation', 'requestId', 'recoverySecret'],
  );
  const expected = routeKind === 'business-data'
    ? Object.freeze({ action: 'clear_business_data', confirmation: 'DELETE_MY_REVIEW_DATA' })
    : Object.freeze({ action: 'delete_account', confirmation: 'DELETE_MY_ACCOUNT' });
  if (
    value.protocolVersion !== 3
    || value.action !== expected.action
    || value.confirmation !== expected.confirmation
    || !UUID_V4_PATTERN.test(value.requestId ?? '')
    || !RECOVERY_SECRET_PATTERN.test(value.recoverySecret ?? '')
  ) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid deletion protocol');
  return Object.freeze({
    protocolVersion: 3,
    action: expected.action,
    confirmation: expected.confirmation,
    requestId: value.requestId.toLowerCase(),
    recoverySecret: value.recoverySecret,
  });
}

function connectionHeader(request) {
  const value = request.headers.get('x-rv-connection-id') ?? '';
  if (!UUID_PATTERN.test(value)) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'connection header required');
  return value.toLowerCase();
}

function bearerToken(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer ([A-Za-z0-9._~-]{32,8192})$/);
  if (!match) throw new BinanceBetaEdgeError('AUTH_INVALID', 'authentication required');
  return match[1];
}

function decodeJwtSubject(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => JWT_PART_PATTERN.test(part))) throw new Error('invalid JWT');
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    if (!payload || typeof payload !== 'object' || !UUID_PATTERN.test(payload.sub ?? '')) throw new Error('invalid JWT');
    return payload.sub.toLowerCase();
  } catch {
    throw new BinanceBetaEdgeError('AUTH_INVALID', 'authentication required');
  }
}

async function authenticate(request, deps, context) {
  const token = bearerToken(request);
  const subject = decodeJwtSubject(token);
  const verified = await deps.verifyUser(token, context);
  if (!verified || verified.is_anonymous === true || String(verified.id).toLowerCase() !== subject) {
    throw new BinanceBetaEdgeError('AUTH_INVALID', 'authentication required');
  }
  return Object.freeze({ token, subject });
}

function validIsoOrNull(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function normalizePermissionEvidence(value, permissionState) {
  if (value === null && permissionState !== 'READ_ONLY_VERIFIED') return null;
  const keys = [
    'evidenceVersion', 'provider', 'readOnly', 'tradeDisabled', 'withdrawDisabled',
    'internalTransferDisabled', 'universalTransferDisabled', 'checkedAt', 'evidenceDigest',
  ];
  if (
    !exactObject(value, keys)
    || value.evidenceVersion !== 'rv-binance-permission/1'
    || value.provider !== 'binance-usdm'
    || !['readOnly', 'tradeDisabled', 'withdrawDisabled', 'internalTransferDisabled', 'universalTransferDisabled']
      .every((key) => typeof value[key] === 'boolean')
    || !validIsoOrNull(value.checkedAt)
    || value.checkedAt === null
    || !HEX_64_PATTERN.test(value.evidenceDigest ?? '')
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid permission evidence');
  if (permissionState === 'READ_ONLY_VERIFIED' && !(
    value.readOnly
    && value.tradeDisabled
    && value.withdrawDisabled
    && value.internalTransferDisabled
    && value.universalTransferDisabled
  )) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid verified permission evidence');
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])));
}

function normalizeConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid connection response');
  }
  const status = String(value.status ?? '');
  const permissionState = String(value.permissionState ?? '');
  const lastErrorCode = value.lastErrorCode;
  if (
    !UUID_PATTERN.test(value.connectionId ?? '')
    || !CONNECTION_STATUSES.has(status)
    || !Number.isSafeInteger(value.credentialVersion)
    || value.credentialVersion < 1
    || !validIsoOrNull(value.lastTrustedAt)
    || !validIsoOrNull(value.nextDueAt)
    || !PERMISSION_STATES.has(permissionState)
    || !(lastErrorCode === null || (typeof lastErrorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(lastErrorCode)))
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid connection response');
  return Object.freeze({
    connectionId: value.connectionId.toLowerCase(),
    status,
    credentialVersion: value.credentialVersion,
    lastTrustedAt: value.lastTrustedAt,
    nextDueAt: value.nextDueAt,
    permissionState,
    permissionEvidence: normalizePermissionEvidence(value.permissionEvidence ?? null, permissionState),
    lastErrorCode,
  });
}

function normalizeConnectionList(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.format !== CONNECTIONS_FORMAT
    || !Array.isArray(value.connections)
    || value.connections.length > 32
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid connection list');
  return Object.freeze({
    format: CONNECTIONS_FORMAT,
    connections: Object.freeze(value.connections.map(normalizeConnection)),
  });
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
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid coverage gap');
  return Object.freeze({ code: value.code, from: value.from ?? null, to: value.to ?? null });
}

function normalizeCoverage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid coverage response');
  }
  const dates = ['attemptedThrough', 'fetchedThrough', 'committedThrough', 'trustedThrough'];
  if (
    !COVERAGE_STATES.has(String(value.state ?? ''))
    || dates.some((key) => !validIsoOrNull(value[key] ?? null))
    || !(value.currentGeneration === null || (Number.isSafeInteger(value.currentGeneration) && value.currentGeneration >= 0))
    || !Array.isArray(value.gaps)
    || value.gaps.length > 32
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid coverage response');
  return Object.freeze({
    state: value.state,
    attemptedThrough: value.attemptedThrough ?? null,
    fetchedThrough: value.fetchedThrough ?? null,
    committedThrough: value.committedThrough ?? null,
    trustedThrough: value.trustedThrough ?? null,
    currentGeneration: value.currentGeneration,
    gaps: Object.freeze(value.gaps.map(normalizeGap)),
  });
}

function normalizeDatasetDocument(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.format !== DATASET_FORMAT
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || !validIsoOrNull(value.asOf)
    || value.asOf === null
    || !value.coverage
    || typeof value.coverage !== 'object'
    || Array.isArray(value.coverage)
    || !value.reconciliation
    || typeof value.reconciliation !== 'object'
    || Array.isArray(value.reconciliation)
    || !value.capabilities
    || typeof value.capabilities !== 'object'
    || Array.isArray(value.capabilities)
    || !Array.isArray(value.trades)
    || value.trades.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.tradeModels)
    || value.tradeModels.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.reviews)
    || value.reviews.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.actions)
    || value.actions.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.journal)
    || value.journal.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.risk)
    || value.risk.length > MAX_PUBLIC_ROWS
    || !Array.isArray(value.reports)
    || value.reports.length > MAX_PUBLIC_ROWS
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid dataset response');
  return publicJson({
    format: DATASET_FORMAT,
    generation: value.generation,
    asOf: value.asOf,
    coverage: value.coverage,
    reconciliation: value.reconciliation,
    capabilities: value.capabilities,
    trades: value.trades,
    tradeModels: value.tradeModels,
    reviews: value.reviews,
    actions: value.actions,
    journal: value.journal,
    risk: value.risk,
    reports: value.reports,
    ...Object.fromEntries(
      ['income', 'orders', 'algoOrders', 'forceOrders', 'balances', 'positions']
        .filter((key) => Object.hasOwn(value, key))
        .map((key) => [key, value[key]]),
    ),
  });
}

function normalizeTradesDocument(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.format !== TRADES_FORMAT
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || !validIsoOrNull(value.asOf)
    || value.asOf === null
    || !Array.isArray(value.trades)
    || value.trades.length > MAX_PUBLIC_ROWS
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid trades response');
  return publicJson({
    format: TRADES_FORMAT,
    generation: value.generation,
    asOf: value.asOf,
    trades: value.trades,
  });
}

function normalizeReviewsDocument(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.format !== REVIEWS_FORMAT
    || !Array.isArray(value.reviews)
    || value.reviews.length > MAX_PUBLIC_ROWS
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid reviews response');
  return publicJson({ format: REVIEWS_FORMAT, reviews: value.reviews });
}

function normalizeReviewWrite(value, tradeId, expectedVersion) {
  if (
    !exactObject(value, ['tradeId', 'version', 'updatedAt'])
    || value.tradeId !== tradeId
    || value.version !== expectedVersion + 1
    || !validIsoOrNull(value.updatedAt)
    || value.updatedAt === null
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid review response');
  return Object.freeze({
    format: REVIEW_FORMAT,
    tradeId,
    version: value.version,
    updatedAt: value.updatedAt,
  });
}

function normalizeMutationWrite(value, resource, expectedVersion, expectedResourceId = null) {
  if (
    !exactObject(value, ['resourceId', 'version', 'updatedAt'])
    || typeof value.resourceId !== 'string'
    || (expectedResourceId === null
      ? !UUID_PATTERN.test(value.resourceId)
      : value.resourceId !== expectedResourceId)
    || value.version !== expectedVersion + 1
    || !validIsoOrNull(value.updatedAt)
    || value.updatedAt === null
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid mutation response');
  return Object.freeze({
    format: MUTATION_FORMAT,
    resource,
    resourceId: UUID_PATTERN.test(value.resourceId)
      ? value.resourceId.toLowerCase()
      : value.resourceId,
    version: value.version,
    updatedAt: value.updatedAt,
  });
}

function normalizeDeletionReceipt(value, action) {
  if (
    !exactObject(value, ['protocolVersion', 'action', 'state', 'receiptId', 'expiresAt'])
    || value.protocolVersion !== 3
    || value.action !== action
    || value.state !== 'completed'
    || !UUID_PATTERN.test(value.receiptId ?? '')
    || !validIsoOrNull(value.expiresAt)
    || value.expiresAt === null
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid deletion receipt');
  return Object.freeze({
    protocolVersion: 3,
    action,
    state: 'completed',
    receiptId: value.receiptId.toLowerCase(),
    expiresAt: value.expiresAt,
  });
}

async function tenantContext(auth, deps, context) {
  const value = await deps.getTenantContext(auth.token, context);
  if (
    !value
    || typeof value !== 'object'
    || !UUID_PATTERN.test(value.tenantId ?? '')
    || value.memberRole !== 'owner'
  ) throw new BinanceBetaEdgeError('AUTH_INVALID', 'active membership required');
  if (
    Object.hasOwn(value, 'membershipVersion')
    && (!Number.isSafeInteger(value.membershipVersion) || value.membershipVersion < 1)
  ) throw new BinanceBetaEdgeError('AUTH_INVALID', 'active membership required');
  return Object.freeze({
    tenantId: value.tenantId.toLowerCase(),
    memberRole: value.memberRole,
    ...(Object.hasOwn(value, 'membershipVersion') ? { membershipVersion: value.membershipVersion } : {}),
  });
}

function requireOwner(tenant) {
  if (tenant.memberRole !== 'owner') throw new BinanceBetaEdgeError('FORBIDDEN', 'owner required');
}

async function connectionsFor(auth, deps, context) {
  return normalizeConnectionList(await deps.listConnections(auth.token, context));
}

async function existingConnection(auth, connectionId, deps, context) {
  const list = await connectionsFor(auth, deps, context);
  const value = list.connections.find((entry) => entry.connectionId === connectionId);
  if (!value) throw new BinanceBetaEdgeError('NOT_FOUND', 'connection unavailable');
  return value;
}

function buildPermissionEvidence(conclusion, checkedAt, digest) {
  const value = {
    evidenceVersion: 'rv-binance-permission/1',
    provider: 'binance-usdm',
    readOnly: conclusion.readOnly,
    tradeDisabled: conclusion.tradeDisabled,
    withdrawDisabled: conclusion.withdrawDisabled,
    internalTransferDisabled: conclusion.internalTransferDisabled,
    universalTransferDisabled: conclusion.universalTransferDisabled,
    checkedAt,
    evidenceDigest: digest,
  };
  return normalizePermissionEvidence(value, 'READ_ONLY_VERIFIED');
}

async function saveCredentialConnection({ auth, tenant, connectionId, expectedVersion, body, deps, context }) {
  const conclusion = await deps.probeReadOnlyPermissions(
    { apiKey: body.apiKey, apiSecret: body.apiSecret },
    context,
  );
  const checkedAt = deps.nowIso();
  if (!validIsoOrNull(checkedAt) || checkedAt === null) {
    throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'clock unavailable');
  }
  const permissionEvidence = buildPermissionEvidence(
    conclusion,
    checkedAt,
    await deps.permissionEvidenceDigest(conclusion, context),
  );
  const credentialVersion = expectedVersion + 1;
  const envelope = await deps.encryptCredentialEnvelope({
    tenantId: tenant.tenantId,
    connectionId,
    credentialVersion,
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
  }, context);
  const providerScopeHash = await deps.providerScopeHash(body.apiKey, context);
  const requestFingerprint = await deps.credentialRequestFingerprint({
    operation: expectedVersion === 0 ? 'create' : 'rotate',
    tenantId: tenant.tenantId,
    connectionId,
    expectedCredentialVersion: expectedVersion,
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
    consentVersion: body.consentVersion,
  }, context);
  const saved = await deps.createOrRotateConnection({
    subject: auth.subject,
    tenantId: tenant.tenantId,
    connectionId,
    provider: 'BINANCE',
    market: 'USD_M',
    providerScopeHash,
    envelopeCiphertext: envelope.ciphertext,
    envelopeNonce: envelope.nonce,
    envelopeKeyRef: envelope.keyRef,
    envelopeSha256: envelope.sha256,
    expectedCredentialVersion: expectedVersion,
    idempotencyKey: body.idempotencyKey,
    requestFingerprint,
    consentVersion: body.consentVersion,
    permissionState: 'READ_ONLY_VERIFIED',
    permissionEvidence,
  }, context);
  if (
    !saved
    || saved.connectionId !== connectionId
    || saved.credentialVersion !== credentialVersion
    || saved.status !== 'ACTIVE'
  ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid connection write response');
  const storedEvidence = saved.permissionEvidence
    ? normalizePermissionEvidence(saved.permissionEvidence, saved.permissionState ?? 'READ_ONLY_VERIFIED')
    : permissionEvidence;
  return Object.freeze({
    connectionId,
    status: 'ACTIVE',
    credentialVersion,
    permissionEvidence: storedEvidence,
  });
}

async function dispatch(request, route, deps, context) {
  const dataConnectionId = [
    'dataset', 'trades', 'reviews', 'review', 'action', 'journal', 'risk', 'report',
  ].includes(route.kind)
    ? connectionHeader(request)
    : null;
  // Authenticate before reading any attacker-controlled request body. Edge
  // gateway JWT verification is deliberately disabled for this function so
  // the handler can validate the exact Supabase user server-side; parsing first
  // would let anonymous callers spend the bounded-body CPU and memory budget.
  const auth = await authenticate(request, deps, context);
  const tenant = await tenantContext(auth, deps, context);
  if (route.kind === 'create' && request.method === 'POST') {
    requireOwner(tenant);
    const body = await parseCredentialBody(request, context.signal);
    const connectionId = String(await deps.deriveConnectionId({
      tenantId: tenant.tenantId,
      idempotencyKey: body.idempotencyKey,
    }, context)).toLowerCase();
    if (!UUID_PATTERN.test(connectionId)) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'connection id unavailable');
    return [201, await saveCredentialConnection({
      auth, tenant, connectionId, expectedVersion: 0, body, deps, context,
    })];
  }
  const reviewBody = route.kind === 'review' && request.method === 'PUT'
    ? await parseReviewBody(request, context.signal)
    : null;
  const actionBody = route.kind === 'action' && request.method === 'PUT'
    ? await parseActionBody(request, context.signal)
    : null;
  const journalBody = route.kind === 'journal' && request.method === 'PUT'
    ? await parseJournalBody(request, context.signal)
    : null;
  const riskBody = route.kind === 'risk' && request.method === 'PUT'
    ? await parseRiskBody(request, context.signal)
    : null;
  const reportBody = route.kind === 'report' && request.method === 'PUT'
    ? await parseReportBody(request, context.signal)
    : null;
  const deletionProtocol = ['business-data', 'account'].includes(route.kind)
    ? await parseDeletionBody(request, context.signal, route.kind)
    : null;
  if (route.kind === 'list' && request.method === 'GET') {
    return [200, await connectionsFor(auth, deps, context)];
  }
  if (route.kind === 'status' && request.method === 'GET') {
    const connection = await existingConnection(auth, route.connectionId, deps, context);
    const coverage = normalizeCoverage(await deps.getDatasetStatus({
      token: auth.token,
      connectionId: route.connectionId,
      dataset: 'trades',
      partitionKey: null,
    }, context));
    return [200, { ...connection, coverage }];
  }
  if (route.kind === 'dataset' && request.method === 'GET') {
    await existingConnection(auth, dataConnectionId, deps, context);
    return [200, normalizeDatasetDocument(await deps.getCurrentDataset({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
    }, context))];
  }
  if (route.kind === 'trades' && request.method === 'GET') {
    await existingConnection(auth, dataConnectionId, deps, context);
    return [200, normalizeTradesDocument(await deps.getTrades({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
    }, context))];
  }
  if (route.kind === 'reviews' && request.method === 'GET') {
    await existingConnection(auth, dataConnectionId, deps, context);
    return [200, normalizeReviewsDocument(await deps.getReviews({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
    }, context))];
  }
  if (route.kind === 'review' && request.method === 'PUT') {
    await existingConnection(auth, dataConnectionId, deps, context);
    const saved = await deps.upsertReview({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
      tradeId: route.tradeId,
      expectedVersion: reviewBody.expectedVersion,
      idempotencyKey: reviewBody.idempotencyKey,
      payload: reviewBody.payload,
    }, context);
    return [200, normalizeReviewWrite(saved, route.tradeId, reviewBody.expectedVersion)];
  }
  if (route.kind === 'action' && request.method === 'PUT') {
    await existingConnection(auth, dataConnectionId, deps, context);
    const saved = await deps.upsertAction({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
      actionId: route.actionId,
      reviewId: actionBody.reviewId,
      tradeId: actionBody.tradeId,
      expectedVersion: actionBody.expectedVersion,
      idempotencyKey: actionBody.idempotencyKey,
      status: actionBody.status,
      payload: actionBody.payload,
    }, context);
    return [200, normalizeMutationWrite(saved, 'action', actionBody.expectedVersion, route.actionId)];
  }
  if (route.kind === 'journal' && request.method === 'PUT') {
    if (!validDay(route.day)) throw new BinanceBetaEdgeError('REQUEST_INVALID', 'invalid journal day');
    await existingConnection(auth, dataConnectionId, deps, context);
    const saved = await deps.upsertJournal({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
      day: route.day,
      expectedVersion: journalBody.expectedVersion,
      idempotencyKey: journalBody.idempotencyKey,
      payload: journalBody.payload,
    }, context);
    return [200, normalizeMutationWrite(saved, 'journal', journalBody.expectedVersion, route.day)];
  }
  if (route.kind === 'risk' && request.method === 'PUT') {
    await existingConnection(auth, dataConnectionId, deps, context);
    const saved = await deps.upsertRiskRule({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
      ruleId: route.ruleId,
      expectedVersion: riskBody.expectedVersion,
      idempotencyKey: riskBody.idempotencyKey,
      status: riskBody.status,
      payload: riskBody.payload,
    }, context);
    return [200, normalizeMutationWrite(saved, 'risk', riskBody.expectedVersion, route.ruleId)];
  }
  if (route.kind === 'report' && request.method === 'PUT') {
    await existingConnection(auth, dataConnectionId, deps, context);
    const saved = await deps.upsertReport({
      token: auth.token,
      tenantId: tenant.tenantId,
      connectionId: dataConnectionId,
      expectedVersion: reportBody.expectedVersion,
      idempotencyKey: reportBody.idempotencyKey,
      reportType: reportBody.reportType,
      periodStart: reportBody.periodStart,
      periodEnd: reportBody.periodEnd,
      sourceGeneration: reportBody.sourceGeneration,
      payload: reportBody.payload,
    }, context);
    return [200, normalizeMutationWrite(saved, 'report', reportBody.expectedVersion)];
  }
  if ((route.kind === 'business-data' || route.kind === 'account') && request.method === 'DELETE') {
    requireOwner(tenant);
    const receipt = await deps.executeDestructiveOperation({
      token: auth.token,
      protocol: deletionProtocol,
    }, context);
    return [200, normalizeDeletionReceipt(receipt, deletionProtocol.action)];
  }
  if (route.kind === 'rotate' && request.method === 'POST') {
    const body = await parseCredentialBody(request, context.signal);
    const existing = await existingConnection(auth, route.connectionId, deps, context);
    requireOwner(tenant);
    return [200, await saveCredentialConnection({
      auth,
      tenant,
      connectionId: route.connectionId,
      expectedVersion: existing.credentialVersion,
      body,
      deps,
      context,
    })];
  }
  if (route.kind === 'sync' && request.method === 'POST') {
    const body = await parseSyncBody(request, context.signal);
    await existingConnection(auth, route.connectionId, deps, context);
    const queued = await deps.enqueueSync({
      token: auth.token,
      connectionId: route.connectionId,
      // A manual sync starts with the account-wide position snapshot. Its
      // normalized symbols are then admitted by the fixed server-side
      // discovery RPC, which schedules only fills/orders/algo_orders symbol
      // partitions. A fills/default request is deliberately impossible.
      dataset: 'positions',
      partitionKey: 'default',
      idempotencyKey: body.idempotencyKey,
    }, context);
    if (!queued || !UUID_PATTERN.test(queued.jobId ?? '') || queued.status !== 'QUEUED') {
      throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid enqueue response');
    }
    return [202, { status: 'QUEUED', jobId: queued.jobId.toLowerCase() }];
  }
  if (route.kind === 'connection' && request.method === 'DELETE') {
    const existing = await existingConnection(auth, route.connectionId, deps, context);
    requireOwner(tenant);
    const disconnected = await deps.disconnectConnection({
      token: auth.token,
      connectionId: route.connectionId,
      expectedCredentialVersion: existing.credentialVersion,
    }, context);
    if (
      !disconnected
      || disconnected.connectionId !== route.connectionId
      || disconnected.status !== 'DISCONNECTED'
      || !UUID_PATTERN.test(disconnected.receiptId ?? '')
    ) throw new BinanceBetaEdgeError('UPSTREAM_UNAVAILABLE', 'invalid disconnect response');
    return [200, { status: 'DISCONNECTED', receiptId: disconnected.receiptId.toLowerCase() }];
  }
  throw new BinanceBetaEdgeError('METHOD_NOT_ALLOWED', 'method not allowed');
}

export function createBinanceBetaHandler(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('Binance Beta dependencies required');
  if (Object.hasOwn(deps, 'allowedOrigin') && deps.allowedOrigin !== CANONICAL_ORIGIN) {
    throw new TypeError('Binance Beta requires canonical Origin');
  }
  for (const name of REQUIRED_DEPENDENCIES) {
    if (typeof deps[name] !== 'function') throw new TypeError(`missing dependency: ${name}`);
  }
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 30_000) {
    throw new TypeError('invalid Binance Beta deadline');
  }
  return async function handleBinanceBeta(request) {
    const origin = request.headers.get('origin') ?? '';
    if (origin !== CANONICAL_ORIGIN) return jsonResponse(403, { error: 'forbidden' }, false);
    const route = routeFor(request);
    if (!route) return jsonResponse(404, { error: 'not_found' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (!allowedMethods(route).includes(request.method)) {
      return jsonResponse(405, { error: 'method_not_allowed' });
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason ?? 'request aborted');
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('request deadline exceeded'), deadlineMs);
    try {
      const [status, value] = await dispatch(request, route, deps, Object.freeze({ signal: controller.signal }));
      return jsonResponse(status, value);
    } catch (error) {
      const [status, value] = publicError(error);
      const retryAfter = Number(error?.retryAfterSeconds);
      return jsonResponse(
        status,
        value,
        true,
        (status === 429 || error?.code === 'GLOBAL_CIRCUIT_OPEN')
          && Number.isSafeInteger(retryAfter)
          && retryAfter > 0
          ? { 'Retry-After': String(Math.min(retryAfter, 3600)) }
          : {},
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }
  };
}
