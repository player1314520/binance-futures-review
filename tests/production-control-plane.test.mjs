import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  EXPECTED_PRODUCTION_CRON_JOBS,
  PRODUCTION_CONTROL_PLANE_READ_ONLY_QUERY,
  PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY,
  ProductionControlPlaneError,
  canonicalProductionControlPlaneEvidence,
  collectProductionControlPlaneEvidence,
  parseCanonicalProductionControlPlaneEvidence,
} from '../scripts/verify-production-control-plane.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const APP_ORIGIN = 'https://binance-futures-review-web.vercel.app';
const TOKEN = 'sbp_test_fine_grained_management_token_123456789';
const NOW = Date.parse('2026-08-29T10:00:00.000Z');
const TEMPLATE_LF = '<p>Code: {{ .Token }}</p>\n';

function authConfig(overrides = {}) {
  return {
    disable_signup: true,
    external_anonymous_users_enabled: false,
    external_email_enabled: true,
    external_phone_enabled: false,
    mailer_autoconfirm: false,
    mailer_otp_exp: 600,
    mailer_otp_length: 6,
    mailer_secure_email_change_enabled: true,
    refresh_token_rotation_enabled: true,
    security_refresh_token_reuse_interval: 10,
    hook_send_email_enabled: false,
    site_url: APP_ORIGIN,
    uri_allow_list: APP_ORIGIN,
    mailer_templates_magic_link_content: TEMPLATE_LF,
    smtp_host: 'smtp.example.invalid',
    smtp_user: 'smtp-user',
    smtp_pass: 'masked-secret-marker',
    smtp_admin_email: 'no-reply@example.invalid',
    smtp_sender_name: 'Review Workbench',
    smtp_port: '587',
    irrelevant_secret_field: 'must-never-be-copied',
    ...overrides,
  };
}

function cronRows(overrides = {}) {
  const byName = overrides.byName ?? {};
  return EXPECTED_PRODUCTION_CRON_JOBS.map((expected, index) => ({
    job_name: expected.jobName,
    schedule: expected.schedule,
    command: expected.command,
    username: 'postgres',
    active: true,
    wrapper_owner: 'postgres',
    latest_status: 'succeeded',
    latest_success_at: new Date(NOW - (index === 0 ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000)).toISOString(),
    latest_failure_at: new Date(NOW - (index === 0 ? 30 * 60 * 1000 : 30 * 60 * 60 * 1000)).toISOString(),
    ...(byName[expected.jobName] ?? {}),
  }));
}

function trafficControlRows(overrides = {}) {
  return [{
    migration_count: 5,
    limiter_table_owner: 'postgres',
    limiter_table_rls_forced: true,
    private_execute_grants: 0,
    private_table_grants: 0,
    public_column_bypass_grants: 0,
    public_table_bypass_grants: 0,
    authenticated_read_rpc_grants: 4,
    read_rpc_bypass_grants: 0,
    service_context_rpc_grants: 1,
    service_context_bypass_grants: 0,
    vault_admission_wrapper_count: 9,
    destructive_admission_wrapper_count: 1,
    semaphore_wrapper_count: 15,
    vault_wrapper_set_match: true,
    semaphore_wrapper_set_match: true,
    function_security_contract_match: true,
    token_bucket_contract_match: true,
    semaphore_contract_match: true,
    status_fairness_contract_match: true,
    ...overrides,
  }];
}

function jsonResponse(value, status) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
}

function collector(overrides = {}) {
  const calls = [];
  const auth = overrides.auth ?? authConfig();
  const cron = overrides.cron ?? cronRows();
  const trafficControl = overrides.trafficControl ?? trafficControlRows();
  const fetchImpl = overrides.fetchImpl ?? (async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return jsonResponse(auth, 200);
    return calls.length === 2 ? jsonResponse(cron, 201) : jsonResponse(trafficControl, 201);
  });
  return {
    calls,
    promise: collectProductionControlPlaneEvidence({
      projectRef: PROJECT_REF,
      appOrigin: APP_ORIGIN,
      managementToken: TOKEN,
      fetchImpl,
      readTemplateBytes: () => Buffer.from(overrides.localTemplate ?? TEMPLATE_LF.replace(/\n/g, '\r\n')),
      now: NOW,
      timeoutMs: overrides.timeoutMs ?? 1000,
      maxResponseBytes: overrides.maxResponseBytes ?? 32 * 1024,
    }),
  };
}

test('traffic-control SQL covers all seven public application tables at table and column ACL levels', () => {
  const tableAclQuery = PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY.match(
    /information_schema\.table_privileges[\s\S]*?as public_table_bypass_grants,/u,
  )?.[0];
  const columnAclQuery = PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY.match(
    /information_schema\.column_privileges[\s\S]*?as public_column_bypass_grants,/u,
  )?.[0];
  assert.ok(tableAclQuery);
  assert.ok(columnAclQuery);
  for (const tableName of [
    'profiles', 'workspaces', 'devices', 'vault_objects',
    'vault_heads', 'vault_head_history', 'destructive_operation_requests',
  ]) {
    assert.match(tableAclQuery, new RegExp(`'${tableName}'`));
    assert.match(columnAclQuery, new RegExp(`'${tableName}'`));
  }
});

test('collector calls only the three official Management API reads and emits allowlisted PII-free evidence', async () => {
  const { calls, promise } = collector();
  const evidence = await promise;
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query/read-only`);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    query: PRODUCTION_CONTROL_PLANE_READ_ONLY_QUERY,
  });
  assert.equal(calls[2].url, `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query/read-only`);
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    query: PRODUCTION_TRAFFIC_CONTROL_READ_ONLY_QUERY,
  });
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
  }
  assert.equal(evidence.projectRef, PROJECT_REF);
  assert.equal(evidence.magicLinkTemplate.exactMatch, true);
  assert.equal(
    evidence.magicLinkTemplate.normalizedSha256,
    crypto.createHash('sha256').update(TEMPLATE_LF).digest('hex'),
  );
  assert.equal(evidence.customSmtp.configured, true);
  assert.equal(evidence.sendEmailHook.disabled, true);
  assert.equal(evidence.trafficControl.publicTableDmlAndSelectDenied, true);
  assert.equal(evidence.trafficControl.statusFairnessContractMatch, true);
  assert.equal(evidence.trafficControl.semaphoreWrapperCount, 15);
  assert.equal(evidence.cron.jobs.length, 2);
  const serialized = canonicalProductionControlPlaneEvidence(evidence);
  for (const forbidden of [
    TOKEN, 'smtp.example.invalid', 'smtp-user', 'masked-secret-marker',
    'no-reply@example.invalid', 'must-never-be-copied',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const encoded = Buffer.from(serialized).toString('base64url');
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  assert.deepEqual(parseCanonicalProductionControlPlaneEvidence(encoded, digest, {
    projectRef: PROJECT_REF,
    appOrigin: APP_ORIGIN,
    now: NOW + 60_000,
  }), evidence);
});

test('collector rejects missing or weakened database traffic controls', async (context) => {
  const unsafe = [
    ['one migration missing', { migration_count: 4 }],
    ['wrong owner', { limiter_table_owner: 'service_role' }],
    ['RLS not forced', { limiter_table_rls_forced: false }],
    ['private execute bypass', { private_execute_grants: 1 }],
    ['private table bypass', { private_table_grants: 1 }],
    ['public table bypass', { public_table_bypass_grants: 1 }],
    ['public column bypass', { public_column_bypass_grants: 1 }],
    ['read RPC bypass', { read_rpc_bypass_grants: 1 }],
    ['service context bypass', { service_context_bypass_grants: 1 }],
    ['vault wrapper set drift', { vault_wrapper_set_match: false }],
    ['semaphore wrapper set drift', { semaphore_wrapper_set_match: false }],
    ['function security drift', { function_security_contract_match: false }],
    ['status lookup ordering drift', { status_fairness_contract_match: false }],
    ['read RPC missing', { authenticated_read_rpc_grants: 3 }],
    ['limiter body drift', { token_bucket_contract_match: false }],
    ['semaphore body drift', { semaphore_contract_match: false }],
    ['wrapper coverage drift', { semaphore_wrapper_count: 14 }],
  ];
  for (const [label, override] of unsafe) {
    await context.test(label, async () => {
      await assert.rejects(
        collector({ trafficControl: trafficControlRows(override) }).promise,
        (error) => error instanceof ProductionControlPlaneError && error.code === 'TRAFFIC_CONTROL_MISMATCH',
      );
    });
  }
});

test('collector rejects unsafe typed Auth, template, SMTP and send-email-hook state', async (context) => {
  const unsafe = [
    ['boolean coercion', { disable_signup: 'true' }],
    ['open signup', { disable_signup: false }],
    ['refresh rotation disabled', { refresh_token_rotation_enabled: false }],
    ['refresh reuse interval changed', { security_refresh_token_reuse_interval: 11 }],
    ['wrong origin', { site_url: 'https://wrong.example' }],
    ['extra redirect', { uri_allow_list: `${APP_ORIGIN},https://wrong.example` }],
    ['wrong template', { mailer_templates_magic_link_content: '<p>{{ .ConfirmationURL }}</p>' }],
    ['default SMTP shape', { smtp_pass: '' }],
    ['send email hook enabled', { hook_send_email_enabled: true }],
  ];
  for (const [label, override] of unsafe) {
    await context.test(label, async () => {
      await assert.rejects(
        collector({ auth: authConfig(override) }).promise,
        (error) => error instanceof ProductionControlPlaneError && error.code === 'AUTH_CONTRACT_MISMATCH',
      );
    });
  }
});

test('collector rejects missing, stale, modified or failed cron jobs', async (context) => {
  const maintenance = EXPECTED_PRODUCTION_CRON_JOBS[0].jobName;
  const retention = EXPECTED_PRODUCTION_CRON_JOBS[1].jobName;
  const unsafe = [
    ['only one job', cronRows().slice(0, 1)],
    ['extra job', [...cronRows(), { ...cronRows()[0], job_name: 'extra' }]],
    ['inactive', cronRows({ byName: { [maintenance]: { active: false } } })],
    ['wrong owner', cronRows({ byName: { [maintenance]: { wrapper_owner: 'service_role' } } })],
    ['changed command', cronRows({ byName: { [maintenance]: { command: 'select 1;' } } })],
    ['maintenance stale', cronRows({ byName: { [maintenance]: { latest_success_at: new Date(NOW - 11 * 60 * 1000).toISOString() } } })],
    ['daily stale', cronRows({ byName: { [retention]: { latest_success_at: new Date(NOW - 37 * 60 * 60 * 1000).toISOString() } } })],
    ['newer failure', cronRows({ byName: { [maintenance]: { latest_failure_at: new Date(NOW - 60_000).toISOString() } } })],
    ['latest failure status', cronRows({ byName: { [maintenance]: { latest_status: 'failed' } } })],
  ];
  for (const [label, cron] of unsafe) {
    await context.test(label, async () => {
      await assert.rejects(
        collector({ cron }).promise,
        (error) => error instanceof ProductionControlPlaneError && error.code === 'CRON_CONTRACT_MISMATCH',
      );
    });
  }
});

test('collector fails closed on status, content-type, size and JSON errors without echoing secrets', async (context) => {
  const cases = [
    ['wrong status', new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }), 'RESPONSE_STATUS'],
    ['wrong content type', new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }), 'RESPONSE_INVALID'],
    ['declared oversized', new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '999999' } }), 'RESPONSE_TOO_LARGE'],
    ['invalid JSON', new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 'RESPONSE_INVALID'],
  ];
  for (const [label, response, code] of cases) {
    await context.test(label, async () => {
      const fetchImpl = async () => response.clone();
      await assert.rejects(
        collector({ fetchImpl }).promise,
        (error) => {
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, new RegExp(TOKEN));
          return true;
        },
      );
    });
  }
});

test('canonical parser rejects stale, tampered and noncanonical evidence', async () => {
  const evidence = await collector().promise;
  const canonical = canonicalProductionControlPlaneEvidence(evidence);
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  const encoded = Buffer.from(canonical).toString('base64url');
  assert.throws(() => parseCanonicalProductionControlPlaneEvidence(encoded, digest, {
    projectRef: PROJECT_REF,
    appOrigin: APP_ORIGIN,
    now: NOW + 16 * 60 * 1000,
  }), /stale/);
  assert.throws(() => parseCanonicalProductionControlPlaneEvidence(encoded, '0'.repeat(64), {
    projectRef: PROJECT_REF,
    appOrigin: APP_ORIGIN,
    now: NOW,
  }), /digest/);
  const reordered = JSON.stringify({ projectRef: evidence.projectRef, ...evidence });
  assert.throws(() => parseCanonicalProductionControlPlaneEvidence(
    Buffer.from(reordered).toString('base64url'),
    crypto.createHash('sha256').update(reordered).digest('hex'),
    { projectRef: PROJECT_REF, appOrigin: APP_ORIGIN, now: NOW },
  ), /canonical/);
});

test('collector enforces its deadline even when an injected fetch ignores abort', async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(
    collector({ fetchImpl: never, timeoutMs: 100 }).promise,
    (error) => error instanceof ProductionControlPlaneError && error.code === 'REQUEST_TIMEOUT',
  );
});
