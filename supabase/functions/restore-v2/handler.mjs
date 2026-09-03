const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^\S{16,16384}$/u;
const MAX_BODY_BYTES = 7 * 1024 * 1024;
const OWNER_RECOVERY_BODY_BYTES = 1024;
const OWNER_CLAIM_BODY_BYTES = 2048;
const OWNER_RECOVERY_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const OWNER_RECOVERY_HEADERS = Object.freeze(['apikey', 'authorization', 'content-type']);

export class RestoreV2Error extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RestoreV2Error';
    this.code = code;
  }
}

function invariant(condition, code, message = code) {
  if (!condition) throw new RestoreV2Error(code, message);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return plainRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function response(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

function errorResponse(error, extraHeaders) {
  const code = String(error?.code ?? 'OPERATION_UNAVAILABLE');
  if (code === 'REQUEST_INVALID') return response(400, { error: 'invalid_request', code }, extraHeaders);
  if (code === 'AUTH_INVALID') return response(401, { error: 'authentication_required', code }, extraHeaders);
  if (code === 'ORIGIN_INVALID') return response(403, { error: 'origin_not_allowed', code });
  if (code === 'RESOURCE_NOT_FOUND') return response(404, { error: 'not_found', code }, extraHeaders);
  if (code === 'LEGACY_UNTRUSTED' || code === 'REPLAY_DETECTED'
      || code === 'IDEMPOTENCY_CONFLICT' || code === 'TARGET_PROJECT_NOT_EMPTY') {
    return response(409, { error: 'operation_conflict', code }, extraHeaders);
  }
  if (code === 'QUARANTINED' || code === 'NOT_READY') {
    return response(503, { error: 'restore_not_ready', code }, extraHeaders);
  }
  return response(503, { error: 'operation_unavailable', code: 'OPERATION_UNAVAILABLE' }, extraHeaders);
}

function ownerRecoveryCors(origin) {
  invariant(origin === OWNER_RECOVERY_ORIGIN, 'ORIGIN_INVALID');
  return Object.freeze({
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  });
}

function ownerRecoveryPreflight(request, corsHeaders) {
  invariant(request.headers.get('access-control-request-method') === 'POST', 'REQUEST_INVALID');
  const requested = (request.headers.get('access-control-request-headers') ?? '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  invariant(requested.length === new Set(requested).size
    && requested.includes('authorization') && requested.includes('content-type')
    && requested.every(value => OWNER_RECOVERY_HEADERS.includes(value)), 'REQUEST_INVALID');
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': OWNER_RECOVERY_HEADERS.join(', '),
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    },
  });
}

function pathOf(request) {
  const url = new URL(request.url);
  if (url.hash || url.pathname.includes('%')) return null;
  const functionPrefix = '/functions/v1/restore-v2';
  const routes = [
    '/internal/v2/recovery/tag',
    '/internal/v2/deletion/intents',
    '/internal/v2/deletion/journal-evidence',
    '/internal/v2/deletion/execute',
    '/internal/v2/restore/claim',
    '/internal/v2/restore/stage',
    '/internal/v2/restore/owner-invite',
    '/internal/v2/restore/owner-claim',
    '/internal/v2/restore/owner-recover',
    '/internal/v2/restore/publish',
    '/internal/v2/restore/status',
  ];
  for (const route of routes) {
    if (url.pathname === route || url.pathname === `${functionPrefix}${route}`) return route;
  }
  return null;
}

async function boundedJson(request, maxBytes) {
  invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_BODY_BYTES,
    'OPERATION_UNAVAILABLE');
  invariant(request.headers.get('content-type')?.toLowerCase() === 'application/json',
    'REQUEST_INVALID');
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    invariant(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= maxBytes,
      'REQUEST_INVALID');
  }
  invariant(request.body, 'REQUEST_INVALID');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      invariant(size <= maxBytes, 'REQUEST_INVALID');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value = JSON.parse(text);
    invariant(plainRecord(value), 'REQUEST_INVALID');
    return value;
  } catch (error) {
    if (error instanceof RestoreV2Error) throw error;
    throw new RestoreV2Error('REQUEST_INVALID');
  } finally {
    reader.releaseLock();
  }
}

function bearer(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer (\S+)$/u);
  invariant(match && TOKEN.test(match[1]), 'AUTH_INVALID');
  return match[1];
}

async function service(request, deps) {
  invariant(await deps.verifyServiceRole(bearer(request)) === true, 'AUTH_INVALID');
}

async function user(request, deps) {
  const identity = await deps.verifyUserToken(bearer(request));
  invariant(plainRecord(identity)
    && UUID.test(identity.userId ?? '')
    && identity.emailVerified === true
    && typeof identity.email === 'string', 'AUTH_INVALID');
  return Object.freeze({
    userId: identity.userId,
    email: identity.email,
    emailVerified: true,
  });
}

function restoreId(value) {
  invariant(UUID.test(value ?? ''), 'REQUEST_INVALID');
  return value;
}

function assertSafeResult(result) {
  invariant(plainRecord(result), 'OPERATION_UNAVAILABLE');
  const text = JSON.stringify(result);
  invariant(!/(?:secret|credentialEnvelope|wrappedDek|serviceRoleKey|privateKey)/iu.test(text),
    'OPERATION_UNAVAILABLE');
  return result;
}

function assertOwnerRecoveryResult(result) {
  assertSafeResult(result);
  const text = JSON.stringify(result);
  invariant(!/"(?:inviteClaim|inviteClaimHash|inviteNonce|inviteDeliveryId)"\s*:/u.test(text),
    'OPERATION_UNAVAILABLE');
  invariant(result.inviteClaimDisclosed === false, 'OPERATION_UNAVAILABLE');
  return result;
}

function membershipsArePersonalOwners(rows) {
  return rows.every(row => !plainRecord(row) || row.dataset !== 'memberships'
    || (plainRecord(row.payload)
      && row.payload.memberRole === 'OWNER'
      && row.payload.status === 'ACTIVE'));
}

export function createRestoreV2Handler(deps) {
  const required = [
    'verifyServiceRole', 'verifyUserToken', 'getVerifiedRecoveryTag',
    'createDeletionIntent', 'attestDeletionJournal', 'executeDeletion',
    'claimRestore', 'stageRestoreBatch', 'claimOwner', 'publishRestore',
    'issueOwnerInvite', 'recoverOwner', 'getRestoreStatus',
  ];
  required.forEach(name => invariant(typeof deps?.[name] === 'function',
    'OPERATION_UNAVAILABLE', `missing restore v2 dependency ${name}`));
  invariant(deps?.ownerRecoveryOrigin === OWNER_RECOVERY_ORIGIN,
    'OPERATION_UNAVAILABLE', 'owner recovery origin unavailable');

  return async function handleRestoreV2(request) {
    let corsHeaders;
    try {
      const route = pathOf(request);
      if (!route) return response(404, { error: 'not_found' });
      if (route === '/internal/v2/restore/owner-recover') {
        corsHeaders = ownerRecoveryCors(request.headers.get('origin'));
        if (request.method === 'OPTIONS') {
          return ownerRecoveryPreflight(request, corsHeaders);
        }
      } else if (request.method === 'OPTIONS') {
        return response(405, { error: 'method_not_allowed' });
      }

      if (route === '/internal/v2/restore/status') {
        invariant(request.method === 'GET', 'REQUEST_INVALID');
        await service(request, deps);
        const url = new URL(request.url);
        invariant([...url.searchParams.keys()].join(',') === 'restore_id', 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.getRestoreStatus({
          restoreId: restoreId(url.searchParams.get('restore_id')),
        })));
      }
      invariant(request.method === 'POST', 'REQUEST_INVALID');
      let verifiedUser;
      let maxBodyBytes = MAX_BODY_BYTES;
      if (route === '/internal/v2/restore/owner-claim'
          || route === '/internal/v2/restore/owner-recover') {
        verifiedUser = await user(request, deps);
        maxBodyBytes = route === '/internal/v2/restore/owner-recover'
          ? OWNER_RECOVERY_BODY_BYTES
          : OWNER_CLAIM_BODY_BYTES;
      } else {
        await service(request, deps);
      }
      const body = await boundedJson(request, maxBodyBytes);

      if (route === '/internal/v2/recovery/tag') {
        invariant(exact(body, ['subject']) && UUID.test(body.subject ?? ''), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.getVerifiedRecoveryTag(body.subject)));
      }

      if (route === '/internal/v2/restore/owner-claim') {
        invariant(exact(body, ['restoreId', 'principalLineageId', 'inviteClaim'])
          && UUID.test(body.restoreId ?? '') && UUID.test(body.principalLineageId ?? '')
          && /^[0-9a-f]{64}$/u.test(body.inviteClaim ?? ''), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.claimOwner({ ...body, user: verifiedUser })));
      }

      if (route === '/internal/v2/restore/owner-recover') {
        invariant(exact(body, ['restoreId']) && UUID.test(body.restoreId ?? ''),
          'REQUEST_INVALID');
        return response(200, assertOwnerRecoveryResult(await deps.recoverOwner({
          restoreId: body.restoreId,
          user: verifiedUser,
        })), corsHeaders);
      }

      if (route === '/internal/v2/deletion/intents') {
        invariant(exact(body, ['tenantId', 'subject', 'expectedMembershipVersion', 'operation', 'eventId'])
          && UUID.test(body.tenantId ?? '') && UUID.test(body.subject ?? '')
          && UUID.test(body.eventId ?? '') && Number.isSafeInteger(body.expectedMembershipVersion)
          && ['DELETE_BUSINESS_DATA', 'DELETE_ACCOUNT'].includes(body.operation), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.createDeletionIntent(body)));
      }
      if (route === '/internal/v2/deletion/journal-evidence') {
        invariant(exact(body, ['intentId', 'objectEvidence', 'rangeProof'])
          && UUID.test(body.intentId ?? '') && plainRecord(body.objectEvidence)
          && plainRecord(body.rangeProof), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.attestDeletionJournal(body)));
      }
      if (route === '/internal/v2/deletion/execute') {
        invariant(exact(body, ['intentId']) && UUID.test(body.intentId ?? ''), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.executeDeletion(body)));
      }
      if (route === '/internal/v2/restore/claim') {
        invariant(exact(body, ['envelope', 'journalProof']) && plainRecord(body.envelope)
          && plainRecord(body.journalProof), 'REQUEST_INVALID');
        if (body.envelope.format === 'review-workbench-beta-signed-manifest/1'
          || body.envelope.manifest?.format === 'review-workbench-beta-backup/1') {
          throw new RestoreV2Error('LEGACY_UNTRUSTED');
        }
        return response(200, assertSafeResult(await deps.claimRestore(body)));
      }
      if (route === '/internal/v2/restore/stage') {
        invariant(exact(body, [
          'restoreId', 'batchIndex', 'totalBatches', 'idempotencyKey', 'rows',
        ]) && UUID.test(body.restoreId ?? '') && UUID.test(body.idempotencyKey ?? '')
          && Number.isSafeInteger(body.batchIndex) && body.batchIndex >= 0
          && Number.isSafeInteger(body.totalBatches) && body.totalBatches > 0
          && body.batchIndex < body.totalBatches && Array.isArray(body.rows)
          && body.rows.length <= 250
          && membershipsArePersonalOwners(body.rows), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.stageRestoreBatch(body)));
      }
      if (route === '/internal/v2/restore/owner-invite') {
        invariant(exact(body, ['restoreId', 'principalLineageId', 'deliveryId'])
          && UUID.test(body.restoreId ?? '')
          && UUID.test(body.principalLineageId ?? '')
          && UUID.test(body.deliveryId ?? ''), 'REQUEST_INVALID');
        return response(200, assertSafeResult(await deps.issueOwnerInvite(body)));
      }
      if (route === '/internal/v2/restore/publish') {
        invariant(exact(body, ['restoreId', 'journalProof'])
          && UUID.test(body.restoreId ?? '') && plainRecord(body.journalProof),
        'REQUEST_INVALID');
        const result = assertSafeResult(await deps.publishRestore(body));
        invariant(result.state !== 'PUBLISHED'
          || (result.published === true && result.credentialsRestored === 0),
        'QUARANTINED');
        return response(result.state === 'PUBLISHED' ? 200 : 503, result);
      }
      throw new RestoreV2Error('REQUEST_INVALID');
    } catch (error) {
      return errorResponse(error, corsHeaders);
    }
  };
}
