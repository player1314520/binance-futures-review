import {
  ACCOUNT_DELETION_EDGE_DEADLINE_MS,
  ACCOUNT_DELETION_TTL_SECONDS,
  DELETION_PROTOCOL_VERSION,
  DeletionProtocolError,
  authorizeAccountDeletion,
  parseDeletionRequest,
} from './protocol.mjs';

const MAX_REQUEST_BYTES = 1024;
const DEFAULT_TOTAL_DEADLINE_MS = ACCOUNT_DELETION_EDGE_DEADLINE_MS;

function corsHeaders(origin, allowedOrigin) {
  if (!origin || origin !== allowedOrigin) return {};
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function jsonResponse(status, value, origin, allowedOrigin, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin, allowedOrigin),
      ...extraHeaders,
    },
  });
}

function bearerFrom(request) {
  const value = request.headers.get('Authorization') ?? '';
  const match = value.match(/^Bearer ([^\s]{32,8192})$/);
  if (!match) throw new DeletionProtocolError('AUTH_INVALID', 'invalid authentication proof');
  return match[1];
}

function deadlineError() {
  return new DeletionProtocolError('DEADLINE_EXCEEDED', 'deletion deadline exceeded');
}

async function readWithDeadline(reader, signal) {
  if (signal.aborted) throw deadlineError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(deadlineError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedText(request, maxBytes, signal) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DeletionProtocolError('REQUEST_TOO_LARGE', 'request too large');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await readWithDeadline(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('request too large');
        throw new DeletionProtocolError('REQUEST_TOO_LARGE', 'request too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof DeletionProtocolError && error.code === 'DEADLINE_EXCEEDED') {
      void reader.cancel('request deadline exceeded').catch(() => {});
    }
    if (error instanceof DeletionProtocolError) throw error;
    throw new DeletionProtocolError('REQUEST_INVALID', 'invalid deletion request');
  } finally {
    reader.releaseLock();
  }
}

function operationResponse(action, row, origin, allowedOrigin) {
  return jsonResponse(200, {
    protocolVersion: DELETION_PROTOCOL_VERSION,
    action,
    state: 'completed',
    receiptId: row.receiptId,
    expiresAt: row.expiresAt,
  }, origin, allowedOrigin);
}

function statusResponse(row, origin, allowedOrigin) {
  if (row.status === 'completed') {
    return jsonResponse(200, {
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'deletion_status',
      operation: row.operation,
      state: 'completed',
      receiptId: row.receiptId,
      expiresAt: row.expiresAt,
    }, origin, allowedOrigin);
  }
  return jsonResponse(200, {
    protocolVersion: DELETION_PROTOCOL_VERSION,
    action: 'deletion_status',
    operation: row.operation,
    state: row.status,
    expiresAt: row.expiresAt,
  }, origin, allowedOrigin);
}

function assertDependencies(deps) {
  const names = [
    'nowSeconds',
    'randomUUID',
    'verifyUser',
    'fingerprint',
    'beginDestructiveOperation',
    'executeWorkspaceDeletion',
    'executeJournaledDeletion',
    'executeBusinessDeletion',
    'markAccountDeleting',
    'markOperationCompleted',
    'getDestructiveOperationStatus',
    'deleteAuthUser',
    'authUserExists',
  ];
  if (typeof deps?.allowedOrigin !== 'string' || !deps.allowedOrigin) throw new Error('invalid allowed origin');
  for (const name of names) if (typeof deps[name] !== 'function') throw new Error(`missing dependency: ${name}`);
  const totalDeadlineMs = deps.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  if (!Number.isInteger(totalDeadlineMs) || totalDeadlineMs < 10 || totalDeadlineMs > 30_000) {
    throw new Error('invalid total deadline');
  }
}

function publicError(error) {
  if (!(error instanceof DeletionProtocolError)) return [503, 'deletion_unavailable'];
  if (error.code === 'AUTH_INVALID') return [401, 'authentication_required'];
  if (error.code === 'REAUTH_REQUIRED') return [403, 'recent_reauthentication_required'];
  if (error.code === 'REQUEST_TOO_LARGE') return [413, 'invalid_request'];
  if (error.code === 'REQUEST_INVALID') return [400, 'invalid_request'];
  if (error.code === 'IDEMPOTENCY_CONFLICT') return [409, 'idempotency_conflict'];
  if (error.code === 'DELETION_REQUEST_NOT_FOUND') return [404, 'deletion_request_not_found'];
  if (error.code === 'DELETION_REQUEST_EXPIRED') return [410, 'deletion_request_expired'];
  if (error.code === 'RATE_LIMITED') return [429, 'rate_limited'];
  return [503, 'deletion_unavailable'];
}

function scopeValue(operation, workspaceId) {
  return `${operation}:${operation === 'delete_workspace' ? workspaceId : '-'}`;
}

function rowKey(parsed, capabilityFingerprint, subjectFingerprint, scopeFingerprint) {
  const operation = parsed.action === 'deletion_status' ? parsed.operation : parsed.action;
  return Object.freeze({
    requestId: parsed.requestId,
    capabilityFingerprint,
    subjectFingerprint,
    scopeFingerprint,
    operation,
  });
}

export function createDeletionHandler(deps) {
  assertDependencies(deps);
  const allowedOrigin = deps.allowedOrigin;
  const totalDeadlineMs = deps.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;

  return async function handleDeletion(request) {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== allowedOrigin) {
      return jsonResponse(403, { error: 'forbidden' }, origin, allowedOrigin);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store', ...corsHeaders(origin, allowedOrigin) },
      });
    }
    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' }, origin, allowedOrigin);
    }
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return jsonResponse(415, { error: 'invalid_request' }, origin, allowedOrigin);
    }

    const deadline = new AbortController();
    const onRequestAbort = () => deadline.abort(request.signal.reason ?? 'request aborted');
    if (request.signal.aborted) onRequestAbort();
    else request.signal.addEventListener('abort', onRequestAbort, { once: true });
    const timer = setTimeout(() => deadline.abort('total deadline'), totalDeadlineMs);
    const context = Object.freeze({ signal: deadline.signal });

    try {
      const parsed = parseDeletionRequest(
        await readBoundedText(request, MAX_REQUEST_BYTES, deadline.signal),
      );
      const currentSeconds = Number(deps.nowSeconds());
      if (!Number.isFinite(currentSeconds)) {
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'clock unavailable');
      }
      const now = Math.floor(currentSeconds);
      const currentMilliseconds = currentSeconds * 1000;
      const operation = parsed.action === 'deletion_status' ? parsed.operation : parsed.action;
      const workspaceId = operation === 'delete_workspace' ? parsed.workspaceId : undefined;

      if (parsed.action === 'deletion_status') {
        const capabilityFingerprint = await deps.fingerprint(
          'capability',
          `${parsed.requestId}:${parsed.recoverySecret}`,
          context,
        );
        const subjectFingerprint = await deps.fingerprint('subject', parsed.subjectHint, context);
        const scopeFingerprint = await deps.fingerprint(
          'scope',
          scopeValue(operation, workspaceId),
          context,
        );
        const key = rowKey(parsed, capabilityFingerprint, subjectFingerprint, scopeFingerprint);
        let row = await deps.getDestructiveOperationStatus(key, context);
        if (!row) throw new DeletionProtocolError('DELETION_REQUEST_NOT_FOUND', 'deletion request not found');
        if (Date.parse(row.expiresAt) <= currentMilliseconds) {
          throw new DeletionProtocolError('DELETION_REQUEST_EXPIRED', 'deletion request expired');
        }
        if (operation === 'delete_account' && row.status !== 'completed') {
          const exists = await deps.authUserExists(parsed.subjectHint, context);
          if (!exists) {
            // An absent Auth user is not sufficient deletion evidence. The
            // capability-bound v2 journal event must already exist and replay
            // through the same fail-closed proof path before the legacy
            // receipt can advance to completed. This also distinguishes a
            // lost Admin response from an out-of-band Auth deletion.
            await deps.executeJournaledDeletion({
              subject: parsed.subjectHint,
              eventId: row.receiptId,
              operation: 'DELETE_ACCOUNT',
            }, context);
            row = await deps.markOperationCompleted(key, context);
          }
        }
        return statusResponse(row, origin, allowedOrigin);
      }

      const token = bearerFrom(request);
      const authorization = await authorizeAccountDeletion({
        bearerToken: token,
        nowSeconds: now,
        verifyUser: (jwt) => deps.verifyUser(jwt, context),
      });
      const capabilityFingerprint = await deps.fingerprint(
        'capability',
        `${parsed.requestId}:${parsed.recoverySecret}`,
        context,
      );
      const subjectFingerprint = await deps.fingerprint('subject', authorization.userId, context);
      const scopeFingerprint = await deps.fingerprint(
        'scope',
        scopeValue(operation, workspaceId),
        context,
      );
      const expiresAt = new Date(
        (currentSeconds + ACCOUNT_DELETION_TTL_SECONDS) * 1000,
      ).toISOString();
      const key = rowKey(parsed, capabilityFingerprint, subjectFingerprint, scopeFingerprint);
      let row = await deps.beginDestructiveOperation({
        ...key,
        subject: authorization.userId,
        sessionId: authorization.sessionId,
        receiptId: deps.randomUUID(),
        expiresAt,
      }, context);
      if (Date.parse(row.expiresAt) <= currentMilliseconds) {
        throw new DeletionProtocolError('DELETION_REQUEST_EXPIRED', 'deletion request expired');
      }
      if (row.status === 'completed') {
        if (operation === 'clear_business_data' || operation === 'delete_account') {
          await deps.executeJournaledDeletion({
            subject: authorization.userId,
            eventId: row.receiptId,
            operation: operation === 'delete_account'
              ? 'DELETE_ACCOUNT'
              : 'DELETE_BUSINESS_DATA',
          }, context);
        }
        return operationResponse(operation, row, origin, allowedOrigin);
      }

      if (operation === 'delete_workspace') {
        row = await deps.executeWorkspaceDeletion({
          ...key,
          subject: authorization.userId,
          sessionId: authorization.sessionId,
          workspaceId: parsed.workspaceId,
          confirmation: parsed.confirmation,
        }, context);
        return operationResponse(operation, row, origin, allowedOrigin);
      }

      if (operation === 'clear_business_data') {
        await deps.executeJournaledDeletion({
          subject: authorization.userId,
          eventId: row.receiptId,
          operation: 'DELETE_BUSINESS_DATA',
        }, context);
        row = await deps.executeBusinessDeletion({
          ...key,
          subject: authorization.userId,
          sessionId: authorization.sessionId,
          confirmation: parsed.confirmation,
        }, context);
        return operationResponse(operation, row, origin, allowedOrigin);
      }

      await deps.executeJournaledDeletion({
        subject: authorization.userId,
        eventId: row.receiptId,
        operation: 'DELETE_ACCOUNT',
      }, context);
      row = await deps.markAccountDeleting({
        ...key,
        subject: authorization.userId,
        sessionId: authorization.sessionId,
      }, context);
      if (row.status !== 'completed') {
        const outcome = await deps.deleteAuthUser(authorization.userId, context);
        if (outcome !== 'deleted' && outcome !== 'not_found') {
          throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'account deletion outcome unavailable');
        }
        row = await deps.markOperationCompleted(key, context);
      }
      return operationResponse(operation, row, origin, allowedOrigin);
    } catch (error) {
      const [status, code] = publicError(error);
      return jsonResponse(
        status,
        { error: code },
        origin,
        allowedOrigin,
        status === 429 ? { 'Retry-After': '1' } : {},
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onRequestAbort);
    }
  };
}
