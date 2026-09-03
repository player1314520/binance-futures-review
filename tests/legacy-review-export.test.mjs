import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLASSIC_REVIEW_EXPORT_FORMAT,
  CLASSIC_REVIEW_EXPORT_LIMITS,
  ClassicReviewExportError,
  buildClassicReviewExport,
  serializeClassicReviewExport,
} from '../frontend/legacy-review-export.js';

class ReadOnlyStorage {
  constructor(entries) {
    this.entries = new Map(Object.entries(entries));
    this.reads = [];
  }

  getItem(key) {
    this.reads.push(key);
    return this.entries.has(key) ? this.entries.get(key) : null;
  }

  removeItem() {
    throw new Error('legacy keys must not be deleted');
  }

  clear() {
    throw new Error('legacy storage must not be cleared');
  }
}

function storage(overrides = {}) {
  return new ReadOnlyStorage({
    'rv-reviews': JSON.stringify({
      'trade-2': {
        saw: '等待突破',
        did: '追价进场',
        learn: '等收线确认',
        grade: 'C',
        reviewed: true,
        apiKey: 'must-not-leave-classic',
        fills: [{ symbol: 'BTCUSDT', price: 60_000 }],
      },
      'trade-1': {
        saw: '回踩支撑',
        did: '按计划进场',
        learn: '继续执行',
        grade: 'A',
        reviewed: false,
        token: 'must-not-leave-classic-either',
      },
    }),
    'rv-guards': JSON.stringify({
      maxLoss: 400,
      maxTrades: 3,
      maxRiskR: 1.5,
      apiSecret: 'must-not-leave-guards',
    }),
    'rv-agent': JSON.stringify({ token: 'local-agent-secret' }),
    'rv-binance': JSON.stringify({ apiKey: 'binance-secret' }),
    ...overrides,
  });
}

test('exports only the review allowlist and three display-only risk numbers', () => {
  const source = storage();
  const exported = buildClassicReviewExport(source);

  assert.equal(exported.format, CLASSIC_REVIEW_EXPORT_FORMAT);
  assert.deepEqual(exported.riskLimits, {
    maxLoss: 400,
    maxTrades: 3,
    maxRiskR: 1.5,
  });
  assert.deepEqual(exported.reviews.map((review) => review.tradeId), ['trade-1', 'trade-2']);
  for (const review of exported.reviews) {
    assert.deepEqual(
      Object.keys(review).sort(),
      ['did', 'grade', 'learn', 'reviewed', 'saw', 'tradeId'],
    );
  }

  const serialized = serializeClassicReviewExport(source);
  assert.deepEqual(JSON.parse(serialized), exported);
  assert.doesNotMatch(serialized, /api|token|secret|fills|symbol|price/iu);
  assert.deepEqual(source.reads, ['rv-reviews', 'rv-guards', 'rv-reviews', 'rv-guards']);
  assert.equal(source.entries.has('rv-reviews'), true);
  assert.equal(source.entries.has('rv-guards'), true);
  assert.equal(source.entries.has('rv-agent'), true);
});

test('preserves missing grade and target-overlong text for explicit migration issues', () => {
  const overlong = 'x'.repeat(601);
  const source = storage({
    'rv-reviews': JSON.stringify({
      'trade-1': { saw: overlong, did: '', learn: '', reviewed: false },
    }),
    'rv-guards': null,
  });

  const exported = buildClassicReviewExport(source);
  assert.equal(Object.hasOwn(exported.reviews[0], 'grade'), false);
  assert.equal(exported.reviews[0].saw, overlong);
  assert.equal(exported.riskLimits, null);

  const toggledOff = buildClassicReviewExport(storage({
    'rv-reviews': JSON.stringify({
      'trade-1': { saw: '', did: '', learn: '', grade: null, reviewed: false },
    }),
  }));
  assert.equal(toggledOff.reviews[0].grade, null);
});

test('rejects resource abuse instead of truncating source review text', () => {
  const tooLong = 'x'.repeat(CLASSIC_REVIEW_EXPORT_LIMITS.sourceFieldCharacters + 1);
  const source = storage({
    'rv-reviews': JSON.stringify({
      'trade-1': {
        saw: tooLong,
        did: '',
        learn: '',
        grade: 'B',
        reviewed: false,
      },
    }),
  });

  assert.throws(
    () => buildClassicReviewExport(source),
    (error) => error instanceof ClassicReviewExportError && error.code === 'RESOURCE_LIMIT',
  );
});

test('rejects dangerous review IDs and malformed risk numbers without polluting prototypes', () => {
  const polluted = storage({
    'rv-reviews': '{"__proto__":{"saw":"x","did":"y","learn":"z","grade":"A","reviewed":true}}',
  });
  assert.throws(
    () => buildClassicReviewExport(polluted),
    (error) => error instanceof ClassicReviewExportError && error.code === 'INVALID_REVIEW_ID',
  );
  assert.equal(Object.prototype.polluted, undefined);

  const malformedRisk = storage({
    'rv-guards': JSON.stringify({ maxLoss: 400, maxTrades: '3', maxRiskR: 1.5 }),
  });
  assert.throws(
    () => buildClassicReviewExport(malformedRisk),
    (error) => error instanceof ClassicReviewExportError && error.code === 'INVALID_RISK_LIMITS',
  );
});

test('rejects non-string review primitives rather than serializing arbitrary values', () => {
  const source = storage({
    'rv-reviews': JSON.stringify({
      'trade-1': { saw: { token: 'nested' }, did: '', learn: '', grade: 'A', reviewed: true },
    }),
  });

  assert.throws(
    () => buildClassicReviewExport(source),
    (error) => error instanceof ClassicReviewExportError && error.code === 'INVALID_REVIEW_FIELD',
  );
});
