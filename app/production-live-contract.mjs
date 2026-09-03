import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve one production-contract input without letting a stale private
 * materialization silently shadow the isolated canonical source. Public
 * candidates normally contain only the standard path; private source normally
 * contains only the override. If both exist, they must be byte-identical.
 */
export function resolveProductionContractFile(repositoryRoot, relativePath, sourceOverride) {
  const standardPath = path.join(repositoryRoot, ...relativePath.split('/'));
  if (!sourceOverride) return standardPath;
  const overridePath = path.join(repositoryRoot, ...sourceOverride.split('/'));
  const standardExists = fs.existsSync(standardPath);
  const overrideExists = fs.existsSync(overridePath);
  if (standardExists && overrideExists) {
    const standardBytes = fs.readFileSync(standardPath);
    const overrideBytes = fs.readFileSync(overridePath);
    if (!standardBytes.equals(overrideBytes)) {
      throw new Error(`production contract source divergence: ${relativePath}`);
    }
    return standardPath;
  }
  return standardExists ? standardPath : overridePath;
}

/**
 * Hash the exact resolved contract through the same path used by both the
 * production build and the destructive live gate.
 */
export function productionLiveContractSha256({
  repositoryRoot,
  domain,
  relativePaths,
  sourceOverrides = {},
}) {
  const digest = crypto.createHash('sha256').update(`${domain}\0`);
  for (const relativePath of [...relativePaths].sort()) {
    const sourcePath = resolveProductionContractFile(
      repositoryRoot,
      relativePath,
      sourceOverrides[relativePath],
    );
    const bytes = fs.readFileSync(sourcePath);
    digest
      .update(relativePath).update('\0')
      .update(String(bytes.length)).update('\0')
      .update(crypto.createHash('sha256').update(bytes).digest('hex')).update('\0');
  }
  return digest.digest('hex');
}
