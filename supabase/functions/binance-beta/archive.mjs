export const ARCHIVE_PROTOCOL = 'rv-binance-archive/1';

const DAY_MS = 86_400_000n;
const MAX_WINDOW_MS = 365n * DAY_MS;
const MAX_LINK_TTL_MS = 7n * DAY_MS;
const MAX_POLL_COUNT = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOWNLOAD_ID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const ARCHIVE_DATASETS = Object.freeze({
  fills: Object.freeze({
    requestEndpoint: 'tradeHistoryRequest', pollEndpoint: 'tradeHistoryPoll', monthlyQuota: 5,
  }),
  orders: Object.freeze({
    requestEndpoint: 'orderHistoryRequest', pollEndpoint: 'orderHistoryPoll', monthlyQuota: 10,
  }),
  income: Object.freeze({
    requestEndpoint: 'incomeHistoryRequest', pollEndpoint: 'incomeHistoryPoll', monthlyQuota: 5,
  }),
});
const FALLBACK_REASONS = new Set([
  'QUOTA_EXHAUSTED', 'COVERAGE_UNAVAILABLE', 'POLL_EXHAUSTED', 'LINK_EXPIRED',
]);

export class BinanceArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BinanceArchiveError';
    this.code = code;
  }
}

function fail(code, message = 'archive operation rejected') {
  throw new BinanceArchiveError(code, `${code}:${message}`);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, required = []) {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function exactUnsigned(value, field) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : '')
    : value;
  if (typeof text !== 'string' || !/^\d{1,128}$/u.test(text)) fail('ARCHIVE_TIME_INVALID', field);
  return BigInt(text).toString();
}

function archiveDefinition(dataset) {
  if (typeof dataset !== 'string' || !Object.hasOwn(ARCHIVE_DATASETS, dataset)) {
    fail('ARCHIVE_DATASET_FORBIDDEN', 'archive dataset forbidden');
  }
  return ARCHIVE_DATASETS[dataset];
}

function freezeState(value) {
  return Object.freeze({ ...value });
}

function validateState(value) {
  if (!record(value) || value.protocol !== ARCHIVE_PROTOCOL) fail('ARCHIVE_STATE_INVALID');
  const definition = archiveDefinition(value.dataset);
  const startTime = exactUnsigned(value.startTime, 'startTime');
  const endTime = exactUnsigned(value.endTime, 'endTime');
  if (BigInt(startTime) > BigInt(endTime) || BigInt(endTime) - BigInt(startTime) > MAX_WINDOW_MS) {
    fail('ARCHIVE_WINDOW_INVALID', 'archive window invalid');
  }
  if (value.requestEndpoint !== definition.requestEndpoint || value.pollEndpoint !== definition.pollEndpoint) {
    fail('ARCHIVE_STATE_INVALID');
  }
  if (value.monthlyQuota !== definition.monthlyQuota) fail('ARCHIVE_STATE_INVALID');
  if (!['REQUEST_PENDING', 'POLL_PENDING', 'STAGED', 'CSV_REQUIRED'].includes(value.status)) {
    fail('ARCHIVE_STATE_INVALID');
  }
  if (!Number.isSafeInteger(value.pollCount) || value.pollCount < 0 || value.pollCount > MAX_POLL_COUNT) {
    fail('ARCHIVE_STATE_INVALID');
  }
  const commonKeys = [
    'protocol', 'dataset', 'startTime', 'endTime', 'requestEndpoint', 'pollEndpoint',
    'monthlyQuota', 'status', 'pollCount',
  ];
  const statusKeys = {
    REQUEST_PENDING: commonKeys,
    POLL_PENDING: [...commonKeys, 'downloadId'],
    STAGED: [...commonKeys, 'archiveId'],
    CSV_REQUIRED: [...commonKeys, 'fallbackReason'],
  }[value.status];
  if (Object.keys(value).sort().join(',') !== statusKeys.sort().join(',')) fail('ARCHIVE_STATE_INVALID');
  if (value.status === 'POLL_PENDING' && !DOWNLOAD_ID_PATTERN.test(value.downloadId ?? '')) {
    fail('ARCHIVE_DOWNLOAD_ID_INVALID');
  }
  if (value.status === 'STAGED' && !UUID_PATTERN.test(value.archiveId ?? '')) fail('ARCHIVE_STATE_INVALID');
  if (value.status === 'CSV_REQUIRED' && !FALLBACK_REASONS.has(value.fallbackReason)) fail('ARCHIVE_STATE_INVALID');
  return value;
}

function safeDownloadUrl(raw) {
  if (typeof raw !== 'string' || raw.length < 16 || raw.length > 4096) fail('ARCHIVE_LINK_INVALID');
  let url;
  try { url = new URL(raw); } catch { fail('ARCHIVE_LINK_INVALID'); }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || host === 'localhost'
    || host.endsWith('.localhost')
    || /^127\./u.test(host)
    || /^10\./u.test(host)
    || /^192\.168\./u.test(host)
    || /^169\.254\./u.test(host)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
    || host === '::1'
  ) fail('ARCHIVE_LINK_INVALID');
  return raw;
}

function nextPollState(state, downloadId, pollCount) {
  return freezeState({
    ...state,
    status: 'POLL_PENDING',
    downloadId,
    pollCount,
  });
}

export function createArchiveState(input) {
  if (!record(input)) fail('ARCHIVE_REQUEST_INVALID');
  const definition = archiveDefinition(input.dataset);
  const startTime = exactUnsigned(input.startTime, 'startTime');
  const endTime = exactUnsigned(input.endTime, 'endTime');
  if (BigInt(startTime) > BigInt(endTime) || BigInt(endTime) - BigInt(startTime) > MAX_WINDOW_MS) {
    fail('ARCHIVE_WINDOW_INVALID', 'archive window invalid');
  }
  return freezeState({
    protocol: ARCHIVE_PROTOCOL,
    dataset: input.dataset,
    startTime,
    endTime,
    requestEndpoint: definition.requestEndpoint,
    pollEndpoint: definition.pollEndpoint,
    monthlyQuota: definition.monthlyQuota,
    status: 'REQUEST_PENDING',
    pollCount: 0,
  });
}

export function fallbackArchiveToCsv(rawState, reason) {
  const state = validateState(rawState);
  if (!FALLBACK_REASONS.has(reason)) fail('ARCHIVE_FALLBACK_INVALID');
  const { downloadId: _privateDownloadId, ...safeState } = state;
  return freezeState({
    ...safeState,
    status: 'CSV_REQUIRED',
    fallbackReason: reason,
  });
}

export function archiveReceipt(rawState) {
  const state = validateState(rawState);
  const nextAction = {
    REQUEST_PENDING: 'REQUEST_ARCHIVE',
    POLL_PENDING: 'POLL_ARCHIVE',
    STAGED: 'PRIVATE_ACTIONS_INGEST',
    CSV_REQUIRED: 'UPLOAD_CSV_EVIDENCE',
  }[state.status];
  return Object.freeze({
    protocol: ARCHIVE_PROTOCOL,
    dataset: state.dataset,
    windowStart: state.startTime,
    windowEnd: state.endTime,
    status: state.status,
    nextAction,
    archiveId: state.status === 'STAGED' ? state.archiveId : null,
    fallbackReason: state.status === 'CSV_REQUIRED' ? state.fallbackReason : null,
  });
}

export async function runArchiveStep(rawState, deps, credentials) {
  const state = validateState(rawState);
  if (!deps || typeof deps !== 'object' || typeof deps.client?.get !== 'function') {
    fail('ARCHIVE_CLIENT_REQUIRED');
  }
  if (typeof deps.stagePrivateLink !== 'function') fail('ARCHIVE_PRIVATE_STAGER_REQUIRED');
  const nowValue = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
  const now = BigInt(exactUnsigned(nowValue, 'nowMs'));
  if (state.status === 'STAGED' || state.status === 'CSV_REQUIRED') return state;

  try {
    if (state.status === 'REQUEST_PENDING') {
      const response = await deps.client.get(state.requestEndpoint, {
        startTime: state.startTime,
        endTime: state.endTime,
      }, credentials);
      if (!exactKeys(response, ['avgCostTimestampOfLast30d', 'downloadId'], ['downloadId'])) {
        fail('ARCHIVE_RESPONSE_INVALID');
      }
      if (!DOWNLOAD_ID_PATTERN.test(response.downloadId ?? '')) fail('ARCHIVE_DOWNLOAD_ID_INVALID');
      if (Object.hasOwn(response, 'avgCostTimestampOfLast30d')) {
        exactUnsigned(response.avgCostTimestampOfLast30d, 'avgCostTimestampOfLast30d');
      }
      return nextPollState(state, response.downloadId, 0);
    }

    if (state.pollCount >= MAX_POLL_COUNT) return fallbackArchiveToCsv(state, 'POLL_EXHAUSTED');
    const response = await deps.client.get(state.pollEndpoint, { downloadId: state.downloadId }, credentials);
    if (!exactKeys(
      response,
      ['downloadId', 'status', 'url', 'notified', 'expirationTimestamp', 'isExpired'],
      ['downloadId', 'status'],
    )) fail('ARCHIVE_RESPONSE_INVALID');
    if (response.downloadId !== state.downloadId) fail('ARCHIVE_DOWNLOAD_ID_MISMATCH');
    if (response.status === 'processing') return nextPollState(state, state.downloadId, state.pollCount + 1);
    if (response.status !== 'completed') fail('ARCHIVE_STATUS_INVALID');
    if (response.isExpired !== undefined && response.isExpired !== 'false') {
      return fallbackArchiveToCsv(state, 'LINK_EXPIRED');
    }
    const expiresAtMs = BigInt(exactUnsigned(response.expirationTimestamp, 'expirationTimestamp'));
    if (expiresAtMs <= now) return fallbackArchiveToCsv(state, 'LINK_EXPIRED');
    if (expiresAtMs - now > MAX_LINK_TTL_MS) fail('ARCHIVE_EXPIRY_INVALID');
    const downloadUrl = safeDownloadUrl(response.url);
    const staged = await deps.stagePrivateLink({
      dataset: state.dataset,
      windowStart: state.startTime,
      windowEnd: state.endTime,
      downloadId: state.downloadId,
      downloadUrl,
      expiresAt: new Date(Number(expiresAtMs)).toISOString(),
    });
    if (!exactKeys(staged, ['archiveId', 'status'], ['archiveId', 'status'])
      || !UUID_PATTERN.test(staged.archiveId ?? '') || staged.status !== 'STAGED') {
      fail('ARCHIVE_PRIVATE_STAGE_INVALID');
    }
    const { downloadId: _privateDownloadId, ...safeState } = state;
    return freezeState({
      ...safeState,
      status: 'STAGED',
      archiveId: staged.archiveId.toLowerCase(),
      pollCount: state.pollCount + 1,
    });
  } catch (error) {
    if (error?.code === 'ARCHIVE_QUOTA_EXHAUSTED') return fallbackArchiveToCsv(state, 'QUOTA_EXHAUSTED');
    if (error?.code === 'ARCHIVE_COVERAGE_UNAVAILABLE') return fallbackArchiveToCsv(state, 'COVERAGE_UNAVAILABLE');
    throw error;
  }
}
