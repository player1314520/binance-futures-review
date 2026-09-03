import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../scripts/run-production-operations-attestation.mjs', import.meta.url));
const module = await import('../scripts/run-production-operations-attestation.mjs');

function cleanEnvironment(overrides = {}) {
  const forbidden = new Set(module.PRODUCTION_OPERATIONS_FORBIDDEN_LIVE_SECRET_KEYS);
  return Object.fromEntries([
    ...Object.entries(process.env).filter(([key]) => !key.startsWith('RV_PRODUCTION_OPERATIONS_') && !forbidden.has(key)),
    ...Object.entries(overrides),
  ]);
}

function required(overrides = {}) {
  return {
    RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE: 'unread-protected-bundle',
    RV_PRODUCTION_OPERATIONS_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
    RV_PRODUCTION_OPERATIONS_APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
    RV_PRODUCTION_OPERATIONS_SOURCE_COMMIT: 'a'.repeat(40),
    RV_PRODUCTION_OPERATIONS_LIVE_RECEIPT_SHA256: 'b'.repeat(64),
    RV_PRODUCTION_OPERATIONS_SIGN_ACK: 'INDEPENDENT_OPERATOR_REVIEWED_PROTECTED_EVIDENCE',
    RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64: 'private-operations-marker-do-not-echo',
    RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
    RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A: 'private-a@example.test',
    RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B: 'private-b@example.test',
    ...overrides,
  };
}

test('independent operations signer rejects invalid custody material before reading evidence', () => {
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', env: cleanEnvironment(required()) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operations key is invalid/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-operations-marker|unread-protected-bundle/);
});

test('operations signer rejects shared live/Management/JWT secret scope without echoing it', () => {
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: cleanEnvironment(required({ RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN: 'management-secret-marker' })),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /share its process scope/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /management-secret-marker|private-operations-marker/);
});

test('operations signer cleanup independently covers required, sensitive, internal and forbidden inputs', () => {
  const independentlyRequiredSensitiveKeys = [
    'RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64',
    'RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64',
    'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A',
    'RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B',
  ];
  for (const key of independentlyRequiredSensitiveKeys) {
    assert.ok(module.PRODUCTION_OPERATIONS_REQUIRED_KEYS.includes(key), `${key} missing required set`);
    assert.ok(module.PRODUCTION_OPERATIONS_SENSITIVE_KEYS.includes(key), `${key} missing sensitive set`);
    assert.ok(module.PRODUCTION_OPERATIONS_CLEANUP_KEYS.includes(key), `${key} missing cleanup`);
  }
  const independentSets = [
    module.PRODUCTION_OPERATIONS_REQUIRED_KEYS,
    module.PRODUCTION_OPERATIONS_SENSITIVE_KEYS,
    module.PRODUCTION_OPERATIONS_INTERNAL_KEYS,
    module.PRODUCTION_OPERATIONS_FORBIDDEN_LIVE_SECRET_KEYS,
  ];
  for (const keys of independentSets) {
    for (const key of keys) assert.ok(module.PRODUCTION_OPERATIONS_CLEANUP_KEYS.includes(key), `${key} missing cleanup`);
  }
  const environment = Object.fromEntries(module.PRODUCTION_OPERATIONS_CLEANUP_KEYS.map((key) => [key, `marker-${key}`]));
  module.clearProductionOperationsProcessEnvironment(environment);
  assert.deepEqual(environment, {});
  const source = fs.readFileSync(runner, 'utf8');
  assert.doesNotMatch(source, /node:child_process|spawn(?:Sync)?\(/);
  assert.match(source, /verifyInboxIdentityCommitments\(evidence\.controlledInboxOtp\.slots/);
  assert.match(source, /finally\s*\{\s*clearProductionOperationsProcessEnvironment\(\)/s);
  assert.doesNotMatch(source, /console\.(?:log|error)|stdout\.write\([^\n]*INBOX_IDENTITY_[AB]/);
});
