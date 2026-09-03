export const CREDENTIAL_KEK_VERSION = 'RV_BETA_CREDENTIAL_KEK_V1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class BetaCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BetaCredentialError';
    this.code = code;
  }
}

function cryptoApi(candidate) {
  const value = candidate ?? globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new BetaCredentialError('CRYPTO_UNAVAILABLE', 'credential crypto unavailable');
  }
  return value;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) throw new Error('invalid encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertAadInput({ tenantId, connectionId, credentialVersion }) {
  if (!UUID_PATTERN.test(tenantId ?? '') || !UUID_PATTERN.test(connectionId ?? '')) {
    throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'credential binding invalid');
  }
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'credential version invalid');
  }
}

function credentialAadText(binding) {
  assertAadInput(binding);
  return [
    'rv-binance-beta-credential-aad/1',
    `tenant:${binding.tenantId}`,
    `connection:${binding.connectionId}`,
    'provider:BINANCE',
    'market:USD_M',
    `credential-version:${binding.credentialVersion}`,
  ].join('\n');
}

export function credentialAad(binding) {
  return encoder.encode(credentialAadText(binding));
}

async function sha256Hex(value, api) {
  return toHex(new Uint8Array(await api.subtle.digest('SHA-256', value)));
}

async function envelopeDigest(envelope, api) {
  return sha256Hex(encoder.encode([
    'rv-binance-beta-credential-envelope/1',
    String(envelope.version),
    String(envelope.credentialVersion),
    envelope.nonce,
    envelope.ciphertext,
    envelope.keyRef,
  ].join('\n')), api);
}

function assertKek(kekBytes) {
  if (!(kekBytes instanceof Uint8Array) || kekBytes.byteLength !== 32) {
    throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'credential KEK invalid');
  }
}

async function importAesKey(bytes, usages, api) {
  return api.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, usages);
}

export async function encryptCredentialEnvelope(input) {
  const api = cryptoApi(input?.crypto);
  assertAadInput(input ?? {});
  assertKek(input?.kekBytes);
  if (
    typeof input.apiKey !== 'string'
    || typeof input.apiSecret !== 'string'
    || input.apiKey.length < 16
    || input.apiKey.length > 256
    || input.apiSecret.length < 16
    || input.apiSecret.length > 256
    || /[\u0000-\u001f\u007f]/u.test(`${input.apiKey}${input.apiSecret}`)
  ) throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'credential pair invalid');

  const dekBytes = api.getRandomValues(new Uint8Array(32));
  const nonce = api.getRandomValues(new Uint8Array(12));
  const wrapNonce = api.getRandomValues(new Uint8Array(12));
  const aad = credentialAad(input);
  const wrapAad = encoder.encode(`${credentialAadText(input)}\nobject:DEK`);
  const dek = await importAesKey(dekBytes, ['encrypt'], api);
  const kek = await importAesKey(input.kekBytes, ['encrypt'], api);
  const plaintext = encoder.encode(JSON.stringify({ apiKey: input.apiKey, apiSecret: input.apiSecret }));
  try {
    const ciphertext = new Uint8Array(await api.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      dek,
      plaintext,
    ));
    const wrappedDek = new Uint8Array(await api.subtle.encrypt(
      { name: 'AES-GCM', iv: wrapNonce, additionalData: wrapAad, tagLength: 128 },
      kek,
      dekBytes,
    ));
    const envelope = {
      version: 1,
      credentialVersion: input.credentialVersion,
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(ciphertext),
      keyRef: `${CREDENTIAL_KEK_VERSION}.${bytesToBase64Url(wrapNonce)}.${bytesToBase64Url(wrappedDek)}`,
    };
    return Object.freeze({ ...envelope, sha256: await envelopeDigest(envelope, api) });
  } catch (error) {
    if (error instanceof BetaCredentialError) throw error;
    throw new BetaCredentialError('CRYPTO_UNAVAILABLE', 'credential encryption unavailable');
  } finally {
    dekBytes.fill(0);
    plaintext.fill(0);
  }
}

function validateEnvelope(envelope) {
  if (
    !envelope
    || typeof envelope !== 'object'
    || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'ciphertext,credentialVersion,keyRef,nonce,sha256,version'
    || envelope.version !== 1
    || !Number.isSafeInteger(envelope.credentialVersion)
    || envelope.credentialVersion < 1
    || !BASE64URL_PATTERN.test(envelope.nonce ?? '')
    || !BASE64URL_PATTERN.test(envelope.ciphertext ?? '')
    || !HEX_64_PATTERN.test(envelope.sha256 ?? '')
  ) throw new Error('invalid envelope');
  const parts = String(envelope.keyRef ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== CREDENTIAL_KEK_VERSION || !BASE64URL_PATTERN.test(parts[1]) || !BASE64URL_PATTERN.test(parts[2])) {
    throw new Error('invalid key reference');
  }
  return parts;
}

export async function decryptCredentialEnvelope(input) {
  try {
    const api = cryptoApi(input?.crypto);
    assertKek(input?.kekBytes);
    const parts = validateEnvelope(input?.envelope);
    const binding = {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      credentialVersion: input.envelope.credentialVersion,
    };
    const expectedDigest = await envelopeDigest(input.envelope, api);
    if (expectedDigest !== input.envelope.sha256) throw new Error('digest mismatch');
    const kek = await importAesKey(input.kekBytes, ['decrypt'], api);
    const dekBytes = new Uint8Array(await api.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(parts[1]),
        additionalData: encoder.encode(`${credentialAadText(binding)}\nobject:DEK`),
        tagLength: 128,
      },
      kek,
      base64UrlToBytes(parts[2]),
    ));
    try {
      const dek = await importAesKey(dekBytes, ['decrypt'], api);
      const clearBytes = new Uint8Array(await api.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64UrlToBytes(input.envelope.nonce),
          additionalData: credentialAad(binding),
          tagLength: 128,
        },
        dek,
        base64UrlToBytes(input.envelope.ciphertext),
      ));
      try {
        const value = JSON.parse(decoder.decode(clearBytes));
        if (
          !value
          || typeof value !== 'object'
          || Object.keys(value).sort().join(',') !== 'apiKey,apiSecret'
          || typeof value.apiKey !== 'string'
          || typeof value.apiSecret !== 'string'
        ) throw new Error('invalid plaintext');
        return Object.freeze({ apiKey: value.apiKey, apiSecret: value.apiSecret });
      } finally {
        clearBytes.fill(0);
      }
    } finally {
      dekBytes.fill(0);
    }
  } catch {
    throw new BetaCredentialError('CREDENTIAL_UNWRAP_FAILED', 'credential envelope unavailable');
  }
}

export async function providerScopeHash(apiKey, secretBytes, cryptoOverride) {
  const api = cryptoApi(cryptoOverride);
  assertKek(secretBytes);
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 256) {
    throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'credential scope invalid');
  }
  const key = await api.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await api.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`rv-binance-provider-scope/1\0BINANCE\0USD_M\0${apiKey}`),
  );
  return toHex(new Uint8Array(signature));
}

export async function permissionEvidenceDigest(conclusion, cryptoOverride) {
  const api = cryptoApi(cryptoOverride);
  const keys = [
    'readOnly',
    'tradeDisabled',
    'withdrawDisabled',
    'internalTransferDisabled',
    'universalTransferDisabled',
  ];
  if (!conclusion || typeof conclusion !== 'object' || keys.some((key) => typeof conclusion[key] !== 'boolean')) {
    throw new BetaCredentialError('CREDENTIAL_INPUT_INVALID', 'permission conclusion invalid');
  }
  const canonical = ['rv-binance-permission/1', 'provider:binance-usdm', ...keys.map((key) => `${key}:${conclusion[key]}`)].join('\n');
  return sha256Hex(encoder.encode(canonical), api);
}
