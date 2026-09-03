import { importArchive } from '@rv/engine';
import type { JsonValue } from './canonical-json';
import type { ActionPlanMap } from './action-plan-storage';
import type { ReviewMap } from './review-storage';
import { readCsvFillLedgerExtension, replayCsvFillLedger } from './csv-fill-ledger';
import {
  normalizeWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_FORMAT,
  type SnapshotGuard,
  type SnapshotJournalEntry,
  type SnapshotSourceEvidence,
  type WorkspaceSnapshotV1,
} from './workspace-snapshot';

export const PORTABLE_BACKUP_FORMAT = 'rv-portable-backup/1' as const;
// Leaves headroom for AES-GCM metadata and base64 expansion inside the 24 MiB
// encrypted vault-object transport ceiling.
export const MAX_PORTABLE_BACKUP_BYTES = 16 * 1024 * 1024;

export class PortableBackupError extends Error {
  readonly code = 'PORTABLE_BACKUP_INVALID';
  constructor() {
    super('PORTABLE_BACKUP_INVALID');
  }
}

export type PortableBackupSource = 'demo' | 'imported' | 'binance';
export type PortableBackupScope = Readonly<{ kind: 'full-workspace' }>;

export type PortableBackupV1 = Readonly<{
  format: typeof PORTABLE_BACKUP_FORMAT;
  exportedAt: number;
  source: PortableBackupSource;
  scope: PortableBackupScope;
  evidence: Readonly<{
    accepted: number;
    dropped: number;
    coverage: 'complete' | 'partial' | 'unknown';
  }>;
  archive: JsonValue;
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
}>;

export type PortableBackupInput = Readonly<{
  source: PortableBackupSource;
  archive: JsonValue;
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
  evidence?: Readonly<{
    accepted: number;
    dropped: number;
    coverage: 'complete' | 'partial' | 'unknown';
  }>;
}>;

function fail(): never {
  throw new PortableBackupError();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exact(row: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
  return Number(value);
}

function normalizeScope(value: unknown): PortableBackupScope {
  const row = record(value);
  exact(row, ['kind']);
  if (row.kind !== 'full-workspace') fail();
  return Object.freeze({ kind: 'full-workspace' });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function recursivelyFreezeParsedJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) recursivelyFreezeParsedJson(child);
  return Object.freeze(value);
}

function normalizeEvidence(
  value: unknown,
  source: PortableBackupSource,
  importedCount: number,
  importedCoverage: string,
): SnapshotSourceEvidence {
  const row = record(value);
  exact(row, ['accepted', 'dropped', 'coverage']);
  if (!['complete', 'partial', 'unknown'].includes(String(row.coverage))) fail();
  const accepted = safeInteger(row.accepted);
  const dropped = safeInteger(row.dropped);
  if (accepted < importedCount) fail();
  const fallbackCoverage = importedCoverage === 'complete' || importedCoverage === 'partial'
    ? importedCoverage
    : 'unknown';
  const coverage = row.coverage === 'unknown' ? fallbackCoverage : row.coverage;
  return Object.freeze({
    kind: source === 'binance' ? 'binance-local' : 'csv',
    accepted,
    dropped,
    coverage: coverage as SnapshotSourceEvidence['coverage'],
    importedAt: 0,
  });
}

export function createPortableBackup(
  input: PortableBackupInput,
  scope: PortableBackupScope,
  exportedAt = Date.now(),
): PortableBackupV1 {
  let ledger = null;
  try {
    ledger = readCsvFillLedgerExtension(input.archive);
    if (ledger) replayCsvFillLedger(ledger);
  } catch {
    fail();
  }
  const imported = importArchive(input.archive);
  if (!ledger && (imported.error !== undefined || !imported.trades.length)) fail();
  const replay = ledger ? replayCsvFillLedger(ledger) : null;
  const importedCoverage = replay?.contract.provenance.coverage.status
    ?? (imported.error === undefined ? imported.contract.provenance.coverage.status : 'unknown');
  const importedCount = replay?.trades.length ?? (imported.error === undefined ? imported.trades.length : 0);
  const evidence = input.evidence ?? {
    accepted: importedCount,
    dropped: 0,
    coverage: importedCoverage === 'complete' || importedCoverage === 'partial'
      ? importedCoverage
      : 'unknown',
  };
  const value = {
    format: PORTABLE_BACKUP_FORMAT,
    exportedAt: safeInteger(exportedAt),
    source: input.source,
    scope: normalizeScope(scope),
    evidence: {
      accepted: evidence.accepted,
      dropped: evidence.dropped,
      coverage: evidence.coverage,
    },
    archive: input.archive,
    reviews: input.reviews,
    actions: input.actions,
    journal: input.journal,
    guards: input.guards,
  };
  const serialized = serializePortableBackup(value);
  parsePortableBackup(serialized);
  return recursivelyFreezeParsedJson(JSON.parse(serialized)) as PortableBackupV1;
}

export function serializePortableBackup(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || utf8Bytes(text) > MAX_PORTABLE_BACKUP_BYTES) fail();
    return text;
  } catch (error) {
    if (error instanceof PortableBackupError) throw error;
    throw new PortableBackupError();
  }
}

export type ParsedPortableBackup = Readonly<{
  source: PortableBackupSource;
  snapshot: WorkspaceSnapshotV1;
}>;

function parsePortableBackupEnvelope(text: string): ParsedPortableBackup {
  try {
    if (typeof text !== 'string' || utf8Bytes(text) > MAX_PORTABLE_BACKUP_BYTES) fail();
    const row = record(JSON.parse(text));
    exact(row, [
      'format', 'exportedAt', 'source', 'scope', 'evidence',
      'archive', 'reviews', 'actions', 'journal', 'guards',
    ]);
    if (row.format !== PORTABLE_BACKUP_FORMAT || !['demo', 'imported', 'binance'].includes(String(row.source))) fail();
    const exportedAt = safeInteger(row.exportedAt);
    normalizeScope(row.scope);
    const archive = row.archive as JsonValue;
    let ledger = null;
    try {
      ledger = readCsvFillLedgerExtension(archive);
      if (ledger) replayCsvFillLedger(ledger);
    } catch {
      fail();
    }
    const imported = importArchive(archive);
    if (!ledger && (imported.error !== undefined || !imported.trades.length)) fail();
    const replay = ledger ? replayCsvFillLedger(ledger) : null;
    const source = normalizeEvidence(
      row.evidence,
      row.source as PortableBackupSource,
      replay?.trades.length ?? (imported.error === undefined ? imported.trades.length : 0),
      replay?.contract.provenance.coverage.status
        ?? (imported.error === undefined ? imported.contract.provenance.coverage.status : 'unknown'),
    );
    const snapshot = normalizeWorkspaceSnapshot({
      format: WORKSPACE_SNAPSHOT_FORMAT,
      generation: 1,
      createdAt: exportedAt,
      engineVersion: 'portable-1',
      source: { ...source, importedAt: exportedAt },
      archive,
      reviews: row.reviews,
      actions: row.actions,
      journal: row.journal,
      guards: row.guards,
    });
    return Object.freeze({
      source: row.source as PortableBackupSource,
      snapshot,
    });
  } catch (error) {
    if (error instanceof PortableBackupError) throw error;
    throw new PortableBackupError();
  }
}

export function parsePortableBackup(text: string): WorkspaceSnapshotV1 {
  return parsePortableBackupEnvelope(text).snapshot;
}

export function parseCompletePortableBackup(text: string): ParsedPortableBackup {
  return parsePortableBackupEnvelope(text);
}
