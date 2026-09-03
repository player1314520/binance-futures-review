export const DELETION_PROTOCOL_VERSION = 3;
export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE_MY_ACCOUNT';
export const DELETE_WORKSPACE_CONFIRMATION = 'DELETE_THIS_WORKSPACE';
export const CLEAR_BUSINESS_CONFIRMATION = 'DELETE_MY_REVIEW_DATA';
export const REAUTH_MAX_AGE_SECONDS = 5 * 60;
export const ACCOUNT_DELETION_TTL_SECONDS = 60 * 60;
export const ACCOUNT_DELETION_EDGE_DEADLINE_MS = 10_000;

const CLOCK_SKEW_SECONDS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_SECRET_PATTERN = /^rvr1_[A-Za-z0-9_-]{43}$/;

export class DeletionProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reject(code, message) {
  throw new DeletionProtocolError(code, message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function assertBase(value) {
  if (!plainObject(value) || value.protocolVersion !== DELETION_PROTOCOL_VERSION) {
    reject('REQUEST_INVALID', 'invalid deletion request');
  }
}

export function parseDeletionRequest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    reject('REQUEST_INVALID', 'invalid deletion request');
  }
  assertBase(value);

  if (value.action === 'delete_workspace') {
    if (
      !exactKeys(value, [
        'protocolVersion', 'action', 'confirmation', 'workspaceId',
        'requestId', 'recoverySecret',
      ])
      || value.confirmation !== DELETE_WORKSPACE_CONFIRMATION
      || typeof value.workspaceId !== 'string'
      || !UUID_PATTERN.test(value.workspaceId)
      || typeof value.requestId !== 'string'
      || !UUID_V4_PATTERN.test(value.requestId)
      || typeof value.recoverySecret !== 'string'
      || !RECOVERY_SECRET_PATTERN.test(value.recoverySecret)
    ) reject('REQUEST_INVALID', 'invalid deletion request');
    return Object.freeze({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'delete_workspace',
      confirmation: DELETE_WORKSPACE_CONFIRMATION,
      workspaceId: value.workspaceId,
      requestId: value.requestId,
      recoverySecret: value.recoverySecret,
    });
  }

  if (value.action === 'clear_business_data') {
    if (
      !exactKeys(value, [
        'protocolVersion', 'action', 'confirmation', 'requestId', 'recoverySecret',
      ])
      || value.confirmation !== CLEAR_BUSINESS_CONFIRMATION
      || typeof value.requestId !== 'string'
      || !UUID_V4_PATTERN.test(value.requestId)
      || typeof value.recoverySecret !== 'string'
      || !RECOVERY_SECRET_PATTERN.test(value.recoverySecret)
    ) reject('REQUEST_INVALID', 'invalid deletion request');
    return Object.freeze({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'clear_business_data',
      confirmation: CLEAR_BUSINESS_CONFIRMATION,
      requestId: value.requestId,
      recoverySecret: value.recoverySecret,
    });
  }

  if (value.action === 'delete_account') {
    if (
      !exactKeys(value, ['protocolVersion', 'action', 'confirmation', 'requestId', 'recoverySecret'])
      || value.confirmation !== ACCOUNT_DELETE_CONFIRMATION
      || typeof value.requestId !== 'string'
      || !UUID_V4_PATTERN.test(value.requestId)
      || typeof value.recoverySecret !== 'string'
      || !RECOVERY_SECRET_PATTERN.test(value.recoverySecret)
    ) reject('REQUEST_INVALID', 'invalid deletion request');
    return Object.freeze({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'delete_account',
      confirmation: ACCOUNT_DELETE_CONFIRMATION,
      requestId: value.requestId,
      recoverySecret: value.recoverySecret,
    });
  }

  if (value.action === 'deletion_status') {
    const operation = value.operation;
    const expectedKeys = operation === 'delete_workspace'
      ? [
          'protocolVersion', 'action', 'operation', 'requestId',
          'recoverySecret', 'subjectHint', 'workspaceId',
        ]
      : [
          'protocolVersion', 'action', 'operation', 'requestId',
          'recoverySecret', 'subjectHint',
        ];
    if (
      !['delete_workspace', 'clear_business_data', 'delete_account'].includes(operation)
      || !exactKeys(value, expectedKeys)
      || typeof value.requestId !== 'string'
      || !UUID_V4_PATTERN.test(value.requestId)
      || typeof value.recoverySecret !== 'string'
      || !RECOVERY_SECRET_PATTERN.test(value.recoverySecret)
      || typeof value.subjectHint !== 'string'
      || !UUID_PATTERN.test(value.subjectHint)
      || (operation === 'delete_workspace'
        && (typeof value.workspaceId !== 'string' || !UUID_PATTERN.test(value.workspaceId)))
    ) reject('REQUEST_INVALID', 'invalid deletion request');
    return Object.freeze({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'deletion_status',
      operation,
      requestId: value.requestId,
      recoverySecret: value.recoverySecret,
      subjectHint: value.subjectHint,
      ...(operation === 'delete_workspace' ? { workspaceId: value.workspaceId } : {}),
    });
  }

  reject('REQUEST_INVALID', 'invalid deletion request');
}

function decodeClaims(token) {
  if (
    typeof token !== 'string'
    || token.length < 32
    || token.length > 8192
    || /\s/.test(token)
  ) reject('AUTH_INVALID', 'invalid authentication proof');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) reject('AUTH_INVALID', 'invalid authentication proof');
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[1].length / 4) * 4,
      '=',
    );
    const value = JSON.parse(atob(base64));
    if (!plainObject(value)) reject('AUTH_INVALID', 'invalid authentication proof');
    return value;
  } catch (error) {
    if (error instanceof DeletionProtocolError) throw error;
    reject('AUTH_INVALID', 'invalid authentication proof');
  }
}

function recentTimestamp(value, nowSeconds) {
  return Number.isInteger(value)
    && value <= nowSeconds + CLOCK_SKEW_SECONDS
    && nowSeconds - value <= REAUTH_MAX_AGE_SECONDS;
}

/** The callback must validate the exact JWT against Supabase Auth. */
export async function authorizeAccountDeletion({ bearerToken, nowSeconds, verifyUser }) {
  if (typeof verifyUser !== 'function') reject('AUTH_INVALID', 'invalid authentication proof');
  let verifiedUser;
  try {
    verifiedUser = await verifyUser(bearerToken);
  } catch (error) {
    if (
      error instanceof DeletionProtocolError
      && ['UPSTREAM_UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(error.code)
    ) throw error;
    reject('AUTH_INVALID', 'invalid authentication proof');
  }
  if (!plainObject(verifiedUser) || typeof verifiedUser.id !== 'string' || !UUID_PATTERN.test(verifiedUser.id)) {
    reject('AUTH_INVALID', 'invalid authentication proof');
  }

  const claims = decodeClaims(bearerToken);
  const current = Number.isFinite(nowSeconds) ? Math.floor(nowSeconds) : Math.floor(Date.now() / 1000);
  const signInAt = Date.parse(String(verifiedUser.last_sign_in_at ?? '')) / 1000;
  const authenticatedAudience = claims.aud === 'authenticated'
    || (Array.isArray(claims.aud) && claims.aud.includes('authenticated'));
  const otpMethods = Array.isArray(claims.amr)
    ? claims.amr.filter((entry) => plainObject(entry) && entry.method === 'otp')
    : [];
  const hasRecentOtp = otpMethods.some((entry) => recentTimestamp(entry.timestamp, current));

  if (
    claims.sub !== verifiedUser.id
    || claims.role !== 'authenticated'
    || !authenticatedAudience
    || claims.is_anonymous !== false
    || verifiedUser.is_anonymous === true
    || typeof claims.session_id !== 'string'
    || !UUID_PATTERN.test(claims.session_id)
    || !Number.isInteger(claims.iat)
    || !recentTimestamp(claims.iat, current)
    || !Number.isInteger(claims.exp)
    || claims.exp <= current
    || !hasRecentOtp
    || !Number.isFinite(signInAt)
    || !recentTimestamp(Math.floor(signInAt), current)
  ) reject('REAUTH_REQUIRED', 'recent OTP re-verification required');

  return Object.freeze({ userId: verifiedUser.id, sessionId: claims.session_id });
}
