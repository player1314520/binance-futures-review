import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  saveJournal: vi.fn(() => true),
  saveGuard: vi.fn(() => true),
  setGuardActive: vi.fn(() => true),
  session: {
    journal: [{ day: '2026-08-27', note: '保持耐心', emotion: '冷静', updatedAt: 1 }],
    guards: [{ id: 'g1', text: '连续亏损三笔后停止', active: true, createdAt: 1, updatedAt: 1 }],
  },
}));

vi.mock('../store', () => ({ useStore: () => store }));

import ReviewLoopView from './ReviewLoopView';

describe('ReviewLoopView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a daily journal and creates/toggles a pre-trade guard', async () => {
    const user = userEvent.setup();
    render(<ReviewLoopView mode="ritual" />);

    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-08-28' } });
    await user.type(screen.getByLabelText('今日状态'), '专注');
    await user.type(screen.getByLabelText('复盘日志'), '只做计划内交易');
    await user.click(screen.getByRole('button', { name: '保存今日日志' }));
    expect(store.saveJournal).toHaveBeenCalledWith('2026-08-28', '只做计划内交易', '专注');

    await user.type(screen.getByLabelText('新增风控守则'), '达到日亏损上限后停止');
    await user.click(screen.getByRole('button', { name: '添加守则' }));
    expect(store.saveGuard).toHaveBeenCalledWith('达到日亏损上限后停止');

    await user.click(screen.getByRole('button', { name: '停用守则：连续亏损三笔后停止' }));
    expect(store.setGuardActive).toHaveBeenCalledWith('g1', false);
  });
});
