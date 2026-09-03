import { beforeEach, describe, expect, it } from 'vitest';
import {
  authSessionNeedsRefresh,
  clearAuthSession,
  loadAuthSession,
  saveAuthSession,
} from './auth-session-storage';

const session = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: 2_000_000,
  userId: 'user-1',
  email: 'person@example.com',
} as const;

describe('auth session storage', () => {
  beforeEach(() => sessionStorage.clear());

  it('persists only in the current browser session', () => {
    expect(saveAuthSession(session)).toBe(true);
    expect(loadAuthSession(1_000_000)).toEqual(session);
    expect(localStorage.length).toBe(0);
  });

  it('drops malformed, oversized, and long-expired sessions', () => {
    sessionStorage.setItem('rv-production-auth-v1', '{bad');
    expect(loadAuthSession()).toBeNull();
    sessionStorage.setItem('rv-production-auth-v1', JSON.stringify({
      ...session,
      accessToken: 'x'.repeat(9_000),
    }));
    expect(loadAuthSession()).toBeNull();
    expect(saveAuthSession({ ...session, expiresAt: 1_000 })).toBe(true);
    expect(loadAuthSession(24 * 60 * 60 * 1000 + 1_001)).toBeNull();
  });

  it('refreshes before expiry and can be explicitly cleared', () => {
    expect(authSessionNeedsRefresh(session, 1_800_001)).toBe(true);
    expect(authSessionNeedsRefresh(session, 1_000_000)).toBe(false);
    saveAuthSession(session);
    clearAuthSession();
    expect(loadAuthSession(1_000_000)).toBeNull();
  });
});
