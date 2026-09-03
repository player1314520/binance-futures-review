import crypto from 'node:crypto';

export const PRODUCTION_LIVE_ATTESTATION_ALGORITHM = 'Ed25519';
export const PRODUCTION_LIVE_ATTESTATION_SIGNATURE_FORMAT = 'base64url-ed25519/1';

// Only the reviewed public verification contract lives in source. The matching
// private key is held outside Git, Vercel, and Supabase. Neither Vite nor the
// live runner accepts a replacement public key from env.
export const PRODUCTION_LIVE_ATTESTATION_KEY_STATUS = 'active';
export const PRODUCTION_LIVE_ATTESTATION_KEY_ID = 'rv-production-20260830-1617de16d213be5b';
export const PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAWEzHUqHIwkL/fb9nZV40BKHyXKmDxJLe+uXXt1hnuC4=';
const SENTINEL_KEY_ID = 'rv-production-unprovisioned';
const SENTINEL_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

export const PRODUCTION_OPERATIONS_ATTESTATION_KEY_STATUS = 'active';
export const PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID = 'rv-operations-20260830-a95be4e61292b1c4';
export const PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAZ9813B6aQMgaNGOQl7CRpPJJKSHgF36xeNfnd/bTEXE=';
const OPERATIONS_SENTINEL_KEY_ID = 'rv-operations-unprovisioned';
const OPERATIONS_SENTINEL_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=';

function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  return decoded;
}

function decodeCanonicalBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new Error(`${label} is not canonical base64url`);
  }
  return decoded;
}

function boundedPayload(value) {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new Error('production receipt payload has an invalid length');
  }
  return Buffer.from(value, 'utf8');
}

export function verifyEd25519Attestation({ payload, signature, publicKeySpkiBase64 }) {
  try {
    const key = crypto.createPublicKey({
      key: decodeCanonicalBase64(publicKeySpkiBase64, 'Ed25519 public key'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return crypto.verify(
      null,
      boundedPayload(payload),
      key,
      decodeCanonicalBase64Url(signature, 64, 'Ed25519 signature'),
    );
  } catch {
    return false;
  }
}

export function isProductionLiveAttestationContractProvisioned({ status, keyId, publicKeySpkiBase64 }) {
  if (
    status !== 'active'
    || typeof keyId !== 'string'
    || !/^rv-production-[a-z0-9-]{8,80}$/.test(keyId)
    || keyId === SENTINEL_KEY_ID
    || typeof publicKeySpkiBase64 !== 'string'
    || publicKeySpkiBase64 === SENTINEL_PUBLIC_KEY_SPKI_BASE64
  ) return false;
  try {
    const key = crypto.createPublicKey({
      key: decodeCanonicalBase64(publicKeySpkiBase64, 'Ed25519 public key'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519'
      && key.export({ format: 'der', type: 'spki' }).toString('base64') === publicKeySpkiBase64;
  } catch {
    return false;
  }
}

export function assertProductionLiveAttestationProvisioned() {
  if (!isProductionLiveAttestationContractProvisioned({
    status: PRODUCTION_LIVE_ATTESTATION_KEY_STATUS,
    keyId: PRODUCTION_LIVE_ATTESTATION_KEY_ID,
    publicKeySpkiBase64: PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  })) {
    throw new Error('production live attestation key is not provisioned');
  }
}

export function verifyProductionLiveGateAttestation(payload, signature) {
  try {
    assertProductionLiveAttestationProvisioned();
  } catch {
    return false;
  }
  return verifyEd25519Attestation({
    payload,
    signature,
    publicKeySpkiBase64: PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  });
}

export function signProductionLiveGateAttestation(payload, privateKeyPkcs8Base64) {
  assertProductionLiveAttestationProvisioned();
  const privateKey = crypto.createPrivateKey({
    key: decodeCanonicalBase64(privateKeyPkcs8Base64, 'Ed25519 private key'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('production live attestation private key is not Ed25519');
  }
  const derivedPublic = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (derivedPublic.toString('base64') !== PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64) {
    throw new Error('production live attestation private key does not match the fixed public key');
  }
  return crypto.sign(null, boundedPayload(payload), privateKey).toString('base64url');
}

export function isProductionOperationsAttestationContractProvisioned({
  status, keyId, publicKeySpkiBase64,
}) {
  if (
    status !== 'active'
    || typeof keyId !== 'string'
    || !/^rv-operations-[a-z0-9-]{8,80}$/.test(keyId)
    || keyId === OPERATIONS_SENTINEL_KEY_ID
    || keyId === PRODUCTION_LIVE_ATTESTATION_KEY_ID
    || typeof publicKeySpkiBase64 !== 'string'
    || publicKeySpkiBase64 === OPERATIONS_SENTINEL_PUBLIC_KEY_SPKI_BASE64
    || publicKeySpkiBase64 === PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64
  ) return false;
  try {
    const key = crypto.createPublicKey({
      key: decodeCanonicalBase64(publicKeySpkiBase64, 'operations Ed25519 public key'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519'
      && key.export({ format: 'der', type: 'spki' }).toString('base64') === publicKeySpkiBase64;
  } catch {
    return false;
  }
}

export function assertProductionOperationsAttestationProvisioned() {
  if (!isProductionOperationsAttestationContractProvisioned({
    status: PRODUCTION_OPERATIONS_ATTESTATION_KEY_STATUS,
    keyId: PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
    publicKeySpkiBase64: PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  })) throw new Error('production operations attestation key is not provisioned');
}

export function verifyProductionOperationsAttestation(payload, signature) {
  try {
    assertProductionOperationsAttestationProvisioned();
  } catch {
    return false;
  }
  return verifyEd25519Attestation({
    payload,
    signature,
    publicKeySpkiBase64: PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  });
}

export function signProductionOperationsAttestation(payload, privateKeyPkcs8Base64) {
  assertProductionOperationsAttestationProvisioned();
  const privateKey = crypto.createPrivateKey({
    key: decodeCanonicalBase64(privateKeyPkcs8Base64, 'operations Ed25519 private key'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('production operations attestation private key is not Ed25519');
  }
  const derivedPublic = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (derivedPublic.toString('base64') !== PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64) {
    throw new Error('production operations private key does not match the fixed public key');
  }
  return crypto.sign(null, boundedPayload(payload), privateKey).toString('base64url');
}
