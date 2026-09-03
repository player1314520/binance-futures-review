import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_LIVE_ATTESTATION_KEY_ID,
  PRODUCTION_LIVE_ATTESTATION_KEY_STATUS,
  PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
  PRODUCTION_OPERATIONS_ATTESTATION_KEY_STATUS,
  PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  assertProductionLiveAttestationProvisioned,
  assertProductionOperationsAttestationProvisioned,
  isProductionLiveAttestationContractProvisioned,
  isProductionOperationsAttestationContractProvisioned,
  signProductionLiveGateAttestation,
  signProductionOperationsAttestation,
  verifyEd25519Attestation,
  verifyProductionLiveGateAttestation,
  verifyProductionOperationsAttestation,
} from '../app/production-live-attestation.mjs';

// RFC 8032 test vector 1. It validates the generic verifier without creating or
// storing any private key in this repository.
const RFC_EMPTY_MESSAGE_SIGNATURE =
  '5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc-bRr0lv18FlbviRlUUFDjnoQCw';
const RFC_EMPTY_MESSAGE_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const OPERATIONS_SENTINEL_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=';

test('generic Ed25519 verifier accepts the exact RFC vector and rejects tampering', () => {
  assert.equal(verifyEd25519Attestation({
    payload: '',
    signature: RFC_EMPTY_MESSAGE_SIGNATURE,
    publicKeySpkiBase64: RFC_EMPTY_MESSAGE_PUBLIC_KEY_SPKI_BASE64,
  }), true);
  assert.equal(verifyEd25519Attestation({
    payload: 'tampered',
    signature: RFC_EMPTY_MESSAGE_SIGNATURE,
    publicKeySpkiBase64: RFC_EMPTY_MESSAGE_PUBLIC_KEY_SPKI_BASE64,
  }), false);
  assert.equal(verifyEd25519Attestation({
    payload: '',
    signature: `${RFC_EMPTY_MESSAGE_SIGNATURE.slice(0, -1)}A`,
    publicKeySpkiBase64: RFC_EMPTY_MESSAGE_PUBLIC_KEY_SPKI_BASE64,
  }), false);
  assert.equal(verifyEd25519Attestation({
    payload: '',
    signature: RFC_EMPTY_MESSAGE_SIGNATURE,
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=',
  }), false, 'a signature from a different Ed25519 key must be rejected');
});

test('independent operations signer is active, separately fixed, and fail-closed', () => {
  assert.equal(PRODUCTION_OPERATIONS_ATTESTATION_KEY_STATUS, 'active');
  assert.match(PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID, /^rv-operations-[a-z0-9-]{8,80}$/);
  assert.doesNotThrow(() => assertProductionOperationsAttestationProvisioned());
  assert.equal(verifyProductionOperationsAttestation('', RFC_EMPTY_MESSAGE_SIGNATURE), false);
  assert.throws(
    () => signProductionOperationsAttestation('{}', 'not-a-private-key'),
    /canonical base64|private key/i,
  );
  assert.equal(isProductionOperationsAttestationContractProvisioned({
    status: 'active',
    keyId: PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
    publicKeySpkiBase64: PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  }), true, 'the reviewed operations public contract must be active');
  assert.equal(isProductionOperationsAttestationContractProvisioned({
    status: 'active',
    keyId: 'rv-operations-real-key-2026-01',
    publicKeySpkiBase64: OPERATIONS_SENTINEL_PUBLIC_KEY_SPKI_BASE64,
  }), false, 'the old operations sentinel public key must remain rejected');
  assert.equal(isProductionOperationsAttestationContractProvisioned({
    status: 'active',
    keyId: 'rv-operations-real-key-2026-01',
    publicKeySpkiBase64: PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  }), false, 'operations and live gate must never share one signing key');
});

test('repository live attestation contract is active and still rejects invalid proof', () => {
  assert.equal(PRODUCTION_LIVE_ATTESTATION_KEY_STATUS, 'active');
  assert.match(PRODUCTION_LIVE_ATTESTATION_KEY_ID, /^rv-production-[a-z0-9-]{8,80}$/);
  assert.doesNotThrow(() => assertProductionLiveAttestationProvisioned());
  assert.equal(verifyProductionLiveGateAttestation('', RFC_EMPTY_MESSAGE_SIGNATURE), false);
  assert.throws(
    () => signProductionLiveGateAttestation('{}', 'not-a-private-key'),
    /canonical base64|private key/i,
  );
  assert.equal(isProductionLiveAttestationContractProvisioned({
    status: 'active',
    keyId: PRODUCTION_LIVE_ATTESTATION_KEY_ID,
    publicKeySpkiBase64: PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  }), true, 'the reviewed live public contract must be active');
  assert.equal(isProductionLiveAttestationContractProvisioned({
    status: 'active',
    keyId: 'rv-production-real-key-2026-01',
    publicKeySpkiBase64: RFC_EMPTY_MESSAGE_PUBLIC_KEY_SPKI_BASE64,
  }), false, 'the old RFC sentinel public key must remain rejected');
  assert.equal(isProductionLiveAttestationContractProvisioned({
    status: 'active',
    keyId: 'rv-production-real-key-2026-01',
    publicKeySpkiBase64: 'bm90LWFuLWVkaW50MTkta2V5',
  }), false, 'an active contract must contain one canonical Ed25519 SPKI public key');
  assert.equal(isProductionLiveAttestationContractProvisioned({
    status: 'active',
    keyId: 'rv-production-real-key-2026-01',
    publicKeySpkiBase64: 'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=',
  }), true, 'a reviewed non-sentinel Ed25519 SPKI can activate the fixed contract');
});
