export type ReviewGrade = 'A' | 'B' | 'C' | 'D';

export type TradeReview = Readonly<{
  saw: string;
  happened: string;
  lesson: string;
  grade: ReviewGrade;
  reviewed: boolean;
  updatedAt: number;
}>;

export type ReviewDraft = Omit<TradeReview, 'updatedAt'>;
export type ReviewMap = Record<string, TradeReview>;

const PREFIX = 'rv-review-v1:';
const LEGACY_SESSION_KEY = 'rv2-session';
export const MAX_REVIEW_FIELD_LENGTH = 600;
const MAX_REVIEWS = 10_000;
const STORAGE_BUDGET = 5_000_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TRADE_IDENTITY_FIELDS = Object.freeze([
  'id',
  'symbol',
  'market',
  'side',
  'entryTime',
  'exitTime',
  'entryPrice',
  'exitPrice',
  'qty',
  'notional',
  'fee',
  'pnl',
  'currency',
]);

function safeScope(scope: string | null): string | null {
  return typeof scope === 'string' && /^[a-z0-9][a-z0-9-]{2,95}$/i.test(scope)
    ? scope
    : null;
}

function safeTradeId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    && !DANGEROUS_KEYS.has(value);
}

function emptyReviewMap(): ReviewMap {
  return Object.create(null) as ReviewMap;
}

export function reviewStorageKey(scope: string | null): string | null {
  const normalized = safeScope(scope);
  return normalized ? `${PREFIX}${normalized}` : null;
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_REVIEW_FIELD_LENGTH)
    : '';
}

function normalizeReview(value: unknown): TradeReview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const grade = typeof source.grade === 'string'
    && ['A', 'B', 'C', 'D'].includes(source.grade)
    ? source.grade as ReviewGrade
    : 'C';
  return Object.freeze({
    saw: text(source.saw),
    happened: text(source.happened),
    lesson: text(source.lesson),
    grade,
    reviewed: source.reviewed === true,
    updatedAt: Number.isSafeInteger(source.updatedAt) && Number(source.updatedAt) >= 0
      ? Number(source.updatedAt)
      : Date.now(),
  });
}

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

export function normalizeReviewMap(value: unknown): ReviewMap | null {
  const rows = strictRecord(value);
  if (!rows || Object.keys(rows).length > MAX_REVIEWS) return null;
  const result = emptyReviewMap();
  for (const [tradeId, candidate] of Object.entries(rows)) {
    if (!safeTradeId(tradeId)) return null;
    const row = strictRecord(candidate);
    if (!row) return null;
    const expected = ['saw', 'happened', 'lesson', 'grade', 'reviewed', 'updatedAt'].sort();
    const actual = Object.keys(row).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
    if (
      typeof row.saw !== 'string'
      || typeof row.happened !== 'string'
      || typeof row.lesson !== 'string'
      || [row.saw, row.happened, row.lesson].some((item) => item.length > MAX_REVIEW_FIELD_LENGTH)
      || typeof row.grade !== 'string'
      || !['A', 'B', 'C', 'D'].includes(row.grade)
      || typeof row.reviewed !== 'boolean'
      || !Number.isSafeInteger(row.updatedAt)
      || Number(row.updatedAt) < 0
    ) return null;
    Object.defineProperty(result, tradeId, { value: Object.freeze({
      saw: row.saw.trim(),
      happened: row.happened.trim(),
      lesson: row.lesson.trim(),
      grade: row.grade as ReviewGrade,
      reviewed: row.reviewed,
      updatedAt: Number(row.updatedAt),
    }), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function serializeReviewMap(value: unknown): string | null {
  const normalized = normalizeReviewMap(value);
  if (!normalized) return null;
  const serialized = JSON.stringify(normalized);
  return serialized.length <= STORAGE_BUDGET ? serialized : null;
}

export function exportReviewsScope(scope: string | null): string | null {
  const key = reviewStorageKey(scope);
  if (!key) return null;
  return serializeReviewMap(loadReviews(scope));
}

export function replaceReviewsScope(scope: string | null, rawOrMap: string | unknown): ReviewMap | null {
  const key = reviewStorageKey(scope);
  if (!key) return null;
  let value = rawOrMap;
  if (typeof rawOrMap === 'string') {
    if (rawOrMap.length > STORAGE_BUDGET) return null;
    try {
      value = JSON.parse(rawOrMap);
    } catch {
      return null;
    }
  }
  const normalized = normalizeReviewMap(value);
  const serialized = normalized ? serializeReviewMap(normalized) : null;
  if (!normalized || serialized === null) return null;
  try {
    localStorage.setItem(key, serialized);
    return normalized;
  } catch {
    return null;
  }
}

export function loadReviews(scope: string | null): ReviewMap {
  const key = reviewStorageKey(scope);
  if (!key) return emptyReviewMap();
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > STORAGE_BUDGET) return emptyReviewMap();
    const parsed = JSON.parse(raw);
    if (!strictRecord(parsed)) return emptyReviewMap();
    const result = emptyReviewMap();
    for (const [tradeId, candidate] of Object.entries(parsed).slice(0, MAX_REVIEWS)) {
      if (!safeTradeId(tradeId)) continue;
      const review = normalizeReview(candidate);
      if (review) {
        Object.defineProperty(result, tradeId, {
          value: review, enumerable: true, configurable: true, writable: true,
        });
      }
    }
    return result;
  } catch (_error) {
    return emptyReviewMap();
  }
}

export function saveReview(
  scope: string | null,
  tradeId: string,
  draft: ReviewDraft,
): boolean {
  const key = reviewStorageKey(scope);
  if (!key || !safeTradeId(tradeId)) return false;
  if ([draft.saw, draft.happened, draft.lesson].some((value) => (
    typeof value !== 'string' || value.trim().length > MAX_REVIEW_FIELD_LENGTH
  ))) return false;
  const normalized = normalizeReview({ ...draft, updatedAt: Date.now() });
  if (!normalized) return false;
  try {
    const reviews = loadReviews(scope);
    reviews[tradeId] = normalized;
    localStorage.setItem(key, JSON.stringify(reviews));
    return true;
  } catch (_error) {
    return false;
  }
}

export function clearLocalReviewData(): number {
  let removed = 0;
  try {
    const keys = Array.from({ length: localStorage.length }, (_value, index) => (
      localStorage.key(index)
    )).filter((key): key is string => typeof key === 'string');
    for (const key of keys) {
      if (key === LEGACY_SESSION_KEY || key.startsWith(PREFIX)) {
        localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch (_error) {}
  return removed;
}

export async function datasetReviewScope(
  trades: readonly Record<string, unknown>[],
): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const normalized = trades.map((trade) => Object.fromEntries(
    TRADE_IDENTITY_FIELDS.map((field) => {
      const value = trade[field];
      return [field, (
        typeof value === 'string'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
      ) ? value : null];
    }),
  ));
  const rows = normalized
    .map((trade) => JSON.stringify(trade))
    .sort();
  const canonical = JSON.stringify({
    version: 'rv-import-review-scope/2',
    rows,
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `import-v2-${hex.slice(0, 32)}`;
}
