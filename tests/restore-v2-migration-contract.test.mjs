import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_PATH = path.join(ROOT, 'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql');
const DATA_PLANE_SQL_PATH = path.join(
  ROOT,
  'supabase/production-vault/migrations/20260831000100_invite_beta_rv2_data_plane.sql',
);

test('restore v2 migration is private, forced-RLS and service-role RPC only', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const tables = [...sql.matchAll(/create table private\.(rv2_restore_v2_[a-z0-9_]+)/gu)].map(match => match[1]);
  assert.ok(tables.length >= 8);
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table private\\.${table} enable row level security`, 'u'));
    assert.match(sql, new RegExp(`alter table private\\.${table} force row level security`, 'u'));
    assert.match(sql, new RegExp(`revoke all privileges on table private\\.${table} from public, anon, authenticated, service_role`, 'u'));
  }
  const functions = [...sql.matchAll(/create function public\.(rv2_restore_v2_[a-z0-9_]+)\(/gu)].map(match => match[1]);
  assert.ok(functions.length >= 8);
  for (const name of functions) {
    const start = sql.indexOf(`create function public.${name}(`);
    const end = sql.indexOf('$function$;', start);
    const body = sql.slice(start, end);
    assert.match(body, /security definer/iu);
    assert.match(body, /set search_path = pg_catalog/iu);
    assert.match(body, /perform private\.rv2_require_service_role\(\)/u);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(`, 'u'));
  }
});

test('restore v2 SQL fails closed on legacy, non-empty, missing journal proof and owner claims', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  assert.match(sql, /LEGACY_UNTRUSTED/u);
  assert.match(sql, /TARGET_PROJECT_NOT_EMPTY/u);
  assert.match(sql, /EXTERNAL_JOURNAL_PROOF_MISSING/u);
  assert.match(sql, /OWNER_RECOVERY_INCOMPLETE/u);
  assert.match(sql, /QUARANTINED/u);
  assert.match(sql, /RECONNECT_REQUIRED/u);
  assert.match(sql, /invite_expires_at[^]*interval '10 minutes'/iu);
  assert.match(sql, /invite_delivery_id[^]*invite_nonce[^]*invite_generation/iu);
  assert.match(sql, /for update[^]*owner recovery invite expired/iu);
  assert.match(sql, /credentials_restored[^\n]*0/iu);
  assert.match(sql, /CAPACITY_MIGRATION_003_REQUIRED/u);
  assert.match(sql, /TARGET_CAPACITY_OBSERVATION_REQUIRED/u);
  assert.match(sql, /to_regclass\('private[.]rv2_ops_capacity_observations'\)/u);
  assert.match(sql, /to_regprocedure\('public[.]rv2_service_get_operational_health\(\)'\)/u);
  assert.doesNotMatch(sql, /insert into private\.rv2_credential_envelopes/iu);
});

test('restore v2 preserves the personal beta one OWNER per tenant invariant', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const rowValidator = sql.match(
    /create function private\.rv2_restore_v2_stage_row_is_valid\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  const stage = sql.match(
    /create function public\.rv2_restore_v2_stage_batch\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(sql, /rv2_restore_v2_principal_role_check check \(member_role = 'OWNER'\)/iu);
  assert.match(sql, /PERSONAL_TENANT_MEMBERSHIP_INVALID/u);
  assert.match(sql, /dataset = 'memberships'[^]*coalesce\(m\.payload ->> 'memberRole', ''\) <> 'OWNER'/iu);
  assert.match(sql, /group by m\.tenant_lineage_id[^]*having count\(\*\) <> 1/iu);
  assert.match(rowValidator, /dataset' = 'memberships'[^]*memberRole'[^]*<> 'OWNER'[^]*status'[^]*<> 'ACTIVE'[^]*return false/iu);
  assert.match(stage, /CREDENTIAL_FIELD_FORBIDDEN[^]*PERSONAL_TENANT_MEMBERSHIP_INVALID[^]*insert into private\.rv2_restore_v2_batches/iu);
  assert.match(stage, /v_run\.state = 'QUARANTINED'[^]*'accepted', false/iu);
  assert.match(stage, /if found then[^]*restore batch idempotency conflict[^]*rv2_restore_v2_stage_row_is_valid[^]*PERSONAL_TENANT_MEMBERSHIP_INVALID[^]*'idempotent', true/iu);
  assert.ok(stage.indexOf('select b.* into v_existing')
    < stage.indexOf("if v_run.state not in ('STAGING', 'NOT_READY')"));
  assert.ok(stage.indexOf("raise exception 'PERSONAL_TENANT_MEMBERSHIP_INVALID'")
    < stage.indexOf("'idempotent', true"));
  assert.doesNotMatch(sql, /other memberships must be re-invited/iu);
});

test('owner self-recovery uniquely matches verified Auth email and keeps invite material internal', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const recovery = sql.match(
    /create function public\.rv2_restore_v2_recover_owner_by_verified_subject\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(recovery, /perform private\.rv2_require_service_role\(\)/u);
  assert.match(recovery, /from auth\.users[^]*email_confirmed_at/iu);
  assert.match(recovery, /for update[^]*rv2_restore_v2_runs[^]*for update/iu);
  assert.match(recovery, /v_existing_count = 1[^]*'idempotent', true/iu);
  assert.match(recovery, /v_run\.state not in \('AWAITING_OWNER_CLAIMS', 'PUBLISHABLE'\)/u);
  assert.match(recovery, /v_run\.state <> 'AWAITING_OWNER_CLAIMS'/u);
  assert.match(recovery, /private\.rv2_restore_v2_recovery_tag\([^]*v_user\.email/iu);
  assert.match(recovery, /v_match_count = 0[^]*P0002[^]*v_match_count <> 1[^]*40001/iu);
  assert.match(recovery, /claimed_user_id = p_subject[^]*principal_lineage_id <> v_match_principal/iu);
  assert.match(recovery, /rv-restore-v2-owner-invite\/1[^]*v_invite_claim/iu);
  assert.match(recovery, /set state = 'CLAIMED'[^]*claimed_user_id = p_subject/iu);
  assert.match(recovery, /state = 'PUBLISHABLE'[^]*graph_verified[^]*journal_proof_verified/iu);
  assert.match(recovery, /'inviteClaimDisclosed', false/iu);
  assert.doesNotMatch(recovery, /'inviteClaim'\s*,/iu);
  assert.match(sql, /revoke all on function public\.rv2_restore_v2_recover_owner_by_verified_subject\(uuid, uuid\) from public, anon, authenticated, service_role/u);
  assert.match(sql, /grant execute on function public\.rv2_restore_v2_recover_owner_by_verified_subject\(uuid, uuid\) to service_role/u);
});

test('deletion state machine journals first and publish transaction verifies graph before state change', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  assert.match(sql, /PENDING_JOURNAL[^]*JOURNALED[^]*DELETED/u);
  assert.match(sql, /DELETION_JOURNAL_REQUIRED/u);
  assert.match(sql, /DANGLING_FOREIGN_KEY/u);
  assert.match(sql, /CROSS_TENANT_REFERENCE/u);
  assert.match(sql, /CREDENTIAL_FIELD_FORBIDDEN/u);
  assert.match(sql, /set constraints all immediate/iu);
  assert.match(sql, /exception\s+when others[^]*QUARANTINED/iu);
  const execute = sql.match(
    /create function public\.rv2_restore_v2_execute_deletion\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(execute, /v_intent\.state <> 'JOURNALED'/iu);
  assert.match(execute, /set_config\([\s\S]*review_workbench\.rv2_journal_delete_intent[\s\S]*v_intent\.intent_id::text/iu);
  assert.match(execute, /rv2_clear_subject_business_data[\s\S]*set_config\('review_workbench\.rv2_journal_delete_intent', '', true\)/iu);
});

test('deletion intent hashes the exact canonical object bytes and accepts normal dot-json keys', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const helper = sql.match(
    /create function private\.rv2_restore_v2_deletion_event_object_text\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  const intent = sql.match(
    /create function public\.rv2_restore_v2_create_deletion_intent\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(helper, /committedAt[^]*eventId[^]*format[^]*operation[^]*tenantLineageId/iu);
  assert.match(helper, /\|\| '\}' \|\| chr\(10\)/iu);
  assert.match(intent, /rv2_restore_v2_deletion_event_object_text\(v_event\)/iu);
  assert.doesNotMatch(intent, /convert_to\(v_event::text/iu);
  assert.match(sql, /\[\.\]json\$/u);
  assert.doesNotMatch(sql, /\\\\\.json/iu);
  const attest = sql.match(
    /create function public\.rv2_restore_v2_attest_deletion_journal\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(attest, /snapshotJournalRoot[^]*firstPassRoot/iu);
  assert.match(attest, /objectCount' <> '1'/iu);
  assert.match(attest, /rv-deletion-journal-list\/2' \|\| chr\(0\)[^]*objectKey[^]*objectSha256[^]*objectBytes[^]*chr\(10\)/iu);
  assert.match(attest, /jsonb_array_length\(p_range_proof -> 'events'\) <> 1/iu);
});

test('32-day journal budget reserves account erasure and proves the 4096-object worst case', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const dataPlane = fs.readFileSync(DATA_PLANE_SQL_PATH, 'utf8');
  const intent = sql.match(
    /create function public\.rv2_restore_v2_create_deletion_intent\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(intent, /review-workbench-rv2-deletion-journal-32d-budget/iu);
  assert.match(intent, /created_at >= statement_timestamp\(\) - interval '32 days'/iu);
  assert.match(intent, /v_recent_count >= 4096/iu);
  assert.match(intent, /DELETE_BUSINESS_DATA'[\s\S]*v_recent_count >= 4086/iu);
  assert.match(intent, /DELETE_BUSINESS_DATA'[\s\S]*interval '24 hours'/iu);
  assert.match(intent, /DELETE_ACCOUNT'[\s\S]*subject_id = p_subject[\s\S]*interval '32 days'/iu);
  assert.match(intent, /member_role <> 'OWNER'/iu);
  assert.match(dataPlane, /if v_count >= 10 then[\s\S]*global invite beta capacity exceeded/iu);

  const journalAdmissionStop = 4086;
  const maximumActiveAccounts = 10;
  const proofCapacity = 4096;
  assert.equal(journalAdmissionStop + maximumActiveAccounts, proofCapacity);
});

test('claim and publish require realistic fresh proofs and publish re-applies later tombstones', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const validator = sql.match(
    /create function private\.rv2_restore_v2_journal_proof_is_valid\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  const claim = sql.match(
    /create function public\.rv2_restore_v2_claim_restore\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  const publish = sql.match(
    /create function public\.rv2_restore_v2_publish\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(validator, /statement_timestamp\(\) - interval '5 minutes'/iu);
  assert.match(validator, /statement_timestamp\(\) \+ interval '5 minutes'/iu);
  assert.match(validator, /p_minimum_range_end[^]*v_range_end < p_minimum_range_end/iu);
  assert.match(validator, /date_trunc\('day'[^]*interval '1 day'/iu);
  assert.match(validator, /v_object_count > 4096/iu);
  assert.match(validator, /jsonb_array_length\(p_proof -> 'events'\) <> v_object_count/iu);
  assert.doesNotMatch(claim, /v_range_end < statement_timestamp\(\)\s*(?:or|then)/iu);
  assert.match(claim, /review-workbench-rv2-deletion-journal-32d-budget/iu);
  assert.match(claim, /i[.]created_at > v_range_end[^]*EXTERNAL_JOURNAL_PROOF_MISSING/iu);
  assert.match(publish, /p_journal_proof jsonb/iu);
  assert.match(publish, /v_run[.]journal_range_end/iu);
  assert.match(publish, /i[.]created_at > v_range_end[^]*FINAL_JOURNAL_PROOF_REQUIRED/iu);
  assert.match(publish, /rv-restore-v2-effective-tenant-lineage\/1[^]*effectiveTenantLineageRoot/iu);
  assert.match(publish, /update private[.]rv2_restore_v2_staging_rows[^]*suppressed_by_deletion = exists/iu);
  assert.match(publish, /journal_final_proof_sha256[^]*journal_final_verified_at/iu);
  assert.match(sql, /rv2_restore_v2_publish\(uuid, jsonb\)/iu);
});

test('restore-v2 materialized row count sums rows rather than counting datasets', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const materializer = sql.match(
    /create function private\.rv2_restore_v2_materialize_backup_export\([\s\S]*?\n\$function\$;/iu,
  )?.[0] ?? '';
  assert.match(materializer, /select coalesce\(sum\(counts\.row_count\), 0\)/iu);
  assert.doesNotMatch(materializer, /select count\(\*\),\s*coalesce\(jsonb_object_agg\(counts\.dataset/iu);
});

test('snapshot export contains stable lineage and trade FK order is generation then identity then model then review', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  assert.match(sql, /rv2_restore_v2_export_snapshot_rows/iu);
  assert.match(sql, /tenantLineageId[^]*principalLineageId[^]*recoveryTagHash[^]*connectionLineageId/iu);
  const generation = sql.indexOf('insert into public.rv2_generations');
  const identity = sql.indexOf('insert into public.rv2_trade_identities');
  const model = sql.indexOf('insert into public.rv2_trade_read_models');
  const review = sql.indexOf('insert into public.rv2_reviews');
  assert.ok(generation > 0 && generation < identity && identity < model && model < review);
  assert.match(sql, /sourceRootSha256[^]*sourceEventCount[^]*projectionSha256[^]*tradeModelCount/iu);
  assert.match(sql, /trade_generation[^]*source_lineage_sha256/iu);
  assert.match(sql, /DANGLING_FOREIGN_KEY/u);
});

test('public staging includes deployable restore v2 bytes but excludes the private operator plane', () => {
  const allowlist = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts/public-staging-allowlist.json'), 'utf8',
  ));
  for (const required of [
    'supabase/functions/restore-v2/README.md',
    'supabase/functions/restore-v2/core.mjs',
    'supabase/functions/restore-v2/handler.mjs',
    'supabase/functions/restore-v2/index.ts',
    'supabase/functions/restore-v2/runtime.mjs',
    'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
  ]) assert.ok(allowlist.files.includes(required), `public restore runtime is missing ${required}`);
  assert.deepEqual(
    allowlist.mappedFiles.find(({ target }) => (
      target === 'supabase/migrations/20260831000200_restore_v2_lineage.sql'
    )),
    {
      source: 'supabase/production-vault/migrations/20260831000200_restore_v2_lineage.sql',
      target: 'supabase/migrations/20260831000200_restore_v2_lineage.sql',
    },
  );

  const exportedPaths = [
    ...allowlist.files,
    ...allowlist.mappedFiles.flatMap(({ source, target }) => [source, target]),
  ].join('\n');
  assert.doesNotMatch(exportedPaths, /(?:^|\/)scripts\/beta-ops(?:\/|$)/imu);
  assert.doesNotMatch(exportedPaths, /(?:^|\/)\.github\/workflows\/beta-(?:archive|backup)\.yml$/imu);
  assert.doesNotMatch(exportedPaths, /(?:^|\/)\.env(?:\.|\/|$)|(?:^|\/)(?:secrets?|runtime-data)(?:\/|$)/imu);

  const exporter = fs.readFileSync(path.join(ROOT, 'scripts/export-public-staging.mjs'), 'utf8');
  const publicExceptions = exporter.match(
    /const SUPABASE_PUBLIC_EXCEPTIONS = new Set\(\[[\s\S]*?\n\]\);/u,
  )?.[0] ?? '';
  assert.match(publicExceptions, /supabase\/functions\/restore-v2\/index\.ts/u);
  assert.match(publicExceptions, /20260831000200_restore_v2_lineage\.sql/u);
  assert.doesNotMatch(publicExceptions, /scripts\/beta-ops|\.github\/workflows\/beta-/iu);
});
