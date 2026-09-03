import {
  BINANCE_BETA_CONSENT_VERSION,
  normalizeCloudConnectionMutation,
  normalizeCloudConnectionStatus,
  normalizeCloudConnections,
  normalizeCloudDisconnect,
  type CloudConnectionMutation,
  type CloudConnectionStatus,
  type CloudConnections,
  type CloudDisconnectReceipt,
} from './cloud-beta-connection';
import {
  normalizeCloudDatasetV1,
  normalizeCloudSyncV1,
  type CloudDatasetV1,
  type CloudSyncV1,
} from './cloud-beta-contract';
import { ProductionConfigError, readProductionConfig, type ProductionConfig } from './production-config';

const EDGE_PREFIX = '/functions/v1/binance-beta';
const RESTORE_EDGE_PREFIX = '/functions/v1/restore-v2';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESTORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const TRADE_ID_PATTERN = /^t_[0-9a-f]{16}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_KEY_PATTERN = /(?:api.?secret|api.?key|authorization|credential|password|private.?key|refresh.?token|access.?token)/i;

type FetchLike = typeof fetch;

export type CloudBetaClientOptions = Readonly<{
  fetchImpl?: FetchLike;
  accessToken: () => string | null;
  timeoutMs?: number;
}>;

export type CloudCredentialInput = Readonly<{
  apiKey: string;
  apiSecret: string;
  consentVersion: typeof BINANCE_BETA_CONSENT_VERSION;
  idempotencyKey: string;
}>;

export type CloudReviewPayload = Readonly<{
  saw: string;
  happened: string;
  lesson: string;
  grade: 'A' | 'B' | 'C' | 'D';
  reviewed: boolean;
}>;

export type CloudMutationBase<TPayload> = Readonly<{
  expectedVersion: number;
  idempotencyKey: string;
  payload: TPayload;
}>;

export type CloudActionMutation = CloudMutationBase<Readonly<{
  text: string;
  experiment: Readonly<Record<string, unknown>> | null;
}>> & Readonly<{
  reviewId: string;
  tradeId: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
}>;

export type CloudRiskMutation = CloudMutationBase<Readonly<{
  text: string;
  active: boolean;
}>> & Readonly<{ status: 'ACTIVE' | 'PAUSED' | 'RETIRED' }>;

export type CloudReportMutation = CloudMutationBase<Readonly<Record<string, unknown>>> & Readonly<{
  reportType: 'WEEKLY' | 'MONTHLY';
  periodStart: string;
  periodEnd: string;
  sourceGeneration: number;
}>;

export type CloudReviewReceipt = Readonly<{
  format: 'rv-cloud-review/1';
  tradeId: string;
  version: number;
  updatedAt: string;
}>;

export type CloudMutationReceipt = Readonly<{
  format: 'rv-cloud-mutation/1';
  resource: 'action' | 'journal' | 'risk' | 'report';
  resourceId: string;
  version: number;
  updatedAt: string;
}>;

export type CloudOwnerRecoveryReceipt = Readonly<{
  format: 'rv-restore-v2-owner-recovery/1';
  restoreId: string;
  state: 'CLAIMED';
  claimed: true;
  idempotent: boolean;
  remainingOwnerClaims: number;
  inviteClaimDisclosed: false;
  recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE';
}>;

export class CloudBetaClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

function normalizeConfig(config: ProductionConfig): ProductionConfig {
  let normalized: ProductionConfig | null;
  try {
    normalized = readProductionConfig({
      VITE_SUPABASE_URL: config.supabaseUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    });
  } catch (error) {
    throw new CloudBetaClientError(
      'CLOUD_CONFIG_INVALID',
      error instanceof ProductionConfigError ? error.message : '云端 Beta 配置无效',
    );
  }
  if (!normalized) throw new CloudBetaClientError('CLOUD_CONFIG_INVALID', '云端 Beta 配置缺失');
  const url = new URL(normalized.supabaseUrl);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new CloudBetaClientError('CLOUD_CONFIG_INVALID', 'Supabase 地址必须是精确 origin');
  }
  return normalized;
}

function uuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', `${label}格式无效`);
  }
  return value;
}

function credentials(value: CloudCredentialInput): CloudCredentialInput {
  if (
    !CREDENTIAL_PATTERN.test(value.apiKey)
    || !CREDENTIAL_PATTERN.test(value.apiSecret)
    || value.consentVersion !== BINANCE_BETA_CONSENT_VERSION
  ) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '只读凭据或风险同意版本无效');
  uuid(value.idempotencyKey, '幂等键');
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = plainRecord(value);
  const actual = row ? Object.keys(row).sort() : [];
  const expected = [...keys].sort();
  if (!row || actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入字段无效');
  }
  return row;
}

function exactResponseKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = plainRecord(value);
  const actual = row ? Object.keys(row).sort() : [];
  const expected = [...keys].sort();
  if (!row || actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端响应字段无效');
  }
  return row;
}

function safeJson(value: unknown, depth = 0): void {
  if (depth > 8) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容无效');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容无效');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 16 * 1024 || /\u0000/.test(value)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容无效');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容无效');
    value.forEach((entry) => safeJson(entry, depth + 1));
    return;
  }
  const row = plainRecord(value);
  if (!row || Object.keys(row).length > 128 || Object.keys(row).some((key) => SECRET_KEY_PATTERN.test(key))) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容无效');
  }
  Object.values(row).forEach((entry) => safeJson(entry, depth + 1));
}

function boundedPayload<T>(value: T, maximumBytes: number): T {
  safeJson(value);
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > maximumBytes) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入内容超过安全上限');
  }
  return value;
}

function mutationVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入版本无效');
  }
  return Number(value);
}

function day(value: string): string {
  const timestamp = DAY_PATTERN.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '日期格式无效');
  }
  return value;
}

function textField(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || value.length > maximum || /\u0000/.test(value)) {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入文本无效');
  }
  if (required && !value.trim()) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '云端写入文本无效');
  return value;
}

function reviewPayload(value: CloudReviewPayload): CloudReviewPayload {
  const row = exactKeys(value, ['saw', 'happened', 'lesson', 'grade', 'reviewed']);
  for (const key of ['saw', 'happened', 'lesson']) textField(row[key], 600);
  if (!['A', 'B', 'C', 'D'].includes(String(row.grade)) || typeof row.reviewed !== 'boolean') {
    throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '复盘字段无效');
  }
  return boundedPayload(value, 4 * 1024);
}

function mutationMeta(value: Readonly<{ expectedVersion: number; idempotencyKey: string }>): void {
  mutationVersion(value.expectedVersion);
  uuid(value.idempotencyKey, '幂等键');
}

function iso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeReviewReceipt(
  value: unknown,
  tradeId: string,
  expectedVersion: number,
): CloudReviewReceipt {
  const row = exactKeys(value, ['format', 'tradeId', 'version', 'updatedAt']);
  if (
    row.format !== 'rv-cloud-review/1'
    || row.tradeId !== tradeId
    || row.version !== expectedVersion + 1
    || !iso(row.updatedAt)
  ) throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端复盘回执无效');
  return Object.freeze({
    format: 'rv-cloud-review/1', tradeId, version: Number(row.version), updatedAt: row.updatedAt,
  });
}

function normalizeMutationReceipt(
  value: unknown,
  resource: CloudMutationReceipt['resource'],
  expectedVersion: number,
  expectedResourceId: string | null,
): CloudMutationReceipt {
  const row = exactKeys(value, ['format', 'resource', 'resourceId', 'version', 'updatedAt']);
  const resourceId = typeof row.resourceId === 'string' ? row.resourceId : '';
  if (
    row.format !== 'rv-cloud-mutation/1'
    || row.resource !== resource
    || (expectedResourceId !== null ? resourceId !== expectedResourceId : !UUID_PATTERN.test(resourceId))
    || row.version !== expectedVersion + 1
    || !iso(row.updatedAt)
  ) throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端写入回执无效');
  return Object.freeze({
    format: 'rv-cloud-mutation/1', resource, resourceId: resourceId.toLowerCase(),
    version: Number(row.version), updatedAt: row.updatedAt,
  });
}

function normalizeOwnerRecoveryReceipt(
  value: unknown,
  restoreId: string,
): CloudOwnerRecoveryReceipt {
  const row = exactResponseKeys(value, [
    'format', 'restoreId', 'state', 'claimed', 'idempotent',
    'remainingOwnerClaims', 'inviteClaimDisclosed', 'recoveryIdentitySource',
  ]);
  if (
    row.format !== 'rv-restore-v2-owner-recovery/1'
    || row.restoreId !== restoreId
    || row.state !== 'CLAIMED'
    || row.claimed !== true
    || typeof row.idempotent !== 'boolean'
    || !Number.isSafeInteger(row.remainingOwnerClaims)
    || Number(row.remainingOwnerClaims) < 0
    || Number(row.remainingOwnerClaims) > 10
    || row.inviteClaimDisclosed !== false
    || row.recoveryIdentitySource !== 'AUTH_VERIFIED_SERVER_SIDE'
  ) throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '恢复认领回执无效');
  return Object.freeze({
    format: 'rv-restore-v2-owner-recovery/1',
    restoreId,
    state: 'CLAIMED',
    claimed: true,
    idempotent: row.idempotent,
    remainingOwnerClaims: Number(row.remainingOwnerClaims),
    inviteClaimDisclosed: false,
    recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE',
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端响应格式无效', response.status);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudBetaClientError('CLOUD_RESPONSE_TOO_LARGE', '云端响应超过安全上限', response.status);
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CloudBetaClientError(
          'CLOUD_RESPONSE_TOO_LARGE',
          '云端响应超过安全上限',
          response.status,
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端响应编码无效', response.status);
  }
  try {
    return text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new CloudBetaClientError('CLOUD_RESPONSE_INVALID', '云端响应不是 JSON', response.status);
  }
}

export class CloudBetaClient {
  private readonly config: ProductionConfig;
  private readonly fetchImpl: FetchLike;
  private readonly accessToken: () => string | null;
  private readonly timeoutMs: number;
  private readonly origin: string;

  constructor(config: ProductionConfig, options: CloudBetaClientOptions) {
    this.config = normalizeConfig(config);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new CloudBetaClientError('CLOUD_CONFIG_INVALID', '云端请求超时配置无效');
    }
    this.origin = new URL(this.config.supabaseUrl).origin;
  }

  private async request(
    path: string,
    method: string,
    expectedStatus: number,
    body?: unknown,
    connectionId?: string,
    edgePrefix = EDGE_PREFIX,
  ): Promise<unknown> {
    const token = this.accessToken();
    if (
      typeof token !== 'string'
      || token.length < 8
      || token.length > 8192
      || /[\r\n\s]/.test(token)
    ) throw new CloudBetaClientError('CLOUD_AUTH_REQUIRED', '请先完成邀请制登录');
    const target = new URL(`${edgePrefix}${path}`, `${this.origin}/`);
    if (target.origin !== this.origin) {
      throw new CloudBetaClientError('CLOUD_ORIGIN_MISMATCH', '云端请求 origin 不一致');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(target.toString(), {
          method,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            apikey: this.config.publishableKey,
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(connectionId === undefined
              ? {}
              : { 'x-rv-connection-id': uuid(connectionId, '连接 ID') }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (controller.signal.aborted) {
          throw new CloudBetaClientError('CLOUD_TIMEOUT', '云端请求超时');
        }
        throw new CloudBetaClientError('CLOUD_NETWORK', '无法连接邀请制 Beta 服务');
      }
      if (response.url) {
        let responseOrigin: string;
        try {
          responseOrigin = new URL(response.url).origin;
        } catch {
          throw new CloudBetaClientError('CLOUD_ORIGIN_MISMATCH', '云端响应 origin 无效');
        }
        if (responseOrigin !== this.origin) {
          await response.body?.cancel().catch(() => undefined);
          throw new CloudBetaClientError('CLOUD_ORIGIN_MISMATCH', '云端响应 origin 不一致');
        }
      }
      const data = await boundedJson(response);
      if (response.status !== expectedStatus) {
        throw new CloudBetaClientError(
          'CLOUD_REJECTED',
          response.status === 401 || response.status === 403
            ? '邀请资格或登录状态无效'
            : response.status === 429
              ? '请求过于频繁，请稍后重试'
              : '邀请制 Beta 服务暂时不可用',
          response.status,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listConnections(): Promise<CloudConnections> {
    return normalizeCloudConnections(await this.request('/v1/connections', 'GET', 200));
  }

  async createConnection(input: CloudCredentialInput): Promise<CloudConnectionMutation> {
    const exactInput = credentials(input);
    return normalizeCloudConnectionMutation(await this.request('/v1/connections', 'POST', 201, {
      apiKey: exactInput.apiKey,
      apiSecret: exactInput.apiSecret,
      consentVersion: exactInput.consentVersion,
      idempotencyKey: exactInput.idempotencyKey,
    }));
  }

  async rotateConnection(
    connectionId: string,
    input: CloudCredentialInput,
  ): Promise<CloudConnectionMutation> {
    const id = uuid(connectionId, '连接 ID');
    const exactInput = credentials(input);
    return normalizeCloudConnectionMutation(await this.request(
      `/v1/connections/${id}/rotate`,
      'POST',
      200,
      {
        apiKey: exactInput.apiKey,
        apiSecret: exactInput.apiSecret,
        consentVersion: exactInput.consentVersion,
        idempotencyKey: exactInput.idempotencyKey,
      },
    ));
  }

  async queueSync(connectionId: string, idempotencyKey: string): Promise<CloudSyncV1> {
    const id = uuid(connectionId, '连接 ID');
    const requestId = uuid(idempotencyKey, '幂等键');
    return normalizeCloudSyncV1(await this.request(
      `/v1/connections/${id}/sync`,
      'POST',
      202,
      { idempotencyKey: requestId },
    ));
  }

  async getConnectionStatus(connectionId: string): Promise<CloudConnectionStatus> {
    const id = uuid(connectionId, '连接 ID');
    return normalizeCloudConnectionStatus(await this.request(
      `/v1/connections/${id}/status`,
      'GET',
      200,
    ));
  }

  async disconnectConnection(connectionId: string): Promise<CloudDisconnectReceipt> {
    const id = uuid(connectionId, '连接 ID');
    return normalizeCloudDisconnect(await this.request(
      `/v1/connections/${id}`,
      'DELETE',
      200,
    ));
  }

  async recoverRestoredOwner(restoreId: string): Promise<CloudOwnerRecoveryReceipt> {
    if (!RESTORE_ID_PATTERN.test(restoreId)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '恢复编号格式无效');
    }
    const id = restoreId.toLowerCase();
    try {
      return normalizeOwnerRecoveryReceipt(await this.request(
        '/internal/v2/restore/owner-recover',
        'POST',
        200,
        { restoreId: id },
        undefined,
        RESTORE_EDGE_PREFIX,
      ), id);
    } catch (error) {
      if (error instanceof CloudBetaClientError && error.status === 404) {
        throw new CloudBetaClientError(
          'CLOUD_RECOVERY_NOT_FOUND',
          '恢复编号、登录账号或恢复状态不匹配',
          404,
        );
      }
      throw error;
    }
  }

  async getCurrentDataset(connectionId: string): Promise<CloudDatasetV1> {
    return normalizeCloudDatasetV1(await this.request(
      '/v1/datasets/current',
      'GET',
      200,
      undefined,
      connectionId,
    ));
  }

  async upsertReview(
    connectionId: string,
    tradeId: string,
    input: CloudMutationBase<CloudReviewPayload>,
  ): Promise<CloudReviewReceipt> {
    const id = uuid(connectionId, '连接 ID');
    if (!TRADE_ID_PATTERN.test(tradeId)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '交易 ID 无效');
    }
    mutationMeta(input);
    const value = await this.request(`/v1/reviews/${tradeId}`, 'PUT', 200, {
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: reviewPayload(input.payload),
    }, id);
    return normalizeReviewReceipt(value, tradeId, input.expectedVersion);
  }

  async updateAction(
    connectionId: string,
    actionId: string,
    input: CloudActionMutation,
  ): Promise<CloudMutationReceipt> {
    const id = uuid(connectionId, '连接 ID');
    const resourceId = uuid(actionId, '行动 ID');
    const reviewId = uuid(input.reviewId, '复盘 ID');
    if (!TRADE_ID_PATTERN.test(input.tradeId)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '交易 ID 无效');
    }
    mutationMeta(input);
    if (!['OPEN', 'DONE', 'CANCELLED'].includes(input.status)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '行动状态无效');
    }
    const payload = exactKeys(input.payload, ['text', 'experiment']);
    textField(payload.text, 600, true);
    if (payload.experiment !== null && !plainRecord(payload.experiment)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '行动实验无效');
    }
    const value = await this.request(`/v1/actions/${resourceId}`, 'PUT', 200, boundedPayload({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      reviewId,
      tradeId: input.tradeId,
      status: input.status,
      payload: input.payload,
    }, 64 * 1024), id);
    return normalizeMutationReceipt(value, 'action', input.expectedVersion, resourceId);
  }

  async upsertJournal(
    connectionId: string,
    journalDay: string,
    input: CloudMutationBase<Readonly<{ note: string; emotion: string }>>,
  ): Promise<CloudMutationReceipt> {
    const id = uuid(connectionId, '连接 ID');
    const resourceId = day(journalDay);
    mutationMeta(input);
    const payload = exactKeys(input.payload, ['note', 'emotion']);
    textField(payload.note, 4_000, true);
    textField(payload.emotion, 80);
    const value = await this.request(`/v1/journal/${resourceId}`, 'PUT', 200, boundedPayload({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
    }, 8 * 1024), id);
    return normalizeMutationReceipt(value, 'journal', input.expectedVersion, resourceId);
  }

  async upsertRiskRule(
    connectionId: string,
    ruleId: string,
    input: CloudRiskMutation,
  ): Promise<CloudMutationReceipt> {
    const id = uuid(connectionId, '连接 ID');
    const resourceId = uuid(ruleId, '风控守则 ID');
    mutationMeta(input);
    if (!['ACTIVE', 'PAUSED', 'RETIRED'].includes(input.status)) {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '风控守则状态无效');
    }
    const payload = exactKeys(input.payload, ['text', 'active']);
    textField(payload.text, 600, true);
    if (typeof payload.active !== 'boolean') {
      throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '风控守则字段无效');
    }
    const value = await this.request(`/v1/risk/${resourceId}`, 'PUT', 200, boundedPayload({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      payload: input.payload,
    }, 4 * 1024), id);
    return normalizeMutationReceipt(value, 'risk', input.expectedVersion, resourceId);
  }

  async upsertReport(
    connectionId: string,
    input: CloudReportMutation,
  ): Promise<CloudMutationReceipt> {
    const id = uuid(connectionId, '连接 ID');
    mutationMeta(input);
    const periodStart = day(input.periodStart);
    const periodEnd = day(input.periodEnd);
    if (
      !['WEEKLY', 'MONTHLY'].includes(input.reportType)
      || periodEnd < periodStart
      || !Number.isSafeInteger(input.sourceGeneration)
      || input.sourceGeneration < 1
      || !plainRecord(input.payload)
    ) throw new CloudBetaClientError('CLOUD_REQUEST_INVALID', '报告字段无效');
    const value = await this.request('/v1/reports/current', 'PUT', 200, boundedPayload({
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      reportType: input.reportType,
      periodStart,
      periodEnd,
      sourceGeneration: input.sourceGeneration,
      payload: input.payload,
    }, 256 * 1024), id);
    return normalizeMutationReceipt(value, 'report', input.expectedVersion, null);
  }
}
