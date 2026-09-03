import { exportArchive, parseStatement } from '@rv/engine';
import { describe, expect, it } from 'vitest';
import {
  createPortableBackup,
  MAX_PORTABLE_BACKUP_BYTES,
  parseCompletePortableBackup,
  parsePortableBackup,
  serializePortableBackup,
} from './portable-backup';
import type { JsonValue } from './canonical-json';
import { createCsvFillLedger, readCsvFillLedgerExtension, withCsvFillLedger } from './csv-fill-ledger';

const CSV = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,0
2026-06-01 10:00:00,BTCUSDT,SELL,68600,0.01,686,0.27,6`;

function expectRecursivelyFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectRecursivelyFrozen(child, seen);
}

describe('portable complete review backup', () => {
  it('round-trips a strictly validated complete backup', () => {
    const imported = parseStatement(CSV, null);
    if (imported.error !== undefined) throw new Error(imported.error);
    const backup = createPortableBackup({
      source: 'imported',
      archive: exportArchive(imported.trades, imported.meta) as unknown as JsonValue,
      reviews: {},
      actions: {},
      journal: [{ day: '2026-08-28', note: '记录', emotion: '冷静', updatedAt: 100 }],
      guards: [{ id: 'g1', text: '不追涨', active: true, createdAt: 100, updatedAt: 100 }],
    }, { kind: 'full-workspace' }, 200);

    const serialized = serializePortableBackup(backup);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(MAX_PORTABLE_BACKUP_BYTES);
    expect(JSON.parse(serialized).scope).toEqual({ kind: 'full-workspace' });
    const snapshot = parsePortableBackup(serialized);
    expect(snapshot.generation).toBe(1);
    expect(snapshot.source).toMatchObject({ kind: 'csv', accepted: 1, dropped: 0 });
    expect(snapshot.journal[0].note).toBe('记录');
    expect(snapshot.guards[0].text).toBe('不追涨');
  });

  it('returns the validated serialization result, detached from inputs and recursively frozen', () => {
    const imported = parseStatement(CSV, null);
    if (imported.error !== undefined) throw new Error(imported.error);
    const input = {
      source: 'imported' as const,
      archive: exportArchive(imported.trades, imported.meta) as unknown as JsonValue,
      reviews: {},
      actions: {},
      journal: [{ day: '2026-08-28', note: '原始记录', emotion: '冷静', updatedAt: 100 }],
      guards: [{ id: 'g1', text: '不追涨', active: true, createdAt: 100, updatedAt: 100 }],
      evidence: { accepted: 1, dropped: 0, coverage: 'complete' as const },
    };
    const scope: { kind: 'full-workspace' } = { kind: 'full-workspace' };
    const backup = createPortableBackup(input, scope, 200);
    const committed = serializePortableBackup(backup);

    expect(backup.archive).not.toBe(input.archive);
    expect(backup.journal).not.toBe(input.journal);
    expect(backup.journal[0]).not.toBe(input.journal[0]);
    expect(backup.guards).not.toBe(input.guards);
    expect(backup.evidence).not.toBe(input.evidence);
    expect(backup.scope).not.toBe(scope);
    expectRecursivelyFrozen(backup);

    (input.archive as { trades: Array<{ symbol: string }> }).trades[0].symbol = 'ETHUSDT';
    input.journal[0].note = '调用方事后篡改';
    input.guards[0].text = '调用方事后篡改';
    input.evidence.accepted = 999;
    (scope as { kind: string }).kind = 'tampered';

    expect(serializePortableBackup(backup)).toBe(committed);
    expect(parsePortableBackup(committed).journal[0].note).toBe('原始记录');
    expect(() => {
      (backup.archive as { trades: Array<{ symbol: string }> }).trades[0].symbol = 'SOLUSDT';
    }).toThrow(TypeError);
  });

  it('rejects unknown fields and unsupported formats', () => {
    expect(() => parsePortableBackup(JSON.stringify({
      format: 'rv-portable-backup/1', exportedAt: 1, source: 'imported', scope: { from: 'x', to: 'y' },
      archive: null, reviews: {}, actions: {}, journal: [], guards: [], email: 'private@example.com',
    }))).toThrow(/PORTABLE_BACKUP_INVALID/);
    expect(() => parsePortableBackup('{"format":"other"}')).toThrow(/PORTABLE_BACKUP_INVALID/);
  });

  it('rejects a date-range document as a complete workspace restore', () => {
    const imported = parseStatement(CSV, null);
    if (imported.error !== undefined) throw new Error(imported.error);
    const complete = createPortableBackup({
      source: 'imported',
      archive: exportArchive(imported.trades, imported.meta) as unknown as JsonValue,
      reviews: {}, actions: {}, journal: [], guards: [],
    }, { kind: 'full-workspace' }, 200);
    const ranged = { ...complete, scope: { from: '2026-06-01', to: '2026-08-28' } };
    expect(() => parseCompletePortableBackup(JSON.stringify(ranged)))
      .toThrow(/PORTABLE_BACKUP_INVALID/);
  });

  it('preserves the declared demo source outside the normalized archive evidence', () => {
    const imported = parseStatement(CSV, null);
    if (imported.error !== undefined) throw new Error(imported.error);
    const backup = createPortableBackup({
      source: 'demo',
      archive: exportArchive(imported.trades, imported.meta) as unknown as JsonValue,
      reviews: {}, actions: {}, journal: [], guards: [],
    }, { kind: 'full-workspace' }, 200);
    const parsed = parseCompletePortableBackup(serializePortableBackup(backup));
    expect(parsed.source).toBe('demo');
    expect(parsed.snapshot.source.kind).toBe('csv');
  });

  it('enforces the portable-backup limit in exact UTF-8 bytes', () => {
    const prefix = '{"note":"';
    const suffix = '"}';
    const remaining = MAX_PORTABLE_BACKUP_BYTES - new TextEncoder().encode(prefix + suffix).byteLength;
    const exact = `${prefix}${'a'.repeat(remaining)}${suffix}`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_PORTABLE_BACKUP_BYTES);
    expect(() => parsePortableBackup(exact)).toThrow(/PORTABLE_BACKUP_INVALID/);
    expect(() => parsePortableBackup(`${prefix}${'你'.repeat(Math.floor(remaining / 3) + 1)}${suffix}`))
      .toThrow(/PORTABLE_BACKUP_INVALID/);
  });

  it('round-trips an open-only ledger before any closed trade exists', async () => {
    const parsed = parseStatement(`Date(UTC),Symbol,Side,Price,Quantity,Fee,Realized Profit
2026-06-01 09:00:00,ETHUSDT,BUY,3000,0.1,0.12,0`, null);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    const merged = await createCsvFillLedger('ledger:portable-open', {
      fills: parsed.fills,
      meta: parsed.meta,
      contract: parsed.contract,
      diagnostics: parsed.diagnostics,
    });
    const archive = withCsvFillLedger(exportArchive([], parsed.meta), merged.ledger) as unknown as JsonValue;
    const backup = createPortableBackup({
      source: 'imported', archive, reviews: {}, actions: {}, journal: [], guards: [],
      evidence: { accepted: 0, dropped: 0, coverage: 'complete' },
    }, { kind: 'full-workspace' }, 500);
    const restored = parsePortableBackup(serializePortableBackup(backup));
    expect(readCsvFillLedgerExtension(restored.archive)?.fills).toHaveLength(1);
    expect(restored.source.accepted).toBe(0);
  });
});
