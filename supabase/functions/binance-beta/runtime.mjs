import { createBinanceClient } from './binance-client.mjs';
import {
  createArchiveState,
  runArchiveStep as runArchiveStateStep,
} from './archive.mjs';
import {
  decryptCredentialEnvelope,
  encryptCredentialEnvelope,
  permissionEvidenceDigest,
  providerScopeHash,
} from './crypto.mjs';
import { projectBinanceUsdmLedger } from './ledger.mjs';

export const CANONICAL_APP_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const PUBLIC_DATASETS = new Set([
  'fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CRON_TOKEN_PATTERN = /^[A-Za-z0-9_-]{64}$/;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const PAGE_LIMIT = 1_000;
const SYMBOL_PATTERN = /^[A-Z0-9]{3,32}$/;
const PROVIDER_INTEGER_FIELDS = new Set([
  'id', 'tradeId', 'orderId', 'algoId', 'tranId',
  'time', 'updateTime', 'tradeTime', 'transactTime', 'createTime', 'createdTime',
  'goodTillDate', 'workingTime', 'activatePriceTime',
]);
const PROVIDER_OPAQUE_IDENTIFIER_FIELDS = new Set([
  'clientOrderId', 'origClientOrderId', 'newClientOrderId', 'clientAlgoId',
]);
const PROVIDER_DECIMAL_FIELDS = new Set([
  'price', 'avgPrice', 'activatePrice', 'priceRate', 'stopPrice', 'priceProtect',
  'qty', 'quantity', 'origQty', 'executedQty', 'cumQty', 'cumQuote', 'quoteQty',
  'baseQty', 'cumBase', 'commission', 'realizedPnl', 'income', 'balance', 'walletBalance',
  'crossWalletBalance', 'availableBalance', 'maxWithdrawAmount', 'initialMargin',
  'maintMargin', 'unrealizedProfit', 'unRealizedProfit', 'positionAmt', 'entryPrice', 'breakEvenPrice',
  'markPrice', 'notional', 'isolatedWallet', 'liquidationPrice', 'maxNotionalValue',
]);
const encoder = new TextEncoder();

export class BinanceBetaRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BinanceBetaRuntimeError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.retryAfterSeconds = Number.isSafeInteger(options.retryAfterSeconds)
      ? options.retryAfterSeconds
      : 0;
  }
}

function exactHttpsOrigin(raw, hostPredicate = () => true) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin !== value.replace(/\/$/u, '')
      || !hostPredicate(url.hostname)
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function decodeSecret(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function safeOpaqueKey(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= 8192
    && !/\s/u.test(value);
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function readRuntimeConfig(getEnv) {
  if (typeof getEnv !== 'function') return null;
  const allowedOrigin = exactHttpsOrigin(getEnv('APP_ORIGIN') ?? '');
  const supabaseUrl = exactHttpsOrigin(
    getEnv('SUPABASE_URL') ?? '',
    (host) => host.endsWith('.supabase.co'),
  );
  const anonKey = getEnv('SUPABASE_ANON_KEY') ?? getEnv('SB_PUBLISHABLE_KEY') ?? '';
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const credentialKek = decodeSecret(getEnv('RV_BETA_CREDENTIAL_KEK_V1') ?? '');
  const scopeHmacKey = decodeSecret(getEnv('RV_BETA_SCOPE_HMAC_V1') ?? '');
  const syncCronToken = getEnv('RV_BETA_SYNC_CRON_TOKEN') ?? '';
  const archiveCronToken = getEnv('RV_BETA_ARCHIVE_CRON_TOKEN') ?? '';
  const workerSubject = String(getEnv('RV_BETA_EDGE_WORKER_SUBJECT') ?? '').toLowerCase();
  if (
    allowedOrigin !== CANONICAL_APP_ORIGIN
    || !supabaseUrl
    || !safeOpaqueKey(anonKey)
    || !safeOpaqueKey(serviceRoleKey)
    || anonKey === serviceRoleKey
    || !credentialKek
    || !scopeHmacKey
    || !CRON_TOKEN_PATTERN.test(syncCronToken)
    || !CRON_TOKEN_PATTERN.test(archiveCronToken)
    || syncCronToken === archiveCronToken
    || [syncCronToken, archiveCronToken].includes(anonKey)
    || [syncCronToken, archiveCronToken].includes(serviceRoleKey)
    || sameBytes(credentialKek, scopeHmacKey)
    || !UUID_PATTERN.test(workerSubject)
  ) return null;
  return Object.freeze({
    allowedOrigin,
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    credentialKek,
    scopeHmacKey,
    syncCronToken,
    archiveCronToken,
    workerSubject,
  });
}

export function canonicalBrowserDataset(value) {
  const canonical = value === 'trades' ? 'fills' : value;
  if (typeof canonical !== 'string' || !PUBLIC_DATASETS.has(canonical)) {
    throw new BinanceBetaRuntimeError('REQUEST_INVALID', 'dataset unavailable');
  }
  return canonical;
}

function canonicalUnsignedInteger(value, field) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : '')
    : value;
  if (typeof text !== 'string' || !/^\d{1,128}$/u.test(text)) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `invalid provider ${field}`);
  }
  return BigInt(text).toString();
}

function canonicalDecimal(value, field) {
  if (typeof value !== 'string' || !/^-?\d{1,40}(?:\.\d{1,24})?$/u.test(value)) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `invalid provider ${field}`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawWhole, rawFraction = ''] = unsigned.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/u, '');
  const fraction = rawFraction.replace(/0+$/u, '');
  const isZero = /^0+$/u.test(whole) && fraction.length === 0;
  return `${negative && !isZero ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function canonicalOpaqueIdentifier(value, field) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : '')
    : value;
  if (typeof text !== 'string' || !/^[.A-Za-z0-9_:/~-]{1,128}$/u.test(text)) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `invalid provider ${field}`);
  }
  return text;
}

function canonicalProviderValue(value, field = '', depth = 0) {
  if (depth > 8) throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'provider payload too deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `unsafe provider number: ${field}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (PROVIDER_INTEGER_FIELDS.has(field)) return canonicalUnsignedInteger(value, field);
    if (PROVIDER_OPAQUE_IDENTIFIER_FIELDS.has(field)) return canonicalOpaqueIdentifier(value, field);
    if (PROVIDER_DECIMAL_FIELDS.has(field)) return canonicalDecimal(value, field);
    if (value.length > 16_384) throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'provider text too large');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > PAGE_LIMIT) throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'provider array too large');
    return Object.freeze(value.map((child) => canonicalProviderValue(child, field, depth + 1)));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'invalid provider value');
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (entries.length > 256) throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'provider object too large');
  const result = {};
  for (const [key, child] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) {
      throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'invalid provider field');
    }
    if (['apiKey', 'apiSecret', 'ciphertext', 'tenantId', 'userId', 'requestedBy'].includes(key)) {
      throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'forbidden provider field');
    }
    result[key] = canonicalProviderValue(child, key, depth + 1);
  }
  return Object.freeze(result);
}

function canonicalFillPayload(raw, partitionKey) {
  const row = canonicalProviderValue(raw);
  // Binance Account Trade List supplies marginAsset as the accounting asset
  // for realizedPnl. Accepting a caller-invented realizedPnlAsset without that
  // provider field would create an unverifiable currency conversion boundary.
  const realizedPnlAsset = row.marginAsset;
  if (
    typeof row.id !== 'string'
    || !/^(?:0|[1-9][0-9]{0,39})$/u.test(row.id)
    || typeof row.symbol !== 'string'
    || row.symbol !== partitionKey
    || !/^[A-Z0-9]{2,24}(?:USDT|USDC)$/u.test(row.symbol)
    || row.pair !== row.symbol
    || !['USDT', 'USDC'].includes(row.marginAsset)
    || settlementAssetForSymbol(row.symbol) !== row.marginAsset
    || canonicalDecimal(row.baseQty ?? '', 'baseQty') !== '0'
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/u.test(row.quoteQty ?? '')
    || canonicalDecimal(row.quoteQty, 'quoteQty') === '0'
    || !['BUY', 'SELL'].includes(row.side)
    || !['BOTH', 'LONG', 'SHORT'].includes(row.positionSide)
    || typeof row.time !== 'string'
    || !/^[0-9]{13}$/u.test(row.time)
    || typeof row.price !== 'string'
    || typeof row.qty !== 'string'
    || typeof row.commission !== 'string'
    || typeof row.realizedPnl !== 'string'
    || typeof row.commissionAsset !== 'string'
    || !/^[A-Z0-9]{2,16}$/u.test(row.commissionAsset)
    || typeof realizedPnlAsset !== 'string'
    || !/^[A-Z0-9]{2,16}$/u.test(realizedPnlAsset)
    || (row.realizedPnlAsset !== undefined && row.realizedPnlAsset !== row.marginAsset)
  ) {
    throw new BinanceBetaRuntimeError(
      'NORMALIZATION_CONFLICT',
      'Binance fill does not satisfy the canonical accounting schema',
    );
  }
  return Object.freeze({
    commission: canonicalDecimal(row.commission, 'commission'),
    commissionAsset: row.commissionAsset,
    baseQty: '0',
    id: canonicalUnsignedInteger(row.id, 'id'),
    pair: row.pair,
    positionSide: row.positionSide,
    price: canonicalDecimal(row.price, 'price'),
    qty: canonicalDecimal(row.qty, 'qty'),
    quoteQty: canonicalDecimal(row.quoteQty, 'quoteQty'),
    realizedPnl: canonicalDecimal(row.realizedPnl, 'realizedPnl'),
    realizedPnlAsset,
    side: row.side,
    symbol: row.symbol,
    time: canonicalUnsignedInteger(row.time, 'time'),
  });
}

function requireCanonicalFields(row, fields, label) {
  if (fields.some((field) => !Object.hasOwn(row, field))) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `${label} schema incomplete`);
  }
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, row[field]])));
}

function settlementAssetForSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  if (symbol.endsWith('USDT')) return 'USDT';
  if (symbol.endsWith('USDC')) return 'USDC';
  return null;
}

function canonicalUnifiedOrderPayload(
  raw,
  partitionKey,
  label,
  identityField,
  { accountWide = false } = {},
) {
  const canonical = canonicalProviderValue(raw);
  const row = Object.freeze({
    ...canonical,
    time: canonical.time ?? canonical.createTime,
    updateTime: canonical.updateTime ?? canonical.time ?? canonical.createTime,
  });
  const settlementAsset = settlementAssetForSymbol(row.symbol);
  const partitionMatches = accountWide
    ? ['default', 'account-wide', row.symbol].includes(partitionKey)
    : row.symbol === partitionKey;
  if (
    !partitionMatches
    || row.pair !== row.symbol
    || !settlementAsset
    || canonicalDecimal(row.cumBase ?? '', 'cumBase') !== '0'
    || typeof row[identityField] !== 'string'
  ) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', `${label} product proof unavailable`);
  }
  const common = requireCanonicalFields(row, [
    identityField, 'symbol', 'pair', 'cumBase', 'side', 'positionSide',
    'status', 'time', 'updateTime',
  ], label);
  return Object.freeze({ ...common, settlementAsset });
}

function canonicalIncomePayload(raw, partitionKey) {
  const row = canonicalProviderValue(raw);
  const hasSymbol = typeof row.symbol === 'string' && row.symbol.length > 0;
  const settlementAsset = hasSymbol ? settlementAssetForSymbol(row.symbol) : row.asset;
  if (
    !['USDT', 'USDC'].includes(settlementAsset)
    || (hasSymbol && !['default', 'account-wide', row.symbol].includes(partitionKey))
  ) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'income product proof unavailable');
  }
  const payload = requireCanonicalFields(row, [
    'tranId', 'tradeId', 'symbol', 'incomeType', 'income', 'asset', 'time',
  ], 'income');
  return Object.freeze({ ...payload, settlementAsset });
}

function canonicalBalancePayload(raw) {
  const row = canonicalProviderValue(raw);
  if (!['USDT', 'USDC'].includes(row.asset)) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'balance asset outside beta scope');
  }
  return requireCanonicalFields(row, [
    'asset', 'walletBalance', 'unrealizedProfit', 'marginBalance',
    'availableBalance', 'maxWithdrawAmount', 'updateTime',
  ], 'balance');
}

function canonicalPositionPayload(raw, partitionKey) {
  const row = canonicalProviderValue(raw);
  const settlementAsset = settlementAssetForSymbol(row.symbol);
  if (!['default', 'account-wide', row.symbol].includes(partitionKey) || !settlementAsset) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'position product proof unavailable');
  }
  const payload = requireCanonicalFields(row, [
    'symbol', 'positionSide', 'positionAmt', 'entryPrice', 'breakEvenPrice',
    'markPrice', 'unRealizedProfit', 'liquidationPrice', 'leverage',
    'marginType', 'notional', 'updateTime',
  ], 'position');
  return Object.freeze({ ...payload, settlementAsset });
}

function canonicalDatasetPayload(dataset, partitionKey, raw) {
  if (dataset === 'fills') return canonicalFillPayload(raw, partitionKey);
  if (dataset === 'orders') {
    return canonicalUnifiedOrderPayload(raw, partitionKey, 'order', 'orderId');
  }
  if (dataset === 'force_orders') {
    return canonicalUnifiedOrderPayload(
      raw,
      partitionKey,
      'force order',
      'orderId',
      { accountWide: true },
    );
  }
  if (dataset === 'algo_orders') {
    return canonicalUnifiedOrderPayload(raw, partitionKey, 'algo order', 'algoId');
  }
  if (dataset === 'income') return canonicalIncomePayload(raw, partitionKey);
  if (dataset === 'balances') return canonicalBalancePayload(raw);
  if (dataset === 'positions') return canonicalPositionPayload(raw, partitionKey);
  throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'unsupported dataset');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'non-canonical JSON');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalSymbol(value) {
  if (typeof value !== 'string' || !SYMBOL_PATTERN.test(value)) {
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'audited symbol partition required');
  }
  return value;
}

function canonicalPageCursor(dataset, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid page cursor');
  }
  const allowed = {
    fills: new Set(['fromId', 'startTime']),
    income: new Set(['page', 'startTime']),
    orders: new Set(['orderId', 'startTime']),
    algo_orders: new Set(['algoId', 'startTime']),
    force_orders: new Set(['startTime']),
    balances: new Set(),
    positions: new Set(),
  }[dataset];
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed?.has(key)) throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid page cursor');
    if (typeof value !== 'string' || !/^\d{1,128}$/u.test(value) || BigInt(value).toString() !== value) {
      throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid page cursor');
    }
    result[key] = canonicalUnsignedInteger(value, key);
  }
  if (Object.hasOwn(result, 'fromId') && Object.hasOwn(result, 'startTime')) {
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'ambiguous page cursor');
  }
  return Object.freeze(result);
}

function oneRow(value, label) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0])) {
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', `invalid ${label} response`);
  }
  return value[0];
}

function queryForClaim(dataset, partitionKey, pageCursor) {
  const query = { ...pageCursor };
  if (['fills', 'orders', 'algo_orders'].includes(dataset)) {
    query.symbol = canonicalSymbol(partitionKey);
  } else if (!['default', 'account-wide'].includes(partitionKey)) {
    query.symbol = canonicalSymbol(partitionKey);
  }
  if (['fills', 'income', 'orders', 'algo_orders', 'force_orders'].includes(dataset)) {
    query.limit = PAGE_LIMIT;
  }
  return Object.freeze(query);
}

export function adaptServiceClaim(value) {
  const row = oneRow(value, 'claim');
  const dataset = row.dataset;
  if (
    !UUID_PATTERN.test(row.job_id ?? '')
    || !UUID_PATTERN.test(row.tenant_id ?? '')
    || !UUID_PATTERN.test(row.requested_by ?? '')
    || !UUID_PATTERN.test(row.connection_id ?? '')
    || !UUID_PATTERN.test(row.attempt_id ?? '')
    || !UUID_PATTERN.test(row.claim_token ?? '')
    || row.provider !== 'binance'
    || !HEX_64_PATTERN.test(row.provider_scope_hash ?? '')
    || !Number.isSafeInteger(row.credential_version)
    || row.credential_version < 1
    || !PUBLIC_DATASETS.has(dataset)
    || typeof row.partition_key !== 'string'
    || row.partition_key.length < 1
    || row.partition_key.length > 128
    || !['INTERACTIVE', 'SCHEDULED'].includes(row.queue_class)
    || !row.permission_evidence
    || row.permission_state !== 'READ_ONLY_VERIFIED'
    || !HEX_64_PATTERN.test(row.envelope_sha256 ?? '')
    || !Number.isSafeInteger(row.page_number)
    || row.page_number < 0
    || !(row.previous_page_digest === null || HEX_64_PATTERN.test(row.previous_page_digest ?? ''))
  ) throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid claim response');
  const pageCursor = canonicalPageCursor(dataset, row.page_cursor);
  const query = queryForClaim(dataset, row.partition_key, pageCursor);
  return Object.freeze({
    jobId: row.job_id.toLowerCase(),
    attemptId: row.attempt_id.toLowerCase(),
    claimToken: row.claim_token.toLowerCase(),
    connectionId: row.connection_id.toLowerCase(),
    credentialVersion: row.credential_version,
    tenantId: row.tenant_id.toLowerCase(),
    requestedBy: row.requested_by.toLowerCase(),
    dataset,
    partitionKey: row.partition_key,
    query,
    pageCursor,
    pageNumber: row.page_number,
    previousPageDigest: row.previous_page_digest,
    envelope: Object.freeze({
      version: 1,
      credentialVersion: row.credential_version,
      ciphertext: row.envelope_ciphertext,
      nonce: row.envelope_nonce,
      keyRef: row.envelope_key_ref,
      sha256: row.envelope_sha256,
    }),
  });
}

export async function adaptSourceEventsForCommit(events) {
  if (!Array.isArray(events) || events.length > 1_000) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'event page unavailable');
  }
  return Object.freeze(events.map((event) => {
    if (
      !event
      || typeof event !== 'object'
      || Array.isArray(event)
      || typeof event.eventId !== 'string'
      || event.eventId.length < 1
      || event.eventId.length > 192
      || typeof event.observedAt !== 'string'
      || !Number.isFinite(Date.parse(event.observedAt))
      || !event.payload
      || typeof event.payload !== 'object'
      || Array.isArray(event.payload)
    ) throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'event page unavailable');
    const payload = canonicalProviderValue(event.payload);
    if (canonicalJson(payload).length > 256_000) {
      throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'event page unavailable');
    }
    return Object.freeze({
      providerEventId: event.eventId,
      eventTime: event.observedAt,
      payload,
    });
  }));
}

function toCamelRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, character) => character.toUpperCase()),
    value,
  ]));
}

function databaseError(value) {
  const code = value && typeof value === 'object' && !Array.isArray(value)
    ? String(value.code ?? '')
    : '';
  if (code === 'P0002') return new BinanceBetaRuntimeError('NOT_FOUND', 'resource unavailable');
  if (code === 'P0003') return new BinanceBetaRuntimeError('AUTH_INVALID', 'authentication required');
  if (code === 'P0006' || code === '40001' || code === '23505') {
    return new BinanceBetaRuntimeError('CONFLICT', 'write conflict');
  }
  if (code === 'P0004' || code === 'P0005') {
    return new BinanceBetaRuntimeError('RATE_LIMITED', 'database admission rejected', { retryable: true });
  }
  return new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'database unavailable', { retryable: true });
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) {
    try { await response.body?.cancel('upstream response too large'); } catch { /* no-op */ }
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'upstream response unavailable', { retryable: true });
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES) {
        await reader.cancel('upstream response too large');
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'upstream response unavailable', { retryable: true });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof BinanceBetaRuntimeError) throw error;
    throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'upstream response unavailable', { retryable: true });
  } finally {
    reader.releaseLock();
  }
}

async function hmacBytes(keyBytes, value) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function hmacHex(keyBytes, value) {
  const bytes = await hmacBytes(keyBytes, value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicConnectionId(tenantId, idempotencyKey, keyBytes) {
  const bytes = await hmacBytes(keyBytes, `rv-beta-connection-id/1\0${tenantId}\0${idempotencyKey}`);
  const uuid = bytes.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = [...uuid].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function statusForBrowser(status) {
  const map = {
    VERIFYING: 'PENDING',
    ACTIVE: 'ACTIVE',
    AUTH_ERROR: 'ERROR',
    RATE_LIMITED: 'STALE',
    DISABLED: 'ERROR',
    REVOKED: 'DISCONNECTED',
  };
  return map[status] ?? status;
}

function connectionForBrowser(raw) {
  const row = toCamelRow(raw);
  return {
    ...row,
    status: statusForBrowser(row.status),
  };
}

function eventIdentity(dataset, partitionKey, row, index) {
  const candidates = {
    fills: row.id,
    income: row.tranId,
    orders: row.orderId,
    algo_orders: row.algoId,
    force_orders: `${row.symbol}:${row.orderId}`,
    balances: `${row.asset ?? 'UNKNOWN'}:${row.updateTime ?? row.time ?? index}`,
    positions: `${row.symbol ?? partitionKey}:${row.positionSide ?? 'BOTH'}:${row.updateTime ?? row.time ?? index}`,
  };
  const identity = candidates[dataset];
  if (identity === undefined || identity === null || String(identity).length < 1) {
    throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'provider identity unavailable');
  }
  return `binance-usdm:${dataset}:${partitionKey}:${String(identity)}`;
}

function eventTime(row, fallback) {
  for (const key of ['time', 'updateTime', 'tradeTime', 'transactTime']) {
    const text = row?.[key];
    if (typeof text !== 'string' || !/^\d{1,16}$/u.test(text)) continue;
    const value = Number(text);
    if (Number.isSafeInteger(value) && value > 0) return new Date(value).toISOString();
  }
  return fallback;
}

function cursorFromFullPage(endpoint, query, rows) {
  if (rows.length !== PAGE_LIMIT) return null;
  const nextFromField = (field, cursorKey) => {
    const values = rows.map((row) => canonicalUnsignedInteger(row[field], field));
    const maximum = values.reduce((left, right) => (BigInt(left) > BigInt(right) ? left : right));
    return Object.freeze({ [cursorKey]: (BigInt(maximum) + 1n).toString() });
  };
  if (endpoint === 'userTrades') return nextFromField('id', 'fromId');
  if (endpoint === 'allOrders') return nextFromField('orderId', 'orderId');
  if (endpoint === 'allAlgoOrders') return nextFromField('algoId', 'algoId');
  if (endpoint === 'income') {
    const page = Object.hasOwn(query, 'page') ? canonicalUnsignedInteger(query.page, 'page') : '1';
    return Object.freeze({ page: (BigInt(page) + 1n).toString() });
  }
  if (endpoint === 'forceOrders') return nextFromField('time', 'startTime');
  throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'bounded continuation unavailable');
}

function ledgerInputForPage(dataset, events) {
  const payloads = events.map((event) => event.payload);
  return {
    fills: dataset === 'fills' ? payloads : [],
    income: dataset === 'income' ? payloads : [],
    incomeCoverage: 'PARTIAL',
  };
}

async function ledgerShadowForPage(dataset, events) {
  let projection;
  let reasonCodes = ['ORACLE_NOT_AVAILABLE', 'PAGE_SCOPED_PROJECTION'];
  try {
    projection = projectBinanceUsdmLedger(ledgerInputForPage(dataset, events));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^LEDGER_[A-Z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : 'LEDGER_PROJECTION_UNAVAILABLE';
    reasonCodes = [...reasonCodes, code].sort();
    projection = Object.freeze({
      protocol: 'rv-ledger-shadow-page/1',
      state: 'INCOMPLETE',
      dataset,
      eventCount: String(events.length),
      reasonCodes: Object.freeze([code]),
    });
  }
  const projectionDigest = await sha256Hex(canonicalJson(projection));
  const summary = {
    protocol: 'rv-reconciliation/2',
    stage: 'SHADOW',
    status: 'NOT_EVALUATED',
    realGeneration: false,
    generation: null,
    reasonCodes,
    checks: {
      balancedEntries: projection.protocol === 'rv-ledger-projection/1' ? 'DERIVED' : 'NOT_EVALUATED',
      assetParity: 'NOT_EVALUATED',
      positionParity: 'NOT_EVALUATED',
    },
    diffs: [],
    projectionDigest,
  };
  return Object.freeze({
    projection,
    projectionDigest,
    reconciliation: Object.freeze({
      ...summary,
      summaryDigest: await sha256Hex(canonicalJson(summary)),
    }),
  });
}

async function postCommitEffectForPage(dataset, events) {
  const symbols = Object.freeze([...new Set(events
    .map((event) => event.payload?.symbol)
    .filter((symbol) => typeof symbol === 'string' && SYMBOL_PATTERN.test(symbol)))]
    .sort((left, right) => left.localeCompare(right, 'en')));
  const ledgerShadow = ['fills', 'income'].includes(dataset)
    ? await ledgerShadowForPage(dataset, events)
    : null;
  return Object.freeze({
    protocol: 'rv-sync-post-commit/1',
    symbols,
    ledgerShadow,
  });
}

export function createRuntimeDependencies(config, options = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('runtime config required');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required');
  const baseHeaders = { 'Cache-Control': 'no-store' };

  async function jsonFetch(input, init, context) {
    let response;
    try {
      response = await fetchImpl(input, { ...init, redirect: 'error', signal: context.signal });
    } catch {
      throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'upstream unavailable', { retryable: true });
    }
    return Object.freeze({ response, value: await readBoundedJson(response) });
  }

  async function rpc(name, body, token, service, context) {
    const bearer = service ? config.serviceRoleKey : token;
    const apikey = service ? config.serviceRoleKey : config.anonKey;
    const { response, value } = await jsonFetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    }, context);
    if (!response.ok) throw databaseError(value);
    return value;
  }

  const publicDeps = {
    allowedOrigin: config.allowedOrigin,
    deadlineMs: 10_000,
    nowIso: () => new Date().toISOString(),
    async verifyUser(token, context) {
      const { response, value } = await jsonFetch(`${config.supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: { ...baseHeaders, apikey: config.anonKey, Authorization: `Bearer ${token}` },
      }, context);
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'Auth unavailable', { retryable: true });
      }
      return { id: value.id, is_anonymous: value.is_anonymous === true };
    },
    async getTenantContext(token, context) {
      const row = oneRow(await rpc('rv2_get_tenant_context', {}, token, false, context), 'tenant context');
      return { tenantId: row.tenant_id, memberRole: String(row.member_role ?? '').toLowerCase() };
    },
    deriveConnectionId({ tenantId, idempotencyKey }) {
      return deterministicConnectionId(tenantId, idempotencyKey, config.scopeHmacKey);
    },
    probeReadOnlyPermissions(credentials, context) {
      return createBinanceClient({ fetch: fetchImpl, signal: context.signal }).verifyReadOnly(credentials);
    },
    permissionEvidenceDigest(conclusion) {
      // handler's second argument is an Abort context, not a Crypto override.
      return permissionEvidenceDigest(conclusion);
    },
    providerScopeHash(apiKey) {
      return providerScopeHash(apiKey, config.scopeHmacKey);
    },
    async credentialRequestFingerprint(input) {
      return hmacHex(config.scopeHmacKey, [
        'rv-beta-credential-request/1', input.operation, input.tenantId, input.connectionId,
        String(input.expectedCredentialVersion), input.apiKey, input.apiSecret, input.consentVersion,
      ].join('\0'));
    },
    encryptCredentialEnvelope(input) {
      return encryptCredentialEnvelope({ ...input, kekBytes: config.credentialKek });
    },
    async createOrRotateConnection(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_create_or_rotate_connection', {
        p_subject: input.subject,
        p_tenant_id: input.tenantId,
        p_connection_id: input.connectionId,
        p_provider: 'binance',
        p_provider_scope_hash: input.providerScopeHash,
        p_permission_state: input.permissionState,
        p_permission_evidence: input.permissionEvidence,
        p_consent_version: input.consentVersion,
        p_envelope_ciphertext: input.envelopeCiphertext,
        p_envelope_nonce: input.envelopeNonce,
        p_envelope_key_ref: input.envelopeKeyRef,
        p_envelope_sha256: input.envelopeSha256,
        p_expected_credential_version: input.expectedCredentialVersion,
        p_idempotency_key: input.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
      }, null, true, context), 'connection write'));
      return connectionForBrowser(row);
    },
    async listConnections(token, context) {
      const value = await rpc('rv2_list_connections', {}, token, false, context);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.connections)) {
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid connection list');
      }
      return { ...value, connections: value.connections.map(connectionForBrowser) };
    },
    async getDatasetStatus(input, context) {
      const value = await rpc('rv2_get_dataset_status', { p_connection_id: input.connectionId }, input.token, false, context);
      const dataset = canonicalBrowserDataset(input.dataset);
      const coverage = value?.coverage?.[dataset === 'fills' ? 'trades' : dataset];
      if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid coverage response');
      }
      return {
        state: coverage.state === 'VERIFIED' ? 'COMPLETE' : coverage.state,
        attemptedThrough: coverage.attempted ?? null,
        fetchedThrough: coverage.fetched ?? null,
        committedThrough: coverage.committed ?? null,
        trustedThrough: coverage.trusted ?? null,
        currentGeneration: Number.isSafeInteger(value.currentGeneration) ? value.currentGeneration : 0,
        gaps: coverage.gaps ?? [],
      };
    },
    async getCurrentDataset(input, context) {
      return rpc('rv2_get_current_dataset', {
        p_connection_id: input.connectionId,
      }, input.token, false, context);
    },
    async getTrades(input, context) {
      return rpc('rv2_get_trades', {
        p_connection_id: input.connectionId,
      }, input.token, false, context);
    },
    async getReviews(input, context) {
      return rpc('rv2_get_reviews', {
        p_connection_id: input.connectionId,
      }, input.token, false, context);
    },
    async upsertReview(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_upsert_review', {
        p_connection_id: input.connectionId,
        p_trade_id: input.tradeId,
        p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
      }, input.token, false, context), 'review write'));
    },
    async upsertAction(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_upsert_action', {
        p_connection_id: input.connectionId,
        p_action_id: input.actionId,
        p_review_id: input.reviewId,
        p_trade_id: input.tradeId,
        p_status: input.status,
        p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
      }, input.token, false, context), 'action write'));
    },
    async upsertJournal(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_upsert_journal', {
        p_connection_id: input.connectionId,
        p_journal_day: input.day,
        p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
      }, input.token, false, context), 'journal write'));
    },
    async upsertRiskRule(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_upsert_risk_rule', {
        p_connection_id: input.connectionId,
        p_rule_id: input.ruleId,
        p_status: input.status,
        p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
      }, input.token, false, context), 'risk write'));
    },
    async upsertReport(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_upsert_report', {
        p_connection_id: input.connectionId,
        p_report_type: input.reportType,
        p_period_start: input.periodStart,
        p_period_end: input.periodEnd,
        p_source_generation: input.sourceGeneration,
        p_expected_version: input.expectedVersion,
        p_idempotency_key: input.idempotencyKey,
        p_payload: input.payload,
      }, input.token, false, context), 'report write'));
    },
    async executeDestructiveOperation(input, context) {
      const { response, value } = await jsonFetch(`${config.supabaseUrl}/functions/v1/delete-account`, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/json',
          apikey: config.anonKey,
          Authorization: `Bearer ${input.token}`,
          Origin: config.allowedOrigin,
        },
        body: JSON.stringify(input.protocol),
      }, context);
      if (!response.ok) {
        const remoteCode = value && typeof value === 'object' && !Array.isArray(value)
          ? String(value.error ?? value.code ?? '')
          : '';
        const mapped = {
          authentication_required: 'AUTH_INVALID',
          recent_reauthentication_required: 'REAUTH_REQUIRED',
          deletion_request_not_found: 'DELETION_REQUEST_NOT_FOUND',
          deletion_request_expired: 'DELETION_REQUEST_EXPIRED',
          idempotency_conflict: 'IDEMPOTENCY_CONFLICT',
          invalid_request: 'REQUEST_INVALID',
        }[remoteCode];
        if (mapped) throw new BinanceBetaRuntimeError(mapped, 'deletion operation rejected');
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'deletion operation unavailable', { retryable: true });
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'deletion operation unavailable');
      }
      return value;
    },
    async enqueueSync(input, context) {
      const dataset = canonicalBrowserDataset(input.dataset);
      const partitionKey = input.partitionKey;
      if (typeof partitionKey !== 'string' || partitionKey.length > 128) {
        throw new BinanceBetaRuntimeError('REQUEST_INVALID', 'sync partition unavailable');
      }
      if (['fills', 'orders', 'algo_orders'].includes(dataset) && !SYMBOL_PATTERN.test(partitionKey)) {
        throw new BinanceBetaRuntimeError('REQUEST_INVALID', 'audited symbol partition required');
      }
      else if (dataset === 'balances' && !['default', 'account-wide'].includes(partitionKey)) {
        throw new BinanceBetaRuntimeError('REQUEST_INVALID', 'sync partition unavailable');
      } else if (!['default', 'account-wide'].includes(partitionKey)) canonicalSymbol(partitionKey);
      const row = toCamelRow(oneRow(await rpc('rv2_enqueue_sync', {
        p_connection_id: input.connectionId,
        p_dataset: dataset,
        p_partition_key: partitionKey,
        p_idempotency_key: input.idempotencyKey,
      }, input.token, false, context), 'enqueue'));
      return row;
    },
    async disconnectConnection(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_disconnect_connection', {
        p_connection_id: input.connectionId,
        p_expected_credential_version: input.expectedCredentialVersion,
      }, input.token, false, context), 'disconnect'));
      return { ...connectionForBrowser(row), receiptId: row.receiptId };
    },
  };

  const internalDeps = {
    workerSubject: config.workerSubject,
    syncCronToken: config.syncCronToken,
    archiveCronToken: config.archiveCronToken,
    async buildPostCommitEffect(input) {
      if (!input || typeof input !== 'object' || !PUBLIC_DATASETS.has(input.dataset) || !Array.isArray(input.events)) {
        throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'post-commit effect unavailable');
      }
      return postCommitEffectForPage(input.dataset, input.events);
    },
    async claimPostCommitWork(input, context) {
      const value = await rpc('rv2_service_claim_post_commit_work', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_lease_seconds: 120,
      }, null, true, context);
      if (Array.isArray(value) && value.length === 0) return null;
      const row = toCamelRow(oneRow(value, 'post-commit claim'));
      if (
        !UUID_PATTERN.test(row.workId ?? '')
        || !UUID_PATTERN.test(row.jobId ?? '')
        || !UUID_PATTERN.test(row.connectionId ?? '')
        || !UUID_PATTERN.test(row.leaseToken ?? '')
        || !Number.isSafeInteger(row.credentialVersion)
        || row.credentialVersion < 1
        || !UUID_PATTERN.test(row.attemptId ?? '')
        || row.workKind !== 'SYNC_EFFECTS'
        || !HEX_64_PATTERN.test(row.inputDigest ?? '')
      ) throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid post-commit claim response');
      return Object.freeze({
        workId: row.workId,
        jobId: row.jobId,
        connectionId: row.connectionId,
        credentialVersion: row.credentialVersion,
        attemptId: row.attemptId.toLowerCase(),
        leaseToken: row.leaseToken,
        workKind: row.workKind,
        inputDigest: row.inputDigest,
      });
    },
    async completePostCommitWork(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_complete_post_commit_work', {
        p_worker_subject: input.workerSubject,
        p_work_id: input.workId,
        p_job_id: input.jobId,
        p_credential_version: input.credentialVersion,
        p_attempt_id: input.attemptId,
        p_lease_token: input.leaseToken,
        p_input_digest: input.inputDigest,
      }, null, true, context), 'post-commit complete'));
      return { ...row, status: row.status === 'DONE' ? 'COMPLETED' : row.status };
    },
    async failPostCommitWork(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_fail_post_commit_work', {
        p_worker_subject: input.workerSubject,
        p_work_id: input.workId,
        p_job_id: input.jobId,
        p_credential_version: input.credentialVersion,
        p_attempt_id: input.attemptId,
        p_lease_token: input.leaseToken,
        p_input_digest: input.inputDigest,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      }, null, true, context), 'post-commit failure'));
      return { ...row, status: row.status === 'PENDING' ? 'QUEUED' : row.status };
    },
    createArchiveState,
    async claimArchiveJob(input, context) {
      const value = await rpc('rv2_service_claim_archive_job', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_lease_seconds: 120,
      }, null, true, context);
      if (Array.isArray(value) && value.length === 0) return null;
      const row = oneRow(value, 'archive claim');
      if (
        !UUID_PATTERN.test(row.job_id ?? '')
        || !UUID_PATTERN.test(row.tenant_id ?? '')
        || !UUID_PATTERN.test(row.connection_id ?? '')
        || !UUID_PATTERN.test(row.claim_token ?? '')
        || !Number.isSafeInteger(row.credential_version)
        || row.credential_version < 1
        || !['fills', 'orders', 'income'].includes(row.dataset)
        || !/^\d{1,128}$/u.test(row.window_start ?? '')
        || !/^\d{1,128}$/u.test(row.window_end ?? '')
        || !(row.state === null || (row.state && typeof row.state === 'object' && !Array.isArray(row.state)))
        || !HEX_64_PATTERN.test(row.envelope_sha256 ?? '')
      ) throw new BinanceBetaRuntimeError('UPSTREAM_UNAVAILABLE', 'invalid archive claim response');
      return Object.freeze({
        jobId: row.job_id.toLowerCase(),
        claimToken: row.claim_token.toLowerCase(),
        connectionId: row.connection_id.toLowerCase(),
        credentialVersion: row.credential_version,
        tenantId: row.tenant_id.toLowerCase(),
        dataset: row.dataset,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        state: row.state === null ? null : Object.freeze({ ...row.state }),
        envelope: Object.freeze({
          version: 1,
          credentialVersion: row.credential_version,
          ciphertext: row.envelope_ciphertext,
          nonce: row.envelope_nonce,
          keyRef: row.envelope_key_ref,
          sha256: row.envelope_sha256,
        }),
      });
    },
    async runArchiveStep(input, context) {
      if (
        !input
        || typeof input !== 'object'
        || !UUID_PATTERN.test(input.jobId ?? '')
        || !UUID_PATTERN.test(input.claimToken ?? '')
        || !Number.isSafeInteger(input.credentialVersion)
        || input.credentialVersion < 1
      ) throw new BinanceBetaRuntimeError('REQUEST_INVALID', 'archive job context unavailable');
      const client = createBinanceClient({
        fetch: fetchImpl,
        signal: context.signal,
        onGlobalCircuit: async (retryAfterSeconds) => {
          try {
            const row = toCamelRow(oneRow(await rpc('rv2_service_open_worker_circuit', {
              p_worker_subject: config.workerSubject,
              p_error_code: 'GLOBAL_CIRCUIT_OPEN',
              p_retry_after_seconds: retryAfterSeconds,
            }, null, true, context), 'worker circuit'));
            if (!validIsoOrNull(row.circuitOpenUntil) || row.circuitOpenUntil === null) {
              throw new Error('invalid worker circuit response');
            }
          } catch {
            // Preserve the bounded Binance classification. The archive failure
            // RPC will retry the same idempotent breaker update while releasing
            // the archive lease.
            throw new BinanceBetaRuntimeError(
              'GLOBAL_CIRCUIT_OPEN',
              'Binance circuit open',
              { retryable: true, retryAfterSeconds },
            );
          }
        },
      });
      return runArchiveStateStep(input.state, {
        nowMs: typeof options.nowMs === 'function' ? options.nowMs : () => Date.now(),
        client,
        stagePrivateLink: async (link) => {
          const row = toCamelRow(oneRow(await rpc('rv2_service_stage_archive_link', {
            p_worker_subject: config.workerSubject,
            p_job_id: input.jobId,
            p_claim_token: input.claimToken,
            p_credential_version: input.credentialVersion,
            p_dataset: link.dataset,
            p_window_start: link.windowStart,
            p_window_end: link.windowEnd,
            p_download_id: link.downloadId,
            p_download_url: link.downloadUrl,
            p_expires_at: link.expiresAt,
          }, null, true, context), 'archive private stage'));
          return { archiveId: row.archiveId, status: row.status };
        },
      }, input.credentials);
    },
    async commitArchiveState(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_commit_archive_state', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_credential_version: input.credentialVersion,
        p_state: input.state,
      }, null, true, context), 'archive state commit'));
      return { jobId: row.jobId, status: row.status };
    },
    async failArchiveJob(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_fail_archive_job', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_credential_version: input.credentialVersion,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      }, null, true, context), 'archive failure'));
      return { jobId: row.jobId, status: row.status };
    },
    async claimSyncJob(input, context) {
      const value = await rpc('rv2_service_claim_sync_job', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_queue_class: input.queueClass === 'BINANCE_USDM' ? null : input.queueClass,
        p_lease_seconds: 120,
      }, null, true, context);
      if (Array.isArray(value) && value.length === 0) return null;
      return adaptServiceClaim(value);
    },
    decryptCredentialEnvelope(input) {
      return decryptCredentialEnvelope({ ...input, kekBytes: config.credentialKek });
    },
    async fetchBinancePage(input, context) {
      const client = createBinanceClient({ fetch: fetchImpl, signal: context.signal });
      const raw = await client.get(input.endpoint, input.query, input.credentials);
      const rawRows = Array.isArray(raw)
        ? raw
        : input.endpoint === 'account' && raw && typeof raw === 'object'
          ? (Array.isArray(raw.assets)
            ? raw.assets.map((asset) => ({ ...asset, updateTime: raw.updateTime }))
            : [])
          : [];
      const rows = Object.freeze(rawRows.map((row) => canonicalProviderValue(row)));
      const attemptedThrough = new Date().toISOString();
      const retentionBoundary = new Date(Date.parse(attemptedThrough) - 90 * 24 * 60 * 60 * 1_000).toISOString();
      const nextCursor = cursorFromFullPage(input.endpoint, input.query, rows);
      const pageDigest = await sha256Hex(canonicalJson(rows));
      return {
        rows,
        attemptedThrough,
        fetchedThrough: rows.length > 0 ? attemptedThrough : null,
        committedThrough: rows.length > 0 ? attemptedThrough : null,
        trustedThrough: null,
        coverageState: rows.length > 0 ? 'PARTIAL' : 'UNKNOWN',
        gaps: [{ code: 'HISTORY_NOT_YET_PROVEN', from: retentionBoundary, to: attemptedThrough }],
        nextCursor,
        hasMore: nextCursor !== null,
        pageDigest,
      };
    },
    async normalizeSourceEvents(input) {
      const now = new Date().toISOString();
      return Promise.all(input.rows.map(async (row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new BinanceBetaRuntimeError('NORMALIZATION_CONFLICT', 'invalid Binance row');
        }
        const payload = canonicalDatasetPayload(input.dataset, input.partitionKey, row);
        const eventId = eventIdentity(input.dataset, input.partitionKey, payload, index);
        return {
          eventId,
          source: 'BINANCE',
          market: 'USD_M',
          sourceEndpoint: input.sourceEndpoint,
          observedAt: eventTime(payload, now),
          payload,
        };
      }));
    },
    async commitSyncPage(input, context) {
      const row = toCamelRow(oneRow(await rpc('rv2_service_commit_sync_page', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_credential_version: input.credentialVersion,
        p_events: await adaptSourceEventsForCommit(input.events),
        p_attempted_through: input.attemptedThrough,
        p_fetched_through: input.fetchedThrough,
        p_committed_through: input.committedThrough,
        p_trusted_through: input.trustedThrough,
        p_coverage_state: input.coverageState === 'COMPLETE' ? 'VERIFIED' : input.coverageState,
        p_gaps: input.gaps,
        p_next_cursor: input.nextCursor,
        p_has_more: input.hasMore,
        p_page_digest: input.pageDigest,
        p_post_commit_effect: input.postCommitEffect,
      }, null, true, context), 'commit'));
      return {
        ...row,
        status: row.status === 'SUCCEEDED' ? 'COMPLETED' : row.status,
      };
    },
    async failSyncJob(input, context) {
      return toCamelRow(oneRow(await rpc('rv2_service_fail_sync_job', {
        p_worker_subject: input.workerSubject,
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_credential_version: input.credentialVersion,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
        p_retry_after_seconds: input.retryAfterSeconds,
      }, null, true, context), 'failure'));
    },
  };

  return Object.freeze({ publicDeps: Object.freeze(publicDeps), internalDeps: Object.freeze(internalDeps) });
}
