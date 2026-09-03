import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AuthClientError,
  SupabaseAuthClient,
  type AuthSession,
} from './auth-client';
import {
  authSessionNeedsRefresh,
  clearAuthSession,
  loadAuthSession,
  saveAuthSession,
} from './auth-session-storage';
import {
  ProductionConfigError,
  readProductionConfig,
  type ProductionConfig,
} from './production-config';

export type AuthPhase =
  | 'UNCONFIGURED'
  | 'CONFIG_INVALID'
  | 'SIGNED_OUT'
  | 'SENDING_CODE'
  | 'CODE_SENT'
  | 'VERIFYING'
  | 'RESTORING'
  | 'SIGNED_IN'
  | 'SIGNING_OUT';

export type AuthRuntime = Readonly<{
  config: ProductionConfig | null;
  client: Pick<SupabaseAuthClient, 'sendEmailOtp' | 'verifyEmailOtp' | 'refresh' | 'signOut'> | null;
  invalidMessage: string | null;
}>;

type AuthContextValue = Readonly<{
  phase: AuthPhase;
  configured: boolean;
  session: AuthSession | null;
  pendingEmail: string;
  error: string;
  config: ProductionConfig | null;
  sendCode: (email: string) => Promise<boolean>;
  verifyCode: (otp: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  accessToken: () => string | null;
}>;

const AuthContext = createContext<AuthContextValue | null>(null);
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_PERIODIC_REFRESH_DELAY_MS = 1_000;

export function createDefaultAuthRuntime(): AuthRuntime {
  try {
    const config = readProductionConfig({
      VITE_BACKEND_MODE: import.meta.env.VITE_BACKEND_MODE,
      VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      VITE_APP_ORIGIN: import.meta.env.VITE_APP_ORIGIN,
    });
    return Object.freeze({
      config,
      client: config ? new SupabaseAuthClient(config) : null,
      invalidMessage: null,
    });
  } catch (error) {
    return Object.freeze({
      config: null,
      client: null,
      invalidMessage: error instanceof ProductionConfigError
        ? error.message
        : '生产后端配置无效',
    });
  }
}

function message(error: unknown): string {
  return error instanceof AuthClientError ? error.message : '认证流程暂时不可用';
}

export function AuthProvider({
  children,
  runtime = createDefaultAuthRuntime(),
}: {
  children: React.ReactNode;
  runtime?: AuthRuntime;
}) {
  const initialPhase: AuthPhase = runtime.invalidMessage
    ? 'CONFIG_INVALID'
    : runtime.client
      ? 'SIGNED_OUT'
      : 'UNCONFIGURED';
  const [phase, setPhase] = useState<AuthPhase>(initialPhase);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [pendingEmail, setPendingEmail] = useState('');
  const [error, setError] = useState(runtime.invalidMessage ?? '');
  const epoch = useRef(0);
  const sessionRef = useRef<AuthSession | null>(null);
  const refreshInFlightRef = useRef(false);

  const commitSession = useCallback((next: AuthSession | null) => {
    sessionRef.current = next;
    setSession(next);
    if (next) saveAuthSession(next);
    else clearAuthSession();
  }, []);

  useEffect(() => {
    if (!runtime.client) {
      clearAuthSession();
      return;
    }
    const stored = loadAuthSession();
    if (!stored) return;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    setPhase('RESTORING');
    if (!authSessionNeedsRefresh(stored)) {
      commitSession(stored);
      setPhase('SIGNED_IN');
      return;
    }
    void runtime.client.refresh(stored.refreshToken).then((next) => {
      if (epoch.current !== currentEpoch) return;
      commitSession(next);
      setPhase('SIGNED_IN');
    }).catch(() => {
      if (epoch.current !== currentEpoch) return;
      commitSession(null);
      setPhase('SIGNED_OUT');
      setError('登录已过期，请重新验证邮箱');
    });
    return () => { epoch.current += 1; };
  }, [commitSession, runtime.client]);

  useEffect(() => {
    if (!runtime.client || !session) return;
    const expectedUserId = session.userId;
    const expectedRefreshToken = session.refreshToken;
    const delay = Math.max(
      MIN_PERIODIC_REFRESH_DELAY_MS,
      session.expiresAt - Date.now() - REFRESH_WINDOW_MS,
    );
    const timer = window.setTimeout(() => {
      if (
        refreshInFlightRef.current
        || sessionRef.current?.userId !== expectedUserId
        || sessionRef.current?.refreshToken !== expectedRefreshToken
      ) return;
      const currentEpoch = epoch.current;
      refreshInFlightRef.current = true;
      void runtime.client!.refresh(expectedRefreshToken).then((next) => {
        if (
          epoch.current !== currentEpoch
          || sessionRef.current?.userId !== expectedUserId
          || sessionRef.current?.refreshToken !== expectedRefreshToken
        ) return;
        if (next.userId !== expectedUserId) throw new Error('AUTH_SUBJECT_CHANGED');
        commitSession(next);
        setError('');
        setPhase('SIGNED_IN');
      }).catch(() => {
        if (
          epoch.current !== currentEpoch
          || sessionRef.current?.userId !== expectedUserId
          || sessionRef.current?.refreshToken !== expectedRefreshToken
        ) return;
        epoch.current += 1;
        commitSession(null);
        setPhase('SIGNED_OUT');
        setError('登录已过期，请重新验证邮箱');
      }).finally(() => {
        refreshInFlightRef.current = false;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [commitSession, runtime.client, session]);

  const sendCode = useCallback(async (email: string) => {
    if (!runtime.client) return false;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    setError('');
    setPhase('SENDING_CODE');
    try {
      await runtime.client.sendEmailOtp(email);
      if (epoch.current !== currentEpoch) return false;
      setPendingEmail(email.trim().toLowerCase());
      setPhase('CODE_SENT');
      return true;
    } catch (caught) {
      if (epoch.current !== currentEpoch) return false;
      setError(message(caught));
      setPhase('SIGNED_OUT');
      return false;
    }
  }, [runtime.client]);

  const verifyCode = useCallback(async (otp: string) => {
    if (!runtime.client || !pendingEmail) return false;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    setError('');
    setPhase('VERIFYING');
    try {
      const next = await runtime.client.verifyEmailOtp(pendingEmail, otp);
      if (epoch.current !== currentEpoch) return false;
      commitSession(next);
      setPendingEmail('');
      setPhase('SIGNED_IN');
      return true;
    } catch (caught) {
      if (epoch.current !== currentEpoch) return false;
      setError(message(caught));
      setPhase('CODE_SENT');
      return false;
    }
  }, [commitSession, pendingEmail, runtime.client]);

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    epoch.current += 1;
    setPhase('SIGNING_OUT');
    commitSession(null);
    setPendingEmail('');
    setError('');
    try {
      if (runtime.client && current) await runtime.client.signOut(current.accessToken);
    } catch {
      // Local tokens are already removed. Remote expiry/revocation remains server controlled.
    } finally {
      setPhase(runtime.client ? 'SIGNED_OUT' : 'UNCONFIGURED');
    }
  }, [commitSession, runtime.client]);

  const value = useMemo<AuthContextValue>(() => Object.freeze({
    phase,
    configured: Boolean(runtime.client && runtime.config),
    session,
    pendingEmail,
    error,
    config: runtime.config,
    sendCode,
    verifyCode,
    signOut,
    accessToken: () => sessionRef.current?.accessToken ?? null,
  }), [
    error,
    pendingEmail,
    phase,
    runtime.client,
    runtime.config,
    sendCode,
    session,
    signOut,
    verifyCode,
  ]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
