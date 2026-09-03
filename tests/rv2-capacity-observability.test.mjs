import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../supabase/production-vault/migrations/20260831000300_invite_beta_capacity_observability.sql',
  import.meta.url,
);

const sql = await readFile(migrationUrl, 'utf8').catch((error) => {
  if (error?.code === 'ENOENT') return '';
  throw error;
});

function functionBody(name) {
  const match = sql.match(new RegExp(
    `create(?: or replace)? function (?:public|private)\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`,
    'i',
  ));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

test('capacity migration is additive, transactional, and private by default', () => {
  assert.match(sql, /^-- Invite Beta free-plan capacity and PII-free operations guard\./i);
  assert.match(sql, /\nbegin;[\s\S]*\ncommit;\s*$/i);
  assert.doesNotMatch(sql, /\b(?:drop|truncate)\b/i);

  for (const table of ['rv2_ops_capacity_observations']) {
    assert.match(sql, new RegExp(`create table private\\.${table} \\(`, 'i'));
    assert.match(sql, new RegExp(`alter table private\\.${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table private\\.${table} force row level security;`, 'i'));
    assert.match(sql, new RegExp(
      `revoke all (?:privileges )?on table private\\.${table} from public, anon, authenticated, service_role;`,
      'i',
    ));
  }
});

test('observations are append-only, bounded, aggregate-only, and evidence bound', () => {
  const table = sql.match(
    /create table private\.rv2_ops_capacity_observations \(([\s\S]*?)\n\);/i,
  )?.[1] ?? '';
  assert.match(table, /db_bytes bigint not null/i);
  assert.match(table, /r2_standard_bytes bigint not null/i);
  assert.match(table, /actions_minutes_used numeric\(12, 3\) not null/i);
  assert.match(table, /actions_minutes_limit numeric\(12, 3\) not null/i);
  assert.match(table, /backup_object_age_seconds bigint/i);
  assert.match(table, /smtp_delivery_failures_24h integer not null/i);
  assert.match(table, /evidence_sha256 text not null/i);
  assert.doesNotMatch(table, /tenant_id|user_id|connection_id|email|subject|provider_event/i);

  const immutable = functionBody('rv2_ops_capacity_observation_immutable');
  assert.match(immutable, /if tg_op in \('UPDATE', 'DELETE'\)/i);
  assert.match(immutable, /capacity observation is append-only/i);
  assert.match(sql, /before update or delete on private\.rv2_ops_capacity_observations/i);
});

test('service observation records live DB size and validates external evidence', () => {
  const record = functionBody('rv2_service_record_capacity_observation');
  assert.match(record, /perform private\.rv2_require_service_role\(\)/i);
  assert.match(record, /pg_database_size\(current_database\(\)\)/i);
  assert.match(record, /p_evidence_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(record, /extensions\.digest\(convert_to\([\s\S]*?'rv-capacity-observation\/1'/i);
  assert.match(record, /v_expected_sha256 <> p_evidence_sha256/i);
  assert.match(record, /p_observed_at < statement_timestamp\(\) - interval '24 hours'/i);
  assert.match(record, /pg_advisory_xact_lock/i);
  assert.match(record, /idempotency evidence reused with different observation/i);
  assert.match(record, /insert into private\.rv2_ops_capacity_observations/i);
  assert.doesNotMatch(record, /p_(?:tenant|user|connection|email|subject)/i);

  assert.match(sql, /revoke execute on function public\.rv2_service_record_capacity_observation\([\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant execute on function public\.rv2_service_record_capacity_observation\([\s\S]*?to service_role;/i);
});

test('admission and history fail closed on stale or unknown external usage', () => {
  const state = functionBody('rv2_ops_resource_state');
  assert.match(state, /pg_database_size\(current_database\(\)\)/i);
  assert.match(state, /314572800/); // 300 MiB warning
  assert.match(state, /367001600/); // 350 MiB stop admission and history
  assert.match(state, /419430400/); // 400 MiB maintenance read-only
  assert.match(state, /6442450944/); // 60% of 10 GiB
  assert.match(state, /8589934592/); // 80% of 10 GiB
  assert.match(state, /external_usage_known/i);
  assert.match(state, /observed_at >= statement_timestamp\(\) - interval '24 hours'/i);
  assert.match(state, /rv2_restore_v2_deletion_intents/i);
  assert.match(state, /created_at >= statement_timestamp\(\) - interval '32 days'/i);
  assert.match(state, /v_deletion_journal_objects_32d < 4086/i);
  assert.match(state, /DELETION_JOURNAL_WINDOW_NEAR_LIMIT/i);
  assert.match(state, /admission_allowed/i);
  assert.match(state, /history_allowed/i);
  assert.match(state, /maintenance_read_only/i);

  const guard = functionBody('rv2_ops_enforce_resource_guard');
  assert.match(guard, /TENANT_ADMISSION/);
  assert.match(guard, /HISTORY_BACKFILL/);
  assert.match(guard, /MAINTENANCE_WRITE/);
  assert.match(guard, /resource guard unavailable/i);
  assert.match(guard, /new\.status in \('AUTH_ERROR', 'DISABLED', 'REVOKED'\)/i);
  assert.match(guard, /new\.result_status = 'DISABLED'/i);
  assert.match(guard, /new\.status = 'REVOKED'/i);
  assert.match(guard, /coalesce\(auth\.role\(\), ''\) = 'service_role'/i);
  assert.match(guard, /old\.status = 'ACTIVE'[\s\S]*new\.status = 'DELETED'/i);
  assert.match(guard, /new\.membership_version = old\.membership_version \+ 1/i);
  assert.match(guard, /to_jsonb\(new\) - array\[[\s\S]*'status'[\s\S]*'membership_version'[\s\S]*'updated_at'[\s\S]*to_jsonb\(old\)/i);
  assert.match(guard, /current_setting\([\s\S]*review_workbench\.rv2_journal_delete_intent/iu);
  assert.match(guard, /private\.rv2_restore_v2_deletion_intents/iu);
  assert.match(guard, /intent\.operation = 'DELETE_ACCOUNT'/iu);
  assert.match(guard, /intent\.state = 'JOURNALED'/iu);

  assert.match(sql, /before insert on public\.rv2_tenants/i);
  assert.match(sql, /before insert on public\.rv2_memberships/i);
  assert.match(sql, /before update on public\.rv2_memberships/i);
  assert.match(sql, /before insert on private\.rv2_archive_jobs/i);
  assert.match(sql, /before insert on private\.rv2_sync_jobs/i);
  assert.doesNotMatch(guard, /new\.queue_class = 'GITHUB_OIDC'/i);
  for (const table of [
    'rv2_connections',
    'rv2_source_events', 'rv2_generations', 'rv2_trade_identities',
    'rv2_trade_read_models', 'rv2_reviews', 'rv2_actions',
    'rv2_journal_entries', 'rv2_risk_rules', 'rv2_reports',
    'rv2_ledger_generations', 'rv2_reconciliation_generations',
  ]) {
    assert.match(sql, new RegExp(`before insert or update on public\\.${table}`, 'i'));
  }

  for (const table of [
    'rv2_credential_envelopes', 'rv2_sync_attempts', 'rv2_sync_partitions',
    'rv2_sync_coverage', 'rv2_source_event_conflicts',
    'rv2_ledger_shadow_submissions', 'rv2_post_commit_work', 'rv2_sync_gaps',
    'rv2_archives', 'rv2_egress_receipts', 'rv2_review_requests',
    'rv2_domain_mutation_requests', 'rv2_trade_projection_evidence',
  ]) {
    assert.match(sql, new RegExp(`before insert or update on private\\.${table}`, 'i'));
  }

  // Capacity pressure must never disable cleanup/deletion paths.
  assert.doesNotMatch(sql, /before\s+delete\s+on\s+(?:public|private)\.rv2_/i);
});

test('health response exposes only aggregate PII-free operational signals', () => {
  const health = functionBody('rv2_service_get_operational_health');
  assert.match(health, /perform private\.rv2_require_service_role\(\)/i);
  for (const signal of [
    'queueLagSeconds', 'expiredLeases', 'rateLimit429Last24h', 'ban418Last24h',
    'authFailures', 'openCoverageGaps', 'staleCoveragePartitions',
    'dbBytes', 'r2StandardBytes', 'backupObjectAgeSeconds',
    'smtpDeliveryFailures24h', 'actionsMinutesUsed',
  ]) {
    assert.match(health, new RegExp(`'${signal}'`, 'i'));
  }
  assert.doesNotMatch(health, /jsonb_(?:agg|build_object)\([^;]*(?:tenant_id|user_id|connection_id|email)/i);
  assert.match(health, /'format', 'rv-ops-health\/1'/i);
  assert.match(sql, /revoke execute on function public\.rv2_service_get_operational_health\(\)[\s\S]*?from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant execute on function public\.rv2_service_get_operational_health\(\)[\s\S]*?to service_role;/i);
});
