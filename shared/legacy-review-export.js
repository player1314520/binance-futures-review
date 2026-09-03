// Product-line-neutral, read-only bridge from the Classic localStorage shape
// into a deliberately narrow, versioned review-migration document. It never
// reads trade, credential, agent or API storage and never mutates Classic keys.

export const CLASSIC_REVIEW_EXPORT_FORMAT = 'rv-classic-review-export/1';

export const CLASSIC_REVIEW_EXPORT_LIMITS = Object.freeze({
  reviewCount: 10_000,
  sourceFieldCharacters: 20_000,
  totalReviewCharacters: 2_000_000,
  reviewsStorageBytes: 5_000_000,
  guardsStorageBytes: 16_384,
  serializedBytes: 5_000_000,
});

const REVIEW_STORAGE_KEY = 'rv-reviews';
const GUARD_STORAGE_KEY = 'rv-guards';
const REVIEW_FIELDS = Object.freeze(['saw', 'did', 'learn', 'grade', 'reviewed']);
const RISK_FIELDS = Object.freeze(['maxLoss', 'maxTrades', 'maxRiskR']);
const SAFE_TRADE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

export class ClassicReviewExportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ClassicReviewExportError';
    this.code = code;
  }
}

function fail(code) {
  throw new ClassicReviewExportError(code);
}

function plainRecord(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(value).some((symbol) => (
    Object.prototype.propertyIsEnumerable.call(value, symbol)
  ))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) fail(code);
  return value;
}

function ownValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!('value' in descriptor)) fail('INVALID_STORAGE_DATA');
  return { present: true, value: descriptor.value };
}

function readStorage(storage, key, byteLimit) {
  if (!storage || typeof storage.getItem !== 'function') fail('STORAGE_UNAVAILABLE');
  let raw;
  try {
    raw = storage.getItem(key);
  } catch (_error) {
    return fail('STORAGE_UNAVAILABLE');
  }
  if (raw === null) return null;
  if (typeof raw !== 'string') fail('INVALID_STORAGE_DATA');
  if (encoder.encode(raw).byteLength > byteLimit) fail('RESOURCE_LIMIT');
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fail('INVALID_STORAGE_DATA');
  }
}

function safeTradeId(value) {
  return typeof value === 'string'
    && SAFE_TRADE_ID.test(value)
    && !DANGEROUS_KEYS.has(value);
}

function normalizeReviewField(field, value) {
  // Classic uses `null` when a grade is toggled off. Preserve that absence so
  // the migration parser can raise a visible MISSING_GRADE issue; never invent C.
  if (value === null) return null;
  if (field === 'reviewed') {
    if (typeof value !== 'boolean') fail('INVALID_REVIEW_FIELD');
    return value;
  }
  if (typeof value !== 'string' || /\u0000/u.test(value)) fail('INVALID_REVIEW_FIELD');
  if (value.length > CLASSIC_REVIEW_EXPORT_LIMITS.sourceFieldCharacters) fail('RESOURCE_LIMIT');
  return value;
}

function exportReviews(parsed) {
  if (parsed === null) return Object.freeze([]);
  const source = plainRecord(parsed, 'INVALID_STORAGE_DATA');
  const tradeIds = Object.keys(source).sort();
  if (tradeIds.length > CLASSIC_REVIEW_EXPORT_LIMITS.reviewCount) fail('RESOURCE_LIMIT');

  let totalCharacters = 0;
  const reviews = tradeIds.map((tradeId) => {
    if (!safeTradeId(tradeId)) fail('INVALID_REVIEW_ID');
    const candidate = ownValue(source, tradeId).value;
    const review = plainRecord(candidate, 'INVALID_REVIEW_FIELD');
    const exported = { tradeId };
    for (const field of REVIEW_FIELDS) {
      const entry = ownValue(review, field);
      if (!entry.present) continue;
      const value = normalizeReviewField(field, entry.value);
      if (typeof value === 'string') {
        totalCharacters += value.length;
        if (totalCharacters > CLASSIC_REVIEW_EXPORT_LIMITS.totalReviewCharacters) fail('RESOURCE_LIMIT');
      }
      exported[field] = value;
    }
    return Object.freeze(exported);
  });
  return Object.freeze(reviews);
}

function finiteNonNegative(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function exportRiskLimits(parsed) {
  if (parsed === null) return null;
  const source = plainRecord(parsed, 'INVALID_RISK_LIMITS');
  const values = {};
  for (const field of RISK_FIELDS) {
    const entry = ownValue(source, field);
    if (!entry.present || !finiteNonNegative(entry.value)) fail('INVALID_RISK_LIMITS');
    if (field === 'maxTrades' && !Number.isSafeInteger(entry.value)) fail('INVALID_RISK_LIMITS');
    values[field] = Object.is(entry.value, -0) ? 0 : entry.value;
  }
  return Object.freeze(values);
}

export function buildClassicReviewExport(storage = globalThis.localStorage) {
  const reviews = exportReviews(readStorage(
    storage,
    REVIEW_STORAGE_KEY,
    CLASSIC_REVIEW_EXPORT_LIMITS.reviewsStorageBytes,
  ));
  const riskLimits = exportRiskLimits(readStorage(
    storage,
    GUARD_STORAGE_KEY,
    CLASSIC_REVIEW_EXPORT_LIMITS.guardsStorageBytes,
  ));
  return Object.freeze({
    format: CLASSIC_REVIEW_EXPORT_FORMAT,
    reviews,
    riskLimits,
  });
}

export function serializeClassicReviewExport(storage = globalThis.localStorage) {
  const serialized = JSON.stringify(buildClassicReviewExport(storage));
  if (encoder.encode(serialized).byteLength > CLASSIC_REVIEW_EXPORT_LIMITS.serializedBytes) {
    fail('RESOURCE_LIMIT');
  }
  return serialized;
}
