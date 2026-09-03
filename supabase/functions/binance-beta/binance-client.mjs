export const BINANCE_HOSTS = Object.freeze(['api.binance.com', 'fapi.binance.com']);

export const BINANCE_ENDPOINTS = Object.freeze({
  apiRestrictions: Object.freeze(['api.binance.com', '/sapi/v1/account/apiRestrictions']),
  time: Object.freeze(['fapi.binance.com', '/fapi/v1/time']),
  userTrades: Object.freeze(['fapi.binance.com', '/fapi/v1/userTrades']),
  income: Object.freeze(['fapi.binance.com', '/fapi/v1/income']),
  allOrders: Object.freeze(['fapi.binance.com', '/fapi/v1/allOrders']),
  allAlgoOrders: Object.freeze(['fapi.binance.com', '/fapi/v1/allAlgoOrders']),
  forceOrders: Object.freeze(['fapi.binance.com', '/fapi/v1/forceOrders']),
  account: Object.freeze(['fapi.binance.com', '/fapi/v3/account']),
  positionRisk: Object.freeze(['fapi.binance.com', '/fapi/v3/positionRisk']),
  orderHistoryRequest: Object.freeze(['fapi.binance.com', '/fapi/v1/order/asyn']),
  orderHistoryPoll: Object.freeze(['fapi.binance.com', '/fapi/v1/order/asyn/id']),
  tradeHistoryRequest: Object.freeze(['fapi.binance.com', '/fapi/v1/trade/asyn']),
  tradeHistoryPoll: Object.freeze(['fapi.binance.com', '/fapi/v1/trade/asyn/id']),
  incomeHistoryRequest: Object.freeze(['fapi.binance.com', '/fapi/v1/income/asyn']),
  incomeHistoryPoll: Object.freeze(['fapi.binance.com', '/fapi/v1/income/asyn/id']),
});

const QUERY_KEYS = Object.freeze({
  apiRestrictions: [],
  time: [],
  userTrades: ['symbol', 'startTime', 'endTime', 'fromId', 'limit'],
  income: ['symbol', 'incomeType', 'startTime', 'endTime', 'page', 'limit'],
  allOrders: ['symbol', 'orderId', 'startTime', 'endTime', 'limit'],
  allAlgoOrders: ['symbol', 'algoId', 'startTime', 'endTime', 'limit'],
  forceOrders: ['symbol', 'autoCloseType', 'startTime', 'endTime', 'limit'],
  account: ['omitZeroBalances'],
  positionRisk: ['symbol'],
  orderHistoryRequest: ['startTime', 'endTime'],
  orderHistoryPoll: ['downloadId'],
  tradeHistoryRequest: ['startTime', 'endTime'],
  tradeHistoryPoll: ['downloadId'],
  incomeHistoryRequest: ['startTime', 'endTime'],
  incomeHistoryPoll: ['downloadId'],
});

const REQUIRED_PERMISSION_FIELDS = Object.freeze([
  'ipRestrict',
  'createTime',
  'enableReading',
  'enableWithdrawals',
  'enableInternalTransfer',
  'permitsUniversalTransfer',
  'enableSpotAndMarginTrading',
  'enableFutures',
  'enableMargin',
  'enableVanillaOptions',
  'enableFixApiTrade',
  'enableFixReadOnly',
  'enablePortfolioMarginTrading',
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const INTEGER_QUERY_KEYS = new Set([
  'startTime', 'endTime', 'fromId', 'limit', 'page', 'orderId', 'algoId',
]);
const ARCHIVE_REQUEST_ENDPOINTS = new Set([
  'orderHistoryRequest', 'tradeHistoryRequest', 'incomeHistoryRequest',
]);
const ARCHIVE_POLL_ENDPOINTS = new Set([
  'orderHistoryPoll', 'tradeHistoryPoll', 'incomeHistoryPoll',
]);
const MAX_JSON_DEPTH = 16;
const MAX_JSON_CONTAINER_ITEMS = 10_000;
const MAX_JSON_VALUES = 100_000;
const MAX_JSON_INTEGER_DIGITS = 128;
const encoder = new TextEncoder();

export class BinanceBetaError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BinanceBetaError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.retryAfterSeconds = Number.isSafeInteger(options.retryAfterSeconds)
      ? options.retryAfterSeconds
      : 0;
  }
}

export function validateReadOnlyPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'permission evidence unavailable');
  }
  const receivedFields = Object.keys(value).sort();
  const expectedFields = [...REQUIRED_PERMISSION_FIELDS].sort();
  if (receivedFields.length !== expectedFields.length
      || receivedFields.some((key, index) => key !== expectedFields[index])) {
    throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'permission evidence schema changed');
  }
  for (const key of REQUIRED_PERMISSION_FIELDS) {
    if (!Object.hasOwn(value, key)) {
      throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'permission evidence incomplete');
    }
  }
  if (typeof value.ipRestrict !== 'boolean'
      || exactSafeInteger(value.createTime, false) === null) {
    throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'permission evidence incomplete');
  }
  for (const key of REQUIRED_PERMISSION_FIELDS.filter((field) => field.startsWith('enable') || field === 'permitsUniversalTransfer')) {
    if (typeof value[key] !== 'boolean') {
      throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'permission evidence incomplete');
    }
  }
  const dangerous = [
    'enableWithdrawals',
    'enableInternalTransfer',
    'permitsUniversalTransfer',
    'enableSpotAndMarginTrading',
    'enableFutures',
    'enableMargin',
    'enableVanillaOptions',
    'enableFixApiTrade',
    'enablePortfolioMarginTrading',
  ];
  if (value.enableReading !== true || dangerous.some((key) => value[key] !== false)) {
    throw new BinanceBetaError('PERMISSION_UNSAFE', 'read-only permission required');
  }
  return Object.freeze({
    readOnly: true,
    tradeDisabled: true,
    withdrawDisabled: true,
    internalTransferDisabled: true,
    universalTransferDisabled: true,
  });
}

function retryAfter(response, fallback) {
  const value = response.headers.get('retry-after') ?? '';
  if (/^[1-9][0-9]{0,3}$/.test(value)) return Math.min(Number(value), 3600);
  return fallback;
}

function exactSafeInteger(value, signed = true) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) ? String(value) : '')
    : value;
  const pattern = signed ? /^-?(?:0|[1-9]\d*)$/u : /^(?:0|[1-9]\d*)$/u;
  if (typeof text !== 'string' || text.length > 17 || !pattern.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && (signed || number >= 0) ? number : null;
}

// Binance's order/trade identifiers are int64 values. Native JSON.parse turns
// an unquoted token into a JavaScript Number before the caller can reject or
// normalize it, irreversibly rounding values above 2^53. This bounded parser
// therefore keeps every integer token as a canonical decimal string. Binance
// documents monetary decimals as JSON strings; fractional or exponent-form
// number tokens are treated as an upstream schema conflict and fail closed.
export function parseLosslessJson(text) {
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_BYTES) {
    throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
  }
  let index = 0;
  let valueCount = 0;
  const reject = () => {
    throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
  };
  const whitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    if (text[index] !== '"') reject();
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try { return JSON.parse(text.slice(start, index)); } catch { reject(); }
      }
      if (code < 0x20) reject();
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/u.test(text[index])) reject();
        if (text[index] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) reject();
          index += 4;
        }
      }
      index += 1;
    }
    reject();
  };
  const parseInteger = () => {
    const start = index;
    if (text[index] === '-') index += 1;
    if (text[index] === '0') {
      index += 1;
      if (/\d/u.test(text[index] ?? '')) reject();
    } else {
      if (!/[1-9]/u.test(text[index] ?? '')) reject();
      while (/\d/u.test(text[index] ?? '')) index += 1;
    }
    if (text[index] === '.' || text[index] === 'e' || text[index] === 'E') reject();
    const token = text.slice(start, index);
    const digits = token[0] === '-' ? token.length - 1 : token.length;
    if (digits < 1 || digits > MAX_JSON_INTEGER_DIGITS) reject();
    try { return BigInt(token).toString(); } catch { reject(); }
  };
  const parseValue = (depth) => {
    whitespace();
    if (depth > MAX_JSON_DEPTH || ++valueCount > MAX_JSON_VALUES) reject();
    if (text[index] === '"') return parseString();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    if (text[index] === '-' || /\d/u.test(text[index] ?? '')) return parseInteger();
    if (text[index] === '[') {
      index += 1;
      const result = [];
      whitespace();
      if (text[index] === ']') { index += 1; return result; }
      while (result.length < MAX_JSON_CONTAINER_ITEMS) {
        result.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === ']') { index += 1; return result; }
        if (text[index] !== ',') reject();
        index += 1;
      }
      reject();
    }
    if (text[index] === '{') {
      index += 1;
      const result = {};
      const keys = new Set();
      whitespace();
      if (text[index] === '}') { index += 1; return result; }
      while (keys.size < MAX_JSON_CONTAINER_ITEMS) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) reject();
        keys.add(key);
        whitespace();
        if (text[index] !== ':') reject();
        index += 1;
        const value = parseValue(depth + 1);
        Object.defineProperty(result, key, {
          value, enumerable: true, configurable: true, writable: true,
        });
        whitespace();
        if (text[index] === '}') { index += 1; return result; }
        if (text[index] !== ',') reject();
        index += 1;
      }
      reject();
    }
    reject();
  };
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) reject();
  return value;
}

async function readBoundedJson(response) {
  const declaredText = response.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isFinite(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
      try { await response.body?.cancel('upstream response too large'); } catch { /* no-op */ }
      throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
    }
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel('upstream response too large');
        throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? parseLosslessJson(text) : null;
  } catch (error) {
    if (error instanceof BinanceBetaError) throw error;
    throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
  } finally {
    reader.releaseLock();
  }
}

async function hmacSha256(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertCredentials(credentials) {
  if (
    !credentials
    || typeof credentials.apiKey !== 'string'
    || typeof credentials.apiSecret !== 'string'
    || credentials.apiKey.length < 16
    || credentials.apiKey.length > 256
    || credentials.apiSecret.length < 16
    || credentials.apiSecret.length > 256
  ) throw new BinanceBetaError('AUTH_DISABLED', 'Binance authentication unavailable');
}

function queryParameters(endpoint, query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
  }
  const allowed = new Set(QUERY_KEYS[endpoint]);
  const entries = Object.entries(query);
  for (const [key, value] of entries) {
    if (!allowed.has(key)) throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
    if (!['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
      || (typeof value === 'string' && (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)))) {
      throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
    }
    if (INTEGER_QUERY_KEYS.has(key)) {
      const text = typeof value === 'number' ? String(value) : value;
      if (typeof text !== 'string' || !/^\d{1,128}$/u.test(text)) {
        throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
      }
    }
    if (key === 'symbol' && (typeof value !== 'string' || !/^[A-Z0-9]{3,32}$/u.test(value))) {
      throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
    }
    if (key === 'downloadId' && (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,256}$/u.test(value))) {
      throw new BinanceBetaError('QUERY_FORBIDDEN', 'Binance query forbidden');
    }
  }
  if (endpoint === 'userTrades' && !entries.some(([key]) => key === 'symbol')) {
    throw new BinanceBetaError('QUERY_FORBIDDEN', 'audited symbol partition required');
  }
  if (ARCHIVE_REQUEST_ENDPOINTS.has(endpoint)) {
    if (entries.length !== 2 || !Object.hasOwn(query, 'startTime') || !Object.hasOwn(query, 'endTime')) {
      throw new BinanceBetaError('QUERY_FORBIDDEN', 'archive window required');
    }
    const start = BigInt(String(query.startTime));
    const end = BigInt(String(query.endTime));
    if (start > end || end - start > 365n * 86_400_000n) {
      throw new BinanceBetaError('QUERY_FORBIDDEN', 'archive window forbidden');
    }
  }
  if (ARCHIVE_POLL_ENDPOINTS.has(endpoint)
    && (entries.length !== 1 || !Object.hasOwn(query, 'downloadId'))) {
    throw new BinanceBetaError('QUERY_FORBIDDEN', 'archive download id required');
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

export function createBinanceClient(deps = {}) {
  if (typeof deps.fetch !== 'function') throw new TypeError('Binance fetch dependency required');
  const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();
  let timeOffsetMs = 0;

  async function perform(endpoint, query, credentials, timestampRetryUsed) {
    const definition = BINANCE_ENDPOINTS[endpoint];
    if (!definition) throw new BinanceBetaError('ENDPOINT_FORBIDDEN', 'Binance endpoint forbidden');
    const [host, path] = definition;
    const parameters = new URLSearchParams();
    for (const [key, value] of queryParameters(endpoint, query)) parameters.append(key, String(value));
    const headers = { Accept: 'application/json', 'Cache-Control': 'no-store' };
    if (endpoint !== 'time') {
      assertCredentials(credentials);
      parameters.append('recvWindow', '5000');
      parameters.append('timestamp', String(Math.trunc(nowMs() + timeOffsetMs)));
      const signature = await hmacSha256(credentials.apiSecret, parameters.toString());
      parameters.append('signature', signature);
      headers['X-MBX-APIKEY'] = credentials.apiKey;
    }
    const url = new URL(`https://${host}${path}`);
    url.search = parameters.toString();
    let response;
    try {
      response = await deps.fetch(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: deps.signal,
      });
    } catch {
      throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', { retryable: true });
    }
    const value = await readBoundedJson(response);
    if (response.status === 418) {
      const seconds = retryAfter(response, 120);
      await deps.onGlobalCircuit?.(seconds);
      throw new BinanceBetaError('GLOBAL_CIRCUIT_OPEN', 'Binance circuit open', {
        retryable: true,
        retryAfterSeconds: seconds,
      });
    }
    if (response.status === 429) {
      const seconds = retryAfter(response, 60);
      throw new BinanceBetaError('RATE_LIMITED', 'Binance rate limited', {
        retryable: true,
        retryAfterSeconds: seconds,
      });
    }
    if (response.status === 451) {
      throw new BinanceBetaError('GEO_RESTRICTED', 'Binance region unavailable');
    }
    const upstreamCode = value && typeof value === 'object' && !Array.isArray(value)
      ? exactSafeInteger(value.code)
      : null;
    if (upstreamCode === -1021) {
      if (timestampRetryUsed || endpoint === 'time') {
        throw new BinanceBetaError('TIMESTAMP_INVALID', 'Binance timestamp unavailable', { retryable: true });
      }
      const clock = await perform('time', {}, null, true);
      const serverTime = clock && typeof clock === 'object' && !Array.isArray(clock)
        ? exactSafeInteger(clock.serverTime, false)
        : null;
      if (serverTime === null) {
        throw new BinanceBetaError('TIMESTAMP_INVALID', 'Binance timestamp unavailable', { retryable: true });
      }
      timeOffsetMs = serverTime - nowMs();
      return perform(endpoint, query, credentials, true);
    }
    if (response.status === 401 || response.status === 403 || [-2014, -2015, -2016].includes(upstreamCode)) {
      await deps.onAuthDisabled?.();
      throw new BinanceBetaError('AUTH_DISABLED', 'Binance authentication disabled');
    }
    if (!response.ok) {
      throw new BinanceBetaError('UPSTREAM_UNAVAILABLE', 'Binance response unavailable', {
        retryable: response.status >= 500,
      });
    }
    return value;
  }

  return Object.freeze({
    get(endpoint, query = {}, credentials = null) {
      return perform(endpoint, query, credentials, false);
    },
    async verifyReadOnly(credentials) {
      const conclusion = validateReadOnlyPermissions(
        await perform('apiRestrictions', {}, credentials, false),
      );
      const accountProof = await perform('account', {}, credentials, false);
      if (!accountProof || typeof accountProof !== 'object' || Array.isArray(accountProof)) {
        throw new BinanceBetaError('PERMISSION_AMBIGUOUS', 'USD-M read scope unavailable');
      }
      return conclusion;
    },
  });
}
