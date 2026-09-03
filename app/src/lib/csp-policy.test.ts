import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from './csp-policy';

describe('production Content Security Policy', () => {
  it('allows only self plus the exact configured Supabase HTTPS origin', () => {
    expect(buildContentSecurityPolicy('https://project-ref.supabase.co'))
      .toContain("connect-src 'self' https://project-ref.supabase.co");
    expect(buildContentSecurityPolicy('')).toContain("connect-src 'self';");
  });

  it('rejects unsafe or imprecise origins', () => {
    for (const value of [
      'http://project.supabase.co',
      'https://user:pass@project.supabase.co',
      'https://project.supabase.co/rest/v1',
      'https://project.supabase.co?x=1',
      'https://evil.example.com',
    ]) {
      expect(() => buildContentSecurityPolicy(value)).toThrow(/CSP_SUPABASE_ORIGIN_INVALID/);
    }
  });

  it('does not permit inline script, eval, frames, objects, or arbitrary forms', () => {
    const policy = buildContentSecurityPolicy('https://project-ref.supabase.co');
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("form-action 'none'");
  });
});
