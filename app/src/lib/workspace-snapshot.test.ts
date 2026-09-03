import { describe, expect, it } from 'vitest';
import { exportArchive, parseStatement } from '@rv/engine';
import { normalizeWorkspaceSnapshot, WORKSPACE_SNAPSHOT_FORMAT } from './workspace-snapshot';
import { createCsvFillLedger, withCsvFillLedger } from './csv-fill-ledger';

const archive = exportArchive([{
  id: 'trade-1',
  symbol: 'BTCUSDT',
  market: 'USDM',
  side: 'LONG',
  entryTime: 1_700_000_000_000,
  exitTime: 1_700_000_060_000,
  entryPrice: 60_000,
  exitPrice: 60_100,
  qty: 0.01,
  fee: 0.2,
  pnl: 1,
  currency: 'USDT',
  source: 'csv-report',
}], { source: 'csv-report' });

function validSnapshot() {
  return {
    format: WORKSPACE_SNAPSHOT_FORMAT,
    generation: 1,
    createdAt: 1_700_000_100_000,
    engineVersion: '2.0.0-alpha',
    source: {
      kind: 'csv',
      accepted: 1,
      dropped: 0,
      coverage: 'complete',
      importedAt: 1_700_000_100_000,
    },
    archive,
    reviews: {
      'trade-1': {
        saw: '回到计划区域',
        happened: '按计划执行',
        lesson: '进场前写失效条件',
        grade: 'B',
        reviewed: true,
        updatedAt: 1_700_000_100_001,
      },
    },
    actions: {
      'trade:trade-1': {
        id: 'trade:trade-1',
        sourceTradeId: 'trade-1',
        text: '进场前写失效条件',
        status: 'open',
        createdAt: 1_700_000_100_001,
        updatedAt: 1_700_000_100_001,
        completedAt: null,
        experiment: null,
      },
    },
    journal: [],
    guards: [],
  };
}

function expectRecursivelyFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectRecursivelyFrozen(child, seen);
}

describe('production workspace snapshot', () => {
  it('accepts a complete, ciphertext-ready review workspace', () => {
    expect(normalizeWorkspaceSnapshot(validSnapshot())).toEqual(validSnapshot());
  });

  it('detaches every retained value from the caller and recursively freezes the verified snapshot', () => {
    const base = validSnapshot();
    const input = structuredClone({
      ...base,
      actions: {
        'trade:trade-1': {
          ...base.actions['trade:trade-1'],
          updatedAt: 1_700_000_100_500,
          experiment: {
            hypothesis: '先记录失效条件', targetCount: 1, observedCount: 1, successfulCount: 1,
            windowStart: '2026-08-29', windowEnd: '2026-08-29', successCriterion: 1,
            evidenceNote: '', decision: 'pending',
            observations: [{ day: '2026-08-29', followed: true, evidenceNote: '已记录' }],
            updatedAt: 1_700_000_100_500,
          },
        },
      },
      journal: [{ day: '2026-08-29', note: '原始日志', emotion: '冷静', updatedAt: 2 }],
      guards: [{ id: 'g1', text: '原始护栏', active: true, createdAt: 2, updatedAt: 2 }],
    });
    const normalized = normalizeWorkspaceSnapshot(input);
    const committed = JSON.stringify(normalized);

    expect(normalized.archive).not.toBe(input.archive);
    expect(normalized.source).not.toBe(input.source);
    expect(normalized.reviews).not.toBe(input.reviews);
    expect(normalized.reviews['trade-1']).not.toBe(input.reviews['trade-1']);
    expect(normalized.actions).not.toBe(input.actions);
    expect(normalized.actions['trade:trade-1']).not.toBe(input.actions['trade:trade-1']);
    expect(normalized.actions['trade:trade-1'].experiment)
      .not.toBe(input.actions['trade:trade-1'].experiment);
    expect(normalized.actions['trade:trade-1'].experiment?.observations[0])
      .not.toBe(input.actions['trade:trade-1'].experiment.observations[0]);
    expect(normalized.journal).not.toBe(input.journal);
    expect(normalized.journal[0]).not.toBe(input.journal[0]);
    expect(normalized.guards).not.toBe(input.guards);
    expect(normalized.guards[0]).not.toBe(input.guards[0]);
    expectRecursivelyFrozen(normalized);

    (input.archive as unknown as { trades: Array<{ symbol: string }> }).trades[0].symbol = 'ETHUSDT';
    input.source.accepted = 999;
    input.reviews['trade-1'].lesson = '调用方事后篡改';
    input.actions['trade:trade-1'].text = '调用方事后篡改';
    input.actions['trade:trade-1'].experiment.observations[0].evidenceNote = '调用方事后篡改';
    input.journal[0].note = '调用方事后篡改';
    input.guards[0].text = '调用方事后篡改';

    expect(JSON.stringify(normalized)).toBe(committed);
    expect(() => {
      (normalized.archive as { trades: Array<{ symbol: string }> }).trades[0].symbol = 'SOLUSDT';
    }).toThrow(TypeError);
  });

  it('normalizes legacy actions and round-trips a fully evidenced behavior experiment', () => {
    const legacy = validSnapshot();
    const { experiment: _legacyExperiment, ...legacyAction } = legacy.actions['trade:trade-1'];
    const normalizedLegacy = normalizeWorkspaceSnapshot({
      ...legacy,
      actions: { 'trade:trade-1': legacyAction },
    });
    expect(normalizedLegacy.actions['trade:trade-1'].experiment).toBeNull();

    const current = validSnapshot();
    const withExperiment = {
      ...current,
      actions: {
        'trade:trade-1': {
          ...current.actions['trade:trade-1'],
          status: 'open' as const,
          updatedAt: 1_700_000_100_500,
          completedAt: null,
          experiment: {
            hypothesis: '先写失效条件能提高计划执行率',
            targetCount: 2,
            observedCount: 2,
            successfulCount: 1,
            windowStart: '2026-08-29',
            windowEnd: '2026-09-05',
            successCriterion: 2,
            evidenceNote: '1/2 次执行，需缩小动作后复测。',
            decision: 'revise' as const,
            observations: [
              { day: '2026-08-30', followed: true, evidenceNote: 'trade-2 已按计划记录' },
              { day: '2026-09-01', followed: false, evidenceNote: 'trade-3 未等待确认' },
            ],
            updatedAt: 1_700_000_100_500,
          },
        },
      },
    };
    expect(normalizeWorkspaceSnapshot(withExperiment).actions['trade:trade-1'].experiment)
      .toEqual(withExperiment.actions['trade:trade-1'].experiment);
    const reviseMarkedDone = structuredClone(withExperiment) as Record<string, any>;
    reviseMarkedDone.actions['trade:trade-1'].status = 'done';
    reviseMarkedDone.actions['trade:trade-1'].completedAt = 1_700_000_100_500;
    expect(() => normalizeWorkspaceSnapshot(reviseMarkedDone)).toThrow(/快照格式无效/);
  });

  it('rejects experiment claims with impossible dates, counts, or missing evidence', () => {
    const current = validSnapshot();
    const base = {
      ...current,
      actions: {
        'trade:trade-1': {
          ...current.actions['trade:trade-1'],
          status: 'done' as const,
          updatedAt: 1_700_000_100_500,
          completedAt: 1_700_000_100_500,
          experiment: {
            hypothesis: '测试单变量', targetCount: 1, observedCount: 1, successfulCount: 1,
            windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
            evidenceNote: '达到标准', decision: 'adopt' as const,
            observations: [{ day: '2026-08-29', followed: true, evidenceNote: 'trade-2 已记录' }],
            updatedAt: 1_700_000_100_500,
          },
        },
      },
    };
    expect(normalizeWorkspaceSnapshot(base).actions['trade:trade-1'].experiment?.observedCount).toBe(1);

    const impossibleCount = structuredClone(base);
    impossibleCount.actions['trade:trade-1'].experiment.observedCount = 0;
    expect(() => normalizeWorkspaceSnapshot(impossibleCount)).toThrow(/快照格式无效/);
    const invalidDay = structuredClone(base);
    invalidDay.actions['trade:trade-1'].experiment.observations[0].day = '2026-02-30';
    expect(() => normalizeWorkspaceSnapshot(invalidDay)).toThrow(/快照格式无效/);
    const missingEvidence = structuredClone(base);
    missingEvidence.actions['trade:trade-1'].experiment.observations[0].evidenceNote = ' ';
    expect(() => normalizeWorkspaceSnapshot(missingEvidence)).toThrow(/快照格式无效/);
  });

  it('accepts only an explicitly empty first-generation workspace without an archive', () => {
    const empty = {
      ...validSnapshot(),
      archive: null,
      source: { kind: 'empty', accepted: 0, dropped: 0, coverage: 'unknown', importedAt: 1 },
      reviews: {},
      actions: {},
    };
    expect(normalizeWorkspaceSnapshot(empty)).toEqual(empty);
    expect(() => normalizeWorkspaceSnapshot({
      ...empty,
      source: { ...empty.source, kind: 'csv' },
    })).toThrow();
    expect(() => normalizeWorkspaceSnapshot({
      ...empty,
      reviews: validSnapshot().reviews,
    })).toThrow(/快照格式无效/);
    expect(() => normalizeWorkspaceSnapshot({
      ...empty,
      actions: validSnapshot().actions,
    })).toThrow(/快照格式无效/);
  });

  it('rejects raw CSV or other undeclared plaintext fields', () => {
    expect(() => normalizeWorkspaceSnapshot({
      ...validSnapshot(),
      rawCsv: 'must never enter the vault payload',
    })).toThrow(/快照格式无效/);
  });

  it('rejects malformed archives, non-successor generations, and unsafe action ids', () => {
    expect(() => normalizeWorkspaceSnapshot({ ...validSnapshot(), archive: { format: 'fupan/1', trades: [] } })).toThrow();
    expect(() => normalizeWorkspaceSnapshot({ ...validSnapshot(), generation: 0 })).toThrow();
    const invalidAction = validSnapshot();
    invalidAction.actions['trade:trade-1'].id = '../other-user';
    expect(() => normalizeWorkspaceSnapshot(invalidAction)).toThrow();
  });

  it('rejects reviews and actions that reference trades absent from the archive', () => {
    const base = validSnapshot();
    const ghostReview = {
      ...base,
      reviews: { ...base.reviews, 'ghost-trade': { ...base.reviews['trade-1'] } },
    };
    expect(() => normalizeWorkspaceSnapshot(ghostReview)).toThrow(/快照格式无效/);

    const ghostAction = validSnapshot();
    ghostAction.actions['trade:trade-1'].sourceTradeId = 'ghost-trade';
    expect(() => normalizeWorkspaceSnapshot(ghostAction)).toThrow(/快照格式无效/);
  });

  it('rejects prototype-sensitive identifiers and coerced review grades', () => {
    const base = validSnapshot();
    const dangerousReviews = JSON.parse(JSON.stringify(base.reviews));
    Object.defineProperty(dangerousReviews, '__proto__', {
      value: { ...base.reviews['trade-1'] }, enumerable: true,
    });
    expect(() => normalizeWorkspaceSnapshot({ ...base, reviews: dangerousReviews }))
      .toThrow(/快照格式无效/);
    expect(() => normalizeWorkspaceSnapshot({
      ...base,
      reviews: { 'trade-1': { ...base.reviews['trade-1'], grade: 66 } },
    })).toThrow(/快照格式无效/);
  });

  it('accepts a structurally valid open-only fill ledger and rejects a malformed extension', async () => {
    const parsed = parseStatement(`Date(UTC),Symbol,Side,Price,Quantity,Fee,Realized Profit
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,0.27,0`, null);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    const merged = await createCsvFillLedger('ledger:test-open', {
      fills: parsed.fills,
      meta: parsed.meta,
      contract: parsed.contract,
      diagnostics: parsed.diagnostics,
    });
    const openArchive = withCsvFillLedger(exportArchive([], parsed.meta), merged.ledger);
    const openSnapshot = {
      ...validSnapshot(),
      source: { ...validSnapshot().source, accepted: 0 },
      archive: openArchive,
      reviews: {},
      actions: {},
    };
    expect(normalizeWorkspaceSnapshot(openSnapshot).archive).toEqual(openArchive);
    expect(() => normalizeWorkspaceSnapshot({
      ...openSnapshot,
      archive: { ...openArchive, rvFillLedger: { version: 'other' } },
    })).toThrow(/快照格式无效/);
  });
});
