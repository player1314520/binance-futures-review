import assert from 'node:assert/strict';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_TIMEOUT_MS = 15_000;

function exactProductionOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('production URL must be an exact HTTPS origin'); }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.hostname === 'github.io'
    || url.hostname.endsWith('.github.io')
  ) throw new Error('production URL must be a dedicated exact HTTPS origin');
  return url.origin;
}

async function fetchBounded(fetchImpl, url, options, maximumBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('deployment smoke timeout'), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('deployment response exceeds its declared limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error('deployment response exceeds its byte limit');
    return { response, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyProductionDeployment({
  url,
  commit,
  projectRef,
  receiptSha256,
  operationsAttestationSha256,
  fetchImpl = fetch,
}) {
  const origin = exactProductionOrigin(url);
  assert.match(commit, COMMIT_PATTERN, 'expected commit must be a full lowercase Git SHA');
  assert.match(projectRef, PROJECT_REF_PATTERN, 'expected project ref must be exactly 20 lowercase characters');
  assert.match(receiptSha256, SHA256_PATTERN, 'expected live-gate receipt SHA-256 is invalid');
  assert.match(operationsAttestationSha256, SHA256_PATTERN, 'expected operations attestation SHA-256 is invalid');

  const releaseResult = await fetchBounded(fetchImpl, `${origin}/release.json`, { method: 'GET' }, 16 * 1024);
  assert.equal(releaseResult.response.status, 200, 'production release.json is unavailable');
  let release;
  try { release = JSON.parse(releaseResult.text); } catch { assert.fail('production release.json is invalid'); }
  assert.deepEqual(Object.keys(release).sort(), [
    'appOrigin', 'backendProjectRef', 'commit', 'format', 'liveGateReceiptSha256',
    'mode', 'operationsAttestation', 'product',
  ]);
  assert.equal(release.format, 'rv-web-release/1');
  assert.equal(release.product, 'Binance Futures Review Web');
  assert.equal(release.mode, 'production-vault');
  assert.equal(release.commit, commit);
  assert.equal(release.backendProjectRef, projectRef);
  assert.equal(release.appOrigin, origin, 'release.json appOrigin differs from the requested production origin');
  assert.equal(release.liveGateReceiptSha256, receiptSha256);
  assert.deepEqual(Object.keys(release.operationsAttestation).sort(), [
    'attestationSha256', 'evidenceBundleSha256', 'keyId', 'witnessedAt',
  ]);
  assert.match(release.operationsAttestation.keyId, /^rv-operations-[a-z0-9-]{8,80}$/);
  assert.match(release.operationsAttestation.evidenceBundleSha256, SHA256_PATTERN);
  assert.equal(release.operationsAttestation.attestationSha256, operationsAttestationSha256);
  assert.equal(new Date(Date.parse(release.operationsAttestation.witnessedAt)).toISOString(), release.operationsAttestation.witnessedAt);

  const pageResult = await fetchBounded(fetchImpl, `${origin}/`, { method: 'GET' }, 2 * 1024 * 1024);
  assert.equal(pageResult.response.status, 200, 'production application shell is unavailable');
  const expectedHeaders = {
    'content-security-policy': "frame-ancestors 'none';",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    assert.equal(pageResult.response.headers.get(name), expected, `production header ${name} is missing or different`);
  }
  const metaCsp = pageResult.text.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\scontent="([^"]+)"/i)?.[1]
    ?? pageResult.text.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\scontent='([^']+)'/i)?.[1]
    ?? '';
  assert.ok(metaCsp, 'production HTML CSP meta is missing');
  assert.match(metaCsp, new RegExp(`connect-src 'self' https://${projectRef}\\.supabase\\.co;`));
  assert.doesNotMatch(metaCsp, /unsafe-inline|unsafe-eval|connect-src[^;]*\*/i);

  for (const functionName of ['publish-vault-head', 'delete-account']) {
    const cors = await fetchBounded(
      fetchImpl,
      `https://${projectRef}.supabase.co/functions/v1/${functionName}`,
      { method: 'OPTIONS', headers: { Origin: origin } },
      4 * 1024,
    );
    assert.equal(cors.response.status, 204, `${functionName} production CORS preflight failed`);
    assert.equal(cors.response.headers.get('access-control-allow-origin'), origin, `${functionName} APP_ORIGIN differs from production`);
  }
  return Object.freeze({ origin, commit, projectRef, receiptSha256, operationsAttestationSha256 });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--url', '--commit', '--project-ref', '--receipt-sha', '--operations-attestation-sha'].includes(key) || !value || value.startsWith('--')) {
      throw new Error('usage: --url <origin> --commit <sha> --project-ref <ref> --receipt-sha <sha256> --operations-attestation-sha <sha256>');
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 5) throw new Error('all deployment smoke arguments are required');
  return {
    url: values['--url'],
    commit: values['--commit'],
    projectRef: values['--project-ref'],
    receiptSha256: values['--receipt-sha'],
    operationsAttestationSha256: values['--operations-attestation-sha'],
  };
}

if (process.argv[1] && new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).pathname.endsWith('/verify-production-deployment.mjs')) {
  verifyProductionDeployment(parseArguments(process.argv.slice(2)))
    .then((result) => console.log(`Production deployment verified: ${result.origin} @ ${result.commit}`))
    .catch((error) => {
      console.error(`Production deployment verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    });
}
