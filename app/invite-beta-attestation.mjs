import {
  verifyEd25519Attestation,
} from './production-live-attestation.mjs';

export const INVITE_BETA_ATTESTATION_ALGORITHM = 'Ed25519';
export const INVITE_BETA_ATTESTATION_SIGNATURE_FORMAT = 'base64url-ed25519/1';

// Invite Beta has an evidence chain that is deliberately independent from the
// retired production-vault chain.  A reviewed public key must replace each
// sentinel in source before any invite-beta build can pass.  Private keys are
// generated and retained offline; they are never accepted from env, Supabase,
// Vercel, GitHub Actions, or the database.
export const INVITE_BETA_LIVE_ATTESTATION_KEY_STATUS = 'unprovisioned';
export const INVITE_BETA_LIVE_ATTESTATION_KEY_ID =
  'rv-invite-beta-live-unprovisioned';
export const INVITE_BETA_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

export const INVITE_BETA_OPERATIONS_ATTESTATION_KEY_STATUS = 'unprovisioned';
export const INVITE_BETA_OPERATIONS_ATTESTATION_KEY_ID =
  'rv-invite-beta-operations-unprovisioned';
export const INVITE_BETA_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64 =
  'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=';

function provisioned(status, keyId, publicKeySpkiBase64, sentinelId, sentinelKey) {
  return status === 'active'
    && typeof keyId === 'string'
    && /^rv-invite-beta-(?:live|operations)-[a-z0-9-]{8,80}$/.test(keyId)
    && keyId !== sentinelId
    && typeof publicKeySpkiBase64 === 'string'
    && publicKeySpkiBase64 !== sentinelKey;
}

export function isInviteBetaLiveAttestationProvisioned() {
  return provisioned(
    INVITE_BETA_LIVE_ATTESTATION_KEY_STATUS,
    INVITE_BETA_LIVE_ATTESTATION_KEY_ID,
    INVITE_BETA_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    'rv-invite-beta-live-unprovisioned',
    'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
  );
}

export function isInviteBetaOperationsAttestationProvisioned() {
  return provisioned(
    INVITE_BETA_OPERATIONS_ATTESTATION_KEY_STATUS,
    INVITE_BETA_OPERATIONS_ATTESTATION_KEY_ID,
    INVITE_BETA_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    'rv-invite-beta-operations-unprovisioned',
    'MCowBQYDK2VwAyEAPUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=',
  );
}

export function verifyInviteBetaLiveAttestation(payload, signature) {
  if (!isInviteBetaLiveAttestationProvisioned()) return false;
  return verifyEd25519Attestation({
    payload,
    signature,
    publicKeySpkiBase64: INVITE_BETA_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  });
}

export function verifyInviteBetaOperationsAttestation(payload, signature) {
  if (!isInviteBetaOperationsAttestationProvisioned()) return false;
  return verifyEd25519Attestation({
    payload,
    signature,
    publicKeySpkiBase64: INVITE_BETA_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
  });
}
