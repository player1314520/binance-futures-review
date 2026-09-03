import { canonicalJson, type JsonValue } from './canonical-json';

export const VAULT_ENVELOPE_FORMAT = 'rv-e2ee-vault';
export const VAULT_ENVELOPE_VERSION = 1 as const;
export const VAULT_KDF_ITERATIONS = 600_000;

export const VAULT_CRYPTO_LIMITS = Object.freeze({
  sourceFileBytes: 8 * 1024 * 1024,
  plaintextBytes: 16 * 1024 * 1024,
  ciphertextBytes: (16 * 1024 * 1024) + 16,
  envelopeBytes: 24 * 1024 * 1024,
  secretBytes: 1024,
  aadIdentifierCharacters: 256,
});

const MIN_SECRET_BYTES = 16;
const DEK_BYTES = 32;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BITS = 128;
const GCM_TAG_BYTES = GCM_TAG_BITS / 8;
const WRAPPED_DEK_BYTES = DEK_BYTES + GCM_TAG_BYTES;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
type Bytes = Uint8Array<ArrayBuffer>;

export type VaultAad = Readonly<{
  user: string;
  workspace: string;
  kind: string;
  logicalKey: string;
  generation: number;
  schemaVersion: number;
}>;

export type VaultEnvelopeV1 = Readonly<{
  format: typeof VAULT_ENVELOPE_FORMAT;
  version: typeof VAULT_ENVELOPE_VERSION;
  aad: VaultAad;
  kdf: Readonly<{
    name: 'PBKDF2';
    hash: 'SHA-256';
    iterations: typeof VAULT_KDF_ITERATIONS;
    salt: string;
  }>;
  keyWrap: Readonly<{
    name: 'AES-GCM-256';
    iv: string;
    ciphertext: string;
  }>;
  payload: Readonly<{
    name: 'AES-GCM-256';
    iv: string;
    ciphertext: string;
    plaintextBytes: number;
  }>;
}>;

export type VaultRandomSource = (length: number) => Uint8Array;

export type VaultCryptoOptions = Readonly<{
  webCrypto?: Crypto;
  randomBytes?: VaultRandomSource;
}>;

export type VaultCryptoErrorCode =
  | 'VAULT_AUTHENTICATION_FAILED'
  | 'VAULT_CRYPTO_UNAVAILABLE'
  | 'VAULT_INVALID_INPUT'
  | 'VAULT_LIMIT_EXCEEDED'
  | 'VAULT_UNSUPPORTED_VERSION';

export class VaultCryptoError extends Error {
  readonly code: VaultCryptoErrorCode;

  constructor(code: VaultCryptoErrorCode) {
    super(code);
    this.name = 'VaultCryptoError';
    this.code = code;
  }
}

type ParsedEnvelope = Readonly<{
  envelope: VaultEnvelopeV1;
  salt: Bytes;
  wrapIv: Bytes;
  wrappedDek: Bytes;
  payloadIv: Bytes;
  ciphertext: Bytes;
}>;

function fail(code: VaultCryptoErrorCode): never {
  throw new VaultCryptoError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function normalizedAad(value: unknown): VaultAad {
  if (!isRecord(value) || !hasExactKeys(value, [
    'user',
    'workspace',
    'kind',
    'logicalKey',
    'generation',
    'schemaVersion',
  ])) fail('VAULT_INVALID_INPUT');

  const identifier = (candidate: unknown, maxLength: number): string => {
    if (
      typeof candidate !== 'string'
      || candidate.length < 1
      || candidate.length > maxLength
      || candidate.trim() !== candidate
      || /[\u0000-\u001f\u007f]/.test(candidate)
    ) fail('VAULT_INVALID_INPUT');
    return candidate;
  };

  const user = identifier(value.user, 128);
  const workspace = identifier(value.workspace, 128);
  const kind = identifier(value.kind, 64);
  const logicalKey = identifier(
    value.logicalKey,
    VAULT_CRYPTO_LIMITS.aadIdentifierCharacters,
  );
  if (!KIND_PATTERN.test(kind)) fail('VAULT_INVALID_INPUT');
  if (
    !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 1
    || !Number.isSafeInteger(value.schemaVersion)
    || Number(value.schemaVersion) < 1
  ) fail('VAULT_INVALID_INPUT');

  return Object.freeze({
    user,
    workspace,
    kind,
    logicalKey,
    generation: Number(value.generation),
    schemaVersion: Number(value.schemaVersion),
  });
}

function aadBytes(purpose: 'key-wrap' | 'payload', aad: VaultAad): Bytes {
  return textEncoder.encode(canonicalJson({
    aad,
    domain: `${VAULT_ENVELOPE_FORMAT}/${VAULT_ENVELOPE_VERSION}/${purpose}`,
  }));
}

function getWebCrypto(options: VaultCryptoOptions): Crypto {
  const webCrypto = options.webCrypto ?? globalThis.crypto;
  if (!webCrypto?.subtle || typeof webCrypto.getRandomValues !== 'function') {
    fail('VAULT_CRYPTO_UNAVAILABLE');
  }
  return webCrypto;
}

function randomBytes(
  length: number,
  webCrypto: Crypto,
  source?: VaultRandomSource,
): Bytes {
  const generated = source
    ? source(length)
    : webCrypto.getRandomValues(new Uint8Array(length));
  if (!isUint8Array(generated) || generated.byteLength !== length) {
    fail('VAULT_INVALID_INPUT');
  }
  const copied = new Uint8Array(length);
  copied.set(generated);
  return copied;
}

function secretBytes(secret: string | Uint8Array): Bytes {
  if (typeof secret !== 'string' && !isUint8Array(secret)) {
    fail('VAULT_INVALID_INPUT');
  }
  const encoded = typeof secret === 'string'
    ? textEncoder.encode(secret)
    : new Uint8Array(secret);
  if (
    encoded.byteLength < MIN_SECRET_BYTES
    || encoded.byteLength > VAULT_CRYPTO_LIMITS.secretBytes
  ) {
    encoded.fill(0);
    fail('VAULT_INVALID_INPUT');
  }
  return encoded;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function maximumBase64UrlCharacters(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function base64UrlDecode(
  value: unknown,
  maximumBytes: number,
  exactBytes?: number,
): Bytes {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumBase64UrlCharacters(maximumBytes)
    || !BASE64URL_PATTERN.test(value)
  ) fail('VAULT_INVALID_INPUT');

  try {
    const paddingLength = (4 - (value.length % 4)) % 4;
    const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(paddingLength)}`);
    if (
      binary.length > maximumBytes
      || (exactBytes !== undefined && binary.length !== exactBytes)
    ) fail('VAULT_INVALID_INPUT');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    if (base64UrlEncode(bytes) !== value) fail('VAULT_INVALID_INPUT');
    return bytes;
  } catch (error) {
    if (error instanceof VaultCryptoError) throw error;
    return fail('VAULT_INVALID_INPUT');
  }
}

function validateByteLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail('VAULT_LIMIT_EXCEEDED');
  }
}

export function assertVaultSourceFileSize(bytes: number): void {
  validateByteLimit(bytes, VAULT_CRYPTO_LIMITS.sourceFileBytes);
}

export function assertVaultPlaintextSize(bytes: number): void {
  validateByteLimit(bytes, VAULT_CRYPTO_LIMITS.plaintextBytes);
}

export function assertVaultCiphertextSize(bytes: number): void {
  validateByteLimit(bytes, VAULT_CRYPTO_LIMITS.ciphertextBytes);
}

export function assertVaultEnvelopeSize(bytes: number): void {
  validateByteLimit(bytes, VAULT_CRYPTO_LIMITS.envelopeBytes);
}

async function deriveWrappingKey(
  webCrypto: Crypto,
  secret: Bytes,
  salt: Bytes,
): Promise<CryptoKey> {
  const material = await webCrypto.subtle.importKey(
    'raw',
    secret,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return webCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: VAULT_KDF_ITERATIONS,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function parseEnvelope(value: unknown): ParsedEnvelope {
  if (!isRecord(value)) fail('VAULT_INVALID_INPUT');
  if (value.format !== VAULT_ENVELOPE_FORMAT || value.version !== VAULT_ENVELOPE_VERSION) {
    fail('VAULT_UNSUPPORTED_VERSION');
  }
  if (!hasExactKeys(value, ['format', 'version', 'aad', 'kdf', 'keyWrap', 'payload'])) {
    fail('VAULT_INVALID_INPUT');
  }
  if (
    !isRecord(value.kdf)
    || !hasExactKeys(value.kdf, ['name', 'hash', 'iterations', 'salt'])
    || value.kdf.name !== 'PBKDF2'
    || value.kdf.hash !== 'SHA-256'
    || value.kdf.iterations !== VAULT_KDF_ITERATIONS
    || !isRecord(value.keyWrap)
    || !hasExactKeys(value.keyWrap, ['name', 'iv', 'ciphertext'])
    || value.keyWrap.name !== 'AES-GCM-256'
    || !isRecord(value.payload)
    || !hasExactKeys(value.payload, ['name', 'iv', 'ciphertext', 'plaintextBytes'])
    || value.payload.name !== 'AES-GCM-256'
  ) fail('VAULT_INVALID_INPUT');

  const aad = normalizedAad(value.aad);
  if (typeof value.payload.plaintextBytes !== 'number') fail('VAULT_INVALID_INPUT');
  const plaintextBytes = value.payload.plaintextBytes;
  assertVaultPlaintextSize(plaintextBytes);
  const ciphertextBytes = plaintextBytes + GCM_TAG_BYTES;
  assertVaultCiphertextSize(ciphertextBytes);

  const saltText = value.kdf.salt;
  const wrapIvText = value.keyWrap.iv;
  const wrappedDekText = value.keyWrap.ciphertext;
  const payloadIvText = value.payload.iv;
  const ciphertextText = value.payload.ciphertext;
  if (
    typeof saltText !== 'string'
    || typeof wrapIvText !== 'string'
    || typeof wrappedDekText !== 'string'
    || typeof payloadIvText !== 'string'
    || typeof ciphertextText !== 'string'
  ) fail('VAULT_INVALID_INPUT');

  const envelope: VaultEnvelopeV1 = Object.freeze({
    format: VAULT_ENVELOPE_FORMAT,
    version: VAULT_ENVELOPE_VERSION,
    aad,
    kdf: Object.freeze({
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: VAULT_KDF_ITERATIONS,
      salt: saltText,
    }),
    keyWrap: Object.freeze({
      name: 'AES-GCM-256',
      iv: wrapIvText,
      ciphertext: wrappedDekText,
    }),
    payload: Object.freeze({
      name: 'AES-GCM-256',
      iv: payloadIvText,
      ciphertext: ciphertextText,
      plaintextBytes,
    }),
  });
  return Object.freeze({
    envelope,
    salt: base64UrlDecode(saltText, SALT_BYTES, SALT_BYTES),
    wrapIv: base64UrlDecode(wrapIvText, GCM_IV_BYTES, GCM_IV_BYTES),
    wrappedDek: base64UrlDecode(
      wrappedDekText,
      WRAPPED_DEK_BYTES,
      WRAPPED_DEK_BYTES,
    ),
    payloadIv: base64UrlDecode(payloadIvText, GCM_IV_BYTES, GCM_IV_BYTES),
    ciphertext: base64UrlDecode(
      ciphertextText,
      ciphertextBytes,
      ciphertextBytes,
    ),
  });
}

function sameAad(first: VaultAad, second: VaultAad): boolean {
  return canonicalJson(first) === canonicalJson(second);
}

function clearParsedEnvelope(parsed: ParsedEnvelope): void {
  parsed.salt.fill(0);
  parsed.wrapIv.fill(0);
  parsed.wrappedDek.fill(0);
  parsed.payloadIv.fill(0);
  parsed.ciphertext.fill(0);
}

/** Converts a validated envelope to canonical UTF-8 bytes for repository upload. */
export function serializeVaultEnvelope(envelopeInput: unknown): Bytes {
  const parsed = parseEnvelope(envelopeInput);
  try {
    const bytes = textEncoder.encode(canonicalJson(parsed.envelope));
    assertVaultEnvelopeSize(bytes.byteLength);
    return bytes;
  } finally {
    clearParsedEnvelope(parsed);
  }
}

/** Validates canonical UTF-8 repository bytes before they reach decryption. */
export function deserializeVaultEnvelope(bytesInput: Uint8Array): VaultEnvelopeV1 {
  if (!isUint8Array(bytesInput) || bytesInput.byteLength < 1) {
    fail('VAULT_INVALID_INPUT');
  }
  assertVaultEnvelopeSize(bytesInput.byteLength);

  try {
    const serialized = textDecoder.decode(bytesInput);
    const untrusted = JSON.parse(serialized) as unknown;
    const parsed = parseEnvelope(untrusted);
    try {
      if (canonicalJson(parsed.envelope) !== serialized) fail('VAULT_INVALID_INPUT');
      return parsed.envelope;
    } finally {
      clearParsedEnvelope(parsed);
    }
  } catch (error) {
    if (error instanceof VaultCryptoError) throw error;
    return fail('VAULT_INVALID_INPUT');
  }
}

/**
 * Encrypts canonical JSON with a fresh content key, then wraps that key with a
 * PBKDF2-derived AES key. The returned object is safe to serialize for a vault
 * repository; only routing metadata in `aad` remains visible to that service.
 */
export async function encryptVaultPayload<T extends JsonValue>(
  payload: T,
  secret: string | Uint8Array,
  aadInput: VaultAad,
  options: VaultCryptoOptions = {},
): Promise<VaultEnvelopeV1> {
  const webCrypto = getWebCrypto(options);
  const aad = normalizedAad(aadInput);
  const plaintext = textEncoder.encode(canonicalJson(payload));
  assertVaultPlaintextSize(plaintext.byteLength);

  const secretCopy = secretBytes(secret);
  const dek = randomBytes(DEK_BYTES, webCrypto, options.randomBytes);
  const salt = randomBytes(SALT_BYTES, webCrypto, options.randomBytes);
  const wrapIv = randomBytes(GCM_IV_BYTES, webCrypto, options.randomBytes);
  const payloadIv = randomBytes(GCM_IV_BYTES, webCrypto, options.randomBytes);

  try {
    const [wrappingKey, payloadKey] = await Promise.all([
      deriveWrappingKey(webCrypto, secretCopy, salt),
      webCrypto.subtle.importKey(
        'raw',
        dek,
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
      ),
    ]);
    const [wrappedDekBuffer, ciphertextBuffer] = await Promise.all([
      webCrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: wrapIv,
          additionalData: aadBytes('key-wrap', aad),
          tagLength: GCM_TAG_BITS,
        },
        wrappingKey,
        dek,
      ),
      webCrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: payloadIv,
          additionalData: aadBytes('payload', aad),
          tagLength: GCM_TAG_BITS,
        },
        payloadKey,
        plaintext,
      ),
    ]);

    const wrappedDek = new Uint8Array(wrappedDekBuffer);
    const ciphertext = new Uint8Array(ciphertextBuffer);
    assertVaultCiphertextSize(ciphertext.byteLength);
    if (wrappedDek.byteLength !== WRAPPED_DEK_BYTES) fail('VAULT_INVALID_INPUT');

    return Object.freeze({
      format: VAULT_ENVELOPE_FORMAT,
      version: VAULT_ENVELOPE_VERSION,
      aad,
      kdf: Object.freeze({
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: VAULT_KDF_ITERATIONS,
        salt: base64UrlEncode(salt),
      }),
      keyWrap: Object.freeze({
        name: 'AES-GCM-256',
        iv: base64UrlEncode(wrapIv),
        ciphertext: base64UrlEncode(wrappedDek),
      }),
      payload: Object.freeze({
        name: 'AES-GCM-256',
        iv: base64UrlEncode(payloadIv),
        ciphertext: base64UrlEncode(ciphertext),
        plaintextBytes: plaintext.byteLength,
      }),
    });
  } finally {
    secretCopy.fill(0);
    dek.fill(0);
    plaintext.fill(0);
  }
}

/**
 * Authenticates and decrypts a repository envelope. Wrong secrets, altered
 * ciphertext and substituted AAD intentionally share one failure code.
 */
export async function decryptVaultPayload<T extends JsonValue = JsonValue>(
  envelopeInput: unknown,
  secret: string | Uint8Array,
  expectedAadInput: VaultAad,
  options: Pick<VaultCryptoOptions, 'webCrypto'> = {},
): Promise<T> {
  const webCrypto = getWebCrypto(options);
  const parsed = parseEnvelope(envelopeInput);
  const expectedAad = normalizedAad(expectedAadInput);
  if (!sameAad(parsed.envelope.aad, expectedAad)) {
    fail('VAULT_AUTHENTICATION_FAILED');
  }

  const secretCopy = secretBytes(secret);
  let dek: Bytes | null = null;
  let plaintext: Bytes | null = null;
  try {
    const wrappingKey = await deriveWrappingKey(webCrypto, secretCopy, parsed.salt);
    const dekBuffer = await webCrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.wrapIv,
        additionalData: aadBytes('key-wrap', parsed.envelope.aad),
        tagLength: GCM_TAG_BITS,
      },
      wrappingKey,
      parsed.wrappedDek,
    );
    dek = new Uint8Array(dekBuffer);
    if (dek.byteLength !== DEK_BYTES) fail('VAULT_AUTHENTICATION_FAILED');

    const payloadKey = await webCrypto.subtle.importKey(
      'raw',
      dek,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plaintextBuffer = await webCrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: parsed.payloadIv,
        additionalData: aadBytes('payload', parsed.envelope.aad),
        tagLength: GCM_TAG_BITS,
      },
      payloadKey,
      parsed.ciphertext,
    );
    plaintext = new Uint8Array(plaintextBuffer);
    if (plaintext.byteLength !== parsed.envelope.payload.plaintextBytes) {
      fail('VAULT_AUTHENTICATION_FAILED');
    }

    const serialized = textDecoder.decode(plaintext);
    const value = JSON.parse(serialized) as JsonValue;
    if (canonicalJson(value) !== serialized) fail('VAULT_AUTHENTICATION_FAILED');
    return value as T;
  } catch (error) {
    if (
      error instanceof VaultCryptoError
      && error.code !== 'VAULT_AUTHENTICATION_FAILED'
    ) throw error;
    return fail('VAULT_AUTHENTICATION_FAILED');
  } finally {
    secretCopy.fill(0);
    dek?.fill(0);
    plaintext?.fill(0);
    clearParsedEnvelope(parsed);
  }
}
