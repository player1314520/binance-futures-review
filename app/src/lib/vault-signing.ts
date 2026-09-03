import type { JsonValue } from './canonical-json';
import { normalizeRecoveryCode } from './recovery-code';

export const VAULT_SIGNING_ALGORITHM = 'ed25519-v1' as const;
export const SIGNED_VAULT_PAYLOAD_FORMAT = 'rv-signed-vault-payload/1' as const;
export const VAULT_OBJECT_SIGNATURE_DOMAIN = 'rv-vault-object-signature/1' as const;
export const VAULT_PUBLISH_PROTOCOL_VERSION = 'rv-vault-publish/1' as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_KEY_BYTES = 512;
const ED25519_SIGNATURE_BYTES = 64;
const encoder = new TextEncoder();

export type VaultSigningErrorCode =
  | 'SIGNING_CRYPTO_UNAVAILABLE'
  | 'SIGNING_INVALID_INPUT'
  | 'SIGNING_KEY_INVALID';

export class VaultSigningError extends Error {
  constructor(readonly code: VaultSigningErrorCode) {
    super(code);
    this.name = 'VaultSigningError';
  }
}

export type VaultObjectSignatureInput = Readonly<{
  userId: string;
  workspaceId: string;
  objectId: string;
  generation: number;
  envelopeVersion: number;
  ciphertextSha256: string;
  parentObjectId: string | null;
  parentCiphertextSha256: string | null;
}>;

export type VaultSigningKeyPair = Readonly<{
  algorithm: typeof VAULT_SIGNING_ALGORITHM;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}>;

export type SignedVaultPayload<T extends JsonValue = JsonValue> = Readonly<{
  format: typeof SIGNED_VAULT_PAYLOAD_FORMAT;
  signingPrivateKeyPkcs8: string;
  snapshot: T;
}>;

function fail(code: VaultSigningErrorCode): never {
  throw new VaultSigningError(code);
}

function getWebCrypto(supplied?: Crypto): Crypto {
  const webCrypto = supplied ?? globalThis.crypto;
  if (!webCrypto?.subtle || typeof webCrypto.getRandomValues !== 'function') {
    fail('SIGNING_CRYPTO_UNAVAILABLE');
  }
  return webCrypto;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(
  value: unknown,
  maximumBytes = MAX_KEY_BYTES,
  exactBytes?: number,
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4
    || !BASE64URL_PATTERN.test(value)
  ) fail('SIGNING_INVALID_INPUT');
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(base64);
    if (binary.length > maximumBytes || (exactBytes !== undefined && binary.length !== exactBytes)) {
      fail('SIGNING_INVALID_INPUT');
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (encodeBase64Url(bytes) !== value) fail('SIGNING_INVALID_INPUT');
    return bytes;
  } catch (error) {
    if (error instanceof VaultSigningError) throw error;
    return fail('SIGNING_INVALID_INPUT');
  }
}

export function normalizeVaultBase64Url(value: unknown, maximumBytes = MAX_KEY_BYTES): string {
  const bytes = decodeBase64Url(value, maximumBytes);
  try {
    return encodeBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function normalizeSha256Hex(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) fail('SIGNING_INVALID_INPUT');
  return value;
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('SIGNING_INVALID_INPUT');
  return value.toLowerCase();
}

function normalizedManifestInput(input: VaultObjectSignatureInput): VaultObjectSignatureInput {
  if (!input || typeof input !== 'object') fail('SIGNING_INVALID_INPUT');
  if (typeof input.userId !== 'string' || !USER_ID_PATTERN.test(input.userId)) fail('SIGNING_INVALID_INPUT');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) fail('SIGNING_INVALID_INPUT');
  if (!Number.isSafeInteger(input.envelopeVersion) || input.envelopeVersion < 1) fail('SIGNING_INVALID_INPUT');
  const noParent = input.parentObjectId === null && input.parentCiphertextSha256 === null;
  const hasParent = input.parentObjectId !== null && input.parentCiphertextSha256 !== null;
  if (!noParent && !hasParent) fail('SIGNING_INVALID_INPUT');
  return Object.freeze({
    userId: input.userId,
    workspaceId: normalizeUuid(input.workspaceId),
    objectId: normalizeUuid(input.objectId),
    generation: input.generation,
    envelopeVersion: input.envelopeVersion,
    ciphertextSha256: normalizeSha256Hex(input.ciphertextSha256),
    parentObjectId: hasParent ? normalizeUuid(input.parentObjectId) : null,
    parentCiphertextSha256: hasParent ? normalizeSha256Hex(input.parentCiphertextSha256) : null,
  });
}

export function buildVaultObjectSignatureManifest(input: VaultObjectSignatureInput): string {
  const value = normalizedManifestInput(input);
  return [
    VAULT_OBJECT_SIGNATURE_DOMAIN,
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

async function importPrivateKey(webCrypto: Crypto, value: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(value);
  try {
    return await webCrypto.subtle.importKey('pkcs8', bytes, { name: 'Ed25519' }, false, ['sign']);
  } catch (_error) {
    return fail('SIGNING_KEY_INVALID');
  } finally {
    bytes.fill(0);
  }
}

async function importPublicKey(webCrypto: Crypto, value: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(value);
  try {
    return await webCrypto.subtle.importKey('spki', bytes, { name: 'Ed25519' }, false, ['verify']);
  } catch (_error) {
    return fail('SIGNING_KEY_INVALID');
  } finally {
    bytes.fill(0);
  }
}

export async function generateVaultSigningKeyPair(
  options: Readonly<{ webCrypto?: Crypto }> = {},
): Promise<VaultSigningKeyPair> {
  const webCrypto = getWebCrypto(options.webCrypto);
  try {
    const pair = await webCrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    if (!('privateKey' in pair) || !pair.privateKey || !pair.publicKey) fail('SIGNING_CRYPTO_UNAVAILABLE');
    const [spki, pkcs8] = await Promise.all([
      webCrypto.subtle.exportKey('spki', pair.publicKey),
      webCrypto.subtle.exportKey('pkcs8', pair.privateKey),
    ]);
    return Object.freeze({
      algorithm: VAULT_SIGNING_ALGORITHM,
      publicKeySpki: encodeBase64Url(new Uint8Array(spki)),
      privateKeyPkcs8: encodeBase64Url(new Uint8Array(pkcs8)),
    });
  } catch (error) {
    if (error instanceof VaultSigningError) throw error;
    return fail('SIGNING_CRYPTO_UNAVAILABLE');
  }
}

export async function signVaultObject(
  privateKeyPkcs8: string,
  input: VaultObjectSignatureInput,
  options: Readonly<{ webCrypto?: Crypto }> = {},
): Promise<string> {
  const webCrypto = getWebCrypto(options.webCrypto);
  const key = await importPrivateKey(webCrypto, privateKeyPkcs8);
  try {
    const signature = await webCrypto.subtle.sign(
      { name: 'Ed25519' },
      key,
      encoder.encode(buildVaultObjectSignatureManifest(input)),
    );
    const bytes = new Uint8Array(signature);
    if (bytes.byteLength !== ED25519_SIGNATURE_BYTES) fail('SIGNING_CRYPTO_UNAVAILABLE');
    return encodeBase64Url(bytes);
  } catch (error) {
    if (error instanceof VaultSigningError) throw error;
    return fail('SIGNING_CRYPTO_UNAVAILABLE');
  }
}

export async function verifyVaultObjectSignature(
  publicKeySpki: string,
  input: VaultObjectSignatureInput,
  signatureBase64Url: string,
  options: Readonly<{ webCrypto?: Crypto }> = {},
): Promise<boolean> {
  const webCrypto = getWebCrypto(options.webCrypto);
  const [key, signature] = await Promise.all([
    importPublicKey(webCrypto, publicKeySpki),
    Promise.resolve(decodeBase64Url(signatureBase64Url, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES)),
  ]);
  try {
    return await webCrypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature,
      encoder.encode(buildVaultObjectSignatureManifest(input)),
    );
  } catch (_error) {
    return fail('SIGNING_CRYPTO_UNAVAILABLE');
  } finally {
    signature.fill(0);
  }
}

export async function sha256Hex(
  bytesInput: Uint8Array | ArrayBuffer,
  options: Readonly<{ webCrypto?: Crypto }> = {},
): Promise<string> {
  const webCrypto = getWebCrypto(options.webCrypto);
  const source = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  try {
    const digest = new Uint8Array(await webCrypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (_error) {
    return fail('SIGNING_CRYPTO_UNAVAILABLE');
  }
}

export async function deriveVaultWriteCapability(
  recoveryCodeInput: string,
  workspaceIdInput: string,
  options: Readonly<{ webCrypto?: Crypto }> = {},
): Promise<string> {
  const webCrypto = getWebCrypto(options.webCrypto);
  const recoveryCode = normalizeRecoveryCode(recoveryCodeInput);
  const workspaceId = normalizeUuid(workspaceIdInput);
  const ikm = encoder.encode(recoveryCode);
  const salt = encoder.encode(workspaceId);
  const info = encoder.encode('rv-vault-write-capability/1');
  try {
    const material = await webCrypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const derived = new Uint8Array(await webCrypto.subtle.deriveBits({
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    }, material, 256));
    return [...derived].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (_error) {
    return fail('SIGNING_CRYPTO_UNAVAILABLE');
  } finally {
    ikm.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && isJsonValue(item));
}

export function createSignedVaultPayload<T extends JsonValue>(
  signingPrivateKeyPkcs8: string,
  snapshot: T,
): SignedVaultPayload<T> {
  const normalizedKey = normalizeVaultBase64Url(signingPrivateKeyPkcs8);
  if (!isJsonValue(snapshot)) fail('SIGNING_INVALID_INPUT');
  return Object.freeze({
    format: SIGNED_VAULT_PAYLOAD_FORMAT,
    signingPrivateKeyPkcs8: normalizedKey,
    snapshot,
  });
}

export function parseSignedVaultPayload(value: unknown): SignedVaultPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SIGNING_INVALID_INPUT');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !== 'format,signingPrivateKeyPkcs8,snapshot'
    || record.format !== SIGNED_VAULT_PAYLOAD_FORMAT
    || !isJsonValue(record.snapshot)
  ) fail('SIGNING_INVALID_INPUT');
  return createSignedVaultPayload(normalizeVaultBase64Url(record.signingPrivateKeyPkcs8), record.snapshot);
}
