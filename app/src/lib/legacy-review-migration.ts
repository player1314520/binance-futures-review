import { canonicalJson } from './canonical-json';
import {
  MAX_REVIEW_FIELD_LENGTH,
  type ReviewGrade,
  type ReviewMap,
  type TradeReview,
} from './review-storage';

export const CLASSIC_REVIEW_EXPORT_FORMAT = 'rv-classic-review-export/1' as const;
export const LEGACY_REVIEW_MIGRATION_PLAN_FORMAT = 'rv-classic-review-migration-plan/1' as const;
export const LEGACY_REVIEW_MIGRATION_RECEIPT_FORMAT = 'rv-classic-review-migration-receipt/1' as const;

export const LEGACY_REVIEW_MIGRATION_LIMITS = Object.freeze({
  serializedBytes: 5_000_000,
  reviewCount: 10_000,
  sourceFieldCharacters: 20_000,
  totalReviewCharacters: 2_000_000,
  currentTradeCount: 250_000,
  currentTradeIdCharacters: 16_000_000,
});

const TRADE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const REVIEW_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REVIEW_ENTRY_KEYS = Object.freeze(['tradeId', 'saw', 'did', 'learn', 'grade', 'reviewed']);
const RISK_KEYS = Object.freeze(['maxLoss', 'maxTrades', 'maxRiskR']);
const encoder = new TextEncoder();
// Plans are runtime capabilities, not an import format. Branding prevents a
// caller from bypassing the strict export parser by fabricating entries or
// candidates. Every retained nested value is frozen before a plan is branded.
const unboundPlanBrand = new WeakSet<object>();
const boundPlanBrand = new WeakSet<object>();

export type LegacyRiskLimits = Readonly<{
  maxLoss: number;
  maxTrades: number;
  maxRiskR: number;
}>;

export type LegacyReviewMigrationIssueCode =
  | 'MISSING_FIELD'
  | 'MISSING_GRADE'
  | 'INVALID_GRADE'
  | 'FIELD_TOO_LONG'
  | 'INVALID_FIELD_CONTENT';

export type LegacyReviewMigrationIssue = Readonly<{
  code: LegacyReviewMigrationIssueCode;
  field: 'saw' | 'did' | 'learn' | 'grade' | 'reviewed';
  tradeId: string;
}>;

export type LegacyReviewMigrationDraft = Readonly<{
  saw: string;
  happened: string;
  lesson: string;
  grade: ReviewGrade;
  reviewed: boolean;
}>;

export type LegacyReviewMigrationEntry = Readonly<{
  tradeId: string;
  review: LegacyReviewMigrationDraft | null;
  issues: readonly LegacyReviewMigrationIssue[];
}>;

export type LegacyReviewMigrationCandidate = Readonly<{
  tradeId: string;
  match: 'exact-trade-id';
  review: LegacyReviewMigrationDraft;
}>;

export type LegacyReviewMigrationBinding = Readonly<{
  reviewScope: string;
  tradeSetDigest: string;
}>;

export type LegacyReviewMigrationPlan = Readonly<{
  format: typeof LEGACY_REVIEW_MIGRATION_PLAN_FORMAT;
  state: 'unbound' | 'bound';
  sourceDigest: string;
  binding: LegacyReviewMigrationBinding | null;
  entries: readonly LegacyReviewMigrationEntry[];
  candidates: readonly LegacyReviewMigrationCandidate[];
  issues: readonly LegacyReviewMigrationIssue[];
  invalidCount: number;
  unmatchedCount: number;
  riskLimits: Readonly<{
    disposition: 'display-only';
    values: LegacyRiskLimits | null;
  }>;
  lineage: Readonly<{
    status: 'unsupported';
    code: 'CSV_LINEAGE_RECOMPUTE_UNSUPPORTED';
  }>;
}>;

export type LegacyReviewMigrationReceipt = Readonly<{
  format: typeof LEGACY_REVIEW_MIGRATION_RECEIPT_FORMAT;
  sourceHash: string;
  bindingHash: string;
  selectionHash: string;
  resultHash: string;
  selectedCount: number;
  insertedCount: number;
  skippedExistingCount: number;
}>;

export type LegacyReviewMigrationErrorCode =
  | 'INVALID_EXPORT'
  | 'RESOURCE_LIMIT'
  | 'CRYPTO_UNAVAILABLE'
  | 'INVALID_PLAN'
  | 'INVALID_BINDING'
  | 'STALE_BINDING'
  | 'INVALID_SELECTION'
  | 'INVALID_EXISTING_REVIEWS';

export class LegacyReviewMigrationError extends Error {
  constructor(readonly code: LegacyReviewMigrationErrorCode) {
    super(code);
    this.name = 'LegacyReviewMigrationError';
  }
}

type PlainRecord = Record<string, unknown>;

function fail(code: LegacyReviewMigrationErrorCode): never {
  throw new LegacyReviewMigrationError(code);
}

function plainRecord(value: unknown, code: LegacyReviewMigrationErrorCode): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) fail(code);
  return value as PlainRecord;
}

function ownValue(record: PlainRecord, key: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, value: undefined };
  if (!('value' in descriptor)) fail('INVALID_EXPORT');
  return { present: true, value: descriptor.value };
}

function exactKeys(record: PlainRecord, allowed: readonly string[], required: readonly string[]): void {
  const names = Object.getOwnPropertyNames(record);
  if (names.some((name) => !allowed.includes(name))) fail('INVALID_EXPORT');
  if (required.some((name) => !Object.hasOwn(record, name))) fail('INVALID_EXPORT');
}

function strictArray(value: unknown, maximum: number, code: LegacyReviewMigrationErrorCode): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code);
  const extraNames = Object.getOwnPropertyNames(value).filter((name) => name !== 'length');
  if (
    extraNames.length !== value.length
    || extraNames.some((name, index) => name !== String(index))
    || extraNames.some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !('value' in descriptor);
    })
  ) fail(code);
  return value;
}

function safeTradeId(value: unknown, code: LegacyReviewMigrationErrorCode): string {
  if (
    typeof value !== 'string'
    || !TRADE_ID_PATTERN.test(value)
    || DANGEROUS_KEYS.has(value)
  ) fail(code);
  return value;
}

function safeReviewScope(value: unknown): string {
  if (
    typeof value !== 'string'
    || !REVIEW_SCOPE_PATTERN.test(value)
    || DANGEROUS_KEYS.has(value)
  ) fail('INVALID_BINDING');
  return value;
}

function finiteRiskNumber(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > Number.MAX_SAFE_INTEGER
  ) fail('INVALID_EXPORT');
  return Object.is(value, -0) ? 0 : value;
}

function normalizeRiskLimits(value: unknown): LegacyRiskLimits | null {
  if (value === null) return null;
  const row = plainRecord(value, 'INVALID_EXPORT');
  exactKeys(row, RISK_KEYS, RISK_KEYS);
  const maxLoss = finiteRiskNumber(row.maxLoss);
  const maxTrades = finiteRiskNumber(row.maxTrades);
  const maxRiskR = finiteRiskNumber(row.maxRiskR);
  if (!Number.isSafeInteger(maxTrades)) fail('INVALID_EXPORT');
  return Object.freeze({ maxLoss, maxTrades, maxRiskR });
}

function reviewIssue(
  tradeId: string,
  field: LegacyReviewMigrationIssue['field'],
  code: LegacyReviewMigrationIssueCode,
): LegacyReviewMigrationIssue {
  return Object.freeze({ code, field, tradeId });
}

function optionalSourceString(
  row: PlainRecord,
  field: 'saw' | 'did' | 'learn' | 'grade',
): string | undefined {
  const entry = ownValue(row, field);
  if (!entry.present || entry.value === undefined || entry.value === null) return undefined;
  if (typeof entry.value !== 'string') fail('INVALID_EXPORT');
  if (entry.value.length > LEGACY_REVIEW_MIGRATION_LIMITS.sourceFieldCharacters) fail('RESOURCE_LIMIT');
  return entry.value;
}

function optionalSourceBoolean(row: PlainRecord, field: 'reviewed'): boolean | undefined {
  const entry = ownValue(row, field);
  if (!entry.present || entry.value === undefined || entry.value === null) return undefined;
  if (typeof entry.value !== 'boolean') fail('INVALID_EXPORT');
  return entry.value;
}

type SourceReviewProjection = Readonly<{
  tradeId: string;
  saw?: string;
  did?: string;
  learn?: string;
  grade?: string;
  reviewed?: boolean;
}>;

function projectSourceReview(value: unknown): SourceReviewProjection {
  const row = plainRecord(value, 'INVALID_EXPORT');
  exactKeys(row, REVIEW_ENTRY_KEYS, ['tradeId']);
  const tradeId = safeTradeId(row.tradeId, 'INVALID_EXPORT');
  const projected: {
    tradeId: string;
    saw?: string;
    did?: string;
    learn?: string;
    grade?: string;
    reviewed?: boolean;
  } = { tradeId };
  const saw = optionalSourceString(row, 'saw');
  const did = optionalSourceString(row, 'did');
  const learn = optionalSourceString(row, 'learn');
  const grade = optionalSourceString(row, 'grade');
  const reviewed = optionalSourceBoolean(row, 'reviewed');
  if (saw !== undefined) projected.saw = saw;
  if (did !== undefined) projected.did = did;
  if (learn !== undefined) projected.learn = learn;
  if (grade !== undefined) projected.grade = grade;
  if (reviewed !== undefined) projected.reviewed = reviewed;
  return Object.freeze(projected);
}

function entryFromProjection(source: SourceReviewProjection): LegacyReviewMigrationEntry {
  const issues: LegacyReviewMigrationIssue[] = [];
  const textFields = [
    ['saw', source.saw],
    ['did', source.did],
    ['learn', source.learn],
  ] as const;
  for (const [field, value] of textFields) {
    if (value === undefined) issues.push(reviewIssue(source.tradeId, field, 'MISSING_FIELD'));
    else if (value.length > MAX_REVIEW_FIELD_LENGTH) {
      issues.push(reviewIssue(source.tradeId, field, 'FIELD_TOO_LONG'));
    } else if (/\u0000/u.test(value)) {
      issues.push(reviewIssue(source.tradeId, field, 'INVALID_FIELD_CONTENT'));
    }
  }
  if (source.grade === undefined) {
    issues.push(reviewIssue(source.tradeId, 'grade', 'MISSING_GRADE'));
  } else if (!['A', 'B', 'C', 'D'].includes(source.grade)) {
    issues.push(reviewIssue(source.tradeId, 'grade', 'INVALID_GRADE'));
  }
  if (source.reviewed === undefined) {
    issues.push(reviewIssue(source.tradeId, 'reviewed', 'MISSING_FIELD'));
  }

  const frozenIssues = Object.freeze(issues);
  if (frozenIssues.length > 0) {
    return Object.freeze({ tradeId: source.tradeId, review: null, issues: frozenIssues });
  }
  return Object.freeze({
    tradeId: source.tradeId,
    review: Object.freeze({
      saw: source.saw!,
      happened: source.did!,
      lesson: source.learn!,
      grade: source.grade as ReviewGrade,
      reviewed: source.reviewed!,
    }),
    issues: frozenIssues,
  });
}

async function sha256Canonical(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('CRYPTO_UNAVAILABLE');
  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      encoder.encode(canonicalJson(value)),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch (error) {
    if (error instanceof LegacyReviewMigrationError) throw error;
    return fail('CRYPTO_UNAVAILABLE');
  }
}

function parseInput(input: unknown): PlainRecord {
  if (typeof input !== 'string') return plainRecord(input, 'INVALID_EXPORT');
  if (encoder.encode(input).byteLength > LEGACY_REVIEW_MIGRATION_LIMITS.serializedBytes) {
    fail('RESOURCE_LIMIT');
  }
  try {
    return plainRecord(JSON.parse(input), 'INVALID_EXPORT');
  } catch (error) {
    if (error instanceof LegacyReviewMigrationError) throw error;
    return fail('INVALID_EXPORT');
  }
}

const LINEAGE_UNSUPPORTED = Object.freeze({
  status: 'unsupported' as const,
  code: 'CSV_LINEAGE_RECOMPUTE_UNSUPPORTED' as const,
});

export async function parseLegacyReviewExport(input: unknown): Promise<LegacyReviewMigrationPlan> {
  const row = parseInput(input);
  exactKeys(row, ['format', 'reviews', 'riskLimits'], ['format', 'reviews', 'riskLimits']);
  if (row.format !== CLASSIC_REVIEW_EXPORT_FORMAT) fail('INVALID_EXPORT');
  const reviewRows = strictArray(
    row.reviews,
    LEGACY_REVIEW_MIGRATION_LIMITS.reviewCount,
    'RESOURCE_LIMIT',
  );

  const seen = new Set<string>();
  let totalCharacters = 0;
  const sourceReviews = reviewRows.map((candidate) => {
    const projected = projectSourceReview(candidate);
    if (seen.has(projected.tradeId)) fail('INVALID_EXPORT');
    seen.add(projected.tradeId);
    totalCharacters += projected.tradeId.length;
    for (const field of ['saw', 'did', 'learn', 'grade'] as const) {
      totalCharacters += projected[field]?.length ?? 0;
    }
    if (totalCharacters > LEGACY_REVIEW_MIGRATION_LIMITS.totalReviewCharacters) {
      fail('RESOURCE_LIMIT');
    }
    return projected;
  });
  const riskLimits = normalizeRiskLimits(row.riskLimits);
  const normalizedSource = Object.freeze({
    format: CLASSIC_REVIEW_EXPORT_FORMAT,
    reviews: Object.freeze(sourceReviews),
    riskLimits,
  });
  const entries = Object.freeze(sourceReviews.map(entryFromProjection));
  const issues = Object.freeze(entries.flatMap((entry) => entry.issues));
  const plan: LegacyReviewMigrationPlan = Object.freeze({
    format: LEGACY_REVIEW_MIGRATION_PLAN_FORMAT,
    state: 'unbound',
    sourceDigest: await sha256Canonical(normalizedSource),
    binding: null,
    entries,
    candidates: Object.freeze([]),
    issues,
    invalidCount: entries.filter((entry) => entry.review === null).length,
    unmatchedCount: 0,
    riskLimits: Object.freeze({ disposition: 'display-only', values: riskLimits }),
    lineage: LINEAGE_UNSUPPORTED,
  });
  unboundPlanBrand.add(plan);
  return plan;
}

function normalizedTradeIds(
  value: unknown,
  code: LegacyReviewMigrationErrorCode,
  maximum: number = LEGACY_REVIEW_MIGRATION_LIMITS.currentTradeCount,
): readonly string[] {
  const rows = strictArray(value, maximum, code);
  let characters = 0;
  const seen = new Set<string>();
  const ids = rows.map((candidate) => {
    const id = safeTradeId(candidate, code);
    characters += id.length;
    if (
      characters > LEGACY_REVIEW_MIGRATION_LIMITS.currentTradeIdCharacters
      || seen.has(id)
    ) fail(code);
    seen.add(id);
    return id;
  });
  return Object.freeze(ids.sort());
}

export async function computeLegacyTradeSetDigest(currentTradeIds: readonly string[]): Promise<string> {
  const tradeIds = normalizedTradeIds(currentTradeIds, 'INVALID_BINDING');
  return sha256Canonical(Object.freeze({
    format: 'rv-classic-trade-set/1',
    tradeIds,
  }));
}

function validateUnboundPlan(plan: LegacyReviewMigrationPlan): void {
  if (
    !plan
    || !unboundPlanBrand.has(plan)
    || plan.format !== LEGACY_REVIEW_MIGRATION_PLAN_FORMAT
    || plan.state !== 'unbound'
    || plan.binding !== null
    || !SHA256_PATTERN.test(plan.sourceDigest)
    || !Array.isArray(plan.entries)
    || plan.candidates.length !== 0
  ) fail('INVALID_PLAN');
}

export async function bindLegacyReviewMigrationPlan(
  plan: LegacyReviewMigrationPlan,
  context: Readonly<{ reviewScope: string; currentTradeIds: readonly string[] }>,
): Promise<LegacyReviewMigrationPlan> {
  validateUnboundPlan(plan);
  const reviewScope = safeReviewScope(context?.reviewScope);
  const currentTradeIds = normalizedTradeIds(context?.currentTradeIds, 'INVALID_BINDING');
  const current = new Set(currentTradeIds);
  const candidates = Object.freeze(plan.entries
    .filter((entry): entry is LegacyReviewMigrationEntry & { review: LegacyReviewMigrationDraft } => (
      entry.review !== null && current.has(entry.tradeId)
    ))
    .map((entry) => Object.freeze({
      tradeId: entry.tradeId,
      match: 'exact-trade-id' as const,
      review: entry.review,
    }))
    .sort((left, right) => left.tradeId.localeCompare(right.tradeId)));
  const validCount = plan.entries.length - plan.invalidCount;
  const boundPlan: LegacyReviewMigrationPlan = Object.freeze({
    ...plan,
    state: 'bound',
    binding: Object.freeze({
      reviewScope,
      tradeSetDigest: await computeLegacyTradeSetDigest(currentTradeIds),
    }),
    candidates,
    unmatchedCount: validCount - candidates.length,
  });
  boundPlanBrand.add(boundPlan);
  return boundPlan;
}

function validateExistingReview(value: unknown): TradeReview {
  const row = plainRecord(value, 'INVALID_EXISTING_REVIEWS');
  const required = ['saw', 'happened', 'lesson', 'grade', 'reviewed', 'updatedAt'];
  const names = Object.getOwnPropertyNames(row);
  if (names.length !== required.length || names.some((name) => !required.includes(name))) {
    fail('INVALID_EXISTING_REVIEWS');
  }
  if (
    typeof row.saw !== 'string'
    || typeof row.happened !== 'string'
    || typeof row.lesson !== 'string'
    || row.saw.length > MAX_REVIEW_FIELD_LENGTH
    || row.happened.length > MAX_REVIEW_FIELD_LENGTH
    || row.lesson.length > MAX_REVIEW_FIELD_LENGTH
    || typeof row.grade !== 'string'
    || !['A', 'B', 'C', 'D'].includes(row.grade)
    || typeof row.reviewed !== 'boolean'
    || !Number.isSafeInteger(row.updatedAt)
    || Number(row.updatedAt) < 0
  ) fail('INVALID_EXISTING_REVIEWS');
  return Object.freeze({
    saw: row.saw,
    happened: row.happened,
    lesson: row.lesson,
    grade: row.grade as ReviewGrade,
    reviewed: row.reviewed,
    updatedAt: Number(row.updatedAt),
  }) as TradeReview;
}

function cloneExistingReviews(value: unknown): ReviewMap {
  const source = plainRecord(value, 'INVALID_EXISTING_REVIEWS');
  const ids = Object.getOwnPropertyNames(source);
  if (ids.length > LEGACY_REVIEW_MIGRATION_LIMITS.reviewCount) fail('RESOURCE_LIMIT');
  const result: ReviewMap = Object.create(null) as ReviewMap;
  for (const id of ids) {
    safeTradeId(id, 'INVALID_EXISTING_REVIEWS');
    Object.defineProperty(result, id, {
      value: validateExistingReview(ownValue(source, id).value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateBoundPlan(plan: LegacyReviewMigrationPlan): asserts plan is LegacyReviewMigrationPlan & {
  state: 'bound';
  binding: LegacyReviewMigrationBinding;
} {
  if (
    !plan
    || !boundPlanBrand.has(plan)
    || plan.format !== LEGACY_REVIEW_MIGRATION_PLAN_FORMAT
    || plan.state !== 'bound'
    || !plan.binding
    || !SHA256_PATTERN.test(plan.sourceDigest)
    || !SHA256_PATTERN.test(plan.binding.tradeSetDigest)
    || !Array.isArray(plan.candidates)
  ) fail('INVALID_PLAN');
}

async function computeLegacyMigrationResultHash(
  receipt: Pick<LegacyReviewMigrationReceipt,
    'sourceHash' | 'bindingHash' | 'selectionHash'
    | 'selectedCount' | 'insertedCount' | 'skippedExistingCount'>,
  reviews: ReviewMap,
): Promise<string> {
  return sha256Canonical(Object.freeze({
    format: 'rv-classic-review-migration-result/1',
    sourceHash: receipt.sourceHash,
    bindingHash: receipt.bindingHash,
    selectionHash: receipt.selectionHash,
    selectedCount: receipt.selectedCount,
    insertedCount: receipt.insertedCount,
    skippedExistingCount: receipt.skippedExistingCount,
    reviews,
  }));
}

export async function verifyLegacyReviewMigrationReceipt(
  receipt: unknown,
  reviews: ReviewMap,
): Promise<boolean> {
  try {
    const row = plainRecord(receipt, 'INVALID_PLAN');
    const expectedKeys = [
      'format', 'sourceHash', 'bindingHash', 'selectionHash', 'resultHash',
      'selectedCount', 'insertedCount', 'skippedExistingCount',
    ].sort();
    const actualKeys = Object.getOwnPropertyNames(row).sort();
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
      || row.format !== LEGACY_REVIEW_MIGRATION_RECEIPT_FORMAT
      || typeof row.sourceHash !== 'string'
      || !SHA256_PATTERN.test(row.sourceHash)
      || typeof row.bindingHash !== 'string'
      || !SHA256_PATTERN.test(row.bindingHash)
      || typeof row.selectionHash !== 'string'
      || !SHA256_PATTERN.test(row.selectionHash)
      || typeof row.resultHash !== 'string'
      || !SHA256_PATTERN.test(row.resultHash)
      || !Number.isSafeInteger(row.selectedCount)
      || Number(row.selectedCount) < 0
      || !Number.isSafeInteger(row.insertedCount)
      || Number(row.insertedCount) < 0
      || !Number.isSafeInteger(row.skippedExistingCount)
      || Number(row.skippedExistingCount) < 0
      || Number(row.selectedCount) !== Number(row.insertedCount) + Number(row.skippedExistingCount)
    ) return false;
    const normalizedReviews = Object.freeze(cloneExistingReviews(reviews));
    const expected = await computeLegacyMigrationResultHash({
      sourceHash: row.sourceHash,
      bindingHash: row.bindingHash,
      selectionHash: row.selectionHash,
      selectedCount: Number(row.selectedCount),
      insertedCount: Number(row.insertedCount),
      skippedExistingCount: Number(row.skippedExistingCount),
    }, normalizedReviews);
    return expected === row.resultHash;
  } catch {
    return false;
  }
}

export async function mergeLegacyReviewMigration(
  plan: LegacyReviewMigrationPlan,
  input: Readonly<{
    reviewScope: string;
    currentTradeIds: readonly string[];
    selectedTradeIds: readonly string[];
    existingReviews: ReviewMap;
    now?: number;
  }>,
): Promise<Readonly<{ reviews: ReviewMap; receipt: LegacyReviewMigrationReceipt }>> {
  validateBoundPlan(plan);
  const reviewScope = safeReviewScope(input?.reviewScope);
  const currentTradeIds = normalizedTradeIds(input?.currentTradeIds, 'INVALID_BINDING');
  const tradeSetDigest = await computeLegacyTradeSetDigest(currentTradeIds);
  if (
    plan.binding.reviewScope !== reviewScope
    || plan.binding.tradeSetDigest !== tradeSetDigest
  ) fail('STALE_BINDING');

  const selectedTradeIds = normalizedTradeIds(
    input?.selectedTradeIds,
    'INVALID_SELECTION',
    LEGACY_REVIEW_MIGRATION_LIMITS.reviewCount,
  );
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.tradeId, candidate]));
  if (selectedTradeIds.some((tradeId) => !candidates.has(tradeId))) fail('INVALID_SELECTION');
  const reviews = cloneExistingReviews(input?.existingReviews);
  let reviewCount = Object.keys(reviews).length;
  const now = input?.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_SELECTION');
  const inserted: string[] = [];
  let skippedExistingCount = 0;
  for (const tradeId of selectedTradeIds) {
    if (Object.hasOwn(reviews, tradeId)) {
      skippedExistingCount += 1;
      continue;
    }
    if (reviewCount >= LEGACY_REVIEW_MIGRATION_LIMITS.reviewCount) {
      fail('RESOURCE_LIMIT');
    }
    const candidate = candidates.get(tradeId)!;
    Object.defineProperty(reviews, tradeId, {
      value: Object.freeze({ ...candidate.review, updatedAt: now }),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    inserted.push(tradeId);
    reviewCount += 1;
  }

  const bindingHash = await sha256Canonical(Object.freeze({
    format: 'rv-classic-review-migration-binding/1',
    reviewScope,
    tradeSetDigest,
  }));
  const selectionHash = await sha256Canonical(Object.freeze({
    format: 'rv-classic-review-migration-selection/1',
    selectedTradeIds,
  }));
  const receiptBase = Object.freeze({
    format: LEGACY_REVIEW_MIGRATION_RECEIPT_FORMAT,
    sourceHash: plan.sourceDigest,
    bindingHash,
    selectionHash,
    selectedCount: selectedTradeIds.length,
    insertedCount: inserted.length,
    skippedExistingCount,
  });
  const receipt = Object.freeze({
    ...receiptBase,
    resultHash: await computeLegacyMigrationResultHash(receiptBase, reviews),
  });
  return Object.freeze({ reviews: Object.freeze(reviews), receipt });
}
