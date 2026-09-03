import { importArchive } from '@rv/engine';
import { canonicalJson, type JsonValue } from './canonical-json';
import { normalizeActionPlan, type ActionPlanMap } from './action-plan-storage';
import type { ReviewGrade, ReviewMap } from './review-storage';
import { VAULT_CRYPTO_LIMITS } from './vault-crypto';
import { readCsvFillLedgerExtension, replayCsvFillLedger } from './csv-fill-ledger';

export const WORKSPACE_SNAPSHOT_FORMAT = 'rv-workspace-snapshot/1' as const;
const MAX_REVIEWS = 10_000;
const MAX_ACTIONS = 2_000;
const MAX_JOURNAL_DAYS = 3_650;
const MAX_GUARDS = 200;
const MAX_TEXT = 600;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type SnapshotSourceEvidence = Readonly<{
  kind: 'empty' | 'csv' | 'binance-local';
  accepted: number;
  dropped: number;
  coverage: 'complete' | 'partial' | 'unknown';
  importedAt: number;
}>;

export type SnapshotJournalEntry = Readonly<{
  day: string;
  note: string;
  emotion: string;
  updatedAt: number;
}>;

export type SnapshotGuard = Readonly<{
  id: string;
  text: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type WorkspaceSnapshotV1 = Readonly<{
  format: typeof WORKSPACE_SNAPSHOT_FORMAT;
  generation: number;
  createdAt: number;
  engineVersion: string;
  source: SnapshotSourceEvidence;
  archive: JsonValue;
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
}>;

export class WorkspaceSnapshotError extends Error {
  readonly code = 'WORKSPACE_SNAPSHOT_INVALID';
}

function fail(): never {
  throw new WorkspaceSnapshotError('工作区快照格式无效');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail();
  return Number(value);
}

function safeText(value: unknown, maximum = MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > maximum || /\u0000/.test(value)) fail();
  return value.trim();
}

function safeId(value: unknown, maximum = 160): string {
  const id = safeText(value, maximum);
  if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id) || DANGEROUS_KEYS.has(id)) fail();
  return id;
}

function recursivelyFreezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const child of value) recursivelyFreezeJson(child);
  } else {
    for (const child of Object.values(value)) recursivelyFreezeJson(child);
  }
  return Object.freeze(value);
}

function normalizeSource(value: unknown): SnapshotSourceEvidence {
  const row = record(value);
  exact(row, ['kind', 'accepted', 'dropped', 'coverage', 'importedAt']);
  if (!['empty', 'csv', 'binance-local'].includes(String(row.kind))) fail();
  if (!['complete', 'partial', 'unknown'].includes(String(row.coverage))) fail();
  return Object.freeze({
    kind: row.kind as SnapshotSourceEvidence['kind'],
    accepted: safeInteger(row.accepted),
    dropped: safeInteger(row.dropped),
    coverage: row.coverage as SnapshotSourceEvidence['coverage'],
    importedAt: safeInteger(row.importedAt),
  });
}

function normalizeReviews(value: unknown): ReviewMap {
  const rows = record(value);
  if (Object.keys(rows).length > MAX_REVIEWS) fail();
  const result: ReviewMap = Object.create(null) as ReviewMap;
  for (const [tradeId, candidate] of Object.entries(rows)) {
    const row = record(candidate);
    exact(row, ['saw', 'happened', 'lesson', 'grade', 'reviewed', 'updatedAt']);
    if (typeof row.grade !== 'string' || !['A', 'B', 'C', 'D'].includes(row.grade)) fail();
    if (typeof row.reviewed !== 'boolean') fail();
    const safeTradeId = safeId(tradeId, 128);
    Object.defineProperty(result, safeTradeId, { value: Object.freeze({
      saw: safeText(row.saw),
      happened: safeText(row.happened),
      lesson: safeText(row.lesson),
      grade: row.grade as ReviewGrade,
      reviewed: row.reviewed,
      updatedAt: safeInteger(row.updatedAt),
    }), enumerable: true, configurable: true, writable: true });
  }
  return Object.freeze(result);
}

function normalizeActions(value: unknown): ActionPlanMap {
  const rows = record(value);
  if (Object.keys(rows).length > MAX_ACTIONS) fail();
  const result: ActionPlanMap = Object.create(null) as ActionPlanMap;
  for (const [actionId, candidate] of Object.entries(rows)) {
    const row = record(candidate);
    const legacyKeys = ['id', 'sourceTradeId', 'text', 'status', 'createdAt', 'updatedAt', 'completedAt'];
    const currentKeys = [...legacyKeys, 'experiment'];
    const actualKeys = Object.keys(row).sort();
    if (
      ![legacyKeys, currentKeys].some((keys) => {
        const expected = [...keys].sort();
        return expected.length === actualKeys.length
          && expected.every((key, index) => key === actualKeys[index]);
      })
    ) fail();
    const action = normalizeActionPlan(row);
    if (!action || action.id !== actionId || safeId(action.sourceTradeId, 128) !== action.sourceTradeId) fail();
    Object.defineProperty(result, action.id, {
      value: action, enumerable: true, configurable: true, writable: true,
    });
  }
  return Object.freeze(result);
}

function normalizeJournal(value: unknown): readonly SnapshotJournalEntry[] {
  if (!Array.isArray(value) || value.length > MAX_JOURNAL_DAYS) fail();
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    const row = record(candidate);
    exact(row, ['day', 'note', 'emotion', 'updatedAt']);
    const day = safeText(row.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || seen.has(day)) fail();
    seen.add(day);
    return Object.freeze({
      day,
      note: safeText(row.note, 4_000),
      emotion: safeText(row.emotion, 80),
      updatedAt: safeInteger(row.updatedAt),
    });
  }));
}

function normalizeGuards(value: unknown): readonly SnapshotGuard[] {
  if (!Array.isArray(value) || value.length > MAX_GUARDS) fail();
  const seen = new Set<string>();
  return Object.freeze(value.map((candidate) => {
    const row = record(candidate);
    exact(row, ['id', 'text', 'active', 'createdAt', 'updatedAt']);
    const id = safeId(row.id, 128);
    if (seen.has(id) || typeof row.active !== 'boolean') fail();
    seen.add(id);
    const createdAt = safeInteger(row.createdAt);
    const updatedAt = safeInteger(row.updatedAt);
    if (updatedAt < createdAt) fail();
    return Object.freeze({
      id,
      text: safeText(row.text),
      active: row.active,
      createdAt,
      updatedAt,
    });
  }));
}

export function normalizeWorkspaceSnapshot(value: unknown): WorkspaceSnapshotV1 {
  const row = record(value);
  exact(row, [
    'format',
    'generation',
    'createdAt',
    'engineVersion',
    'source',
    'archive',
    'reviews',
    'actions',
    'journal',
    'guards',
  ]);
  if (row.format !== WORKSPACE_SNAPSHOT_FORMAT) fail();
  const engineVersion = safeText(row.engineVersion, 80);
  if (!engineVersion || !/^[A-Za-z0-9._+-]+$/.test(engineVersion)) fail();

  const serializedArchive = canonicalJson(row.archive);
  if (new TextEncoder().encode(serializedArchive).byteLength > VAULT_CRYPTO_LIMITS.plaintextBytes) fail();
  const archive = recursivelyFreezeJson(JSON.parse(serializedArchive) as JsonValue);
  const source = normalizeSource(row.source);
  let archiveTradeIds: Set<string> | null = null;
  if (archive === null) {
    if (source.kind !== 'empty' || source.accepted !== 0 || source.dropped !== 0) fail();
  } else {
    let ledger = null;
    try {
      ledger = readCsvFillLedgerExtension(archive);
      if (ledger) replayCsvFillLedger(ledger);
    } catch {
      fail();
    }
    const imported = importArchive(archive);
    if ((!ledger && (imported.error !== undefined || !imported.trades.length)) || source.kind === 'empty') fail();
    const trades = ledger ? replayCsvFillLedger(ledger).trades : imported.trades!;
    archiveTradeIds = new Set(trades.map((trade) => trade.id));
  }

  const reviews = normalizeReviews(row.reviews);
  const actions = normalizeActions(row.actions);
  if (
    (!archiveTradeIds && (Object.keys(reviews).length > 0 || Object.keys(actions).length > 0))
    || (archiveTradeIds && (
      Object.keys(reviews).some((tradeId) => !archiveTradeIds.has(tradeId))
      || Object.values(actions).some((action) => !archiveTradeIds.has(action.sourceTradeId))
    ))
  ) fail();

  const snapshot = Object.freeze({
    format: WORKSPACE_SNAPSHOT_FORMAT,
    generation: safeInteger(row.generation, 1),
    createdAt: safeInteger(row.createdAt),
    engineVersion,
    source,
    archive,
    reviews,
    actions,
    journal: normalizeJournal(row.journal),
    guards: normalizeGuards(row.guards),
  });
  if (new TextEncoder().encode(canonicalJson(snapshot)).byteLength > VAULT_CRYPTO_LIMITS.plaintextBytes) fail();
  return snapshot;
}
