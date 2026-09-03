// WP2 current-tree privacy gate.
//
// Security credentials and machine-specific paths are checked across every active
// text source and generated artifact. Maintainer trade-profile fingerprints use a
// narrower, named public-candidate scope because the 1.0 private shell and legacy
// production Supabase operations are not part of the future WP13 public export.
// This gate is intentionally not a substitute for WP13's full-history scan and
// allowlist-only staging export audit.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const skippedEntryNames = new Set([
  '.git',
  '.claude', // retired worktree/task metadata, not an active product tree
  '.tmp',
  'coverage',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const privateKeyContainerExtensions = new Set([
  '.jks',
  '.keystore',
  '.p12',
  '.pfx',
]);

const privateProductProfilePaths = new Set([
  'frontend/Canvas.dc.html',
  'frontend/workbench.html',
  'frontend/复盘工作台.dc.html',
  'frontend/设计系统总览.dc.html',
]);

export function isPublicProfilePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (privateProductProfilePaths.has(normalized)) return false;
  if (normalized.startsWith('dist/1.0/')) return false;
  if (normalized.startsWith('supabase/')) return false;
  return true;
}

const allActiveText = () => true;
const publicProfile = ({ relativePath }) => isPublicProfilePath(relativePath);
const maintainerSymbolProfileExpression = new RegExp(
  [
    '(?:(?:用户画像|维护者|站长|本人|真实(?:数据|交易)).{0,240}',
    'XAGUSDT.{0,160}(?:NVDAUSDT|MRVLUSDT|SKHYNIXUSDT)',
    '|(?:NVDAUSDT|MRVLUSDT|SKHYNIXUSDT).{0,160}XAGUSDT',
    '.{0,240}(?:用户画像|维护者|站长|本人|真实(?:数据|交易)))',
  ].join(''),
  'gi',
);

export const PRIVACY_RULES = Object.freeze([
  {
    id: 'personal-absolute-path',
    label: 'machine-specific absolute filesystem path',
    scope: allActiveText,
    re: /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'`<>|]*|\/(?:Users|home)\/[^/\s]+\/[^\s"'`<>]*)/g,
  },
  {
    id: 'private-key',
    label: 'private key material',
    scope: allActiveText,
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    id: 'jwt-credential',
    label: 'JWT-like credential',
    scope: allActiveText,
    re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    id: 'api-key',
    label: 'API-key-like credential',
    scope: allActiveText,
    re: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  },
  {
    id: 'literal-secret-assignment',
    label: 'literal secret assignment',
    scope: allActiveText,
    re: /^(?:export\s+)?(?:OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|BINANCE_API_KEY|BINANCE_API_SECRET|BINANCE_SECRET_KEY|AWS_SECRET_ACCESS_KEY)\s*=\s*["']?(?!<|example|replace|your_)[A-Za-z0-9+/=_-]{16,}["']?\s*$/gim,
  },
  {
    id: 'supabase-project-url',
    label: 'hardcoded Supabase project URL',
    scope: allActiveText,
    re: /https:\/\/[a-z0-9]{20}\.supabase\.co/gi,
  },
  {
    id: 'legacy-real-trade-id',
    label: 'legacy real-trade fixture id',
    scope: allActiveText,
    re: /\bt_[0-9a-f]{32}\b/gi,
  },
  {
    id: 'maintainer-trade-count',
    label: 'legacy maintainer trade-count fingerprint',
    scope: publicProfile,
    re: /(?<!\d)(?:(?:62|65|68|71|73)\s*(?:笔|行|个品种|平仓|闭环)|(?:536|605)\s*(?:笔|fills)\b)/gi,
  },
  {
    id: 'maintainer-start-equity',
    label: 'legacy maintainer starting-equity fingerprint',
    scope: publicProfile,
    re: /\bSTART_EQ\s*=\s*2927\b/gi,
  },
  {
    id: 'maintainer-timespan',
    label: 'maintainer-specific trading timespan',
    scope: publicProfile,
    re: /(?:(?:维护者|站长|本人|你自己|自己|我的?).{0,100}(?:5\s*个月|12\s*个品种)|(?:5\s*个月|12\s*个品种).{0,100}(?:维护者|站长|本人|你自己|自己|真实(?:数据|交易)))/gi,
  },
  {
    id: 'maintainer-symbol-profile',
    label: 'maintainer-specific symbol combination',
    scope: publicProfile,
    re: maintainerSymbolProfileExpression,
  },
]);

// Exceptions, when unavoidable, must name the exact file, line, column, rule,
// match length and irreversible digest. Whole-file and whole-directory
// exceptions are intentionally unsupported.
// There are currently no exceptions: the scanner's regex definitions are written
// as regex syntax and are expected to pass their own scan.
export const EXACT_MATCH_ALLOWLIST = Object.freeze([]);

function findingKey(finding) {
  return JSON.stringify([
    finding.relativePath,
    finding.line,
    finding.column,
    finding.ruleId,
    finding.matchLength,
    finding.matchDigest,
  ]);
}

const exactAllowlistKeys = new Set(EXACT_MATCH_ALLOWLIST.map(findingKey));

function irreversibleDigest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update('rv-privacy-finding-v1\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 12)}`;
}

export function listCurrentTreeFiles(repo = REPO) {
  const discovered = [];
  const pending = [''];

  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = path.join(repo, relativeDirectory);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (skippedEntryNames.has(entry.name)) continue;
      const relativePath = path.posix.join(
        relativeDirectory.replaceAll('\\', '/'),
        entry.name,
      );
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (entry.isFile()) {
        discovered.push(relativePath);
      }
    }
  }

  return discovered.sort();
}

export function scanText(relativePath, source) {
  const normalized = relativePath.replaceAll('\\', '/');
  const findings = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const rule of PRIVACY_RULES) {
      if (!rule.scope({ relativePath: normalized })) continue;
      const expression = new RegExp(rule.re.source, rule.re.flags);
      for (const match of line.matchAll(expression)) {
        const matchedText = match[0];
        const finding = {
          relativePath: normalized,
          line: index + 1,
          column: (match.index ?? 0) + 1,
          ruleId: rule.id,
          matchLength: matchedText.length,
          matchDigest: irreversibleDigest(matchedText),
        };
        if (!exactAllowlistKeys.has(findingKey(finding))) findings.push(finding);
      }
    }
  }

  return findings;
}

export function decodeTextCandidate(contents) {
  let encoding = 'utf-8';
  if (
    contents.length >= 3
    && contents[0] === 0xef
    && contents[1] === 0xbb
    && contents[2] === 0xbf
  ) {
    encoding = 'utf-8';
  } else if (contents.length >= 2 && contents[0] === 0xff && contents[1] === 0xfe) {
    encoding = 'utf-16le';
  } else if (contents.length >= 2 && contents[0] === 0xfe && contents[1] === 0xff) {
    encoding = 'utf-16be';
  }

  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(contents);
  } catch {
    return null;
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const allowedWhitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d;
    if (!allowedWhitespace && (codePoint < 0x20 || codePoint === 0x7f)) return null;
  }
  return text;
}

function readTextCandidate(absolutePath) {
  return decodeTextCandidate(fs.readFileSync(absolutePath));
}

function privateKeyContainerFinding(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  const extension = path.extname(normalized).toLowerCase();
  if (!privateKeyContainerExtensions.has(extension)) return null;

  // The file's existence is the finding. Its bytes are deliberately never read,
  // hashed or echoed: length=0 records that there was no content match.
  return {
    relativePath: normalized,
    line: 1,
    column: 1,
    ruleId: 'private-key-container',
    matchLength: 0,
    matchDigest: irreversibleDigest(`private-key-container:${extension}`),
  };
}

export function scanRepository(repo = REPO) {
  const files = listCurrentTreeFiles(repo);
  const findings = [];
  let reviewedTextFiles = 0;

  for (const relativePath of files) {
    const containerFinding = privateKeyContainerFinding(relativePath);
    if (containerFinding !== null) {
      if (!exactAllowlistKeys.has(findingKey(containerFinding))) {
        findings.push(containerFinding);
      }
      continue;
    }

    const source = readTextCandidate(path.join(repo, relativePath));
    if (source === null) continue;
    reviewedTextFiles += 1;
    findings.push(...scanText(relativePath, source));
  }

  return { files, findings, reviewedTextFiles };
}

export function formatFindings(findings) {
  return findings
    .map((finding) => (
      `${finding.relativePath}:${finding.line}:${finding.column} `
      + `[${finding.ruleId}] length=${finding.matchLength} digest=${finding.matchDigest}`
    ))
    .join('\n');
}

export function assertNoPrivacyFindings(findings) {
  if (findings.length === 0) return;
  throw new Error(
    `current-tree privacy scan failed (${findings.length} finding(s)):\n`
    + formatFindings(findings),
  );
}

export function verifySyntheticGolden(repo = REPO) {
  const goldenPath = path.join(repo, 'tests', 'golden', 'trades-fixture.json');
  if (!fs.existsSync(goldenPath)) {
    let packageJson;
    let manifest;
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
      manifest = JSON.parse(fs.readFileSync(path.join(repo, 'PUBLIC-STAGING-MANIFEST.json'), 'utf8'));
    } catch {
      assert.fail('public golden fixture is required outside an exported candidate layout');
    }
    const releaseMode = manifest?.provenance?.mode === 'release'
      && manifest?.provenance?.releaseEligible === true;
    const testMode = manifest?.provenance?.mode === 'non-release-test'
      && manifest?.provenance?.releaseEligible === false;
    assert.equal(packageJson?.name, 'review-workbench-open-candidate');
    assert.equal(manifest?.format, 'rv-public-staging-manifest/1');
    assert.equal(manifest?.sourcePolicy, 'exact-allowlist-current-files-no-history');
    assert.equal(manifest?.provenance?.format, 'rv-public-staging-provenance/1');
    assert.equal(releaseMode || testMode, true);
    assert.ok(Array.isArray(manifest?.files));
    assert.equal(manifest.files.some((entry) => entry?.path === 'tests/golden/trades-fixture.json'), false);
    assert.equal(manifest.files.some((entry) => entry?.path === 'scripts/verify-repository-privacy.mjs'), true);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  assert.equal(golden.synthetic, true, 'public golden fixture must be explicitly synthetic');
  assert.equal(golden.format, 'rv-synthetic-trades/1');
}

function main() {
  const { files, findings, reviewedTextFiles } = scanRepository(REPO);
  verifySyntheticGolden(REPO);
  assertNoPrivacyFindings(findings);
  console.log(
    `✓ current-tree privacy scan passed `
    + `(${reviewedTextFiles} text files / ${files.length} active paths reviewed)`,
  );
  console.log('  scopes: secrets + machine paths = full active tree; maintainer profile = public candidates');
  console.log('  boundary: full Git-history and allowlist-only public export remain mandatory WP13 gates');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
