import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson } from './canonical-json';

describe('canonical JSON', () => {
  it('sorts every object level while preserving array order', () => {
    expect(canonicalJson({
      z: 1,
      a: [{ y: true, x: 'first' }, null, -0],
      middle: { b: 2, a: 1 },
    })).toBe('{"a":[{"x":"first","y":true},null,0],"middle":{"a":1,"b":2},"z":1}');
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    undefined,
    new Date('2026-08-28T00:00:00Z'),
    Object.assign([1], { extra: true }),
  ])('rejects values outside the plain JSON data model', (value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it('rejects cycles and accessors without invoking an accessor', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);

    let invoked = false;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        invoked = true;
        return 'must not run';
      },
    });
    expect(() => canonicalJson(accessor)).toThrow(CanonicalJsonError);
    expect(invoked).toBe(false);
  });
});
