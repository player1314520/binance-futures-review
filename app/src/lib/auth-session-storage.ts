import type { AuthSession } from './auth-client';

const KEY = 'rv-production-auth-v1';
const MAX_SERIALIZED_LENGTH = 32 * 1024;
const MAX_TOKEN_LENGTH = 8192;

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= MAX_TOKEN_LENGTH;
}

function normalize(value: unknown, now = Date.now()): AuthSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !validToken(row.accessToken)
    || !validToken(row.refreshToken)
    || typeof row.userId !== 'string'
    || !/^[A-Za-z0-9-]{1,128}$/.test(row.userId)
    || !Number.isSafeInteger(row.expiresAt)
    || Number(row.expiresAt) <= now - 24 * 60 * 60 * 1000
  ) return null;
  return Object.freeze({
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: Number(row.expiresAt),
    userId: row.userId,
    email: typeof row.email === 'string' && row.email.length <= 254 ? row.email : null,
  });
}

export function loadAuthSession(now = Date.now()): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return null;
    return normalize(JSON.parse(raw), now);
  } catch {
    return null;
  }
}

export function saveAuthSession(session: AuthSession): boolean {
  const normalized = normalize(session, 0);
  if (!normalized) return false;
  const raw = JSON.stringify(normalized);
  if (raw.length > MAX_SERIALIZED_LENGTH) return false;
  try {
    sessionStorage.setItem(KEY, raw);
    return true;
  } catch {
    return false;
  }
}

export function clearAuthSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}

export function authSessionNeedsRefresh(
  session: AuthSession,
  now = Date.now(),
  windowMs = 5 * 60 * 1000,
): boolean {
  return session.expiresAt <= now + windowMs;
}
