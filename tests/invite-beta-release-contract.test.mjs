import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INVITE_BETA_CONTRACT_FILES,
  INVITE_BETA_CONTRACT_SOURCE_OVERRIDES,
} from '../app/invite-beta-contract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const RETIRED_ORIGIN = 'https://binance-futures-review.vercel.app';
const IS_EXPORTED_CANDIDATE = fs.existsSync(path.join(REPO, 'PUBLIC-STAGING-MANIFEST.json'));

function read(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), 'utf8');
}

function readLayout(sourcePath, candidatePath) {
  return read(IS_EXPORTED_CANDIDATE ? candidatePath : sourcePath);
}

test('invite beta promise states the real server-readable boundary and rollout ceiling', () => {
  const promise = read('PROMISE.md');

  assert.match(promise, /# 我们的承诺\(v5\)/u);
  assert.match(promise, /邀请制 Beta/u);
  assert.match(promise, /最多\s*10\s*个/u);
  assert.match(promise, /交易与复盘数据[^\n]*服务端可读/u);
  assert.match(promise, /管理员[^\n]*部署环境[^\n]*理论上可解密/u);
  assert.match(promise, /不(?:是|提供|支持)[^\n]*零知识/u);
  assert.match(promise, /无固定出口 IP/u);
  assert.match(promise, /R2[^\n]*Brevo[^\n]*GitHub Runner/u);
  assert.match(promise, /小时级[^\n]*尽力/u);
  assert.match(promise, /不提供下单、改单、撤单、转账、提现/u);
  assert.match(promise, /旧[^\n]*vault[^\n]*只读/iu);
});

test('active product policy no longer promises that Binance keys or business plaintext stay off-server', () => {
  const activePolicy = IS_EXPORTED_CANDIDATE
    ? [
        read('README.md'),
        read('app/CONSTITUTION.md'),
        read('docs/INVITE-BETA-BACKEND.md'),
      ].join('\n')
    : [
        read('README.md'),
        read('app/CONSTITUTION.md'),
        read('ROADMAP.md'),
        read('BACKEND.md').split('## 冻结历史快照开始')[0],
      ].join('\n');

  assert.doesNotMatch(activePolicy, /不收 Binance API Secret|key 绝不服务端托管|生产 Web 云仓采用浏览器端加密|目标云架构仍是[^\n]*全量 E2EE/u);
  assert.match(activePolicy, /服务端可读/u);
  assert.match(activePolicy, /旧[^\n]*vault[^\n]*只读/iu);
});

test('Supabase Auth and Edge configuration use the one canonical production origin', () => {
  const config = read('supabase/config.toml');

  assert.match(config, new RegExp(`site_url = "${CANONICAL_ORIGIN.replaceAll('.', '\\.') }"`));
  assert.match(config, new RegExp(`additional_redirect_urls = \\["${CANONICAL_ORIGIN.replaceAll('.', '\\.') }"\\]`));
  assert.doesNotMatch(config, new RegExp(RETIRED_ORIGIN.replaceAll('.', '\\.')));
  assert.match(config, /\[functions\.binance-beta\][^]*verify_jwt = false/u);
});

test('retired no-web hostname has only a permanent redirect to the canonical origin', () => {
  const vercel = JSON.parse(readLayout('public-staging/vercel.json', 'vercel.json'));
  const redirect = vercel.redirects?.find((entry) => entry.has?.some(
    (condition) => condition.type === 'host' && condition.value === 'binance-futures-review.vercel.app',
  ));

  assert.ok(redirect, 'retired host redirect must exist');
  assert.equal(redirect.permanent, true);
  assert.equal(redirect.destination, `${CANONICAL_ORIGIN}/:path*`);
});

test('backend contract documents the immutable Classic shell and fail-closed beta gates', () => {
  const backend = read('docs/INVITE-BETA-BACKEND.md');

  for (const required of [
    'rv-cloud-dataset/1',
    'rv-reconciliation/2',
    'SHADOW',
    'PARITY_OBSERVING',
    'PARITY_PASSED',
    'PRIMARY',
    'PARTIAL',
    'STALE',
    'UNKNOWN',
    'CONFLICT',
    '7c90282',
    '1440×1000',
    '390×844',
    'local-demo',
    'invite-beta',
  ]) {
    assert.match(backend, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  }
  assert.match(backend, /Classic\/DC[^\n]*不(?:删减|改版|重设计)/u);
  assert.match(backend, /双用户[^\n]*真实/u);
  assert.match(backend, /GitHub push[^\n]*明确确认/u);
});

test('root package exposes bounded invite-beta verification lanes', () => {
  const manifest = JSON.parse(read('package.json'));
  const verificationLane = IS_EXPORTED_CANDIDATE
    ? manifest.scripts.test
    : manifest.scripts['test:invite-beta'];

  assert.equal(typeof verificationLane, 'string');
  assert.match(verificationLane, /invite-beta-release-contract/u);
  assert.match(verificationLane, /rv2-/u);
  assert.match(verificationLane, /binance-beta-/u);

  if (IS_EXPORTED_CANDIDATE) {
    assert.equal(manifest.scripts['test:invite-beta'], undefined);
    assert.match(verificationLane, /beta-operations-backend\.test\.mjs/u);
    assert.match(verificationLane, /public-backend-completeness\.test\.mjs/u);
    assert.match(verificationLane, /restore-v2-core\.test\.mjs/u);
    assert.match(verificationLane, /restore-v2-handler\.test\.mjs/u);
    assert.match(verificationLane, /restore-v2-migration-contract\.test\.mjs/u);
  } else {
    assert.match(verificationLane, /beta-operations-/u);
    assert.match(verificationLane, /beta-ops-/u);
    assert.match(verificationLane, /restore-v2-/u);
  }
});

test('public candidate verifies every exported invite-beta backend contract', () => {
  const manifest = JSON.parse(read('public-staging/package.json'));
  for (const required of [
    'beta-operations-backend.test.mjs',
    'invite-beta-release-contract.test.mjs',
    'public-backend-completeness.test.mjs',
    'restore-v2-core.test.mjs',
    'restore-v2-handler.test.mjs',
    'restore-v2-migration-contract.test.mjs',
    'rv2-data-plane-schema.test.mjs',
    'binance-beta-archive.test.mjs',
    'binance-beta-handler.test.mjs',
    'binance-beta-ledger.test.mjs',
    'binance-beta-modules.test.mjs',
    'binance-beta-runtime.test.mjs',
    'binance-beta-security.test.mjs',
    'binance-beta-trade-projector.test.mjs',
    'binance-beta-worker.test.mjs',
    'rv2-capacity-observability.test.mjs',
    'rv2-review-loop-schema.test.mjs',
  ]) assert.match(manifest.scripts.test, new RegExp(required.replaceAll('.', '\\.'), 'u'));
});

test('Vite binds invite-beta builds to a reviewed backend digest and independent Ed25519 verifiers', () => {
  const vite = read('app/vite.config.ts');
  const contract = read('app/invite-beta-contract.mjs');
  const attestation = read('app/invite-beta-attestation.mjs');

  assert.match(vite, /inviteBetaContractSha256/u);
  assert.match(vite, /expectedInviteBetaContractSha256:\s*inviteBetaContractSha256/u);
  assert.match(vite, /expectedInviteBetaLiveKeyId:\s*INVITE_BETA_LIVE_ATTESTATION_KEY_ID/u);
  assert.match(vite, /verifyInviteBetaLiveAttestation/u);
  assert.match(vite, /expectedInviteBetaOperationsKeyId:\s*INVITE_BETA_OPERATIONS_ATTESTATION_KEY_ID/u);
  assert.match(vite, /verifyInviteBetaOperationsAttestation/u);

  assert.match(contract, /rv-invite-beta-contract\/1/u);
  assert.match(contract, /supabase\/functions\/binance-beta/u);
  assert.match(contract, /trade-projector\.mjs/u);
  assert.match(contract, /20260831000100_invite_beta_rv2_data_plane\.sql/u);
  assert.match(contract, /supabase\/functions\/beta-operations/u);
  assert.match(contract, /supabase\/functions\/restore-v2/u);
  assert.match(contract, /20260831000200_restore_v2_lineage\.sql/u);
  assert.match(contract, /20260831000300_invite_beta_capacity_observability\.sql/u);
  assert.match(attestation, /Ed25519/u);
  assert.match(attestation, /unprovisioned/u);
  assert.doesNotMatch(attestation, /process\.env/u);
});

test('invite-beta backend digest binds operations, restore and migrations in a fixed explicit order', () => {
  const requiredRuntime = [
    'supabase/functions/beta-operations/core.mjs',
    'supabase/functions/beta-operations/handler.mjs',
    'supabase/functions/beta-operations/index.ts',
    'supabase/functions/beta-operations/runtime.mjs',
    'supabase/functions/restore-v2/core.mjs',
    'supabase/functions/restore-v2/handler.mjs',
    'supabase/functions/restore-v2/index.ts',
    'supabase/functions/restore-v2/runtime.mjs',
    'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
    'supabase/migrations/20260831000200_restore_v2_lineage.sql',
    'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql',
  ];

  for (const relativePath of requiredRuntime) {
    assert.ok(INVITE_BETA_CONTRACT_FILES.includes(relativePath), `backend digest omits ${relativePath}`);
  }
  assert.equal(new Set(INVITE_BETA_CONTRACT_FILES).size, INVITE_BETA_CONTRACT_FILES.length);
  assert.deepEqual(
    INVITE_BETA_CONTRACT_FILES,
    [...INVITE_BETA_CONTRACT_FILES].sort(),
    'the explicit digest input order must stay deterministic',
  );
  assert.deepEqual(INVITE_BETA_CONTRACT_SOURCE_OVERRIDES, {
    'supabase/migrations/20260831000100_invite_beta_rv2_data_plane.sql':
      'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
    'supabase/migrations/20260831000200_restore_v2_lineage.sql':
      'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
    'supabase/migrations/20260831000300_invite_beta_capacity_observability.sql':
      'supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
  });
});

test('security policy states the invite-beta credential, tenancy, network and deletion boundaries', () => {
  const security = read('SECURITY.md');

  assert.match(security, /AES-256-GCM/u);
  assert.match(security, /AAD/u);
  assert.match(security, /Project Secret/u);
  assert.match(security, /管理员[^\n]*理论上可解密/u);
  assert.match(security, /RLS/u);
  assert.match(security, /跨租户[^\n]*404/u);
  assert.match(security, /只允许[^\n]*GET/u);
  assert.match(security, /断开 Binance/u);
  assert.match(security, /删除业务数据/u);
  assert.match(security, /删除账户/u);
});

test('public exporter permits reviewed beta contracts but keeps operators and secrets private', () => {
  const exporter = read('scripts/export-public-staging.mjs');
  const supabaseExceptions = exporter.match(
    /const SUPABASE_PUBLIC_EXCEPTIONS = new Set\(\[[\s\S]*?\n\]\);/u,
  )?.[0] ?? '';

  assert.match(exporter, /docs\/INVITE-BETA-BACKEND\.md/u);
  assert.match(supabaseExceptions, /supabase\/functions\/binance-beta\//u);
  assert.match(supabaseExceptions, /supabase\/functions\/beta-operations\//u);
  assert.match(supabaseExceptions, /supabase\/functions\/restore-v2\//u);
  assert.match(supabaseExceptions, /20260831000200_restore_v2_lineage\.sql/u);
  assert.doesNotMatch(exporter, /DOC_PUBLIC_EXCEPTIONS[^]*\.github\/workflows\/beta-/u);
  assert.doesNotMatch(supabaseExceptions, /scripts\/beta-ops|\.github\/workflows\/beta-/u);
});

test('public UI copy does not preserve obsolete absolute E2EE or key-custody promises', () => {
  const forbiddenPromises = [
    /不收\s*Binance API Secret/iu,
    /不接收交易所密钥/iu,
    /(?:云端|服务器)[^。\n]{0,24}只保存密文/iu,
    /无法读取交易与复盘正文/iu,
    /(?:公网产品|网页版公开部署)[^。\n]{0,32}不接收[^。\n]{0,24}(?:API Key|交易所密钥)/iu,
  ];
  const explicitlyScopedException = /(?:旧|历史)[^。\n]{0,80}(?:vault|E2EE)[^。\n]{0,80}(?:只读|冻结)|(?:未配置|当前仍是)[^。\n]{0,40}local-demo/iu;

  for (const relativePath of [
    'app/src/App.tsx',
    'app/src/views/AccountView.tsx',
    'app/src/views/DataView.tsx',
  ]) {
    for (const [lineIndex, line] of read(relativePath).split(/\r?\n/u).entries()) {
      for (const forbidden of forbiddenPromises) {
        if (forbidden.test(line) && !explicitlyScopedException.test(line)) {
          assert.fail(`${relativePath}:${lineIndex + 1} contains an obsolete unscoped privacy promise`);
        }
      }
    }
  }
});
