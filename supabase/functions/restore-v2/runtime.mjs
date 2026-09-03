import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';

import { canonicalJson, verifyManifestEnvelope } from './core.mjs';
import { RestoreV2Error } from './handler.mjs';

function invariant(condition, code, message = code) {
  if (!condition) throw new RestoreV2Error(code, message);
}

function envValue(env, name, pattern, maximum = 16384) {
  const value = env.get(name);
  invariant(typeof value === 'string' && value.length <= maximum && pattern.test(value),
    'OPERATION_UNAVAILABLE');
  return value;
}

function safeEqual(left, right) {
  const a = Buffer.from(left ?? '', 'utf8');
  const b = Buffer.from(right ?? '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readResponseJson(response, { notFoundCodes = [] } = {}) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  invariant(contentType.startsWith('application/json'), 'OPERATION_UNAVAILABLE');
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length <= 8 * 1024 * 1024, 'OPERATION_UNAVAILABLE');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new RestoreV2Error('OPERATION_UNAVAILABLE'); }
  if (!response.ok && notFoundCodes.includes(String(value?.code ?? ''))) {
    throw new RestoreV2Error('RESOURCE_NOT_FOUND');
  }
  invariant(response.ok, response.status === 409 ? 'IDEMPOTENCY_CONFLICT' : 'OPERATION_UNAVAILABLE');
  return value;
}

export function createRestoreV2Runtime({ env = Deno.env, fetchImpl = fetch } = {}) {
  const supabaseUrl = envValue(env, 'SUPABASE_URL', /^https:\/\/[a-z0-9]{20}\.supabase\.co$/u, 128);
  const projectHost = new URL(supabaseUrl).host;
  const serviceRoleKey = envValue(env, 'SUPABASE_SERVICE_ROLE_KEY', /^\S{32,8192}$/u);
  const anonKey = envValue(env, 'SUPABASE_ANON_KEY', /^\S{32,8192}$/u);
  const ownerRecoveryOrigin = envValue(
    env,
    'RESTORE_V2_USER_ORIGIN',
    /^https:\/\/binance-futures-review-web[.]vercel[.]app$/u,
    128,
  );
  const manifestKeyId = envValue(env, 'RESTORE_V2_MANIFEST_KEY_ID', /^[A-Za-z0-9._-]{3,64}$/u, 64);
  const publicKeyPem = envValue(env, 'RESTORE_V2_MANIFEST_PUBLIC_KEY_PEM', /^-----BEGIN PUBLIC KEY-----[^]*-----END PUBLIC KEY-----\s*$/u, 8192);
  let manifestPublicKey;
  try { manifestPublicKey = createPublicKey(publicKeyPem); } catch { throw new RestoreV2Error('OPERATION_UNAVAILABLE'); }

  async function fixedFetch(url, options) {
    const parsed = new URL(url);
    invariant(parsed.protocol === 'https:' && parsed.host === projectHost
      && !parsed.username && !parsed.password && !parsed.hash, 'OPERATION_UNAVAILABLE');
    return fetchImpl(parsed.toString(), { ...options, redirect: 'error' });
  }

  async function rpc(name, args, options) {
    invariant(/^rv2_restore_v2_[a-z0-9_]+$/u.test(name), 'OPERATION_UNAVAILABLE');
    const response = await fixedFetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
    });
    return readResponseJson(response, options);
  }

  return Object.freeze({
    ownerRecoveryOrigin,
    verifyServiceRole: async token => safeEqual(token, serviceRoleKey),
    verifyUserToken: async token => {
      if (!/^\S{16,16384}$/u.test(token ?? '')) return null;
      const response = await fixedFetch(`${supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: { apikey: anonKey, authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!response.ok) return null;
      const value = await readResponseJson(response);
      const verified = Boolean(value.email_confirmed_at)
        && typeof value.email === 'string' && value.email.length <= 320;
      return verified ? { userId: value.id, email: value.email, emailVerified: true } : null;
    },
    getVerifiedRecoveryTag: async subject => rpc('rv2_restore_v2_verified_recovery_tag', {
      p_subject: subject,
    }),
    createDeletionIntent: async value => rpc('rv2_restore_v2_create_deletion_intent', {
      p_subject: value.subject,
      p_tenant_id: value.tenantId,
      p_expected_membership_version: value.expectedMembershipVersion,
      p_operation: value.operation,
      p_event_id: value.eventId,
    }),
    attestDeletionJournal: async value => rpc('rv2_restore_v2_attest_deletion_journal', {
      p_intent_id: value.intentId,
      p_object_evidence: value.objectEvidence,
      p_range_proof: value.rangeProof,
    }),
    executeDeletion: async value => rpc('rv2_restore_v2_execute_deletion', {
      p_intent_id: value.intentId,
    }),
    claimRestore: async value => {
      const verification = verifyManifestEnvelope(value.envelope, {
        publicKey: manifestPublicKey,
        expectedKeyId: manifestKeyId,
      });
      invariant(verification.trust === 'VERIFIED_V2', 'LEGACY_UNTRUSTED');
      const envelopeSha256 = createHash('sha256')
        .update('rv-restore-v2-envelope/1\0' + canonicalJson(value.envelope), 'utf8')
        .digest('hex');
      return rpc('rv2_restore_v2_claim_restore', {
        p_manifest: verification.manifest,
        p_envelope_sha256: envelopeSha256,
        p_signature_verified: true,
        p_journal_proof: value.journalProof,
      });
    },
    stageRestoreBatch: async value => rpc('rv2_restore_v2_stage_batch', {
      p_restore_id: value.restoreId,
      p_batch_index: value.batchIndex,
      p_total_batches: value.totalBatches,
      p_idempotency_key: value.idempotencyKey,
      p_rows: value.rows,
    }),
    issueOwnerInvite: async value => rpc('rv2_restore_v2_issue_owner_invite', {
      p_restore_id: value.restoreId,
      p_principal_lineage_id: value.principalLineageId,
      p_delivery_id: value.deliveryId,
    }),
    claimOwner: async value => rpc('rv2_restore_v2_claim_owner', {
      p_restore_id: value.restoreId,
      p_principal_lineage_id: value.principalLineageId,
      p_invite_claim: value.inviteClaim,
      p_subject: value.user.userId,
    }),
    recoverOwner: async value => rpc(
      'rv2_restore_v2_recover_owner_by_verified_subject',
      {
        p_restore_id: value.restoreId,
        p_subject: value.user.userId,
      },
      { notFoundCodes: ['P0002', '40001'] },
    ),
    publishRestore: async value => rpc('rv2_restore_v2_publish', {
      p_restore_id: value.restoreId,
      p_journal_proof: value.journalProof,
    }),
    getRestoreStatus: async value => rpc('rv2_restore_v2_status', {
      p_restore_id: value.restoreId,
    }),
  });
}
