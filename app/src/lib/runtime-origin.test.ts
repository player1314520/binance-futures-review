import { describe, expect, it } from 'vitest';
import { runtimeOriginMatches } from './runtime-origin';

describe('runtime production origin boundary', () => {
  it('keeps local-demo builds usable when no production origin is configured', () => {
    expect(runtimeOriginMatches('', 'http://127.0.0.1:4173')).toBe(true);
  });

  it('accepts only the exact configured HTTPS origin', () => {
    expect(runtimeOriginMatches(
      'https://binance-futures-review-web.vercel.app',
      'https://binance-futures-review-web.vercel.app',
    )).toBe(true);
    expect(runtimeOriginMatches(
      'https://binance-futures-review-web.vercel.app',
      'https://preview-binance-futures-review.vercel.app',
    )).toBe(false);
  });

  it.each([
    'http://binance-futures-review-web.vercel.app',
    'https://binance-futures-review-web.vercel.app/path',
    'https://user@example.com',
  ])('rejects an unsafe configured origin: %s', (expected) => {
    expect(runtimeOriginMatches(expected, 'https://binance-futures-review-web.vercel.app')).toBe(false);
  });
});
