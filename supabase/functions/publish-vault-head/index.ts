import { createPublishVaultHeadHandler } from './handler.mjs';
import { PublishProtocolError } from './protocol.mjs';

const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;

function exactHttpsOrigin(raw: string): string | null {
  const value = raw.trim();
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
      || url.origin !== value.replace(/\/$/, '')
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
} | null {
  const allowedOrigin = exactHttpsOrigin(Deno.env.get('APP_ORIGIN') ?? '');
  const supabaseUrl = exactHttpsOrigin(Deno.env.get('SUPABASE_URL') ?? '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? '';
  if (
    !allowedOrigin
    || !supabaseUrl
    || serviceRoleKey.length < 20
    || serviceRoleKey.length > 8192
    || /\s/.test(serviceRoleKey)
  ) return null;
  return { allowedOrigin, supabaseUrl, serviceRoleKey };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    try { await response.body?.cancel('upstream response too large'); } catch { /* no-op */ }
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'upstream response too large');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel('upstream response too large');
        throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'upstream response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) as unknown : null;
  } catch (error) {
    if (error instanceof PublishProtocolError) throw error;
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'invalid upstream response');
  } finally {
    reader.releaseLock();
  }
}

async function boundedJsonFetch(
  input: string,
  init: RequestInit,
  requestSignal: AbortSignal,
): Promise<Readonly<{ response: Response; value: unknown }>> {
  if (requestSignal.aborted) {
    throw new PublishProtocolError('DEADLINE_EXCEEDED', 'request deadline exceeded');
  }
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort('request deadline exceeded');
  requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  const timer = setTimeout(() => controller.abort('upstream timeout'), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    const value = await readBoundedJson(response);
    return Object.freeze({ response, value });
  } catch (error) {
    if (error instanceof PublishProtocolError) throw error;
    if (requestSignal.aborted) {
      throw new PublishProtocolError('DEADLINE_EXCEEDED', 'request deadline exceeded');
    }
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'upstream unavailable');
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', onRequestAbort);
  }
}

function oneRow(value: unknown, label: string): Record<string, unknown> | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', `invalid ${label} response`);
  }
  const row = value[0];
  if (row === undefined) return null;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', `invalid ${label} response`);
  }
  return row as Record<string, unknown>;
}

function databaseError(value: unknown): PublishProtocolError {
  const code = value && typeof value === 'object'
    ? String((value as Record<string, unknown>).code ?? '')
    : '';
  if (code === '40001') return new PublishProtocolError('CONFLICT', 'publish conflict');
  if (code === 'P0002') return new PublishProtocolError('NOT_FOUND', 'vault candidate unavailable');
  if (code === 'P0003') return new PublishProtocolError('UNAUTHORIZED', 'live Auth session required');
  if (code === 'P0004' || code === 'P0005') {
    return new PublishProtocolError('RATE_LIMITED', 'database admission rejected');
  }
  return new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'database operation unavailable');
}

function buildDependencies(config: NonNullable<ReturnType<typeof serverConfig>>) {
  const serviceHeaders = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Cache-Control': 'no-store',
  };

  async function rpc(
    name: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { response, value } = await boundedJsonFetch(
      `${config.supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
    );
    if (!response.ok) throw databaseError(value);
    return value;
  }

  return {
    allowedOrigin: config.allowedOrigin,
    async verifyUser(jwt: string, { signal }: { signal: AbortSignal }) {
      const { response, value } = await boundedJsonFetch(`${config.supabaseUrl}/auth/v1/user`, {
        method: 'GET',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${jwt}`,
          'Cache-Control': 'no-store',
        },
      }, signal);
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PublishProtocolError('UPSTREAM_UNAVAILABLE', 'Auth verification unavailable');
      }
      const row = value as Record<string, unknown>;
      return {
        id: typeof row.id === 'string' ? row.id : '',
        is_anonymous: row.is_anonymous === true,
      };
    },
    async getPublishContext(
      subject: string,
      sessionId: string,
      workspaceId: string,
      objectId: string,
      { signal }: { signal: AbortSignal },
    ) {
      return oneRow(await rpc('rv_service_read_publish_context', {
        p_subject: subject,
        p_session_id: sessionId,
        p_workspace_id: workspaceId,
        p_object_id: objectId,
      }, signal), 'publish context');
    },
    async publishHead(
      subject: string,
      sessionId: string,
      workspaceId: string,
      expectedGeneration: number,
      objectId: string,
      { signal }: { signal: AbortSignal },
    ) {
      return oneRow(await rpc('rv_service_publish_vault_head', {
        p_subject: subject,
        p_session_id: sessionId,
        p_workspace_id: workspaceId,
        p_expected_generation: expectedGeneration,
        p_object_id: objectId,
      }, signal), 'publish');
    },
  };
}

const config = serverConfig();
if (!config) {
  Deno.serve(() => new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  }));
} else {
  Deno.serve(createPublishVaultHeadHandler(buildDependencies(config)));
}
