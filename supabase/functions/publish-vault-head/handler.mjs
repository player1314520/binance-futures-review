import {
  MAX_PUBLISH_BODY_BYTES,
  PUBLISH_PROTOCOL_VERSION,
  SIGNING_ALGORITHM,
  PublishProtocolError,
  bindVerifiedVaultSession,
  buildVaultSignatureManifest,
  isEd25519Signature,
  isEd25519Spki,
  isLowerHexDigest,
  isUuid,
  parsePublishRequest,
  verifyEd25519Signature,
} from './protocol.mjs';

const DEFAULT_DEADLINE_MS = 10_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,16384}$/;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

function jsonResponse(status, value, origin, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(value), { status, headers });
}

function publicError(error, origin) {
  const code = error instanceof PublishProtocolError ? error.code : 'UPSTREAM_UNAVAILABLE';
  if (code === 'ORIGIN_FORBIDDEN') return jsonResponse(403, { error: 'origin_forbidden' });
  if (code === 'METHOD_NOT_ALLOWED') return jsonResponse(405, { error: 'method_not_allowed' }, origin);
  if (code === 'PAYLOAD_TOO_LARGE') return jsonResponse(413, { error: 'payload_too_large' }, origin);
  if (code === 'INVALID_REQUEST') return jsonResponse(400, { error: 'invalid_publish_request' }, origin);
  if (code === 'UNAUTHORIZED') return jsonResponse(401, { error: 'authentication_required' }, origin);
  if (code === 'NOT_FOUND') return jsonResponse(404, { error: 'vault_candidate_not_found' }, origin);
  if (code === 'CONFLICT') return jsonResponse(409, { error: 'vault_publish_conflict' }, origin);
  if (code === 'RATE_LIMITED') {
    return jsonResponse(429, { error: 'rate_limited' }, origin, { 'Retry-After': '1' });
  }
  if (code === 'INVALID_OBJECT' || code === 'INVALID_SIGNATURE') {
    return jsonResponse(422, { error: 'vault_signature_invalid' }, origin);
  }
  return jsonResponse(503, { error: 'publish_unavailable' }, origin);
}

async function readBoundedBody(request, signal) {
  const declaredText = request.headers.get('content-length');
  if (declaredText !== null) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new PublishProtocolError('INVALID_REQUEST', 'invalid content length');
    }
    if (declared > MAX_PUBLISH_BODY_BYTES) {
      throw new PublishProtocolError('PAYLOAD_TOO_LARGE', 'publish request too large');
    }
  }
  if (!request.body) throw new PublishProtocolError('INVALID_REQUEST', 'request body required');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  const abort = async () => {
    try { await reader.cancel('request deadline exceeded'); } catch { /* no-op */ }
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new PublishProtocolError('DEADLINE_EXCEEDED', 'deadline exceeded');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PUBLISH_BODY_BYTES) {
        await reader.cancel('publish request too large');
        throw new PublishProtocolError('PAYLOAD_TOO_LARGE', 'publish request too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof PublishProtocolError) throw error;
    throw new PublishProtocolError('INVALID_REQUEST', 'invalid request body');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function bearerToken(request) {
  const value = request.headers.get('authorization') ?? '';
  const match = value.match(/^Bearer ([^\s]+)$/);
  if (!match || !TOKEN_PATTERN.test(match[1])) {
    throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  }
  return match[1];
}

function workspaceRow(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.signing_algorithm !== SIGNING_ALGORITHM
    || !isEd25519Spki(value.signing_public_key)
  ) throw new PublishProtocolError('NOT_FOUND', 'workspace unavailable');
  return value;
}

function candidateRow(value, request) {
  if (
    !value
    || typeof value !== 'object'
    || value.object_id !== request.objectId
    || !Number.isSafeInteger(value.generation)
    || value.generation !== request.expectedGeneration + 1
    || value.envelope_version !== 1
    || !isLowerHexDigest(value.ciphertext_sha256)
    || !isEd25519Signature(value.signature)
    || !(value.parent_object_id === null || isUuid(value.parent_object_id))
    || !(value.parent_ciphertext_sha256 === null || isLowerHexDigest(value.parent_ciphertext_sha256))
  ) throw new PublishProtocolError('INVALID_OBJECT', 'invalid candidate metadata');
  return value;
}

function headRow(value) {
  if (value === null) return null;
  if (
    !value
    || typeof value !== 'object'
    || !isUuid(value.object_id)
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
  ) throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'invalid head metadata');
  return value;
}

function publishedRow(value, request) {
  if (
    !value
    || typeof value !== 'object'
    || value.object_id !== request.objectId
    || value.generation !== request.expectedGeneration + 1
    || typeof value.updated_at !== 'string'
    || !Number.isFinite(Date.parse(value.updated_at))
  ) throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'invalid publish response');
  return value;
}

function publishContextRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublishProtocolError('NOT_FOUND', 'publish context unavailable');
  }
  const headValues = [value.head_object_id, value.head_generation, value.head_updated_at];
  const nullHead = headValues.every((item) => item === null);
  if (!nullHead && headValues.some((item) => item === null || item === undefined)) {
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'invalid publish context');
  }
  return Object.freeze({
    workspace: {
      signing_algorithm: value.signing_algorithm,
      signing_public_key: value.signing_public_key,
    },
    candidate: {
      object_id: value.object_id,
      generation: value.generation,
      envelope_version: value.envelope_version,
      ciphertext_sha256: value.ciphertext_sha256,
      signature: value.signature,
      parent_object_id: value.parent_object_id,
      parent_ciphertext_sha256: value.parent_ciphertext_sha256,
    },
    head: nullHead ? null : {
      object_id: value.head_object_id,
      generation: value.head_generation,
      updated_at: value.head_updated_at,
    },
    headCiphertextSha256: value.head_ciphertext_sha256,
  });
}

async function executePublish(request, deps, signal) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType !== 'application/json') {
    throw new PublishProtocolError('INVALID_REQUEST', 'application/json required');
  }
  const parsed = parsePublishRequest(await readBoundedBody(request, signal));
  const token = bearerToken(request);
  const verified = bindVerifiedVaultSession(token, await deps.verifyUser(token, { signal }));

  const context = publishContextRow(await deps.getPublishContext(
    verified.userId,
    verified.sessionId,
    parsed.workspaceId,
    parsed.objectId,
    { signal },
  ));
  const workspace = workspaceRow(context.workspace);
  const candidate = candidateRow(context.candidate, parsed);
  const head = headRow(context.head);

  if (parsed.expectedGeneration === 0) {
    if (head !== null || candidate.parent_object_id !== null || candidate.parent_ciphertext_sha256 !== null) {
      throw new PublishProtocolError('CONFLICT', 'root publish conflict');
    }
  } else {
    if (!head || head.generation !== parsed.expectedGeneration) {
      throw new PublishProtocolError('CONFLICT', 'stale publish');
    }
    if (candidate.parent_object_id !== head.object_id) {
      throw new PublishProtocolError('CONFLICT', 'parent mismatch');
    }
    const parentDigest = context.headCiphertextSha256;
    if (!isLowerHexDigest(parentDigest) || candidate.parent_ciphertext_sha256 !== parentDigest) {
      throw new PublishProtocolError('CONFLICT', 'parent digest mismatch');
    }
  }

  const manifest = buildVaultSignatureManifest({
    userId: verified.userId,
    workspaceId: parsed.workspaceId,
    objectId: candidate.object_id,
    generation: candidate.generation,
    envelopeVersion: candidate.envelope_version,
    ciphertextSha256: candidate.ciphertext_sha256,
    parentObjectId: candidate.parent_object_id,
    parentCiphertextSha256: candidate.parent_ciphertext_sha256,
  });
  const validSignature = await verifyEd25519Signature(
    workspace.signing_public_key,
    candidate.signature,
    manifest,
  );
  if (!validSignature) throw new PublishProtocolError('INVALID_SIGNATURE', 'signature verification failed');
  if (signal.aborted) throw new PublishProtocolError('DEADLINE_EXCEEDED', 'deadline exceeded');

  const published = publishedRow(await deps.publishHead(
    verified.userId,
    verified.sessionId,
    parsed.workspaceId,
    parsed.expectedGeneration,
    parsed.objectId,
    { signal },
  ), parsed);
  return {
    protocolVersion: PUBLISH_PROTOCOL_VERSION,
    workspaceId: parsed.workspaceId,
    objectId: published.object_id,
    generation: published.generation,
    updatedAt: published.updated_at,
  };
}

export function createPublishVaultHeadHandler(deps) {
  if (!deps || typeof deps.allowedOrigin !== 'string') throw new TypeError('publish dependencies required');
  const deadlineMs = Number.isSafeInteger(deps.deadlineMs) && deps.deadlineMs > 0
    ? deps.deadlineMs
    : DEFAULT_DEADLINE_MS;
  return async function publishVaultHeadHandler(request) {
    const requestOrigin = request.headers.get('origin') ?? '';
    if (requestOrigin !== deps.allowedOrigin) {
      return publicError(new PublishProtocolError('ORIGIN_FORBIDDEN', 'origin forbidden'));
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(deps.allowedOrigin) });
    }
    if (request.method !== 'POST') {
      return publicError(new PublishProtocolError('METHOD_NOT_ALLOWED', 'method not allowed'), deps.allowedOrigin);
    }

    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort('request deadline exceeded');
      rejectDeadline(new PublishProtocolError('DEADLINE_EXCEEDED', 'deadline exceeded'));
    }, deadlineMs);
    try {
      const value = await Promise.race([executePublish(request, deps, controller.signal), deadline]);
      return jsonResponse(200, value, deps.allowedOrigin);
    } catch (error) {
      return publicError(error, deps.allowedOrigin);
    } finally {
      clearTimeout(timer);
      controller.abort('request complete');
    }
  };
}
