import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_CONTROL_PLANE_EVIDENCE_FORMAT = 'rv-production-control-plane-evidence/2';
export const PRODUCTION_CONTROL_PLANE_MAX_AGE_MS = 15 * 60 * 1000;
const CONTROL_CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

export const PRODUCTION_CONTROL_PLANE_READ_ONLY_QUERY = String.raw`select
  j.jobname as job_name,
  j.schedule,
  j.command,
  j.username,
  j.active,
  (
    select pg_catalog.pg_get_userbyid(p.proowner)
      from pg_catalog.pg_proc as p
      join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
     where n.nspname = 'private'
       and p.proname = 'rv_run_production_vault_maintenance'
       and pg_catalog.pg_get_function_identity_arguments(p.oid) = ''
  ) as wrapper_owner,
  (
    select r.status
      from cron.job_run_details as r
     where r.jobid = j.jobid
       and r.end_time is not null
     order by r.end_time desc, r.runid desc
     limit 1
  ) as latest_status,
  (
    select max(r.end_time)
      from cron.job_run_details as r
     where r.jobid = j.jobid
       and r.status = 'succeeded'
  ) as latest_success_at,
  (
    select max(r.end_time)
      from cron.job_run_details as r
     where r.jobid = j.jobid
       and r.status <> 'succeeded'
       and r.end_time is not null
  ) as latest_failure_at
from cron.job as j
order by j.jobname;`;

export const PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY = String.raw`with function_defs as materialized (
  select n.nspname, p.proname, pg_catalog.pg_get_userbyid(p.proowner) as owner,
         p.prosecdef, p.proconfig,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
         pg_catalog.pg_get_functiondef(p.oid) as definition
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
), vault_wrappers(proname) as (
  values ('rv_bootstrap_workspace'), ('rv_register_device'),
         ('rv_upload_vault_generation'), ('rv_list_workspaces'),
         ('rv_read_generation_object'), ('rv_read_active_generation'),
         ('rv_read_generation_history'), ('rv_service_read_publish_context'),
         ('rv_service_publish_vault_head')
), semaphore_wrappers(proname) as (
  values ('rv_bootstrap_workspace'), ('rv_register_device'),
         ('rv_upload_vault_generation'), ('rv_list_workspaces'),
         ('rv_read_generation_object'), ('rv_read_active_generation'),
         ('rv_read_generation_history'), ('rv_service_read_publish_context'),
         ('rv_service_publish_vault_head'), ('rv_begin_destructive_operation'),
         ('rv_service_execute_workspace_deletion'),
         ('rv_service_execute_business_deletion'),
         ('rv_mark_destructive_operation_deleting'),
         ('rv_mark_destructive_operation_completed'),
         ('rv_get_destructive_operation_status')
)
select
  (select count(*) from supabase_migrations.schema_migrations
    where name in (
      'production_vault', 'vault_objects_device_fkey_index',
      'free_plan_admission_controls', 'status_fairness_and_admission_truth',
      'close_status_lookup_admission_gap'
    )) as migration_count,
  (select pg_catalog.pg_get_userbyid(c.relowner)
     from pg_catalog.pg_class as c
     join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'rv_rate_limit_buckets') as limiter_table_owner,
  (select c.relrowsecurity and c.relforcerowsecurity
     from pg_catalog.pg_class as c
     join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'rv_rate_limit_buckets') as limiter_table_rls_forced,
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'private' and privilege_type = 'EXECUTE'
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as private_execute_grants,
  (select count(*) from information_schema.table_privileges
    where table_schema = 'private' and table_name = 'rv_rate_limit_buckets'
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as private_table_grants,
  (select count(*) from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in (
        'profiles', 'workspaces', 'devices', 'vault_objects',
        'vault_heads', 'vault_head_history', 'destructive_operation_requests'
      )
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as public_table_bypass_grants,
  (select count(*) from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in (
        'profiles', 'workspaces', 'devices', 'vault_objects',
        'vault_heads', 'vault_head_history', 'destructive_operation_requests'
      )
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as public_column_bypass_grants,
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'public' and privilege_type = 'EXECUTE'
      and routine_name in ('rv_list_workspaces', 'rv_read_generation_object', 'rv_read_active_generation', 'rv_read_generation_history')
      and grantee = 'authenticated') as authenticated_read_rpc_grants,
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'public' and privilege_type = 'EXECUTE'
      and routine_name in ('rv_list_workspaces', 'rv_read_generation_object', 'rv_read_active_generation', 'rv_read_generation_history')
      and grantee in ('PUBLIC', 'anon', 'service_role')) as read_rpc_bypass_grants,
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'public' and privilege_type = 'EXECUTE'
      and routine_name = 'rv_service_read_publish_context'
      and grantee = 'service_role') as service_context_rpc_grants,
  (select count(*) from information_schema.routine_privileges
    where routine_schema = 'public' and privilege_type = 'EXECUTE'
      and routine_name = 'rv_service_read_publish_context'
      and grantee in ('PUBLIC', 'anon', 'authenticated')) as service_context_bypass_grants,
  (select count(*) from function_defs
    where nspname = 'public' and definition like '%rv_consume_subject_session_limit(''vault''%') as vault_admission_wrapper_count,
  (select count(*) from function_defs
    where nspname = 'public' and definition like '%rv_consume_subject_session_limit(''destructive''%') as destructive_admission_wrapper_count,
  (select count(*) from function_defs
    where nspname = 'public' and definition like '%rv_acquire_user_database_slot()%') as semaphore_wrapper_count,
  (select count(*) = 9 and count(distinct f.proname) = 9
     from function_defs as f
     join vault_wrappers as required using (proname)
    where f.nspname = 'public'
      and f.definition like '%rv_consume_subject_session_limit(''vault''%') as vault_wrapper_set_match,
  (select count(*) = 15 and count(distinct f.proname) = 15
     from function_defs as f
     join semaphore_wrappers as required using (proname)
    where f.nspname = 'public'
      and f.definition like '%rv_acquire_user_database_slot()%') as semaphore_wrapper_set_match,
  (select count(*) = 15 and count(distinct f.proname) = 15
          and bool_and(f.owner = 'postgres' and f.prosecdef
            and coalesce(f.proconfig, array[]::text[]) @> array['search_path=pg_catalog'])
     from function_defs as f
     join semaphore_wrappers as required using (proname)
    where f.nspname = 'public') as function_security_contract_match,
  coalesce((select owner = 'postgres'
    and definition like '%v_capacity := 120%'
    and definition like '%v_capacity := 10%'
    and definition like '%v_capacity := 60%'
    and definition like '%for update%'
    and definition like '%available_tokens = v_available - 1%'
    and definition like '%errcode = ''P0004''%'
    from function_defs where nspname = 'private' and proname = 'rv_consume_rate_limit'), false) as token_bucket_contract_match,
  coalesce((select owner = 'postgres'
    and definition like '%for v_slot in 0..9 loop%'
    and definition like '%pg_try_advisory_xact_lock(187904819, v_slot)%'
    and definition like '%errcode = ''P0005''%'
    from function_defs where nspname = 'private' and proname = 'rv_acquire_user_database_slot'), false) as semaphore_contract_match,
  coalesce((select strpos(definition, 'perform private.rv_acquire_user_database_slot()') > 0
    and strpos(definition, 'select core.request_id')
      > strpos(definition, 'perform private.rv_acquire_user_database_slot()')
    and strpos(definition, '''deletion-status-capability''')
      > strpos(definition, 'select core.request_id')
    and strpos(definition, '''deletion-status-global-unknown''')
      > strpos(definition, 'select core.request_id')
    and definition like '%if v_known then%'
    and definition like '%else%'
    from function_defs where nspname = 'public'
      and proname = 'rv_get_destructive_operation_status'
      and identity_arguments = 'p_request_id uuid, p_capability_fingerprint text, p_subject_fingerprint text, p_scope_fingerprint text, p_operation text'), false) as status_fairness_contract_match;`;

export const EXPECTED_PRODUCTION_CRON_JOBS = Object.freeze([
  Object.freeze({
    jobName: 'rv-production-vault-maintenance',
    schedule: '*/5 * * * *',
    command: 'select private.rv_run_production_vault_maintenance();',
    maximumSuccessAgeMs: 10 * 60 * 1000,
  }),
  Object.freeze({
    jobName: 'rv-pg-cron-run-details-retention',
    schedule: '17 3 * * *',
    command: "delete from cron.job_run_details\n    where end_time < now() - interval '7 days';",
    maximumSuccessAgeMs: 36 * 60 * 60 * 1000,
  }),
]);

export class ProductionControlPlaneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionControlPlaneError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionControlPlaneError(code, message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RESPONSE_INVALID', `${label} must be an object`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail('RESPONSE_INVALID', `${label} has unknown or missing fields`);
  }
  return value;
}

function boundedString(value, label, { min = 1, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail('RESPONSE_INVALID', `${label} has an invalid type or length`);
  }
  return value;
}

function canonicalHttpsOrigin(value, label) {
  const text = boundedString(value, label, { max: 2048 });
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail('INVALID_INPUT', `${label} is not an HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin !== text.replace(/\/$/, '')
  ) fail('INVALID_INPUT', `${label} is not a canonical HTTPS origin`);
  return parsed.origin;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, '\n');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseTimestamp(value, label) {
  const text = boundedString(value, label, { max: 64 });
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) fail('RESPONSE_INVALID', `${label} is not a timestamp`);
  return Object.freeze({ milliseconds: parsed, canonical: new Date(parsed).toISOString() });
}

function validateCronRows(rows, referenceTime) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_PRODUCTION_CRON_JOBS.length) {
    fail('CRON_CONTRACT_MISMATCH', 'production cron must contain exactly two jobs');
  }
  const expectedKeys = [
    'active', 'command', 'job_name', 'latest_failure_at', 'latest_status',
    'latest_success_at', 'schedule', 'username', 'wrapper_owner',
  ];
  const byName = new Map();
  for (const candidate of rows) {
    const row = exactKeys(candidate, expectedKeys, 'cron row');
    const name = boundedString(row.job_name, 'cron job name', { max: 128 });
    if (byName.has(name)) fail('CRON_CONTRACT_MISMATCH', 'production cron has duplicate jobs');
    byName.set(name, row);
  }

  const jobs = [];
  for (const expected of EXPECTED_PRODUCTION_CRON_JOBS) {
    const row = byName.get(expected.jobName);
    if (!row) fail('CRON_CONTRACT_MISMATCH', 'a required production cron job is missing');
    if (
      row.active !== true
      || row.username !== 'postgres'
      || row.wrapper_owner !== 'postgres'
      || row.schedule !== expected.schedule
      || normalizeLineEndings(boundedString(row.command, 'cron command', { max: 4096 })).trim() !== expected.command
      || row.latest_status !== 'succeeded'
    ) fail('CRON_CONTRACT_MISMATCH', 'production cron definition or latest terminal status is unsafe');

    const success = parseTimestamp(row.latest_success_at, 'cron latest success');
    if (
      success.milliseconds > referenceTime + CONTROL_CLOCK_SKEW_MS
      || success.milliseconds < referenceTime - expected.maximumSuccessAgeMs
    ) fail('CRON_CONTRACT_MISMATCH', 'production cron latest success is stale or from the future');

    let failure = null;
    if (row.latest_failure_at !== null) {
      failure = parseTimestamp(row.latest_failure_at, 'cron latest failure');
      if (failure.milliseconds > success.milliseconds) {
        fail('CRON_CONTRACT_MISMATCH', 'a production cron failure is newer than its latest success');
      }
    }
    jobs.push(Object.freeze({
      jobName: expected.jobName,
      schedule: expected.schedule,
      command: expected.command,
      owner: 'postgres',
      active: true,
      latestStatus: 'succeeded',
      latestSuccessAt: success.canonical,
      latestFailureAt: failure?.canonical ?? null,
    }));
  }
  return Object.freeze({ wrapperOwner: 'postgres', jobs: Object.freeze(jobs) });
}

function validateTrafficControlRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail('TRAFFIC_CONTROL_MISMATCH', 'database traffic-control query must return exactly one row');
  }
  const row = exactKeys(rows[0], [
    'authenticated_read_rpc_grants', 'destructive_admission_wrapper_count',
    'function_security_contract_match', 'limiter_table_owner',
    'limiter_table_rls_forced', 'migration_count', 'private_execute_grants',
    'private_table_grants', 'public_column_bypass_grants',
    'public_table_bypass_grants',
    'read_rpc_bypass_grants', 'semaphore_contract_match',
    'semaphore_wrapper_count', 'semaphore_wrapper_set_match',
    'service_context_bypass_grants', 'service_context_rpc_grants',
    'status_fairness_contract_match', 'token_bucket_contract_match',
    'vault_admission_wrapper_count', 'vault_wrapper_set_match',
  ], 'database traffic-control row');
  if (
    Number(row.migration_count) !== 5
    || row.limiter_table_owner !== 'postgres'
    || row.limiter_table_rls_forced !== true
    || Number(row.private_execute_grants) !== 0
    || Number(row.private_table_grants) !== 0
    || Number(row.public_column_bypass_grants) !== 0
    || Number(row.public_table_bypass_grants) !== 0
    || Number(row.authenticated_read_rpc_grants) !== 4
    || Number(row.read_rpc_bypass_grants) !== 0
    || Number(row.service_context_rpc_grants) !== 1
    || Number(row.service_context_bypass_grants) !== 0
    || Number(row.vault_admission_wrapper_count) !== 9
    || Number(row.destructive_admission_wrapper_count) !== 1
    || Number(row.semaphore_wrapper_count) !== 15
    || row.vault_wrapper_set_match !== true
    || row.semaphore_wrapper_set_match !== true
    || row.function_security_contract_match !== true
    || row.token_bucket_contract_match !== true
    || row.semaphore_contract_match !== true
    || row.status_fairness_contract_match !== true
  ) fail('TRAFFIC_CONTROL_MISMATCH', 'database traffic-control deployment differs from the reviewed exact policy');
  return Object.freeze({
    enforcement: 'postgres-database-boundary',
    migrationCount: 5,
    limiterTableOwner: 'postgres',
    limiterTableRlsForced: true,
    privateExecuteDenied: true,
    privateTableAccessDenied: true,
    publicTableDmlAndSelectDenied: true,
    authenticatedReadRpcCount: 4,
    readRpcBypassDenied: true,
    servicePublishContextRpcCount: 1,
    servicePublishContextBypassDenied: true,
    vaultAdmissionWrapperCount: 9,
    destructiveAdmissionWrapperCount: 1,
    semaphoreWrapperCount: 15,
    exactWrapperSetsMatch: true,
    functionSecurityContractMatch: true,
    tokenBucketContractMatch: true,
    semaphoreContractMatch: true,
    statusFairnessContractMatch: true,
  });
}

function validateHostedAuth(raw, appOrigin, localTemplate) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 512) {
    fail('RESPONSE_INVALID', 'Auth config response is invalid');
  }
  const exact = (key, expected) => {
    if (raw[key] !== expected) fail('AUTH_CONTRACT_MISMATCH', `hosted Auth field ${key} does not match the release contract`);
  };
  const authString = (key, label, maximum) => {
    const value = raw[key];
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
      fail('AUTH_CONTRACT_MISMATCH', `${label} is not completely configured`);
    }
    return value;
  };
  exact('disable_signup', true);
  exact('external_anonymous_users_enabled', false);
  exact('external_email_enabled', true);
  exact('external_phone_enabled', false);
  exact('mailer_autoconfirm', false);
  exact('mailer_otp_exp', 600);
  exact('mailer_otp_length', 6);
  exact('mailer_secure_email_change_enabled', true);
  exact('refresh_token_rotation_enabled', true);
  exact('security_refresh_token_reuse_interval', 10);
  exact('hook_send_email_enabled', false);
  exact('site_url', appOrigin);

  const redirects = boundedString(raw.uri_allow_list, 'Auth redirect allow-list', { max: 4096 })
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (redirects.length !== 1 || redirects[0] !== appOrigin) {
    fail('AUTH_CONTRACT_MISMATCH', 'hosted Auth redirect allow-list is not bound to the exact application origin');
  }

  const hostedTemplate = normalizeLineEndings(authString(
    'mailer_templates_magic_link_content', 'hosted email OTP template', MAX_TEMPLATE_BYTES,
  ));
  if (hostedTemplate !== localTemplate) {
    fail('AUTH_CONTRACT_MISMATCH', 'hosted email OTP template differs from the reviewed local template');
  }

  const smtpHost = authString('smtp_host', 'custom SMTP host', 255);
  const smtpUser = authString('smtp_user', 'custom SMTP user', 1024);
  const smtpPass = authString('smtp_pass', 'custom SMTP password marker', 4096);
  const smtpAdmin = authString('smtp_admin_email', 'custom SMTP sender email', 320);
  const smtpSender = authString('smtp_sender_name', 'custom SMTP sender name', 255);
  const smtpPort = authString('smtp_port', 'custom SMTP port', 5);
  const parsedPort = Number(smtpPort);
  if (
    !/^[0-9]{1,5}$/.test(smtpPort)
    || !Number.isInteger(parsedPort)
    || parsedPort < 1
    || parsedPort > 65535
    || !smtpAdmin.includes('@')
    || /\s/.test(smtpHost)
    || smtpUser.trim() !== smtpUser
    || smtpPass.trim() !== smtpPass
    || smtpSender.trim() !== smtpSender
  ) fail('AUTH_CONTRACT_MISMATCH', 'custom SMTP is not completely configured');

  return Object.freeze({
    auth: Object.freeze({
      signupDisabled: true,
      anonymousSignInsDisabled: true,
      emailOtpEnabled: true,
      phoneSignInsDisabled: true,
      emailAutoconfirmDisabled: true,
      otpLength: 6,
      otpExpirySeconds: 600,
      secureEmailChangeEnabled: true,
      refreshTokenRotationEnabled: true,
      refreshTokenReuseIntervalSeconds: 10,
      siteUrlBound: true,
      redirectAllowListBound: true,
    }),
    magicLinkTemplate: Object.freeze({
      normalizedSha256: sha256Text(localTemplate),
      exactMatch: true,
    }),
    customSmtp: Object.freeze({ configured: true }),
    sendEmailHook: Object.freeze({ disabled: true }),
  });
}

async function readBoundedJson(response, { expectedStatus, maxResponseBytes, deadlineAt, controller }) {
  if (!response || typeof response.status !== 'number' || response.status !== expectedStatus) {
    fail('RESPONSE_STATUS', 'Supabase Management API returned an unexpected status');
  }
  if (response.redirected === true) fail('RESPONSE_STATUS', 'Supabase Management API redirected unexpectedly');
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail('RESPONSE_INVALID', 'Supabase Management API did not return JSON');
  }
  const contentLengthText = response.headers?.get?.('content-length');
  if (contentLengthText !== null && contentLengthText !== undefined) {
    if (!/^[0-9]+$/.test(contentLengthText)) fail('RESPONSE_INVALID', 'Management API content length is invalid');
    if (Number(contentLengthText) > maxResponseBytes) fail('RESPONSE_TOO_LARGE', 'Management API response is too large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    fail('RESPONSE_INVALID', 'Supabase Management API response body is missing');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await awaitBeforeDeadline(reader.read(), deadlineAt, controller);
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) fail('RESPONSE_TOO_LARGE', 'Management API response is too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ProductionControlPlaneError) throw error;
    fail('RESPONSE_INVALID', 'Supabase Management API response could not be decoded');
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('RESPONSE_INVALID', 'Supabase Management API response is not valid JSON');
  }
}

async function awaitBeforeDeadline(promise, deadlineAt, controller) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) fail('REQUEST_TIMEOUT', 'Supabase Management API request timed out');
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProductionControlPlaneError(
            'REQUEST_TIMEOUT',
            'Supabase Management API request timed out',
          ));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function managementRequest({
  fetchImpl,
  method,
  url,
  token,
  body,
  expectedStatus,
  timeoutMs,
  maxResponseBytes,
}) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let response;
  try {
    response = await awaitBeforeDeadline(fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    }), deadlineAt, controller);
  } catch {
    if (controller.signal.aborted) fail('REQUEST_TIMEOUT', 'Supabase Management API request timed out');
    fail('REQUEST_FAILED', 'Supabase Management API request failed');
  }
  return await readBoundedJson(response, {
    expectedStatus,
    maxResponseBytes,
    deadlineAt,
    controller,
  });
}

function localTemplateText(repositoryRoot, readTemplateBytes) {
  let bytes;
  try {
    bytes = readTemplateBytes(path.join(repositoryRoot, 'supabase', 'templates', 'magic-link.html'));
  } catch {
    fail('LOCAL_CONTRACT_UNAVAILABLE', 'reviewed local email template is unavailable');
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_TEMPLATE_BYTES) {
    fail('LOCAL_CONTRACT_UNAVAILABLE', 'reviewed local email template has an invalid size');
  }
  try {
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('LOCAL_CONTRACT_UNAVAILABLE', 'reviewed local email template is not UTF-8');
  }
}

export function canonicalProductionControlPlaneEvidence(value) {
  return JSON.stringify({
    format: value.format,
    projectRef: value.projectRef,
    appOrigin: value.appOrigin,
    collectedAt: value.collectedAt,
    auth: value.auth,
    magicLinkTemplate: value.magicLinkTemplate,
    customSmtp: value.customSmtp,
    sendEmailHook: value.sendEmailHook,
    trafficControl: value.trafficControl,
    cron: value.cron,
  });
}

function validateEvidenceObject(raw, { projectRef, appOrigin, now, maxAgeMs }) {
  const row = exactKeys(raw, [
    'appOrigin', 'auth', 'collectedAt', 'cron', 'customSmtp', 'format',
    'magicLinkTemplate', 'projectRef', 'sendEmailHook', 'trafficControl',
  ], 'control-plane evidence');
  if (
    row.format !== PRODUCTION_CONTROL_PLANE_EVIDENCE_FORMAT
    || row.projectRef !== projectRef
    || row.appOrigin !== appOrigin
  ) fail('EVIDENCE_INVALID', 'control-plane evidence binding is invalid');
  const collected = parseTimestamp(row.collectedAt, 'control-plane collection time');
  if (
    collected.milliseconds > now + CONTROL_CLOCK_SKEW_MS
    || collected.milliseconds < now - maxAgeMs
  ) fail('EVIDENCE_INVALID', 'control-plane evidence is stale or from the future');

  const auth = exactKeys(row.auth, [
    'anonymousSignInsDisabled', 'emailAutoconfirmDisabled', 'emailOtpEnabled',
    'otpExpirySeconds', 'otpLength', 'phoneSignInsDisabled', 'redirectAllowListBound',
    'refreshTokenReuseIntervalSeconds', 'refreshTokenRotationEnabled',
    'secureEmailChangeEnabled', 'signupDisabled', 'siteUrlBound',
  ], 'control-plane Auth evidence');
  if (
    auth.signupDisabled !== true
    || auth.anonymousSignInsDisabled !== true
    || auth.emailOtpEnabled !== true
    || auth.phoneSignInsDisabled !== true
    || auth.emailAutoconfirmDisabled !== true
    || auth.otpLength !== 6
    || auth.otpExpirySeconds !== 600
    || auth.secureEmailChangeEnabled !== true
    || auth.refreshTokenRotationEnabled !== true
    || auth.refreshTokenReuseIntervalSeconds !== 10
    || auth.siteUrlBound !== true
    || auth.redirectAllowListBound !== true
  ) fail('EVIDENCE_INVALID', 'control-plane Auth evidence is unsafe');

  const template = exactKeys(row.magicLinkTemplate, ['exactMatch', 'normalizedSha256'], 'template evidence');
  if (template.exactMatch !== true || !/^[0-9a-f]{64}$/.test(template.normalizedSha256)) {
    fail('EVIDENCE_INVALID', 'email template evidence is invalid');
  }
  const smtp = exactKeys(row.customSmtp, ['configured'], 'SMTP evidence');
  const hook = exactKeys(row.sendEmailHook, ['disabled'], 'send-email hook evidence');
  if (smtp.configured !== true || hook.disabled !== true) {
    fail('EVIDENCE_INVALID', 'SMTP or send-email hook evidence is unsafe');
  }

  const traffic = exactKeys(row.trafficControl, [
    'authenticatedReadRpcCount', 'destructiveAdmissionWrapperCount',
    'enforcement', 'exactWrapperSetsMatch', 'functionSecurityContractMatch',
    'limiterTableOwner', 'limiterTableRlsForced', 'migrationCount',
    'privateExecuteDenied', 'privateTableAccessDenied',
    'publicTableDmlAndSelectDenied', 'readRpcBypassDenied',
    'semaphoreContractMatch', 'semaphoreWrapperCount',
    'servicePublishContextBypassDenied', 'servicePublishContextRpcCount',
    'statusFairnessContractMatch', 'tokenBucketContractMatch',
    'vaultAdmissionWrapperCount',
  ], 'database traffic-control evidence');
  if (
    traffic.enforcement !== 'postgres-database-boundary'
    || traffic.migrationCount !== 5
    || traffic.limiterTableOwner !== 'postgres'
    || traffic.limiterTableRlsForced !== true
    || traffic.privateExecuteDenied !== true
    || traffic.privateTableAccessDenied !== true
    || traffic.publicTableDmlAndSelectDenied !== true
    || traffic.authenticatedReadRpcCount !== 4
    || traffic.readRpcBypassDenied !== true
    || traffic.servicePublishContextRpcCount !== 1
    || traffic.servicePublishContextBypassDenied !== true
    || traffic.vaultAdmissionWrapperCount !== 9
    || traffic.destructiveAdmissionWrapperCount !== 1
    || traffic.semaphoreWrapperCount !== 15
    || traffic.exactWrapperSetsMatch !== true
    || traffic.functionSecurityContractMatch !== true
    || traffic.tokenBucketContractMatch !== true
    || traffic.semaphoreContractMatch !== true
    || traffic.statusFairnessContractMatch !== true
  ) fail('EVIDENCE_INVALID', 'database traffic-control evidence is unsafe');

  const cron = exactKeys(row.cron, ['jobs', 'wrapperOwner'], 'cron evidence');
  if (cron.wrapperOwner !== 'postgres' || !Array.isArray(cron.jobs) || cron.jobs.length !== 2) {
    fail('EVIDENCE_INVALID', 'cron evidence is invalid');
  }
  const rawRows = cron.jobs.map((job) => {
    const item = exactKeys(job, [
      'active', 'command', 'jobName', 'latestFailureAt', 'latestStatus',
      'latestSuccessAt', 'owner', 'schedule',
    ], 'cron evidence job');
    return {
      job_name: item.jobName,
      schedule: item.schedule,
      command: item.command,
      username: item.owner,
      active: item.active,
      wrapper_owner: cron.wrapperOwner,
      latest_status: item.latestStatus,
      latest_success_at: item.latestSuccessAt,
      latest_failure_at: item.latestFailureAt,
    };
  });
  const normalizedCron = validateCronRows(rawRows, collected.milliseconds);
  return Object.freeze({
    format: PRODUCTION_CONTROL_PLANE_EVIDENCE_FORMAT,
    projectRef,
    appOrigin,
    collectedAt: collected.canonical,
    auth: Object.freeze({ ...auth }),
    magicLinkTemplate: Object.freeze({ ...template }),
    customSmtp: Object.freeze({ configured: true }),
    sendEmailHook: Object.freeze({ disabled: true }),
    trafficControl: Object.freeze({ ...traffic }),
    cron: normalizedCron,
  });
}

export function parseCanonicalProductionControlPlaneEvidence(
  encoded,
  expectedSha256,
  { projectRef, appOrigin, now = Date.now(), maxAgeMs = PRODUCTION_CONTROL_PLANE_MAX_AGE_MS },
) {
  if (!/^[A-Za-z0-9_-]{128,8192}$/.test(encoded) || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    fail('EVIDENCE_INVALID', 'control-plane evidence encoding is invalid');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'));
  } catch {
    fail('EVIDENCE_INVALID', 'control-plane evidence could not be decoded');
  }
  if (sha256Text(text) !== expectedSha256) fail('EVIDENCE_INVALID', 'control-plane evidence digest does not match');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('EVIDENCE_INVALID', 'control-plane evidence is not JSON');
  }
  const normalized = validateEvidenceObject(raw, { projectRef, appOrigin, now, maxAgeMs });
  if (canonicalProductionControlPlaneEvidence(normalized) !== text) {
    fail('EVIDENCE_INVALID', 'control-plane evidence is not canonical JSON');
  }
  return normalized;
}

export async function collectProductionControlPlaneEvidence({
  projectRef,
  appOrigin: rawAppOrigin,
  managementToken,
  repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  fetchImpl = globalThis.fetch,
  readTemplateBytes = (templatePath) => fs.readFileSync(templatePath),
  now = Date.now(),
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (!PROJECT_REF_PATTERN.test(projectRef ?? '')) fail('INVALID_INPUT', 'project ref is invalid');
  const appOrigin = canonicalHttpsOrigin(rawAppOrigin, 'application origin');
  if (
    typeof managementToken !== 'string'
    || managementToken.length < 20
    || managementToken.length > 4096
    || /\s/.test(managementToken)
  ) fail('INVALID_INPUT', 'fine-grained Management API token is invalid');
  if (typeof fetchImpl !== 'function') fail('INVALID_INPUT', 'fetch implementation is unavailable');
  if (!Number.isFinite(now)) fail('INVALID_INPUT', 'collection time is invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    fail('INVALID_INPUT', 'request timeout is invalid');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
    fail('INVALID_INPUT', 'response size limit is invalid');
  }

  const localTemplate = localTemplateText(repositoryRoot, readTemplateBytes);
  const base = `https://api.supabase.com/v1/projects/${projectRef}`;
  const authResponse = await managementRequest({
    fetchImpl,
    method: 'GET',
    url: `${base}/config/auth`,
    token: managementToken,
    expectedStatus: 200,
    timeoutMs,
    maxResponseBytes,
  });
  const cronResponse = await managementRequest({
    fetchImpl,
    method: 'POST',
    url: `${base}/database/query/read-only`,
    token: managementToken,
    body: { query: PRODUCTION_CONTROL_PLANE_READ_ONLY_QUERY },
    expectedStatus: 201,
    timeoutMs,
    maxResponseBytes,
  });
  const trafficControlResponse = await managementRequest({
    fetchImpl,
    method: 'POST',
    url: `${base}/database/query/read-only`,
    token: managementToken,
    body: { query: PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY },
    expectedStatus: 201,
    timeoutMs,
    maxResponseBytes,
  });

  const hosted = validateHostedAuth(authResponse, appOrigin, localTemplate);
  const evidence = Object.freeze({
    format: PRODUCTION_CONTROL_PLANE_EVIDENCE_FORMAT,
    projectRef,
    appOrigin,
    collectedAt: new Date(now).toISOString(),
    ...hosted,
    trafficControl: validateTrafficControlRows(trafficControlResponse),
    cron: validateCronRows(cronResponse, now),
  });
  return validateEvidenceObject(evidence, {
    projectRef,
    appOrigin,
    now,
    maxAgeMs: PRODUCTION_CONTROL_PLANE_MAX_AGE_MS,
  });
}

async function main() {
  try {
    const evidence = await collectProductionControlPlaneEvidence({
      projectRef: process.env.RV_PRODUCTION_VAULT_EXPECTED_PROJECT_REF,
      appOrigin: process.env.RV_PRODUCTION_VAULT_APP_ORIGIN,
      managementToken: process.env.RV_SUPABASE_MANAGEMENT_ACCESS_TOKEN,
    });
    process.stdout.write(`${canonicalProductionControlPlaneEvidence(evidence)}\n`);
  } catch (error) {
    const code = error instanceof ProductionControlPlaneError ? error.code : 'UNEXPECTED_FAILURE';
    process.stderr.write(`Production control-plane verification failed (${code}).\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
