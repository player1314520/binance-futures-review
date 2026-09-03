import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  productionLiveContractSha256,
  resolveProductionContractFile,
} from '../app/production-live-contract.mjs';

function fixture(standard, override) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-contract-'));
  const standardRelative = 'supabase/migrations/current.sql';
  const overrideRelative = 'supabase/production-vault/migrations/current.sql';
  for (const [relativePath, value] of [
    [standardRelative, standard],
    [overrideRelative, override],
  ]) {
    if (value === null) continue;
    const target = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
  return { root, standardRelative, overrideRelative };
}

test('production contract resolver rejects divergent standard and isolated sources', (context) => {
  const divergent = fixture('select 1;\n', 'select 2;\n');
  context.after(() => fs.rmSync(divergent.root, { recursive: true, force: true }));
  assert.throws(() => resolveProductionContractFile(
    divergent.root,
    divergent.standardRelative,
    divergent.overrideRelative,
  ), /source divergence/);

  const identical = fixture('select 1;\n', 'select 1;\n');
  context.after(() => fs.rmSync(identical.root, { recursive: true, force: true }));
  assert.equal(resolveProductionContractFile(
    identical.root,
    identical.standardRelative,
    identical.overrideRelative,
  ), path.join(identical.root, ...identical.standardRelative.split('/')));
});

test('production build and live gate share one deterministic contract hash helper', (context) => {
  const sample = fixture('select 1;\n', null);
  context.after(() => fs.rmSync(sample.root, { recursive: true, force: true }));
  const actual = productionLiveContractSha256({
    repositoryRoot: sample.root,
    domain: 'rv-test/1',
    relativePaths: [sample.standardRelative],
  });
  const bytes = Buffer.from('select 1;\n');
  const expected = crypto.createHash('sha256')
    .update('rv-test/1\0')
    .update(sample.standardRelative).update('\0')
    .update(String(bytes.length)).update('\0')
    .update(crypto.createHash('sha256').update(bytes).digest('hex')).update('\0')
    .digest('hex');
  assert.equal(actual, expected);
});

test('production contract digest includes attestation, collector, runner, Vite and resolver surfaces', () => {
  const releaseConfig = fs.readFileSync(new URL('../app/src/lib/release-config.ts', import.meta.url), 'utf8');
  for (const relativePath of [
    'app/production-live-attestation.mjs',
    'app/production-live-contract.mjs',
    'app/vite.config.ts',
    'scripts/production-operations-evidence.mjs',
    'scripts/run-production-operations-attestation.mjs',
    'scripts/run-production-vault-live.mjs',
    'scripts/verify-production-control-plane.mjs',
    'supabase/migrations/20260829000100_production_vault.sql',
    'supabase/migrations/20260830000100_vault_objects_device_fkey_index.sql',
    'supabase/migrations/20260830000200_free_plan_admission_controls.sql',
    'supabase/migrations/20260830000300_status_fairness_and_admission_truth.sql',
    'supabase/migrations/20260830000400_close_status_lookup_admission_gap.sql',
    'tests/production-vault-live.spec.mjs',
  ]) assert.match(releaseConfig, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('runner and browser live receipt require the same ordered checks', () => {
  const releaseConfig = fs.readFileSync(new URL('../app/src/lib/release-config.ts', import.meta.url), 'utf8');
  const runner = fs.readFileSync(new URL('../scripts/run-production-vault-live.mjs', import.meta.url), 'utf8');
  const values = (source, name) => {
    const body = source.match(new RegExp(`${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]`))?.[1] ?? '';
    return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  };
  const browserChecks = values(releaseConfig, 'PRODUCTION_LIVE_GATE_CHECKS');
  const runnerChecks = values(runner, 'EXPECTED_CHECKS');
  assert.ok(browserChecks.length > 0, 'browser live checks were not found');
  assert.deepEqual(runnerChecks, browserChecks);
});
