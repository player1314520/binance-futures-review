import { createDeletionHandler } from './handler.mjs';
import {
  ACCOUNT_DELETION_EDGE_DEADLINE_MS,
  DeletionProtocolError,
} from './protocol.mjs';
import { createEdgeDeletionJournal } from './r2-journal.mjs';

const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const TOTAL_DEADLINE_MS = ACCOUNT_DELETION_EDGE_DEADLINE_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function exactHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin !== raw.trim().replace(/\/$/, '')
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function serverConfig(): {
  allowedOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  hmacSecret: string;
  r2AccountId: string;
  r2ApiToken: string;
  r2ParentAccessKeyId: string;
  r2Bucket: string;
} | null {
  const allowedOrigin = exactHttpsOrigin(Deno.env.get('APP_ORIGIN') ?? '');
  const supabaseUrl = exactHttpsOrigin(Deno.env.get('SUPABASE_URL') ?? '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';
  const hmacSecret = Deno.env.get('DELETION_HMAC_SECRET') ?? '';
  const r2AccountId = Deno.env.get('DELETION_R2_ACCOUNT_ID')?.trim() ?? '';
  const r2ApiToken = Deno.env.get('DELETION_R2_API_TOKEN')?.trim() ?? '';
  const r2ParentAccessKeyId = Deno.env.get('DELETION_R2_PARENT_ACCESS_KEY_ID')?.trim() ?? '';
  const r2Bucket = Deno.env.get('DELETION_R2_BUCKET')?.trim() ?? '';
  if (
    !allowedOrigin
    || !supabaseUrl
    || serviceRoleKey.length < 20
    || serviceRoleKey.length > 8192
    || /\s/.test(serviceRoleKey)
    || hmacSecret.length < 32
    || hmacSecret.length > 4096
    || !/^[a-f0-9]{32}$/.test(r2AccountId)
    || !/^\S{32,8192}$/.test(r2ApiToken)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(r2ParentAccessKeyId)
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(r2Bucket)
    || r2Bucket.includes('..')
  ) return null;
  return {
    allowedOrigin,
    supabaseUrl,
    serviceRoleKey,
    hmacSecret,
    r2AccountId,
    r2ApiToken,
    r2ParentAccessKeyId,
    r2Bucket,
  };
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DeletionProtocolError('DEADLINE_EXCEEDED', 'total deadline exceeded');
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DeletionProtocolError('DEADLINE_EXCEEDED', 'total deadline exceeded'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'upstream response too large');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel('response too large');
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'upstream response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) as unknown : null;
  } catch (error) {
    if (error instanceof DeletionProtocolError && error.code === 'DEADLINE_EXCEEDED') {
      void reader.cancel('total deadline exceeded').catch(() => {});
    }
    if (error instanceof DeletionProtocolError) throw error;
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'invalid upstream response');
  } finally {
    reader.releaseLock();
  }
}

async function boundedJsonFetch(
  input: string,
  init: RequestInit,
  context: Readonly<{ signal: AbortSignal }>,
): Promise<Readonly<{ response: Response; value: unknown }>> {
  try {
    if (context.signal.aborted) {
      throw new DeletionProtocolError('DEADLINE_EXCEEDED', 'total deadline exceeded');
    }
    const response = await fetch(input, { ...init, signal: context.signal, redirect: 'error' });
    const value = await readBoundedJson(response, context.signal);
    return Object.freeze({ response, value });
  } catch (error) {
    if (error instanceof DeletionProtocolError) throw error;
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'upstream unavailable');
  }
}

function stateRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : null;
  if (!row || typeof row !== 'object') {
    throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'invalid state response');
  }
  const data = row as Record<string, unknown>;
  if (
    typeof data.request_id !== 'string'
    || !UUID_PATTERN.test(data.request_id)
    || !['delete_workspace', 'clear_business_data', 'delete_account'].includes(String(data.operation))
    || !['pending', 'deleting', 'completed'].includes(String(data.status))
    || typeof data.receipt_id !== 'string'
    || !UUID_PATTERN.test(data.receipt_id)
    || typeof data.expires_at !== 'string'
    || !Number.isFinite(Date.parse(data.expires_at))
  ) throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'invalid state response');
  return Object.freeze({
    requestId: data.request_id,
    operation: String(data.operation),
    status: String(data.status),
    receiptId: data.receipt_id,
    expiresAt: data.expires_at,
  });
}

function buildDependencies(config: NonNullable<ReturnType<typeof serverConfig>>) {
  const serviceHeaders = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const encoder = new TextEncoder();
  const hmacKey = crypto.subtle.importKey(
    'raw',
    encoder.encode(config.hmacSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const deletionJournal = createEdgeDeletionJournal({
    accountId: config.r2AccountId,
    apiToken: config.r2ApiToken,
    parentAccessKeyId: config.r2ParentAccessKeyId,
    bucket: config.r2Bucket,
  });

  async function rpc(
    name: string,
    body: Record<string, unknown>,
    context: Readonly<{ signal: AbortSignal }>,
  ): Promise<unknown> {
    const { response, value } = await boundedJsonFetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify(body),
    }, context);
    if (!response.ok) {
      const code = value && typeof value === 'object'
        ? String((value as Record<string, unknown>).code ?? '')
        : '';
      if (code === '23505') throw new DeletionProtocolError('IDEMPOTENCY_CONFLICT', 'idempotency conflict');
      if (code === 'P0002') throw new DeletionProtocolError('DELETION_REQUEST_NOT_FOUND', 'deletion request not found');
      if (code === 'P0003') throw new DeletionProtocolError('REAUTH_REQUIRED', 'active session required');
      if (code === 'P0004' || code === 'P0005') {
        throw new DeletionProtocolError('RATE_LIMITED', 'database admission rejected');
      }
      throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'database operation unavailable');
    }
    return value;
  }

  async function adminUserExists(
    subject: string,
    context: Readonly<{ signal: AbortSignal }>,
  ): Promise<boolean> {
    const { response, value } = await boundedJsonFetch(
      `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(subject)}`,
      { method: 'GET', headers: serviceHeaders },
      context,
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok || !value || typeof value !== 'object') {
      throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'Auth user probe unavailable');
    }
    return (value as Record<string, unknown>).id === subject;
  }

  return {
    allowedOrigin: config.allowedOrigin,
    totalDeadlineMs: TOTAL_DEADLINE_MS,
    nowSeconds: () => Date.now() / 1000,
    randomUUID: () => crypto.randomUUID(),
    async verifyUser(jwt: string, context: Readonly<{ signal: AbortSignal }>) {
      const { response, value } = await boundedJsonFetch(`${config.supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${jwt}`,
          'Cache-Control': 'no-store',
        },
      }, context);
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) {
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'Auth verification unavailable');
      }
      if (!value || typeof value !== 'object') return null;
      const data = value as Record<string, unknown>;
      return {
        id: typeof data.id === 'string' ? data.id : '',
        is_anonymous: data.is_anonymous === true,
        last_sign_in_at: typeof data.last_sign_in_at === 'string' ? data.last_sign_in_at : '',
      };
    },
    async fingerprint(kind: string, value: string) {
      const signature = await crypto.subtle.sign(
        'HMAC',
        await hmacKey,
        encoder.encode(`review-workbench-delete-v3\0${kind}\0${value}`),
      );
      const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!FINGERPRINT_PATTERN.test(hex)) throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'fingerprint unavailable');
      return hex;
    },
    async beginDestructiveOperation(row: {
      requestId: string;
      capabilityFingerprint: string;
      subjectFingerprint: string;
      scopeFingerprint: string;
      operation: string;
      subject: string;
      sessionId: string;
      receiptId: string;
      expiresAt: string;
    }, context: Readonly<{ signal: AbortSignal }>) {
      return stateRow(await rpc('rv_begin_destructive_operation', {
        p_subject: row.subject,
        p_session_id: row.sessionId,
        p_request_id: row.requestId,
        p_capability_fingerprint: row.capabilityFingerprint,
        p_subject_fingerprint: row.subjectFingerprint,
        p_scope_fingerprint: row.scopeFingerprint,
        p_operation: row.operation,
        p_receipt_id: row.receiptId,
        p_expires_at: row.expiresAt,
      }, context));
    },
    async executeWorkspaceDeletion(row: {
      requestId: string;
      capabilityFingerprint: string;
      subjectFingerprint: string;
      scopeFingerprint: string;
      operation: string;
      subject: string;
      sessionId: string;
      workspaceId: string;
      confirmation: string;
    }, context: Readonly<{ signal: AbortSignal }>) {
      return stateRow(await rpc('rv_service_execute_workspace_deletion', {
        p_subject: row.subject,
        p_session_id: row.sessionId,
        p_workspace_id: row.workspaceId,
        p_confirmation: row.confirmation,
        p_request_id: row.requestId,
        p_capability_fingerprint: row.capabilityFingerprint,
        p_subject_fingerprint: row.subjectFingerprint,
        p_scope_fingerprint: row.scopeFingerprint,
      }, context));
    },
    async executeJournaledDeletion(row: {
      subject: string;
      eventId: string;
      operation: 'DELETE_BUSINESS_DATA' | 'DELETE_ACCOUNT';
    }, context: Readonly<{ signal: AbortSignal }>) {
      const prepared = await rpc('rv2_restore_v2_prepare_public_deletion', {
        p_subject: row.subject,
        p_event_id: row.eventId,
        p_operation: row.operation,
      }, context) as Record<string, unknown>;
      const event = prepared?.event as Record<string, unknown> | undefined;
      if (
        prepared?.format !== 'rv-deletion-intent/2'
        || typeof prepared.intentId !== 'string'
        || !UUID_PATTERN.test(prepared.intentId)
        || typeof prepared.eventSha256 !== 'string'
        || !FINGERPRINT_PATTERN.test(prepared.eventSha256)
        || !event
        || event.format !== 'rv-deletion-journal-event/2'
        || event.eventId !== row.eventId
        || event.operation !== row.operation
      ) throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'deletion intent unavailable');
      const proof = await deletionJournal.appendAndProve({
        event,
        expectedSha256: prepared.eventSha256,
        signal: context.signal,
      });
      const attested = await rpc('rv2_restore_v2_attest_deletion_journal', {
        p_intent_id: prepared.intentId,
        p_object_evidence: proof.objectEvidence,
        p_range_proof: proof.rangeProof,
      }, context) as Record<string, unknown>;
      if (attested?.format !== 'rv-deletion-journal-attestation/2'
        || !['JOURNALED', 'DELETED'].includes(String(attested.state))) {
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'deletion journal attestation unavailable');
      }
      const executed = await rpc('rv2_restore_v2_execute_deletion', {
        p_intent_id: prepared.intentId,
      }, context) as Record<string, unknown>;
      if (executed?.format !== 'rv-deletion-result/2'
        || executed.state !== 'DELETED'
        || executed.receiptId !== row.eventId) {
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'journaled deletion unavailable');
      }
      return executed;
    },
    async executeBusinessDeletion(row: {
      requestId: string;
      capabilityFingerprint: string;
      subjectFingerprint: string;
      scopeFingerprint: string;
      operation: string;
      subject: string;
      sessionId: string;
      confirmation: string;
    }, context: Readonly<{ signal: AbortSignal }>) {
      return stateRow(await rpc('rv_service_execute_business_deletion', {
        p_subject: row.subject,
        p_session_id: row.sessionId,
        p_confirmation: row.confirmation,
        p_request_id: row.requestId,
        p_capability_fingerprint: row.capabilityFingerprint,
        p_subject_fingerprint: row.subjectFingerprint,
        p_scope_fingerprint: row.scopeFingerprint,
      }, context));
    },
    async markAccountDeleting(
      key: {
        requestId: string;
        capabilityFingerprint: string;
        subjectFingerprint: string;
        scopeFingerprint: string;
        operation: string;
        subject: string;
        sessionId: string;
      },
      context: Readonly<{ signal: AbortSignal }>,
    ) {
      return stateRow(await rpc('rv_mark_destructive_operation_deleting', {
        p_subject: key.subject,
        p_session_id: key.sessionId,
        p_request_id: key.requestId,
        p_capability_fingerprint: key.capabilityFingerprint,
        p_subject_fingerprint: key.subjectFingerprint,
        p_scope_fingerprint: key.scopeFingerprint,
        p_operation: key.operation,
      }, context));
    },
    async markOperationCompleted(
      key: {
        requestId: string;
        capabilityFingerprint: string;
        subjectFingerprint: string;
        scopeFingerprint: string;
        operation: string;
      },
      context: Readonly<{ signal: AbortSignal }>,
    ) {
      return stateRow(await rpc('rv_mark_destructive_operation_completed', {
        p_request_id: key.requestId,
        p_capability_fingerprint: key.capabilityFingerprint,
        p_subject_fingerprint: key.subjectFingerprint,
        p_scope_fingerprint: key.scopeFingerprint,
        p_operation: key.operation,
      }, context));
    },
    async getDestructiveOperationStatus(
      key: {
        requestId: string;
        capabilityFingerprint: string;
        subjectFingerprint: string;
        scopeFingerprint: string;
        operation: string;
      },
      context: Readonly<{ signal: AbortSignal }>,
    ) {
      const value = await rpc('rv_get_destructive_operation_status', {
        p_request_id: key.requestId,
        p_capability_fingerprint: key.capabilityFingerprint,
        p_subject_fingerprint: key.subjectFingerprint,
        p_scope_fingerprint: key.scopeFingerprint,
        p_operation: key.operation,
      }, context);
      if (Array.isArray(value) && value.length === 0) return null;
      return stateRow(value);
    },
    async deleteAuthUser(subject: string, context: Readonly<{ signal: AbortSignal }>) {
      const { response } = await boundedJsonFetch(
        `${config.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(subject)}`,
        { method: 'DELETE', headers: serviceHeaders },
        context,
      );
      if (response.status === 404) {
        return 'not_found';
      }
      if (!response.ok) {
        throw new DeletionProtocolError('UPSTREAM_UNAVAILABLE', 'Auth deletion unavailable');
      }
      return 'deleted';
    },
    authUserExists: adminUserExists,
  };
}

const config = serverConfig();
if (!config) {
  Deno.serve(() => new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }));
} else {
  Deno.serve(createDeletionHandler(buildDependencies(config)));
}
