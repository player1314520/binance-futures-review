import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWLIST_FORMAT,
  MANIFEST_NAME,
  exportPublicStaging,
} from '../scripts/export-public-staging.mjs';
import {
  generatePublicCompliance,
  scanCandidateHistory,
  verifyPublicCompliance,
  verifyPublicCandidate,
  writePublicCompliance,
} from '../scripts/public-candidate-gates.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.realpathSync(os.tmpdir());
const RELEASE_NAME = 'player1314520';
const RELEASE_EMAIL = '168609221+player1314520@users.noreply.github.com';
const IS_EXPORTED_CANDIDATE = fs.existsSync(path.join(REPO, MANIFEST_NAME));

function makeDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function sourceFixture(t) {
  const root = makeDirectory(t, 'rv-b8-source-');
  const files = {
    'DISTRIBUTION.md': 'STATUS: not_distributed\n',
    'package.json': JSON.stringify({
      name: 'private-source',
      private: true,
      license: 'AGPL-3.0-only',
      packageManager: 'pnpm@10.30.3',
    }),
    'app/main.js': 'export const app = true;\n',
  };
  for (const [relativePath, contents] of Object.entries(files)) write(root, relativePath, contents);
  return {
    root,
    allowlist: {
      format: ALLOWLIST_FORMAT,
      files: Object.keys(files).sort(),
      mappedFiles: [],
    },
  };
}

function targetFixture(t) {
  const root = makeDirectory(t, 'rv-b8-target-parent-');
  const target = path.join(root, 'candidate');
  fs.mkdirSync(target);
  return target;
}

function git(root, args, options = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${String(result.stderr)}`);
  return result.stdout;
}

function initRepository(root, { name = RELEASE_NAME, email = RELEASE_EMAIL } = {}) {
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', name]);
  git(root, ['config', 'user.email', email]);
}

function commitAll(root, message) {
  git(root, ['add', '--all']);
  git(root, ['commit', '-m', message]);
}

function minimalCandidate(t) {
  const root = makeDirectory(t, 'rv-b8-compliance-');
  const packageJson = {
    name: 'review-workbench-open-candidate',
    version: '2.0.0-alpha',
    private: true,
    license: 'AGPL-3.0-only',
    packageManager: 'pnpm@10.30.3',
  };
  write(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  write(root, 'app/package.json', `${JSON.stringify({ ...packageJson, name: '@rv/app' }, null, 2)}\n`);
  write(root, 'frontend/package.json', `${JSON.stringify({ ...packageJson, name: '@rv/engine' }, null, 2)}\n`);
  write(root, 'LICENSE', 'AGPL candidate license text\n');
  const integrity = crypto.createHash('sha512').update('dependency').digest('base64');
  write(root, 'pnpm-lock.yaml', [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      safe-package:',
    '        specifier: 1.2.3',
    '        version: 1.2.3',
    '',
    '  app: {}',
    '',
    '  frontend: {}',
    '',
    'packages:',
    '',
    "  'safe-package@1.2.3':",
    `    resolution: {integrity: sha512-${integrity}}`,
    '',
    'snapshots:',
    '',
    "  'safe-package@1.2.3': {}",
    '',
  ].join('\n'));
  return root;
}

function currentFiles(root) {
  const files = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  }
  return files.sort();
}

function candidateDigest(entries) {
  const digest = crypto.createHash('sha256').update('rv-public-candidate-tree/1\0');
  for (const entry of entries) {
    digest
      .update(entry.path)
      .update('\0')
      .update(String(entry.bytes))
      .update('\0')
      .update(entry.sha256)
      .update('\0');
  }
  return digest.digest('hex');
}

function releaseCandidateFixture(t, {
  inheritedRoot = false,
  rootSubject = 'Review Workbench public candidate root',
} = {}) {
  const root = minimalCandidate(t);
  write(root, '.gitattributes', '* text=auto\n*.json text eol=lf\n*.md text eol=lf\n');
  write(root, '.gitignore', 'node_modules/\ndist/\n');
  write(root, 'README.md', 'safe independent candidate\n');
  write(root, 'scripts/public-staging-allowlist.json', '{"fixture":true}\n');
  writePublicCompliance({ root, layout: 'candidate' });
  const entries = currentFiles(root).map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
    return { path: relativePath, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const allowlistBytes = fs.readFileSync(path.join(root, 'scripts/public-staging-allowlist.json'));
  const manifest = {
    format: 'rv-public-staging-manifest/1',
    distributionStatus: 'not_distributed',
    sourcePolicy: 'exact-allowlist-current-files-no-history',
    provenance: {
      format: 'rv-public-staging-provenance/1',
      mode: 'release',
      releaseEligible: true,
      source: {
        commit: '1'.repeat(40),
        gitTree: '2'.repeat(40),
        clean: true,
        treeSha256: '3'.repeat(64),
      },
      allowlistSha256: crypto.createHash('sha256').update(allowlistBytes).digest('hex'),
      candidateSha256: candidateDigest(entries),
      tools: {
        exporter: 'review-workbench-public-staging/2.0.0',
        node: process.versions.node,
        packageManager: 'pnpm@10.30.3',
        git: 'fixture',
      },
    },
    files: entries,
  };
  write(root, MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
  initRepository(root);
  if (inheritedRoot) {
    write(root, 'private-ancestor.txt', 'safe but not a public candidate snapshot\n');
    git(root, ['add', 'private-ancestor.txt']);
    git(root, ['commit', '-m', 'private source ancestor']);
    fs.unlinkSync(path.join(root, 'private-ancestor.txt'));
  }
  commitAll(root, rootSubject);
  return root;
}

test('non-release export records complete deterministic provenance without claiming clean release evidence', (t) => {
  const { root, allowlist } = sourceFixture(t);
  const firstTarget = targetFixture(t);
  const secondTarget = targetFixture(t);

  exportPublicStaging({ sourceRoot: root, targetRoot: firstTarget, allowlist, mode: 'non-release-test' });
  exportPublicStaging({ sourceRoot: root, targetRoot: secondTarget, allowlist, mode: 'non-release-test' });

  const firstRaw = fs.readFileSync(path.join(firstTarget, MANIFEST_NAME), 'utf8');
  const secondRaw = fs.readFileSync(path.join(secondTarget, MANIFEST_NAME), 'utf8');
  assert.equal(firstRaw, secondRaw);
  const manifest = JSON.parse(firstRaw);
  assert.equal(manifest.provenance.format, 'rv-public-staging-provenance/1');
  assert.equal(manifest.provenance.mode, 'non-release-test');
  assert.equal(manifest.provenance.releaseEligible, false);
  assert.equal(manifest.provenance.source.commit, null);
  assert.equal(manifest.provenance.source.clean, false);
  assert.match(manifest.provenance.source.treeSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.provenance.allowlistSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.provenance.candidateSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.provenance.tools.exporter, /^review-workbench-public-staging\//);
  assert.match(manifest.provenance.tools.node, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.provenance.tools.packageManager, 'pnpm@10.30.3');
  assert.doesNotMatch(firstRaw, /rv-b8-source|[A-Za-z]:\\|\/Users\//i);
});

test('programmatic export requires an explicit release or non-release-test mode', (t) => {
  const { root, allowlist } = sourceFixture(t);
  const target = targetFixture(t);
  assert.throws(() => exportPublicStaging({ sourceRoot: root, targetRoot: target, allowlist }), /mode/i);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('release export requires a clean Git source and binds the exact commit and tree', (t) => {
  const { root, allowlist } = sourceFixture(t);
  initRepository(root);
  commitAll(root, 'initial public source fixture');

  const target = targetFixture(t);
  exportPublicStaging({ sourceRoot: root, targetRoot: target, allowlist, mode: 'release' });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.provenance.releaseEligible, true);
  assert.equal(manifest.provenance.source.clean, true);
  assert.equal(manifest.provenance.source.commit, git(root, ['rev-parse', 'HEAD']).trim());
  assert.equal(manifest.provenance.source.gitTree, git(root, ['rev-parse', 'HEAD^{tree}']).trim());

  write(root, 'dirty.txt', 'not committed\n');
  const dirtyTarget = targetFixture(t);
  assert.throws(
    () => exportPublicStaging({ sourceRoot: root, targetRoot: dirtyTarget, allowlist, mode: 'release' }),
    /clean|dirty|release/i,
  );
  assert.deepEqual(fs.readdirSync(dirtyTarget), []);
});

test('release export rejects an ignored allowlisted source that is absent from the recorded commit', (t) => {
  const { root, allowlist } = sourceFixture(t);
  write(root, '.gitignore', 'ignored.js\n');
  initRepository(root);
  commitAll(root, 'tracked source without ignored payload');
  write(root, 'ignored.js', 'export const ignored = true;\n');
  assert.equal(git(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim(), '');
  const ignoredPolicy = {
    ...allowlist,
    files: [...allowlist.files, 'ignored.js'].sort(),
  };
  const target = targetFixture(t);
  assert.throws(
    () => exportPublicStaging({ sourceRoot: root, targetRoot: target, allowlist: ignoredPolicy, mode: 'release' }),
    /tracked|commit|HEAD/i,
  );
  assert.deepEqual(fs.readdirSync(target), []);
});

test('candidate compliance output is deterministic, SPDX 2.3, and fail-closed on drift', (t) => {
  const root = minimalCandidate(t);
  const first = generatePublicCompliance({ root, layout: 'candidate' });
  const second = generatePublicCompliance({ root, layout: 'candidate' });
  assert.deepEqual(first, second);

  const sbom = JSON.parse(first.sbom);
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.name, 'review-workbench-open-candidate-sbom');
  assert.ok(sbom.packages.some((entry) => entry.name === 'safe-package' && entry.versionInfo === '1.2.3'));
  const safePackage = sbom.packages.find((entry) => entry.name === 'safe-package');
  assert.ok(sbom.relationships.some((entry) => (
    entry.relationshipType === 'DEPENDS_ON' && entry.relatedSpdxElement === safePackage.SPDXID
  )));
  assert.match(sbom.documentComment, /NOASSERTION/);
  assert.match(first.notice, /safe-package@1\.2\.3/);
  assert.match(first.notice, /private.*vulnerability/i);
  assert.match(first.licenseReadme, /AGPL-3\.0-only/);
  assert.equal(first.license, 'AGPL candidate license text\n');

  writePublicCompliance({ root, layout: 'candidate' });
  assert.doesNotThrow(() => verifyPublicCompliance({ root, layout: 'candidate' }));
  fs.appendFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'drift\n');
  assert.throws(() => verifyPublicCompliance({ root, layout: 'candidate' }), /drift|out of date/i);
});

test('candidate compliance refuses a contradictory child workspace license', (t) => {
  const root = minimalCandidate(t);
  const enginePath = path.join(root, 'frontend', 'package.json');
  const engine = JSON.parse(fs.readFileSync(enginePath, 'utf8'));
  fs.writeFileSync(enginePath, `${JSON.stringify({ ...engine, license: 'MIT' }, null, 2)}\n`);
  assert.throws(() => generatePublicCompliance({ root, layout: 'candidate' }), /license|AGPL/i);
});

test('the real non-release staging tree carries the exact candidate compliance packet', (t) => {
  const target = IS_EXPORTED_CANDIDATE ? REPO : targetFixture(t);
  if (!IS_EXPORTED_CANDIDATE) {
    exportPublicStaging({ sourceRoot: REPO, targetRoot: target, mode: 'non-release-test' });
  }
  assert.doesNotThrow(() => verifyPublicCompliance({ root: target, layout: 'candidate' }));
  const manifest = JSON.parse(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8'));
  const staged = new Set(manifest.files.map((entry) => entry.path));
  for (const required of [
    'LICENSES/AGPL-3.0-only.txt',
    'LICENSES/README.md',
    'THIRD_PARTY_NOTICES.md',
    'sbom.spdx.json',
    'scripts/public-candidate-gates.mjs',
  ]) assert.ok(staged.has(required), `missing candidate compliance output ${required}`);
  assert.equal(manifest.provenance.releaseEligible, IS_EXPORTED_CANDIDATE);
});

test('full-history scan catches a secret removed from the current tree without echoing it', (t) => {
  const root = makeDirectory(t, 'rv-b8-history-');
  initRepository(root);
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial public candidate');
  const secret = `sk-${'z'.repeat(32)}`;
  write(root, 'temporary-secret.txt', `${secret}\n`);
  commitAll(root, 'temporary credential mistake');
  fs.unlinkSync(path.join(root, 'temporary-secret.txt'));
  commitAll(root, 'remove temporary credential');

  assert.throws(
    () => scanCandidateHistory(root),
    (error) => {
      assert.match(error.message, /history privacy scan failed/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('full-history scan validates every commit identity against the public noreply identity', (t) => {
  const root = makeDirectory(t, 'rv-b8-identity-');
  initRepository(root, { name: 'Private Name', email: 'private@example.invalid' });
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial candidate');
  assert.throws(() => scanCandidateHistory(root), /author|committer|identity/i);
});

test('full-history scan rejects a shallow object database even when its visible commit is safe', (t) => {
  const root = makeDirectory(t, 'rv-b8-shallow-');
  initRepository(root);
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial candidate');
  const gitDirectory = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  fs.writeFileSync(path.join(gitDirectory, 'shallow'), `${git(root, ['rev-parse', 'HEAD']).trim()}\n`);
  assert.throws(() => scanCandidateHistory(root), /shallow|full.history/i);
});

test('full-history scan also rejects personal metadata stored in annotated tag objects', (t) => {
  const root = makeDirectory(t, 'rv-b8-tag-identity-');
  initRepository(root);
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial candidate');
  git(root, ['config', 'user.name', 'Private Tagger']);
  git(root, ['config', 'user.email', 'private-tagger@example.invalid']);
  git(root, ['tag', '--annotate', 'candidate-v1', '--message', 'candidate tag']);
  assert.throws(() => scanCandidateHistory(root), /tagger|identity/i);
});

test('full-history scan includes dangling blobs and unreachable commits, not only refs', (t) => {
  const root = makeDirectory(t, 'rv-b8-unreachable-');
  initRepository(root);
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial candidate');
  const secret = `sk-${'u'.repeat(32)}`;
  git(root, ['hash-object', '-w', '--stdin'], { input: `${secret}\n` });
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  git(root, ['commit-tree', tree, '-F', '-'], { input: `unreachable ${secret}\n` });

  assert.throws(
    () => scanCandidateHistory(root),
    (error) => {
      assert.match(error.message, /history privacy scan failed/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('full-history scan includes names stored only in unreachable tree objects', (t) => {
  const root = makeDirectory(t, 'rv-b8-unreachable-tree-');
  initRepository(root);
  write(root, 'README.md', 'safe candidate\n');
  commitAll(root, 'initial candidate');
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: 'safe bytes\n' }).trim();
  const secret = `sk-${'n'.repeat(32)}`;
  git(root, ['mktree', '-z'], { input: `100644 blob ${blob}\t${secret}.txt\0` });
  assert.throws(
    () => scanCandidateHistory(root),
    (error) => {
      assert.match(error.message, /history privacy scan failed/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('full-history scan rejects binary control bytes after the first 16 KiB in reachable and dangling blobs', (t) => {
  const binaryTail = Buffer.concat([
    Buffer.alloc(16 * 1024, 0x61),
    Buffer.from([0x00, 0x01, 0x7f]),
  ]);

  const reachable = makeDirectory(t, 'rv-b8-late-binary-reachable-');
  initRepository(reachable);
  write(reachable, 'late-binary.dat', binaryTail);
  commitAll(reachable, 'reachable late binary blob');
  assert.throws(() => scanCandidateHistory(reachable), /binary-history-blob|privacy scan failed/i);

  const dangling = makeDirectory(t, 'rv-b8-late-binary-dangling-');
  initRepository(dangling);
  write(dangling, 'README.md', 'safe candidate\n');
  commitAll(dangling, 'safe candidate root');
  git(dangling, ['hash-object', '-w', '--stdin'], { input: binaryTail });
  assert.throws(() => scanCandidateHistory(dangling), /binary-history-blob|privacy scan failed/i);
});

test('full-history scan rejects Git replace refs instead of inspecting replacement bytes', (t) => {
  const root = makeDirectory(t, 'rv-b8-replace-ref-');
  initRepository(root);
  const secret = `sk-${'r'.repeat(32)}`;
  write(root, 'README.md', `${secret}\n`);
  commitAll(root, 'candidate with replaced reachable blob');
  const originalBlob = git(root, ['rev-parse', 'HEAD:README.md']).trim();
  const safeBlob = git(root, ['hash-object', '-w', '--stdin'], { input: 'safe replacement bytes\n' }).trim();
  git(root, ['replace', originalBlob, safeBlob]);

  assert.throws(
    () => scanCandidateHistory(root),
    (error) => {
      assert.match(error.message, /replace ref|replacement object/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('candidate release history anchors one candidate root, rejects inherited roots, and permits public descendants', (t) => {
  const inherited = releaseCandidateFixture(t, { inheritedRoot: true });
  assert.throws(
    () => verifyPublicCandidate(inherited),
    /independent root|root snapshot|inherited history/i,
  );

  const descendant = releaseCandidateFixture(t);
  write(descendant, 'README.md', 'safe public follow-up bytes\n');
  const descendantManifestPath = path.join(descendant, MANIFEST_NAME);
  const descendantManifest = JSON.parse(fs.readFileSync(descendantManifestPath, 'utf8'));
  descendantManifest.files = descendantManifest.files.map((entry) => {
    const bytes = fs.readFileSync(path.join(descendant, ...entry.path.split('/')));
    return {
      path: entry.path,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
  descendantManifest.provenance.candidateSha256 = candidateDigest(descendantManifest.files);
  fs.writeFileSync(descendantManifestPath, `${JSON.stringify(descendantManifest, null, 2)}\n`);
  commitAll(descendant, 'public follow-up candidate snapshot');
  assert.doesNotThrow(() => verifyPublicCandidate(descendant));

  const wrongSubject = releaseCandidateFixture(t, { rootSubject: 'unanchored root subject' });
  assert.throws(() => verifyPublicCandidate(wrongSubject), /root subject/i);

  const unreachable = releaseCandidateFixture(t);
  const tree = git(unreachable, ['rev-parse', 'HEAD^{tree}']).trim();
  git(unreachable, ['commit-tree', tree, '-F', '-'], { input: 'unreachable safe commit\n' });
  assert.throws(
    () => verifyPublicCandidate(unreachable),
    /independent root|unreachable commit/i,
  );
});

test('candidate Git inspection ignores a configured fsmonitor hook and rejects promisor repositories', (t) => {
  const monitored = releaseCandidateFixture(t);
  const hookRoot = makeDirectory(t, 'rv-b8-fsmonitor-');
  const sentinel = path.join(hookRoot, 'executed.txt');
  const hook = path.join(hookRoot, 'fsmonitor-hook.sh');
  const shellSentinel = sentinel.replaceAll('\\', '/');
  fs.writeFileSync(hook, `#!/bin/sh\nprintf invoked > "${shellSentinel}"\nprintf 'token\\n'\n`);
  fs.chmodSync(hook, 0o755);
  git(monitored, ['config', 'core.fsmonitor', hook.replaceAll('\\', '/')]);
  git(monitored, ['config', 'core.fsmonitorHookVersion', '2']);
  git(monitored, ['status', '--porcelain=v1']);
  assert.equal(fs.existsSync(sentinel), true, 'fixture must prove ordinary Git would execute the fsmonitor hook');
  fs.unlinkSync(sentinel);
  assert.doesNotThrow(() => verifyPublicCandidate(monitored));
  assert.equal(fs.existsSync(sentinel), false, 'candidate fsmonitor hook must never execute');

  const promisor = releaseCandidateFixture(t);
  git(promisor, ['config', 'extensions.partialClone', 'origin']);
  git(promisor, ['config', 'remote.origin.promisor', 'true']);
  git(promisor, ['config', 'remote.origin.partialCloneFilter', 'blob:none']);
  assert.throws(() => verifyPublicCandidate(promisor), /partial clone|promisor|lazy fetch/i);

  const worktreePromisor = releaseCandidateFixture(t);
  git(worktreePromisor, ['config', 'extensions.worktreeConfig', 'true']);
  git(worktreePromisor, ['config', '--worktree', 'remote.origin.promisor', 'true']);
  assert.throws(() => verifyPublicCandidate(worktreePromisor), /partial clone|promisor|lazy fetch/i);
});

test('candidate verification binds a clean HEAD and index, not only working-tree path names', (t) => {
  const root = releaseCandidateFixture(t);
  assert.doesNotThrow(() => verifyPublicCandidate(root));

  const readmePath = path.join(root, 'README.md');
  const manifestBytes = fs.readFileSync(readmePath);
  fs.writeFileSync(readmePath, 'different safe staged bytes\n');
  git(root, ['add', 'README.md']);
  fs.writeFileSync(readmePath, manifestBytes);
  assert.throws(() => verifyPublicCandidate(root), /clean|index|HEAD|tracked/i);
});

test('public candidate wires tests, typecheck, build, compliance, privacy and history without distribution authority', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'public-staging/package.json'), 'utf8'));
  const engineManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'public-staging/frontend-package.json'), 'utf8'));
  assert.match(manifest.scripts.verify, /pnpm test/);
  assert.match(manifest.scripts.verify, /pnpm typecheck/);
  assert.match(manifest.scripts.verify, /pnpm build/);
  assert.match(manifest.scripts.verify, /pnpm test:e2e/);
  assert.match(manifest.scripts['test:e2e'], /playwright\.public\.config\.ts/);
  assert.match(manifest.scripts.verify, /pnpm verify:privacy/);
  assert.match(manifest.scripts.verify, /verify:candidate/);
  assert.match(manifest.scripts['verify:candidate'], /public-candidate-gates\.mjs/);
  assert.equal(manifest.scripts['verify:privacy'], 'node scripts/verify-repository-privacy.mjs');
  assert.equal(engineManifest.types, './engine.d.ts');
  assert.deepEqual(engineManifest.exports['.'], {
    types: './engine.d.ts',
    default: './engine.js',
  });
  assert.equal(engineManifest.exports['./loopback-api'], './loopback-api.js');
  assert.equal(engineManifest.exports['./runtime-client'], './runtime-client.js');

  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/public-staging-allowlist.json'), 'utf8'));
  assert.ok(policy.files.includes('.gitattributes'));
  assert.ok(policy.files.includes('.gitignore'));
  assert.ok(policy.files.includes('playwright.public.config.ts'));
  assert.ok(policy.files.includes('tests/public-e2e/production-candidate.spec.ts'));
  assert.ok(policy.files.includes('tests/public-e2e/serve-public-candidate.mjs'));
  assert.match(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8'), /^\*\.toml text eol=lf$/m);
  assert.match(fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8'), /^\*\.txt text eol=lf$/m);

  const security = fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8');
  assert.match(security, /私密沟通渠道/);
  assert.match(security, /不要在公开 issue/);
  assert.match(security, /尚无双方确认.*停止传输/s);
});

test('the exported tree can execute its copied B8 gates without private-source files', {
  skip: process.env.RV_B8_NESTED === '1' || IS_EXPORTED_CANDIDATE,
}, (t) => {
  const target = targetFixture(t);
  exportPublicStaging({ sourceRoot: REPO, targetRoot: target, mode: 'non-release-test' });
  const privacy = spawnSync(process.execPath, ['scripts/verify-repository-privacy.mjs'], {
    cwd: target,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(privacy.status, 0, `copied privacy gate failed:\n${privacy.stdout}\n${privacy.stderr}`);
  const result = spawnSync(process.execPath, ['--test', 'tests/public-candidate-b8.test.mjs'], {
    cwd: target,
    encoding: 'utf8',
    env: { ...process.env, RV_B8_NESTED: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `copied B8 tests failed:\n${result.stdout}\n${result.stderr}`);
});
