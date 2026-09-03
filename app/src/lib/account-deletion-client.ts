import { SupabaseAuthClient } from './auth-client';
import type { ProductionConfig } from './production-config';

const DELETION_PROTOCOL_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
// Keep validation slightly wider than the exported-file window so an exact
// boundary reports the specific expiry code instead of a generic invalid one.
const RECOVERY_MAX_AGE_GRACE_MS = 1;
const RECOVERY_STORAGE_KEY = 'rv-account-deletion-recovery-v2';
const WORKSPACE_RECOVERY_STORAGE_KEY = 'rv-workspace-deletion-recovery-v3';
const BUSINESS_RECOVERY_STORAGE_KEY = 'rv-business-deletion-recovery-v3';
const TOMBSTONE_STORAGE_KEY = 'rv-account-deletion-tombstone-v2';
const TOMBSTONE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_SECRET_PATTERN = /^rvr1_[A-Za-z0-9_-]{43}$/;

export const ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES = 1024;
export const ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS = 5 * 60 * 1000;
export const ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS = 15_000;
// Mirrored by a contract test against the Edge constant. This is not a claim
// about provider or public-network routing latency.
export const ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS = 10_000;
export const ACCOUNT_DELETION_SERVER_STATUS_TTL_MS = 3_600_000;
// A pre-delete file cannot contain the server's eventual expiresAt. Keep it
// locally parseable through every product-controlled deadline that can precede
// and follow row creation. Once the server answers, its expiresAt/410 response
// is authoritative; this local envelope never extends the server capability.
export const ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS =
  ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS
  + ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS
  + ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS
  + ACCOUNT_DELETION_SERVER_STATUS_TTL_MS;
const RECOVERY_MAX_AGE_MS =
  ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS + RECOVERY_MAX_AGE_GRACE_MS;
export const ACCOUNT_DELETION_RECOVERY_FILE_NAME = 'review-workbench-account-deletion-recovery-v1.json';

export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE_MY_ACCOUNT';
export const DELETE_WORKSPACE_CONFIRMATION = 'DELETE_THIS_WORKSPACE';
export const CLEAR_BUSINESS_CONFIRMATION = 'DELETE_MY_REVIEW_DATA';

export class AccountDeletionClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

type AccountDeletionClientOptions = Readonly<{
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}>;

function validClientTimeout(timeoutMs: number): number {
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS
  ) {
    throw new AccountDeletionClientError(
      'CONFIG_INVALID',
      `账户删除请求超时必须是 1 到 ${ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS} 毫秒的整数`,
    );
  }
  return timeoutMs;
}

export type AccountDeletionProof = Readonly<{
  accessToken: string;
  expiresAt: number;
  userId: string;
  email: string | null;
}>;

export type AccountDeletionRecovery = Readonly<{
  requestId: string;
  recoverySecret: string;
  subjectHint: string;
  createdAt: number;
}>;

export type AccountDeletionRecoveryFile = Readonly<{
  version: 1;
  operation: 'delete_account';
  requestId: string;
  recoverySecret: string;
  subjectHint: string;
  createdAt: number;
}>;

export type WorkspaceDeletionRecovery = Readonly<AccountDeletionRecovery & {
  workspaceId: string;
}>;

export type BusinessDeletionRecovery = AccountDeletionRecovery;

export type AccountDeletionTombstone = Readonly<{
  receiptId: string;
  completedAt: number;
}>;

export type AccountDeletionState = Readonly<{
  state: 'pending' | 'deleting' | 'completed';
  receiptId: string | null;
  expiresAt: string;
}>;

export type AccountDeletionReceipt = Readonly<{
  state: 'completed';
  receiptId: string;
  expiresAt: string;
}>;

export type WorkspaceDeletionReceipt = AccountDeletionReceipt;
export type BusinessDeletionReceipt = AccountDeletionReceipt;

type RecoveryEntropy = Readonly<{
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
}>;

function validRecovery(value: unknown, now = Date.now()): value is AccountDeletionRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'createdAt,recoverySecret,requestId,subjectHint'
    && typeof row.requestId === 'string'
    && UUID_V4_PATTERN.test(row.requestId)
    && typeof row.recoverySecret === 'string'
    && RECOVERY_SECRET_PATTERN.test(row.recoverySecret)
    && typeof row.subjectHint === 'string'
    && UUID_PATTERN.test(row.subjectHint)
    && Number.isSafeInteger(row.createdAt)
    && Number(row.createdAt) <= now + 60_000
    && Number(row.createdAt) > now - RECOVERY_MAX_AGE_MS;
}

function sameRecoveryCapability(
  left: Partial<AccountDeletionRecovery>,
  right: AccountDeletionRecovery,
): boolean {
  return left.requestId === right.requestId
    && left.recoverySecret === right.recoverySecret
    && left.subjectHint === right.subjectHint;
}

function resolveRecoveryLease(
  recovery: AccountDeletionRecovery,
  stored: AccountDeletionRecovery | null,
): AccountDeletionRecovery {
  if (stored) {
    if (sameRecoveryCapability(recovery, stored)) return stored;
    throw new AccountDeletionClientError('RECOVERY_CONFLICT', '删除恢复凭据与原请求不一致');
  }
  if (!validRecovery(recovery)) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  return recovery;
}

function renewRecoveryLease<T extends AccountDeletionRecovery>(recovery: T): T {
  const renewed = Object.freeze({ ...recovery, createdAt: Date.now() }) as T;
  const valid = 'workspaceId' in renewed
    ? validWorkspaceRecovery(renewed, renewed.createdAt)
    : validRecovery(renewed, renewed.createdAt);
  if (!valid) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  return renewed;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function canonicalRecoverySecret(value: string): boolean {
  if (!RECOVERY_SECRET_PATTERN.test(value)) return false;
  try {
    const encoded = value.slice('rvr1_'.length);
    const decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '=');
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return bytes.byteLength === 32
      && new Set(bytes).size >= 8
      && base64Url(bytes) === encoded;
  } catch {
    return false;
  }
}

function canonicalRecoveryFile(recovery: AccountDeletionRecovery): string {
  const payload: AccountDeletionRecoveryFile = {
    version: 1,
    operation: 'delete_account',
    requestId: recovery.requestId,
    recoverySecret: recovery.recoverySecret,
    subjectHint: recovery.subjectHint,
    createdAt: recovery.createdAt,
  };
  return JSON.stringify(payload);
}

function recoveryFileInvalid(): never {
  throw new AccountDeletionClientError(
    'RECOVERY_FILE_INVALID',
    '删除状态恢复文件无效或已被修改',
  );
}

function validateRecoveryFileRecovery(
  recovery: AccountDeletionRecovery,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || !validRecovery(recovery, now)) recoveryFileInvalid();
  if (recovery.createdAt <= now - ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS) {
    throw new AccountDeletionClientError(
      'RECOVERY_FILE_EXPIRED',
      '删除状态恢复文件已超过可恢复时限',
    );
  }
  if (recovery.createdAt > now || !canonicalRecoverySecret(recovery.recoverySecret)) {
    recoveryFileInvalid();
  }
}

export function serializeAccountDeletionRecoveryFile(
  recovery: AccountDeletionRecovery,
  now = Date.now(),
): string {
  validateRecoveryFileRecovery(recovery, now);
  const serialized = canonicalRecoveryFile(recovery);
  if (new TextEncoder().encode(serialized).byteLength > ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES) {
    recoveryFileInvalid();
  }
  return serialized;
}

export function parseAccountDeletionRecoveryFile(
  source: string,
  now = Date.now(),
): AccountDeletionRecovery {
  if (
    typeof source !== 'string'
    || source.length === 0
    || new TextEncoder().encode(source).byteLength > ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES
  ) recoveryFileInvalid();

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    recoveryFileInvalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) recoveryFileInvalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).join(',')
      !== 'version,operation,requestId,recoverySecret,subjectHint,createdAt'
    || row.version !== 1
    || row.operation !== 'delete_account'
  ) recoveryFileInvalid();

  const recovery = Object.freeze({
    requestId: row.requestId,
    recoverySecret: row.recoverySecret,
    subjectHint: row.subjectHint,
    createdAt: row.createdAt,
  }) as AccountDeletionRecovery;
  validateRecoveryFileRecovery(recovery, now);
  if (canonicalRecoveryFile(recovery) !== source) recoveryFileInvalid();
  return recovery;
}

export function downloadAccountDeletionRecoveryFile(recovery: AccountDeletionRecovery): void {
  const serialized = serializeAccountDeletionRecoveryFile(recovery);
  let objectUrl = '';
  try {
    if (
      typeof document === 'undefined'
      || typeof URL.createObjectURL !== 'function'
      || typeof URL.revokeObjectURL !== 'function'
    ) throw new Error('download unavailable');
    objectUrl = URL.createObjectURL(new Blob([serialized], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = ACCOUNT_DELETION_RECOVERY_FILE_NAME;
    link.rel = 'noopener';
    link.click();
  } catch (error) {
    if (error instanceof AccountDeletionClientError) throw error;
    throw new AccountDeletionClientError(
      'RECOVERY_FILE_DOWNLOAD_FAILED',
      '浏览器未能保存删除状态恢复文件，请重试下载',
    );
  } finally {
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch {}
    }
  }
}

function createDeletionRecovery(
  subjectHint: string,
  entropy: RecoveryEntropy = {},
): AccountDeletionRecovery {
  try {
    const requestId = (entropy.randomUUID ?? (() => crypto.randomUUID()))();
    const randomBytes = entropy.randomBytes ?? ((length: number) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    });
    const bytes = randomBytes(32);
    if (!UUID_V4_PATTERN.test(requestId) || !(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
      throw new Error('invalid entropy');
    }
    const recovery = Object.freeze({
      requestId,
      recoverySecret: `rvr1_${base64Url(bytes)}`,
      subjectHint,
      createdAt: (entropy.now ?? Date.now)(),
    });
    if (!validRecovery(recovery, recovery.createdAt)) throw new Error('invalid recovery');
    return recovery;
  } catch {
    throw new AccountDeletionClientError('RECOVERY_UNAVAILABLE', '无法生成安全的删除恢复凭据');
  }
}

export function createAccountDeletionRecovery(
  subjectHint: string,
  entropy: RecoveryEntropy = {},
): AccountDeletionRecovery {
  return createDeletionRecovery(subjectHint, entropy);
}

export function createBusinessDeletionRecovery(
  subjectHint: string,
  entropy: RecoveryEntropy = {},
): BusinessDeletionRecovery {
  return createDeletionRecovery(subjectHint, entropy);
}

export function createWorkspaceDeletionRecovery(
  subjectHint: string,
  workspaceId: string,
  entropy: RecoveryEntropy = {},
): WorkspaceDeletionRecovery {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  return Object.freeze({ ...createDeletionRecovery(subjectHint, entropy), workspaceId });
}

export function saveAccountDeletionRecovery(recovery: AccountDeletionRecovery): void {
  if (!validRecovery(recovery)) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  try {
    sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
  } catch {
    throw new AccountDeletionClientError('RECOVERY_UNAVAILABLE', '当前浏览器无法安全保存删除恢复凭据');
  }
}

export function refreshAccountDeletionRecovery(
  recovery: AccountDeletionRecovery,
): AccountDeletionRecovery {
  const refreshed = renewRecoveryLease(recovery);
  saveAccountDeletionRecovery(refreshed);
  return refreshed;
}

export function loadAccountDeletionRecovery(): AccountDeletionRecovery | null {
  try {
    const raw = sessionStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (validRecovery(value)) return Object.freeze({ ...value });
  } catch {}
  try { sessionStorage.removeItem(RECOVERY_STORAGE_KEY); } catch {}
  return null;
}

export function clearAccountDeletionRecovery(): void {
  try { sessionStorage.removeItem(RECOVERY_STORAGE_KEY); } catch {}
}

function validWorkspaceRecovery(
  value: unknown,
  now = Date.now(),
): value is WorkspaceDeletionRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'createdAt,recoverySecret,requestId,subjectHint,workspaceId') {
    return false;
  }
  const { workspaceId, ...base } = row;
  return typeof workspaceId === 'string'
    && UUID_PATTERN.test(workspaceId)
    && validRecovery(base, now);
}

export function saveWorkspaceDeletionRecovery(recovery: WorkspaceDeletionRecovery): void {
  if (!validWorkspaceRecovery(recovery)) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  try {
    sessionStorage.setItem(WORKSPACE_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
  } catch {
    throw new AccountDeletionClientError('RECOVERY_UNAVAILABLE', '当前浏览器无法安全保存删除恢复凭据');
  }
}

export function loadWorkspaceDeletionRecovery(): WorkspaceDeletionRecovery | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (validWorkspaceRecovery(value)) return Object.freeze({ ...value });
  } catch {}
  try { sessionStorage.removeItem(WORKSPACE_RECOVERY_STORAGE_KEY); } catch {}
  return null;
}

export function clearWorkspaceDeletionRecovery(): void {
  try { sessionStorage.removeItem(WORKSPACE_RECOVERY_STORAGE_KEY); } catch {}
}

export function saveBusinessDeletionRecovery(recovery: BusinessDeletionRecovery): void {
  if (!validRecovery(recovery)) {
    throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
  }
  try {
    sessionStorage.setItem(BUSINESS_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
  } catch {
    throw new AccountDeletionClientError('RECOVERY_UNAVAILABLE', '当前浏览器无法安全保存删除恢复凭据');
  }
}

export function loadBusinessDeletionRecovery(): BusinessDeletionRecovery | null {
  try {
    const raw = sessionStorage.getItem(BUSINESS_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (validRecovery(value)) return Object.freeze({ ...value });
  } catch {}
  try { sessionStorage.removeItem(BUSINESS_RECOVERY_STORAGE_KEY); } catch {}
  return null;
}

export function clearBusinessDeletionRecovery(): void {
  try { sessionStorage.removeItem(BUSINESS_RECOVERY_STORAGE_KEY); } catch {}
}

function validTombstone(value: unknown, now = Date.now()): value is AccountDeletionTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'completedAt,receiptId'
    && typeof row.receiptId === 'string'
    && UUID_PATTERN.test(row.receiptId)
    && Number.isSafeInteger(row.completedAt)
    && Number(row.completedAt) <= now + 60_000
    && Number(row.completedAt) > now - TOMBSTONE_MAX_AGE_MS;
}

export function saveAccountDeletionTombstone(tombstone: AccountDeletionTombstone): void {
  if (!validTombstone(tombstone)) return;
  try { sessionStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstone)); } catch {}
}

export function loadAccountDeletionTombstone(): AccountDeletionTombstone | null {
  try {
    const raw = sessionStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (validTombstone(value)) return Object.freeze({ ...value });
  } catch {}
  try { sessionStorage.removeItem(TOMBSTONE_STORAGE_KEY); } catch {}
  return null;
}

export function clearAccountDeletionTombstone(): void {
  try { sessionStorage.removeItem(TOMBSTONE_STORAGE_KEY); } catch {}
}

function publicFailure(status: number, statusRequest = false): AccountDeletionClientError {
  if (status === 401) {
    return new AccountDeletionClientError('AUTH_REQUIRED', '身份验证已过期，请重新登录', status);
  }
  if (status === 403) {
    return new AccountDeletionClientError('REAUTH_REQUIRED', '请重新获取并验证邮件验证码', status);
  }
  if (status === 404 && statusRequest) {
    return new AccountDeletionClientError('RECOVERY_NOT_FOUND', '未找到可验证的删除请求', status);
  }
  if (status === 409) {
    return new AccountDeletionClientError('RECOVERY_CONFLICT', '删除恢复凭据与原请求不一致', status);
  }
  if (status === 410) {
    return new AccountDeletionClientError('RECOVERY_EXPIRED', '删除结果查询窗口已过期', status);
  }
  if (status === 429) {
    return new AccountDeletionClientError('RATE_LIMITED', '请求过于频繁，请稍后重试', status);
  }
  return new AccountDeletionClientError('DELETE_REJECTED', '删除请求未完成', status);
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  status: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new AccountDeletionClientError('RESPONSE_TIMEOUT', '删除响应超时', status);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AccountDeletionClientError('RESPONSE_TIMEOUT', '删除响应超时', status));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AccountDeletionClientError('RESPONSE_TOO_LARGE', '删除响应超过安全上限', response.status);
  }
  let text = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    try {
      while (true) {
        const { done, value } = await readResponseChunk(reader, signal, response.status);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel('response too large');
          throw new AccountDeletionClientError('RESPONSE_TOO_LARGE', '删除响应超过安全上限', response.status);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof AccountDeletionClientError && error.code === 'RESPONSE_TIMEOUT') {
        void reader.cancel('response deadline exceeded').catch(() => {});
      }
      if (error instanceof AccountDeletionClientError) throw error;
      throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效', response.status);
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效', response.status);
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== [...keys].sort().join(',')) {
    throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
  }
  return data;
}

type DeletionOperation = 'delete_workspace' | 'clear_business_data' | 'delete_account';

function parseOperationState(
  value: unknown,
  action: DeletionOperation | 'deletion_status',
  expectedOperation: DeletionOperation,
): AccountDeletionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
  }
  const data = value as Record<string, unknown>;
  const completed = data.state === 'completed';
  const keys = completed
    ? ['protocolVersion', 'action', 'state', 'receiptId', 'expiresAt']
    : ['protocolVersion', 'action', 'state', 'expiresAt'];
  if (action === 'deletion_status') keys.push('operation');
  exactObject(data, keys);
  if (
    data.protocolVersion !== DELETION_PROTOCOL_VERSION
    || data.action !== action
    || (action === 'deletion_status' && data.operation !== expectedOperation)
    || !['pending', 'deleting', 'completed'].includes(String(data.state))
    || typeof data.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(data.expiresAt))
    || (completed && (typeof data.receiptId !== 'string' || !UUID_PATTERN.test(data.receiptId)))
  ) throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
  return Object.freeze({
    state: data.state as AccountDeletionState['state'],
    receiptId: completed ? data.receiptId as string : null,
    expiresAt: data.expiresAt,
  });
}

function requireOpenServerStatusWindow(
  state: AccountDeletionState,
  clearRecovery: () => void,
): AccountDeletionState {
  // The local file age is only an admission envelope for a capability created
  // before the row exists. Once the server returns expiresAt, it is the source
  // of truth and cannot be extended by refreshing or re-importing the file.
  if (Date.parse(state.expiresAt) <= Date.now()) {
    clearRecovery();
    throw new AccountDeletionClientError(
      'RECOVERY_EXPIRED',
      '删除结果查询窗口已按服务端时间过期',
      410,
    );
  }
  return state;
}

function assertFreshProof(proof: AccountDeletionProof): void {
  if (
    !proof
    || typeof proof.accessToken !== 'string'
    || proof.accessToken.length < 32
    || proof.accessToken.length > 8192
    || /\s/.test(proof.accessToken)
    || !Number.isFinite(proof.expiresAt)
    || proof.expiresAt <= Date.now()
    || typeof proof.userId !== 'string'
    || !UUID_PATTERN.test(proof.userId)
  ) throw new AccountDeletionClientError('REAUTH_REQUIRED', '请重新获取并验证邮件验证码');
}

/**
 * Routes every destructive operation through the recent-OTP Edge boundary.
 * Account recovery is session-scoped unless the user explicitly downloads the
 * one-hour status capability; neither path carries an email, JWT, or trade data.
 */
export class AccountDeletionClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly authClient: SupabaseAuthClient;

  constructor(
    private readonly config: ProductionConfig,
    options: AccountDeletionClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = validClientTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.authClient = new SupabaseAuthClient(config, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
  }

  async sendReverificationCode(email: string, signal?: AbortSignal): Promise<void> {
    await this.authClient.sendEmailOtp(email, signal);
  }

  async verifyReverificationCode(
    email: string,
    otp: string,
    signal?: AbortSignal,
  ): Promise<AccountDeletionProof> {
    const session = await this.authClient.verifyEmailOtp(email, otp, signal);
    return Object.freeze({
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      userId: session.userId,
      email: session.email,
    });
  }

  private async post(
    body: Record<string, unknown>,
    proof: AccountDeletionProof | null,
    signal: AbortSignal | undefined,
    recoverableOutcome: boolean,
  ): Promise<Readonly<{ response: Response; value: unknown }>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.supabaseUrl}/functions/v1/delete-account`, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            ...(proof ? { authorization: `Bearer ${proof.accessToken}` } : {}),
            apikey: this.config.publishableKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch {
        if (recoverableOutcome) {
          throw new AccountDeletionClientError(
            'OUTCOME_RECOVERABLE',
            '未能确认删除结果；请使用当前恢复凭据查询最终状态',
          );
        }
        throw new AccountDeletionClientError(
          signal?.aborted ? 'ABORTED' : 'OUTCOME_UNCONFIRMED',
          signal?.aborted ? '删除请求已取消' : '未能确认删除结果；可重新验证后安全重试',
        );
      }
      return Object.freeze({ response, value: await boundedJson(response, controller.signal) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async deleteWorkspace(
    freshProof: AccountDeletionProof,
    workspaceId: string,
    confirmation: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceDeletionReceipt> {
    if (confirmation !== DELETE_WORKSPACE_CONFIRMATION || !UUID_PATTERN.test(workspaceId)) {
      throw new AccountDeletionClientError('CONFIRMATION_MISMATCH', '请输入完整确认短语');
    }
    assertFreshProof(freshProof);
    const existing = loadWorkspaceDeletionRecovery();
    if (existing && (existing.subjectHint !== freshProof.userId || existing.workspaceId !== workspaceId)) {
      throw new AccountDeletionClientError(
        'RECOVERY_CONFLICT',
        '请先查询上一次工作区删除请求的最终状态',
      );
    }
    const recovery = renewRecoveryLease(
      existing ?? createWorkspaceDeletionRecovery(freshProof.userId, workspaceId),
    );
    // Anchor the local recovery lease immediately before the first byte can be
    // sent. The server starts its one-hour TTL only when begin succeeds.
    saveWorkspaceDeletionRecovery(recovery);
    try {
      const { response, value } = await this.post({
        protocolVersion: DELETION_PROTOCOL_VERSION,
        action: 'delete_workspace',
        confirmation: DELETE_WORKSPACE_CONFIRMATION,
        workspaceId,
        requestId: recovery.requestId,
        recoverySecret: recovery.recoverySecret,
      }, freshProof, signal, true);
      if (!response.ok) {
        if (response.status >= 500) throw new AccountDeletionClientError('OUTCOME_RECOVERABLE', '');
        if (response.status === 410) clearWorkspaceDeletionRecovery();
        throw publicFailure(response.status);
      }
      const state = parseOperationState(value, 'delete_workspace', 'delete_workspace');
      if (state.state !== 'completed' || !state.receiptId) {
        throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
      }
      clearWorkspaceDeletionRecovery();
      return Object.freeze({ ...state, state: 'completed', receiptId: state.receiptId });
    } catch (error) {
      if (
        error instanceof AccountDeletionClientError
        && !['RECEIPT_INVALID', 'RESPONSE_TOO_LARGE', 'RESPONSE_TIMEOUT', 'OUTCOME_RECOVERABLE'].includes(error.code)
      ) throw error;
      throw new AccountDeletionClientError(
        'OUTCOME_RECOVERABLE',
        '未能确认工作区删除结果；请使用当前恢复凭据查询最终状态',
      );
    }
  }

  async clearBusinessData(
    freshProof: AccountDeletionProof,
    confirmation: string,
    signal?: AbortSignal,
  ): Promise<BusinessDeletionReceipt> {
    if (confirmation !== CLEAR_BUSINESS_CONFIRMATION) {
      throw new AccountDeletionClientError('CONFIRMATION_MISMATCH', '请输入完整确认短语');
    }
    assertFreshProof(freshProof);
    const existing = loadBusinessDeletionRecovery();
    if (existing && existing.subjectHint !== freshProof.userId) {
      throw new AccountDeletionClientError(
        'RECOVERY_CONFLICT',
        '请先查询上一次业务数据删除请求的最终状态',
      );
    }
    const recovery = renewRecoveryLease(
      existing ?? createBusinessDeletionRecovery(freshProof.userId),
    );
    saveBusinessDeletionRecovery(recovery);
    try {
      const { response, value } = await this.post({
        protocolVersion: DELETION_PROTOCOL_VERSION,
        action: 'clear_business_data',
        confirmation: CLEAR_BUSINESS_CONFIRMATION,
        requestId: recovery.requestId,
        recoverySecret: recovery.recoverySecret,
      }, freshProof, signal, true);
      if (!response.ok) {
        if (response.status >= 500) throw new AccountDeletionClientError('OUTCOME_RECOVERABLE', '');
        if (response.status === 410) clearBusinessDeletionRecovery();
        throw publicFailure(response.status);
      }
      const state = parseOperationState(value, 'clear_business_data', 'clear_business_data');
      if (state.state !== 'completed' || !state.receiptId) {
        throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
      }
      clearBusinessDeletionRecovery();
      return Object.freeze({ ...state, state: 'completed', receiptId: state.receiptId });
    } catch (error) {
      if (
        error instanceof AccountDeletionClientError
        && !['RECEIPT_INVALID', 'RESPONSE_TOO_LARGE', 'RESPONSE_TIMEOUT', 'OUTCOME_RECOVERABLE'].includes(error.code)
      ) throw error;
      throw new AccountDeletionClientError(
        'OUTCOME_RECOVERABLE',
        '未能确认业务数据删除结果；请使用当前恢复凭据查询最终状态',
      );
    }
  }

  async deleteAccount(
    freshProof: AccountDeletionProof,
    confirmation: string,
    recovery: AccountDeletionRecovery,
    signal?: AbortSignal,
  ): Promise<AccountDeletionReceipt> {
    if (confirmation !== ACCOUNT_DELETE_CONFIRMATION) {
      throw new AccountDeletionClientError('CONFIRMATION_MISMATCH', '请输入完整确认短语');
    }
    assertFreshProof(freshProof);
    const activeRecovery = renewRecoveryLease(resolveRecoveryLease(
      recovery,
      loadAccountDeletionRecovery(),
    ));
    saveAccountDeletionRecovery(activeRecovery);
    try {
      const { response, value } = await this.post({
        protocolVersion: DELETION_PROTOCOL_VERSION,
        action: 'delete_account',
        confirmation: ACCOUNT_DELETE_CONFIRMATION,
        requestId: activeRecovery.requestId,
        recoverySecret: activeRecovery.recoverySecret,
      }, freshProof, signal, true);
      if (!response.ok) {
        if (response.status >= 500) {
          throw new AccountDeletionClientError(
            'OUTCOME_RECOVERABLE',
            '未能确认删除结果；请使用当前恢复凭据查询最终状态',
          );
        }
        if (response.status === 410) clearAccountDeletionRecovery();
        throw publicFailure(response.status);
      }
      const state = parseOperationState(value, 'delete_account', 'delete_account');
      if (state.state !== 'completed' || !state.receiptId) {
        throw new AccountDeletionClientError('RECEIPT_INVALID', '删除回执无效');
      }
      return Object.freeze({ ...state, state: 'completed', receiptId: state.receiptId });
    } catch (error) {
      if (
        error instanceof AccountDeletionClientError
        && !['RECEIPT_INVALID', 'RESPONSE_TOO_LARGE', 'RESPONSE_TIMEOUT', 'OUTCOME_RECOVERABLE'].includes(error.code)
      ) throw error;
      throw new AccountDeletionClientError(
        'OUTCOME_RECOVERABLE',
        '未能确认删除结果；请使用当前恢复凭据查询最终状态',
      );
    }
  }

  async queryAccountDeletionStatus(
    recovery: AccountDeletionRecovery,
    signal?: AbortSignal,
  ): Promise<AccountDeletionState> {
    const activeRecovery = resolveRecoveryLease(recovery, loadAccountDeletionRecovery());
    const { response, value } = await this.post({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'deletion_status',
      operation: 'delete_account',
      requestId: activeRecovery.requestId,
      recoverySecret: activeRecovery.recoverySecret,
      subjectHint: activeRecovery.subjectHint,
    }, null, signal, false);
    if (!response.ok) {
      if (response.status === 410) clearAccountDeletionRecovery();
      throw publicFailure(response.status, true);
    }
    return requireOpenServerStatusWindow(
      parseOperationState(value, 'deletion_status', 'delete_account'),
      clearAccountDeletionRecovery,
    );
  }

  async queryWorkspaceDeletionStatus(
    recovery: WorkspaceDeletionRecovery,
    signal?: AbortSignal,
  ): Promise<AccountDeletionState> {
    const stored = loadWorkspaceDeletionRecovery();
    let activeRecovery: WorkspaceDeletionRecovery;
    if (stored) {
      if (
        !sameRecoveryCapability(recovery, stored)
        || recovery.workspaceId !== stored.workspaceId
      ) throw new AccountDeletionClientError('RECOVERY_CONFLICT', '删除恢复凭据与原请求不一致');
      activeRecovery = stored;
    } else {
      if (!validWorkspaceRecovery(recovery)) {
        throw new AccountDeletionClientError('RECOVERY_INVALID', '删除恢复凭据无效或已过期');
      }
      activeRecovery = recovery;
    }
    const { response, value } = await this.post({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'deletion_status',
      operation: 'delete_workspace',
      requestId: activeRecovery.requestId,
      recoverySecret: activeRecovery.recoverySecret,
      subjectHint: activeRecovery.subjectHint,
      workspaceId: activeRecovery.workspaceId,
    }, null, signal, false);
    if (!response.ok) {
      if (response.status === 410) clearWorkspaceDeletionRecovery();
      throw publicFailure(response.status, true);
    }
    const state = requireOpenServerStatusWindow(
      parseOperationState(value, 'deletion_status', 'delete_workspace'),
      clearWorkspaceDeletionRecovery,
    );
    if (state.state === 'completed') clearWorkspaceDeletionRecovery();
    return state;
  }

  async queryBusinessDeletionStatus(
    recovery: BusinessDeletionRecovery,
    signal?: AbortSignal,
  ): Promise<AccountDeletionState> {
    const activeRecovery = resolveRecoveryLease(recovery, loadBusinessDeletionRecovery());
    const { response, value } = await this.post({
      protocolVersion: DELETION_PROTOCOL_VERSION,
      action: 'deletion_status',
      operation: 'clear_business_data',
      requestId: activeRecovery.requestId,
      recoverySecret: activeRecovery.recoverySecret,
      subjectHint: activeRecovery.subjectHint,
    }, null, signal, false);
    if (!response.ok) {
      if (response.status === 410) clearBusinessDeletionRecovery();
      throw publicFailure(response.status, true);
    }
    const state = requireOpenServerStatusWindow(
      parseOperationState(value, 'deletion_status', 'clear_business_data'),
      clearBusinessDeletionRecovery,
    );
    if (state.state === 'completed') clearBusinessDeletionRecovery();
    return state;
  }
}
