import { describe, expect, it } from 'vitest';
import {
  buildReviewReport,
  REPORT_WINDOW_MAX_DAYS,
  reportWindow,
  validateReportWindow,
} from './review-report';

const trades = [
  { id: 't1', symbol: 'BTCUSDT', pnl: 10, exitTime: Date.UTC(2026, 7, 25) },
  { id: 't2', symbol: 'ETHUSDT', pnl: -4, exitTime: Date.UTC(2026, 7, 27) },
  { id: 'old', symbol: 'BTCUSDT', pnl: 99, exitTime: Date.UTC(2026, 6, 1) },
];

describe('review reports', () => {
  it('builds a deterministic observed-range weekly report', () => {
    const report = buildReviewReport({
      trades,
      reviews: {
        t1: { saw: 'a', happened: 'b', lesson: '等待确认', grade: 'A', reviewed: true, updatedAt: 1 },
      },
      actions: {
        'trade:t1': {
          id: 'trade:t1', sourceTradeId: 't1', text: '等待确认', status: 'done',
          createdAt: 1, updatedAt: 2, completedAt: 2,
        },
      },
      journal: [{ day: '2026-08-27', note: '保持耐心', emotion: '冷静', updatedAt: 1 }],
      guards: [{ id: 'g1', text: '三连亏停止', active: true, createdAt: 1, updatedAt: 1 }],
    }, { from: '2026-08-24', to: '2026-08-30' });

    expect(report).toMatchObject({
      tradeCount: 2,
      netPnl: 6,
      wins: 1,
      losses: 1,
      reviewed: 1,
      reviewRate: 0.5,
      openActions: 0,
      completedActions: 1,
      journalDays: 1,
      activeGuards: 1,
    });
    expect(report.topSymbols[0]).toEqual({ symbol: 'BTCUSDT', trades: 1, netPnl: 10 });
    expect(report.lessons).toEqual(['等待确认']);
  });

  it('derives Monday-Sunday and calendar-month windows in Asia/Shanghai', () => {
    expect(reportWindow(new Date('2026-08-28T12:00:00Z'), 'week'))
      .toEqual({ from: '2026-08-24', to: '2026-08-30' });
    expect(reportWindow(new Date('2026-08-28T12:00:00Z'), 'month'))
      .toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(reportWindow(new Date('2026-08-30T16:30:00Z'), 'week'))
      .toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(reportWindow(new Date('2026-08-31T16:30:00Z'), 'month'))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('includes trades by their Asia/Shanghai close day at the exact day boundary', () => {
    const report = buildReviewReport({
      trades: [
        { id: 'before', symbol: 'BTCUSDT', pnl: 1, exitTime: Date.parse('2026-08-30T15:59:59.999Z') },
        { id: 'inside', symbol: 'ETHUSDT', pnl: 2, exitTime: Date.parse('2026-08-30T16:00:00.000Z') },
        { id: 'after', symbol: 'SOLUSDT', pnl: 3, exitTime: Date.parse('2026-09-06T16:00:00.000Z') },
      ],
      reviews: {}, actions: {}, journal: [], guards: [],
    }, { from: '2026-08-31', to: '2026-09-06' });
    expect(report.tradeCount).toBe(1);
    expect(report.netPnl).toBe(2);
  });

  it('accepts real ISO calendar days and reports the inclusive day count', () => {
    expect(validateReportWindow({ from: '2024-02-29', to: '2024-02-29' })).toEqual({
      ok: true,
      window: { from: '2024-02-29', to: '2024-02-29' },
      days: 1,
    });
    expect(validateReportWindow({ from: '2024-01-01', to: '2024-12-31' })).toMatchObject({
      ok: true,
      days: REPORT_WINDOW_MAX_DAYS,
    });
  });

  it.each([
    [{ from: '', to: '2026-08-30' }, 'REPORT_WINDOW_REQUIRED', '请填写起始日期和结束日期。'],
    [{ from: '2026-8-01', to: '2026-08-30' }, 'REPORT_WINDOW_INVALID', '日期必须是有效的 YYYY-MM-DD。'],
    [{ from: '2026-02-29', to: '2026-03-01' }, 'REPORT_WINDOW_INVALID', '日期必须是有效的 YYYY-MM-DD。'],
    [{ from: '2026-08-31', to: '2026-08-30' }, 'REPORT_WINDOW_ORDER', '起始日期不能晚于结束日期。'],
    [{ from: '2024-01-01', to: '2025-01-01' }, 'REPORT_WINDOW_TOO_LARGE', '日期范围最多 366 天。'],
  ] as const)('rejects an invalid custom report window %#', (window, code, message) => {
    expect(validateReportWindow(window)).toEqual({ ok: false, code, message });
  });

  it('fails closed when callers bypass the UI with an oversized report window', () => {
    expect(() => buildReviewReport({
      trades: [], reviews: {}, actions: {}, journal: [], guards: [],
    }, { from: '2024-01-01', to: '2025-01-01' })).toThrow('REPORT_WINDOW_TOO_LARGE');
  });
});
