import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const print = vi.fn();
const store = vi.hoisted(() => ({
  analyticsReady: true,
  saveReportSnapshot: vi.fn(async (_input: Readonly<{
    reportType: 'WEEKLY' | 'MONTHLY';
    periodStart: string;
    periodEnd: string;
    payload: Readonly<Record<string, unknown>>;
  }>) => true),
  session: {
    source: 'imported',
    cloudWorkspace: null as null | { generation: number },
    trades: [
      { id: 't1', symbol: 'BTCUSDT', pnl: 10, exitTime: Date.UTC(2026, 7, 25) },
      { id: 't2', symbol: 'ETHUSDT', pnl: -4, exitTime: Date.UTC(2026, 7, 27) },
    ],
    reviews: { t1: { saw: 'a', happened: 'b', lesson: '等待确认', grade: 'A', reviewed: true, updatedAt: 1 } },
    actions: {},
    journal: [{ day: '2026-08-27', note: '保持耐心', emotion: '冷静', updatedAt: 1 }],
    guards: [],
    meta: null,
  },
}));

vi.mock('../store', () => ({ useStore: () => store }));

import ReportsView from './ReportsView';

describe('ReportsView', () => {
  it('renders an observed weekly report and exposes print plus plaintext-backup boundaries', async () => {
    vi.stubGlobal('print', print);
    const user = userEvent.setup();
    render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);

    expect(screen.getByRole('heading', { name: '周报 / 月报' })).toBeInTheDocument();
    expect(screen.getByText('2 笔')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText(/完整备份是未加密明文文件/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '报告边界' }).children).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '打印 / 存为 PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('writes the current preset report snapshot through the cloud Store adapter', async () => {
    const user = userEvent.setup();
    store.session.cloudWorkspace = { generation: 7 };
    store.saveReportSnapshot.mockClear();
    try {
      render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
      await user.click(screen.getByRole('button', { name: '保存云端报告' }));
      expect(store.saveReportSnapshot).toHaveBeenCalledWith({
        reportType: 'WEEKLY',
        periodStart: '2026-08-24',
        periodEnd: '2026-08-30',
        payload: expect.objectContaining({ from: '2026-08-24', to: '2026-08-30', tradeCount: 2 }),
      });
      expect(await screen.findByRole('status')).toHaveTextContent('当前报告已写入云端复盘数据');
    } finally {
      store.session.cloudWorkspace = null;
    }
  });

  it('never persists hidden outcome metrics while the cloud analytics gate is locked', async () => {
    const user = userEvent.setup();
    store.analyticsReady = false;
    store.session.cloudWorkspace = { generation: 7 };
    store.saveReportSnapshot.mockClear();
    try {
      render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
      await user.click(screen.getByRole('button', { name: '保存云端报告' }));
      const payload = store.saveReportSnapshot.mock.calls[0]?.[0]?.payload;
      expect(payload).toMatchObject({
        format: 'rv-cloud-review-report/1',
        analyticsStatus: 'LOCKED',
        from: '2026-08-24',
        to: '2026-08-30',
        tradeCount: 2,
        reviewed: 1,
      });
      expect(payload).not.toHaveProperty('netPnl');
      expect(payload).not.toHaveProperty('wins');
      expect(payload).not.toHaveProperty('losses');
      expect(payload).not.toHaveProperty('winRate');
      expect(payload).not.toHaveProperty('topSymbols');
    } finally {
      store.analyticsReady = true;
      store.session.cloudWorkspace = null;
    }
  });

  it('keeps all outcome-derived report labels hidden while analytics evidence is locked', () => {
    store.analyticsReady = false;
    render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
    expect(screen.getByText('胜负指标未解锁')).toBeInTheDocument();
    expect(screen.queryByText('1 胜 / 1 负')).not.toBeInTheDocument();
    expect(screen.queryByText('+$6.00')).not.toBeInTheDocument();
    expect(screen.getByText(/收益类指标保持关闭/)).toBeInTheDocument();
    store.analyticsReady = true;
  });

  it('keeps draft dates inert until the accessible custom range is applied', async () => {
    const user = userEvent.setup();
    render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);

    const from = screen.getByRole('textbox', { name: '起始日期' });
    const to = screen.getByRole('textbox', { name: '结束日期' });
    expect(from).toHaveValue('2026-08-24');
    expect(to).toHaveValue('2026-08-30');

    await user.clear(from);
    await user.type(from, '2026-08-27');
    await user.clear(to);
    await user.type(to, '2026-08-27');
    expect(screen.getByText('2 笔')).toBeInTheDocument();
    expect(screen.getByText('2026-08-24 — 2026-08-30')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '应用范围' }));
    expect(screen.getByText('闭环交易').parentElement).toHaveTextContent('1 笔');
    expect(screen.getByText('2026-08-27 — 2026-08-27')).toBeInTheDocument();
  });

  it('rejects empty and reversed dates without changing the applied report', async () => {
    const user = userEvent.setup();
    render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
    const from = screen.getByRole('textbox', { name: '起始日期' });
    const to = screen.getByRole('textbox', { name: '结束日期' });

    await user.clear(from);
    await user.click(screen.getByRole('button', { name: '应用范围' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写起始日期和结束日期。');
    expect(from).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('2026-08-24 — 2026-08-30')).toBeInTheDocument();

    await user.type(from, '2026-08-31');
    await user.clear(to);
    await user.type(to, '2026-08-30');
    await user.click(screen.getByRole('button', { name: '应用范围' }));
    expect(screen.getByRole('alert')).toHaveTextContent('起始日期不能晚于结束日期。');
    expect(screen.getByText('2 笔')).toBeInTheDocument();
  });

  it('rejects a custom range longer than 366 inclusive days', async () => {
    const user = userEvent.setup();
    render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
    const from = screen.getByRole('textbox', { name: '起始日期' });
    const to = screen.getByRole('textbox', { name: '结束日期' });

    await user.clear(from);
    await user.type(from, '2024-01-01');
    await user.clear(to);
    await user.type(to, '2025-01-01');
    await user.click(screen.getByRole('button', { name: '应用范围' }));

    expect(screen.getByRole('alert')).toHaveTextContent('日期范围最多 366 天。');
    expect(screen.getByText('2026-08-24 — 2026-08-30')).toBeInTheDocument();
  });

  it('keeps the page usable and explains when an exact plaintext backup cannot be serialized', async () => {
    const user = userEvent.setup();
    const originalLesson = store.session.reviews.t1.lesson;
    store.session.reviews.t1.lesson = 'x'.repeat(20_000);
    try {
      render(<ReportsView reference={new Date('2026-08-28T12:00:00Z')} />);
      await user.click(screen.getByRole('checkbox', { name: /不再受云仓端到端加密保护/ }));
      await user.click(screen.getByRole('button', { name: '下载完整备份' }));
      expect(screen.getByRole('alert')).toHaveTextContent(/备份无法生成/);
      expect(screen.getByRole('button', { name: '下载完整备份' })).toBeEnabled();
    } finally {
      store.session.reviews.t1.lesson = originalLesson;
    }
  });
});
