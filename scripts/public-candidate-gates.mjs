import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assertNoPrivacyFindings,
  decodeTextCandidate,
  formatFindings,
  scanRepository,
  scanText,
} from './verify-repository-privacy.mjs';

const SPDX_VERSION = 'SPDX-2.3';
const GENERATOR_VERSION = 'review-workbench-public-compliance/2.0.0';
const RELEASE_NAME = 'player1314520';
const RELEASE_EMAIL = '168609221+player1314520@users.noreply.github.com';
const PUBLIC_ROOT_SUBJECT = 'Review Workbench public candidate root';
const MAX_HISTORY_BLOB_BYTES = 5 * 1024 * 1024;
const FORBIDDEN_HISTORY_EXTENSIONS = new Set(['.jks', '.keystore', '.p12', '.pem', '.pfx']);
const RUNTIME_DEPENDENCY_COORDINATES = Object.freeze([
  'cookie@1.1.1',
  'js-tokens@4.0.0',
  'loose-envify@1.4.0',
  'react@18.3.1',
  'react-dom@18.3.1',
  'react-router@7.18.2',
  'react-router-dom@7.18.2',
  'scheduler@0.23.2',
  'set-cookie-parser@2.7.2',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`unsupported quoted YAML scalar: ${trimmed}`);
    }
  }
  return trimmed;
}

function splitCoordinate(value) {
  const withoutPeers = value.replace(/\(.*/, '');
  const separator = withoutPeers.lastIndexOf('@');
  if (separator <= 0 || separator === withoutPeers.length - 1) {
    fail(`unsupported pnpm package coordinate: ${value}`);
  }
  return {
    coordinate: withoutPeers,
    name: withoutPeers.slice(0, separator),
    version: withoutPeers.slice(separator + 1),
  };
}

function parseIntegrity(value, coordinate) {
  const match = value.match(/^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/);
  if (!match) fail(`unsupported integrity for ${coordinate}`);
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) fail(`empty integrity for ${coordinate}`);
  return { algorithm: match[1].toUpperCase(), checksumValue: bytes.toString('hex') };
}

function parseLockPackages(lockText) {
  const lines = lockText.split(/\r?\n/);
  const packages = [];
  let inPackages = false;
  let current = null;

  function finishCurrent() {
    if (current === null) return;
    if (current.checksum === null) fail(`lock package has no integrity: ${current.coordinate}`);
    packages.push(Object.freeze(current));
    current = null;
  }

  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      if (inPackages) fail('pnpm lockfile contains duplicate packages sections');
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line)) {
      finishCurrent();
      break;
    }
    const packageMatch = line.match(/^  (\S.*):$/);
    if (packageMatch) {
      finishCurrent();
      current = { ...splitCoordinate(yamlScalar(packageMatch[1])), checksum: null };
      continue;
    }
    if (current === null) {
      if (line.trim()) fail(`unexpected pnpm packages content: ${line.trim()}`);
      continue;
    }
    const integrity = line.match(/integrity:\s*([^,}\s]+)/)?.[1];
    if (integrity) current.checksum = parseIntegrity(integrity, current.coordinate);
  }
  finishCurrent();
  if (!inPackages || packages.length === 0) fail('pnpm lockfile contains no resolved packages');
  const coordinates = new Set(packages.map((entry) => entry.coordinate));
  if (coordinates.size !== packages.length) fail('pnpm lockfile contains duplicate package coordinates');
  return packages.sort((left, right) => compareText(left.coordinate, right.coordinate));
}

function lockSectionLines(lockText, startName, endName = null) {
  const lines = lockText.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${startName}:`);
  if (start < 0) fail(`pnpm lockfile has no ${startName} section`);
  const end = endName === null
    ? lines.length
    : lines.findIndex((line, index) => index > start && line === `${endName}:`);
  if (endName !== null && end < 0) fail(`pnpm lockfile has no ${endName} section after ${startName}`);
  return lines.slice(start + 1, end);
}

function parseLockImporters(lockText) {
  const importers = new Map();
  let importer = null;
  let group = null;
  for (const line of lockSectionLines(lockText, 'importers', 'packages')) {
    const importerMatch = line.match(/^  (\S.*?):(?: \{\})?$/);
    if (importerMatch) {
      importer = yamlScalar(importerMatch[1]);
      group = null;
      if (importers.has(importer)) fail(`duplicate lock importer ${importer}`);
      importers.set(importer, new Map());
      continue;
    }
    const groupMatch = line.match(/^    (dependencies|devDependencies|optionalDependencies):$/);
    if (groupMatch) {
      if (importer === null) fail('lock dependency group appears before an importer');
      group = groupMatch[1];
      continue;
    }
    const dependencyMatch = group && line.match(/^      (\S.*):$/);
    if (dependencyMatch) {
      const name = yamlScalar(dependencyMatch[1]);
      if (importers.get(importer).has(name)) fail(`duplicate importer dependency ${importer}:${name}`);
      importers.get(importer).set(name, { group, version: null });
      continue;
    }
    const versionMatch = group && line.match(/^        version:\s*(\S.*)$/);
    if (versionMatch) {
      const latest = [...importers.get(importer).values()].at(-1);
      if (!latest) fail(`lock dependency version appears without a dependency in ${importer}`);
      latest.version = yamlScalar(versionMatch[1]);
    }
  }
  for (const [importerName, dependencies] of importers) {
    for (const [dependencyName, metadata] of dependencies) {
      if (metadata.version === null) fail(`lock dependency is unresolved: ${importerName}:${dependencyName}`);
    }
  }
  return importers;
}

function parseSnapshotRelationships(lockText, knownCoordinates) {
  const relationships = [];
  let owner = null;
  let group = null;
  for (const line of lockSectionLines(lockText, 'snapshots')) {
    const ownerMatch = line.match(/^  (\S.*?):(?: \{\})?$/);
    if (ownerMatch) {
      owner = splitCoordinate(yamlScalar(ownerMatch[1])).coordinate;
      if (!knownCoordinates.has(owner)) fail(`snapshot has no packages entry: ${owner}`);
      group = null;
      continue;
    }
    const groupMatch = line.match(/^    (dependencies|optionalDependencies):$/);
    if (groupMatch) {
      if (owner === null) fail('snapshot dependency group appears before an owner');
      group = groupMatch[1];
      continue;
    }
    if (/^    \S.*:$/.test(line)) {
      group = null;
      continue;
    }
    const dependencyMatch = group && line.match(/^      (\S.*?):\s+(\S.*)$/);
    if (!dependencyMatch) continue;
    const name = yamlScalar(dependencyMatch[1]);
    const version = yamlScalar(dependencyMatch[2]);
    if (version.startsWith('link:')) continue;
    const dependency = splitCoordinate(`${name}@${version}`).coordinate;
    if (!knownCoordinates.has(dependency)) fail(`snapshot dependency has no package entry: ${owner} -> ${dependency}`);
    relationships.push({ from: owner, to: dependency });
  }
  return relationships;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `${encodeURIComponent(name.split('/')[0])}/${encodeURIComponent(name.split('/').slice(1).join('/'))}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function spdxId(kind, value) {
  return `SPDXRef-${kind}-${sha256(`${kind}\0${value}`).slice(0, 20)}`;
}

function detectLayout(root) {
  const rootManifestPath = path.join(root, 'package.json');
  if (!fs.existsSync(rootManifestPath)) fail('candidate compliance root package.json is missing');
  const manifest = parseJson(fs.readFileSync(rootManifestPath, 'utf8'), 'package.json');
  return manifest.name === 'review-workbench-open-candidate' ? 'candidate' : 'source';
}

function compliancePaths(root, layout) {
  const selected = layout === 'auto' ? detectLayout(root) : layout;
  if (!['source', 'candidate'].includes(selected)) fail('compliance layout must be source, candidate, or auto');
  const publicPrefix = selected === 'source' ? 'public-staging' : '';
  const relative = (...segments) => path.join(root, ...segments.filter(Boolean));
  return Object.freeze({
    layout: selected,
    inputs: Object.freeze({
      rootManifest: relative(publicPrefix, 'package.json'),
      appManifest: relative('app', 'package.json'),
      engineManifest: relative(publicPrefix, 'frontend-package.json'),
      candidateEngineManifest: relative('frontend', 'package.json'),
      lockfile: relative('pnpm-lock.yaml'),
      license: relative('LICENSE'),
      runtimeInventory: selected === 'source'
        ? relative(publicPrefix, 'runtime-dependency-licenses.json')
        : relative('RUNTIME-DEPENDENCY-LICENSES.json'),
      runtimeLicenses: selected === 'source'
        ? relative(publicPrefix, 'RUNTIME-LICENSES.md')
        : relative('LICENSES', 'RUNTIME-DEPENDENCIES.md'),
    }),
    outputs: Object.freeze({
      sbom: relative(publicPrefix, 'sbom.spdx.json'),
      notice: relative(publicPrefix, 'THIRD_PARTY_NOTICES.md'),
      licenseReadme: selected === 'source'
        ? relative(publicPrefix, 'LICENSES-README.md')
        : relative('LICENSES', 'README.md'),
      license: relative('LICENSES', 'AGPL-3.0-only.txt'),
    }),
  });
}

function readRequired(absolutePath, label) {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-link file`);
    return fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && /must be a regular/.test(error.message)) throw error;
    fail(`${label} is missing`);
  }
}

function readRequiredBytes(absolutePath, label) {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-link file`);
    return fs.readFileSync(absolutePath);
  } catch (error) {
    if (error instanceof Error && /must be a regular/.test(error.message)) throw error;
    fail(`${label} is missing`);
  }
}

function workspacePackage(manifest, role, workspacePath) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`${role} manifest must be an object`);
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) fail(`${role} manifest needs a package name`);
  if (manifest.private !== true) fail(`${role} manifest must remain private:true`);
  if (manifest.license !== undefined && manifest.license !== 'AGPL-3.0-only') {
    fail(`${role} manifest license conflicts with AGPL-3.0-only candidate policy`);
  }
  const declaredLicense = manifest.license === 'AGPL-3.0-only' ? 'AGPL-3.0-only' : 'NOASSERTION';
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    role,
    workspacePath,
    declaredLicense,
  };
}

function resolveRuntimeLicenses(inventoryText, runtimeLicenseText, lockByCoordinate) {
  const inventory = parseJson(inventoryText, 'runtime dependency license inventory');
  if (inventory.format !== 'rv-runtime-dependency-licenses/1') fail('runtime license inventory format is unsupported');
  if (inventory.source !== 'https://registry.npmjs.org/') fail('runtime license inventory must identify the npm registry source');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inventory.verifiedAt ?? '')) fail('runtime license inventory date is invalid');
  if (!Array.isArray(inventory.packages)) fail('runtime license inventory packages are missing');
  const coordinates = inventory.packages.map((entry) => `${entry?.name}@${entry?.version}`);
  if (JSON.stringify(coordinates) !== JSON.stringify(RUNTIME_DEPENDENCY_COORDINATES)) {
    fail('runtime license inventory does not match the reviewed browser dependency closure');
  }
  const resolved = new Map();
  for (const entry of inventory.packages) {
    const coordinate = `${entry.name}@${entry.version}`;
    if (entry.license !== 'MIT') fail(`runtime dependency license is unresolved: ${coordinate}`);
    const lockEntry = lockByCoordinate.get(coordinate);
    if (!lockEntry) fail(`runtime dependency is absent from the frozen lockfile: ${coordinate}`);
    const expected = parseIntegrity(entry.integrity, coordinate);
    if (
      expected.algorithm !== lockEntry.checksum.algorithm
      || expected.checksumValue !== lockEntry.checksum.checksumValue
    ) fail(`runtime dependency integrity differs from the frozen lockfile: ${coordinate}`);
    if (!runtimeLicenseText.includes(`\`${coordinate}\``)) fail(`runtime license text does not name ${coordinate}`);
    resolved.set(coordinate, Object.freeze({ license: entry.license }));
  }
  return resolved;
}

export function generatePublicCompliance({ root, layout = 'auto' } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('candidate compliance root must be absolute');
  const paths = compliancePaths(root, layout);
  const rootManifestText = readRequired(paths.inputs.rootManifest, 'public root package.json');
  const appManifestText = readRequired(paths.inputs.appManifest, 'app package.json');
  const engineManifestPath = paths.layout === 'source'
    ? paths.inputs.engineManifest
    : paths.inputs.candidateEngineManifest;
  const engineManifestText = readRequired(engineManifestPath, 'engine package.json');
  const lockText = readRequired(paths.inputs.lockfile, 'pnpm-lock.yaml');
  const license = readRequired(paths.inputs.license, 'LICENSE');
  const rootManifest = parseJson(rootManifestText, 'public root package.json');
  const appManifest = parseJson(appManifestText, 'app package.json');
  const hasBrowserRuntime = Object.keys(appManifest.dependencies ?? {}).length > 0;
  const runtimeInventoryText = hasBrowserRuntime
    ? readRequired(paths.inputs.runtimeInventory, 'runtime dependency license inventory')
    : '';
  const runtimeLicenseText = hasBrowserRuntime
    ? readRequired(paths.inputs.runtimeLicenses, 'runtime dependency license text')
    : '';
  if (rootManifest.license !== 'AGPL-3.0-only') fail('public root license must be AGPL-3.0-only');
  const workspaces = [
    workspacePackage(rootManifest, 'application', '.'),
    workspacePackage(appManifest, 'application-component', 'app'),
    workspacePackage(parseJson(engineManifestText, 'engine package.json'), 'library', 'frontend'),
  ];
  const lockPackages = parseLockPackages(lockText);
  const lockByCoordinate = new Map(lockPackages.map((entry) => [entry.coordinate, entry]));
  const runtimeLicenses = hasBrowserRuntime
    ? resolveRuntimeLicenses(runtimeInventoryText, runtimeLicenseText, lockByCoordinate)
    : new Map();
  const importers = parseLockImporters(lockText);
  const snapshotRelationships = parseSnapshotRelationships(lockText, new Set(lockByCoordinate.keys()));
  const inputDigest = sha256([
    `package.json\0${rootManifestText}`,
    `app/package.json\0${appManifestText}`,
    `frontend/package.json\0${engineManifestText}`,
    `pnpm-lock.yaml\0${lockText}`,
    `LICENSE\0${license}`,
    `RUNTIME-DEPENDENCY-LICENSES.json\0${runtimeInventoryText}`,
    `LICENSES/RUNTIME-DEPENDENCIES.md\0${runtimeLicenseText}`,
  ].join('\0'));

  const packages = [];
  const relationships = [];
  const relationshipKeys = new Set();
  const workspaceIds = new Map();
  const lockIds = new Map();
  const addRelationship = (SPDXElementId, relationshipType, relatedSpdxElement) => {
    const key = `${SPDXElementId}\0${relationshipType}\0${relatedSpdxElement}`;
    if (relationshipKeys.has(key)) return;
    relationshipKeys.add(key);
    relationships.push({ SPDXElementId, relationshipType, relatedSpdxElement });
  };
  for (const workspace of workspaces) {
    const SPDXID = spdxId('Workspace', workspace.name);
    workspaceIds.set(workspace.workspacePath, SPDXID);
    const entry = {
      name: workspace.name,
      SPDXID,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: workspace.declaredLicense,
      licenseDeclared: workspace.declaredLicense,
      copyrightText: 'NOASSERTION',
      primaryPackagePurpose: workspace.role === 'library' ? 'LIBRARY' : 'APPLICATION',
    };
    if (workspace.version !== null) entry.versionInfo = workspace.version;
    packages.push(entry);
    addRelationship('SPDXRef-DOCUMENT', 'DESCRIBES', SPDXID);
  }
  for (const dependency of lockPackages) {
    const SPDXID = spdxId('Pnpm', dependency.coordinate);
    const runtimeLicense = runtimeLicenses.get(dependency.coordinate)?.license ?? 'NOASSERTION';
    lockIds.set(dependency.coordinate, SPDXID);
    packages.push({
      name: dependency.name,
      SPDXID,
      versionInfo: dependency.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      checksums: [dependency.checksum],
      licenseConcluded: runtimeLicense,
      licenseDeclared: runtimeLicense,
      copyrightText: 'NOASSERTION',
      primaryPackagePurpose: 'LIBRARY',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPurl(dependency.name, dependency.version),
      }],
      comment: runtimeLicense === 'NOASSERTION'
        ? 'Build/test dependency recorded from the frozen lockfile; it is not part of the reviewed browser runtime closure.'
        : 'Browser runtime dependency; npm integrity and included MIT license text are bound by the reviewed runtime inventory.',
    });
  }
  addRelationship(workspaceIds.get('.'), 'CONTAINS', workspaceIds.get('app'));
  addRelationship(workspaceIds.get('.'), 'CONTAINS', workspaceIds.get('frontend'));
  const workspaceNameToPath = new Map(workspaces.map((workspace) => [workspace.name, workspace.workspacePath]));
  for (const [importerPath, dependencies] of importers) {
    const ownerId = workspaceIds.get(importerPath);
    if (!ownerId) fail(`lockfile contains an unexpected workspace importer: ${importerPath}`);
    for (const [dependencyName, metadata] of dependencies) {
      if (metadata.version.startsWith('link:')) {
        const dependencyPath = workspaceNameToPath.get(dependencyName);
        if (!dependencyPath) fail(`lock importer links an unknown workspace: ${importerPath}:${dependencyName}`);
        addRelationship(ownerId, 'DEPENDS_ON', workspaceIds.get(dependencyPath));
        continue;
      }
      const coordinate = splitCoordinate(`${dependencyName}@${metadata.version}`).coordinate;
      const dependencyId = lockIds.get(coordinate);
      if (!dependencyId) fail(`lock importer dependency has no package entry: ${importerPath}:${coordinate}`);
      addRelationship(ownerId, 'DEPENDS_ON', dependencyId);
    }
  }
  for (const relationship of snapshotRelationships) {
    addRelationship(lockIds.get(relationship.from), 'DEPENDS_ON', lockIds.get(relationship.to));
  }
  packages.sort((left, right) => compareText(left.SPDXID, right.SPDXID));
  relationships.sort((left, right) => (
    compareText(left.SPDXElementId, right.SPDXElementId)
    || compareText(left.relationshipType, right.relationshipType)
    || compareText(left.relatedSpdxElement, right.relatedSpdxElement)
  ));
  const sbomObject = {
    spdxVersion: SPDX_VERSION,
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: 'review-workbench-open-candidate-sbom',
    documentNamespace: `https://spdx.org/spdxdocs/review-workbench-open-${inputDigest}`,
    documentComment: [
      'Honest boundaries:',
      '1. The nine-package browser runtime closure is integrity-bound to the exact lockfile and carries included MIT license text; build/test-only packages remain NOASSERTION in this offline inventory.',
      '2. This offline generator does not query vulnerability databases and does not establish that any dependency is vulnerability-free.',
      '3. SPDX generation, tests, and privacy scans do not authorize publication, deployment, repository creation, visibility changes, or redistribution.',
      '4. The fixed creation time is for deterministic bytes and is not a wall-clock attestation.',
    ].join('\n'),
    creationInfo: {
      created: '1970-01-01T00:00:00Z',
      creators: [`Tool: ${GENERATOR_VERSION}`],
      comment: 'The content-derived namespace binds the exact approved offline inputs.',
    },
    packages,
    relationships,
  };
  const noticeLines = [
    '# Candidate-specific third-party notices',
    '',
    `Candidate compliance input SHA-256: \`${inputDigest}\`.`,
    '',
    'The dependency coordinates below are derived from this candidate\'s exact `pnpm-lock.yaml`. The browser runtime closure',
    'is marked `MIT` only when its reviewed npm integrity matches the lockfile and its license text is included in',
    '`LICENSES/RUNTIME-DEPENDENCIES.md`. Build/test-only packages remain `NOASSERTION` because their code is fetched by',
    'contributors and CI but is not copied into the deployed browser artifact.',
    '',
    '| Package | Scope | Integrity | License |',
    '| --- | --- | --- | --- |',
    ...lockPackages.map((entry) => (
      `| \`${entry.coordinate.replaceAll('|', '\\|')}\` | ${runtimeLicenses.has(entry.coordinate) ? 'browser runtime' : 'build/test only'} | ${entry.checksum.algorithm}:${entry.checksum.checksumValue} | ${runtimeLicenses.get(entry.coordinate)?.license ?? 'NOASSERTION'} |`
    )),
    '',
    'Security findings must be sent only through a private vulnerability-reporting channel already confirmed with the',
    'maintainer. Do not post credentials, personal data, account evidence, or exploit details in a public issue.',
    '',
    '## Honest boundaries',
    '',
    '1. This inventory does not replace review of upstream copyright and license files.',
    '2. A lockfile integrity hash proves package-byte identity only; it does not prove safety, provenance, or legal clearance.',
    '3. No vulnerability database or package registry was contacted while generating this notice.',
    '4. This inventory is not legal advice and does not create a vulnerability-response SLA.',
    '',
  ];
  const licenseReadme = [
    '# Candidate license packet',
    '',
    '`AGPL-3.0-only.txt` is a byte-for-byte copy of the candidate root `LICENSE` and covers the candidate source under',
    '`AGPL-3.0-only`. `RUNTIME-DEPENDENCIES.md` contains the reviewed MIT notices for all nine packages in the deployed',
    'browser runtime closure. Their versions and npm integrity hashes are bound by `../RUNTIME-DEPENDENCY-LICENSES.json`.',
    'Other lockfile entries are build/test-only tools and remain `NOASSERTION`; their code is not copied into `app/dist`.',
    '',
    'Honest boundaries:',
    '',
    '1. This packet is not legal advice.',
    '2. It does not grant a commercial license or permission beyond the included license text.',
    '3. A future runtime dependency change must update the frozen closure, integrity inventory, and included license text.',
    '',
  ].join('\n');
  return Object.freeze({
    sbom: `${JSON.stringify(sbomObject, null, 2)}\n`,
    notice: noticeLines.join('\n'),
    licenseReadme,
    license,
    inputSha256: inputDigest,
    packageCount: lockPackages.length,
  });
}

export function writePublicCompliance({ root, layout = 'auto' } = {}) {
  const paths = compliancePaths(root, layout);
  const output = generatePublicCompliance({ root, layout: paths.layout });
  fs.mkdirSync(path.dirname(paths.outputs.sbom), { recursive: true });
  fs.mkdirSync(path.dirname(paths.outputs.notice), { recursive: true });
  fs.mkdirSync(path.dirname(paths.outputs.licenseReadme), { recursive: true });
  fs.writeFileSync(paths.outputs.sbom, output.sbom, 'utf8');
  fs.writeFileSync(paths.outputs.notice, output.notice, 'utf8');
  fs.writeFileSync(paths.outputs.licenseReadme, output.licenseReadme, 'utf8');
  if (paths.layout === 'candidate') {
    fs.mkdirSync(path.dirname(paths.outputs.license), { recursive: true });
    fs.writeFileSync(paths.outputs.license, output.license, 'utf8');
  }
  return Object.freeze({ packageCount: output.packageCount, inputSha256: output.inputSha256 });
}

export function verifyPublicCompliance({ root, layout = 'auto' } = {}) {
  const paths = compliancePaths(root, layout);
  const expected = generatePublicCompliance({ root, layout: paths.layout });
  const checks = [
    [paths.outputs.sbom, expected.sbom, 'SPDX SBOM'],
    [paths.outputs.notice, expected.notice, 'third-party notice'],
    [paths.outputs.licenseReadme, expected.licenseReadme, 'license packet README'],
  ];
  if (paths.layout === 'candidate') checks.push([paths.outputs.license, expected.license, 'AGPL license packet']);
  for (const [absolutePath, expectedBytes, label] of checks) {
    if (!fs.existsSync(absolutePath)) fail(`${label} is missing`);
    if (fs.readFileSync(absolutePath, 'utf8') !== expectedBytes) fail(`${label} is out of date or has drifted`);
  }
  return Object.freeze({ packageCount: expected.packageCount, inputSha256: expected.inputSha256 });
}

function runGit(root, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const result = spawnSync('git', [
    '--no-replace-objects',
    '-c', 'core.fsmonitor=false',
    '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0',
    '-C', root,
    ...args,
  ], {
    encoding,
    env: {
      ...env,
      GIT_CONFIG_GLOBAL: nullConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) fail(`Git history inspection failed for ${args[0]}`);
  return result;
}

function assertNoPromisorConfiguration(root) {
  const result = runGit(root, ['config', '--includes', '--null', '--name-only', '--list'], {
    encoding: 'buffer',
    allowFailure: true,
  });
  if (result.status !== 0) fail('candidate local Git configuration cannot be inspected safely');
  const keys = result.stdout.toString('utf8').split('\0').filter(Boolean).map((value) => value.toLowerCase());
  if (keys.some((key) => (
    key === 'extensions.partialclone'
    || /^remote\..+\.(promisor|partialclonefilter)$/.test(key)
  ))) {
    fail('candidate repository uses partial clone or promisor configuration; lazy object fetch is forbidden');
  }
}

function assertRepositoryRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('candidate history root must be absolute');
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    fail('candidate history root is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('candidate history root must be a regular directory');
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') fail('candidate history requires an initialized Git repository');
  assertNoPromisorConfiguration(root);
}

function historyObjectRows(root) {
  const output = runGit(root, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname) %(objecttype) %(objectsize)',
  ]).stdout;
  const rows = String(output).trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{40,64}) (blob|commit|tag|tree) (\d+)$/);
    if (!match) fail('Git returned an unsupported object inventory row');
    return { id: match[1], type: match[2], size: Number(match[3]) };
  });
  if (rows.length === 0) fail('candidate Git repository contains no objects');
  return rows.sort((left, right) => compareText(left.id, right.id));
}

function reachableObjectPaths(root) {
  const result = runGit(root, ['rev-list', '--all', '--objects']).stdout;
  const paths = new Map();
  for (const line of String(result).split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{40,64})(?: (.+))?$/);
    if (!match || !match[2]) continue;
    const values = paths.get(match[1]) ?? [];
    values.push(match[2].replaceAll('\\', '/'));
    paths.set(match[1], values);
  }
  return paths;
}

function commitIdentities(raw, objectId) {
  const header = raw.split('\n\n', 1)[0];
  const identities = [];
  for (const role of ['author', 'committer']) {
    const line = header.split('\n').find((value) => value.startsWith(`${role} `));
    const match = line?.match(new RegExp(`^${role} (.+) <([^>]+)> \\d+ [+-]\\d{4}$`));
    if (!match) fail(`Git ${role} identity is malformed for commit ${objectId.slice(0, 12)}`);
    identities.push({ role, name: match[1], email: match[2] });
  }
  return identities;
}

function identityFinding(role, identity, objectType, objectId) {
  if (identity.name === RELEASE_NAME && identity.email === RELEASE_EMAIL) return null;
  return {
    relativePath: `git-history/${objectType}/${objectId.slice(0, 12)}`,
    line: 1,
    column: 1,
    ruleId: `${role}-identity-not-public-noreply`,
    matchLength: 0,
    matchDigest: `sha256:${sha256(`${identity.name}\0${identity.email}`).slice(0, 12)}`,
  };
}

export function scanCandidateHistory(root, {
  expectedSourceCommit = null,
  requireIndependentRoot = false,
} = {}) {
  assertRepositoryRoot(root);
  if (typeof requireIndependentRoot !== 'boolean') fail('independent-root history policy must be boolean');
  const replaceRefs = String(runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/']).stdout)
    .split(/\r?\n/)
    .filter(Boolean);
  if (replaceRefs.length > 0) {
    fail('candidate repository contains a Git replace ref; replacement objects are forbidden');
  }
  const shallow = String(runGit(root, ['rev-parse', '--is-shallow-repository']).stdout).trim();
  if (shallow !== 'false') fail('candidate full-history verification rejects a shallow repository');
  const alternatesOutput = String(runGit(root, ['rev-parse', '--git-path', 'objects/info/alternates']).stdout).trim();
  const alternatesPath = path.isAbsolute(alternatesOutput) ? alternatesOutput : path.resolve(root, alternatesOutput);
  if (alternatesPath && fs.existsSync(alternatesPath) && fs.readFileSync(alternatesPath, 'utf8').trim()) {
    fail('candidate repository uses an alternate object store and is not independent');
  }
  if (expectedSourceCommit !== null && !/^[a-f0-9]{40,64}$/.test(expectedSourceCommit)) {
    fail('expected source commit must be a full hexadecimal object id');
  }
  if (expectedSourceCommit !== null) {
    const inherited = runGit(root, ['cat-file', '-e', `${expectedSourceCommit}^{commit}`], { allowFailure: true });
    if (inherited.status === 0) fail('candidate repository contains the private source commit and is not independent');
  }

  const reachableCommits = String(runGit(root, ['rev-list', '--all']).stdout).trim().split(/\r?\n/).filter(Boolean);
  if (reachableCommits.length === 0) fail('candidate repository has no reachable commit');
  const rootCommits = String(runGit(root, ['rev-list', '--max-parents=0', '--all']).stdout)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const pathsByObject = reachableObjectPaths(root);
  const objects = historyObjectRows(root);
  const findings = [];
  let blobCount = 0;
  let commitCount = 0;
  let tagCount = 0;
  let treeCount = 0;
  const commitParentCounts = new Map();

  for (const object of objects) {
    if (object.type === 'commit') {
      commitCount += 1;
      const raw = String(runGit(root, ['cat-file', '-p', object.id]).stdout);
      const header = raw.split('\n\n', 1)[0];
      commitParentCounts.set(
        object.id,
        header.split('\n').filter((line) => /^parent [a-f0-9]{40,64}$/.test(line)).length,
      );
      for (const identity of commitIdentities(raw, object.id)) {
        const finding = identityFinding(identity.role, identity, 'commit', object.id);
        if (finding !== null) findings.push(finding);
      }
      findings.push(...scanText(`git-history/commit/${object.id}`, raw));
      continue;
    }
    if (object.type === 'tag') {
      tagCount += 1;
      const raw = String(runGit(root, ['cat-file', '-p', object.id]).stdout);
      const line = raw.split('\n').find((value) => value.startsWith('tagger '));
      const match = line?.match(/^tagger (.+) <([^>]+)> \d+ [+-]\d{4}$/);
      if (!match) fail(`Git tagger identity is malformed for tag ${object.id.slice(0, 12)}`);
      const finding = identityFinding('tagger', { name: match[1], email: match[2] }, 'tag', object.id);
      if (finding !== null) findings.push(finding);
      findings.push(...scanText(`git-history/tag/${object.id}`, raw));
      continue;
    }
    if (object.type === 'tree') {
      treeCount += 1;
      const bytes = runGit(root, ['ls-tree', '-z', object.id], { encoding: null }).stdout;
      const rows = bytes.toString('utf8').split('\0').filter(Boolean);
      for (let index = 0; index < rows.length; index += 1) {
        const separator = rows[index].indexOf('\t');
        if (separator < 0) fail(`Git tree metadata is malformed for tree ${object.id.slice(0, 12)}`);
        const entryName = rows[index].slice(separator + 1);
        if (entryName.includes('\uFFFD')) {
          findings.push({
            relativePath: `git-history/tree/${object.id.slice(0, 12)}/entry-${index + 1}`,
            line: 1,
            column: 1,
            ruleId: 'non-utf8-tree-entry-name',
            matchLength: 0,
            matchDigest: `sha256:${sha256(bytes).slice(0, 12)}`,
          });
          continue;
        }
        findings.push(...scanText(
          `git-history/tree/${object.id}/entry-${index + 1}`,
          entryName,
        ));
      }
      continue;
    }
    if (object.type !== 'blob') continue;
    blobCount += 1;
    if (!Number.isSafeInteger(object.size) || object.size > MAX_HISTORY_BLOB_BYTES) {
      findings.push({
        relativePath: `git-history/blob/${object.id.slice(0, 12)}`,
        line: 1,
        column: 1,
        ruleId: 'history-blob-too-large',
        matchLength: 0,
        matchDigest: `sha256:${sha256(String(object.size)).slice(0, 12)}`,
      });
      continue;
    }
    const bytes = runGit(root, ['cat-file', 'blob', object.id], { encoding: 'buffer' }).stdout;
    const objectPaths = pathsByObject.get(object.id) ?? [`object-${object.id.slice(0, 12)}`];
    if (objectPaths.some((relativePath) => FORBIDDEN_HISTORY_EXTENSIONS.has(path.posix.extname(relativePath.toLowerCase())))) {
      findings.push({
        relativePath: `git-history/blob/${object.id.slice(0, 12)}`,
        line: 1,
        column: 1,
        ruleId: 'private-key-container',
        matchLength: 0,
        matchDigest: `sha256:${sha256(object.id).slice(0, 12)}`,
      });
      continue;
    }
    const text = decodeTextCandidate(bytes);
    if (text === null) {
      findings.push({
        relativePath: `git-history/blob/${object.id.slice(0, 12)}`,
        line: 1,
        column: 1,
        ruleId: 'binary-history-blob',
        matchLength: 0,
        matchDigest: `sha256:${sha256(object.id).slice(0, 12)}`,
      });
      continue;
    }
    for (const relativePath of objectPaths) {
      findings.push(...scanText(`git-history/blob/${object.id}/${relativePath}`, text));
    }
  }
  if (commitCount === 0 || blobCount === 0) fail('candidate history lacks commits or blobs');
  if (findings.length > 0) {
    fail(`candidate full-history privacy scan failed (${findings.length} finding(s)):\n${formatFindings(findings)}`);
  }
  let independentRootCommit = null;
  if (requireIndependentRoot) {
    const reachableSet = new Set(reachableCommits);
    const objectCommitIds = [...commitParentCounts.keys()];
    if (
      rootCommits.length !== 1
      || commitCount !== reachableCommits.length
      || objectCommitIds.some((objectId) => !reachableSet.has(objectId))
      || commitParentCounts.get(rootCommits[0]) !== 0
    ) {
      fail('candidate release repository must have one independent root and no unreachable commit history');
    }
    independentRootCommit = rootCommits[0];
  }
  return Object.freeze({
    objectCount: objects.length,
    commitCount,
    blobCount,
    tagCount,
    treeCount,
    reachableCommitCount: reachableCommits.length,
    independentRootCommit,
  });
}

function candidateEntriesSha256(files) {
  const digest = crypto.createHash('sha256').update('rv-public-candidate-tree/1\0');
  for (const entry of files) {
    digest.update(entry.path).update('\0').update(String(entry.bytes)).update('\0').update(entry.sha256).update('\0');
  }
  return digest.digest('hex');
}

function validateCandidateManifest(manifest, label) {
  if (manifest?.format !== 'rv-public-staging-manifest/1') fail(`${label} format is missing or unsupported`);
  if (!['not_distributed', 'distributed'].includes(manifest.distributionStatus)) {
    fail(`${label} distribution status is unsupported`);
  }
  const provenance = manifest.provenance;
  if (provenance?.format !== 'rv-public-staging-provenance/1') fail(`${label} provenance format is missing or unsupported`);
  if (provenance.mode !== 'release' || provenance.releaseEligible !== true || provenance.source?.clean !== true) {
    fail(`${label} is non-release or does not carry clean source evidence`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(provenance.source.commit ?? '')) fail(`${label} source commit is missing`);
  if (!/^[a-f0-9]{40,64}$/.test(provenance.source.gitTree ?? '')) fail(`${label} source Git tree is missing`);
  if (!/^[a-f0-9]{64}$/.test(provenance.source.treeSha256 ?? '')) fail(`${label} source tree SHA-256 is missing`);
  if (!/^[a-f0-9]{64}$/.test(provenance.allowlistSha256 ?? '')) fail(`${label} allowlist SHA-256 is missing`);
  if (!/^[a-f0-9]{64}$/.test(provenance.candidateSha256 ?? '')) fail(`${label} candidate SHA-256 is missing`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(`${label} files are missing`);
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} contains an invalid file entry`);
    const relativePath = entry.path;
    if (
      typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath === 'PUBLIC-STAGING-MANIFEST.json'
      || relativePath.includes('\\')
      || relativePath.includes(':')
      || relativePath.includes('\0')
      || relativePath.startsWith('/')
      || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
      || path.posix.normalize(relativePath) !== relativePath
    ) fail(`${label} contains an unsafe file path`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`${label} contains an invalid byte count`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) fail(`${label} contains an invalid file SHA-256`);
  }
  const sortedPaths = manifest.files.map((entry) => entry.path);
  if (JSON.stringify(sortedPaths) !== JSON.stringify([...sortedPaths].sort(compareText))) fail(`${label} files are not sorted`);
  if (new Set(sortedPaths).size !== sortedPaths.length) fail(`${label} files are duplicated`);
  return { provenance, sortedPaths };
}

function gitTreePaths(root, revision) {
  const rows = String(runGit(root, ['ls-tree', '-r', '-z', revision]).stdout).split('\0').filter(Boolean);
  return rows.map((row) => {
    const match = row.match(/^(100644|100755) blob [a-f0-9]{40,64}\t(.+)$/);
    if (!match) fail(`candidate ${revision} contains a non-regular file or unsupported Git mode`);
    return match[2];
  }).sort(compareText);
}

function gitBlob(root, revision, relativePath) {
  return runGit(root, ['cat-file', 'blob', `${revision}:${relativePath}`], { encoding: null }).stdout;
}

function verifyIndependentRootSnapshot(root, rootCommit) {
  if (!/^[a-f0-9]{40,64}$/.test(rootCommit ?? '')) fail('candidate independent root commit is missing');
  const rawCommit = String(runGit(root, ['cat-file', '-p', rootCommit]).stdout);
  const message = rawCommit.slice(rawCommit.indexOf('\n\n') + 2);
  if (message.split(/\r?\n/, 1)[0] !== PUBLIC_ROOT_SUBJECT) {
    fail(`candidate independent root subject must be exactly "${PUBLIC_ROOT_SUBJECT}"`);
  }
  const manifestBytes = gitBlob(root, rootCommit, 'PUBLIC-STAGING-MANIFEST.json');
  const manifest = parseJson(manifestBytes.toString('utf8'), 'candidate independent root manifest');
  const { provenance, sortedPaths } = validateCandidateManifest(manifest, 'candidate independent root manifest');
  const expectedTracked = [...sortedPaths, 'PUBLIC-STAGING-MANIFEST.json'].sort(compareText);
  if (JSON.stringify(gitTreePaths(root, rootCommit)) !== JSON.stringify(expectedTracked)) {
    fail('candidate independent root tree is not an exact release snapshot');
  }
  for (const entry of manifest.files) {
    const bytes = gitBlob(root, rootCommit, entry.path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      fail(`candidate independent root file digest drifted: ${entry.path}`);
    }
  }
  if (candidateEntriesSha256(manifest.files) !== provenance.candidateSha256) {
    fail('candidate independent root tree SHA-256 drifted');
  }
  const allowlistBytes = gitBlob(root, rootCommit, 'scripts/public-staging-allowlist.json');
  if (sha256(allowlistBytes) !== provenance.allowlistSha256) {
    fail('candidate independent root allowlist SHA-256 drifted');
  }
}

export function verifyPublicCandidate(root) {
  assertRepositoryRoot(root);
  verifyPublicCompliance({ root, layout: 'candidate' });
  const manifestPath = path.join(root, 'PUBLIC-STAGING-MANIFEST.json');
  const manifest = parseJson(readRequired(manifestPath, 'PUBLIC-STAGING-MANIFEST.json'), 'PUBLIC-STAGING-MANIFEST.json');
  const { provenance, sortedPaths } = validateCandidateManifest(manifest, 'candidate manifest');
  for (const entry of manifest.files) {
    const absolutePath = path.join(root, ...entry.path.split('/'));
    const bytes = readRequiredBytes(absolutePath, `candidate file ${entry.path}`);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      fail(`candidate file digest drifted: ${entry.path}`);
    }
  }
  if (candidateEntriesSha256(manifest.files) !== provenance.candidateSha256) fail('candidate tree SHA-256 drifted');
  const allowlistBytes = fs.readFileSync(path.join(root, 'scripts', 'public-staging-allowlist.json'));
  if (sha256(allowlistBytes) !== provenance.allowlistSha256) fail('candidate allowlist SHA-256 drifted');

  const status = String(runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout);
  if (status.length !== 0) fail('candidate Git worktree and index must be clean before verification');
  const tracked = gitTreePaths(root, 'HEAD');
  const expectedTracked = [...sortedPaths, 'PUBLIC-STAGING-MANIFEST.json'].sort(compareText);
  if (JSON.stringify(tracked) !== JSON.stringify(expectedTracked)) fail('candidate HEAD tree differs from the exact manifest');
  for (const relativePath of expectedTracked) {
    const head = gitBlob(root, 'HEAD', relativePath);
    const working = readRequiredBytes(path.join(root, ...relativePath.split('/')), `candidate HEAD file ${relativePath}`);
    if (!head.equals(working)) fail(`candidate HEAD bytes differ from the verified working tree: ${relativePath}`);
  }
  const currentTree = scanRepository(root);
  assertNoPrivacyFindings(currentTree.findings);
  const history = scanCandidateHistory(root, {
    expectedSourceCommit: provenance.source.commit,
    requireIndependentRoot: true,
  });
  verifyIndependentRootSnapshot(root, history.independentRootCommit);
  return Object.freeze({
    fileCount: manifest.files.length,
    currentTextFileCount: currentTree.reviewedTextFiles,
    ...history,
  });
}

function parseCli(argv) {
  if (argv.length === 0) fail('public candidate gate action is required');
  const action = argv[0];
  const options = { action, root: process.cwd(), layout: 'auto' };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--root', '--layout'].includes(argument)) fail(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  options.root = path.resolve(options.root);
  return options;
}

function main() {
  try {
    const options = parseCli(process.argv.slice(2));
    let result;
    if (options.action === '--write-compliance') {
      result = writePublicCompliance(options);
      process.stdout.write(`Generated candidate SPDX, NOTICE, and license packet (${result.packageCount} resolved packages).\n`);
      return;
    }
    if (options.action === '--check-compliance') {
      result = verifyPublicCompliance(options);
      process.stdout.write(`Candidate compliance artifacts are deterministic (${result.packageCount} resolved packages).\n`);
      return;
    }
    if (options.action === '--verify-history') {
      result = scanCandidateHistory(options.root);
      process.stdout.write(`Candidate full-history privacy scan passed (${result.commitCount} commits / ${result.blobCount} blobs).\n`);
      return;
    }
    if (options.action === '--verify-candidate') {
      result = verifyPublicCandidate(options.root);
      process.stdout.write(`Candidate release gates passed (${result.fileCount} tracked files / ${result.commitCount} commits).\n`);
      return;
    }
    fail(`unknown action ${options.action}`);
  } catch (error) {
    process.stderr.write(`public candidate gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
