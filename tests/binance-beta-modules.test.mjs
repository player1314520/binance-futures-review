import assert from 'node:assert/strict';
import test from 'node:test';

const MODULES = [
  '../supabase/functions/binance-beta/crypto.mjs',
  '../supabase/functions/binance-beta/binance-client.mjs',
  '../supabase/functions/binance-beta/archive.mjs',
  '../supabase/functions/binance-beta/handler.mjs',
  '../supabase/functions/binance-beta/internal-handler.mjs',
  '../supabase/functions/binance-beta/runtime.mjs',
];

test('Binance Beta Edge exposes independently testable pure-logic modules', async () => {
  for (const specifier of MODULES) {
    await assert.doesNotReject(
      import(specifier),
      `expected ${specifier} to be importable`,
    );
  }
});
