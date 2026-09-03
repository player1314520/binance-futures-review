export type ProductionConfig = Readonly<{
  supabaseUrl: string;
  publishableKey: string;
}>;

export class ProductionConfigError extends Error {
  readonly code = 'PRODUCTION_CONFIG_INVALID';
}

function decodeJwtPayload(value: string): Record<string, unknown> | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[1].length / 4) * 4,
      '=',
    );
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function assertPublishableKey(value: string): string {
  const key = value.trim();
  if (key.length < 20 || key.length > 4096 || /\s/.test(key)) {
    throw new ProductionConfigError('Supabase publishable key 格式无效');
  }
  const payload = decodeJwtPayload(key);
  if (
    /^sb_secret_/i.test(key)
    || /service[_-]?role/i.test(key)
    || payload?.role === 'service_role'
    || payload?.role === 'supabase_admin'
  ) {
    throw new ProductionConfigError('浏览器配置禁止 service_role 或管理密钥');
  }
  const modernPublishable = /^sb_publishable_[A-Za-z0-9_-]{20,}$/i.test(key);
  const legacyAnon = payload?.role === 'anon';
  if (!modernPublishable && !legacyAnon) {
    throw new ProductionConfigError('浏览器配置只接受 Supabase publishable key 或 legacy anon key');
  }
  return key;
}

function assertSupabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProductionConfigError('Supabase URL 格式无效');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new ProductionConfigError('Supabase URL 必须是无凭据、无参数的 HTTPS 地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function readProductionConfig(env: Record<string, unknown>): ProductionConfig | null {
  const rawUrl = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL : '';
  const rawKey = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === 'string'
    ? env.VITE_SUPABASE_PUBLISHABLE_KEY
    : '';
  if (!rawUrl && !rawKey) return null;
  if (!rawUrl || !rawKey) {
    throw new ProductionConfigError('生产后端配置必须同时提供 URL 与 publishable key');
  }
  return Object.freeze({
    supabaseUrl: assertSupabaseUrl(rawUrl),
    publishableKey: assertPublishableKey(rawKey),
  });
}
