import type { ProductionConfig } from './production-config';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_AUTH_RESPONSE_BYTES = 128 * 1024;
const EMAIL_MAX_LENGTH = 254;
const OTP_PATTERN = /^[0-9]{6,10}$/;

export type AuthSession = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string | null;
}>;

export class AuthClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

type AuthClientOptions = Readonly<{
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}>;

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    !email
    || email.length > EMAIL_MAX_LENGTH
    || /[\r\n]/.test(email)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AuthClientError('AUTH_EMAIL_INVALID', '请输入有效邮箱地址');
  }
  return email;
}

function assertToken(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192) {
    throw new AuthClientError('AUTH_RESPONSE_INVALID', `登录响应缺少 ${name}`);
  }
  return value;
}

function sessionFrom(value: unknown): AuthSession {
  if (!value || typeof value !== 'object') {
    throw new AuthClientError('AUTH_RESPONSE_INVALID', '登录响应格式无效');
  }
  const data = value as Record<string, unknown>;
  const user = data.user as Record<string, unknown> | undefined;
  const expiresIn = Number(data.expires_in);
  const userId = typeof user?.id === 'string' ? user.id : '';
  if (!userId || userId.length > 128 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthClientError('AUTH_RESPONSE_INVALID', '登录响应缺少有效用户或有效期');
  }
  return Object.freeze({
    accessToken: assertToken(data.access_token, 'access token'),
    refreshToken: assertToken(data.refresh_token, 'refresh token'),
    expiresAt: Date.now() + Math.floor(expiresIn * 1000),
    userId,
    email: typeof user?.email === 'string' ? user.email : null,
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_AUTH_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthClientError('AUTH_RESPONSE_TOO_LARGE', '认证响应超过安全上限', response.status);
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
      if (total > MAX_AUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AuthClientError(
          'AUTH_RESPONSE_TOO_LARGE',
          '认证响应超过安全上限',
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
    throw new AuthClientError('AUTH_RESPONSE_INVALID', '认证服务返回了无效响应', response.status);
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AuthClientError('AUTH_RESPONSE_INVALID', '认证服务返回了无效响应', response.status);
  }
}

function publicMessage(status: number): string {
  if (status === 401 || status === 403) return '验证码无效、已过期或账户未获邀请';
  if (status === 429) return '请求过于频繁，请稍后重试';
  return '认证服务暂时不可用';
}

export class SupabaseAuthClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ProductionConfig,
    options: AuthClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.supabaseUrl}/auth/v1/${path}`, {
          ...init,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            apikey: this.config.publishableKey,
            'content-type': 'application/json',
            ...init.headers,
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AuthClientError(
            signal?.aborted ? 'AUTH_ABORTED' : 'AUTH_TIMEOUT',
            signal?.aborted ? '认证请求已取消' : '认证请求超时',
          );
        }
        throw new AuthClientError('AUTH_NETWORK', '无法连接认证服务');
      }
      const body = await boundedJson(response);
      if (!response.ok) {
        throw new AuthClientError('AUTH_REJECTED', publicMessage(response.status), response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async sendEmailOtp(emailInput: string, signal?: AbortSignal): Promise<void> {
    const email = normalizeEmail(emailInput);
    await this.request('otp', {
      method: 'POST',
      body: JSON.stringify({
        email,
        create_user: false,
      }),
    }, signal);
  }

  async verifyEmailOtp(
    emailInput: string,
    otpInput: string,
    signal?: AbortSignal,
  ): Promise<AuthSession> {
    const email = normalizeEmail(emailInput);
    const token = otpInput.trim();
    if (!OTP_PATTERN.test(token)) {
      throw new AuthClientError('AUTH_OTP_INVALID', '请输入邮件中的数字验证码');
    }
    return sessionFrom(await this.request('verify', {
      method: 'POST',
      body: JSON.stringify({ email, token, type: 'email' }),
    }, signal));
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<AuthSession> {
    const token = assertToken(refreshToken, 'refresh token');
    return sessionFrom(await this.request('token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: token }),
    }, signal));
  }

  async signOut(accessToken: string, signal?: AbortSignal): Promise<void> {
    const token = assertToken(accessToken, 'access token');
    await this.request('logout?scope=global', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    }, signal);
  }
}
