import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ALLOWLIST_FORMAT,
  MANIFEST_NAME,
  exportPublicStaging,
  loadAllowlist,
  validateAllowlist,
  verifyStagedTree,
} from '../scripts/export-public-staging.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const CANDIDATE_MANIFEST_PATH = path.join(REPO, MANIFEST_NAME);
const IS_EXPORTED_CANDIDATE = fs.existsSync(CANDIDATE_MANIFEST_PATH);

function makeDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function fixture(t, overrides = {}) {
  const root = makeDirectory(t, 'rv-wp13-source-');
  const files = {
    'DISTRIBUTION.md': 'STATUS: not_distributed\n',
    'package.json': '{"name":"fixture","private":true,"license":"AGPL-3.0-only"}\n',
    'app/src/main.js': 'export const product = "2.0";\n',
    'frontend/engine.js': 'export const engine = "core";\n',
    ...overrides,
  };
  for (const [relativePath, contents] of Object.entries(files)) write(root, relativePath, contents);
  const allowlist = {
    format: ALLOWLIST_FORMAT,
    files: Object.keys(files).sort(),
    mappedFiles: [],
  };
  return { allowlist, root };
}

function emptyTarget(t) {
  const parent = makeDirectory(t, 'rv-wp13-target-parent-');
  const target = path.join(parent, 'public-staging');
  fs.mkdirSync(target);
  return target;
}

function exportNonRelease(options) {
  return exportPublicStaging({ ...options, mode: 'non-release-test' });
}

function materializedCandidate(t) {
  if (IS_EXPORTED_CANDIDATE) {
    const manifest = JSON.parse(fs.readFileSync(CANDIDATE_MANIFEST_PATH, 'utf8'));
    return { files: manifest.files.map((entry) => entry.path), target: REPO };
  }
  const target = emptyTarget(t);
  exportNonRelease({ sourceRoot: REPO, targetRoot: target });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
  return { files: manifest.files.map((entry) => entry.path), target };
}

function layoutPath(sourcePath, candidatePath) {
  return path.join(REPO, IS_EXPORTED_CANDIDATE ? candidatePath : sourcePath);
}

function treeFiles(root) {
  const files = [];
  const pending = [''];
  while (pending.length) {
    const relativeDirectory = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) pending.push(relativePath);
      else files.push(relativePath);
    }
  }
  return files.sort();
}

function policyOutputPaths(policy) {
  return [...policy.files, ...policy.mappedFiles.map((entry) => entry.target)].sort();
}

test('WP13 policy maps dedicated public metadata into a buildable root without private package drift', () => {
  const rawPolicy = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/public-staging-allowlist.json'), 'utf8'));
  assert.deepEqual(rawPolicy.mappedFiles, [
    { source: 'LICENSE', target: 'LICENSES/AGPL-3.0-only.txt' },
    { source: 'public-staging/CHANGELOG.md', target: 'CHANGELOG.md' },
    { source: 'public-staging/CONSTITUTION.md', target: 'app/CONSTITUTION.md' },
    { source: 'public-staging/DISTRIBUTION.md', target: 'DISTRIBUTION.md' },
    { source: 'public-staging/LICENSES-README.md', target: 'LICENSES/README.md' },
    { source: 'public-staging/PRODUCT-LINES.md', target: 'PRODUCT-LINES.md' },
    { source: 'public-staging/README.md', target: 'README.md' },
    { source: 'public-staging/RUNTIME-LICENSES.md', target: 'LICENSES/RUNTIME-DEPENDENCIES.md' },
    { source: 'public-staging/SUPPORT.md', target: 'SUPPORT.md' },
    { source: 'public-staging/THIRD_PARTY_NOTICES.md', target: 'THIRD_PARTY_NOTICES.md' },
    { source: 'public-staging/frontend-package.json', target: 'frontend/package.json' },
    { source: 'public-staging/landing.html', target: 'public-site/index.html' },
    { source: 'public-staging/package.json', target: 'package.json' },
    { source: 'public-staging/pages.yml', target: '.github/workflows/pages.yml' },
    { source: 'public-staging/pnpm-workspace.yaml', target: 'pnpm-workspace.yaml' },
    { source: 'public-staging/runtime-dependency-licenses.json', target: 'RUNTIME-DEPENDENCY-LICENSES.json' },
    { source: 'public-staging/sbom.spdx.json', target: 'sbom.spdx.json' },
    { source: 'public-staging/vercel.json', target: 'vercel.json' },
    {
      source: 'supabase/production-vault/migrations/20260829000100_production_vault.sql',
      target: 'supabase/migrations/20260829000100_production_vault.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
      target: 'supabase/migrations/20260830000100_vault_objects_device_fkey_index.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
      target: 'supabase/migrations/20260830000200_free_plan_admission_controls.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
      target: 'supabase/migrations/20260830000300_status_fairness_and_admission_truth.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
      target: 'supabase/migrations/20260830000400_close_status_lookup_admission_gap.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
      target: 'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
      target: 'supabase/migrations/20260831000200_restore_v2_lineage.sql',
    },
    {
      source: 'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
      target: 'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
    },
  ]);
  const policy = validateAllowlist(rawPolicy);
  const outputs = policyOutputPaths(policy);
  assert.equal(new Set(outputs).size, outputs.length);
  for (const required of [
    '.gitattributes',
    '.github/workflows/verify.yml',
    '.github/workflows/pages.yml',
    '.gitignore',
    'CHANGELOG.md',
    'frontend/engine.d.ts',
    'frontend/demo-data.js',
    'frontend/loopback-api.js',
    'frontend/net-position.js',
    'frontend/package.json',
    'frontend/runtime-client.js',
    'LICENSES/AGPL-3.0-only.txt',
    'LICENSES/README.md',
    'LICENSES/RUNTIME-DEPENDENCIES.md',
    'package.json',
    'pnpm-workspace.yaml',
    'PROMISE.md',
    'public-site/index.html',
    'README.md',
    'sbom.spdx.json',
    'scripts/public-candidate-gates.mjs',
    'tests/net-position.test.mjs',
    'tests/public-candidate-b8.test.mjs',
    'vercel.json',
  ]) assert.ok(outputs.includes(required), `missing buildable public output ${required}`);

  const publicChangelog = fs.readFileSync(path.join(REPO, 'public-staging/CHANGELOG.md'), 'utf8');
  assert.match(publicChangelog, /^## 2026-08-11·p0-quality-v2-rc1$/m);

  const publicPackage = JSON.parse(fs.readFileSync(path.join(REPO, 'public-staging/package.json'), 'utf8'));
  assert.equal(publicPackage.private, true);
  assert.equal(publicPackage.license, 'AGPL-3.0-only');
  assert.equal(publicPackage.scripts.build, 'pnpm --filter @rv/app build');
  assert.match(publicPackage.scripts.test, /tests\/legacy-review-export\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /tests\/net-position\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /tests\/public-candidate-b8\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /tests\/runtime-license-inventory\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /vitest run/);
  assert.match(publicPackage.scripts.verify, /pnpm typecheck/);
  assert.match(publicPackage.scripts.verify, /pnpm test:e2e/);
  assert.match(publicPackage.scripts['test:e2e'], /playwright\.public\.config\.ts/);
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(
    sourcePackage.scripts['test:production-operations-attestation'],
    'node scripts/run-production-operations-attestation.mjs',
  );
  assert.equal(
    publicPackage.scripts['test:production-operations-attestation'],
    sourcePackage.scripts['test:production-operations-attestation'],
  );
  assert.match(publicPackage.scripts.verify, /pnpm verify:candidate/);
  assert.equal(Object.hasOwn(publicPackage.scripts, 'deploy'), false);
  assert.deepEqual(publicPackage.devDependencies, JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).devDependencies);

  const enginePackage = JSON.parse(fs.readFileSync(path.join(REPO, 'public-staging/frontend-package.json'), 'utf8'));
  assert.deepEqual(enginePackage.exports, {
    '.': { types: './engine.d.ts', default: './engine.js' },
    './data-quality-v2': './data-quality-v2.js',
    './demo-data': './demo-data.js',
    './loopback-api': './loopback-api.js',
    './net-position': './net-position.js',
    './runtime-client': './runtime-client.js',
  });
  assert.equal(enginePackage.types, './engine.d.ts');
  assert.equal(enginePackage.private, true);
});

test('all public production APP_ORIGIN examples use the same dedicated non-GitHub origin', () => {
  const documents = [
    'docs/PRODUCTION-DEPLOYMENT.md',
    'supabase/functions/publish-vault-head/README.md',
  ];
  const origins = [];
  for (const relativePath of documents) {
    const text = fs.readFileSync(path.join(REPO, relativePath), 'utf8');
    const matches = [...text.matchAll(/APP_ORIGIN=(https:\/\/[^\s`]+)/g)].map((match) => match[1]);
    assert.ok(matches.length > 0, `${relativePath} must name the production APP_ORIGIN`);
    for (const origin of matches) {
      assert.doesNotMatch(origin, /(?:^|\.)github\.io(?:$|\/)/i);
      origins.push(origin);
    }
  }
  assert.deepEqual([...new Set(origins)], ['https://binance-futures-review-web.vercel.app']);
});

test('every staged Markdown local link closes and Constitution promise target exists', (t) => {
  const { files, target } = materializedCandidate(t);

  for (const relativeDocument of files.filter((file) => file.endsWith('.md'))) {
    const source = fs.readFileSync(path.join(target, relativeDocument), 'utf8');
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1].split('#', 1)[0];
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const linkedPath = path.resolve(path.dirname(path.join(target, relativeDocument)), href);
      assert.ok(fs.existsSync(linkedPath), `${relativeDocument} has missing local link ${href}`);
    }
  }

  const constitution = fs.readFileSync(path.join(target, 'app/CONSTITUTION.md'), 'utf8');
  assert.match(constitution, /\.\.\/PROMISE\.md/);
  assert.ok(fs.existsSync(path.join(target, 'PROMISE.md')));
});

test('public CI runs the exact three-OS verify contract without private or runtime paths', (t) => {
  const { target } = materializedCandidate(t);
  const workflow = fs.readFileSync(path.join(target, '.github/workflows/verify.yml'), 'utf8');
  const matrix = workflow.match(/^\s*os:\s*\[([^\]]+)\]\s*$/m)?.[1]
    .split(',')
    .map((value) => value.trim());

  assert.deepEqual(matrix, ['ubuntu-latest', 'windows-latest', 'macos-latest']);
  assert.match(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /^\s*pull_request_target:\s*$/m);
  assert.match(workflow, /^\s*- run: pnpm verify\s*$/m);
  assert.doesNotMatch(
    workflow,
    /runtime-data|desktop-kit|private-backups|frontend[\\/]workbench\.html|(?:^|[\\/])(?:strategy|supabase|report)(?:[\\/]|$)/im,
  );
  assert.doesNotMatch(workflow, /[A-Za-z]:[\\/]|\/(?:Users|home)\//);

  const externalActions = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)\s*(?:#\s*(.+))?$/gm)]
    .map(([, actionReference, versionComment]) => ({
      actionReference,
      versionComment: versionComment?.trim() ?? '',
    }));
  assert.deepEqual(externalActions, [
    {
      actionReference: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      versionComment: 'v4.4.0',
    },
    {
      actionReference: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
      versionComment: 'v4.4.0',
    },
    {
      actionReference: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      versionComment: 'v4.4.0',
    },
  ]);
  const checkoutBlock = workflow.match(
    /- uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262[^\n]*\n(?<withBlock>(?:\s{8,}.+\n)+)/u,
  )?.groups?.withBlock ?? '';
  assert.match(checkoutBlock, /^\s*with:\s*$/m);
  assert.match(checkoutBlock, /^\s*fetch-depth:\s*0\s*$/m);
  assert.match(checkoutBlock, /^\s*persist-credentials:\s*false\s*$/m);
  assert.match(
    checkoutBlock,
    /^\s*ref:\s*\$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\s*$/m,
  );
  const nestedValidSyntax = '    - name: cache\n      uses: actions/cache@v4\n';
  assert.equal(
    [...nestedValidSyntax.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)][0][1],
    'actions/cache@v4',
    'the scanner must see uses keys on a line after a named step',
  );
});

test('mapped metadata is copied byte-for-byte to its exact public destination', (t) => {
  const { root } = fixture(t);
  write(root, 'public/package.json', '{"name":"public","private":true,"license":"AGPL-3.0-only"}\n');
  const allowlist = {
    format: ALLOWLIST_FORMAT,
    files: ['DISTRIBUTION.md', 'app/src/main.js', 'frontend/engine.js'],
    mappedFiles: [{ source: 'public/package.json', target: 'package.json' }],
  };
  const target = emptyTarget(t);
  exportNonRelease({ sourceRoot: root, targetRoot: target, allowlist });
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), fs.readFileSync(path.join(root, 'public/package.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(target, 'public/package.json')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
  assert.deepEqual(manifest.files.map((entry) => entry.path), [
    'DISTRIBUTION.md',
    'app/src/main.js',
    'frontend/engine.js',
    'package.json',
  ]);
});

test('WP13 default allowlist is a narrow 2.0/core boundary with fail-closed governance', () => {
  const allowlist = loadAllowlist(path.join(REPO, 'scripts/public-staging-allowlist.json'));
  assert.deepEqual(allowlist.files, [...allowlist.files].sort());
  assert.equal(new Set(allowlist.files).size, allowlist.files.length);
  const outputs = policyOutputPaths(allowlist);
  assert.equal(outputs.length, 263, 'candidate allowlist must stay at the reviewed 263-file invite-beta boundary');
  for (const required of [
    'DISTRIBUTION.md',
    'LICENSE',
    'package.json',
    'app/package.json',
    'app/production-live-attestation.mjs',
    'app/production-live-contract.mjs',
    'app/invite-beta-attestation.mjs',
    'app/invite-beta-contract.mjs',
    'app/src/main.tsx',
    'app/src/navigation.test.ts',
    'app/src/navigation.ts',
    'app/src/store-vault.test.tsx',
    'app/src/components/WorkspacePanel.test.tsx',
    'app/src/components/WorkspacePanel.tsx',
    'app/src/components/LegacyMigrationPanel.test.tsx',
    'app/src/components/LegacyMigrationPanel.tsx',
    'app/src/lib/account-deletion-client.test.ts',
    'app/src/lib/account-deletion-client.ts',
    'app/src/lib/auth-context.test.tsx',
    'app/src/lib/auth-context.tsx',
    'app/src/lib/csp-policy.test.ts',
    'app/src/lib/csp-policy.ts',
    'app/src/lib/browser-restore-transaction.test.ts',
    'app/src/lib/browser-restore-transaction.ts',
    'app/src/lib/cloud-beta-client.ts',
    'app/src/lib/cloud-beta-connection.ts',
    'app/src/lib/cloud-beta-contract.ts',
    'app/src/lib/legacy-review-migration.test.ts',
    'app/src/lib/legacy-review-migration.ts',
    'app/src/lib/portable-backup.test.ts',
    'app/src/lib/portable-backup.ts',
    'app/src/lib/release-config.test.ts',
    'app/src/lib/release-config.ts',
    'app/src/lib/runtime-origin.test.ts',
    'app/src/lib/runtime-origin.ts',
    'app/src/lib/vault-crypto.test.ts',
    'app/src/lib/vault-crypto.ts',
    'app/src/lib/vault-repository.test.ts',
    'app/src/lib/vault-repository.ts',
    'app/src/lib/vault-signing.test.ts',
    'app/src/lib/vault-signing.ts',
    'app/src/lib/workspace-vault-service.test.ts',
    'app/src/lib/workspace-vault-service.ts',
    'app/src/views/AccountView.test.tsx',
    'app/src/views/AccountView.tsx',
    'app/src/views/ReportsView.test.tsx',
    'app/src/views/ReportsView.tsx',
    'app/src/views/ReviewLoopView.test.tsx',
    'app/src/views/ReviewLoopView.tsx',
    'app/src/views/WorkbenchView.tsx',
    'app/src/views/WorkbenchView.test.tsx',
    'scripts/run-production-vault-live.mjs',
    'scripts/verify-production-control-plane.mjs',
    'scripts/production-operations-evidence.mjs',
    'scripts/run-production-operations-attestation.mjs',
    'scripts/verify-production-deployment.mjs',
    'docs/INVITE-BETA-BACKEND.md',
    'shared/legacy-review-export.d.ts',
    'shared/legacy-review-export.js',
    'supabase/functions/binance-beta/archive.mjs',
    'supabase/functions/binance-beta/index.ts',
    'supabase/functions/binance-beta/ledger.mjs',
    'supabase/functions/binance-beta/runtime.mjs',
    'supabase/functions/binance-beta/trade-projector.mjs',
    'supabase/functions/beta-operations/index.ts',
    'supabase/functions/delete-account/r2-journal.mjs',
    'supabase/functions/restore-v2/index.ts',
    'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
    'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
    'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
    'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
    'supabase/migrations/20260831000200_restore_v2_lineage.sql',
    'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
    'tests/beta-operations-backend.test.mjs',
    'tests/binance-beta-ledger.test.mjs',
    'tests/binance-beta-trade-projector.test.mjs',
    'tests/invite-beta-release-contract.test.mjs',
    'tests/public-backend-completeness.test.mjs',
    'tests/restore-v2-core.test.mjs',
    'tests/restore-v2-handler.test.mjs',
    'tests/restore-v2-migration-contract.test.mjs',
    'tests/rv2-capacity-observability.test.mjs',
    'tests/rv2-data-plane-schema.test.mjs',
    'tests/rv2-review-loop-schema.test.mjs',
    'tests/production-deployment-smoke.test.mjs',
    'app/src/views/TodayView.tsx',
    'app/src/views/DataView.test.tsx',
    'app/src/views/DataView.tsx',
    'frontend/engine.js',
    'frontend/legacy-review-export.d.ts',
    'frontend/legacy-review-export.js',
    'frontend/demo-data.js',
    'frontend/net-position.js',
    'docs/PRODUCTION-DEPLOYMENT.md',
    'supabase/config.toml',
    'supabase/functions/delete-account/index.ts',
    'supabase/functions/publish-vault-head/index.ts',
    'supabase/production-vault/migrations/20260829000100_production_vault.sql',
    'supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
    'supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
    'supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
    'supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
    'supabase/templates/magic-link.html',
    'tests/account-deletion-edge.test.mjs',
    'tests/legacy-review-export.test.mjs',
    'tests/production-build-secret-leak.test.mjs',
    'tests/production-control-plane.test.mjs',
    'tests/production-live-attestation.test.mjs',
    'tests/production-operations-evidence.test.mjs',
    'tests/production-operations-runner.test.mjs',
    'tests/production-live-contract.test.mjs',
    'tests/production-vault-live-runner.test.mjs',
    'tests/production-vault-live.spec.mjs',
    'tests/production-vault-schema.test.mjs',
    'tests/vault-publish-edge.test.mjs',
    'RUNTIME-DEPENDENCY-LICENSES.json',
    'public-site/index.html',
    'vercel.json',
  ]) assert.ok(outputs.includes(required), `missing required public file ${required}`);

  const productionAppFiles = treeFiles(path.join(REPO, 'app'))
    .map((relativePath) => `app/${relativePath}`)
    .filter((relativePath) => (
      relativePath !== 'app/CONSTITUTION.md'
      && !relativePath.startsWith('app/dist/')
      && !relativePath.startsWith('app/node_modules/')
      && !relativePath.endsWith('.tsbuildinfo')
    ));
  assert.deepEqual(
    outputs.filter((relativePath) => relativePath.startsWith('app/')).sort(),
    [...productionAppFiles, 'app/CONSTITUTION.md'].sort(),
    'the candidate must include every reviewed app source/config/test file and no app build output',
  );

  const joined = [
    ...allowlist.files,
    ...allowlist.mappedFiles.flatMap(({ source, target }) => [source, target]),
  ].join('\n');
  assert.doesNotMatch(joined, /(?:^|\/)\.git(?:\/|$)/m);
  assert.doesNotMatch(joined, /(?:^|\/)\.env(?:\.|\/|$)/mi);
  assert.doesNotMatch(joined, /(?:^|\/)app\/dist(?:\/|$)/m);
  assert.doesNotMatch(joined, /(?:^|\/)(?:fixtures?|golden|runtime-data|desktop-kit)(?:\/|$)/mi);
  assert.doesNotMatch(joined, /(?:^|\/)(?:report|strategy|baselines)(?:\/|$)/m);
  assert.deepEqual(
    outputs.filter((relativePath) => relativePath.startsWith('docs/')).sort(),
    ['docs/INVITE-BETA-BACKEND.md', 'docs/PRODUCTION-DEPLOYMENT.md', 'docs/PUBLIC-STAGING.md'],
  );
  assert.deepEqual(
    outputs.filter((relativePath) => relativePath.startsWith('supabase/')).sort(),
    [
    'supabase/config.toml',
      'supabase/functions/beta-operations/README.md',
      'supabase/functions/beta-operations/core.mjs',
      'supabase/functions/beta-operations/handler.mjs',
      'supabase/functions/beta-operations/index.ts',
      'supabase/functions/beta-operations/runtime.mjs',
    'supabase/functions/binance-beta/README.md',
    'supabase/functions/binance-beta/archive.mjs',
    'supabase/functions/binance-beta/binance-client.mjs',
      'supabase/functions/binance-beta/crypto.mjs',
      'supabase/functions/binance-beta/handler.mjs',
      'supabase/functions/binance-beta/index.ts',
      'supabase/functions/binance-beta/internal-handler.mjs',
      'supabase/functions/binance-beta/ledger.mjs',
      'supabase/functions/binance-beta/runtime.mjs',
      'supabase/functions/binance-beta/trade-projector.mjs',
      'supabase/functions/delete-account/README.md',
      'supabase/functions/delete-account/handler.mjs',
      'supabase/functions/delete-account/index.ts',
      'supabase/functions/delete-account/protocol.mjs',
      'supabase/functions/delete-account/r2-journal.mjs',
      'supabase/functions/publish-vault-head/README.md',
      'supabase/functions/publish-vault-head/handler.mjs',
      'supabase/functions/publish-vault-head/index.ts',
      'supabase/functions/publish-vault-head/protocol.mjs',
      'supabase/functions/restore-v2/README.md',
      'supabase/functions/restore-v2/core.mjs',
      'supabase/functions/restore-v2/handler.mjs',
      'supabase/functions/restore-v2/index.ts',
      'supabase/functions/restore-v2/runtime.mjs',
      'supabase/migrations/20260829000100_production_vault.sql',
      'supabase/migrations/20260830000100_vault_objects_device_fkey_index.sql',
      'supabase/migrations/20260830000200_free_plan_admission_controls.sql',
      'supabase/migrations/20260830000300_status_fairness_and_admission_truth.sql',
      'supabase/migrations/20260830000400_close_status_lookup_admission_gap.sql',
      'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
      'supabase/migrations/20260831000200_restore_v2_lineage.sql',
      'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
      'supabase/production-vault/README.md',
      'supabase/production-vault/migrations/20260829000100_production_vault.sql',
      'supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
      'supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
      'supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
      'supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
      'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
      'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
      'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
      'supabase/templates/magic-link.html',
    ],
  );
  assert.doesNotMatch(
    joined,
    /frontend\/(?!data-quality-v2\.js$|demo-data\.js$|engine\.d\.ts$|engine\.js$|legacy-review-export\.d\.ts$|legacy-review-export\.js$|loopback-api\.js$|net-position\.js$|package\.json$|runtime-client\.js$)/m,
  );

  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).private, true);
  assert.match(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8'), /^\*\.tsbuildinfo$/m);
  const distribution = fs.readFileSync(path.join(REPO, 'DISTRIBUTION.md'), 'utf8');
  const manifestPath = path.join(REPO, MANIFEST_NAME);
  const isExportedCandidate = fs.existsSync(manifestPath);
  const expectedDistributionStatus = isExportedCandidate
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).distributionStatus
    : 'not_distributed';
  assert.equal(
    distribution.match(/^STATUS: .+$/m)?.[0],
    `STATUS: ${expectedDistributionStatus}`,
  );
  if (expectedDistributionStatus === 'distributed') {
    assert.match(distribution, /^PUBLIC_URL: https:\/\/[^\s]+$/m);
  }

  const docs = fs.readFileSync(path.join(REPO, 'docs/PUBLIC-STAGING.md'), 'utf8');
  const boundaries = docs.split(/\r?\n/).filter((line) => /^\d+\./.test(line));
  assert.ok(boundaries.length >= 3, 'documentation must state at least three honest boundaries');
  assert.match(docs, /does not publish|does not create a public repository/i);
  assert.match(docs, /Git history/i);
  assert.match(docs, /not_distributed/);
  assert.match(docs, /Windows clean-staging/i);
  assert.match(docs, /pnpm install --frozen-lockfile --offline/);
  assert.match(docs, /Linux.*macOS.*not (?:run|verified)/is);
});

test('Classic exporter stays in the neutral shared layer instead of coupling product shells', () => {
  const panel = fs.readFileSync(
    path.join(REPO, 'app/src/components/LegacyMigrationPanel.tsx'),
    'utf8',
  );
  const compatibilityEntry = fs.readFileSync(
    path.join(REPO, 'frontend/legacy-review-export.js'),
    'utf8',
  );
  const shared = fs.readFileSync(path.join(REPO, 'shared/legacy-review-export.js'), 'utf8');
  assert.doesNotMatch(panel, /\.\.\/\.\.\/\.\.\/frontend\//);
  assert.match(panel, /\.\.\/\.\.\/\.\.\/shared\/legacy-review-export\.js/);
  assert.match(compatibilityEntry, /export \* from '\.\.\/shared\/legacy-review-export\.js'/);
  assert.match(shared, /export function serializeClassicReviewExport/);
  assert.doesNotMatch(shared, /(?:frontend|app|report)\//);
});

test('public migration materialization is byte-identical to the isolated production source', (t) => {
  const { target } = materializedCandidate(t);
  for (const filename of [
    '20260829000100_production_vault.sql',
    '20260830000100_vault_objects_device_fkey_index.sql',
    '20260830000200_free_plan_admission_controls.sql',
    '20260830000300_status_fairness_and_admission_truth.sql',
    '20260830000400_close_status_lookup_admission_gap.sql',
    '20260831000100_invite_beta_rv2_data_plane.sql',
    '20260831000200_restore_v2_lineage.sql',
    '20260831000300_invite_beta_capacity_observability.sql',
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(target, `supabase/migrations/${filename}`)),
      fs.readFileSync(path.join(target, `supabase/production-vault/migrations/${filename}`)),
    );
  }
});

test('public production gate exports active fixed keys and fails closed on invalid custody proof', async (t) => {
  const { files, target } = materializedCandidate(t);
  for (const required of [
    'app/production-live-attestation.mjs',
    'app/production-live-contract.mjs',
    'app/src/lib/release-config.test.ts',
    'app/src/lib/release-config.ts',
    'app/vite.config.ts',
    'docs/PRODUCTION-DEPLOYMENT.md',
    'scripts/production-operations-evidence.mjs',
    'scripts/run-production-operations-attestation.mjs',
    'scripts/run-production-vault-live.mjs',
    'tests/production-live-attestation.test.mjs',
    'tests/production-build-secret-leak.test.mjs',
    'tests/production-live-contract.test.mjs',
    'tests/production-operations-evidence.test.mjs',
    'tests/production-operations-runner.test.mjs',
    'tests/production-vault-live-runner.test.mjs',
    'tests/production-vault-live.spec.mjs',
  ]) assert.ok(files.includes(required), `signed production gate is missing ${required}`);

  const attestationPath = path.join(target, 'app/production-live-attestation.mjs');
  const attestation = await import(`${pathToFileURL(attestationPath).href}?wp13=${crypto.randomUUID()}`);
  assert.equal(attestation.PRODUCTION_LIVE_ATTESTATION_KEY_STATUS, 'active');
  assert.match(attestation.PRODUCTION_LIVE_ATTESTATION_KEY_ID, /^rv-production-[a-z0-9-]{8,80}$/);
  assert.doesNotThrow(() => attestation.assertProductionLiveAttestationProvisioned());
  assert.equal(
    attestation.verifyProductionLiveGateAttestation('{}', 'A'.repeat(86)),
    false,
    'an invalid live signature must never authorize production',
  );
  assert.equal(attestation.PRODUCTION_OPERATIONS_ATTESTATION_KEY_STATUS, 'active');
  assert.match(attestation.PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID, /^rv-operations-[a-z0-9-]{8,80}$/);
  assert.notEqual(
    attestation.PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
    attestation.PRODUCTION_LIVE_ATTESTATION_KEY_ID,
  );
  assert.notEqual(
    attestation.PRODUCTION_OPERATIONS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    attestation.PRODUCTION_LIVE_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    'the live gate and independent operations signer must use different fixed public keys',
  );
  assert.doesNotThrow(() => attestation.assertProductionOperationsAttestationProvisioned());
  assert.equal(
    attestation.verifyProductionOperationsAttestation('{}', 'A'.repeat(86)),
    false,
    'an invalid operations signature must never authorize production',
  );

  const releaseConfig = fs.readFileSync(path.join(target, 'app/src/lib/release-config.ts'), 'utf8');
  const releaseConfigTest = fs.readFileSync(path.join(target, 'app/src/lib/release-config.test.ts'), 'utf8');
  const viteConfig = fs.readFileSync(path.join(target, 'app/vite.config.ts'), 'utf8');
  const runner = fs.readFileSync(path.join(target, 'scripts/run-production-vault-live.mjs'), 'utf8');
  const operationsSigner = fs.readFileSync(path.join(target, 'scripts/run-production-operations-attestation.mjs'), 'utf8');
  const liveSpec = fs.readFileSync(path.join(target, 'tests/production-vault-live.spec.mjs'), 'utf8');
  const deploymentDocs = fs.readFileSync(path.join(target, 'docs/PRODUCTION-DEPLOYMENT.md'), 'utf8');
  const publicPackage = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(
    publicPackage.scripts['test:production-operations-attestation'],
    'node scripts/run-production-operations-attestation.mjs',
  );
  assert.ok(files.includes('scripts/run-production-operations-attestation.mjs'));

  const signerResult = spawnSync(
    process.execPath,
    [path.join(target, 'scripts/run-production-operations-attestation.mjs')],
    {
      cwd: target,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RV_'))),
        RV_PRODUCTION_OPERATIONS_EVIDENCE_FILE: path.join(target, 'protected-evidence-not-present.json'),
        RV_PRODUCTION_OPERATIONS_EXPECTED_PROJECT_REF: 'abcdefghijklmnopqrst',
        RV_PRODUCTION_OPERATIONS_APP_ORIGIN: 'https://binance-futures-review-web.vercel.app',
        RV_PRODUCTION_OPERATIONS_SOURCE_COMMIT: 'a'.repeat(40),
        RV_PRODUCTION_OPERATIONS_LIVE_RECEIPT_SHA256: 'b'.repeat(64),
        RV_PRODUCTION_OPERATIONS_SIGN_ACK: 'INDEPENDENT_OPERATOR_REVIEWED_PROTECTED_EVIDENCE',
        RV_PRODUCTION_OPERATIONS_ATTESTATION_PRIVATE_KEY_B64: 'private-test-marker-must-not-echo',
        RV_PRODUCTION_OPERATIONS_INBOX_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
        RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_A: 'slot-a@example.invalid',
        RV_PRODUCTION_OPERATIONS_INBOX_IDENTITY_B: 'slot-b@example.invalid',
      },
    },
  );
  assert.equal(signerResult.error, undefined, 'the exported operations signer must be executable');
  assert.equal(signerResult.status, 1, 'the exported signer must fail closed on invalid custody material');
  assert.match(`${signerResult.stdout}\n${signerResult.stderr}`, /operations key is invalid/i);
  assert.doesNotMatch(
    `${signerResult.stdout}\n${signerResult.stderr}`,
    /ERR_PNPM_NO_SCRIPT|MODULE_NOT_FOUND|private-test-marker/,
  );

  assert.match(releaseConfig, /rv-production-live-gate-receipt\/4/);
  assert.match(releaseConfig, /rv-production-operations-attestation\/3/);
  assert.match(releaseConfig, /manualReleaseBlockers[^\n]+not-evaluated-by-live-gate/);
  assert.match(releaseConfig, /RV_PRODUCTION_LIVE_GATE_SIGNATURE/);
  assert.match(releaseConfig, /verifyReceiptAttestation\(receipt\.canonicalReceipt, signature\)/);
  assert.match(releaseConfig, /RV_PRODUCTION_OPERATIONS_ATTESTATION/);
  assert.match(releaseConfig, /RV_PRODUCTION_OPERATIONS_SIGNATURE/);
  assert.match(
    releaseConfig,
    /verifyOperationsAttestation\(\s*operations\.canonicalAttestation,\s*operationsSignature/s,
  );
  assert.match(releaseConfig, /RV_PRODUCTION_LIVE_GATE_RECEIPT_SHA/);
  assert.match(releaseConfig, /SHA-only live gate[^'\n]*\u5df2\u7981\u7528/u);
  assert.doesNotMatch(
    releaseConfig,
    /VITE_(?:RATE_LIMITS|BILLING_ALERTS|MONITORING|TWO_INBOX_OTP)_OK/,
    'ordinary Vite self-reported flags must not participate in the production gate',
  );
  assert.match(releaseConfigTest, /does not accept ordinary Vite self-reported operations flags/);
  for (const forbiddenSubstitute of [
    'VITE_RATE_LIMITS_OK',
    'VITE_BILLING_ALERTS_OK',
    'VITE_MONITORING_OK',
    'VITE_TWO_INBOX_OTP_OK',
  ]) assert.match(releaseConfigTest, new RegExp(forbiddenSubstitute));
  assert.match(viteConfig, /verifyProductionLiveGateAttestation/);
  assert.match(viteConfig, /expectedAttestationKeyId:\s*PRODUCTION_LIVE_ATTESTATION_KEY_ID/);
  assert.match(viteConfig, /verifyProductionOperationsAttestation/);
  assert.match(viteConfig, /expectedOperationsAttestationKeyId:\s*PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID/);
  assert.match(viteConfig, /verifyOperationsAttestation:\s*verifyProductionOperationsAttestation/);
  assert.doesNotMatch(viteConfig, /process\.env\.[A-Z0-9_]*ATTESTATION[A-Z0-9_]*/);

  const forbiddenBrowserGateVariable = /VITE_PRODUCTION_(?:LIVE_GATE_(?:RECEIPT(?:_SHA)?|SIGNATURE)|OPERATIONS_(?:ATTESTATION|SIGNATURE))/;
  for (const [label, source] of [
    ['release config', releaseConfig],
    ['live runner', runner],
    ['operations signer', operationsSigner],
    ['deployment documentation', deploymentDocs],
  ]) assert.doesNotMatch(source, forbiddenBrowserGateVariable, `${label} still names a browser-exposed gate variable`);

  assert.match(runner, /RECEIPT_FORMAT = 'rv-production-live-gate-receipt\/4'/);
  assert.match(runner, /manualReleaseBlockers !== 'not-evaluated-by-live-gate'/);
  assert.match(liveSpec, /manualReleaseBlockers:\s*'not-evaluated-by-live-gate'/);
  assert.match(runner, /RV_PRODUCTION_LIVE_GATE_RECEIPT=/);
  assert.match(runner, /RV_PRODUCTION_LIVE_GATE_SIGNATURE=/);
  assert.doesNotMatch(runner, /RV_PRODUCTION_LIVE_GATE_RECEIPT_SHA=/);
  assert.doesNotMatch(runner, /RV_PRODUCTION_OPERATIONS_(?:ATTESTATION|SIGNATURE)=/);
  assert.match(operationsSigner, /RV_PRODUCTION_OPERATIONS_ATTESTATION=/);
  assert.match(operationsSigner, /RV_PRODUCTION_OPERATIONS_SIGNATURE=/);
  assert.match(deploymentDocs, /independent operations signature/i);
  assert.match(deploymentDocs, /manualReleaseBlockers: not-evaluated-by-live-gate/);
  assert.match(publicPackage.scripts.test, /tests\/production-live-attestation\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /tests\/production-build-secret-leak\.test\.mjs/);
  assert.match(publicPackage.scripts.test, /tests\/production-vault-live-runner\.test\.mjs/);
});

test('Pages replaces the shared-origin demo with a verified no-data landing only', () => {
  const workflow = fs.readFileSync(layoutPath('public-staging/pages.yml', '.github/workflows/pages.yml'), 'utf8');
  const landing = fs.readFileSync(layoutPath('public-staging/landing.html', 'public-site/index.html'), 'utf8');

  assert.match(workflow, /^\s*- run: pnpm verify\s*$/m);
  assert.match(workflow, /^\s*- run: pnpm verify:history\s*$/m);
  assert.match(workflow, /^\s*PRODUCTION_APP_URL:\s*\$\{\{ vars\.PRODUCTION_APP_URL \}\}\s*$/m);
  assert.match(workflow, /never shared github\.io/);
  assert.match(workflow, /landing-only-no-data/);
  assert.match(workflow, /localStorage\|sessionStorage\|indexedDB/);
  assert.match(workflow, /connect-src 'none'/);
  assert.match(workflow, /path\.join\('pages-dist', '\.nojekyll'\)/);
  assert.match(workflow, /path\.join\('pages-dist', 'release\.json'\)/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /path:\s*pages-dist/);

  assert.doesNotMatch(landing, /<script\b|<input\b|<form\b|<iframe\b/i);
  assert.doesNotMatch(landing, /localStorage|sessionStorage|indexedDB|fetch\s*\(|XMLHttpRequest|WebSocket/i);
  assert.match(landing, /__PRODUCTION_APP_URL__/);
  assert.match(landing, /connect-src 'none'/);

  assert.doesNotMatch(workflow, /VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(workflow, /pnpm test:production-vault-live/);
  assert.doesNotMatch(workflow, /^\s*(?:VITE_)?SUPABASE_SERVICE_ROLE(?:_KEY)?:/mi);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.[^}]*SUPABASE/i);

  const externalActions = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)\s*(?:#\s*(.+))?$/gm)]
    .map(([, actionReference, versionComment]) => ({
      actionReference,
      versionComment: versionComment?.trim() ?? '',
    }));
  assert.deepEqual(externalActions, [
    {
      actionReference: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      versionComment: 'v4.4.0',
    },
    {
      actionReference: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
      versionComment: 'v4.4.0',
    },
    {
      actionReference: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      versionComment: 'v4.4.0',
    },
    {
      actionReference: 'actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b',
      versionComment: 'v5',
    },
    {
      actionReference: 'actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b',
      versionComment: 'v4',
    },
    {
      actionReference: 'actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e',
      versionComment: 'v4',
    },
  ]);
});

test('Pages installs Chromium before running the candidate verification chain', () => {
  const workflow = fs.readFileSync(layoutPath('public-staging/pages.yml', '.github/workflows/pages.yml'), 'utf8');
  const installIndex = workflow.indexOf('pnpm exec playwright install --with-deps chromium');
  const verifyIndex = workflow.indexOf('- run: pnpm verify');

  assert.ok(installIndex >= 0, 'Pages must install the Playwright Chromium binary');
  assert.ok(verifyIndex >= 0, 'Pages must run the candidate verification chain');
  assert.ok(installIndex < verifyIndex, 'Chromium installation must happen before candidate verification');
});

test('Vercel candidate builds the authenticated app on a dedicated origin with response-header defenses', () => {
  const config = JSON.parse(fs.readFileSync(layoutPath('public-staging/vercel.json', 'vercel.json'), 'utf8'));
  assert.equal(config.installCommand, 'pnpm install --frozen-lockfile');
  assert.equal(config.buildCommand, 'pnpm --filter @rv/app build');
  assert.equal(config.outputDirectory, 'app/dist');
  const headers = config.headers.find((entry) => entry.source === '/(.*)')?.headers ?? [];
  const values = new Map(headers.map((entry) => [entry.key.toLowerCase(), entry.value]));
  assert.equal(values.get('content-security-policy'), "frame-ancestors 'none';");
  assert.equal(values.get('x-frame-options'), 'DENY');
  assert.equal(values.get('x-content-type-options'), 'nosniff');
  assert.equal(values.get('referrer-policy'), 'no-referrer');
  assert.equal(values.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(values.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(values.get('permissions-policy') ?? '', /camera=\(\).*microphone=\(\)/);
});

test('export copies only allowlisted current bytes and creates a deterministic manifest', (t) => {
  const { root, allowlist } = fixture(t);
  write(root, '.git/config', '[remote "origin"]\nurl = private\n');
  write(root, 'frontend/workbench.html', 'private desktop shell\n');
  write(root, 'runtime-data/account.json', `{"key":"${'sk-' + 'x'.repeat(32)}"}\n`);

  const firstTarget = emptyTarget(t);
  const secondTarget = emptyTarget(t);
  const first = exportNonRelease({ sourceRoot: root, targetRoot: firstTarget, allowlist });
  const second = exportNonRelease({ sourceRoot: root, targetRoot: secondTarget, allowlist });

  const expectedFiles = [...policyOutputPaths(allowlist), MANIFEST_NAME].sort();
  assert.deepEqual(treeFiles(firstTarget), expectedFiles);
  assert.deepEqual(treeFiles(secondTarget), expectedFiles);
  assert.deepEqual(fs.readFileSync(path.join(firstTarget, MANIFEST_NAME)), fs.readFileSync(path.join(secondTarget, MANIFEST_NAME)));
  assert.equal(first.manifestSha256, second.manifestSha256);

  const manifestRaw = fs.readFileSync(path.join(firstTarget, MANIFEST_NAME), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.format, 'rv-public-staging-manifest/1');
  assert.equal(manifest.distributionStatus, 'not_distributed');
  assert.deepEqual(manifest.files.map((entry) => entry.path), policyOutputPaths(allowlist));
  assert.doesNotMatch(manifestRaw, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.doesNotMatch(manifestRaw, /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\.git|sk-[A-Za-z0-9_-]{20,})/);
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(firstTarget, entry.path));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
});

test('export rejects traversal, private surfaces, credentials, and unknown allowlist fields', (t) => {
  const { root, allowlist } = fixture(t);
  const withFile = (relativePath) => ({
    ...allowlist,
    files: [...allowlist.files, relativePath].sort(),
  });
  const cases = [
    withFile('../escape.txt'),
    withFile('frontend/workbench.html'),
    withFile('scripts/desktop-kit/START.bat'),
    withFile('tests/fixtures/private.json'),
    withFile('.env.production'),
    withFile('app/runtime-data/cache.json'),
    withFile('app/node_modules/package.json'),
    withFile('app/blob.bin'),
    withFile('docs/private-operations.md'),
    withFile('supabase/migrations/legacy.sql'),
    { ...allowlist, unexpected: true },
  ];
  for (const candidate of cases) {
    const target = emptyTarget(t);
    assert.throws(
      () => validateAllowlist(candidate),
      /allowlist|forbidden|unsafe|unknown/i,
    );
    assert.deepEqual(fs.readdirSync(target), []);
  }
});

test('export rejects a non-empty or unsafe target', (t) => {
  const { root, allowlist } = fixture(t);
  const nonEmpty = emptyTarget(t);
  write(nonEmpty, 'keep.txt', 'owned by caller\n');
  assert.throws(() => exportNonRelease({ sourceRoot: root, targetRoot: nonEmpty, allowlist }), /empty/i);
  assert.equal(fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8'), 'owned by caller\n');
  assert.throws(() => exportNonRelease({ sourceRoot: root, targetRoot: root, allowlist }), /target|overlap|unsafe/i);
  assert.throws(() => exportNonRelease({ sourceRoot: root, targetRoot: 'relative-staging', allowlist }), /absolute/i);
  assert.throws(() => exportNonRelease({ sourceRoot: root, targetRoot: path.parse(root).root, allowlist }), /root|unsafe/i);
});

test('export rejects symlink or reparse-point source paths and non-regular sources', (t) => {
  const { root } = fixture(t);
  const linkedContents = makeDirectory(t, 'rv-wp13-linked-');
  write(linkedContents, 'main.js', 'export default 1;\n');
  const linkedPath = path.join(root, 'linked-app');
  fs.symlinkSync(linkedContents, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedAllowlist = {
    format: ALLOWLIST_FORMAT,
    files: ['DISTRIBUTION.md', 'linked-app/main.js', 'package.json'],
    mappedFiles: [],
  };
  assert.throws(
    () => exportNonRelease({ sourceRoot: root, targetRoot: emptyTarget(t), allowlist: linkedAllowlist }),
    /symbolic|reparse|link/i,
  );

  fs.mkdirSync(path.join(root, 'not-a-file.json'));
  const nonRegularAllowlist = {
    format: ALLOWLIST_FORMAT,
    files: ['DISTRIBUTION.md', 'not-a-file.json', 'package.json'],
    mappedFiles: [],
  };
  assert.throws(
    () => exportNonRelease({ sourceRoot: root, targetRoot: emptyTarget(t), allowlist: nonRegularAllowlist }),
    /regular file/i,
  );
});

test('privacy failure is fail-closed and leaves the explicit target empty', (t) => {
  const secret = `sk-${'q'.repeat(32)}`;
  const { root, allowlist } = fixture(t, { 'app/src/leak.js': `export const token = "${secret}";\n` });
  const target = emptyTarget(t);
  assert.throws(
    () => exportNonRelease({ sourceRoot: root, targetRoot: target, allowlist }),
    /privacy scan failed/i,
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test('export rejects an embedded allowlist that does not match the applied policy', (t) => {
  const embedded = `${JSON.stringify({
    format: ALLOWLIST_FORMAT,
    files: ['DISTRIBUTION.md', 'package.json'],
    mappedFiles: [],
  }, null, 2)}\n`;
  const { root, allowlist } = fixture(t, { 'scripts/public-staging-allowlist.json': embedded });
  assert.throws(
    () => exportNonRelease({ sourceRoot: root, targetRoot: emptyTarget(t), allowlist }),
    /embedded allowlist|policy/i,
  );
});

test('staged-tree verifier rejects unknown files, links, and non-regular entries', (t) => {
  const root = makeDirectory(t, 'rv-wp13-verify-');
  write(root, 'known.txt', 'known\n');
  write(root, 'unknown.txt', 'unknown\n');
  assert.throws(() => verifyStagedTree(root, ['known.txt']), /unknown|exact/i);

  fs.unlinkSync(path.join(root, 'unknown.txt'));
  fs.mkdirSync(path.join(root, 'unknown-empty-directory'));
  assert.throws(() => verifyStagedTree(root, ['known.txt']), /unknown|exact/i);
  fs.rmdirSync(path.join(root, 'unknown-empty-directory'));

  const external = path.join(makeDirectory(t, 'rv-wp13-external-'), 'external.txt');
  fs.writeFileSync(external, 'external\n');
  try {
    fs.symlinkSync(external, path.join(root, 'linked.txt'), 'file');
    assert.throws(() => verifyStagedTree(root, ['known.txt', 'linked.txt']), /symbolic|reparse|regular/i);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});
