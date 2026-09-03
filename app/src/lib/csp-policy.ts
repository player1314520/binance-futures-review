export function buildContentSecurityPolicy(supabaseUrl: string): string {
  let connectSource = '';
  if (supabaseUrl.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(supabaseUrl);
    } catch {
      throw new Error('CSP_SUPABASE_ORIGIN_INVALID');
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.port
      || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
    ) throw new Error('CSP_SUPABASE_ORIGIN_INVALID');
    connectSource = ` ${parsed.origin}`;
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${connectSource}`,
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ') + ';';
}
