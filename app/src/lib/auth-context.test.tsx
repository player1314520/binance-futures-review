import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth, type AuthRuntime } from './auth-context';
import { saveAuthSession } from './auth-session-storage';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
} as const;

const signedIn = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId: 'user-1',
  email: 'person@example.com',
} as const;

function Harness() {
  const auth = useAuth();
  return (
    <div>
      <span>{auth.phase}</span>
      <span>{auth.session?.userId ?? 'none'}</span>
      <button type="button" onClick={() => void auth.sendCode('PERSON@example.com')}>send</button>
      <button type="button" onClick={() => void auth.verifyCode('123456')}>verify</button>
      <button type="button" onClick={() => void auth.signOut()}>signout</button>
    </div>
  );
}

function runtime(overrides: Partial<AuthRuntime['client']> = {}): AuthRuntime {
  return {
    config,
    invalidMessage: null,
    client: {
      sendEmailOtp: vi.fn(async () => undefined),
      verifyEmailOtp: vi.fn(async () => signedIn),
      refresh: vi.fn(async () => signedIn),
      signOut: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

describe('AuthProvider', () => {
  beforeEach(() => sessionStorage.clear());

  it('runs the invite-only OTP flow and persists only the current session', async () => {
    const user = userEvent.setup();
    const activeRuntime = runtime();
    render(<AuthProvider runtime={activeRuntime}><Harness /></AuthProvider>);

    await user.click(screen.getByRole('button', { name: 'send' }));
    expect(await screen.findByText('CODE_SENT')).toBeInTheDocument();
    expect(activeRuntime.client?.sendEmailOtp).toHaveBeenCalledWith('PERSON@example.com');
    await user.click(screen.getByRole('button', { name: 'verify' }));
    expect(await screen.findByText('SIGNED_IN')).toBeInTheDocument();
    expect(screen.getByText('user-1')).toBeInTheDocument();
    expect(sessionStorage.getItem('rv-production-auth-v1')).toContain('refresh-token-value');
    expect(localStorage.getItem('rv-production-auth-v1')).toBeNull();
  });

  it('refreshes a near-expiry session without exposing it to the page first', async () => {
    saveAuthSession({ ...signedIn, expiresAt: Date.now() + 1_000 });
    const refreshed = { ...signedIn, accessToken: 'new-access-token', expiresAt: Date.now() + 7_200_000 };
    const activeRuntime = runtime({ refresh: vi.fn(async () => refreshed) });
    render(<AuthProvider runtime={activeRuntime}><Harness /></AuthProvider>);

    expect(screen.queryByText('user-1')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('SIGNED_IN')).toBeInTheDocument());
    expect(activeRuntime.client?.refresh).toHaveBeenCalledWith('refresh-token-value');
    expect(sessionStorage.getItem('rv-production-auth-v1')).toContain('new-access-token');
  });

  it('clears local tokens even if remote sign-out fails', async () => {
    saveAuthSession(signedIn);
    const activeRuntime = runtime({ signOut: vi.fn(async () => { throw new Error('offline'); }) });
    const user = userEvent.setup();
    render(<AuthProvider runtime={activeRuntime}><Harness /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('SIGNED_IN')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'signout' }));
    await waitFor(() => expect(screen.getByText('SIGNED_OUT')).toBeInTheDocument());
    expect(sessionStorage.getItem('rv-production-auth-v1')).toBeNull();
  });

  it('refreshes a long-lived open session before the access token expires', async () => {
    vi.useFakeTimers();
    try {
      const now = new Date('2026-08-28T12:00:00.000Z');
      vi.setSystemTime(now);
      const expiring = { ...signedIn, expiresAt: now.getTime() + 5 * 60 * 1000 + 1_000 };
      const refreshed = {
        ...signedIn,
        accessToken: 'periodically-refreshed-access-token',
        expiresAt: now.getTime() + 60 * 60 * 1000,
      };
      const refresh = vi.fn(async () => refreshed);
      saveAuthSession(expiring);
      render(<AuthProvider runtime={runtime({ refresh })}><Harness /></AuthProvider>);

      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('SIGNED_IN')).toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith('refresh-token-value');
      expect(sessionStorage.getItem('rv-production-auth-v1'))
        .toContain('periodically-refreshed-access-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
