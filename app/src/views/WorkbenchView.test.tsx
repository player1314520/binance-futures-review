import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  analyticsReady: false,
  exportSession: vi.fn(),
  setActionStatus: vi.fn(async () => true),
  setActionExperiment: vi.fn(async () => true),
  recordActionExperimentObservation: vi.fn(async () => true),
  decideActionExperiment: vi.fn(async () => true),
  session: {
    source: 'imported',
    persistence: 'browser',
    trades: [{
      id: 'trade-1', symbol: 'BTCUSDT', market: 'USDM', side: 'LONG',
      entryTime: 1_700_000_000_000, exitTime: 1_700_000_060_000,
      entryPrice: 60_000, exitPrice: 60_100, qty: 0.01, fee: 0.2, pnl: 1,
      currency: 'USDT', source: 'csv-report', riskFallback: true, oneR: 1,
      rMultiple: 1, mfeReal: false, mfeR: 0, maeR: 0, leftOnTable: null,
      session: 'asia', sessionLabel: '亚洲', sessionClass: 'asia', sessionThin: false,
    }],
    reviews: {},
    actions: {} as Record<string, unknown>,
  },
}));

vi.mock('../store', () => ({ useStore: () => store }));

import WorkbenchView from './WorkbenchView';

function action(experiment: unknown = null, status: 'open' | 'done' | 'dismissed' = 'open') {
  return {
    id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '进场前先写失效条件', status,
    createdAt: 100, updatedAt: 200, completedAt: status === 'open' ? null : 200, experiment,
  };
}

function pendingExperiment(overrides: Record<string, unknown> = {}) {
  return {
    hypothesis: '先写失效条件能提高动作执行率', targetCount: 2,
    observedCount: 0, successfulCount: 0,
    windowStart: '2026-08-29', windowEnd: '2026-09-05', successCriterion: 2,
    evidenceNote: '', decision: 'pending', observations: [], updatedAt: 200,
    ...overrides,
  };
}

function renderLab() {
  return render(<MemoryRouter><WorkbenchView mode="experiments" /></MemoryRouter>);
}

describe('Workbench behavior experiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.session.actions = { 'trade:trade-1': action() };
  });

  it('persists an explicit hypothesis, bounded window, sample target, and execution criterion', async () => {
    const user = userEvent.setup();
    renderLab();

    expect(screen.getByText('0/1 已闭环')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('可检验假设'));
    await user.type(screen.getByLabelText('可检验假设'), '等待确认后再进场能提高计划执行率');
    await user.clear(screen.getByLabelText('目标机会数'));
    await user.type(screen.getByLabelText('目标机会数'), '4');
    await user.clear(screen.getByLabelText('至少执行次数'));
    await user.type(screen.getByLabelText('至少执行次数'), '3');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-29' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-10' } });
    await user.click(screen.getByRole('button', { name: '开始实验并持久化' }));

    await waitFor(() => expect(store.setActionExperiment).toHaveBeenCalledWith('trade:trade-1', {
      hypothesis: '等待确认后再进场能提高计划执行率',
      targetCount: 4,
      windowStart: '2026-08-29',
      windowEnd: '2026-09-10',
      successCriterion: 3,
    }));
    expect(screen.getByText(/只检验这一个动作是否按计划执行/)).toBeInTheDocument();
  });

  it('records one evidence note with an explicit followed or missed result', async () => {
    const user = userEvent.setup();
    store.session.actions = { 'trade:trade-1': action(pendingExperiment()) };
    renderLab();

    fireEvent.change(screen.getByLabelText('观察日期'), { target: { value: '2026-08-30' } });
    await user.selectOptions(screen.getByLabelText('动作结果'), 'no');
    await user.type(screen.getByLabelText('证据说明'), '复盘 trade-2：条件未确认仍然进场');
    await user.click(screen.getByRole('button', { name: '保存本次观察' }));

    await waitFor(() => expect(store.recordActionExperimentObservation).toHaveBeenCalledWith(
      'trade:trade-1',
      { day: '2026-08-30', followed: false, evidenceNote: '复盘 trade-2：条件未确认仍然进场' },
    ));
  });

  it('requires a written decision after the target sample and keeps the PnL boundary visible', async () => {
    const user = userEvent.setup();
    store.session.actions = {
      'trade:trade-1': action(pendingExperiment({
        observedCount: 2,
        successfulCount: 1,
        observations: [
          { day: '2026-08-30', followed: true, evidenceNote: 'trade-2 已执行' },
          { day: '2026-09-01', followed: false, evidenceNote: 'trade-3 未执行' },
        ],
      })),
    };
    renderLab();

    expect(screen.getByText('未达到预设执行标准')).toBeInTheDocument();
    expect(screen.getByText(/不是盈亏改善或因果证明/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('实验决策'), 'revise');
    await user.type(screen.getByLabelText('结论与限制'), '仅 1/2 次执行，缩小触发条件后再测。');
    await user.click(screen.getByRole('button', { name: '保存决策并闭环' }));

    await waitFor(() => expect(store.decideActionExperiment).toHaveBeenCalledWith(
      'trade:trade-1', 'revise', '仅 1/2 次执行，缩小触发条件后再测。',
    ));
  });

  it('does not count a legacy completed checkbox as verified evidence', async () => {
    const user = userEvent.setup();
    store.session.actions = { 'trade:trade-1': action(null, 'done') };
    renderLab();

    expect(screen.getByText(/没有样本窗口和逐次证据，因此不计作已验证实验/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新打开并设计实验' }));
    expect(store.setActionStatus).toHaveBeenCalledWith('trade:trade-1', 'open');
  });

  it('keeps revise open and offers a persisted redesign instead of a dead-end conclusion', async () => {
    const user = userEvent.setup();
    store.session.actions = {
      'trade:trade-1': action({
        ...pendingExperiment({
          observedCount: 2,
          successfulCount: 1,
          observations: [
            { day: '2026-08-30', followed: true, evidenceNote: 'trade-2 已执行' },
            { day: '2026-09-01', followed: false, evidenceNote: 'trade-3 未执行' },
          ],
        }),
        decision: 'revise',
        evidenceNote: '缩小触发条件后重测。',
      }, 'open'),
    };
    renderLab();

    expect(screen.getByText('1/1 已闭环')).toBeInTheDocument();
    expect(screen.getAllByText('修改后重测')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '按结论重新设计' }));
    await user.clear(screen.getByLabelText('可检验假设'));
    await user.type(screen.getByLabelText('可检验假设'), '只在二次确认后执行');
    await user.clear(screen.getByLabelText('目标机会数'));
    await user.type(screen.getByLabelText('目标机会数'), '2');
    await user.clear(screen.getByLabelText('至少执行次数'));
    await user.type(screen.getByLabelText('至少执行次数'), '2');
    await user.click(screen.getByRole('button', { name: '保存新版实验并重新取证' }));

    await waitFor(() => expect(store.setActionExperiment).toHaveBeenCalledWith('trade:trade-1', expect.objectContaining({
      hypothesis: '只在二次确认后执行', targetCount: 2, successCriterion: 2,
    })));
  });
});
