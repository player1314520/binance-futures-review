import { describe, expect, it } from 'vitest';
import { ProductionConfigError, readProductionConfig } from './production-config';

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

describe('readProductionConfig', () => {
  it('keeps an unconfigured build offline', () => {
    expect(readProductionConfig({})).toBeNull();
  });

  it('accepts an https URL and browser publishable key', () => {
    expect(readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co/',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    })).toEqual({
      supabaseUrl: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    });
  });

  it('rejects partial, insecure, credentialed, and service-role configuration', () => {
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
    })).toThrow(ProductionConfigError);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'http://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    })).toThrow(/HTTPS/);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://user:password@project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
    })).toThrow(/HTTPS/);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'service_role' }),
    })).toThrow(/service_role/);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnopqrstuvwxyz',
    })).toThrow(/管理密钥|publishable/);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'opaque-browser-key-that-has-no-role',
    })).toThrow(/publishable/);
    expect(() => readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'authenticated' }),
    })).toThrow(/publishable/);
  });

  it('accepts a legacy Supabase anon JWT but no other JWT role', () => {
    const anon = jwt({ role: 'anon' });
    expect(readProductionConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: anon,
    })?.publishableKey).toBe(anon);
  });
});
