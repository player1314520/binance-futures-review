import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const appRoot = path.join(repositoryRoot, 'app');
const requireFromApp = createRequire(path.join(appRoot, 'package.json'));
const viteBin = path.resolve(path.dirname(requireFromApp.resolve('vite')), '..', '..', 'bin', 'vite.js');

test('production-mode browser bundle contains no build-only gate or unused VITE sentinel', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-production-leak-'));
  const sentinels = {
    RV_PRODUCTION_LIVE_GATE_RECEIPT: 'sentinel-full-live-receipt-9f0b74',
    RV_PRODUCTION_LIVE_GATE_SIGNATURE: 'sentinel-live-signature-88c31a',
    RV_PRODUCTION_OPERATIONS_ATTESTATION: 'sentinel-full-ops-attestation-6e124d',
    RV_PRODUCTION_OPERATIONS_SIGNATURE: 'sentinel-ops-signature-c5921f',
    VITE_UNUSED_PRIVATE_SENTINEL: 'sentinel-unused-vite-value-b013e9',
  };
  try {
    const result = spawnSync(process.execPath, [viteBin,
      'build', '--mode', 'production',
      '--outDir', output, '--emptyOutDir',
    ], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, ...sentinels },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (/\.(?:js|css|html|map)$/i.test(entry.name)) files.push(target);
      }
    };
    visit(output);
    assert.ok(files.length > 0, 'production build emitted no browser artifacts');
    const bundle = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    for (const sentinel of Object.values(sentinels)) assert.doesNotMatch(bundle, new RegExp(sentinel));
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
