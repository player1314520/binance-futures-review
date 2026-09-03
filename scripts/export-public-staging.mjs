import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertNoPrivacyFindings,
  scanRepository,
} from './verify-repository-privacy.mjs';

export const ALLOWLIST_FORMAT = 'rv-public-staging-allowlist/2';
export const MANIFEST_NAME = 'PUBLIC-STAGING-MANIFEST.json';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = path.join(REPO, 'scripts', 'public-staging-allowlist.json');
const MANIFEST_FORMAT = 'rv-public-staging-manifest/1';
const PROVENANCE_FORMAT = 'rv-public-staging-provenance/1';
const EXPORTER_VERSION = 'review-workbench-public-staging/2.0.0';
const EXPORT_MODES = new Set(['release', 'non-release-test']);
const REQUIRED_GOVERNANCE_OUTPUTS = Object.freeze(['DISTRIBUTION.md', 'package.json']);
const FORBIDDEN_PREFIXES = Object.freeze([
  '.git/',
  '.tmp/',
  'baselines/',
  'dist/',
  'docs/',
  'legacy-cloud/',
  'node_modules/',
  'private-backups/',
  'report/',
  'runtime-data/',
  'scripts/desktop-kit/',
  'strategy/',
  'supabase/',
  'tests/fixtures/',
  'tests/golden/',
]);
const FORBIDDEN_EXTENSIONS = new Set([
  '.aes256gcm', '.bat', '.csv', '.db', '.dpapi', '.gif', '.jpeg', '.jpg',
  '.jks', '.key', '.keystore', '.log', '.p12', '.pem', '.pfx', '.png',
  '.sqlite', '.sqlite3', '.webp',
]);
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.sql', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const ALLOWED_EXTENSIONLESS_FILES = new Set(['.gitattributes', '.gitignore', 'LICENSE']);
const FORBIDDEN_NAMES = new Set([
  '.env', '.git', '.runtime-data', 'secrets.bat', 'start.bat', 'run.bat',
]);
const FORBIDDEN_SEGMENTS = new Set([
  '.tmp', 'baselines', 'dist', 'fixtures', 'fixture', 'golden', 'legacy-cloud',
  'node_modules', 'private-backups', 'runtime-data', 'samples',
]);
const FRONTEND_PUBLIC_EXCEPTIONS = new Set([
  'frontend/data-quality-v2.js',
  'frontend/demo-data.js',
  'frontend/engine.d.ts',
  'frontend/engine.js',
  'frontend/legacy-review-export.d.ts',
  'frontend/legacy-review-export.js',
  'frontend/loopback-api.js',
  'frontend/net-position.js',
  'frontend/package.json',
  'frontend/runtime-client.js',
]);
const DOC_PUBLIC_EXCEPTIONS = new Set([
  'docs/INVITE-BETA-BACKEND.md',
  'docs/PRODUCTION-DEPLOYMENT.md',
  'docs/PUBLIC-STAGING.md',
]);
const SUPABASE_PUBLIC_EXCEPTIONS = new Set([
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
  'supabase/production-vault/README.md',
  'supabase/production-vault/migrations/20260829000100_production_vault.sql',
  'supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
  'supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
  'supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
  'supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
  'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
  'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
  'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  'supabase/migrations/20260831000200_restore_v2_lineage.sql',
  'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
  'supabase/templates/magic-link.html',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestEntries(entries, domain) {
  const digest = crypto.createHash('sha256').update(`${domain}\0`);
  for (const [relativePath, bytes] of [...entries].sort(([left], [right]) => compareText(left, right))) {
    digest
      .update(relativePath)
      .update('\0')
      .update(String(bytes.length))
      .update('\0')
      .update(sha256(bytes))
      .update('\0');
  }
  return digest.digest('hex');
}

function runGit(sourceRoot, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', sourceRoot, ...args], {
    encoding,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) fail(`Git provenance inspection failed for ${args[0]}`);
  return result;
}

function assertReleaseInputsAtCommit(sourceRoot, commit, sourceEntries) {
  for (const [relativePath, expectedBytes] of sourceEntries) {
    const result = runGit(sourceRoot, ['cat-file', 'blob', `${commit}:${relativePath}`], {
      allowFailure: true,
      encoding: null,
    });
    if (result.status !== 0) fail(`release source input is not tracked by the recorded commit: ${relativePath}`);
    if (!Buffer.isBuffer(result.stdout) || !result.stdout.equals(expectedBytes)) {
      fail(`release source input bytes differ from the recorded commit: ${relativePath}`);
    }
  }
}

function inspectGitSource(sourceRoot) {
  const inside = runGit(sourceRoot, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  const gitVersion = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  const version = gitVersion.status === 0
    ? String(gitVersion.stdout).trim().replace(/^git version\s+/u, '')
    : null;
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    return Object.freeze({ commit: null, gitTree: null, clean: false, gitVersion: version });
  }
  const commit = String(runGit(sourceRoot, ['rev-parse', '--verify', 'HEAD']).stdout).trim();
  const gitTree = String(runGit(sourceRoot, ['rev-parse', 'HEAD^{tree}']).stdout).trim();
  const status = String(runGit(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).stdout);
  if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(gitTree)) {
    fail('Git provenance returned a non-full object id');
  }
  return Object.freeze({ commit, gitTree, clean: status.length === 0, gitVersion: version });
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(left, right) {
  const a = normalizeForComparison(left);
  const b = normalizeForComparison(right);
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  const contained = (relative) => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return contained(relativeAB) || contained(relativeBA);
}

function validateRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) fail('allowlist paths must be non-empty strings');
  if (relativePath.includes('\\')) fail('allowlist paths must use forward slashes');
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) fail('absolute allowlist path is unsafe');
  if (path.posix.normalize(relativePath) !== relativePath || relativePath === '.' || relativePath.startsWith('../')) {
    fail('allowlist traversal is unsafe');
  }

  const lower = relativePath.toLowerCase();
  const parts = lower.split('/');
  if (parts.some((part) => part === '..' || part === '')) fail('allowlist traversal is unsafe');
  if (parts.some((part) => FORBIDDEN_NAMES.has(part) || part.startsWith('.env.'))) fail('forbidden credential or history path');
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) fail('forbidden private or runtime path');
  if (FORBIDDEN_EXTENSIONS.has(path.posix.extname(lower))) fail('forbidden credential or runtime-data file type');
  const extension = path.posix.extname(lower);
  if (!ALLOWED_TEXT_EXTENSIONS.has(extension) && !ALLOWED_EXTENSIONLESS_FILES.has(relativePath)) {
    fail('unknown or non-text allowlist file type is forbidden');
  }
  if (lower.includes('/fixtures/') || lower.includes('/fixture/') || lower.includes('/samples/')) {
    fail('internal fixture path is forbidden');
  }
  if (lower.startsWith('frontend/') && !FRONTEND_PUBLIC_EXCEPTIONS.has(relativePath)) {
    fail('private desktop shell path is forbidden');
  }
  if (lower.startsWith('docs/') && !DOC_PUBLIC_EXCEPTIONS.has(relativePath)) {
    fail('private generated docs path is forbidden');
  }
  if (lower.startsWith('supabase/') && !SUPABASE_PUBLIC_EXCEPTIONS.has(relativePath)) {
    fail('unreviewed backend path is forbidden');
  }
  if (
    FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))
    && !DOC_PUBLIC_EXCEPTIONS.has(relativePath)
    && !SUPABASE_PUBLIC_EXCEPTIONS.has(relativePath)
  ) {
    fail('forbidden private or runtime path');
  }
}

export function validateAllowlist(allowlist) {
  if (allowlist === null || typeof allowlist !== 'object' || Array.isArray(allowlist)) fail('allowlist must be an object');
  const keys = Object.keys(allowlist).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['files', 'format', 'mappedFiles'])) fail('allowlist contains unknown fields');
  if (allowlist.format !== ALLOWLIST_FORMAT) fail('unknown allowlist format');
  if (!Array.isArray(allowlist.files) || allowlist.files.length === 0) fail('allowlist files must be a non-empty array');
  if (!Array.isArray(allowlist.mappedFiles)) fail('allowlist mappedFiles must be an array');
  for (const relativePath of allowlist.files) validateRelativePath(relativePath);
  if (new Set(allowlist.files).size !== allowlist.files.length) fail('allowlist files must be unique');
  if (JSON.stringify(allowlist.files) !== JSON.stringify([...allowlist.files].sort())) fail('allowlist files must be sorted');
  const mappedFiles = allowlist.mappedFiles.map((mapping) => {
    if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) fail('mapped file must be an object');
    if (JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify(['source', 'target'])) {
      fail('mapped file contains unknown fields');
    }
    validateRelativePath(mapping.source);
    validateRelativePath(mapping.target);
    if (mapping.source === mapping.target) fail('mapped file source and target must differ');
    return Object.freeze({ source: mapping.source, target: mapping.target });
  });
  const mappingKeys = mappedFiles.map(({ source, target }) => `${source}\0${target}`);
  if (JSON.stringify(mappingKeys) !== JSON.stringify([...mappingKeys].sort())) fail('mapped files must be sorted');
  if (new Set(mappedFiles.map(({ source }) => source)).size !== mappedFiles.length) fail('mapped file sources must be unique');
  if (new Set(mappedFiles.map(({ target }) => target)).size !== mappedFiles.length) fail('mapped file targets must be unique');
  const outputPaths = [...allowlist.files, ...mappedFiles.map(({ target }) => target)];
  if (new Set(outputPaths).size !== outputPaths.length) fail('allowlist output paths must be unique');
  for (const required of REQUIRED_GOVERNANCE_OUTPUTS) {
    if (!outputPaths.includes(required)) fail(`allowlist is missing required governance output ${required}`);
  }
  return Object.freeze({
    format: allowlist.format,
    files: Object.freeze([...allowlist.files]),
    mappedFiles: Object.freeze(mappedFiles),
  });
}

export function loadAllowlist(allowlistPath = DEFAULT_ALLOWLIST) {
  let stat;
  try {
    stat = fs.lstatSync(allowlistPath);
  } catch {
    fail('allowlist file is unavailable');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('allowlist must be a regular non-link file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch {
    fail('allowlist is not valid JSON');
  }
  return validateAllowlist(parsed);
}

function assertDirectoryPathHasNoLinks(absoluteDirectory, label) {
  const resolved = path.resolve(absoluteDirectory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail(`${label} directory is unavailable`);
    }
    if (stat.isSymbolicLink()) fail(`${label} path contains a symbolic link or reparse point`);
    if (!stat.isDirectory()) fail(`${label} must be a directory`);
  }
}

function assertSourcePath(root, relativePath) {
  let current = root;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fail(`allowlisted source is unavailable: ${relativePath}`);
    }
    if (stat.isSymbolicLink()) fail(`allowlisted source contains a symbolic link or reparse point: ${relativePath}`);
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) fail(`allowlisted source parent is not a directory: ${relativePath}`);
    if (final && !stat.isFile()) fail(`allowlisted source is not a regular file: ${relativePath}`);
  }
  return current;
}

function readRegularFile(root, relativePath) {
  const absolutePath = assertSourcePath(root, relativePath);
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    fail(`allowlisted source could not be opened safely: ${relativePath}`);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) fail(`allowlisted source is not a regular file: ${relativePath}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    let current;
    try {
      assertSourcePath(root, relativePath);
      current = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('allowlisted source')) throw error;
      fail(`allowlisted source path changed while reading: ${relativePath}`);
    }
    if (!current.isFile() || current.isSymbolicLink()) fail(`allowlisted source changed type: ${relativePath}`);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev || before.ino !== after.ino) {
      fail(`allowlisted source changed while reading: ${relativePath}`);
    }
    if (after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size) {
      fail(`allowlisted source path changed while reading: ${relativePath}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseGovernedPackage(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} package.json must be valid JSON`);
  }
  if (manifest.private !== true) fail(`${label} package.json must remain private:true`);
  if (manifest.license !== 'AGPL-3.0-only') fail(`${label} package.json must remain AGPL-3.0-only`);
  return manifest;
}

function assertGovernance(entries, privateRootPackageBytes) {
  parseGovernedPackage(privateRootPackageBytes, 'private root');
  parseGovernedPackage(entries.get('package.json'), 'public staging');

  const distribution = entries.get('DISTRIBUTION.md').toString('utf8');
  const statuses = distribution.match(/^STATUS: .+$/gm) ?? [];
  if (statuses.length !== 1 || !/^STATUS: (?:not_distributed|distributed)$/.test(statuses[0])) {
    fail('DISTRIBUTION status must be not_distributed or distributed');
  }
  const distributionStatus = statuses[0].slice('STATUS: '.length);
  if (distributionStatus === 'distributed' && !/^PUBLIC_URL: https:\/\/[^\s]+$/m.test(distribution)) {
    fail('distributed candidate must name one HTTPS PUBLIC_URL');
  }
  return distributionStatus;
}

function assertEmbeddedAllowlist(entries, policy) {
  const embeddedBytes = entries.get('scripts/public-staging-allowlist.json');
  if (embeddedBytes === undefined) return;
  let embedded;
  try {
    embedded = validateAllowlist(JSON.parse(embeddedBytes.toString('utf8')));
  } catch {
    fail('embedded allowlist is invalid');
  }
  if (
    embedded.format !== policy.format
    || JSON.stringify(embedded.files) !== JSON.stringify(policy.files)
    || JSON.stringify(embedded.mappedFiles) !== JSON.stringify(policy.mappedFiles)
  ) {
    fail('embedded allowlist does not match the applied policy');
  }
}

function manifestBytes(entries, { mode, gitSource, sourceTreeSha256, allowlistSha256, distributionStatus }) {
  const packageManager = parseGovernedPackage(entries.get('package.json'), 'public staging').packageManager ?? null;
  const manifest = {
    format: MANIFEST_FORMAT,
    distributionStatus,
    sourcePolicy: 'exact-allowlist-current-files-no-history',
    provenance: {
      format: PROVENANCE_FORMAT,
      mode,
      releaseEligible: mode === 'release' && gitSource.clean,
      source: {
        commit: gitSource.commit,
        gitTree: gitSource.gitTree,
        clean: gitSource.clean,
        treeSha256: sourceTreeSha256,
      },
      allowlistSha256,
      candidateSha256: digestEntries(entries, 'rv-public-candidate-tree/1'),
      tools: {
        exporter: EXPORTER_VERSION,
        node: process.versions.node,
        packageManager,
        git: gitSource.gitVersion,
      },
    },
    files: [...entries].map(([relativePath, bytes]) => ({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function writeTree(root, entries, manifest) {
  for (const [relativePath, bytes] of entries) {
    const destination = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(root, MANIFEST_NAME), manifest, { flag: 'wx' });
}

function collectExactTree(root) {
  const files = [];
  const directories = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
      if (entry.isSymbolicLink()) fail(`staged tree contains a symbolic link or reparse point: ${relativePath}`);
      if (entry.isDirectory()) {
        directories.push(relativePath);
        pending.push(relativePath);
      }
      else if (entry.isFile()) files.push(relativePath);
      else fail(`staged tree contains a non-regular file: ${relativePath}`);
    }
  }
  return { directories: directories.sort(), files: files.sort() };
}

function expectedDirectories(expectedFiles) {
  const directories = new Set();
  for (const relativePath of expectedFiles) {
    let directory = path.posix.dirname(relativePath);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort();
}

export function verifyStagedTree(root, expectedFiles) {
  assertDirectoryPathHasNoLinks(root, 'staged tree');
  const expected = [...expectedFiles].sort();
  if (new Set(expected).size !== expected.length) fail('expected staged paths must be unique');
  const actual = collectExactTree(root);
  if (
    JSON.stringify(actual.files) !== JSON.stringify(expected)
    || JSON.stringify(actual.directories) !== JSON.stringify(expectedDirectories(expected))
  ) fail('staged tree contains unknown or missing files; exact tree check failed');
  const { findings } = scanRepository(root);
  assertNoPrivacyFindings(findings);
  return Object.freeze({ files: Object.freeze(actual.files) });
}

function assertSafeRoots(sourceRoot, targetRoot) {
  if (!path.isAbsolute(sourceRoot)) fail('source root must be absolute');
  if (!path.isAbsolute(targetRoot)) fail('target root must be absolute');
  if (normalizeForComparison(targetRoot) === normalizeForComparison(path.parse(targetRoot).root)) fail('filesystem root is an unsafe target');
  assertDirectoryPathHasNoLinks(sourceRoot, 'source root');
  assertDirectoryPathHasNoLinks(targetRoot, 'target root');
  let sourceReal;
  let targetReal;
  try {
    sourceReal = fs.realpathSync(sourceRoot);
    targetReal = fs.realpathSync(targetRoot);
  } catch {
    fail('source or target root is unavailable');
  }
  if (pathsOverlap(sourceReal, targetReal)) fail('source and target roots overlap and are unsafe');
  if (fs.readdirSync(targetRoot).length !== 0) fail('target root must be explicitly empty');
}

function cleanupKnownFiles(root, relativePaths) {
  for (const relativePath of [...relativePaths].sort().reverse()) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(absolutePath);
    } catch {}
  }
  const directories = new Set();
  for (const relativePath of relativePaths) {
    let directory = path.posix.dirname(relativePath);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  for (const relativeDirectory of [...directories].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(path.join(root, ...relativeDirectory.split('/'))); } catch {}
  }
}

export function exportPublicStaging({
  sourceRoot = REPO,
  targetRoot,
  allowlist = loadAllowlist(),
  mode,
} = {}) {
  if (typeof targetRoot !== 'string' || targetRoot.length === 0) fail('an explicit target root is required');
  if (!EXPORT_MODES.has(mode)) fail('export mode must be release or non-release-test');
  const policy = validateAllowlist(allowlist);
  assertSafeRoots(sourceRoot, targetRoot);

  const gitSource = inspectGitSource(sourceRoot);
  if (mode === 'release' && (gitSource.commit === null || !gitSource.clean)) {
    fail('release export requires a clean Git source at an exact commit');
  }

  const collectedEntries = new Map();
  const sourceEntries = new Map();
  const readSource = (relativePath) => {
    if (!sourceEntries.has(relativePath)) sourceEntries.set(relativePath, readRegularFile(sourceRoot, relativePath));
    return sourceEntries.get(relativePath);
  };
  for (const relativePath of policy.files) collectedEntries.set(relativePath, readSource(relativePath));
  for (const { source, target } of policy.mappedFiles) {
    collectedEntries.set(target, readSource(source));
  }
  const entries = new Map([...collectedEntries].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
  const distributionStatus = assertGovernance(entries, readSource('package.json'));
  assertEmbeddedAllowlist(entries, policy);
  for (const [relativePath, expectedBytes] of sourceEntries) {
    const currentBytes = readRegularFile(sourceRoot, relativePath);
    if (!currentBytes.equals(expectedBytes)) fail(`allowlisted source changed during export: ${relativePath}`);
  }
  if (mode === 'release') assertReleaseInputsAtCommit(sourceRoot, gitSource.commit, sourceEntries);
  const finalGitSource = inspectGitSource(sourceRoot);
  if (
    finalGitSource.commit !== gitSource.commit
    || finalGitSource.gitTree !== gitSource.gitTree
    || finalGitSource.clean !== gitSource.clean
  ) fail('Git source state changed during export');
  if (mode === 'release' && !finalGitSource.clean) fail('release source became dirty during export');
  const embeddedAllowlist = entries.get('scripts/public-staging-allowlist.json');
  const canonicalAllowlist = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  const manifest = manifestBytes(entries, {
    mode,
    gitSource: finalGitSource,
    sourceTreeSha256: digestEntries(sourceEntries, 'rv-public-source-input-tree/1'),
    allowlistSha256: sha256(embeddedAllowlist ?? canonicalAllowlist),
    distributionStatus,
  });
  const expectedFiles = [...entries.keys(), MANIFEST_NAME].sort();

  const checkRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rv-public-staging-check-'));
  try {
    writeTree(checkRoot, entries, manifest);
    verifyStagedTree(checkRoot, expectedFiles);
  } finally {
    fs.rmSync(checkRoot, { recursive: true, force: true });
  }

  if (fs.readdirSync(targetRoot).length !== 0) fail('target root stopped being empty');
  try {
    writeTree(targetRoot, entries, manifest);
    verifyStagedTree(targetRoot, expectedFiles);
  } catch (error) {
    cleanupKnownFiles(targetRoot, expectedFiles);
    throw error;
  }

  return Object.freeze({
    fileCount: entries.size,
    manifestSha256: sha256(manifest),
    distributionStatus,
  });
}

function parseOptions(argv) {
  const options = { targetRoot: null, mode: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--target', '--mode'].includes(argument)) {
      fail('usage: node scripts/export-public-staging.mjs --target <absolute-empty-directory> --mode <release|non-release-test>');
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail(`${argument} requires a value`);
    if (argument === '--target') options.targetRoot = value;
    else options.mode = value;
    index += 1;
  }
  if (options.targetRoot === null || options.mode === null) {
    fail('usage: node scripts/export-public-staging.mjs --target <absolute-empty-directory> --mode <release|non-release-test>');
  }
  return options;
}

function main() {
  try {
    const result = exportPublicStaging(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`public staging failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
