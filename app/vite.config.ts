import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentSecurityPolicy } from './src/lib/csp-policy';
import {
  PRODUCTION_LIVE_GATE_CONTRACT_DOMAIN,
  PRODUCTION_LIVE_GATE_CONTRACT_FILES,
  PRODUCTION_LIVE_GATE_SOURCE_OVERRIDES,
  buildReleaseDescriptor,
} from './src/lib/release-config';
import { productionLiveContractSha256 } from './production-live-contract.mjs';
import { inviteBetaContractSha256 } from './invite-beta-contract.mjs';
import {
  INVITE_BETA_LIVE_ATTESTATION_KEY_ID,
  INVITE_BETA_OPERATIONS_ATTESTATION_KEY_ID,
  verifyInviteBetaLiveAttestation,
  verifyInviteBetaOperationsAttestation,
} from './invite-beta-attestation.mjs';
import {
  PRODUCTION_LIVE_ATTESTATION_KEY_ID,
  PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
  verifyProductionOperationsAttestation,
  verifyProductionLiveGateAttestation,
} from './production-live-attestation.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 2.0 薄壳:纯静态 SPA(蓝图裁决,否决 SSR)。@rv/engine 经 workspace 符号链指向 ../frontend/engine.js,
// 物理零搬移 —— 1.x 构建链(gen-rv-modules/build-multifile/金标准)与本壳互不感知。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const csp = buildContentSecurityPolicy(env.VITE_SUPABASE_URL ?? '');
  const release = buildReleaseDescriptor({
    ...env,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  }, {
    sha256Text: (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex'),
    expectedContractSha256: productionLiveContractSha256({
      repositoryRoot: REPOSITORY_ROOT,
      domain: PRODUCTION_LIVE_GATE_CONTRACT_DOMAIN,
      relativePaths: PRODUCTION_LIVE_GATE_CONTRACT_FILES,
      sourceOverrides: PRODUCTION_LIVE_GATE_SOURCE_OVERRIDES,
    }),
    expectedAttestationKeyId: PRODUCTION_LIVE_ATTESTATION_KEY_ID,
    verifyReceiptAttestation: verifyProductionLiveGateAttestation,
    expectedOperationsAttestationKeyId: PRODUCTION_OPERATIONS_ATTESTATION_KEY_ID,
    verifyOperationsAttestation: verifyProductionOperationsAttestation,
    expectedInviteBetaContractSha256: inviteBetaContractSha256({
      repositoryRoot: REPOSITORY_ROOT,
    }),
    expectedInviteBetaLiveKeyId: INVITE_BETA_LIVE_ATTESTATION_KEY_ID,
    verifyInviteBetaLiveAttestation,
    expectedInviteBetaOperationsKeyId: INVITE_BETA_OPERATIONS_ATTESTATION_KEY_ID,
    verifyInviteBetaOperationsAttestation,
  });
  return {
    plugins: [
      react(),
      {
        name: 'rv-exact-production-csp',
        transformIndexHtml(html: string) {
          return html.replace('__RV_CSP__', csp);
        },
      },
      {
        name: 'rv-release-marker',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'release.json',
            source: `${JSON.stringify(release, null, 2)}\n`,
          });
        },
      },
    ],
    base: './',
    server: { fs: { allow: ['..'] } },
    build: { outDir: 'dist', sourcemap: false },
  };
});
