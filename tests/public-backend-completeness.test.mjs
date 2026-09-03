import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_EXPORTED_CANDIDATE = fs.existsSync(path.join(REPO, 'PUBLIC-STAGING-MANIFEST.json'));

const REVIEWED_FUNCTION_FILES = Object.freeze({
  'beta-operations': Object.freeze([
    'README.md',
    'core.mjs',
    'handler.mjs',
    'index.ts',
    'runtime.mjs',
  ]),
  'binance-beta': Object.freeze([
    'README.md',
    'archive.mjs',
    'binance-client.mjs',
    'crypto.mjs',
    'handler.mjs',
    'index.ts',
    'internal-handler.mjs',
    'ledger.mjs',
    'runtime.mjs',
    'trade-projector.mjs',
  ]),
  'delete-account': Object.freeze([
    'README.md',
    'handler.mjs',
    'index.ts',
    'protocol.mjs',
    'r2-journal.mjs',
  ]),
  'publish-vault-head': Object.freeze([
    'README.md',
    'handler.mjs',
    'index.ts',
    'protocol.mjs',
  ]),
  'restore-v2': Object.freeze([
    'README.md',
    'core.mjs',
    'handler.mjs',
    'index.ts',
    'runtime.mjs',
  ]),
});

const RV2_MIGRATIONS = Object.freeze([
  '20260831000100_invite_beta_rv2_data_plane.sql',
  '20260831000200_restore_v2_lineage.sql',
  '20260831000300_invite_beta_capacity_observability.sql',
]);

function read(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), 'utf8');
}

function relativeImports(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/gu)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

test('every configured Edge Function is exported as one reviewed self-contained runtime', () => {
  const config = read('supabase/config.toml');
  const configuredFunctions = [...config.matchAll(/^\[functions\.([^\]]+)\]$/gmu)]
    .map((match) => match[1])
    .sort();
  const reviewedFunctions = Object.keys(REVIEWED_FUNCTION_FILES).sort();

  assert.deepEqual(
    configuredFunctions,
    reviewedFunctions,
    'a configured Edge Function must enter the reviewed public runtime contract',
  );

  for (const functionName of configuredFunctions) {
    const relativeDirectory = `supabase/functions/${functionName}`;
    const absoluteDirectory = path.join(REPO, relativeDirectory);
    assert.equal(fs.statSync(absoluteDirectory).isDirectory(), true, `${relativeDirectory} is missing`);

    const actualFiles = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(
      actualFiles,
      [...REVIEWED_FUNCTION_FILES[functionName]].sort(),
      `${relativeDirectory} is not the complete reviewed runtime`,
    );
    assert.ok(actualFiles.includes('README.md'), `${relativeDirectory}/README.md is missing`);
    assert.ok(actualFiles.includes('index.ts'), `${relativeDirectory}/index.ts is missing`);

    for (const filename of actualFiles.filter((value) => /\.(?:mjs|ts)$/u.test(value))) {
      const source = read(`${relativeDirectory}/${filename}`);
      for (const specifier of relativeImports(source)) {
        const resolved = path.resolve(absoluteDirectory, specifier);
        assert.equal(
          path.dirname(resolved),
          absoluteDirectory,
          `${relativeDirectory}/${filename} imports outside its deployable function bundle`,
        );
        assert.equal(
          fs.statSync(resolved).isFile(),
          true,
          `${relativeDirectory}/${filename} has an unresolved local import ${specifier}`,
        );
      }
    }
  }
});

test('the public deployment migration chain contains byte-identical rv2 migrations 001, 002 and 003', () => {
  const sourceDirectory = path.join(REPO, 'supabase/production-vault/migrations');
  const deployableDirectory = IS_EXPORTED_CANDIDATE
    ? path.join(REPO, 'supabase/migrations')
    : sourceDirectory;

  for (const filename of RV2_MIGRATIONS) {
    const sourcePath = path.join(sourceDirectory, filename);
    const deployablePath = path.join(deployableDirectory, filename);
    assert.equal(fs.statSync(sourcePath).isFile(), true, `private migration source is missing ${filename}`);
    assert.equal(fs.statSync(deployablePath).isFile(), true, `deployable migration is missing ${filename}`);
    assert.deepEqual(
      fs.readFileSync(deployablePath),
      fs.readFileSync(sourcePath),
      `deployable migration drifted from ${filename}`,
    );
  }
});
