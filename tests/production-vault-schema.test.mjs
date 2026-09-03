import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sqlUrl = new URL('../supabase/production-vault/migrations/20260829000100_production_vault.sql', import.meta.url);
const deviceIndexSqlUrl = new URL(
  '../supabase/production-vault/migrations/20260830000100_vault_objects_device_fkey_index.sql',
  import.meta.url,
);
const admissionSqlUrl = new URL(
  '../supabase/production-vault/migrations/20260830000200_free_plan_admission_controls.sql',
  import.meta.url,
);
const statusFairnessSqlUrl = new URL(
  '../supabase/production-vault/migrations/20260830000300_status_fairness_and_admission_truth.sql',
  import.meta.url,
);
const statusAdmissionSqlUrl = new URL(
  '../supabase/production-vault/migrations/20260830000400_close_status_lookup_admission_gap.sql',
  import.meta.url,
);
const readmeUrl = new URL('../supabase/production-vault/README.md', import.meta.url);

const sql = await readFile(sqlUrl, 'utf8');
const deviceIndexSql = await readFile(deviceIndexSqlUrl, 'utf8');
const admissionSql = await readFile(admissionSqlUrl, 'utf8');
const statusFairnessSql = await readFile(statusFairnessSqlUrl, 'utf8');
const statusAdmissionSql = await readFile(statusAdmissionSqlUrl, 'utf8');
const readme = await readFile(readmeUrl, 'utf8');

const tables = [
  'profiles',
  'workspaces',
  'devices',
  'vault_objects',
  'vault_heads',
  'vault_head_history',
  'destructive_operation_requests',
];

function tableBody(name) {
  const match = sql.match(new RegExp(`create table public\\.${name} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(match, `missing table public.${name}`);
  return match[1];
}

test('forward migration covers the vault object device foreign key without redundant head indexes', () => {
  assert.match(
    deviceIndexSql,
    /create index vault_objects_device_fkey_idx\s+on public\.vault_objects\s*\(user_id, workspace_id, created_by_device_id\);/i,
  );
  assert.doesNotMatch(deviceIndexSql, /vault_heads|vault_head_history/i);
  assert.doesNotMatch(deviceIndexSql, /drop\s+(?:index|table)|alter\s+table[^;]*drop/i);
});

test('Free-plan admission state stores only bounded domain-separated fingerprints', () => {
  const table = admissionSql.match(
    /create table private\.rv_rate_limit_buckets \(([\s\S]*?)\n\);/i,
  )?.[1] ?? '';
  assert.match(table, /identity_fingerprint text not null/i);
  assert.match(table, /available_tokens numeric\(18, 6\) not null/i);
  assert.match(table, /expires_at timestamptz not null/i);
  assert.match(table, /identity_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.doesNotMatch(table, /\buser_id\b|session_id|email|jwt|recovery|workspace_id|ip_address|inet/i);
  assert.match(admissionSql, /extensions\.digest[\s\S]*review-workbench-admission-v1[\s\S]*'sha256'/i);
  assert.match(admissionSql, /alter table private\.rv_rate_limit_buckets enable row level security;/i);
  assert.match(admissionSql, /alter table private\.rv_rate_limit_buckets force row level security;/i);
  assert.match(admissionSql, /revoke all on table private\.rv_rate_limit_buckets[\s\S]*from public, anon, authenticated, service_role;/i);
  assert.doesNotMatch(admissionSql, /x-forwarded-for|x-real-ip|cf-connecting-ip|inet_client_addr|caller.?supplied.?ip/i);
});

test('known deletion recovery cannot be starved by the unknown-capability global bucket', () => {
  assert.match(statusFairnessSql, /select core\.request_id[\s\S]*from private\.rv_core_get_destructive_operation_status/i);
  assert.match(statusFairnessSql, /if v_known then[\s\S]*'deletion-status'[\s\S]*else[\s\S]*'deletion-status-global'/i);
  assert.match(statusFairnessSql, /deletion-status-global-unknown/i);
  assert.doesNotMatch(
    statusFairnessSql.match(/if v_known then([\s\S]*?)else/i)?.[1] ?? '',
    /deletion-status-global/i,
  );
  assert.match(statusFairnessSql, /grant execute on function public\.rv_get_destructive_operation_status[\s\S]*to service_role/i);
  assert.match(statusFairnessSql, /statement that raises later rolls its charge back/i);
});

test('status lookup acquires database capacity before reading operation state', () => {
  const slot = statusAdmissionSql.indexOf('perform private.rv_acquire_user_database_slot()');
  const lookup = statusAdmissionSql.indexOf('from private.rv_core_get_destructive_operation_status');
  const branch = statusAdmissionSql.indexOf('if v_known then');
  assert.ok(slot >= 0, 'status lookup is missing database admission');
  assert.ok(lookup > slot, 'status operation state is read before database admission');
  assert.ok(branch > lookup, 'known/unknown response buckets must follow the keyed lookup');
  assert.match(statusAdmissionSql, /security definer[\s\S]*set search_path = pg_catalog/i);
  assert.match(statusAdmissionSql, /committed-statement throughput, not Edge, IP, or all-attempt/i);
  assert.match(statusAdmissionSql, /grant execute on function public\.rv_get_destructive_operation_status[\s\S]*to service_role/i);
});

test('Free-plan token buckets and transaction semaphore are fixed server policies', () => {
  const consume = admissionSql.match(
    /create function private\.rv_consume_rate_limit\([\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(consume, /p_scope = 'vault'[\s\S]*v_capacity := 120[\s\S]*v_refill_per_second := 2/i);
  assert.match(consume, /p_scope = 'destructive'[\s\S]*v_capacity := 10[\s\S]*10::numeric \/ 60::numeric/i);
  assert.match(consume, /p_scope = 'deletion-status'[\s\S]*v_capacity := 10/i);
  assert.match(consume, /p_scope = 'deletion-status-global'[\s\S]*v_capacity := 60[\s\S]*v_refill_per_second := 1/i);
  assert.match(consume, /on conflict \(scope, identity_kind, identity_fingerprint\) do nothing/i);
  assert.match(consume, /from private\.rv_rate_limit_buckets[\s\S]*for update;/i);
  assert.match(consume, /available_tokens = v_available - 1/i);
  assert.match(consume, /rate limit exceeded[\s\S]*errcode = 'P0004'/i);

  const semaphore = admissionSql.match(
    /create function private\.rv_acquire_user_database_slot\(\)[\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(semaphore, /for v_slot in 0\.\.9 loop/i);
  assert.match(semaphore, /pg_try_advisory_xact_lock\(187904819, v_slot\)/i);
  assert.match(semaphore, /capacity temporarily unavailable[\s\S]*errcode = 'P0005'/i);
  assert.doesNotMatch(semaphore, /pg_try_advisory_lock\s*\(/i);
});

test('all browser vault reads and publish verification cross the admission boundary', () => {
  for (const name of [
    'rv_list_workspaces',
    'rv_read_generation_object',
    'rv_read_active_generation',
    'rv_read_generation_history',
  ]) {
    const fn = admissionSql.match(
      new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`, 'i'),
    )?.[0] ?? '';
    assert.match(fn, /security definer/i);
    assert.match(fn, /auth\.uid\(\)/i);
    assert.match(fn, /rv_require_live_auth_session/i);
    assert.match(fn, /rv_consume_subject_session_limit\('vault'/i);
    assert.match(fn, /rv_acquire_user_database_slot\(\)/i);
    assert.match(admissionSql, new RegExp(
      `grant execute on function public\\.${name}\\([^;]+\\) to authenticated;`,
      'i',
    ));
  }
  assert.match(admissionSql, /create function public\.rv_service_read_publish_context\([\s\S]*security definer/i);
  assert.match(admissionSql, /rv_service_read_publish_context[\s\S]*rv_consume_subject_session_limit\('vault'/i);
  assert.match(admissionSql, /grant execute on function public\.rv_service_read_publish_context\(uuid, uuid, uuid, uuid\) to service_role;/i);
  for (const table of ['workspaces', 'vault_objects', 'vault_heads', 'vault_head_history']) {
    assert.match(admissionSql, new RegExp(
      `revoke select on table public\\.${table} from authenticated, service_role;`,
      'i',
    ));
  }
});

test('destructive operations are subject/session limited and status is capability/global limited', () => {
  const begin = admissionSql.match(
    /create function public\.rv_begin_destructive_operation\([\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(begin, /rv_consume_subject_session_limit\('destructive', p_subject, p_session_id\)/i);
  assert.match(begin, /rv_acquire_user_database_slot\(\)/i);

  const status = admissionSql.match(
    /create function public\.rv_get_destructive_operation_status\([\s\S]*?\n\$function\$;/i,
  )?.[0] ?? '';
  assert.match(status, /'deletion-status-global'[\s\S]*'global'/i);
  assert.match(status, /'deletion-status'[\s\S]*'capability'/i);
  assert.match(status, /coalesce\(p_capability_fingerprint, ''\)/i);
  assert.match(status, /rv_acquire_user_database_slot\(\)/i);
  assert.match(admissionSql, /rv_prune_rate_limit_buckets[\s\S]*limit 500[\s\S]*for update skip locked/i);
  assert.match(admissionSql, /rv_run_production_vault_maintenance[\s\S]*rv_prune_rate_limit_buckets/i);
});

test('is an isolated clean-project baseline with no legacy owner identity', () => {
  assert.match(sql, /requires a new dedicated project/i);
  assert.match(readme, /never apply it to an existing shared\/legacy project/i);
  assert.doesNotMatch(sql, /OWNER_UID|OWNER_UUID|owner\s*=\s*['"][0-9a-f-]{36}/i);
  assert.doesNotMatch(sql, /168609221|player1314520|@users\.noreply\.github\.com/i);
  assert.match(sql, /v_user_id uuid := auth\.uid\(\)/g);
  assert.match(sql, /user_id uuid not null default auth\.uid\(\)/g);
  assert.match(sql, /'trades', 'journal_entries', 'guards', 'annotations'/);
});

test('fails deliberately if the upstream Auth session contract drifts', () => {
  assert.match(sql, /to_regclass\('auth\.sessions'\)/i);
  assert.match(sql, /pg_catalog\.pg_attribute/i);
  assert.match(sql, /array\['id',\s*'user_id',\s*'not_after'\]/i);
  assert.match(sql, /requires auth\.sessions id, user_id, and not_after columns/i);
});

test('uses tenant-scoped composite identity and foreign keys', () => {
  const workspace = tableBody('workspaces');
  assert.match(workspace, /primary key \(user_id, workspace_id\)/i);
  assert.match(workspace, /signing_algorithm text not null/i);
  assert.match(workspace, /signing_public_key text not null/i);
  assert.match(workspace, /write_capability_hash text not null/i);
  assert.match(workspace, /signing_algorithm = 'ed25519-v1'/i);
  assert.match(workspace, /signing_public_key ~ '\^\[A-Za-z0-9_-\]\{59\}\$'/i);
  assert.match(workspace, /write_capability_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(tableBody('devices'), /primary key \(user_id, workspace_id, device_id\)/i);
  assert.match(tableBody('devices'), /foreign key \(user_id, workspace_id\)[\s\S]*references public\.workspaces \(user_id, workspace_id\)/i);
  assert.match(tableBody('vault_objects'), /primary key \(user_id, workspace_id, object_id\)/i);
  assert.match(tableBody('vault_objects'), /unique \(user_id, workspace_id, object_id, generation\)/i);
  assert.match(tableBody('vault_objects'), /foreign key \(user_id, workspace_id, created_by_device_id\)[\s\S]*references public\.devices \(user_id, workspace_id, device_id\)/i);
  assert.match(tableBody('vault_objects'), /ciphertext_sha256 text not null/i);
  assert.match(tableBody('vault_objects'), /signature text not null/i);
  assert.match(tableBody('vault_objects'), /parent_object_id uuid/i);
  assert.match(tableBody('vault_objects'), /parent_ciphertext_sha256 text/i);
  assert.match(tableBody('vault_heads'), /primary key \(user_id, workspace_id\)/i);
  assert.match(tableBody('vault_heads'), /foreign key \(user_id, workspace_id, object_id, generation\)/i);
  assert.match(tableBody('vault_head_history'), /primary key \(user_id, workspace_id, generation\)/i);
  assert.match(tableBody('vault_head_history'), /foreign key \(user_id, workspace_id, object_id, generation\)[\s\S]*references public\.vault_objects/i);
  assert.match(tableBody('destructive_operation_requests'), /primary key \(request_id\)/i);
  assert.match(tableBody('destructive_operation_requests'), /capability_fingerprint text not null/i);
  assert.match(tableBody('destructive_operation_requests'), /subject_fingerprint text not null/i);
  assert.match(tableBody('destructive_operation_requests'), /scope_fingerprint text not null/i);
  assert.match(tableBody('destructive_operation_requests'), /operation text not null/i);
  assert.match(tableBody('destructive_operation_requests'), /status text not null/i);
  assert.match(tableBody('destructive_operation_requests'), /expires_at timestamptz not null/i);
  assert.doesNotMatch(tableBody('destructive_operation_requests'), /\buser_id\b|workspace_id|session_id|email|jwt|recovery_secret|access_token/i);
  assert.doesNotMatch(tableBody('vault_objects'), /unique \(user_id, workspace_id, generation\)/i);
});

test('enables and forces RLS on every table and grants anonymous users nothing', () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security;`, 'i'));
  }

  assert.doesNotMatch(sql, /create policy[\s\S]{0,200}\bto\s+anon\b/i);
  assert.match(sql, /revoke all privileges on table[\s\S]*from public, anon, authenticated, service_role;/i);
  assert.match(sql, /create policy vault_head_history_owner_select[\s\S]*on public\.vault_head_history for select to authenticated[\s\S]*auth\.uid\(\)/i);
  assert.match(sql, /grant select\s*\([\s\S]*?workspace_id[\s\S]*?object_id[\s\S]*?generation[\s\S]*?committed_at[\s\S]*?\)\s*on table public\.vault_head_history\s*to authenticated;/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*vault_head_history[^;]*to authenticated/i);
  assert.doesNotMatch(sql, /create function public\.rv_publish_vault_head\(/i);
  assert.match(sql, /revoke all on function public\.rv_service_publish_vault_head\(uuid, uuid, uuid, bigint, uuid\) from public, anon, authenticated;/i);

  const policies = [...sql.matchAll(/create policy[\s\S]*?;/gi)].map((match) => match[0]);
  assert.ok(policies.length >= 6, 'expected explicit owner-only select policies');
  for (const policy of policies) {
    assert.match(policy, /to authenticated/i);
    assert.match(policy, /auth\.uid\(\)/i);
    assert.match(policy, /rv_current_session_is_live\(\)/i);
  }
});

test('all RLS reads fail closed when the bearer JWT session is revoked or missing', () => {
  const helper = sql.match(/create function public\.rv_current_session_is_live\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(helper, /security definer/i);
  assert.match(helper, /set search_path = pg_catalog/i);
  assert.match(helper, /auth\.jwt\(\)\s*->>\s*'session_id'/i);
  assert.match(helper, /from auth\.sessions as s/i);
  assert.match(helper, /s\.user_id = auth\.uid\(\)/i);
  assert.match(helper, /s\.id = v_session_id::uuid/i);
  assert.doesNotMatch(helper, /for (?:key )?(?:update|share)/i);
  assert.match(helper, /live auth session required[\s\S]*errcode = 'P0003'/i);
  assert.match(sql, /revoke all on function public\.rv_current_session_is_live\(\) from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant execute on function public\.rv_current_session_is_live\(\) to authenticated;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.rv_current_session_is_live\(\) to (?:anon|service_role|public)/i);
});

test('explicit Data API grants stay read-only and fail closed for future objects', () => {
  assert.match(sql, /revoke all on schema public from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant usage on schema public to authenticated, service_role;/i);
  assert.match(sql, /alter default privileges in schema public\s+revoke all on tables from public, anon, authenticated, service_role;/i);
  assert.match(sql, /alter default privileges in schema public\s+revoke all on sequences from public, anon, authenticated, service_role;/i);
  assert.match(sql, /alter default privileges in schema public\s+revoke execute on functions from public, anon, authenticated, service_role;/i);

  for (const table of ['workspaces', 'vault_objects', 'vault_heads', 'vault_head_history']) {
    assert.match(sql, new RegExp(`grant select\\s*\\([^;]+\\)\\s*on table public\\.${table}\\s*to authenticated;`, 'i'));
  }
  assert.doesNotMatch(sql, /grant select(?:\s+on table|\s*\([^;]+\)\s*on table)\s+public\.(?:profiles|devices|destructive_operation_requests)\s+to authenticated/i);
  assert.doesNotMatch(sql, /grant select\s+on table[^;]+to authenticated;/i);
  assert.doesNotMatch(sql, /grant select\s*\([^;]*write_capability_hash[^;]*\)\s*on table public\.workspaces\s*to authenticated;/i);

  for (const table of ['workspaces', 'vault_objects', 'vault_heads']) {
    assert.match(sql, new RegExp(`grant select\\s*\\([^;]+\\)\\s*on table public\\.${table}\\s*to service_role;`, 'i'));
  }
  assert.doesNotMatch(sql, /grant select(?:\s+on table|\s*\([^;]+\)\s*on table)\s+public\.(?:profiles|devices|vault_head_history|destructive_operation_requests)\s+to service_role/i);
  assert.doesNotMatch(sql, /grant select\s+on table[^;]+to service_role;/i);

  assert.doesNotMatch(sql, /grant (?:insert|update|delete|truncate|references|trigger)[^;]*to authenticated/i);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete|truncate|references|trigger)[^;]*to anon/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|truncate|references|trigger)[^;]*to service_role/i);
});

test('keeps private workspace content inside immutable ciphertext only', () => {
  const minimalBodies = [
    tableBody('profiles'),
    tableBody('workspaces'),
    tableBody('devices'),
    tableBody('vault_objects'),
    tableBody('vault_heads'),
    tableBody('vault_head_history'),
    tableBody('destructive_operation_requests'),
  ].join('\n');

  assert.match(tableBody('vault_objects'), /ciphertext text not null/i);
  assert.match(tableBody('vault_objects'), /envelope_version smallint not null default 1/i);
  assert.match(tableBody('vault_objects'), /created_by_device_id uuid not null/i);
  assert.match(tableBody('vault_objects'), /ciphertext_sha256_check[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(tableBody('vault_objects'), /signature_check[\s\S]*\^\[A-Za-z0-9_-\]\{86\}\$/i);
  assert.match(tableBody('vault_objects'), /generation = 1[\s\S]*parent_object_id is null[\s\S]*parent_ciphertext_sha256 is null/i);
  assert.doesNotMatch(sql, /grant insert[^;]*on public\.(?:devices|vault_objects) to authenticated/i);
  assert.doesNotMatch(sql, /grant update[^;]*on public\.(?:workspaces|devices|vault_objects) to authenticated/i);
  assert.doesNotMatch(sql, /grant update\s*\([^;]*\)\s*on public\.vault_objects/i);
  assert.match(sql, /create trigger rv_workspaces_root_immutable[\s\S]*before update on public\.workspaces/i);
  assert.match(sql, /create trigger rv_vault_objects_immutable[\s\S]*before update on public\.vault_objects/i);
  assert.doesNotMatch(minimalBodies, /\b(email|display_name|workspace_name|file_name|raw_csv|symbol|side|price|quantity|leverage|pnl|profit|journal|review_text|api_key|api_secret)\b/i);
  assert.doesNotMatch(minimalBodies, /\bjsonb?\b/i);
  assert.doesNotMatch(minimalBodies, /wrapped_workspace_key|device_public_key|recovery_secret/i);
});

test('enforces concurrent tenant quotas at a security-definer trigger boundary', () => {
  const vaultBody = tableBody('vault_objects');
  assert.match(vaultBody, /ciphertext_bytes integer generated always as[\s\S]*octet_length\(decode\(ciphertext, 'base64'\)\)[\s\S]*stored/i);
  assert.match(vaultBody, /between 17 and 25165824/i);

  const match = sql.match(/create function public\.rv_enforce_tenant_quota\(\)[\s\S]*?\n\$function\$;/i);
  assert.ok(match, 'missing rv_enforce_tenant_quota');
  const fn = match[0];
  assert.match(fn, /security definer/i);
  assert.match(fn, /pg_advisory_xact_lock\s*\(\s*hashtextextended/i);
  assert.match(fn, /v_workspace_limit constant integer := 16/i);
  assert.match(fn, /v_device_limit constant integer := 16/i);
  assert.match(fn, /v_object_limit constant integer := 2048/i);
  assert.match(fn, /v_total_bytes_limit constant bigint := 536870912/i);
  assert.match(fn, /count\(\*\)[\s\S]*public\.workspaces/i);
  assert.match(fn, /count\(\*\)[\s\S]*public\.devices/i);
  assert.match(fn, /count\(\*\)[\s\S]*sum\(o\.ciphertext_bytes\)[\s\S]*public\.vault_objects/i);
  assert.match(fn, /raise exception 'tenant quota exceeded' using errcode = '54000'/i);
  assert.doesNotMatch(fn, /raise exception[^;]*(new\.|user_id|workspace_id|device_id)/i);

  for (const table of ['workspaces', 'devices', 'vault_objects']) {
    assert.match(sql, new RegExp(
      `create trigger rv_quota_${table}_before_insert[\\s\\S]*before insert on public\\.${table}[\\s\\S]*rv_enforce_tenant_quota\\(\\)`,
      'i',
    ));
  }
  assert.match(sql, /revoke all on function public\.rv_enforce_tenant_quota\(\) from public, anon, authenticated;/i);
});

test('authenticated write RPCs require the hashed capability and enforce signed immutable metadata', () => {
  const bootstrap = sql.match(/create function public\.rv_bootstrap_workspace\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(bootstrap, /p_signing_algorithm text/i);
  assert.match(bootstrap, /p_signing_public_key text/i);
  assert.match(bootstrap, /p_write_capability text/i);
  assert.match(bootstrap, /p_session_id uuid/i);
  assert.match(bootstrap, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(bootstrap, /perform public\.rv_require_live_auth_session\(v_user_id, p_session_id\);/i);
  assert.ok(bootstrap.indexOf('rv_require_live_auth_session') < bootstrap.indexOf('insert into public.profiles'));
  assert.match(bootstrap, /extensions\.digest\([\s\S]*'sha256'/i);
  assert.match(bootstrap, /signing_algorithm is distinct from p_signing_algorithm/i);
  assert.match(bootstrap, /signing_public_key is distinct from p_signing_public_key/i);
  assert.match(bootstrap, /write_capability_hash is distinct from v_capability_hash/i);

  const register = sql.match(/create function public\.rv_register_device\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(register, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(register, /p_write_capability text/i);
  assert.match(register, /p_session_id uuid/i);
  assert.match(register, /perform public\.rv_require_live_auth_session\(v_user_id, p_session_id\);/i);
  assert.ok(register.indexOf('rv_require_live_auth_session') < register.indexOf('insert into public.devices'));
  assert.match(register, /w\.write_capability_hash = v_capability_hash/i);
  assert.match(register, /insert into public\.devices/i);

  const upload = sql.match(/create function public\.rv_upload_vault_generation\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(upload, /v_user_id uuid := auth\.uid\(\)/i);
  assert.match(upload, /p_session_id uuid/i);
  assert.match(upload, /perform public\.rv_require_live_auth_session\(v_user_id, p_session_id\);/i);
  assert.ok(upload.indexOf('rv_require_live_auth_session') < upload.indexOf('insert into public.vault_objects'));
  assert.match(upload, /w\.write_capability_hash = v_capability_hash/i);
  assert.match(upload, /extensions\.digest\(decode\(p_ciphertext, 'base64'\), 'sha256'\)/i);
  assert.match(upload, /v_ciphertext_sha256 is distinct from p_ciphertext_sha256/i);
  assert.match(upload, /p_generation - 1/i);
  assert.match(upload, /parent\.ciphertext_sha256 = p_parent_ciphertext_sha256/i);
  assert.match(upload, /insert into public\.vault_objects/i);

  for (const signature of [
    'public.rv_bootstrap_workspace(uuid, text, text, text, uuid)',
    'public.rv_register_device(uuid, uuid, text, uuid)',
    'public.rv_upload_vault_generation(uuid, uuid, uuid, bigint, smallint, text, text, text, uuid, text, text, uuid)',
  ]) {
    const escaped = signature.replace(/[().]/g, '\\$&').replace(/, /g, ',\\s*');
    assert.match(sql, new RegExp(`grant execute on function ${escaped} to authenticated;`, 'i'));
  }
});

test('only the service Edge RPC can CAS a signed successor head', () => {
  const fn = sql.match(/create function public\.rv_service_publish_vault_head\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(fn, /security definer/i);
  assert.match(fn, /p_subject uuid[\s\S]*p_session_id uuid/i);
  assert.match(fn, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(fn, /perform public\.rv_require_live_auth_session\(p_subject, p_session_id\);/i);
  assert.ok(
    fn.indexOf('rv_require_live_auth_session') < fn.indexOf('from public.workspaces'),
    'live session must be checked before the workspace lock and CAS mutation',
  );
  assert.match(fn, /from public\.workspaces[\s\S]*for update/i);
  assert.match(fn, /v_object\.generation <> p_expected_generation \+ 1/i);
  assert.match(fn, /v_object\.parent_object_id is distinct from v_head_object_id/i);
  assert.match(fn, /v_object\.parent_ciphertext_sha256 is distinct from v_head_ciphertext_sha256/i);
  assert.match(fn, /errcode = '40001'/i);
  assert.match(fn, /insert into public\.vault_head_history\s*\([\s\S]*user_id, workspace_id, generation, object_id, committed_at/i);
  const historyInsert = fn.indexOf('insert into public.vault_head_history');
  const finalCasMutation = Math.max(
    fn.lastIndexOf('insert into public.vault_heads'),
    fn.lastIndexOf('update public.vault_heads'),
  );
  assert.ok(historyInsert > finalCasMutation, 'only the candidate that already won head CAS may enter history');
  assert.match(sql, /grant execute on function public\.rv_service_publish_vault_head\(uuid, uuid, uuid, bigint, uuid\) to service_role;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.rv_service_publish_vault_head[^;]*to authenticated/i);
});

test('destructive mutations require the same live auth session inside each SQL transaction', () => {
  const helper = sql.match(/create function public\.rv_require_live_auth_session\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(helper, /p_subject uuid[\s\S]*p_session_id uuid/i);
  assert.match(helper, /security definer/i);
  assert.match(helper, /set search_path = pg_catalog/i);
  assert.match(helper, /from auth\.sessions as s/i);
  assert.match(helper, /s\.user_id = p_subject/i);
  assert.match(helper, /s\.id = p_session_id/i);
  assert.match(helper, /auth\.jwt\(\)\s*->>\s*'session_id'[\s\S]*p_session_id::text/i);
  assert.match(helper, /s\.not_after is null[\s\S]*s\.not_after > statement_timestamp\(\)/i);
  assert.match(helper, /from auth\.sessions as s[\s\S]*for key share;/i);
  assert.match(helper, /live auth session required[\s\S]*errcode = 'P0003'/i);
  assert.doesNotMatch(helper, /insert|update|delete/i);

  const begin = sql.match(/create function public\.rv_begin_destructive_operation\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  const workspace = sql.match(/create function public\.rv_service_execute_workspace_deletion\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  const business = sql.match(/create function public\.rv_service_execute_business_deletion\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  const deleting = sql.match(/create function public\.rv_mark_destructive_operation_deleting\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  for (const fn of [begin, workspace, business, deleting]) {
    assert.match(fn, /p_subject uuid[\s\S]*p_session_id uuid/i);
    assert.match(fn, /perform public\.rv_require_live_auth_session\(p_subject, p_session_id\);/i);
  }
  assert.ok(begin.indexOf('rv_require_live_auth_session') < begin.indexOf('insert into public.destructive_operation_requests'));
  assert.ok(workspace.indexOf('rv_require_live_auth_session') < workspace.indexOf('delete from public.workspaces'));
  assert.ok(business.indexOf('rv_require_live_auth_session') < business.indexOf('delete from public.profiles'));
  assert.ok(deleting.indexOf('rv_require_live_auth_session') < deleting.indexOf('update public.destructive_operation_requests'));

  assert.match(sql, /revoke all on function public\.rv_require_live_auth_session\(uuid, uuid\) from public, anon, authenticated, service_role;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.rv_require_live_auth_session/i);
  assert.match(sql, /revoke all on function public\.rv_begin_destructive_operation\(uuid, uuid, uuid, text, text, text, text, uuid, timestamptz\) from public, anon, authenticated;/i);
  assert.match(sql, /revoke all on function public\.rv_mark_destructive_operation_deleting\(uuid, uuid, uuid, text, text, text, text\) from public, anon, authenticated;/i);
});

test('destructive data RPCs atomically delete and complete only the capability-bound operation', () => {
  const match = sql.match(/create function public\.rv_service_execute_business_deletion\([\s\S]*?\n\$function\$;/i);
  assert.ok(match, 'missing rv_service_execute_business_deletion');
  const fn = match[0];

  assert.match(fn, /security definer/i);
  assert.match(fn, /p_subject uuid/i);
  assert.match(fn, /p_confirmation is distinct from 'DELETE_MY_REVIEW_DATA'/i);
  assert.match(fn, /r\.capability_fingerprint = p_capability_fingerprint/i);
  assert.match(fn, /r\.subject_fingerprint = p_subject_fingerprint/i);
  assert.match(fn, /r\.scope_fingerprint = p_scope_fingerprint/i);
  assert.match(fn, /r\.operation = 'clear_business_data'/i);
  assert.match(fn, /delete from public\.profiles as p[\s\S]*p\.user_id = p_subject/i);
  assert.match(fn, /status = 'completed'/i);
  assert.doesNotMatch(fn, /delete from auth\.users/i);
  assert.ok(
    fn.indexOf('delete from public.profiles') < fn.lastIndexOf("status = 'completed'"),
    'business deletion and its completion receipt must commit in one SQL transaction',
  );

  const workspace = sql.match(/create function public\.rv_service_execute_workspace_deletion\([\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(workspace, /p_subject uuid/i);
  assert.match(workspace, /p_confirmation is distinct from 'DELETE_THIS_WORKSPACE'/i);
  assert.match(workspace, /w\.user_id = p_subject/i);
  assert.match(workspace, /r\.operation = 'delete_workspace'/i);
  assert.match(workspace, /status = 'completed'/i);

  assert.match(sql, /revoke all on function public\.rv_service_execute_workspace_deletion\(uuid, uuid, uuid, text, uuid, text, text, text\) from public, anon, authenticated;/i);
  assert.match(sql, /revoke all on function public\.rv_service_execute_business_deletion\(uuid, uuid, text, uuid, text, text, text\) from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.rv_service_execute_workspace_deletion\(uuid, uuid, uuid, text, uuid, text, text, text\) to service_role;/i);
  assert.match(sql, /grant execute on function public\.rv_service_execute_business_deletion\(uuid, uuid, text, uuid, text, text, text\) to service_role;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.rv_(?:delete_workspace|clear_my_business_data)[^;]*to authenticated/i);
});

test('all destructive-operation receipts are PII-free, short-lived, and service-only', () => {
  const body = tableBody('destructive_operation_requests');
  assert.match(body, /status in \('pending', 'deleting', 'completed'\)/i);
  assert.match(body, /operation in \('delete_workspace', 'clear_business_data', 'delete_account'\)/i);
  assert.match(body, /expires_at <= created_at \+ interval '1 hour'/i);
  assert.match(body, /capability_fingerprint_check[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(body, /subject_fingerprint_check[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(body, /scope_fingerprint_check[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /alter table public\.destructive_operation_requests force row level security;/i);
  assert.match(sql, /create index destructive_operation_requests_expires_at_idx\s+on public\.destructive_operation_requests \(expires_at\);/i);
  assert.match(sql, /revoke all privileges on table[\s\S]*destructive_operation_requests[\s\S]*from public, anon, authenticated, service_role;/i);
  assert.doesNotMatch(sql, /grant (?:select|insert|update|delete)[^;]*destructive_operation_requests[^;]*to authenticated/i);

  for (const name of [
    'rv_begin_destructive_operation',
    'rv_mark_destructive_operation_deleting',
    'rv_mark_destructive_operation_completed',
    'rv_get_destructive_operation_status',
    'rv_prune_destructive_operation_requests',
  ]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(`, 'i'));
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated;`, 'i'));
  }

  const prune = sql.match(/create function public\.rv_prune_destructive_operation_requests\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(prune, /order by candidate\.expires_at, candidate\.request_id/i);
  assert.match(prune, /limit 500/i);
  assert.match(prune, /for update skip locked/i);
});

test('vault garbage collection retains recoverable history and bounds every batch', () => {
  const prune = sql.match(/create function public\.rv_prune_vault_objects\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(prune, /returns bigint/i);
  assert.match(prune, /security definer/i);
  assert.match(prune, /set search_path = pg_catalog/i);
  assert.match(prune, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(prune, /row_number\(\) over\s*\([\s\S]*partition by h\.user_id, h\.workspace_id[\s\S]*order by h\.generation desc/i);
  assert.match(prune, /committed_rank > 4/i);
  assert.match(prune, /history\.object_id is null[\s\S]*o\.created_at <= statement_timestamp\(\) - interval '24 hours'/i);
  assert.match(prune, /not exists\s*\([\s\S]*from public\.vault_heads as current_head[\s\S]*current_head\.object_id = o\.object_id[\s\S]*\)/i);
  assert.match(prune, /join public\.workspaces as locked_workspace[\s\S]*for update of locked_workspace, o skip locked/i);
  assert.match(prune, /limit 500[\s\S]*for update of locked_workspace, o skip locked/i);
  assert.match(prune, /delete from public\.vault_objects as doomed/i);
  assert.match(prune, /delete from public\.vault_objects as doomed[\s\S]*not exists\s*\([\s\S]*from public\.vault_heads as current_head_after_lock[\s\S]*current_head_after_lock\.object_id = doomed\.object_id/i);
  assert.match(prune, /get diagnostics v_deleted = row_count[\s\S]*v_changed := v_changed \+ v_deleted/i);
  assert.doesNotMatch(prune, /return query|returns table|returning[\s\S]*(?:user_id|workspace_id|object_id)/i);
  assert.match(tableBody('vault_head_history'), /references public\.vault_objects[\s\S]*on delete cascade/i);

  assert.match(sql, /revoke all on function public\.rv_prune_vault_objects\(\) from public, anon, authenticated;/i);
  assert.match(sql, /grant execute on function public\.rv_prune_vault_objects\(\) to service_role;/i);
  assert.doesNotMatch(sql, /grant execute on function public\.rv_prune_vault_objects\(\) to (?:anon|authenticated)/i);
});

test('Supabase Cron runs bounded maintenance without embedding credentials', () => {
  assert.match(sql, /create extension if not exists pg_cron;/i);
  assert.match(sql, /do \$cron_installer\$[\s\S]*current_user <> 'postgres'[\s\S]*errcode = '42501'[\s\S]*\$cron_installer\$;/i);
  assert.match(sql, /create schema if not exists private authorization postgres;/i);
  assert.match(sql, /revoke all on schema private from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant usage on schema private to postgres;/i);

  const wrapper = sql.match(/create function private\.rv_run_production_vault_maintenance\(\)[\s\S]*?\n\$function\$;/i)?.[0] ?? '';
  assert.match(wrapper, /returns void/i);
  assert.match(wrapper, /security definer/i);
  assert.match(wrapper, /set search_path = pg_catalog/i);
  assert.match(wrapper, /set_config\(\s*'request\.jwt\.claim\.role',\s*'service_role',\s*true\s*\)/i);
  assert.match(wrapper, /for v_destructive_batch in 1\.\.4 loop[\s\S]*public\.rv_prune_destructive_operation_requests\(\)[\s\S]*exit when v_changed < 500/i);
  assert.match(wrapper, /for v_vault_batch in 1\.\.4 loop[\s\S]*public\.rv_prune_vault_objects\(\)[\s\S]*exit when v_changed < 500/i);
  assert.ok(wrapper.indexOf('set_config') < wrapper.indexOf('rv_prune_destructive_operation_requests'));
  assert.ok(wrapper.indexOf('set_config') < wrapper.indexOf('rv_prune_vault_objects'));

  assert.match(sql, /alter function private\.rv_run_production_vault_maintenance\(\) owner to postgres;/i);
  assert.match(sql, /revoke all on function private\.rv_run_production_vault_maintenance\(\)\s+from public, anon, authenticated, service_role;/i);
  assert.match(sql, /grant execute on function private\.rv_run_production_vault_maintenance\(\) to postgres;/i);
  assert.doesNotMatch(sql, /grant execute on function private\.rv_run_production_vault_maintenance\(\) to (?:anon|authenticated|service_role)/i);

  assert.match(sql, /cron\.schedule\(\s*'rv-production-vault-maintenance',\s*'\*\/5 \* \* \* \*',\s*\$cron\$select private\.rv_run_production_vault_maintenance\(\);\$cron\$\s*\)/i);
  assert.match(sql, /cron\.schedule\(\s*'rv-pg-cron-run-details-retention',\s*'17 3 \* \* \*',\s*\$cron\$delete from cron\.job_run_details[\s\S]*end_time < now\(\) - interval '7 days';\$cron\$\s*\)/i);

  const scheduledCommands = [...sql.matchAll(/\$cron\$([\s\S]*?)\$cron\$/gi)]
    .map((match) => match[1])
    .join('\n');
  assert.doesNotMatch(scheduledCommands, /service[_-]?role[_-]?key|api[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|password|secret/i);
});

test('README documents deployment gates and at least three honest boundaries', () => {
  assert.match(readme, /two real\s+test users/i);
  assert.match(readme, /anonymous requests cannot read/i);
  assert.match(readme, /## Honest boundaries/i);
  const boundarySection = readme.split(/## Honest boundaries/i)[1] ?? '';
  const bullets = boundarySection.match(/^- /gm) ?? [];
  assert.ok(bullets.length >= 3, `expected at least 3 honest boundaries, got ${bullets.length}`);
});
