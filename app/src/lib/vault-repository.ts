import {
  VAULT_PUBLISH_PROTOCOL_VERSION,
  VAULT_SIGNING_ALGORITHM,
  sha256Hex,
  verifyVaultObjectSignature,
} from './vault-signing';

export const VAULT_ENVELOPE_VERSION = 1 as const;

const DEFAULT_TIMEOUT_MS = 15_000;
// A canonical payload may be 16 MiB before the E2EE module adds its JSON/base64url
// envelope. The repository then base64-encodes that opaque envelope for PostgREST.
export const MAX_ENCRYPTED_ENVELOPE_BYTES = 24 * 1024 * 1024;
export const MAX_VAULT_RESPONSE_BYTES = 36 * 1024 * 1024;
export const MIN_ENCRYPTED_ENVELOPE_BYTES = 17;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_HISTORY_OBJECTS = 16;
const SESSION_BOUND_RPCS = new Set([
  'rpc/rv_bootstrap_workspace',
  'rpc/rv_register_device',
  'rpc/rv_upload_vault_generation',
  'rpc/rv_list_workspaces',
  'rpc/rv_read_generation_object',
  'rpc/rv_read_active_generation',
  'rpc/rv_read_generation_history',
]);
const READ_ONLY_RPCS = new Set([
  'rpc/rv_list_workspaces',
  'rpc/rv_read_generation_object',
  'rpc/rv_read_active_generation',
  'rpc/rv_read_generation_history',
]);

export type VaultRepositoryErrorCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'INVALID_ARGUMENT'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'REMOTE_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'INTEGRITY_FAILURE';

export type VaultOperationOutcome = 'NOT_APPLIED' | 'UNKNOWN' | null;

export class VaultRepositoryError extends Error {
  readonly code: VaultRepositoryErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly outcome: VaultOperationOutcome;

  constructor(
    code: VaultRepositoryErrorCode,
    options: Readonly<{
      status?: number | null;
      cause?: unknown;
      retryable?: boolean;
      outcome?: VaultOperationOutcome;
    }> = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VaultRepositoryError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.outcome = options.outcome ?? null;
  }
}

export type VaultOperationOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type VaultWorkspace = Readonly<{
  workspaceId: string;
  signingAlgorithm: typeof VAULT_SIGNING_ALGORITHM;
  signingPublicKey: string;
  createdAt: string;
  head: VaultHead | null;
}>;

export type VaultHead = Readonly<{
  workspaceId: string;
  objectId: string;
  generation: number;
  updatedAt: string;
}>;

export type VaultDevice = Readonly<{
  workspaceId: string;
  deviceId: string;
  createdAt: string;
}>;

export type VaultObject = Readonly<{
  workspaceId: string;
  objectId: string;
  generation: number;
  envelopeVersion: typeof VAULT_ENVELOPE_VERSION;
  ciphertextSha256: string;
  signature: string;
  parentObjectId: string | null;
  parentCiphertextSha256: string | null;
  createdByDeviceId: string;
  createdAt: string;
  encryptedEnvelope: Uint8Array;
}>;

export type ActiveVaultGeneration = Readonly<{
  head: VaultHead;
  object: VaultObject;
}>;

export type BootstrapWorkspaceInput = Readonly<{
  workspaceId: string;
  signingAlgorithm: typeof VAULT_SIGNING_ALGORITHM;
  signingPublicKey: string;
  writeCapability: string;
}>;

export type ListWorkspacesOptions = VaultOperationOptions & Readonly<{
  limit?: number;
}>;

export type RegisterDeviceInput = Readonly<{
  workspaceId: string;
  deviceId: string;
  writeCapability: string;
}>;

export type UploadVaultGenerationInput = Readonly<{
  workspaceId: string;
  deviceId: string;
  generation: number;
  encryptedEnvelope: Uint8Array | ArrayBuffer;
  envelopeVersion?: typeof VAULT_ENVELOPE_VERSION;
  objectId: string;
  ciphertextSha256: string;
  signature: string;
  parentObjectId: string | null;
  parentCiphertextSha256: string | null;
  writeCapability: string;
}>;

export type PublishVaultHeadInput = Readonly<{
  workspaceId: string;
  objectId: string;
  expectedGeneration: number;
}>;

export interface VaultRepository {
  bootstrapWorkspace(
    input: BootstrapWorkspaceInput,
    options?: VaultOperationOptions,
  ): Promise<VaultWorkspace>;
  listWorkspaces(options?: ListWorkspacesOptions): Promise<readonly VaultWorkspace[]>;
  registerDevice(
    input: RegisterDeviceInput,
    options?: VaultOperationOptions,
  ): Promise<VaultDevice>;
  uploadGeneration(
    input: UploadVaultGenerationInput,
    options?: VaultOperationOptions,
  ): Promise<Omit<VaultObject, 'encryptedEnvelope'>>;
  readGenerationObject(
    workspaceId: string,
    objectId: string,
    options?: VaultOperationOptions,
  ): Promise<VaultObject | null>;
  publishHead(
    input: PublishVaultHeadInput,
    options?: VaultOperationOptions,
  ): Promise<VaultHead>;
  readActiveGeneration(
    workspaceId: string,
    options?: VaultOperationOptions,
  ): Promise<ActiveVaultGeneration | null>;
  readGenerationHistory(
    workspaceId: string,
    options?: VaultOperationOptions & Readonly<{ limit?: number }>,
  ): Promise<readonly VaultObject[]>;
}

type FetchLike = typeof fetch;

type RequestAuthSession = {
  accessToken?: Promise<string | null>;
};

export type SupabaseVaultRepositoryOptions = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
  getAccessToken: () => string | null | Promise<string | null>;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxEnvelopeBytes?: number;
  maxResponseBytes?: number;
}>;

type RequestJsonOptions = VaultOperationOptions & Readonly<{
  method?: 'GET' | 'POST';
  body?: unknown;
  prefer?: string;
  authSession?: RequestAuthSession;
  deadlineAt?: number;
  namespace?: 'rest' | 'functions';
}>;

type AbortKind = 'external' | 'timeout' | null;

function fail(code: VaultRepositoryErrorCode, status?: number | null, cause?: unknown): never {
  throw new VaultRepositoryError(code, { status, cause });
}

function requireUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} must be a UUID`));
  }
  return value.toLowerCase();
}

function requireGeneration(value: number, field: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} must be a safe integer >= ${minimum}`));
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} must be a positive safe integer`));
  }
  return value;
}

function requireSha256Hex(value: string, field: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} must be 64 lowercase hex characters`));
  }
  return value;
}

function requireWriteCapability(value: string): string {
  return requireSha256Hex(value, 'writeCapability');
}

function requireBase64Url(value: string, field: string, maxCharacters = 1024): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxCharacters
    || !BASE64URL_PATTERN.test(value)
  ) fail('INVALID_ARGUMENT', null, new Error(`${field} must be unpadded base64url`));
  return value;
}

function asBytes(value: Uint8Array | ArrayBuffer, field: string, maxBytes: number): Uint8Array {
  const isUint8 = ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]';
  const isArrayBuffer = Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  if (!isUint8 && !isArrayBuffer) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} must be bytes`));
  }
  const byteLength = value.byteLength;
  if (byteLength === 0) fail('INVALID_ARGUMENT', null, new Error(`${field} is empty`));
  if (byteLength > maxBytes) fail('PAYLOAD_TOO_LARGE');
  if (isUint8) {
    const source = value as Uint8Array;
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    return bytes;
  }
  const source = new Uint8Array(value as ArrayBuffer);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

function asBytesInRange(
  value: Uint8Array | ArrayBuffer,
  field: string,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array {
  const bytes = asBytes(value, field, maximumBytes);
  if (bytes.byteLength < minimumBytes) {
    fail('INVALID_ARGUMENT', null, new Error(`${field} is too short`));
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkLength = 32_766;
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkLength) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkLength, bytes.byteLength));
    let binary = '';
    for (let index = 0; index < chunk.byteLength; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
    encoded.push(btoa(binary));
  }
  return encoded.join('');
}

function decodeBase64(value: unknown, minimumBytes: number, maxBytes: number): Uint8Array {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) fail('INVALID_RESPONSE');
  const estimatedBytes = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (estimatedBytes < minimumBytes) fail('INVALID_RESPONSE');
  if (estimatedBytes > maxBytes) fail('RESPONSE_TOO_LARGE');
  try {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
    return result;
  } catch (error) {
    fail('INVALID_RESPONSE', null, error);
  }
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[1].length / 4) * 4,
      '=',
    );
    const payload = JSON.parse(atob(base64)) as unknown;
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch (_error) {
    return null;
  }
}

function jwtRole(token: string): string | null {
  const role = jwtPayload(token)?.role;
  return typeof role === 'string' ? role : null;
}

function jwtSessionId(token: string): string | null {
  const sessionId = jwtPayload(token)?.session_id;
  return typeof sessionId === 'string' && UUID_PATTERN.test(sessionId)
    ? sessionId.toLowerCase()
    : null;
}

function validatePublishableKey(key: string): string {
  if (
    typeof key !== 'string'
    || key.trim() !== key
    || key.length < 8
    || key.length > 16_384
    || /\s/.test(key)
  ) {
    fail('INVALID_ARGUMENT', null, new Error('publishableKey is invalid'));
  }
  const role = jwtRole(key);
  if (/^sb_secret_/i.test(key) || /service[_-]?role/i.test(key) || role === 'service_role') {
    fail('FORBIDDEN', null, new Error('service credentials are prohibited in the browser'));
  }
  if (!/^sb_publishable_/i.test(key) && role !== 'anon') {
    fail('INVALID_ARGUMENT', null, new Error('only a Supabase publishable/anon key is accepted'));
  }
  return key;
}

function parseIsoTimestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) fail('INVALID_RESPONSE');
  return value;
}

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail('INVALID_RESPONSE');
  return value.toLowerCase();
}

function parseGeneration(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_RESPONSE');
  return number;
}

function parseSha256Hex(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) fail('INVALID_RESPONSE');
  return value;
}

function parseBase64Url(value: unknown, maxCharacters = 1024): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxCharacters
    || !BASE64URL_PATTERN.test(value)
  ) fail('INVALID_RESPONSE');
  return value;
}

function parseWorkspaceRow(value: unknown): Omit<VaultWorkspace, 'head'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  return Object.freeze({
    workspaceId: parseUuid(row.workspace_id),
    signingAlgorithm: row.signing_algorithm === VAULT_SIGNING_ALGORITHM
      ? VAULT_SIGNING_ALGORITHM
      : fail('INVALID_RESPONSE'),
    signingPublicKey: parseBase64Url(row.signing_public_key),
    createdAt: parseIsoTimestamp(row.created_at),
  });
}

function parseHeadRow(value: unknown): VaultHead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  return Object.freeze({
    workspaceId: parseUuid(row.workspace_id),
    objectId: parseUuid(row.object_id),
    generation: parseGeneration(row.generation),
    updatedAt: parseIsoTimestamp(row.updated_at),
  });
}

function parseDeviceRow(value: unknown): VaultDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  return Object.freeze({
    workspaceId: parseUuid(row.workspace_id),
    deviceId: parseUuid(row.device_id),
    createdAt: parseIsoTimestamp(row.created_at),
  });
}

function parseObjectMetadata(value: unknown): Omit<VaultObject, 'encryptedEnvelope'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
  const row = value as Record<string, unknown>;
  if (Number(row.envelope_version) !== VAULT_ENVELOPE_VERSION) fail('INVALID_RESPONSE');
  const generation = parseGeneration(row.generation);
  const parentObjectId = row.parent_object_id === null ? null : parseUuid(row.parent_object_id);
  const parentCiphertextSha256 = row.parent_ciphertext_sha256 === null
    ? null
    : parseSha256Hex(row.parent_ciphertext_sha256);
  if ((parentObjectId === null) !== (parentCiphertextSha256 === null)) fail('INVALID_RESPONSE');
  if ((generation === 1) !== (parentObjectId === null)) fail('INVALID_RESPONSE');
  return Object.freeze({
    workspaceId: parseUuid(row.workspace_id),
    objectId: parseUuid(row.object_id),
    generation,
    envelopeVersion: VAULT_ENVELOPE_VERSION,
    ciphertextSha256: parseSha256Hex(row.ciphertext_sha256),
    signature: parseBase64Url(row.signature, 128),
    parentObjectId,
    parentCiphertextSha256,
    createdByDeviceId: parseUuid(row.created_by_device_id),
    createdAt: parseIsoTimestamp(row.created_at),
  });
}

function asRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_RESPONSE');
  return value;
}

function firstRpcRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length !== 1) fail('INVALID_RESPONSE');
    return value[0];
  }
  if (!value || typeof value !== 'object') fail('INVALID_RESPONSE');
  return value;
}

function parseMutationResult<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof VaultRepositoryError) {
      throw new VaultRepositoryError(error.code, {
        status: error.status,
        cause: error,
        retryable: false,
        outcome: 'UNKNOWN',
      });
    }
    throw error;
  }
}

function errorCodeFromStatus(status: number, body: unknown): VaultRepositoryErrorCode {
  const remoteCode = (
    body && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>).code ?? '')
      : ''
  ).toUpperCase();
  const remoteMessage = (
    body && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>).message ?? '')
      : ''
  ).toUpperCase();
  if (['P0002', 'PGRST116'].includes(remoteCode)) return 'NOT_FOUND';
  if (remoteCode === 'P0003') return 'AUTH_REQUIRED';
  if (remoteCode === 'P0004' || remoteCode === 'P0005') return 'RATE_LIMITED';
  if (remoteCode === '42501') return status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN';
  if (
    ['23505', '40001', 'VAULT_HEAD_CONFLICT', 'RV_CAS_CONFLICT'].includes(remoteCode)
    || /(?:CAS|HEAD|GENERATION).*(?:CONFLICT|STALE)/.test(remoteMessage)
  ) return 'CONFLICT';
  if (status === 400 || status === 422) return 'INVALID_ARGUMENT';
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409 || status === 412) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  return 'REMOTE_UNAVAILABLE';
}

function abortError(
  kind: AbortKind,
  options: Readonly<{ isRead?: boolean; dispatched?: boolean }> = {},
): VaultRepositoryError {
  const isTimeout = kind === 'timeout';
  const dispatchedMutation = options.dispatched === true && options.isRead !== true;
  return new VaultRepositoryError(isTimeout ? 'TIMEOUT' : 'ABORTED', {
    retryable: isTimeout && (options.isRead === true || options.dispatched !== true),
    outcome: dispatchedMutation ? 'UNKNOWN' : 'NOT_APPLIED',
  });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      fail('RESPONSE_TOO_LARGE');
    }
  }
  if (!response.body?.getReader) {
    const text = await abortable(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maxBytes) fail('RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch (error) {
    fail('INVALID_RESPONSE', null, error);
  }
}

export class SupabaseVaultRepository implements VaultRepository {
  private readonly baseUrl: string;
  private readonly publishableKey: string;
  private readonly getAccessToken: SupabaseVaultRepositoryOptions['getAccessToken'];
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxEnvelopeBytes: number;
  private readonly maxResponseBytes: number;

  constructor(options: SupabaseVaultRepositoryOptions) {
    let url: URL;
    try {
      url = new URL(options.supabaseUrl);
    } catch (error) {
      fail('INVALID_ARGUMENT', null, error);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      fail('INVALID_ARGUMENT', null, new Error('Supabase URL must use HTTPS'));
    }
    if (url.username || url.password || url.search || url.hash) fail('INVALID_ARGUMENT');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.publishableKey = validatePublishableKey(options.publishableKey);
    if (typeof options.getAccessToken !== 'function') fail('INVALID_ARGUMENT');
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') fail('INVALID_ARGUMENT');
    this.getAccessToken = options.getAccessToken;
    this.fetcher = fetcher.bind(globalThis);
    this.timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxEnvelopeBytes = requirePositiveInteger(
      options.maxEnvelopeBytes ?? MAX_ENCRYPTED_ENVELOPE_BYTES,
      'maxEnvelopeBytes',
    );
    if (this.maxEnvelopeBytes < MIN_ENCRYPTED_ENVELOPE_BYTES) fail('INVALID_ARGUMENT');
    this.maxResponseBytes = requirePositiveInteger(
      options.maxResponseBytes ?? MAX_VAULT_RESPONSE_BYTES,
      'maxResponseBytes',
    );
  }

  private operationBudget(
    options: VaultOperationOptions,
  ): () => VaultOperationOptions & Readonly<{
    authSession: RequestAuthSession;
    deadlineAt: number;
  }> {
    if (options.signal?.aborted) throw abortError('external');
    const timeoutMs = requirePositiveInteger(options.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    const deadline = Date.now() + timeoutMs;
    const authSession: RequestAuthSession = {};
    return () => {
      if (options.signal?.aborted) throw abortError('external');
      const remaining = Math.ceil(deadline - Date.now());
      if (remaining <= 0) {
        throw new VaultRepositoryError('TIMEOUT', {
          retryable: true,
          outcome: 'NOT_APPLIED',
        });
      }
      return {
        signal: options.signal,
        timeoutMs: remaining,
        authSession,
        deadlineAt: deadline,
      };
    };
  }

  private async requestJson(path: string, options: RequestJsonOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) throw abortError('external');
    const method = options.method ?? 'GET';
    const isRead = method === 'GET' || READ_ONLY_RPCS.has(path);
    const timeoutMs = requirePositiveInteger(options.timeoutMs ?? this.timeoutMs, 'timeoutMs');
    const controller = new AbortController();
    let abortKind: AbortKind = null;
    let dispatched = false;
    const onExternalAbort = () => {
      if (abortKind === null) abortKind = 'external';
      controller.abort();
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      if (abortKind === null) abortKind = 'timeout';
      controller.abort();
    }, timeoutMs);
    try {
      let accessToken: string | null;
      try {
        const authSession = options.authSession ?? {};
        authSession.accessToken ??= Promise.resolve().then(() => this.getAccessToken());
        accessToken = await abortable(authSession.accessToken, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw abortError(abortKind, { isRead, dispatched });
        fail('AUTH_REQUIRED', null, error);
      }
      if (
        typeof accessToken !== 'string'
        || accessToken.length < 8
        || accessToken.length > 16_384
        || /\s/.test(accessToken)
      ) fail('AUTH_REQUIRED');
      const accessRole = jwtRole(accessToken);
      if (accessRole === 'service_role' || /^sb_secret_/i.test(accessToken)) fail('FORBIDDEN');
      if (accessRole === 'anon') fail('AUTH_REQUIRED');

      const headers = new Headers({
        Accept: 'application/json',
        apikey: this.publishableKey,
        Authorization: `Bearer ${accessToken}`,
      });
      let body: string | undefined;
      if (options.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        let requestBody = options.body;
        if (SESSION_BOUND_RPCS.has(path)) {
          const sessionId = jwtSessionId(accessToken);
          if (!sessionId || !requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
            fail('AUTH_REQUIRED');
          }
          requestBody = { ...requestBody, p_session_id: sessionId };
        }
        body = JSON.stringify(requestBody);
      }
      if (options.prefer) headers.set('Prefer', options.prefer);
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw abortError('timeout', { isRead, dispatched: false });
      }
      dispatched = true;
      const namespace = options.namespace ?? 'rest';
      const response = await abortable(this.fetcher(
        `${this.baseUrl}/${namespace === 'rest' ? 'rest/v1' : 'functions/v1'}/${path}`,
        {
          method,
          headers,
          body,
          signal: controller.signal,
          credentials: 'omit',
        },
      ), controller.signal);
      const responseText = await readResponseText(response, this.maxResponseBytes, controller.signal);
      let parsed: unknown = null;
      if (responseText !== '') {
        try {
          parsed = JSON.parse(responseText);
        } catch (error) {
          fail('INVALID_RESPONSE', response.status, error);
        }
      }
      if (!response.ok) {
        const code = errorCodeFromStatus(response.status, parsed);
        const definitelyNotApplied = code !== 'REMOTE_UNAVAILABLE';
        throw new VaultRepositoryError(code, {
          status: response.status,
          retryable: code === 'RATE_LIMITED' || (isRead && code === 'REMOTE_UNAVAILABLE'),
          outcome: isRead || definitelyNotApplied ? 'NOT_APPLIED' : 'UNKNOWN',
        });
      }
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        throw abortError('timeout', { isRead, dispatched });
      }
      return parsed;
    } catch (error) {
      if (error instanceof VaultRepositoryError) {
        if (!isRead && dispatched && error.outcome === null) {
          throw new VaultRepositoryError(error.code, {
            status: error.status,
            cause: error,
            retryable: false,
            outcome: 'UNKNOWN',
          });
        }
        throw error;
      }
      if (controller.signal.aborted) throw abortError(abortKind, { isRead, dispatched });
      throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
        cause: error,
        retryable: isRead || !dispatched,
        outcome: !isRead && dispatched ? 'UNKNOWN' : 'NOT_APPLIED',
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async bootstrapWorkspace(
    input: BootstrapWorkspaceInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultWorkspace> {
    const budget = this.operationBudget(options);
    const requestedId = requireUuid(input.workspaceId, 'workspaceId');
    if (input.signingAlgorithm !== VAULT_SIGNING_ALGORITHM) fail('INVALID_ARGUMENT');
    const signingPublicKey = requireBase64Url(input.signingPublicKey, 'signingPublicKey');
    const writeCapability = requireWriteCapability(input.writeCapability);
    const raw = await this.requestJson('rpc/rv_bootstrap_workspace', {
      ...budget(),
      method: 'POST',
      body: {
        p_workspace_id: requestedId,
        p_signing_algorithm: VAULT_SIGNING_ALGORITHM,
        p_signing_public_key: signingPublicKey,
        p_write_capability: writeCapability,
      },
    });
    return parseMutationResult(() => {
      const workspace = parseWorkspaceRow(firstRpcRecord(raw));
      if (
        workspace.workspaceId !== requestedId
        || workspace.signingAlgorithm !== VAULT_SIGNING_ALGORITHM
        || workspace.signingPublicKey !== signingPublicKey
      ) fail('INTEGRITY_FAILURE');
      return Object.freeze({ ...workspace, head: null });
    });
  }

  async listWorkspaces(options: ListWorkspacesOptions = {}): Promise<readonly VaultWorkspace[]> {
    const budget = this.operationBudget(options);
    const limit = Math.min(requirePositiveInteger(options.limit ?? 100, 'limit'), 100);
    const raw = await this.requestJson('rpc/rv_list_workspaces', {
      ...budget(),
      method: 'POST',
      body: { p_limit: limit },
    });
    return Object.freeze(asRows(raw).map((value) => {
      const workspace = parseWorkspaceRow(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RESPONSE');
      const row = value as Record<string, unknown>;
      const headValues = [row.head_object_id, row.head_generation, row.head_updated_at];
      const nullHead = headValues.every((item) => item === null);
      if (!nullHead && headValues.some((item) => item === null || item === undefined)) {
        fail('INTEGRITY_FAILURE');
      }
      const head = nullHead ? null : parseHeadRow({
        workspace_id: row.workspace_id,
        object_id: row.head_object_id,
        generation: row.head_generation,
        updated_at: row.head_updated_at,
      });
      if (head && head.workspaceId !== workspace.workspaceId) fail('INTEGRITY_FAILURE');
      return Object.freeze({ ...workspace, head });
    }));
  }

  async registerDevice(
    input: RegisterDeviceInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultDevice> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(input.workspaceId, 'workspaceId');
    const deviceId = requireUuid(input.deviceId, 'deviceId');
    const writeCapability = requireWriteCapability(input.writeCapability);
    const raw = await this.requestJson(
      'rpc/rv_register_device', {
      ...budget(),
      method: 'POST',
      prefer: 'return=representation',
      body: {
        p_workspace_id: workspaceId,
        p_device_id: deviceId,
        p_write_capability: writeCapability,
      },
    });
    return parseMutationResult(() => {
      const rows = asRows(raw);
      if (rows.length !== 1) fail('INVALID_RESPONSE');
      const device = parseDeviceRow(rows[0]);
      if (device.workspaceId !== workspaceId || device.deviceId !== deviceId) {
        fail('INTEGRITY_FAILURE');
      }
      return device;
    });
  }

  async uploadGeneration(
    input: UploadVaultGenerationInput,
    options: VaultOperationOptions = {},
  ): Promise<Omit<VaultObject, 'encryptedEnvelope'>> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(input.workspaceId, 'workspaceId');
    const deviceId = requireUuid(input.deviceId, 'deviceId');
    const objectId = requireUuid(input.objectId, 'objectId');
    const generation = requireGeneration(input.generation, 'generation');
    const version = input.envelopeVersion ?? VAULT_ENVELOPE_VERSION;
    if (version !== VAULT_ENVELOPE_VERSION) fail('INVALID_ARGUMENT');
    const envelope = asBytesInRange(
      input.encryptedEnvelope,
      'encryptedEnvelope',
      MIN_ENCRYPTED_ENVELOPE_BYTES,
      this.maxEnvelopeBytes,
    );
    const ciphertext = encodeBase64(envelope);
    const ciphertextSha256 = requireSha256Hex(input.ciphertextSha256, 'ciphertextSha256');
    if (await sha256Hex(envelope) !== ciphertextSha256) fail('INTEGRITY_FAILURE');
    const signature = requireBase64Url(input.signature, 'signature', 128);
    const parentObjectId = input.parentObjectId === null
      ? null
      : requireUuid(input.parentObjectId, 'parentObjectId');
    const parentCiphertextSha256 = input.parentCiphertextSha256 === null
      ? null
      : requireSha256Hex(input.parentCiphertextSha256, 'parentCiphertextSha256');
    if ((parentObjectId === null) !== (parentCiphertextSha256 === null)) fail('INVALID_ARGUMENT');
    if ((generation === 1) !== (parentObjectId === null)) fail('INVALID_ARGUMENT');
    const writeCapability = requireWriteCapability(input.writeCapability);
    const requestOptions = budget();
    const raw = await this.requestJson(
      'rpc/rv_upload_vault_generation', {
      ...requestOptions,
      method: 'POST',
      prefer: 'return=representation',
      body: {
        p_workspace_id: workspaceId,
        p_device_id: deviceId,
        p_object_id: objectId,
        p_generation: generation,
        p_envelope_version: version,
        p_ciphertext: ciphertext,
        p_ciphertext_sha256: ciphertextSha256,
        p_signature: signature,
        p_parent_object_id: parentObjectId,
        p_parent_ciphertext_sha256: parentCiphertextSha256,
        p_write_capability: writeCapability,
      },
    });
    return parseMutationResult(() => {
      const rows = asRows(raw);
      if (rows.length !== 1) fail('INVALID_RESPONSE');
      const metadata = parseObjectMetadata(rows[0]);
      if (
        metadata.workspaceId !== workspaceId
        || metadata.objectId !== objectId
        || metadata.generation !== generation
        || metadata.envelopeVersion !== version
        || metadata.ciphertextSha256 !== ciphertextSha256
        || metadata.signature !== signature
        || metadata.parentObjectId !== parentObjectId
        || metadata.parentCiphertextSha256 !== parentCiphertextSha256
        || metadata.createdByDeviceId !== deviceId
      ) fail('INTEGRITY_FAILURE');
      return metadata;
    });
  }

  async readGenerationObject(
    workspaceIdInput: string,
    objectIdInput: string,
    options: VaultOperationOptions = {},
  ): Promise<VaultObject | null> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(workspaceIdInput, 'workspaceId');
    const objectId = requireUuid(objectIdInput, 'objectId');
    const raw = await this.requestJson('rpc/rv_read_generation_object', {
      ...budget(),
      method: 'POST',
      body: {
        p_workspace_id: workspaceId,
        p_object_id: objectId,
      },
    });
    const rows = asRows(raw);
    if (rows.length === 0) return null;
    if (rows.length !== 1) fail('INTEGRITY_FAILURE');
    const metadata = parseObjectMetadata(rows[0]);
    if (metadata.workspaceId !== workspaceId || metadata.objectId !== objectId) {
      fail('INTEGRITY_FAILURE');
    }
    const row = rows[0] as Record<string, unknown>;
    return Object.freeze({
      ...metadata,
      encryptedEnvelope: decodeBase64(
        row.ciphertext,
        MIN_ENCRYPTED_ENVELOPE_BYTES,
        this.maxEnvelopeBytes,
      ),
    });
  }

  async publishHead(
    input: PublishVaultHeadInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultHead> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(input.workspaceId, 'workspaceId');
    const objectId = requireUuid(input.objectId, 'objectId');
    const expectedGeneration = requireGeneration(input.expectedGeneration, 'expectedGeneration', true);
    const raw = await this.requestJson('publish-vault-head', {
      ...budget(),
      method: 'POST',
      namespace: 'functions',
      body: {
        protocolVersion: VAULT_PUBLISH_PROTOCOL_VERSION,
        workspaceId,
        objectId,
        expectedGeneration,
      },
    });
    return parseMutationResult(() => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_RESPONSE');
      const response = raw as Record<string, unknown>;
      if (response.protocolVersion !== VAULT_PUBLISH_PROTOCOL_VERSION) fail('INVALID_RESPONSE');
      const head = Object.freeze({
        workspaceId: parseUuid(response.workspaceId),
        objectId: parseUuid(response.objectId),
        generation: parseGeneration(response.generation),
        updatedAt: parseIsoTimestamp(response.updatedAt),
      });
      if (
        head.workspaceId !== workspaceId
        || head.objectId !== objectId
        || head.generation !== expectedGeneration + 1
      ) fail('INTEGRITY_FAILURE');
      return head;
    });
  }

  async readActiveGeneration(
    workspaceIdInput: string,
    options: VaultOperationOptions = {},
  ): Promise<ActiveVaultGeneration | null> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(workspaceIdInput, 'workspaceId');
    const raw = await this.requestJson('rpc/rv_read_active_generation', {
      ...budget(),
      method: 'POST',
      body: { p_workspace_id: workspaceId },
    });
    const rows = asRows(raw);
    if (rows.length === 0) return null;
    if (rows.length !== 1) fail('INTEGRITY_FAILURE');
    if (!rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) fail('INVALID_RESPONSE');
    const row = rows[0] as Record<string, unknown>;
    const head = parseHeadRow({
      workspace_id: row.workspace_id,
      object_id: row.object_id,
      generation: row.generation,
      updated_at: row.head_updated_at,
    });
    const metadata = parseObjectMetadata(row);
    if (
      metadata.workspaceId !== head.workspaceId
      || metadata.objectId !== head.objectId
      || metadata.generation !== head.generation
    ) fail('INTEGRITY_FAILURE');
    return Object.freeze({
      head,
      object: Object.freeze({
        ...metadata,
        encryptedEnvelope: decodeBase64(
          row.ciphertext,
          MIN_ENCRYPTED_ENVELOPE_BYTES,
          this.maxEnvelopeBytes,
        ),
      }),
    });
  }

  async readGenerationHistory(
    workspaceIdInput: string,
    options: VaultOperationOptions & Readonly<{ limit?: number }> = {},
  ): Promise<readonly VaultObject[]> {
    const budget = this.operationBudget(options);
    const workspaceId = requireUuid(workspaceIdInput, 'workspaceId');
    const limit = Math.min(requirePositiveInteger(options.limit ?? 8, 'limit'), MAX_HISTORY_OBJECTS);
    const raw = await this.requestJson('rpc/rv_read_generation_history', {
      ...budget(),
      method: 'POST',
      body: {
        p_workspace_id: workspaceId,
        p_limit: limit,
      },
    });
    return Object.freeze(asRows(raw).map((value) => {
      const metadata = parseObjectMetadata(value);
      if (metadata.workspaceId !== workspaceId) fail('INTEGRITY_FAILURE');
      const row = value as Record<string, unknown>;
      parseIsoTimestamp(row.committed_at);
      return Object.freeze({
        ...metadata,
        encryptedEnvelope: decodeBase64(
          row.ciphertext,
          MIN_ENCRYPTED_ENVELOPE_BYTES,
          this.maxEnvelopeBytes,
        ),
      });
    }));
  }

}

type MemoryObjectState = Readonly<{
  metadata: Omit<VaultObject, 'encryptedEnvelope'>;
  envelope: Uint8Array;
}>;

type MemoryWorkspaceState = {
  workspace: Omit<VaultWorkspace, 'head'>;
  writeCapabilityHash: string;
  devices: Map<string, VaultDevice>;
  objects: Map<string, MemoryObjectState>;
  committedObjectIds: string[];
  head: VaultHead | null;
};

/** Shared test backend. Identity is supplied once when a repository session is created, never per call. */
export class MemoryVaultBackend {
  readonly users = new Map<string, Map<string, MemoryWorkspaceState>>();
}

export type MemoryVaultRepositoryOptions = Readonly<{
  subject: string;
  backend?: MemoryVaultBackend;
  operationDelayMs?: number;
  now?: () => Date;
}>;

function memoryAbortCheck(options: VaultOperationOptions): void {
  if (options.signal?.aborted) throw abortError('external');
}

async function memoryDelay(delayMs: number, options: VaultOperationOptions): Promise<void> {
  memoryAbortCheck(options);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) requirePositiveInteger(timeoutMs, 'timeoutMs');
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let completed = false;
    const finish = (error?: VaultRepositoryError) => {
      if (completed) return;
      completed = true;
      clearTimeout(delayTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError('external'));
    const delayTimer = setTimeout(() => finish(), delayMs);
    const timeoutTimer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => finish(abortError('timeout')), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MemoryVaultRepository implements VaultRepository {
  private readonly subject: string;
  private readonly backend: MemoryVaultBackend;
  private readonly operationDelayMs: number;
  private readonly now: () => Date;

  constructor(options: MemoryVaultRepositoryOptions) {
    if (typeof options.subject !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(options.subject)) {
      fail('INVALID_ARGUMENT');
    }
    if (!Number.isSafeInteger(options.operationDelayMs ?? 0) || (options.operationDelayMs ?? 0) < 0) {
      fail('INVALID_ARGUMENT');
    }
    this.subject = options.subject;
    this.backend = options.backend ?? new MemoryVaultBackend();
    this.operationDelayMs = options.operationDelayMs ?? 0;
    this.now = options.now ?? (() => new Date());
  }

  private user(create = false): Map<string, MemoryWorkspaceState> | undefined {
    let user = this.backend.users.get(this.subject);
    if (!user && create) {
      user = new Map();
      this.backend.users.set(this.subject, user);
    }
    return user;
  }

  private workspace(workspaceIdInput: string): MemoryWorkspaceState {
    const workspaceId = requireUuid(workspaceIdInput, 'workspaceId');
    const workspace = this.user()?.get(workspaceId);
    if (!workspace) fail('NOT_FOUND', 404);
    return workspace;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async bootstrapWorkspace(
    input: BootstrapWorkspaceInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultWorkspace> {
    await memoryDelay(this.operationDelayMs, options);
    const workspaceId = requireUuid(input.workspaceId, 'workspaceId');
    if (input.signingAlgorithm !== VAULT_SIGNING_ALGORITHM) fail('INVALID_ARGUMENT');
    const signingPublicKey = requireBase64Url(input.signingPublicKey, 'signingPublicKey');
    const writeCapability = requireWriteCapability(input.writeCapability);
    const writeCapabilityHash = await sha256Hex(new TextEncoder().encode(writeCapability));
    const user = this.user(true)!;
    let state = user.get(workspaceId);
    if (!state) {
      state = {
        workspace: Object.freeze({
          workspaceId,
          signingAlgorithm: VAULT_SIGNING_ALGORITHM,
          signingPublicKey,
          createdAt: this.timestamp(),
        }),
        writeCapabilityHash,
        devices: new Map(),
        objects: new Map(),
        committedObjectIds: [],
        head: null,
      };
      user.set(workspaceId, state);
    } else if (
      state.workspace.signingAlgorithm !== VAULT_SIGNING_ALGORITHM
      || state.workspace.signingPublicKey !== signingPublicKey
      || state.writeCapabilityHash !== writeCapabilityHash
    ) {
      fail('CONFLICT', 409);
    }
    return Object.freeze({ ...state.workspace, head: state.head });
  }

  async listWorkspaces(options: ListWorkspacesOptions = {}): Promise<readonly VaultWorkspace[]> {
    await memoryDelay(this.operationDelayMs, options);
    const limit = Math.min(requirePositiveInteger(options.limit ?? 100, 'limit'), 100);
    const rows = [...(this.user()?.values() ?? [])]
      .sort((left, right) => right.workspace.createdAt.localeCompare(left.workspace.createdAt))
      .slice(0, limit)
      .map((state) => Object.freeze({ ...state.workspace, head: state.head }));
    return Object.freeze(rows);
  }

  async registerDevice(
    input: RegisterDeviceInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultDevice> {
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(input.workspaceId);
    const deviceId = requireUuid(input.deviceId, 'deviceId');
    const capabilityHash = await sha256Hex(
      new TextEncoder().encode(requireWriteCapability(input.writeCapability)),
    );
    if (capabilityHash !== workspace.writeCapabilityHash) fail('FORBIDDEN', 403);
    if (workspace.devices.has(deviceId)) fail('CONFLICT', 409);
    const device = Object.freeze({
      workspaceId: workspace.workspace.workspaceId,
      deviceId,
      createdAt: this.timestamp(),
    });
    workspace.devices.set(deviceId, device);
    return device;
  }

  async uploadGeneration(
    input: UploadVaultGenerationInput,
    options: VaultOperationOptions = {},
  ): Promise<Omit<VaultObject, 'encryptedEnvelope'>> {
    memoryAbortCheck(options);
    const workspaceId = requireUuid(input.workspaceId, 'workspaceId');
    const deviceId = requireUuid(input.deviceId, 'deviceId');
    const objectId = requireUuid(input.objectId, 'objectId');
    const generation = requireGeneration(input.generation, 'generation');
    if ((input.envelopeVersion ?? VAULT_ENVELOPE_VERSION) !== VAULT_ENVELOPE_VERSION) {
      fail('INVALID_ARGUMENT');
    }
    const envelope = asBytesInRange(
      input.encryptedEnvelope,
      'encryptedEnvelope',
      MIN_ENCRYPTED_ENVELOPE_BYTES,
      MAX_ENCRYPTED_ENVELOPE_BYTES,
    );
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(workspaceId);
    const capabilityHash = await sha256Hex(
      new TextEncoder().encode(requireWriteCapability(input.writeCapability)),
    );
    if (capabilityHash !== workspace.writeCapabilityHash) fail('FORBIDDEN', 403);
    if (!workspace.devices.has(deviceId)) fail('NOT_FOUND', 404);
    if (workspace.objects.has(objectId)) fail('CONFLICT', 409);
    const ciphertextSha256 = requireSha256Hex(input.ciphertextSha256, 'ciphertextSha256');
    if (await sha256Hex(envelope) !== ciphertextSha256) fail('INTEGRITY_FAILURE');
    const signature = requireBase64Url(input.signature, 'signature', 128);
    const parentObjectId = input.parentObjectId === null
      ? null
      : requireUuid(input.parentObjectId, 'parentObjectId');
    const parentCiphertextSha256 = input.parentCiphertextSha256 === null
      ? null
      : requireSha256Hex(input.parentCiphertextSha256, 'parentCiphertextSha256');
    if ((parentObjectId === null) !== (parentCiphertextSha256 === null)) fail('INVALID_ARGUMENT');
    if ((generation === 1) !== (parentObjectId === null)) fail('INVALID_ARGUMENT');
    if (generation > 1) {
      const parent = parentObjectId ? workspace.objects.get(parentObjectId) : null;
      if (
        !parent
        || parent.metadata.generation !== generation - 1
        || parent.metadata.ciphertextSha256 !== parentCiphertextSha256
      ) fail('CONFLICT', 409);
    }
    const signatureValid = await verifyVaultObjectSignature(
      workspace.workspace.signingPublicKey,
      {
        userId: this.subject,
        workspaceId,
        objectId,
        generation,
        envelopeVersion: VAULT_ENVELOPE_VERSION,
        ciphertextSha256,
        parentObjectId,
        parentCiphertextSha256,
      },
      signature,
    );
    if (!signatureValid) fail('FORBIDDEN', 403);
    const metadata = Object.freeze({
      workspaceId,
      objectId,
      generation,
      envelopeVersion: VAULT_ENVELOPE_VERSION,
      ciphertextSha256,
      signature,
      parentObjectId,
      parentCiphertextSha256,
      createdByDeviceId: deviceId,
      createdAt: this.timestamp(),
    });
    workspace.objects.set(objectId, Object.freeze({ metadata, envelope }));
    return metadata;
  }

  async readGenerationObject(
    workspaceIdInput: string,
    objectIdInput: string,
    options: VaultOperationOptions = {},
  ): Promise<VaultObject | null> {
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(workspaceIdInput);
    const objectId = requireUuid(objectIdInput, 'objectId');
    const object = workspace.objects.get(objectId);
    if (!object) return null;
    return Object.freeze({
      ...object.metadata,
      encryptedEnvelope: new Uint8Array(object.envelope),
    });
  }

  async publishHead(
    input: PublishVaultHeadInput,
    options: VaultOperationOptions = {},
  ): Promise<VaultHead> {
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(input.workspaceId);
    const objectId = requireUuid(input.objectId, 'objectId');
    const expectedGeneration = requireGeneration(input.expectedGeneration, 'expectedGeneration', true);
    const currentGeneration = workspace.head?.generation ?? 0;
    if (currentGeneration !== expectedGeneration) fail('CONFLICT', 409);
    const object = workspace.objects.get(objectId);
    if (!object) fail('NOT_FOUND', 404);
    if (object.metadata.generation !== expectedGeneration + 1) fail('INVALID_ARGUMENT');
    if (expectedGeneration === 0) {
      if (object.metadata.parentObjectId !== null || object.metadata.parentCiphertextSha256 !== null) {
        fail('INTEGRITY_FAILURE');
      }
    } else if (
      object.metadata.parentObjectId !== workspace.head?.objectId
      || object.metadata.parentCiphertextSha256
        !== workspace.objects.get(workspace.head?.objectId ?? '')?.metadata.ciphertextSha256
    ) {
      fail('CONFLICT', 409);
    }
    const head = Object.freeze({
      workspaceId: workspace.workspace.workspaceId,
      objectId,
      generation: object.metadata.generation,
      updatedAt: this.timestamp(),
    });
    workspace.head = head;
    workspace.committedObjectIds.push(objectId);
    return head;
  }

  async readActiveGeneration(
    workspaceIdInput: string,
    options: VaultOperationOptions = {},
  ): Promise<ActiveVaultGeneration | null> {
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(workspaceIdInput);
    if (!workspace.head) return null;
    const object = workspace.objects.get(workspace.head.objectId);
    if (!object || object.metadata.generation !== workspace.head.generation) fail('INTEGRITY_FAILURE');
    return Object.freeze({
      head: workspace.head,
      object: Object.freeze({
        ...object.metadata,
        encryptedEnvelope: new Uint8Array(object.envelope),
      }),
    });
  }

  async readGenerationHistory(
    workspaceIdInput: string,
    options: VaultOperationOptions & Readonly<{ limit?: number }> = {},
  ): Promise<readonly VaultObject[]> {
    await memoryDelay(this.operationDelayMs, options);
    const workspace = this.workspace(workspaceIdInput);
    const limit = Math.min(requirePositiveInteger(options.limit ?? 8, 'limit'), MAX_HISTORY_OBJECTS);
    return Object.freeze([...workspace.committedObjectIds]
      .reverse()
      .slice(0, limit)
      .map((objectId) => {
        const object = workspace.objects.get(objectId);
        if (!object) fail('INTEGRITY_FAILURE');
        return Object.freeze({
          ...object.metadata,
          encryptedEnvelope: new Uint8Array(object.envelope),
        });
      }));
  }

}
