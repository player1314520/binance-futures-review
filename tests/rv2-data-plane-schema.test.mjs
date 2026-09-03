import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
  import.meta.url,
);
const readmeUrl = new URL('../supabase/production-vault/README.md', import.meta.url);

const sql = await readFile(migrationUrl, 'utf8').catch((error) => {
  if (error?.code === 'ENOENT') return '';
  throw error;
});
const readme = await readFile(readmeUrl, 'utf8');

const publicTables = [
  'rv2_tenants',
  'rv2_memberships',
  'rv2_connections',
  'rv2_source_events',
  'rv2_generations',
  'rv2_trade_identities',
  'rv2_trade_read_models',
  'rv2_reviews',
  'rv2_actions',
  'rv2_journal_entries',
  'rv2_risk_rules',
  'rv2_reports',
  'rv2_ledger_generations',
  'rv2_reconciliation_generations',
];

const privateTables = [
  'rv2_credential_envelopes',
  'rv2_sync_jobs',
  'rv2_sync_attempts',
  'rv2_sync_partitions',
  'rv2_sync_coverage',
  'rv2_sync_gaps',
  'rv2_archive_jobs',
  'rv2_archives',
  'rv2_egress_receipts',
  'rv2_backup_runs',
  'rv2_review_requests',
  'rv2_domain_mutation_requests',
  'rv2_trade_projection_evidence',
  'rv2_source_event_conflicts',
  'rv2_ledger_shadow_submissions',
  'rv2_post_commit_work',
  'rv2_ops_oidc_claims',
  'rv2_ops_backup_snapshots',
  'rv2_ops_backup_snapshot_rows',
  'rv2_ops_backup_page_evidence',
  'rv2_ops_backup_signing_claims',
  'rv2_ops_restore_runs',
  'rv2_ops_restore_batches',
  'rv2_ops_restore_staging_rows',
  'rv2_ops_archive_batches',
  'rv2_ops_archive_staging_rows',
  'rv2_deletion_tombstones',
  'rv2_worker_control',
];

const browserRpcs = [
  'rv2_get_tenant_context',
  'rv2_enqueue_sync',
  'rv2_list_connections',
  'rv2_get_dataset_status',
  'rv2_get_current_dataset',
  'rv2_get_trades',
  'rv2_get_reviews',
  'rv2_upsert_review',
  'rv2_upsert_action',
  'rv2_upsert_journal',
  'rv2_upsert_risk_rule',
  'rv2_upsert_report',
  'rv2_disconnect_connection',
];

const memberServiceRpcs = [
  'rv2_service_provision_tenant',
  'rv2_service_create_or_rotate_connection',
  'rv2_service_delete_tenant_data',
];

const workerServiceRpcs = [
  'rv2_service_enqueue_due_syncs',
  'rv2_service_claim_sync_job',
  'rv2_service_renew_sync_job',
  'rv2_service_commit_sync_page',
  'rv2_service_schedule_discovered_symbols',
  'rv2_service_submit_ledger_shadow',
  'rv2_service_claim_post_commit_work',
  'rv2_service_complete_post_commit_work',
  'rv2_service_fail_post_commit_work',
  'rv2_service_open_worker_circuit',
  'rv2_service_fail_sync_job',
  'rv2_service_claim_archive_job',
  'rv2_service_commit_archive_state',
  'rv2_service_fail_archive_job',
  'rv2_service_stage_archive_link',
  'rv2_service_publish_generation',
];

const serviceRpcs = [...memberServiceRpcs, ...workerServiceRpcs];

const opsServiceRpcs = [
  'rv2_ops_claim_oidc_jti',
  'rv2_ops_read_backup_page',
  'rv2_ops_record_backup_page_evidence',
  'rv2_ops_claim_backup_signing_evidence',
  'rv2_ops_apply_deletion_tombstones',
  'rv2_ops_claim_restore_manifest',
  'rv2_ops_claim_archive_download',
  'rv2_ops_attest_archive_payload',
  'rv2_ops_fail_archive_claim',
  'rv2_ops_ingest_archive_batch',
  'rv2_ops_finalize_archive',
];

function tableBody(schema, name) {
  const match = sql.match(new RegExp(
    `create table ${schema}\\.${name} \\(([\\s\\S]*?)\\n\\);`,
    'i',
  ));
  assert.ok(match, `missing table ${schema}.${name}`);
  return match[1];
}

function functionBody(name) {
  const match = sql.match(new RegExp(
    `create(?: or replace)? function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`,
    'i',
  ));
  assert.ok(match, `missing RPC public.${name}`);
  return match[0];
}

test('rv2 is a forward-only additive migration and retires only legacy browser writes', () => {
  assert.match(sql, /^-- Review Workbench invite-only Beta rv2 data plane\./i);
  assert.match(sql, /\nbegin;[\s\S]*\ncommit;\s*$/i);
  assert.doesNotMatch(sql, /\bdrop\s+(?:table|schema|column|function|type|index)\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /alter\s+table\s+(?:public\.)?(?:profiles|workspaces|devices|vault_objects|vault_heads|vault_head_history)[^;]*\bdrop\b/i);

  for (const signature of [
    'rv_bootstrap_workspace(uuid, text, text, text, uuid)',
    'rv_register_device(uuid, uuid, text, uuid)',
    'rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid)',
  ]) {
    assert.match(sql, new RegExp(
      `revoke execute on function public\\.${signature.replace(/[()]/g, '\\$&')} from authenticated;`,
      'i',
    ));
  }
  assert.doesNotMatch(sql, /revoke execute on function public\.rv_(?:list_workspaces|read_generation_object|read_active_generation|read_generation_history|get_destructive_operation_status)/i);
  assert.match(readme, /legacy vault browser writes are revoked/i);
  assert.match(readme, /reads and destructive-operation recovery remain available/i);
});

test('migration has no duplicate named constraints that would stop PostgreSQL parsing', () => {
  const names = [...sql.matchAll(/\bconstraint\s+([a-z0-9_]+)\b/gi)].map((match) => match[1].toLowerCase());
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  assert.deepEqual(duplicates, []);
});

test('rv2 separates public domain records from private credentials and operations', () => {
  for (const name of publicTables) tableBody('public', name);
  for (const name of privateTables) tableBody('private', name);

  const credentials = tableBody('private', 'rv2_credential_envelopes');
  assert.match(credentials, /envelope_ciphertext text not null/i);
  assert.match(credentials, /envelope_nonce text not null/i);
  assert.match(credentials, /envelope_key_ref text not null/i);
  assert.match(credentials, /envelope_sha256 text not null/i);
  assert.match(credentials, /idempotency_key uuid not null/i);
  assert.match(credentials, /request_fingerprint text not null/i);
  assert.doesNotMatch(credentials, /api[_ ]?(?:key|secret)|passphrase|email|display_name/i);

  const sourceEvents = tableBody('public', 'rv2_source_events');
  assert.match(sourceEvents, /provider_event_id text not null/i);
  assert.match(sourceEvents, /event_sha256 text not null/i);
  assert.match(sourceEvents, /unique \(tenant_id, connection_id, dataset, provider_event_id\)/i);
  assert.doesNotMatch(sql, /on conflict[^;]*do update[\s\S]{0,300}rv2_source_events/i);
  assert.match(sql, /source event provider identity conflict/i);
});

test('every rv2 table has forced RLS and no direct Data API privilege', () => {
  for (const name of publicTables) {
    assert.match(sql, new RegExp(`alter table public\\.${name} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${name} force row level security;`, 'i'));
    assert.match(sql, new RegExp(
      `revoke all (?:privileges )?on table public\\.${name} from public, anon, authenticated, service_role;`,
      'i',
    ));
  }
  for (const name of privateTables) {
    assert.match(sql, new RegExp(`alter table private\\.${name} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table private\\.${name} force row level security;`, 'i'));
    assert.match(sql, new RegExp(
      `revoke all (?:privileges )?on table private\\.${name} from public, anon, authenticated, service_role;`,
      'i',
    ));
  }
  assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|truncate|references|trigger)[^;]*\bon table\s+(?:public|private)\.rv2_/i);
});

test('personal invite beta has one immutable OWNER membership per tenant, including inactive history', () => {
  const memberships = tableBody('public', 'rv2_memberships');
  assert.match(memberships, /primary key \(tenant_id, user_id\)/i);
  assert.match(memberships, /member_role text not null default 'OWNER'/i);
  assert.match(memberships, /rv2_memberships_tenant_key unique \(tenant_id\)/i);
  assert.match(memberships, /rv2_memberships_user_key unique \(user_id\)/i);
  assert.match(memberships, /rv2_memberships_role_check check \(member_role = 'OWNER'\)/i);
  assert.match(memberships, /rv2_memberships_user_fkey[\s\S]*references auth\.users \(id\) on delete cascade/i);
  assert.match(memberships, /membership_version bigint not null default 1/i);
  assert.match(memberships, /status text not null default 'active'/i);

  const identityGuard = sql.match(
    /create function private\.rv2_enforce_personal_membership_identity\(\)[\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(identityGuard, /security definer/i);
  assert.match(identityGuard, /new\.tenant_id <> old\.tenant_id/i);
  assert.match(identityGuard, /new\.user_id <> old\.user_id/i);
  assert.match(identityGuard, /t\.status = 'ACTIVE'/i);
  assert.match(identityGuard, /t\.status <> 'DELETED'/i);
  assert.match(identityGuard, /personal tenant membership cannot be detached/i);
  assert.match(identityGuard, /from public\.rv2_tenants/i);
  assert.match(sql, /before insert or update of tenant_id, user_id, member_role or delete on public\.rv2_memberships/i);

  const browserTenant = sql.match(/create function private\.rv2_require_browser_tenant\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  const serviceMembership = sql.match(/create function private\.rv2_require_service_membership\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  const tenantContext = functionBody('rv2_get_tenant_context');
  const provision = functionBody('rv2_service_provision_tenant');
  const createOrRotate = functionBody('rv2_service_create_or_rotate_connection');
  const disconnect = functionBody('rv2_disconnect_connection');
  const scheduler = functionBody('rv2_service_enqueue_due_syncs');
  const destructive = sql.match(
    /create function private\.rv2_clear_subject_business_data\([\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  for (const fn of [
    browserTenant, serviceMembership, tenantContext, provision,
    createOrRotate, disconnect, scheduler, destructive,
  ]) {
    assert.match(fn, /member_role = 'OWNER'/i);
  }
  assert.match(provision, /values \([\s\S]*v_tenant_id, p_subject, 'OWNER', 'ACTIVE'/i);
  assert.doesNotMatch(provision, /'ADMIN'|'MEMBER'/i);
  assert.doesNotMatch(sql, /'ADMIN'|'MEMBER'/i);
});

test('invite beta admission caps active personal tenants and active connections globally at ten', () => {
  const memberships = tableBody('public', 'rv2_memberships');
  assert.match(memberships, /status text not null default 'active'/i);

  const tenantGuard = sql.match(/create function private\.rv2_enforce_tenant_limits\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(tenantGuard, /security definer/i);
  assert.match(tenantGuard, /set search_path = pg_catalog/i);
  assert.match(tenantGuard, /pg_advisory_xact_lock/i);
  assert.match(tenantGuard, /review-workbench-rv2-global-invite-beta-limit/i);
  assert.match(tenantGuard, /from public\.rv2_memberships[\s\S]*status = 'ACTIVE'[\s\S]*>= 10/i);
  assert.match(tenantGuard, /from public\.rv2_connections[\s\S]*status = 'ACTIVE'[\s\S]*>= 10/i);
  assert.doesNotMatch(tenantGuard, /m\.tenant_id = new\.tenant_id|c\.tenant_id = new\.tenant_id/i);
  assert.match(sql, /before insert or update of status on public\.rv2_memberships/i);
  assert.match(sql, /before insert or update of status on public\.rv2_connections/i);
});

test('connection metadata is bounded, non-identifying, and sufficient for the Edge read model', () => {
  const connections = tableBody('public', 'rv2_connections');
  assert.match(connections, /provider_scope_hash text not null/i);
  assert.match(connections, /permission_state text not null default 'UNKNOWN'/i);
  assert.match(connections, /permission_evidence jsonb/i);
  assert.match(connections, /last_trusted_at timestamptz/i);
  assert.match(connections, /next_due_at timestamptz/i);
  assert.match(connections, /last_error_code text/i);
  assert.match(connections, /disconnect_receipt_id uuid/i);
  assert.doesNotMatch(connections, /account_id|account_uid|api_key|api_secret|permission_payload/i);

  const evidenceValidator = sql.match(/create function private\.rv2_permission_evidence_is_valid\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(evidenceValidator, /rv-binance-permission\/1/i);
  for (const key of [
    'provider',
    'readOnly',
    'tradeDisabled',
    'withdrawDisabled',
    'internalTransferDisabled',
    'universalTransferDisabled',
    'checkedAt',
    'evidenceDigest',
  ]) assert.match(evidenceValidator, new RegExp(key, 'i'));
  assert.match(connections, /private\.rv2_permission_evidence_is_valid\(permission_evidence\)/i);
  assert.match(connections, /status <> 'ACTIVE' or permission_state = 'READ_ONLY_VERIFIED'/i);

  const list = functionBody('rv2_list_connections');
  assert.match(list, /rv-binance-connections\/1/i);
  assert.match(list, /'connections'/i);
  for (const field of [
    'permission_state',
    'permission_evidence',
    'last_trusted_at',
    'next_due_at',
    'last_error_code',
  ]) assert.match(list, new RegExp(field, 'i'));

  const status = functionBody('rv2_get_dataset_status');
  assert.match(status, /last_error_code/i);
  const disconnect = functionBody('rv2_disconnect_connection');
  assert.match(disconnect, /receipt_id uuid/i);
  assert.match(disconnect, /disconnect_receipt_id/i);
});

test('browser identity comes only from auth.uid membership and service calls require explicit subject consistency', () => {
  const browserTenant = sql.match(/create function private\.rv2_require_browser_tenant\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(browserTenant, /auth\.uid\(\)/i);
  assert.match(browserTenant, /public\.rv2_memberships/i);
  assert.match(browserTenant, /status = 'active'/i);
  assert.match(browserTenant, /live auth session required/i);

  for (const name of browserRpcs) {
    const fn = functionBody(name);
    assert.match(fn, /security definer/i);
    assert.match(fn, /set search_path = pg_catalog/i);
    assert.match(fn, /private\.rv2_require_browser_tenant\(\)/i);
    assert.doesNotMatch(fn, /\bp_(?:subject|user_id)\b/i);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i'));
  }

  const serviceMembership = sql.match(/create function private\.rv2_require_service_membership\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(serviceMembership, /p_subject uuid/i);
  assert.match(serviceMembership, /p_tenant_id uuid/i);
  assert.match(serviceMembership, /public\.rv2_memberships/i);
  assert.match(serviceMembership, /status = 'active'/i);

  for (const name of memberServiceRpcs) {
    const fn = functionBody(name);
    assert.match(fn, /\bp_subject uuid/i);
    assert.match(fn, /security definer/i);
    assert.match(fn, /set search_path = pg_catalog/i);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to service_role;`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i'));
  }

  for (const name of workerServiceRpcs) {
    const fn = functionBody(name);
    assert.match(fn, /\bp_worker_subject uuid/i);
    assert.match(fn, /security definer/i);
    assert.match(fn, /set search_path = pg_catalog/i);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to service_role;`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i'));
  }
});

test('create-or-rotate and enqueue have conflict-closing UUID idempotency', () => {
  const createOrRotate = functionBody('rv2_service_create_or_rotate_connection');
  assert.match(createOrRotate, /member_role = 'OWNER'/i);
  assert.doesNotMatch(createOrRotate, /'ADMIN'|'MEMBER'/i);
  assert.match(createOrRotate, /p_consent_version text/i);
  assert.match(createOrRotate, /p_consent_version <> 'rv-binance-beta-consent\/1'/i);
  assert.match(createOrRotate, /p_expected_credential_version = 0[\s\S]*'CREATE'/i);
  assert.match(createOrRotate, /v_connection_id := p_connection_id/i);
  assert.doesNotMatch(createOrRotate, /v_connection_id := gen_random_uuid\(\)/i);
  assert.match(createOrRotate, /p_idempotency_key uuid/i);
  assert.match(createOrRotate, /p_request_fingerprint text/i);
  assert.match(createOrRotate, /request_fingerprint/i);
  assert.match(createOrRotate, /idempotency key reused with different request/i);
  assert.match(createOrRotate, /provider_scope_hash/i);
  assert.doesNotMatch(createOrRotate, /provider_account_(?:id|uid)/i);

  const enqueue = functionBody('rv2_enqueue_sync');
  assert.match(enqueue, /p_idempotency_key uuid/i);
  assert.match(enqueue, /request_fingerprint/i);
  assert.match(enqueue, /idempotency key reused with different request/i);
  assert.match(enqueue, /pg_advisory_xact_lock[\s\S]*review-workbench-rv2-enqueue:/i);
  assert.match(enqueue, /select j\.job_id, j\.status, j\.request_fingerprint[\s\S]*if found[\s\S]*return query select v_job_id, v_status/i);

  assert.match(readme, /provider_scope_hash[\s\S]*not an official Binance UID/i);
  assert.match(readme, /idempotency[\s\S]*same request[\s\S]*different request/i);
});

test('job page commit validates tenant connection credential attempt lease and immutable event identity', () => {
  const jobs = tableBody('private', 'rv2_sync_jobs');
  assert.match(jobs, /credential_version bigint not null/i);
  assert.match(jobs, /dataset text not null/i);
  assert.match(jobs, /partition_key text not null/i);
  assert.match(jobs, /page_committed boolean not null default false/i);
  assert.match(jobs, /page_cursor jsonb not null default '\{\}'::jsonb/i);
  assert.match(jobs, /page_number bigint not null default 0/i);
  assert.match(jobs, /previous_page_digest text/i);
  assert.match(jobs, /sync_complete boolean not null default false/i);
  assert.match(jobs, /idempotency_key uuid not null/i);

  const claim = functionBody('rv2_service_claim_sync_job');
  assert.match(claim, /p_worker_subject uuid/i);
  assert.match(claim, /p_job_id uuid default null/i);
  assert.doesNotMatch(claim.match(/create(?: or replace)? function[\s\S]*?returns table/i)?.[0] ?? '', /p_(?:tenant_id|user_id) uuid/i);
  assert.match(claim, /order by j\.available_at, j\.job_id/i);
  assert.match(claim, /for update of j skip locked/i);
  assert.match(claim, /requested_by/i);
  assert.match(claim, /page_cursor jsonb/i);
  assert.match(claim, /page_number bigint/i);
  assert.match(claim, /previous_page_digest text/i);

  for (const name of [
    'rv2_service_renew_sync_job',
    'rv2_service_commit_sync_page',
    'rv2_service_fail_sync_job',
  ]) {
    const fn = functionBody(name);
    assert.match(fn, /p_worker_subject uuid/i);
    assert.match(fn, /job_id = p_job_id/i);
    assert.match(fn, /worker_subject = p_worker_subject/i);
    assert.match(fn, /claim_token = p_claim_token/i);
    assert.match(fn, /connection_id/i);
    assert.match(fn, /credential_version/i);
  }

  const commit = functionBody('rv2_service_commit_sync_page');
  assert.match(commit, /claim_token = p_claim_token/i);
  assert.match(commit, /lease_expires_at > statement_timestamp\(\)/i);
  assert.match(commit, /page_committed/i);
  assert.match(commit, /source event provider identity conflict/i);
  assert.match(commit, /p_next_cursor jsonb/i);
  assert.match(commit, /p_has_more boolean/i);
  assert.match(commit, /p_page_digest text/i);
  assert.match(commit, /case when p_has_more then 'QUEUED' else 'SUCCEEDED' end/i);
  assert.match(commit, /sync_complete = not p_has_more/i);
  assert.match(commit, /page_number = j\.page_number \+ 1/i);
  assert.match(commit, /insert into public\.rv2_source_events/i);
  assert.match(commit, /payload' ->> 'symbol' <> v_job\.partition_key/i);
  assert.match(commit, /providerEventId'\) <> \([\s\S]*'binance-usdm:fills:'/i);
  assert.match(commit, /insert into private\.rv2_sync_coverage/i);
  assert.match(commit, /p_post_commit_effect jsonb/i);
  assert.match(commit, /p_trusted_through is not null/i);
  assert.doesNotMatch(
    commit.match(/p_coverage_state = 'VERIFIED'[\s\S]*?\)\) then/i)?.[0] ?? '',
    /p_trusted_through is null/i,
  );
  assert.match(commit, /rv-sync-post-commit\/1/i);
  assert.match(commit, /insert into private\.rv2_post_commit_work/i);
  assert.match(commit, /attempt_id/i);
  assert.match(commit, /input_digest/i);
  assert.match(commit, /item -> 'payload' ->> 'symbol'/i);
  assert.match(commit, /ledgerShadow/i);
  assert.match(commit, /extensions\.digest\([\s\S]*item -> 'payload'/i);
  assert.doesNotMatch(commit, /item ->> 'eventSha256'/i);
});

test('current dataset is a membership-scoped rv-cloud-dataset/1 document with execution rows', () => {
  const current = functionBody('rv2_get_current_dataset');
  assert.match(current, /rv-cloud-dataset\/1/i);
  assert.match(current, /jsonb_build_object/i);
  for (const field of [
    'format',
    'generation',
    'asOf',
    'trades',
    'reviews',
    'coverage',
    'reconciliation',
    'capabilities',
  ]) assert.match(current, new RegExp(`'${field}'`, 'i'));
  assert.match(current, /public\.rv2_source_events/i);
  assert.match(current, /dataset = 'fills'/i);
  assert.match(
    current,
    /else[\s\S]*?select[\s\S]*from public\.rv2_source_events as e[\s\S]*e\.dataset in \('fills', 'income'/i,
    'generation zero must still expose committed records while capabilities remain locked',
  );
  for (const dataset of ['trades', 'income', 'orders', 'positions']) {
    assert.match(current, new RegExp(`'${dataset}'`, 'i'));
  }
  for (const state of ['VERIFIED', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT']) {
    assert.match(sql, new RegExp(state, 'i'));
  }
  for (const capability of [
    'recordsBrowsable',
    'observedTradeAnalytics',
    'accountKpis',
    'currentPositions',
    'equityAnalytics',
    'ledger',
    'experiments',
    'ai',
  ]) assert.match(sql, new RegExp(capability, 'i'));
  assert.match(readme, /execution rows[\s\S]*id[\s\S]*symbol[\s\S]*side[\s\S]*time[\s\S]*price[\s\S]*qty[\s\S]*commission[\s\S]*realizedPnl/i);
});

test('coverage preserves four ordered watermarks per connection dataset and partition', () => {
  const coverage = tableBody('private', 'rv2_sync_coverage');
  assert.match(coverage, /primary key \(tenant_id, connection_id, dataset, partition_key\)/i);
  for (const field of ['attempted_through', 'fetched_through', 'committed_through', 'trusted_through']) {
    assert.match(coverage, new RegExp(`${field} timestamptz`, 'i'));
  }
  assert.match(coverage, /trusted_through is null[\s\S]*attempted_through is not null[\s\S]*fetched_through is not null[\s\S]*committed_through is not null[\s\S]*trusted_through <= committed_through/i);
  assert.match(coverage, /committed_through is null[\s\S]*fetched_through is not null[\s\S]*attempted_through is not null[\s\S]*committed_through <= fetched_through/i);
  assert.match(coverage, /fetched_through is null[\s\S]*attempted_through is not null[\s\S]*fetched_through <= attempted_through/i);
  assert.match(tableBody('private', 'rv2_sync_gaps'), /gap_start timestamptz not null[\s\S]*gap_end timestamptz not null/i);
});

test('dataset coverage is a weakest active-partition snapshot with partition-scoped gaps', () => {
  const coverageDocument = sql.match(/create function private\.rv2_dataset_coverage_document\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(coverageDocument, /from private\.rv2_sync_partitions as p[\s\S]*left join private\.rv2_sync_coverage as c/i);
  assert.match(coverageDocument, /p\.status = 'ACTIVE'/i);
  assert.match(coverageDocument, /coalesce\(c\.state, 'UNKNOWN'\)/i);
  assert.match(coverageDocument, /count\(c\.attempted_through\) = count\(\*\)[\s\S]*min\(c\.attempted_through\)/i);
  assert.match(coverageDocument, /count\(c\.fetched_through\) = count\(\*\)[\s\S]*min\(c\.fetched_through\)/i);
  assert.match(coverageDocument, /count\(c\.committed_through\) = count\(\*\)[\s\S]*min\(c\.committed_through\)/i);
  assert.match(coverageDocument, /count\(c\.trusted_through\) = count\(\*\)[\s\S]*min\(c\.trusted_through\)/i);
  assert.match(coverageDocument, /'partition', g\.partition_key/i);
  assert.match(coverageDocument, /'partitions'/i);
});

test('all required USD-M datasets are isolated and scheduled without a global watermark', () => {
  const requiredDatasets = [
    'fills', 'income', 'orders', 'algo_orders', 'force_orders', 'balances', 'positions',
  ];
  for (const dataset of requiredDatasets) {
    assert.match(sql, new RegExp(`'${dataset}'`, 'i'));
  }
  const coverageDocument = sql.match(/create function private\.rv2_coverage_document\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  for (const field of ['trades', 'income', 'orders', 'algoOrders', 'forceOrders', 'balances', 'positions']) {
    assert.match(coverageDocument, new RegExp(`'${field}'`, 'i'));
  }
  assert.doesNotMatch(sql, /global_watermark/i);

  const scheduler = functionBody('rv2_service_enqueue_due_syncs');
  assert.match(scheduler, /next_due_at <= statement_timestamp\(\)/i);
  assert.match(scheduler, /queue_class[\s\S]*'SCHEDULED'/i);
  assert.match(scheduler, /interval '1 hour'/i);
  assert.match(scheduler, /event_body ->> 'symbol'/i);
  assert.match(scheduler, /unnest\(array\['fills', 'orders', 'algo_orders'\]\)/i);
  assert.doesNotMatch(scheduler, /array\['fills', 'income', 'force_orders', 'balances', 'positions'\]/i);
  const discover = functionBody('rv2_service_schedule_discovered_symbols');
  assert.match(discover, /p_symbols jsonb/i);
  assert.match(discover, /unnest\(array\['fills', 'orders', 'algo_orders'\]\)/i);
  assert.doesNotMatch(discover, /'income'|'balances'|'positions'/i);
  assert.match(sql, /cron\.schedule\([\s\S]*rv2-enqueue-due-syncs/i);
  assert.match(sql, /'\*\/10 \* \* \* \*'/i);
  const archiveWake = sql.match(
    /create function private\.rv2_wake_invite_beta_archive_worker\(\)[\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(archiveWake, /rv2_archive_cron_token/i);
  assert.match(archiveWake, /\/functions\/v1\/binance-beta\/internal\/v1\/archive\/cron/i);
  assert.match(archiveWake, /'x-rv-worker-token'[\s\S]*v_archive_token/i);
  assert.match(archiveWake, /jsonb_build_object\('source', 'pg_cron'\)/i);
  assert.match(sql, /cron\.schedule\([\s\S]*rv2-wake-beta-archive-worker/i);
});

test('worker claim is globally leased and 418 opens a shared circuit breaker', () => {
  const control = tableBody('private', 'rv2_worker_control');
  assert.match(control, /singleton boolean/i);
  assert.match(control, /circuit_open_until timestamptz/i);
  const syncClaim = functionBody('rv2_service_claim_sync_job');
  const archiveClaim = functionBody('rv2_service_claim_archive_job');
  for (const claim of [syncClaim, archiveClaim]) {
    assert.match(claim, /review-workbench-rv2-global-worker-claim/i);
    assert.match(claim, /rv2_worker_control/i);
    assert.match(claim, /private\.rv2_sync_jobs/i);
    assert.match(claim, /private\.rv2_archive_jobs/i);
    assert.match(claim, /status = 'CLAIMED'[\s\S]*lease_expires_at > statement_timestamp\(\)/i);
  }
  const opener = functionBody('rv2_service_open_worker_circuit');
  assert.match(opener, /perform private\.rv2_require_service_role\(\)/i);
  assert.match(opener, /p_error_code <> 'GLOBAL_CIRCUIT_OPEN'/i);
  assert.match(opener, /circuit_open_until = greatest/i);
  const failure = functionBody('rv2_service_fail_sync_job');
  assert.match(failure, /GLOBAL_CIRCUIT_OPEN/i);
  assert.match(failure, /circuit_open_until/i);
});

test('generation publish and review updates use explicit CAS and keep ledger reconciliation shadow-only', () => {
  const publish = functionBody('rv2_service_publish_generation');
  assert.match(publish, /p_expected_generation bigint/i);
  assert.match(publish, /p_credential_version bigint/i);
  assert.match(publish, /p_job_ids uuid\[\]/i);
  assert.match(publish, /generation conflict/i);
  assert.match(publish, /status = 'succeeded'/i);
  assert.match(publish, /expected_work[\s\S]*<> j\.page_number/i);
  assert.match(publish, /expected_work[\s\S]*status = 'DONE'[\s\S]*= j\.page_number/i);
  assert.match(publish, /j\.job_id = any \(published_generation\.source_job_ids\)/i);
  assert.doesNotMatch(publish, /unnest\(p_job_ids\)|= any \(p_job_ids\)/i);
  assert.match(publish, /sourceRootSha256/i);
  assert.match(publish, /tradeProjectionSha256/i);
  assert.match(publish, /tradeModelCount/i);
  assert.match(publish, /v_projection_source_count > v_source_event_count/i);
  assert.match(publish, /v_trade_model_count > v_projection_source_count/i);
  assert.match(publish, /v_trade_model_count > 0 then 'LIMITED'/i);
  assert.match(publish, /'TRUSTED_RECORDS_ONLY'/i);
  assert.match(publish, /set capabilities = v_capabilities[\s\S]*projection_sha256/i);
  assert.doesNotMatch(publish, /p_manifest jsonb/i);
  assert.match(publish, /'RECONCILIATION_NOT_EVALUATED'/i);
  assert.match(publish, /private\.rv2_default_capabilities\(\)/i);
  assert.doesNotMatch(publish, /p_manifest\s*->\s*'reconciliation'/i);
  assert.doesNotMatch(publish, /p_manifest\s*->\s*'capabilities'/i);
  assert.doesNotMatch(publish, /'PRIMARY'/i);

  const review = functionBody('rv2_upsert_review');
  assert.match(review, /p_expected_version bigint/i);
  assert.match(review, /p_idempotency_key uuid/i);
  assert.match(review, /rv2_review_requests/i);
  assert.match(review, /request_fingerprint/i);
  assert.match(review, /idempotency key reused with different request/i);
  assert.match(review, /review version conflict/i);
  assert.match(review, /review-workbench-rv2-review-trade:/i);
  assert.match(review, /result_snapshot/i);
  assert.match(review, /resulting_updated_at/i);

  const ledger = tableBody('public', 'rv2_ledger_generations');
  const reconciliation = tableBody('public', 'rv2_reconciliation_generations');
  assert.match(ledger, /status text not null default 'SHADOW_PENDING'/i);
  assert.match(ledger, /check \(status in \('SHADOW_PENDING', 'SHADOW_READY', 'SHADOW_FAILED', 'SUPERSEDED'\)\)/i);
  assert.match(reconciliation, /state text not null default 'PENDING'/i);
  assert.match(reconciliation, /status text not null default 'UNKNOWN'/i);
  assert.match(reconciliation, /check \(state in \('PENDING', 'RUNNING', 'FINAL', 'SUPERSEDED'\)\)/i);
  assert.match(reconciliation, /check \(status in \('PASS', 'PARTIAL', 'STALE', 'UNKNOWN', 'CONFLICT'\)\)/i);
  assert.match(readme, /Ledger and reconciliation are structural shadow state only/i);
});

test('published generations expose cumulative immutable snapshots rather than only delta job ids', () => {
  for (const name of ['rv2_get_current_dataset', 'rv2_get_trades']) {
    const fn = functionBody(name);
    assert.match(fn, /e\.source_observed_at <= v_generation\.published_at/i);
    assert.doesNotMatch(fn, /e\.sync_job_id = any \(v_generation\.source_job_ids\)/i);
  }
  const publish = functionBody('rv2_service_publish_generation');
  assert.match(publish, /'snapshotThrough', v_published_at/i);
});

test('identity conflicts are durable fail-closed records and cannot be downgraded by a normal commit', () => {
  const conflicts = tableBody('private', 'rv2_source_event_conflicts');
  assert.match(conflicts, /existing_sha256 text not null/i);
  assert.match(conflicts, /observed_sha256 text not null/i);
  assert.match(conflicts, /status text not null default 'OPEN'/i);
  const commit = functionBody('rv2_service_commit_sync_page');
  assert.match(commit, /insert into private\.rv2_source_event_conflicts/i);
  assert.match(commit, /SOURCE_IDENTITY_CONFLICT/i);
  assert.match(commit, /when private\.rv2_sync_coverage\.state = 'CONFLICT' then 'CONFLICT'/i);
  assert.doesNotMatch(commit, /raise exception 'source event provider identity conflict'/i);
});

test('personal OWNER account deletion cascades domain rows while tombstones survive tenant cleanup', () => {
  const credentials = tableBody('private', 'rv2_credential_envelopes');
  const jobs = tableBody('private', 'rv2_sync_jobs');
  assert.match(credentials, /created_by uuid(?! not null)/i);
  assert.match(credentials, /rv2_credential_envelopes_member_fkey[\s\S]*on delete set null/i);
  assert.match(jobs, /rv2_sync_jobs_member_fkey[\s\S]*on delete cascade/i);
  const tombstones = tableBody('private', 'rv2_deletion_tombstones');
  assert.doesNotMatch(tombstones, /references public\.rv2_tenants/i);
  const helper = sql.match(/create function private\.rv2_clear_subject_business_data\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(helper, /member_role = 'OWNER'[\s\S]*else[\s\S]*resource not found/i);
  assert.match(helper, /delete from public\.rv2_connections/i);
  assert.match(helper, /update public\.rv2_memberships[\s\S]*status = 'DELETED'/i);
  assert.match(helper, /update public\.rv2_tenants[\s\S]*status = 'DELETED'/i);
  assert.doesNotMatch(helper, /requested_by = p_subject|created_by = null|'ADMIN'|'MEMBER'/i);
});

test('shadow ledger submissions stay job-bound and cannot unlock primary capabilities', () => {
  const shadow = functionBody('rv2_service_submit_ledger_shadow');
  assert.match(shadow, /rv2_ledger_shadow_submissions/i);
  assert.match(shadow, /rv-ledger-projection\/1/i);
  assert.match(shadow, /SHADOW_ONLY/i);
  assert.match(shadow, /ORACLE_NOT_AVAILABLE/i);
  assert.doesNotMatch(shadow, /'PASS'/i);
  assert.doesNotMatch(shadow, /PRIMARY/i);
});

test('post-commit effects use a durable capability-minimal outbox and fixed idempotent drain contract', () => {
  const outbox = tableBody('private', 'rv2_post_commit_work');
  assert.match(outbox, /attempt_id uuid not null/i);
  assert.match(outbox, /effect jsonb not null/i);
  assert.match(outbox, /input_digest text not null/i);
  assert.match(outbox, /status text not null default 'PENDING'/i);
  assert.match(outbox, /unique \(tenant_id, job_id, page_number\)/i);
  assert.match(outbox, /SYNC_EFFECTS/i);

  const claim = functionBody('rv2_service_claim_post_commit_work');
  assert.match(claim, /p_job_id uuid default null/i);
  assert.match(claim, /order by w\.available_at, w\.work_id/i);
  assert.match(claim, /for update of w skip locked/i);
  assert.match(claim, /attempt_id uuid/i);
  assert.match(claim, /input_digest text/i);
  const claimHeader = claim.match(/create(?: or replace)? function[\s\S]*?returns table[\s\S]*?\n\)/i)?.[0] ?? '';
  assert.doesNotMatch(claimHeader, /tenant_id|effect|payload|capabilit|publish/i);

  const complete = functionBody('rv2_service_complete_post_commit_work');
  assert.match(complete, /p_attempt_id uuid/i);
  assert.match(complete, /p_lease_token uuid/i);
  assert.match(complete, /p_input_digest text/i);
  assert.match(complete, /insert into private\.rv2_sync_partitions/i);
  assert.match(complete, /insert into private\.rv2_ledger_shadow_submissions/i);
  assert.match(complete, /v_job record/i);
  assert.match(complete, /trusted_through = greatest\(c\.trusted_through, c\.committed_through\)/i);
  assert.match(complete, /c\.state <> 'CONFLICT'/i);
  assert.match(complete, /rv2_service_publish_generation/i);
  assert.match(complete, /return query select true, false, 'DONE'/i);
  assert.doesNotMatch(complete, /PRIMARY|capabilit/i);

  const fail = functionBody('rv2_service_fail_post_commit_work');
  assert.match(fail, /p_retryable boolean/i);
  assert.match(fail, /p_retry_after_seconds integer/i);
  assert.match(fail, /p_attempt_id uuid/i);
  assert.doesNotMatch(fail, /trusted_through|current_generation|PRIMARY|capabilit/i);
});

test('archive worker state is leased, job-bound, private, resumable, and releases failures', () => {
  const jobs = tableBody('private', 'rv2_archive_jobs');
  assert.match(jobs, /claim_token uuid/i);
  assert.match(jobs, /lease_expires_at timestamptz/i);
  assert.match(jobs, /archive_state jsonb/i);
  assert.match(jobs, /window_start text not null/i);
  assert.match(jobs, /window_end text not null/i);

  const claim = functionBody('rv2_service_claim_archive_job');
  assert.match(claim, /p_job_id uuid default null/i);
  assert.match(claim, /p_job_id is null or j\.job_id = p_job_id/i);
  assert.match(claim, /order by j\.available_at, j\.job_id/i);
  assert.match(claim, /for update(?: of j)? skip locked/i);
  assert.match(claim, /rv2_credential_envelopes/i);
  assert.match(claim, /envelope_ciphertext/i);
  assert.match(claim, /claim_token/i);

  const commit = functionBody('rv2_service_commit_archive_state');
  assert.match(commit, /p_state ->> 'status'/i);
  assert.match(commit, /REQUEST_PENDING|POLL_PENDING/i);
  assert.match(commit, /CSV_REQUIRED/i);
  assert.match(commit, /STAGED/i);
  assert.doesNotMatch(commit, /download_url/i);

  const fail = functionBody('rv2_service_fail_archive_job');
  assert.match(fail, /claim_token = null/i);
  assert.match(fail, /lease_expires_at = null/i);
  assert.match(fail, /p_retryable/i);
  assert.match(fail, /GLOBAL_CIRCUIT_OPEN/i);
  assert.match(fail, /rv2_service_open_worker_circuit/i);
  assert.match(fail, /AUTH_DISABLED[\s\S]*AUTH_ERROR/i);
  assert.match(fail, /RATE_LIMITED[\s\S]*RATE_LIMITED/i);
  assert.match(fail, /p_error_code in \('RATE_LIMITED', 'GLOBAL_CIRCUIT_OPEN'\)[\s\S]*make_interval\(secs => p_retry_after_seconds\)/i);

  const stage = functionBody('rv2_service_stage_archive_link');
  assert.match(stage, /private\.rv2_archives/i);
  assert.match(stage, /p_download_url/i);
  assert.match(stage, /p_expires_at > statement_timestamp\(\)/i);
  assert.match(stage, /p_expires_at > statement_timestamp\(\) \+ interval '7 days'/i);
  assert.match(stage, /p_claim_token/i);
});

test('beta operations OIDC claims are unique, expiring, capability and exact-run bound', () => {
  const claims = tableBody('private', 'rv2_ops_oidc_claims');
  assert.match(claims, /oidc_jti_sha256 text not null/i);
  assert.match(claims, /constraint rv2_ops_oidc_claims_jti_key unique \(oidc_jti_sha256\)/i);
  assert.match(claims, /capability text not null/i);
  assert.match(claims, /run_id text not null/i);
  assert.match(claims, /run_attempt text not null/i);
  assert.match(claims, /expires_at timestamptz not null/i);
  assert.match(claims, /binding_sha256 text not null/i);
  assert.match(claims, /beta-backup/i);
  assert.match(claims, /beta-archive/i);
  assert.match(claims, /beta-capacity-observe/i);
  const fn = functionBody('rv2_ops_claim_oidc_jti');
  assert.match(fn, /jsonb_object_keys\(p_binding\)/i);
  assert.match(fn, /p_expires_at > statement_timestamp\(\) \+ interval '10 minutes'/i);
  assert.match(fn, /on conflict \(oidc_jti_sha256\) do nothing/i);
  assert.match(fn, /beta-capacity-observe/i);
  assert.match(fn, /first_use/i);
});

test('backup pages come from a materialized immutable snapshot with a bounded cursor chain', () => {
  const snapshots = tableBody('private', 'rv2_ops_backup_snapshots');
  const rows = tableBody('private', 'rv2_ops_backup_snapshot_rows');
  assert.match(snapshots, /snapshot_epoch timestamptz not null/i);
  assert.match(snapshots, /unique \(run_id, run_attempt\)/i);
  assert.match(rows, /row_ordinal bigint not null/i);
  assert.match(rows, /row_data jsonb not null/i);
  assert.match(rows, /'reports'/i);
  assert.doesNotMatch(rows, /credential|envelope|secret|key_ref/i);
  const materialize = sql.match(
    /create function private\.rv2_ops_materialize_backup_snapshot\([\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(materialize, /lock table public\.rv2_tenants[\s\S]*public\.rv2_reports[\s\S]*in share mode/i);
  assert.match(materialize, /select p_snapshot_id, 'reports'/i);
  for (const field of [
    'reportId', 'reportType', 'periodStart', 'periodEnd', 'sourceGeneration',
    'payloadSha256', 'createdBy', 'createdAt', 'updatedAt',
  ]) assert.match(materialize, new RegExp(`'${field}'`, 'i'));
  const readPage = functionBody('rv2_ops_read_backup_page');
  assert.match(readPage, /p_limit <> 1000/i);
  assert.match(readPage, /private\.rv2_ops_materialize_backup_snapshot/i);
  assert.match(readPage, /beta-backup-page\/1/i);
  assert.match(readPage, /beta_backup_v1/i);
  assert.match(readPage, /snapshot_id/i);
  assert.match(readPage, /nextCursor/i);
  assert.match(readPage, /row_ordinal > v_offset/i);
  assert.doesNotMatch(readPage, /rv2_credential_envelopes|envelope_ciphertext/i);
});

test('backup signing claims require persisted page chain, row counts and exact object metadata once', () => {
  const evidence = tableBody('private', 'rv2_ops_backup_page_evidence');
  const signing = tableBody('private', 'rv2_ops_backup_signing_claims');
  assert.match(evidence, /page_sha256 text not null/i);
  assert.match(evidence, /request_cursor_key text not null/i);
  assert.match(signing, /object_key text not null/i);
  assert.match(signing, /object_bytes bigint not null/i);
  assert.match(signing, /object_sha256 text not null/i);
  const record = functionBody('rv2_ops_record_backup_page_evidence');
  assert.match(record, /request fingerprint conflict/i);
  const claim = functionBody('rv2_ops_claim_backup_signing_evidence');
  assert.match(claim, /for update/i);
  assert.match(claim, /rv2_ops_backup_snapshot_rows/i);
  assert.match(claim, /rv2_ops_backup_page_evidence/i);
  assert.match(claim, /p_row_counts/i);
  assert.match(claim, /p_object_key not like p_scope_prefix \|\| '%'/i);
  assert.match(claim, /p_object_bytes <= 0/i);
  assert.match(claim, /p_object_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(claim, /first_use/i);
});

test('restore tombstones and manifest claims are durable before any staging import', () => {
  const runs = tableBody('private', 'rv2_ops_restore_runs');
  assert.match(runs, /tombstones_applied_at timestamptz/i);
  assert.match(runs, /manifest_nonce text/i);
  assert.match(runs, /manifest_sha256 text/i);
  assert.match(runs, /requires_reconnect boolean not null default true/i);
  assert.match(runs, /ownership_verified boolean not null default false/i);
  assert.match(runs, /external_tombstone_verified boolean not null default false/i);
  assert.match(runs, /EXTERNAL_TOMBSTONE_JOURNAL_NOT_VERIFIED/i);
  assert.match(runs, /status in \('TOMBSTONES_APPLIED', 'CLAIMED', 'QUARANTINED', 'FAILED'\)/i);
  assert.match(runs, /published_at is null[\s\S]*not ownership_verified[\s\S]*not external_tombstone_verified/i);
  assert.doesNotMatch(runs, /'PUBLISHED'/i);
  const apply = functionBody('rv2_ops_apply_deletion_tombstones');
  assert.match(apply, /p_target_generation <> p_active_generation \+ 1/i);
  assert.match(apply, /private\.rv2_deletion_tombstones/i);
  assert.match(apply, /tombstone_cutoff/i);
  const claim = functionBody('rv2_ops_claim_restore_manifest');
  assert.match(claim, /tombstones_applied_at is not null/i);
  assert.match(claim, /manifest_nonce/i);
  assert.match(claim, /manifest_sha256/i);
  assert.match(claim, /first_use/i);
  assert.match(claim, /status = 'QUARANTINED'/i);
  assert.match(tableBody('private', 'rv2_ops_restore_batches'), /batch_sha256 text not null/i);
  assert.match(tableBody('private', 'rv2_ops_restore_batches'), /'reports'/i);
  assert.match(tableBody('private', 'rv2_ops_restore_staging_rows'), /row_data jsonb not null/i);
  assert.doesNotMatch(sql, /create function public\.rv2_ops_finalize_restore\(/i);
  assert.doesNotMatch(sql, /status\s*=\s*'PUBLISHED'[\s\S]{0,500}rv2_ops_restore_runs/i);
});

test('archive URL claims, complete batches, and atomic finalize remain run-bound and fail closed', () => {
  const archives = tableBody('private', 'rv2_archives');
  assert.match(archives, /job_id uuid not null/i);
  assert.match(archives, /download_url text/i);
  assert.match(archives, /claimed_run_id text/i);
  assert.match(archives, /claimed_at timestamptz/i);
  assert.match(archives, /payload_evidence_source text/i);
  assert.match(archives, /'ATTESTED'/i);
  assert.match(archives, /finalize_sha256 text/i);
  assert.match(archives, /coverage_evidence jsonb/i);
  assert.match(archives, /'COMPLETED'/i);
  assert.match(archives, /'CONFLICT'/i);
  const claim = functionBody('rv2_ops_claim_archive_download');
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /pg_advisory_xact_lock/i);
  assert.match(claim, /prior\.claimed_run_id = p_run_id/i);
  assert.match(sql, /create unique index rv2_archives_claimed_run_attempt_key[\s\S]*claimed_run_id[\s\S]*claimed_run_attempt/i);
  assert.match(claim, /expires_at > statement_timestamp\(\)/i);
  assert.match(claim, /claimed_at is null/i);
  assert.match(claim, /status in \('PENDING', 'READY'\)/i);
  assert.match(claim, /status = 'FAILED'[\s\S]*download_url = null/i);
  const attest = functionBody('rv2_ops_attest_archive_payload');
  assert.match(attest, /claimed_run_id = p_run_id/i);
  assert.match(attest, /claimed_run_attempt = p_run_attempt/i);
  assert.match(attest, /ARCHIVE_PAYLOAD_MISMATCH/i);
  assert.match(attest, /accepted[\s\S]*false/i);
  assert.match(attest, /status = 'ATTESTED'/i);
  assert.match(attest, /payload_evidence_source/i);
  const fail = functionBody('rv2_ops_fail_archive_claim');
  assert.match(fail, /claimed_run_id = p_run_id/i);
  assert.match(fail, /claimed_run_attempt = p_run_attempt/i);
  assert.match(fail, /status = 'FAILED'/i);
  assert.match(fail, /download_url = null/i);
  const ingest = functionBody('rv2_ops_ingest_archive_batch');
  assert.match(ingest, /a\.status = 'ATTESTED'/i);
  assert.match(ingest, /batch_sha256/i);
  assert.match(ingest, /archive batch replay conflict/i);
  assert.match(ingest, /rv2_ops_archive_staging_rows/i);
  assert.ok(
    ingest.indexOf('insert into private.rv2_ops_archive_batches')
      < ingest.indexOf('insert into private.rv2_ops_archive_staging_rows'),
    'archive batch parent row must exist before immediate-FK staging rows',
  );
  assert.match(ingest, /replayed/i);
  assert.match(ingest, /total_batches/i);
  const finalize = functionBody('rv2_ops_finalize_archive');
  assert.match(finalize, /perform private\.rv2_require_service_role\(\)/i);
  assert.match(finalize, /for update/i);
  assert.match(finalize, /v_archive\.status <> 'ATTESTED'/i);
  assert.match(finalize, /generate_series\(0, v_total_batches - 1\)/i);
  assert.match(finalize, /batch set digest mismatch/i);
  assert.match(finalize, /private\.rv2_ops_archive_staging_rows/i);
  assert.match(finalize, /private\.rv2_source_event_conflicts/i);
  assert.match(finalize, /source_event_provider_identity_conflict|source event provider identity conflict/i);
  assert.match(finalize, /insert into public\.rv2_source_events/i);
  assert.match(finalize, /ARCHIVE_PROVIDER_IDENTITY_CONFLICT/i);
  assert.match(finalize, /ARCHIVE_RECONCILIATION_PENDING/i);
  assert.match(finalize, /trusted_advanced/i);
  assert.match(finalize, /return query select[\s\S]*false/i);
  assert.doesNotMatch(finalize, /rv2_service_publish_generation/i);
});

test('all beta operations RPCs are service-role-only and direct tables remain closed', () => {
  const serviceGuard = sql.match(
    /create function private\.rv2_require_service_role\(\)[\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(serviceGuard, /auth\.role\(\)/i);
  assert.match(serviceGuard, /<> 'service_role'/i);
  for (const name of opsServiceRpcs) {
    const fn = functionBody(name);
    assert.match(fn, /security definer/i);
    assert.match(fn, /set search_path = pg_catalog/i);
    assert.match(fn, /perform private\.rv2_require_service_role\(\)/i);
    assert.match(sql, new RegExp(
      `revoke all on function public\\.${name}\\([^;]*\\) from public, anon, authenticated, service_role;`,
      'i',
    ));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to service_role;`, 'i'));
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${name}\\([^;]*\\) to authenticated;`, 'i'));
  }
  for (const name of [
    'rv2_service_claim_archive_job',
    'rv2_service_commit_archive_state',
    'rv2_service_fail_archive_job',
    'rv2_service_stage_archive_link',
  ]) {
    assert.match(functionBody(name), /perform private\.rv2_require_service_role\(\)/i);
  }
});

test('browser list APIs remain tenant-derived and destructive operations cannot bypass the journal-gated v2 transaction', () => {
  const trades = functionBody('rv2_get_trades');
  assert.match(trades, /'format', 'rv-cloud-trades\/1'/i);
  assert.match(trades, /'trades', v_items/i);
  assert.match(trades, /private\.rv2_require_browser_tenant\(\)/i);
  assert.match(trades, /public\.rv2_source_events/i);
  assert.match(trades, /dataset = 'fills'/i);
  assert.match(trades, /else\s+select[\s\S]*from public\.rv2_source_events as e/i);

  const reviews = functionBody('rv2_get_reviews');
  assert.match(reviews, /'format', 'rv-cloud-reviews\/1'/i);
  assert.match(reviews, /'reviews', v_(?:reviews|items)/i);
  assert.match(reviews, /private\.rv2_require_browser_tenant\(\)/i);
  assert.match(reviews, /public\.rv2_reviews/i);

  const clear = functionBody('rv_service_execute_business_deletion');
  assert.match(clear, /private\.rv_core_service_execute_business_deletion/i);
  assert.doesNotMatch(clear, /private\.rv2_clear_subject_business_data/i);
  assert.match(clear, /journal-bypassing rv2 deletion path/i);

  const beginAccountDelete = functionBody('rv_mark_destructive_operation_deleting');
  assert.match(beginAccountDelete, /private\.rv_core_mark_destructive_operation_deleting/i);
  assert.doesNotMatch(beginAccountDelete, /private\.rv2_clear_subject_business_data/i);
  assert.match(beginAccountDelete, /v2 intent[\s\S]*before this account state may advance to Auth deletion/i);

  const account = functionBody('rv2_service_delete_tenant_data');
  assert.match(account, /m\.member_role = 'OWNER'/i);
  assert.match(account, /insert into private\.rv2_deletion_tombstones/i);
  assert.match(account, /'DELETE_ACCOUNT'/i);

  const tombstones = tableBody('private', 'rv2_deletion_tombstones');
  assert.match(tombstones, /operation text not null/i);
  assert.match(tombstones, /backup_purge_after timestamptz not null/i);
  assert.match(tombstones, /check \(operation in \('CLEAR_BUSINESS_DATA', 'DELETE_ACCOUNT'\)\)/i);
  const helper = sql.match(/create function private\.rv2_clear_subject_business_data\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(helper, /member_role = 'OWNER'/i);
  assert.match(helper, /delete from public\.rv2_connections/i);
  assert.match(helper, /insert into private\.rv2_deletion_tombstones/i);
  assert.doesNotMatch(clear, /delete from auth\.users/i);
});

test('pg_cron wake-up targets the exact token-authenticated one-page worker route', () => {
  assert.match(sql, /\/functions\/v1\/binance-beta\/internal\/v1\/sync\/cron/i);
  assert.match(sql, /'x-rv-worker-token', v_worker_token/i);
  assert.match(sql, /jsonb_build_object\('source', 'pg_cron'\)/i);
  assert.doesNotMatch(sql, /\/functions\/v1\/binance-beta\/internal\/worker/i);
  assert.match(sql, /v_worker_token !~ '\^\[A-Za-z0-9_\-\]\{64\}\$'/i);
});

test('README records at least three concrete honest boundaries and PII-free operational codes', () => {
  assert.match(readme, /## rv2 invite-only Beta data plane/i);
  assert.match(readme, /## rv2 honest boundaries/i);
  const boundaries = readme.match(/## rv2 honest boundaries([\s\S]*?)(?:\n## |$)/i)?.[1] ?? '';
  assert.ok((boundaries.match(/^\s*- /gm) ?? []).length >= 3, 'expected at least three rv2 honest boundaries');
  assert.match(sql, /error_code text/i);
  assert.doesNotMatch(tableBody('private', 'rv2_sync_attempts'), /error_message|stack|email|api_key|api_secret/i);
  assert.doesNotMatch(tableBody('private', 'rv2_egress_receipts'), /destination_url|ip_address|email|headers|authorization/i);
});
