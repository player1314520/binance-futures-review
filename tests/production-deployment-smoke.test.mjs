import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyProductionDeployment } from '../scripts/verify-production-deployment.mjs';

const origin = 'https://binance-futures-review-web.vercel.app';
const projectRef = 'abcdefghijklmnopqrst';
const commit = 'a'.repeat(40);
const receiptSha256 = 'b'.repeat(64);
const operationsAttestationSha256 = 'c'.repeat(64);

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function deploymentFetch(overrides = {}) {
  return async (url, options) => {
    if (url === `${origin}/release.json`) {
      return response(JSON.stringify({
        format: 'rv-web-release/1',
        commit,
        product: 'Binance Futures Review Web',
        mode: 'production-vault',
        backendProjectRef: projectRef,
        appOrigin: overrides.releaseOrigin ?? origin,
        liveGateReceiptSha256: receiptSha256,
        operationsAttestation: {
          keyId: 'rv-operations-production-2026-01',
          witnessedAt: '2026-08-29T12:00:00.000Z',
          evidenceBundleSha256: 'd'.repeat(64),
          attestationSha256: operationsAttestationSha256,
        },
      }), 200, { 'content-type': 'application/json' });
    }
    if (url === `${origin}/`) {
      return response(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://${projectRef}.supabase.co; script-src 'self';">`,
        200,
        {
          'content-security-policy': "frame-ancestors 'none';",
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        },
      );
    }
    if (url.startsWith(`https://${projectRef}.supabase.co/functions/v1/`)) {
      assert.equal(options.method, 'OPTIONS');
      assert.equal(options.headers.Origin, origin);
      return response(null, 204, {
        'access-control-allow-origin': overrides.corsOrigin ?? origin,
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test('post-deploy smoke binds release marker, response policy and both Edge origins', async () => {
  assert.deepEqual(await verifyProductionDeployment({
    url: origin,
    commit,
    projectRef,
    receiptSha256,
    operationsAttestationSha256,
    fetchImpl: deploymentFetch(),
  }), { origin, commit, projectRef, receiptSha256, operationsAttestationSha256 });
});

test('post-deploy smoke rejects a release marker copied from another origin', async () => {
  await assert.rejects(verifyProductionDeployment({
    url: origin,
    commit,
    projectRef,
    receiptSha256,
    operationsAttestationSha256,
    fetchImpl: deploymentFetch({ releaseOrigin: 'https://wrong.example' }),
  }), /appOrigin/);
});

test('post-deploy smoke rejects an Edge deployment bound to a different APP_ORIGIN', async () => {
  await assert.rejects(verifyProductionDeployment({
    url: origin,
    commit,
    projectRef,
    receiptSha256,
    operationsAttestationSha256,
    fetchImpl: deploymentFetch({ corsOrigin: 'https://wrong.example' }),
  }), /APP_ORIGIN/);
});

test('post-deploy smoke refuses shared GitHub Pages as an authenticated origin', async () => {
  await assert.rejects(verifyProductionDeployment({
    url: 'https://player1314520.github.io',
    commit,
    projectRef,
    receiptSha256,
    operationsAttestationSha256,
    fetchImpl: deploymentFetch(),
  }), /dedicated/);
});
