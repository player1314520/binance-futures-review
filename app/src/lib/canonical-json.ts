export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

const MAX_CANONICAL_JSON_DEPTH = 64;

export class CanonicalJsonError extends Error {
  readonly code = 'CANONICAL_JSON_INVALID';

  constructor() {
    super('Value is not valid canonical JSON data.');
    this.name = 'CanonicalJsonError';
  }
}

function invalidJson(): never {
  throw new CanonicalJsonError();
}

function serializeValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) invalidJson();
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) invalidJson();
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      return invalidJson();
  }

  if (ancestors.has(value)) invalidJson();
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length
      || keys.some((key, index) => key !== String(index))
    ) invalidJson();

    return `[${value.map((item) => (
      serializeValue(item, nextAncestors, depth + 1)
    )).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidJson();
  if (Object.getOwnPropertySymbols(value).some((symbol) => (
    Object.prototype.propertyIsEnumerable.call(value, symbol)
  ))) invalidJson();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(value).sort();
  const fields = keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) invalidJson();
    return `${JSON.stringify(key)}:${serializeValue(
      descriptor.value,
      nextAncestors,
      depth + 1,
    )}`;
  });
  return `{${fields.join(',')}}`;
}

/**
 * Serializes plain JSON data with recursively sorted object keys.
 *
 * Non-finite numbers, sparse arrays, accessors, custom prototypes, cycles and
 * values outside the JSON data model are rejected instead of being discarded.
 */
export function canonicalJson(value: JsonValue | unknown): string {
  return serializeValue(value, new Set(), 0);
}
