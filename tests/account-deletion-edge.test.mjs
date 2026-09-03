import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETION_EDGE_DEADLINE_MS,
  ACCOUNT_DELETION_TTL_SECONDS,
  CLEAR_BUSINESS_CONFIRMATION,
  DELETE_WORKSPACE_CONFIRMATION,
  DeletionProtocolError,
  authorizeAccountDeletion,
  parseDeletionRequest,
} from '../supabase/functions/delete-account/protocol.mjs';
import { createDeletionHandler } from '../supabase/functions/delete-account/handler.mjs';

const indexUrl = new URL('../supabase/functions/delete-account/index.ts', import.meta.url);
const handlerUrl = new URL('../supabase/functions/delete-account/handler.mjs', import.meta.url);
const readmeUrl = new URL('../supabase/functions/delete-account/README.md', import.meta.url);
const configUrl = new URL('../supabase/config.toml', import.meta.url);
const magicLinkTemplateUrl = new URL('../supabase/templates/magic-link.html', import.meta.url);
const accountClientUrl = new URL('../app/src/lib/account-deletion-client.ts', import.meta.url);
const index = await readFile(indexUrl, 'utf8');
const handlerSource = await readFile(handlerUrl, 'utf8');
const readme = await readFile(readmeUrl, 'utf8');
const config = await readFile(configUrl, 'utf8');
const magicLinkTemplate = await readFile(magicLinkTemplateUrl, 'utf8');
const accountClient = await readFile(accountClientUrl, 'utf8');

function exportedInteger(source, name) {
  const match = source.match(new RegExp(`export const ${name} = ([0-9_]+);`));
  assert.ok(match, `missing integer contract ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

function tomlSection(text, name) {
  const header = `[${name}]`;
  const start = text.indexOf(header);
  assert.notEqual(start, -1, `missing TOML section ${header}`);
  const bodyStart = start + header.length;
  const nextHeader = text.slice(bodyStart).search(/^\s*\[[^\]]+\]/m);
  return text.slice(bodyStart, nextHeader < 0 ? undefined : bodyStart + nextHeader);
}

const apiConfig = tomlSection(config, 'api');
const dbConfig = tomlSection(config, 'db');
const authConfig = tomlSection(config, 'auth');
const authEmailConfig = tomlSection(config, 'auth.email');
const authRateLimitConfig = tomlSection(config, 'auth.rate_limit');
const authMagicLinkConfig = tomlSection(config, 'auth.email.template.magic_link');

const ORIGIN = 'https://review.example.com';
const NOW = 1_787_875_200;
const USER_ID = '92bf60cf-6964-4dcc-b2f4-dd14b82b0741';
const SESSION_ID = 'f76636b8-49db-40df-b9f9-20f16202659a';
const WORKSPACE_ID = 'e8614b3f-0da6-4fe5-ae4d-96353ca09e8f';
const REQUEST_ID = 'a5810db0-9183-478d-a111-f989adbe62f5';
const BUSINESS_REQUEST_ID = 'b5810db0-9183-478d-a111-f989adbe62f5';
const ACCOUNT_REQUEST_ID = 'c5810db0-9183-478d-a111-f989adbe62f5';
const RECEIPT_ID = 'd5af4758-ae9a-4603-9624-59b982aa465b';
const RECOVERY_SECRET = `rvr1_${'A'.repeat(43)}`;

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function freshClaims(overrides = {}) {
  return {
    sub: USER_ID,
    role: 'authenticated',
    aud: 'authenticated',
    session_id: SESSION_ID,
    is_anonymous: false,
    iat: NOW - 15,
    exp: NOW + 3600,
    amr: [{ method: 'otp', timestamp: NOW - 20 }],
    ...overrides,
  };
}

function mutationBody(action, requestId = REQUEST_ID) {
  if (action === 'delete_workspace') return {
    protocolVersion: 3,
    action,
    confirmation: DELETE_WORKSPACE_CONFIRMATION,
    workspaceId: WORKSPACE_ID,
    requestId,
    recoverySecret: RECOVERY_SECRET,
  };
  if (action === 'clear_business_data') return {
    protocolVersion: 3,
    action,
    confirmation: CLEAR_BUSINESS_CONFIRMATION,
    requestId,
    recoverySecret: RECOVERY_SECRET,
  };
  return {
    protocolVersion: 3,
    action: 'delete_account',
    confirmation: ACCOUNT_DELETE_CONFIRMATION,
    requestId,
    recoverySecret: RECOVERY_SECRET,
  };
}

function statusBody(operation, requestId = REQUEST_ID, recoverySecret = RECOVERY_SECRET) {
  return {
    protocolVersion: 3,
    action: 'deletion_status',
    operation,
    requestId,
    recoverySecret,
    subjectHint: USER_ID,
    ...(operation === 'delete_workspace' ? { workspaceId: WORKSPACE_ID } : {}),
  };
}

function jsonRequest(body, { origin = ORIGIN, token = jwt(freshClaims()) } = {}) {
  const headers = { Origin: origin, 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://edge.example.com/delete-account', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function json(response) {
  return JSON.parse(await response.text());
}

function sameKey(row, key) {
  return row.capabilityFingerprint === key.capabilityFingerprint
    && row.subjectFingerprint === key.subjectFingerprint
    && row.scopeFingerprint === key.scopeFingerprint
    && row.operation === key.operation;
}

function memoryDependencies(overrides = {}) {
  const requests = new Map();
  let userExists = true;
  const calls = {
    verify: 0,
    begin: [],
    workspace: [],
    business: [],
    journal: [],
    deleteAuth: [],
    statusChecks: [],
    prune: 0,
  };
  function requiredRow(key) {
    const row = requests.get(key.requestId);
    if (!row || !sameKey(row, key)) {
      throw new DeletionProtocolError('DELETION_REQUEST_NOT_FOUND', 'missing operation');
    }
    return row;
  }
  function completed(key) {
    const row = requiredRow(key);
    row.status = 'completed';
    return { ...row };
  }
  const deps = {
    allowedOrigin: ORIGIN,
    totalDeadlineMs: 1_000,
    nowSeconds: () => NOW,
    randomUUID: () => RECEIPT_ID,
    verifyUser: async () => {
      calls.verify += 1;
      return {
        id: USER_ID,
        is_anonymous: false,
        last_sign_in_at: new Date((NOW - 10) * 1000).toISOString(),
      };
    },
    fingerprint: async (kind, value) => createHash('sha256').update(`${kind}\0${value}`).digest('hex'),
    beginDestructiveOperation: async (row) => {
      calls.begin.push({ subject: row.subject, sessionId: row.sessionId, operation: row.operation });
      const current = requests.get(row.requestId);
      if (current) {
        if (!sameKey(current, row)) {
          throw new DeletionProtocolError('IDEMPOTENCY_CONFLICT', 'idempotency conflict');
        }
        return { ...current };
      }
      const created = { ...row, status: 'pending', receiptId: RECEIPT_ID };
      requests.set(row.requestId, created);
      return { ...created };
    },
    executeWorkspaceDeletion: async (row) => {
      calls.workspace.push({
        subject: row.subject,
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        confirmation: row.confirmation,
      });
      return completed(row);
    },
    executeJournaledDeletion: async (row) => {
      calls.journal.push({ ...row });
      return {
        state: 'DELETED',
        receiptId: row.eventId,
        journalAppliedBeforeDeletion: true,
      };
    },
    executeBusinessDeletion: async (row) => {
      calls.business.push({
        subject: row.subject,
        sessionId: row.sessionId,
        confirmation: row.confirmation,
      });
      return completed(row);
    },
    markAccountDeleting: async (key) => {
      const row = requiredRow(key);
      row.status = row.status === 'completed' ? 'completed' : 'deleting';
      return { ...row };
    },
    markOperationCompleted: async (key) => completed(key),
    getDestructiveOperationStatus: async (key) => {
      const row = requests.get(key.requestId);
      return row && sameKey(row, key) ? { ...row } : null;
    },
    pruneExpiredDestructiveOperations: async () => { calls.prune += 1; },
    deleteAuthUser: async (subject) => {
      calls.deleteAuth.push(subject);
      userExists = false;
      return 'deleted';
    },
    authUserExists: async (subject) => {
      calls.statusChecks.push(subject);
      return userExists;
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    requests,
    complete: completed,
    setUserExists: (value) => { userExists = value; },
  };
}

test('request parser accepts exact v3 capabilities for all mutations and status scopes', () => {
  assert.equal(parseDeletionRequest(JSON.stringify(mutationBody('delete_workspace'))).action, 'delete_workspace');
  assert.equal(parseDeletionRequest(JSON.stringify(mutationBody('clear_business_data', BUSINESS_REQUEST_ID))).action, 'clear_business_data');
  assert.equal(parseDeletionRequest(JSON.stringify(mutationBody('delete_account', ACCOUNT_REQUEST_ID))).action, 'delete_account');
  assert.deepEqual(parseDeletionRequest(JSON.stringify(statusBody('delete_workspace'))), statusBody('delete_workspace'));

  for (const value of [
    '{}',
    JSON.stringify({ ...mutationBody('clear_business_data'), protocolVersion: 2 }),
    JSON.stringify({ ...mutationBody('delete_account'), confirmation: 'delete' }),
    JSON.stringify({ ...mutationBody('delete_workspace'), userId: USER_ID }),
    JSON.stringify({ ...statusBody('delete_workspace'), workspaceId: undefined }),
    JSON.stringify({ ...statusBody('delete_account'), recoverySecret: 'weak' }),
  ]) assert.throws(() => parseDeletionRequest(value), /invalid deletion request/i);
});

test('exact Origin and OPTIONS are enforced without wildcard CORS', async () => {
  const handler = createDeletionHandler(memoryDependencies().deps);
  const good = await handler(new Request('https://edge.example.com/delete-account', {
    method: 'OPTIONS', headers: { Origin: ORIGIN },
  }));
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
  for (const origin of ['', 'https://evil.example.com']) {
    const response = await handler(new Request('https://edge.example.com/delete-account', {
      method: 'OPTIONS', headers: origin ? { Origin: origin } : {},
    }));
    assert.equal(response.status, 403);
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
  }
});

test('chunked requests stop at 1024 bytes before authentication', async () => {
  const memory = memoryDependencies();
  const handler = createDeletionHandler(memory.deps);
  const request = new Request('https://edge.example.com/delete-account', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'content-type': 'application/json', Authorization: `Bearer ${jwt(freshClaims())}` },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  const response = await handler(request);
  assert.equal(response.status, 413);
  assert.equal(memory.calls.verify, 0);
});

test('one total deadline covers a stalled chunked body and sequential upstream work', async () => {
  const stalled = memoryDependencies();
  stalled.deps.totalDeadlineMs = 20;
  const bodyResponse = await createDeletionHandler(stalled.deps)(new Request(
    'https://edge.example.com/delete-account',
    {
      method: 'POST',
      headers: { Origin: ORIGIN, 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } }),
      duplex: 'half',
    },
  ));
  assert.equal(bodyResponse.status, 503);
  assert.equal(stalled.calls.verify, 0);

  const upstream = memoryDependencies();
  upstream.deps.totalDeadlineMs = 35;
  upstream.deps.verifyUser = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      id: USER_ID,
      is_anonymous: false,
      last_sign_in_at: new Date((NOW - 10) * 1000).toISOString(),
    };
  };
  upstream.deps.fingerprint = async (kind, value, context) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      context.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DeletionProtocolError('DEADLINE_EXCEEDED', 'deadline'));
      }, { once: true });
    });
    return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
  };
  const upstreamResponse = await createDeletionHandler(upstream.deps)(
    jsonRequest(mutationBody('delete_workspace')),
  );
  assert.equal(upstreamResponse.status, 503);
  assert.equal(upstream.calls.workspace.length, 0);
});

test('Auth invalid, stale, and upstream failure fail closed', async () => {
  const invalid = memoryDependencies({ verifyUser: async () => null });
  assert.equal((await createDeletionHandler(invalid.deps)(
    jsonRequest(mutationBody('clear_business_data')),
  )).status, 401);
  const stale = memoryDependencies();
  assert.equal((await createDeletionHandler(stale.deps)(jsonRequest(
    mutationBody('clear_business_data'),
    { token: jwt(freshClaims({ iat: NOW - 301 })) },
  ))).status, 403);
  const unavailable = memoryDependencies({
    verifyUser: async () => { throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'private'); },
  });
  const response = await createDeletionHandler(unavailable.deps)(
    jsonRequest(mutationBody('clear_business_data')),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await json(response), { error: 'deletion_unavailable' });

  const deadline = memoryDependencies({
    verifyUser: async () => { throw new DeletionProtocolError('DEADLINE_EXCEEDED', 'private'); },
  });
  const deadlineResponse = await createDeletionHandler(deadline.deps)(
    jsonRequest(mutationBody('clear_business_data')),
  );
  assert.equal(deadlineResponse.status, 503);
  assert.deepEqual(await json(deadlineResponse), { error: 'deletion_unavailable' });
});

test('verified JWT session id is propagated to every destructive SQL boundary', async () => {
  const authorization = await authorizeAccountDeletion({
    bearerToken: jwt(freshClaims()),
    nowSeconds: NOW,
    verifyUser: async () => ({
      id: USER_ID,
      is_anonymous: false,
      last_sign_in_at: new Date((NOW - 10) * 1000).toISOString(),
    }),
  });
  assert.deepEqual(authorization, { userId: USER_ID, sessionId: SESSION_ID });

  const memory = memoryDependencies();
  const handler = createDeletionHandler(memory.deps);
  assert.equal((await handler(jsonRequest(mutationBody('delete_workspace')))).status, 200);
  assert.equal((await handler(jsonRequest(
    mutationBody('clear_business_data', BUSINESS_REQUEST_ID),
  ))).status, 200);
  assert.deepEqual(memory.calls.begin.map(({ subject, sessionId, operation }) => ({
    subject, sessionId, operation,
  })), [
    { subject: USER_ID, sessionId: SESSION_ID, operation: 'delete_workspace' },
    { subject: USER_ID, sessionId: SESSION_ID, operation: 'clear_business_data' },
  ]);
  assert.equal(memory.calls.workspace[0].sessionId, SESSION_ID);
  assert.equal(memory.calls.business[0].sessionId, SESSION_ID);
});

test('a revoked or missing auth.sessions row fails closed before deletion', async () => {
  const memory = memoryDependencies({
    beginDestructiveOperation: async () => {
      throw new DeletionProtocolError('REAUTH_REQUIRED', 'active session required');
    },
  });
  const response = await createDeletionHandler(memory.deps)(
    jsonRequest(mutationBody('clear_business_data')),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await json(response), { error: 'recent_reauthentication_required' });
  assert.equal(memory.calls.business.length, 0);
  assert.equal(memory.calls.deleteAuth.length, 0);
});

test('workspace and business deletes are subject-bound, atomic, replayable, and receipt-stable', async () => {
  const memory = memoryDependencies();
  const handler = createDeletionHandler(memory.deps);
  const workspaceBody = mutationBody('delete_workspace');
  const first = await handler(jsonRequest(workspaceBody));
  const replay = await handler(jsonRequest(workspaceBody));
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal((await json(first)).receiptId, RECEIPT_ID);
  assert.equal((await json(replay)).receiptId, RECEIPT_ID);
  assert.deepEqual(memory.calls.workspace, [{
    subject: USER_ID,
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    confirmation: DELETE_WORKSPACE_CONFIRMATION,
  }]);

  const business = await handler(jsonRequest(mutationBody('clear_business_data', BUSINESS_REQUEST_ID)));
  assert.equal(business.status, 200);
  assert.deepEqual(memory.calls.business, [{
    subject: USER_ID,
    sessionId: SESSION_ID,
    confirmation: CLEAR_BUSINESS_CONFIRMATION,
  }]);
  const wrongScope = await handler(jsonRequest({ ...workspaceBody, workspaceId: crypto.randomUUID() }));
  assert.equal(wrongScope.status, 409);
});

test('business and account deletion require journal proof before database or Auth deletion', async () => {
  const order = [];
  const memory = memoryDependencies({
    executeJournaledDeletion: async (row) => {
      order.push(`journal:${row.operation}`);
      return { state: 'DELETED', receiptId: row.eventId };
    },
    executeBusinessDeletion: async (row) => {
      order.push('business');
      return memory.complete(row);
    },
    markAccountDeleting: async (row) => {
      order.push('mark-account');
      const current = memory.requests.get(row.requestId);
      current.status = 'deleting';
      return { ...current };
    },
    deleteAuthUser: async () => {
      order.push('auth');
      memory.setUserExists(false);
      return 'deleted';
    },
  });
  const handler = createDeletionHandler(memory.deps);
  assert.equal((await handler(jsonRequest(
    mutationBody('clear_business_data', BUSINESS_REQUEST_ID),
  ))).status, 200);
  assert.equal((await handler(jsonRequest(
    mutationBody('delete_account', ACCOUNT_REQUEST_ID),
  ))).status, 200);
  assert.deepEqual(order, [
    'journal:DELETE_BUSINESS_DATA', 'business',
    'journal:DELETE_ACCOUNT', 'mark-account', 'auth',
  ]);

  const blocked = memoryDependencies({
    executeJournaledDeletion: async () => {
      throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'R2 unavailable');
    },
  });
  const blockedHandler = createDeletionHandler(blocked.deps);
  assert.equal((await blockedHandler(jsonRequest(
    mutationBody('clear_business_data', BUSINESS_REQUEST_ID),
  ))).status, 503);
  assert.equal((await blockedHandler(jsonRequest(
    mutationBody('delete_account', ACCOUNT_REQUEST_ID),
  ))).status, 503);
  assert.equal(blocked.calls.business.length, 0);
  assert.equal(blocked.calls.deleteAuth.length, 0);
});

test('lost workspace-delete response is definitively reconciled by capability status', async () => {
  const memory = memoryDependencies();
  const original = memory.deps.executeWorkspaceDeletion;
  memory.deps.executeWorkspaceDeletion = async (row, context) => {
    await original(row, context);
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'response lost after commit');
  };
  const handler = createDeletionHandler(memory.deps);
  assert.equal((await handler(jsonRequest(mutationBody('delete_workspace')))).status, 503);

  const status = await handler(jsonRequest(statusBody('delete_workspace'), { token: '' }));
  assert.equal(status.status, 200);
  assert.deepEqual(await json(status), {
    protocolVersion: 3,
    action: 'deletion_status',
    operation: 'delete_workspace',
    state: 'completed',
    receiptId: RECEIPT_ID,
    expiresAt: new Date((NOW + 3600) * 1000).toISOString(),
  });
});

test('account deletion is idempotent and a lost Admin response is recoverable without JWT', async () => {
  const memory = memoryDependencies();
  const handler = createDeletionHandler(memory.deps);
  const body = mutationBody('delete_account', ACCOUNT_REQUEST_ID);
  const [first, second] = await Promise.all([handler(jsonRequest(body)), handler(jsonRequest(body))]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await json(first)).receiptId, RECEIPT_ID);
  assert.equal((await json(second)).receiptId, RECEIPT_ID);
  assert.ok(memory.calls.deleteAuth.every((subject) => subject === USER_ID));

  const lost = memoryDependencies();
  lost.deps.deleteAuthUser = async (subject) => {
    lost.calls.deleteAuth.push(subject);
    lost.setUserExists(false);
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'response lost after delete');
  };
  const lostHandler = createDeletionHandler(lost.deps);
  assert.equal((await lostHandler(jsonRequest(body))).status, 503);
  const status = await lostHandler(jsonRequest(
    statusBody('delete_account', ACCOUNT_REQUEST_ID), { token: '' },
  ));
  assert.equal(status.status, 200);
  assert.equal((await json(status)).state, 'completed');
  assert.deepEqual(lost.calls.statusChecks, [USER_ID]);
  assert.deepEqual(lost.calls.journal.map(call => call.operation), [
    'DELETE_ACCOUNT', 'DELETE_ACCOUNT',
  ]);
});

test('an out-of-band missing Auth user cannot bypass the external deletion journal', async () => {
  const memory = memoryDependencies({
    executeJournaledDeletion: async () => {
      throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'R2 unavailable');
    },
  });
  const handler = createDeletionHandler(memory.deps);
  const body = mutationBody('delete_account', ACCOUNT_REQUEST_ID);
  assert.equal((await handler(jsonRequest(body))).status, 503);
  memory.setUserExists(false);

  const status = await handler(jsonRequest(
    statusBody('delete_account', ACCOUNT_REQUEST_ID), { token: '' },
  ));
  assert.equal(status.status, 503);
  assert.deepEqual(await json(status), { error: 'deletion_unavailable' });
  assert.equal(memory.requests.get(ACCOUNT_REQUEST_ID).status, 'pending');
});

test('forged or wrong-scope status cannot enumerate requests or trigger global pruning', async () => {
  const memory = memoryDependencies();
  const handler = createDeletionHandler(memory.deps);
  const unknown = await handler(jsonRequest(statusBody('delete_workspace'), { token: '' }));
  assert.equal(unknown.status, 404);
  assert.equal(memory.calls.prune, 0);
  const wrongCapability = await handler(jsonRequest(
    statusBody('delete_workspace', REQUEST_ID, `rvr1_${'C'.repeat(43)}`),
    { token: '' },
  ));
  assert.equal(wrongCapability.status, 404);
  assert.deepEqual(await json(wrongCapability), { error: 'deletion_request_not_found' });
});

test('database capacity and token refusals return one bounded retryable public response', async () => {
  const privateDetail = `${USER_ID}:${WORKSPACE_ID}:${RECOVERY_SECRET}`;
  const memory = memoryDependencies({
    beginDestructiveOperation: async () => {
      throw new DeletionProtocolError('RATE_LIMITED', privateDetail);
    },
  });
  const response = await createDeletionHandler(memory.deps)(jsonRequest(mutationBody('delete_workspace')));
  const body = await response.text();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '1');
  assert.deepEqual(JSON.parse(body), { error: 'rate_limited' });
  assert.doesNotMatch(body, new RegExp(`${USER_ID}|${WORKSPACE_ID}|${RECOVERY_SECRET}`, 'i'));
});

test('edge wiring uses generic service-only operation RPCs, HMAC, and one total deadline', () => {
  assert.match(index, /DELETION_HMAC_SECRET/);
  assert.match(index, /rv_service_execute_workspace_deletion/);
  assert.match(index, /rv_service_execute_business_deletion/);
  assert.match(index, /rv_begin_destructive_operation/);
  assert.match(index, /rv2_restore_v2_prepare_public_deletion/);
  assert.match(index, /rv2_restore_v2_attest_deletion_journal/);
  assert.match(index, /rv2_restore_v2_execute_deletion/);
  assert.match(index, /DELETION_R2_API_TOKEN/);
  assert.match(handlerSource, /executeJournaledDeletion[\s\S]*executeBusinessDeletion/);
  assert.match(handlerSource, /executeJournaledDeletion[\s\S]*markAccountDeleting[\s\S]*deleteAuthUser/);
  assert.match(index, /code === 'P0003'[\s\S]{0,120}REAUTH_REQUIRED/);
  assert.match(index, /code === 'P0004' \|\| code === 'P0005'/);
  assert.match(handlerSource, /RATE_LIMITED'[\s\S]{0,80}\[429, 'rate_limited'\]/);
  assert.match(index, /p_session_id:\s*row\.sessionId/g);
  assert.match(index, /TOTAL_DEADLINE_MS/);
  assert.match(index, /TOTAL_DEADLINE_MS\s*=\s*ACCOUNT_DELETION_EDGE_DEADLINE_MS/);
  assert.match(handlerSource, /DEFAULT_TOTAL_DEADLINE_MS\s*=\s*ACCOUNT_DELETION_EDGE_DEADLINE_MS/);
  assert.match(index, /boundedJsonFetch[\s\S]*context\.signal/);
  assert.doesNotMatch(index, /setTimeout\([^)]*UPSTREAM_TIMEOUT_MS|UPSTREAM_TIMEOUT_MS/);
  assert.doesNotMatch(handlerSource, /pruneExpiredDestructiveOperations/);
  assert.doesNotMatch(index, /console\.(log|error)[\s\S]{0,120}(token|email|user|secret)/i);
  assert.doesNotMatch(index, /Access-Control-Allow-Origin["']?:\s*["']\*/i);
  assert.match(config, /\[functions\.delete-account\][\s\S]*verify_jwt\s*=\s*false/i);
});

test('browser recovery envelope is cross-checked against Edge and server maximums', () => {
  const clientDeadline = exportedInteger(
    accountClient,
    'ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS',
  );
  const edgeDeadline = exportedInteger(
    accountClient,
    'ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS',
  );
  const serverTtl = exportedInteger(
    accountClient,
    'ACCOUNT_DELETION_SERVER_STATUS_TTL_MS',
  );
  assert.equal(clientDeadline, 15_000);
  assert.equal(edgeDeadline, ACCOUNT_DELETION_EDGE_DEADLINE_MS);
  assert.equal(serverTtl, ACCOUNT_DELETION_TTL_SECONDS * 1_000);
  assert.match(
    accountClient,
    /ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS\s*=\s*[\s\S]{0,300}ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS[\s\S]{0,120}ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS[\s\S]{0,120}ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS[\s\S]{0,120}ACCOUNT_DELETION_SERVER_STATUS_TTL_MS/,
  );
});

test('tracked production Auth contract is invite-only and exact-origin', () => {
  assert.match(apiConfig, /auto_expose_new_tables\s*=\s*false/i);
  assert.match(dbConfig, /major_version\s*=\s*17/i);
  assert.match(authConfig, /site_url\s*=\s*"https:\/\/binance-futures-review-web\.vercel\.app"/i);
  assert.match(authConfig, /additional_redirect_urls\s*=\s*\["https:\/\/binance-futures-review-web\.vercel\.app"\]/i);
  assert.match(authConfig, /enable_refresh_token_rotation\s*=\s*true/i);
  assert.match(authConfig, /refresh_token_reuse_interval\s*=\s*10/i);
  assert.match(authConfig, /enable_signup\s*=\s*false/i);
  assert.match(authConfig, /enable_anonymous_sign_ins\s*=\s*false/i);
  assert.match(authConfig, /enable_manual_linking\s*=\s*false/i);
  assert.match(authEmailConfig, /enable_signup\s*=\s*false/i);
  assert.match(authEmailConfig, /otp_length\s*=\s*6/i);
  assert.match(authEmailConfig, /otp_expiry\s*=\s*600/i);
  assert.match(authMagicLinkConfig, /content_path\s*=\s*"\.\/supabase\/templates\/magic-link\.html"/i);
  assert.match(authRateLimitConfig, /email_sent\s*=\s*6/i);
  assert.doesNotMatch(config, /additional_redirect_urls\s*=\s*\[[^\]]*\*/i);
  assert.doesNotMatch(config, /(service_role|secret|password|project_id|project_ref)\s*=\s*["']/i);
  assert.match(magicLinkTemplate, /\{\{\s*\.Token\s*\}\}/);
  assert.match(magicLinkTemplate, /6 位验证码[\s\S]*10 分钟/);
  assert.doesNotMatch(magicLinkTemplate, /ConfirmationURL|TokenHash|<script|https?:\/\//i);
});

test('README contains v3 recovery, live gates, rate/cost controls, and honest boundaries', () => {
  assert.match(readme, /do not deploy|不要部署/i);
  assert.match(readme, /recent.{0,40}OTP|近期.{0,40}验证码/i);
  assert.match(readme, /two real users|两个真实测试用户/i);
  assert.match(readme, /workspace[\s\S]{0,160}lost|工作区[\s\S]{0,160}丢失/i);
  assert.match(readme, /Origin[\s\S]{0,160}(not authentication|不是身份验证)/i);
  assert.match(readme, /rate limit|限流/i);
  assert.match(readme, /cost|费用|预算/i);
  assert.match(readme, /cannot contain or promise[\s\S]{0,80}`expiresAt`/i);
  assert.match(readme, /not a provider-routing guarantee/i);
  assert.match(readme, /refreshing or re-importing[\s\S]{0,80}never extends/i);
  assert.match(readme, /## Honest boundaries/i);
  const bullets = (readme.split(/## Honest boundaries/i)[1] ?? '').match(/^- /gm) ?? [];
  assert.ok(bullets.length >= 3, `expected at least 3 honest boundaries, got ${bullets.length}`);
});
