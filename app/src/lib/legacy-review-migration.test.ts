import { describe, expect, it } from 'vitest';
import {
  CLASSIC_REVIEW_EXPORT_FORMAT,
  LEGACY_REVIEW_MIGRATION_LIMITS,
  LegacyReviewMigrationError,
  bindLegacyReviewMigrationPlan,
  computeLegacyTradeSetDigest,
  mergeLegacyReviewMigration,
  parseLegacyReviewExport,
  verifyLegacyReviewMigrationReceipt,
} from './legacy-review-migration';

const SCOPE = 'csv-ledger-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function review(tradeId: string, overrides: Record<string, unknown> = {}) {
  return {
    tradeId,
    saw: '回踩支撑',
    did: '按计划执行',
    learn: '进场前写失效条件',
    grade: 'B',
    reviewed: true,
    ...overrides,
  };
}

function document(reviews = [review('trade-1')]) {
  return {
    format: CLASSIC_REVIEW_EXPORT_FORMAT,
    reviews,
    riskLimits: { maxLoss: 400, maxTrades: 3, maxRiskR: 1.5 },
  };
}

describe('Classic review migration core', () => {
  it('parses into an unbound plan, maps legacy fields, and keeps risk limits display-only', async () => {
    const plan = await parseLegacyReviewExport(JSON.stringify(document()));

    expect(plan.state).toBe('unbound');
    expect(plan.binding).toBeNull();
    expect(plan.candidates).toEqual([]);
    expect(plan.entries[0].review).toEqual({
      saw: '回踩支撑',
      happened: '按计划执行',
      lesson: '进场前写失效条件',
      grade: 'B',
      reviewed: true,
    });
    expect(plan.riskLimits).toEqual({
      disposition: 'display-only',
      values: { maxLoss: 400, maxTrades: 3, maxRiskR: 1.5 },
    });
    expect(plan.lineage).toEqual({
      status: 'unsupported',
      code: 'CSV_LINEAGE_RECOMPUTE_UNSUPPORTED',
    });
    expect(plan.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(plan.riskLimits)).not.toContain('SnapshotGuard');
  });

  it('reports missing grade and overlong fields without defaults or truncation', async () => {
    const longText = 'x'.repeat(601);
    const plan = await parseLegacyReviewExport(document([
      review('missing-grade', { grade: undefined }),
      review('too-long', { saw: longText }),
    ]));

    expect(plan.entries[0].review).toBeNull();
    expect(plan.entries[0].issues).toContainEqual({
      code: 'MISSING_GRADE',
      field: 'grade',
      tradeId: 'missing-grade',
    });
    expect(plan.entries[1].review).toBeNull();
    expect(plan.entries[1].issues).toContainEqual({
      code: 'FIELD_TOO_LONG',
      field: 'saw',
      tradeId: 'too-long',
    });
    expect(JSON.stringify(plan)).not.toContain('"grade":"C"');
    expect(JSON.stringify(plan)).not.toContain(longText.slice(0, 600));

    const bound = await bindLegacyReviewMigrationPlan(plan, {
      reviewScope: SCOPE,
      currentTradeIds: ['missing-grade', 'too-long'],
    });
    expect(bound.candidates).toEqual([]);
  });

  it('accepts candidates only when legacy and current trade IDs are exactly equal', async () => {
    const plan = await parseLegacyReviewExport(document([
      review('trade-1'),
      review('trade-2'),
      review('legacy-same-content-different-id'),
    ]));
    const bound = await bindLegacyReviewMigrationPlan(plan, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-2', 'trade-1', 'current-same-content-different-id'],
    });

    expect(bound.state).toBe('bound');
    expect(bound.binding?.reviewScope).toBe(SCOPE);
    expect(bound.binding?.tradeSetDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(bound.candidates.map((candidate) => [candidate.tradeId, candidate.match])).toEqual([
      ['trade-1', 'exact-trade-id'],
      ['trade-2', 'exact-trade-id'],
    ]);
    expect(bound.unmatchedCount).toBe(1);
    expect(bound.lineage.status).toBe('unsupported');
  });

  it('binds to a stable sorted trade-set digest and rejects a changed dataset at merge time', async () => {
    await expect(computeLegacyTradeSetDigest(['trade-2', 'trade-1']))
      .resolves.toBe(await computeLegacyTradeSetDigest(['trade-1', 'trade-2']));

    const plan = await parseLegacyReviewExport(document());
    const bound = await bindLegacyReviewMigrationPlan(plan, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
    });

    await expect(mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1', 'trade-2'],
      selectedTradeIds: ['trade-1'],
      existingReviews: {},
      now: 1_700_000_000_000,
    })).rejects.toMatchObject({ code: 'STALE_BINDING' });
  });

  it('inserts only explicitly selected reviews, never overwrites, and emits hash-only receipts', async () => {
    const plan = await parseLegacyReviewExport(document([
      review('trade-1'),
      review('trade-2', { saw: '不应覆盖旧值', grade: 'A' }),
      review('trade-3'),
    ]));
    const bound = await bindLegacyReviewMigrationPlan(plan, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1', 'trade-2', 'trade-3'],
    });
    const existing = {
      'trade-2': {
        saw: '保留现有复盘',
        happened: '现有执行',
        lesson: '现有教训',
        grade: 'D' as const,
        reviewed: false,
        updatedAt: 99,
      },
    };
    const merged = await mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-3', 'trade-1', 'trade-2'],
      selectedTradeIds: ['trade-1', 'trade-2'],
      existingReviews: existing,
      now: 1_700_000_000_000,
    });

    expect(merged.reviews['trade-1']).toEqual({
      saw: '回踩支撑',
      happened: '按计划执行',
      lesson: '进场前写失效条件',
      grade: 'B',
      reviewed: true,
      updatedAt: 1_700_000_000_000,
    });
    expect(merged.reviews['trade-2']).toEqual(existing['trade-2']);
    expect(merged.reviews['trade-3']).toBeUndefined();
    expect(merged.receipt).toMatchObject({
      format: 'rv-classic-review-migration-receipt/1',
      selectedCount: 2,
      insertedCount: 1,
      skippedExistingCount: 1,
    });
    for (const key of ['sourceHash', 'bindingHash', 'selectionHash', 'resultHash'] as const) {
      expect(merged.receipt[key]).toMatch(/^[0-9a-f]{64}$/u);
    }
    const receiptText = JSON.stringify(merged.receipt);
    expect(receiptText).not.toMatch(/trade-|回踩|复盘|csv-ledger/iu);

    const differentTimestamp = await mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1', 'trade-2', 'trade-3'],
      selectedTradeIds: ['trade-1', 'trade-2'],
      existingReviews: existing,
      now: 1_700_000_000_001,
    });
    expect(differentTimestamp.receipt.selectionHash).toBe(merged.receipt.selectionHash);
    expect(differentTimestamp.receipt.resultHash).not.toBe(merged.receipt.resultHash);

    const differentExisting = await mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1', 'trade-2', 'trade-3'],
      selectedTradeIds: ['trade-1', 'trade-2'],
      existingReviews: {
        'trade-2': { ...existing['trade-2'], lesson: '另一份现有教训' },
      },
      now: 1_700_000_000_000,
    });
    expect(differentExisting.receipt.selectionHash).toBe(merged.receipt.selectionHash);
    expect(differentExisting.receipt.resultHash).not.toBe(merged.receipt.resultHash);

    expect(merged.reviews['trade-2']).not.toBe(existing['trade-2']);
    expect(Object.isFrozen(merged.reviews['trade-2'])).toBe(true);
    const committedResultHash = merged.receipt.resultHash;
    existing['trade-2'].lesson = '调用方事后篡改';
    expect(merged.reviews['trade-2'].lesson).toBe('现有教训');
    expect(merged.receipt.resultHash).toBe(committedResultHash);

    await expect(verifyLegacyReviewMigrationReceipt(merged.receipt, merged.reviews)).resolves.toBe(true);
    for (const count of ['selectedCount', 'insertedCount', 'skippedExistingCount'] as const) {
      await expect(verifyLegacyReviewMigrationReceipt({
        ...merged.receipt,
        [count]: merged.receipt[count] + 1,
      }, merged.reviews)).resolves.toBe(false);
    }

    const sameFinalReviewsButSkipped = await mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1', 'trade-2', 'trade-3'],
      selectedTradeIds: ['trade-1', 'trade-2'],
      existingReviews: merged.reviews,
      now: 1_700_000_000_000,
    });
    expect(sameFinalReviewsButSkipped.reviews).toEqual(merged.reviews);
    expect(sameFinalReviewsButSkipped.receipt).toMatchObject({
      selectedCount: 2,
      insertedCount: 0,
      skippedExistingCount: 2,
    });
    expect(sameFinalReviewsButSkipped.receipt.resultHash).not.toBe(merged.receipt.resultHash);
  });

  it('treats an empty selection as an explicit no-op and rejects non-candidate selections', async () => {
    const plan = await parseLegacyReviewExport(document());
    const bound = await bindLegacyReviewMigrationPlan(plan, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
    });
    const noOp = await mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
      selectedTradeIds: [],
      existingReviews: {},
      now: 1,
    });
    expect(noOp.reviews).toEqual({});
    expect(noOp.receipt.selectedCount).toBe(0);

    await expect(mergeLegacyReviewMigration(bound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
      selectedTradeIds: ['trade-2'],
      existingReviews: {},
      now: 1,
    })).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
  });

  it('rejects unknown keys, dangerous IDs, custom prototypes, and oversized payloads', async () => {
    await expect(parseLegacyReviewExport({ ...document(), extra: 'no' }))
      .rejects.toBeInstanceOf(LegacyReviewMigrationError);
    await expect(parseLegacyReviewExport({
      ...document(),
      reviews: [{ ...review('trade-1'), token: 'no' }],
    })).rejects.toMatchObject({ code: 'INVALID_EXPORT' });
    await expect(parseLegacyReviewExport(
      '{"format":"rv-classic-review-export/1","reviews":[{"tradeId":"__proto__","saw":"a","did":"b","learn":"c","grade":"A","reviewed":true}],"riskLimits":null}',
    )).rejects.toMatchObject({ code: 'INVALID_EXPORT' });
    expect(Object.prototype).not.toHaveProperty('polluted');

    const custom = Object.create({ polluted: true });
    Object.assign(custom, document());
    await expect(parseLegacyReviewExport(custom)).rejects.toMatchObject({ code: 'INVALID_EXPORT' });

    await expect(parseLegacyReviewExport('x'.repeat(
      LEGACY_REVIEW_MIGRATION_LIMITS.serializedBytes + 1,
    ))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('rejects fabricated or cloned plans that bypass the strict parser boundary', async () => {
    const unbound = await parseLegacyReviewExport(document());
    await expect(bindLegacyReviewMigrationPlan(structuredClone(unbound), {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
    })).rejects.toMatchObject({ code: 'INVALID_PLAN' });

    const bound = await bindLegacyReviewMigrationPlan(unbound, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
    });
    const forged = structuredClone(bound);
    const forgedReview = forged.candidates[0].review as unknown as Record<string, unknown>;
    forgedReview.saw = 'x'.repeat(10_000);
    forgedReview.token = 'bypass';
    await expect(mergeLegacyReviewMigration(forged, {
      reviewScope: SCOPE,
      currentTradeIds: ['trade-1'],
      selectedTradeIds: ['trade-1'],
      existingReviews: {},
      now: 1,
    })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
  });
});
