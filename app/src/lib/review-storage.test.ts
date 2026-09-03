import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLocalReviewData,
  datasetReviewScope,
  exportReviewsScope,
  loadReviews,
  normalizeReviewMap,
  replaceReviewsScope,
  reviewStorageKey,
  saveReview,
} from './review-storage';

describe('account-scoped review storage', () => {
  beforeEach(() => localStorage.clear());

  it('removes review records and the retired imported-session cache only', () => {
    localStorage.setItem('rv-review-v1:demo-v1', '{"1":{}}');
    localStorage.setItem('rv-review-v1:import-v2-1234', '{"2":{}}');
    localStorage.setItem('rv2-session', '{"legacy":true}');
    localStorage.setItem('rv-theme', 'dark');

    expect(clearLocalReviewData()).toBe(3);
    expect(localStorage.getItem('rv-review-v1:demo-v1')).toBeNull();
    expect(localStorage.getItem('rv2-session')).toBeNull();
    expect(localStorage.getItem('rv-theme')).toBe('dark');
  });

  it('uses separate opaque namespaces for demo, import and Binance scopes', () => {
    expect(reviewStorageKey('demo-v1')).not.toBe(reviewStorageKey('import-abcd'));
    expect(reviewStorageKey('binance-a1b2c3')).not.toBe(reviewStorageKey('binance-d4e5f6'));
  });

  it('uses a SHA-256 identity over all economic trade fields', async () => {
    const base = {
      id: 'trade-1', symbol: 'BTCUSDT', side: 'LONG',
      entryTime: 1, exitTime: 2, entryPrice: 100, exitPrice: 110,
      qty: 1, notional: 100, fee: 0.1, pnl: 9.9, currency: 'USDT',
    };
    const first = await datasetReviewScope([base]);
    const repeated = await datasetReviewScope([{ ...base }]);
    const otherPrice = await datasetReviewScope([{ ...base, entryPrice: 101 }]);
    const otherFee = await datasetReviewScope([{ ...base, fee: 0.2 }]);

    expect(first).toMatch(/^import-v2-[0-9a-f]{32}$/);
    expect(repeated).toBe(first);
    expect(otherPrice).not.toBe(first);
    expect(otherFee).not.toBe(first);
  });

  it('refuses persistence when a real account has no stable scope', () => {
    expect(reviewStorageKey(null)).toBeNull();
    expect(saveReview(null, 'trade-1', {
      saw: '突破失败', happened: '追单', lesson: '等待收线', grade: 'C', reviewed: true,
    })).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('round-trips only the review allowlist inside its scope', () => {
    expect(saveReview('binance-a1b2c3', 'trade-1', {
      saw: '  价格跌破失效位  ',
      happened: '没有执行止损',
      lesson: '下次触发即离场',
      grade: 'D',
      reviewed: true,
      ignored: 'must not persist',
    } as never)).toBe(true);

    expect(loadReviews('binance-a1b2c3')).toEqual({
      'trade-1': expect.objectContaining({
        saw: '价格跌破失效位',
        happened: '没有执行止损',
        lesson: '下次触发即离场',
        grade: 'D',
        reviewed: true,
      }),
    });
    expect(JSON.stringify(loadReviews('binance-a1b2c3'))).not.toContain('ignored');
    expect(loadReviews('binance-d4e5f6')).toEqual({});
  });

  it('rejects overlong review text instead of silently truncating it', () => {
    expect(saveReview('demo-v1', 'trade-1', {
      saw: 'x'.repeat(601),
      happened: '按计划执行',
      lesson: '继续执行',
      grade: 'B',
      reviewed: true,
    })).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('strictly replaces a whole scope while preserving review timestamps', () => {
    const reviews = {
      'trade-1': {
        saw: '  到达计划区  ', happened: '按计划成交', lesson: '继续等待确认',
        grade: 'A' as const, reviewed: true, updatedAt: 123,
      },
    };
    const replaced = replaceReviewsScope('scope-one', reviews);
    expect(replaced).toEqual({
      'trade-1': expect.objectContaining({ saw: '到达计划区', updatedAt: 123 }),
    });
    expect(exportReviewsScope('scope-one')).toBe(JSON.stringify(replaced));
    expect(loadReviews('scope-one')['trade-1']?.updatedAt).toBe(123);
  });

  it('rejects a malformed whole-scope replacement without changing the prior raw value', () => {
    expect(replaceReviewsScope('scope-one', {
      'trade-1': {
        saw: '观察', happened: '执行', lesson: '复核', grade: 'B', reviewed: true, updatedAt: 10,
      },
    })).not.toBeNull();
    const key = reviewStorageKey('scope-one')!;
    const before = localStorage.getItem(key);
    expect(replaceReviewsScope('scope-one', {
      'trade-1': {
        saw: '观察', happened: '执行', lesson: '复核', grade: 'B', reviewed: true, updatedAt: 10,
        extra: 'reject',
      },
    })).toBeNull();
    expect(localStorage.getItem(key)).toBe(before);
  });

  it('rejects dangerous map keys and non-string grades without touching object prototypes', () => {
    const row = '{"saw":"观察","happened":"执行","lesson":"复核","grade":"B","reviewed":true,"updatedAt":10}';
    const polluted = JSON.parse(`{"__proto__":${row}}`);
    expect(normalizeReviewMap(polluted)).toBeNull();
    expect(normalizeReviewMap({ 'trade-1': {
      saw: '观察', happened: '执行', lesson: '复核', grade: { toString: () => 'B' },
      reviewed: true, updatedAt: 10,
    } })).toBeNull();

    localStorage.setItem(reviewStorageKey('scope-one')!, JSON.stringify(polluted));
    expect(loadReviews('scope-one')).toEqual({});
    expect(saveReview('scope-one', '__proto__', {
      saw: '观察', happened: '执行', lesson: '复核', grade: 'B', reviewed: true,
    })).toBe(false);
    expect(Object.prototype).not.toHaveProperty('saw');
  });

  it('uses an inheritance-free dictionary for otherwise valid record-like trade ids', () => {
    expect(saveReview('scope-one', 'toString', {
      saw: '观察', happened: '执行', lesson: '复核', grade: 'B', reviewed: true,
    })).toBe(true);
    const reviews = loadReviews('scope-one');
    expect(Object.getPrototypeOf(reviews)).toBeNull();
    expect(Object.hasOwn(reviews, 'toString')).toBe(true);
    expect((reviews as unknown as Record<string, { lesson: string }>)['toString']?.lesson).toBe('复核');
    expect((reviews as unknown as Record<string, unknown>).valueOf).toBeUndefined();
  });
});
