import { describe, expect, it, vi } from 'vitest';
import { AuthClientError, SupabaseAuthClient } from './auth-client';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
} as const;

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('SupabaseAuthClient', () => {
  it('always requests an existing invited account and never exposes a signup flag', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });
    await client.sendEmailOtp('  PERSON@Example.com ');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe('https://project.supabase.co/auth/v1/otp');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'person@example.com',
      create_user: false,
    });
    expect(init?.credentials).toBe('omit');
    expect((init?.headers as Record<string, string>).apikey).toBe(config.publishableKey);
  });

  it('verifies a numeric OTP and returns a bounded session object', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
      user: { id: 'user-1', email: 'person@example.com', ignored: 'private' },
      ignored: 'private',
    })) as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });
    await expect(client.verifyEmailOtp('person@example.com', '123456')).resolves.toEqual({
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      expiresAt: Date.parse('2026-08-28T01:00:00Z'),
      userId: 'user-1',
      email: 'person@example.com',
    });
    vi.useRealTimers();
  });

  it('rejects invalid inputs before transport', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });
    await expect(client.sendEmailOtp('not-an-email')).rejects.toMatchObject({ code: 'AUTH_EMAIL_INVALID' });
    await expect(client.verifyEmailOtp('person@example.com', 'abc')).rejects.toMatchObject({ code: 'AUTH_OTP_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not reflect server error bodies to the caller', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      message: 'private backend detail',
      token: 'must-not-leak',
    }, 401)) as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });
    await expect(client.sendEmailOtp('person@example.com')).rejects.toEqual(
      new AuthClientError('AUTH_REJECTED', '验证码无效、已过期或账户未获邀请', 401),
    );
  });

  it('rejects oversized responses before parsing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200, {
      'content-length': String(129 * 1024),
    })) as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });
    await expect(client.sendEmailOtp('person@example.com')).rejects.toMatchObject({
      code: 'AUTH_RESPONSE_TOO_LARGE',
    });
  });

  it('cancels an oversized chunked response before buffering the full body', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(96 * 1024));
        controller.enqueue(new Uint8Array(96 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }))) as unknown as typeof fetch;
    const client = new SupabaseAuthClient(config, { fetchImpl });

    await expect(client.sendEmailOtp('person@example.com')).rejects.toMatchObject({
      code: 'AUTH_RESPONSE_TOO_LARGE',
    });
    expect(cancelled).toBe(true);
  });

  it('supports caller cancellation and has no persistent token storage', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    )) as unknown as typeof fetch;
    const controller = new AbortController();
    const client = new SupabaseAuthClient(config, { fetchImpl, timeoutMs: 10_000 });
    const pending = client.sendEmailOtp('person@example.com', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_ABORTED' });
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});
