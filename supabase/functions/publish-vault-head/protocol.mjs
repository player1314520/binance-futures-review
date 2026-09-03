export const PUBLISH_PROTOCOL_VERSION = 'rv-vault-publish/1';
export const SIGNING_ALGORITHM = 'ed25519-v1';
export const MAX_PUBLISH_BODY_BYTES = 1024;
export const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SPKI_PATTERN = /^[A-Za-z0-9_-]{59}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

export class PublishProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PublishProtocolError';
    this.code = code;
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function invalidRequest() {
  throw new PublishProtocolError('INVALID_REQUEST', 'invalid publish request');
}

function decodeClaims(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 16384 || /\s/.test(token)) {
    throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[1].length / 4) * 4,
      '=',
    );
    const claims = JSON.parse(atob(base64));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('invalid claims');
    return claims;
  } catch {
    throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  }
}

export function bindVerifiedVaultSession(bearerToken, verifiedUser) {
  if (!verifiedUser || typeof verifiedUser !== 'object' || Array.isArray(verifiedUser)) {
    throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  }
  const claims = decodeClaims(bearerToken);
  const authenticatedAudience = claims.aud === 'authenticated'
    || (Array.isArray(claims.aud) && claims.aud.includes('authenticated'));
  if (
    !isUuid(verifiedUser.id)
    || verifiedUser.is_anonymous === true
    || claims.sub !== verifiedUser.id
    || claims.role !== 'authenticated'
    || !authenticatedAudience
    || claims.is_anonymous !== false
    || !isUuid(claims.session_id)
  ) throw new PublishProtocolError('UNAUTHORIZED', 'authentication required');
  return Object.freeze({ userId: verifiedUser.id, sessionId: claims.session_id });
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isLowerHexDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

export function isEd25519Spki(value) {
  return typeof value === 'string' && SPKI_PATTERN.test(value);
}

export function isEd25519Signature(value) {
  return typeof value === 'string' && SIGNATURE_PATTERN.test(value);
}

export function parsePublishRequest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalidRequest();
  }
  if (!exactKeys(value, ['protocolVersion', 'workspaceId', 'objectId', 'expectedGeneration'])) {
    invalidRequest();
  }
  if (
    value.protocolVersion !== PUBLISH_PROTOCOL_VERSION
    || !isUuid(value.workspaceId)
    || !isUuid(value.objectId)
    || !Number.isSafeInteger(value.expectedGeneration)
    || value.expectedGeneration < 0
    || value.expectedGeneration >= MAX_SAFE_GENERATION
  ) invalidRequest();
  return Object.freeze({
    protocolVersion: PUBLISH_PROTOCOL_VERSION,
    workspaceId: value.workspaceId,
    objectId: value.objectId,
    expectedGeneration: value.expectedGeneration,
  });
}

function requiredManifestFields(value) {
  if (
    !value
    || !isUuid(value.userId)
    || !isUuid(value.workspaceId)
    || !isUuid(value.objectId)
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || value.generation > MAX_SAFE_GENERATION
    || value.envelopeVersion !== 1
    || !isLowerHexDigest(value.ciphertextSha256)
  ) throw new PublishProtocolError('INVALID_OBJECT', 'invalid vault object metadata');

  const hasParent = value.parentObjectId !== null || value.parentCiphertextSha256 !== null;
  if (value.generation === 1) {
    if (hasParent) throw new PublishProtocolError('INVALID_OBJECT', 'invalid root parent');
  } else if (!isUuid(value.parentObjectId) || !isLowerHexDigest(value.parentCiphertextSha256)) {
    throw new PublishProtocolError('INVALID_OBJECT', 'invalid parent metadata');
  }
}

export function buildVaultSignatureManifest(value) {
  requiredManifestFields(value);
  return [
    'rv-vault-object-signature/1',
    value.userId,
    value.workspaceId,
    value.objectId,
    String(value.generation),
    String(value.envelopeVersion),
    value.ciphertextSha256,
    value.parentObjectId ?? '-',
    value.parentCiphertextSha256 ?? '-',
  ].join('\n');
}

export function decodeBase64Url(value, expectedBytes) {
  if (typeof value !== 'string' || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PublishProtocolError('INVALID_OBJECT', 'invalid base64url encoding');
  }
  try {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = `${standard}${'='.repeat((4 - (standard.length % 4)) % 4)}`;
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    if (bytes.byteLength !== expectedBytes || canonical !== value) {
      throw new Error('non-canonical base64url');
    }
    return bytes;
  } catch {
    throw new PublishProtocolError('INVALID_OBJECT', 'invalid base64url encoding');
  }
}

export async function verifyEd25519Signature(spki, signature, manifest) {
  if (!isEd25519Spki(spki) || !isEd25519Signature(signature) || typeof manifest !== 'string') return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      decodeBase64Url(spki, 44),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      decodeBase64Url(signature, 64),
      new TextEncoder().encode(manifest),
    );
  } catch {
    return false;
  }
}
