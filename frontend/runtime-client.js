// Browser-only client for the loopback runtime security boundary.
// The runtime origin is deliberately not configurable: a page loaded from any
// other origin must not be able to turn this module into a localhost proxy.

import { normalizeBundleQualityV2 } from './data-quality-v2.js';
import {
  normalizeBinanceAcceptanceRequestV1,
  normalizeBinanceAcceptanceV1,
  normalizeBundleResponseV1,
  normalizeLoopbackErrorV1,
  normalizeProfileConfirmationRequestV1,
  normalizeProfileConfirmationV1,
  normalizeProfileEvaluationRequestV1,
  normalizeProfileEvaluationV1,
  normalizeRuntimeStatusV1,
  normalizeSyncRecentV1,
} from './loopback-api.js';

export const CANONICAL_RUNTIME_ORIGIN = 'http://127.0.0.1:8790';

const DEFAULT_TIMEOUT_MS = 10_000;
const PROTECTED_PATH_PREFIXES = Object.freeze(['/local/', '/fapi/']);
const SAFE_RETRY_METHODS = Object.freeze(new Set(['GET', 'HEAD']));
const CSRF_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const BINANCE_CONNECTION_STATES = Object.freeze(new Set([
  'unconfigured',
  'verifying',
  'connected',
  'auth_error',
  'geo_blocked',
  'unavailable',
  'store_error',
]));
const BUNDLE_DATA_STATUSES = Object.freeze(new Set([
  'CURRENT',
  'CACHED_ONLY',
  'LEGACY_UNBOUND',
]));
const ERROR_MESSAGES = Object.freeze({
  RUNTIME_UNAVAILABLE: 'Local runtime is unavailable from this origin.',
  INVALID_PATH: 'The local runtime path is not allowed.',
  INVALID_REQUEST: 'The local runtime request is invalid.',
  TIMEOUT: 'The local runtime request timed out.',
  NETWORK_ERROR: 'The local runtime request failed.',
  INVALID_JSON: 'The local runtime returned invalid JSON.',
  SESSION_INVALID: 'The local runtime session response is invalid.',
  HTTP_ERROR: 'The local runtime rejected the request.',
});

export class RuntimeClientError extends Error {
  constructor(code, options = {}) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.NETWORK_ERROR);
    this.name = 'RuntimeClientError';
    this.code = code;
    if (Number.isInteger(options.status)) this.status = options.status;
    if (typeof options.serviceCode === 'string') this.serviceCode = options.serviceCode;
    if (typeof options.classification === 'string') this.classification = options.classification;
    if (typeof options.retryable === 'boolean') this.retryable = options.retryable;
  }
}

function fail(code, options) {
  return new RuntimeClientError(code, options);
}

export function normalizeBinanceConnection(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const configured =
    Object.hasOwn(raw, 'configured')
    && raw.configured === true;
  const candidateState =
    Object.hasOwn(raw, 'state')
    && typeof raw.state === 'string'
    ? raw.state
    : (configured ? 'unavailable' : 'unconfigured');
  const state = BINANCE_CONNECTION_STATES.has(candidateState)
    ? candidateState
    : (configured ? 'unavailable' : 'unconfigured');
  const connected =
    configured
    && state === 'connected'
    && Object.hasOwn(raw, 'connected')
    && raw.connected === true;
  const normalizedState = !configured
    ? 'unconfigured'
    : connected
      ? 'connected'
      : state === 'connected' ? 'unavailable' : state;
  return Object.freeze({
    configured,
    connected,
    state: normalizedState,
    canSync:
      connected
      && Object.hasOwn(raw, 'canSync')
      && raw.canSync === true,
  });
}

export function classifyCredentialHttpError(error) {
  switch (error && error.status) {
    case 401: return 'auth_error';
    case 451: return 'geo_blocked';
    case 503: return 'unavailable';
    case 409: return 'busy';
    default: return 'request_failed';
  }
}

export function normalizeBundleDataStatus(bundle) {
  const meta = bundle
    && typeof bundle === 'object'
    && !Array.isArray(bundle)
    && Object.hasOwn(bundle, '_meta')
    && bundle._meta
    && typeof bundle._meta === 'object'
    && !Array.isArray(bundle._meta)
    ? bundle._meta
    : null;
  const value = meta
    && Object.hasOwn(meta, 'dataStatus')
    && typeof meta.dataStatus === 'string'
    ? meta.dataStatus
    : '';
  return BUNDLE_DATA_STATUSES.has(value) ? value : 'LEGACY_UNBOUND';
}

export function normalizeBundleQuality(bundle, options = {}) {
  return normalizeBundleQualityV2(bundle, options);
}

export function resolveBundleConsumerAccess(bundle, options = {}) {
  const quality = normalizeBundleQuality(bundle, options);
  const capabilityDecision = (name) => quality.capabilities[name].decision;
  const available = (name) => capabilityDecision(name) !== 'DENY';
  const strong = (name) => (
    quality.status === 'VALID'
    && capabilityDecision(name) === 'ALLOW'
  );
  const accountKpis = strong('accountKpis');
  const currentPositions = strong('currentPositions');
  const equityAnalytics = strong('equityAnalytics');
  const policy = Object.freeze({
    recordsBrowsable: available('recordsBrowsable'),
    observedTradeAnalytics: available('observedTradeAnalytics'),
    accountKpis,
    currentPositions,
    equityAnalytics,
    ledger: strong('ledger'),
    ai: accountKpis,
    accountReport: accountKpis,
    completeAccountExport: accountKpis,
    liveWallet: equityAnalytics,
    livePositions: currentPositions,
  });
  return Object.freeze({ quality, policy });
}

function responseOkay(response) {
  return Boolean(
    response
      && (
        response.ok === true
        || (
          Number.isInteger(response.status)
          && response.status >= 200
          && response.status < 300
        )
      ),
  );
}

function protectedUrl(pathname) {
  if (
    typeof pathname !== 'string'
    || !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
  ) {
    throw fail('INVALID_PATH');
  }

  let url;
  try {
    url = new URL(pathname, CANONICAL_RUNTIME_ORIGIN);
  } catch (_error) {
    throw fail('INVALID_PATH');
  }
  const protectedPath = PROTECTED_PATH_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix));
  if (
    url.origin !== CANONICAL_RUNTIME_ORIGIN
    || !protectedPath
    || url.pathname === '/local/session'
  ) {
    throw fail('INVALID_PATH');
  }
  return url.href;
}

function normalizeMethod(value) {
  const method = String(value || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw fail('INVALID_REQUEST');
  return method;
}

function requestHeaders(input) {
  let headers;
  try {
    headers = new Headers(input || {});
  } catch (_error) {
    throw fail('INVALID_REQUEST');
  }
  // Browser-managed request identity must never be supplied through this API.
  for (const name of [
    'cookie',
    'host',
    'origin',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'x-rv-csrf',
  ]) {
    headers.delete(name);
  }
  headers.set('Accept', 'application/json');
  return headers;
}

async function parseJson(response, method) {
  if (
    response.status === 204
    || response.status === 205
    || method === 'HEAD'
  ) {
    return null;
  }
  if (typeof response.text !== 'function') throw fail('INVALID_JSON');

  let text;
  try {
    text = await response.text();
  } catch (_error) {
    throw fail('INVALID_JSON');
  }
  if (!text) throw fail('INVALID_JSON');
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw fail('INVALID_JSON');
  }
}

export function createRuntimeClient(options = {}) {
  const fetchImpl =
    options.fetchImpl
    || (
      typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null
    );
  const ambientLocation =
    typeof globalThis.location === 'object'
      ? globalThis.location
      : null;
  const locationLike = ambientLocation || options.locationLike;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') throw fail('INVALID_REQUEST');
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
  ) {
    throw fail('INVALID_REQUEST');
  }

  let enabled =
    options.enabled !== false
    && Boolean(locationLike)
    && locationLike.origin === CANONICAL_RUNTIME_ORIGIN;
  let csrfToken = null;
  let bootstrapPromise = null;
  const activeControllers = new Set();

  async function timedFetch(url, init, effectiveTimeoutMs = timeoutMs) {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      activeControllers.delete(controller);
    };
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      if (!enabled) {
        release();
        throw fail('RUNTIME_UNAVAILABLE');
      }
      return { response, controller, release };
    } catch (_error) {
      release();
      if (!enabled) throw fail('RUNTIME_UNAVAILABLE');
      if (controller.signal.aborted) throw fail('TIMEOUT');
      throw fail('NETWORK_ERROR');
    }
  }

  async function parseHandleJson(handle, method) {
    const { signal } = handle.controller;
    let rejectOnAbort;
    const aborted = new Promise((_resolve, reject) => {
      rejectOnAbort = () => reject(fail(enabled ? 'TIMEOUT' : 'RUNTIME_UNAVAILABLE'));
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      if (signal.aborted) rejectOnAbort();
      return await Promise.race([
        parseJson(handle.response, method),
        aborted,
      ]);
    } catch (error) {
      if (!enabled) throw fail('RUNTIME_UNAVAILABLE');
      if (signal.aborted) throw fail('TIMEOUT');
      throw error;
    } finally {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }

  function assertAvailable() {
    if (!enabled) throw fail('RUNTIME_UNAVAILABLE');
  }

  function disable() {
    enabled = false;
    csrfToken = null;
    bootstrapPromise = null;
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
  }

  async function ensureSession() {
    assertAvailable();
    if (csrfToken) return csrfToken;
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
      const headers = requestHeaders();
      headers.set('Content-Type', 'application/json');
      const handle = await timedFetch(
        `${CANONICAL_RUNTIME_ORIGIN}/local/session`,
        {
          method: 'POST',
          credentials: 'same-origin',
          mode: 'cors',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'same-origin',
          headers,
          body: '{}',
        },
      );
      try {
        const { response } = handle;
        if (!responseOkay(response)) {
          throw fail('HTTP_ERROR', { status: response?.status });
        }
        const payload = await parseHandleJson(handle, 'POST');
        if (
          !payload
          || typeof payload.csrfToken !== 'string'
          || !CSRF_PATTERN.test(payload.csrfToken)
        ) {
          throw fail('SESSION_INVALID');
        }
        assertAvailable();
        csrfToken = payload.csrfToken;
        return csrfToken;
      } finally {
        handle.release();
      }
    })();

    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  function prepareInit(method, optionsForRequest, token) {
    const headers = requestHeaders(optionsForRequest.headers);
    headers.set('X-RV-CSRF', token);
    const hasJson = Object.prototype.hasOwnProperty.call(
      optionsForRequest,
      'json',
    );
    if (hasJson && optionsForRequest.body !== undefined) {
      throw fail('INVALID_REQUEST');
    }
    if (
      (method === 'GET' || method === 'HEAD')
      && (hasJson || optionsForRequest.body !== undefined)
    ) {
      throw fail('INVALID_REQUEST');
    }

    let body = optionsForRequest.body;
    if (hasJson) {
      try {
        body = JSON.stringify(optionsForRequest.json);
      } catch (_error) {
        throw fail('INVALID_REQUEST');
      }
      if (body === undefined) throw fail('INVALID_REQUEST');
      headers.set('Content-Type', 'application/json');
    }

    return {
      method,
      credentials: 'same-origin',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'same-origin',
      headers,
      body,
    };
  }

  async function sendProtected(
    url,
    method,
    optionsForRequest,
    token,
    requestTimeoutMs,
  ) {
    const init = prepareInit(method, optionsForRequest, token);
    return timedFetch(url, init, requestTimeoutMs);
  }

  async function request(pathname, optionsForRequest = {}) {
    assertAvailable();
    const url = protectedUrl(pathname);
    const method = normalizeMethod(optionsForRequest.method);
    const expectedStatus = optionsForRequest.expectedStatus;
    const requestTimeoutMs = optionsForRequest.timeoutMs ?? timeoutMs;
    if (
      expectedStatus !== undefined
      && (
        !Number.isInteger(expectedStatus)
        || expectedStatus < 100
        || expectedStatus > 599
      )
    ) {
      throw fail('INVALID_REQUEST');
    }
    if (
      !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs <= 0
    ) {
      throw fail('INVALID_REQUEST');
    }
    const firstToken = await ensureSession();
    assertAvailable();
    let handle = await sendProtected(
      url,
      method,
      optionsForRequest,
      firstToken,
      requestTimeoutMs,
    );

    try {
      if (handle.response?.status === 401) {
        if (csrfToken === firstToken) csrfToken = null;
        if (SAFE_RETRY_METHODS.has(method)) {
          handle.release();
          handle = null;
          const retryToken = await ensureSession();
          handle = await sendProtected(
            url,
            method,
            optionsForRequest,
            retryToken,
            requestTimeoutMs,
          );
        }
      }

      const { response } = handle;
      if (
        !responseOkay(response)
        || (
          expectedStatus !== undefined
          && response.status !== expectedStatus
        )
      ) {
        let errorEnvelope;
        try {
          errorEnvelope = normalizeLoopbackErrorV1(
            await parseHandleJson(handle, method),
            response?.status,
          );
          // A response body may finish after disable() has revoked the client.
          // Do not let a parsed error envelope escape that authority boundary.
          assertAvailable();
        } catch (_error) {
          if (!enabled) throw fail('RUNTIME_UNAVAILABLE');
          if (handle.controller.signal.aborted) throw fail('TIMEOUT');
          errorEnvelope = normalizeLoopbackErrorV1(null, response?.status);
        }
        throw fail('HTTP_ERROR', {
          status: response?.status,
          serviceCode: errorEnvelope.code,
          classification: errorEnvelope.classification,
          retryable: errorEnvelope.retryable,
        });
      }
      const payload = await parseHandleJson(handle, method);
      // disable() can happen after headers arrive but before text()/JSON.parse()
      // completes. Fail closed before returning any response payload to callers.
      assertAvailable();
      return payload;
    } finally {
      handle?.release();
    }
  }

  async function ping() {
    assertAvailable();
    const handle = await timedFetch(`${CANONICAL_RUNTIME_ORIGIN}/ping`, {
      method: 'GET',
      credentials: 'omit',
      mode: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    try {
      const { response } = handle;
      if (!responseOkay(response)) {
        throw fail('HTTP_ERROR', { status: response?.status });
      }
      assertAvailable();
      return true;
    } finally {
      handle.release();
    }
  }

  function get(pathname, optionsForRequest = {}) {
    return request(pathname, { ...optionsForRequest, method: 'GET' });
  }

  function post(pathname, json, optionsForRequest = {}) {
    return request(pathname, {
      ...optionsForRequest,
      method: 'POST',
      json,
    });
  }

  async function status() {
    return normalizeRuntimeStatusV1(await get('/local/status'));
  }

  async function bundle() {
    return normalizeBundleResponseV1(await get('/local/bundle'));
  }

  async function evaluateBinanceProfileLink(input) {
    let body;
    try {
      body = normalizeProfileEvaluationRequestV1(input);
    } catch (_error) {
      throw fail('INVALID_REQUEST');
    }
    return normalizeProfileEvaluationV1(await request(
      '/local/credentials/binance/evaluate',
      {
        method: 'POST',
        expectedStatus: 200,
        timeoutMs: 180_000,
        json: body,
      },
    ));
  }

  async function confirmBinanceProfileLink(input) {
    let body;
    try {
      body = normalizeProfileConfirmationRequestV1(input);
    } catch (_error) {
      throw fail('INVALID_REQUEST');
    }
    return normalizeProfileConfirmationV1(await request(
      '/local/credentials/binance/confirm',
      {
        method: 'POST',
        expectedStatus: 200,
        timeoutMs: 90_000,
        json: body,
      },
    ));
  }

  async function syncRecent() {
    return normalizeSyncRecentV1(await request('/local/sync-recent', {
      method: 'POST',
      expectedStatus: 200,
      json: {},
    }));
  }

  async function startBinanceAcceptance(input) {
    let body;
    try {
      body = normalizeBinanceAcceptanceRequestV1(input);
    } catch (_error) {
      throw fail('INVALID_REQUEST');
    }
    return normalizeBinanceAcceptanceV1(await request(
      '/local/binance-acceptance-runs',
      {
        method: 'POST',
        expectedStatus: 202,
        json: body,
      },
    ));
  }

  async function getBinanceAcceptance() {
    return normalizeBinanceAcceptanceV1(await get(
      '/local/binance-acceptance-runs/current',
      { expectedStatus: 200 },
    ));
  }

  async function cancelBinanceAcceptance() {
    return request('/local/binance-acceptance-runs/current', {
      method: 'DELETE',
      expectedStatus: 204,
    });
  }

  return Object.freeze({
    get available() { return enabled; },
    disable,
    ping,
    request,
    get,
    post,
    status,
    bundle,
    evaluateBinanceProfileLink,
    confirmBinanceProfileLink,
    syncRecent,
    startBinanceAcceptance,
    getBinanceAcceptance,
    cancelBinanceAcceptance,
  });
}
