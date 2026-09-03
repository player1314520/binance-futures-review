import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
  assertProductionOperationsAttestationProvisioned,
  signProductionOperationsAttestation,
} from '../app/production-live-attestation.mjs';
import {
  createCanonicalProductionOperationsAttestation,
  parseCanonicalProductionOperationsEvidence,
  verifyInboxIdentityCommitments,
} from './production-operations-evidence.mjs';

export const PRODUCTION_OPERATIONS_REQUIRED_KEYS = Object.freeze([
  'RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE',
  'RV_PRODUCTION_OPERATIONS_EXPECTED_PROJECT_REF',
  'RV_PRODUCTION_OPERATIONS_APP_ORIGIN',
  'RV_PRODUCTION_OPERATIONS_SOURCE_COMMIT',
  'RV_PRODUCTION_OPERATIONS_LIVE_RECEIPT_SHA256',
  'RV_PRODUCTION_OPERATIONS_SIGN_ACK',
  'RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B',
]);
export const PRODUCTION_OPERATIONS_SENSITIVE_KEYS = Object.freeze([
  'RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE',
  'RV_PRODUCTION_OPERATIONS_SIGN_ACK',
  'RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A',
  'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B',
]);
export const PRODUCTION_OPERATIONS_INTERNAL_KEYS = Object.freeze([
  'RV_PRODUCTION_OPERATIONS_CANONICAL_BUNDLE',
  'RV_PRODUCTION_OPERATIONS_UNSIGNED_ATTESTATION',
]);
export const PRODUCTION_OPERATIONS_FORBIDDEN_LIVE_SECRET_KEYS = Object.freeze([
  'RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN',
  'RV_PRODUCTION_VAULT_TEST_USER_A_ACCESS_TOKEN',
  'RV_PRODUCTION_VAULT_TEST_USER_B_ACCESS_TOKEN',
  'RV_PRODUCTION_LIVE_ATTESTATION_PRIVATE_KEY_B64',
  'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE',
  'RV_PRODUCTION_CONTROL_PLANE_EVIDENCE_SHA',
  'RV_PRODUCTION_OTP_CODE',
  'RV_PRODUCTION_INBOX_ADDRESS',
]);
export const PRODUCTION_OPERATIONS_CLEANUP_KEYS = Object.freeze([
  ...new Set([
    ...PRODUCTION_OPERATIONS_REQUIRED_KEYS,
    ...PRODUCTION_OPERATIONS_SENSITIVE_KEYS,
    ...PRODUCTION_OPERATIONS_INTERNAL_KEYS,
    ...PRODUCTION_OPERATIONS_FORBIDDEN_LIVE_SECRET_KEYS,
  ]),
]);

export function clearProductionOperationsProcessEnvironment(environment = process.env) {
  for (const key of PRODUCTION_OPERATIONS_CLEANUP_KEYS) delete environment[key];
}

function readProtectedBundle(bundlePath) {
  if (!path.isAbsolute(bundlePath)) throw new Error('operations evidence path must be absolute');
  const stat = fs.lstatSync(bundlePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size > 32_768) {
    throw new Error('operations evidence must be one bounded regular file');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(bundlePath));
}

async function runSigner() {
  const missing = PRODUCTION_OPERATIONS_REQUIRED_KEYS.filter((key) => !(process.env[key]?.trim())).length;
  if (missing > 0) {
    process.stderr.write(`Production operations signer refused: ${missing} required process variables are missing.\n`);
    return 2;
  }
  if (PRODUCTION_OPERATIONS_FORBIDDEN_LIVE_SECRET_KEYS.some((key) => process.env[key])) {
    process.stderr.write('Production operations signer refused: live-gate or raw OTP secrets share its process scope.\n');
    return 1;
  }
  try {
    assertProductionOperationsAttestationProvisioned();
  } catch {
    process.stderr.write('Production operations signer refused: protected operations key is not provisioned.\n');
    return 1;
  }
  try {
    // Reject the wrong custody key before reading the protected evidence file.
    // This discarded signature is only a key-match preflight.
    signProductionOperationsAttestation(
      'rv-production-operations-attestation-key-preflight/1',
      process.env.RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64,
    );
  } catch {
    process.stderr.write('Production operations signer refused: protected operations key is invalid.\n');
    return 1;
  }
  if (process.env.RV_PRODUCTION_OPERATIONS_SIGN_ACK !== 'INDEPENDENT_OPERATOR_REVIEWED_PROTECTED_EVIDENCE') {
    process.stderr.write('Production operations signer refused: independent review acknowledgement is invalid.\n');
    return 1;
  }
  try {
    const canonicalEvidence = readProtectedBundle(process.env.RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE);
    const evidence = parseCanonicalProductionOperationsEvidence(canonicalEvidence, {
      projectRef: process.env.RV_PRODUCTION_OPERATIONS_EXPECTED_PROJECT_REF,
      appOrigin: process.env.RV_PRODUCTION_OPERATIONS_APP_ORIGIN,
      sourceCommit: process.env.RV_PRODUCTION_OPERATIONS_SOURCE_COMMIT,
      liveReceiptSha256: process.env.RV_PRODUCTION_OPERATIONS_LIVE_RECEIPT_SHA256,
      now: Date.now(),
    });
    verifyInboxIdentityCommitments(evidence.controlledInboxOtp.slots, [
      process.env.RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A,
      process.env.RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B,
    ], process.env.RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64);
    const canonicalAttestation = createCanonicalProductionOperationsAttestation(evidence, {
      keyId: PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
      witnessedAt: new Date().toISOString(),
      canonicalEvidence,
    });
    const signature = signProductionOperationsAttestation(
      canonicalAttestation,
      process.env.RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64,
    );
    process.stdout.write('PRODUCTION_OPERATIONS_ATTESTATION_BEGIN\n');
    process.stdout.write(`RV_PRODUCTION_OPERATIONS_ATTESTATION=${Buffer.from(canonicalAttestation, 'utf8').toString('base64url')}\n`);
    process.stdout.write(`RV_PRODUCTION_OPERATIONS_SIGNATURE=${signature}\n`);
    process.stdout.write('PRODUCTION_OPERATIONS_ATTESTATION_END\n');
    return 0;
  } catch {
    process.stderr.write('Production operations signer refused: protected evidence bundle is invalid.\n');
    return 1;
  }
}

export async function main() {
  try {
    return await runSigner();
  } finally {
    clearProductionOperationsProcessEnvironment();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
