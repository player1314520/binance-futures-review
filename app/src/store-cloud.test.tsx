import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  start: vi.fn(),
  credentials: vi.fn(),
  review: vi.fn(),
  action: vi.fn(),
  journal: vi.fn(),
  risk: vi.fn(),
  report: vi.fn(),
}));

vi.mock('./lib/binance-source', () => ({
  loadBinanceSnapshot: mocks.load,
  startBinanceSync: mocks.start,
  storeBinanceCredentials: mocks.credentials,
  upsertCloudTradeReview: mocks.review,
  updateCloudAction: mocks.action,
  upsertCloudJournal: mocks.journal,
  upsertCloudRiskRule: mocks.risk,
  upsertCloudReport: mocks.report,
  safeRuntimeError: () => 'CLOUD_FAILURE',
}));

import { AuthProvider } from './lib/auth-context';
import { WorkspaceProvider } from './lib/workspace-context';
import { StoreProvider, useStore } from './store';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const REVIEW_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';
const RULE_ID = '44444444-4444-4444-8444-444444444444';
const NEW_RULE_ID = '55555555-5555-4555-8555-555555555555';
const TRADE_ID = 't_0123456789abcdef';

function cloudSnapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  const review = {
    saw: '形态', happened: '执行', lesson: '等待确认', grade: 'A', reviewed: true, updatedAt: 1,
  } as const;
  const action = {
    id: ACTION_ID,
    sourceTradeId: TRADE_ID,
    text: '等待确认',
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    experiment: null,
  } as const;
  return {
    runtime: { sync: { state: 'COMPLETED' } },
    bundle: {},
    access: { phase: 'BINANCE_OBSERVED_READY' },
    trades: [{ id: TRADE_ID, symbol: 'BTCUSDT', pnl: 5, exitTime: 1 }],
    records: [],
    reviewScope: 'rv1_0123456789abcdef0123456789abcdef',
    cloudWorkspace: {
      connectionId: CONNECTION_ID,
      generation: 7,
      reviews: { [TRADE_ID]: review },
      actions: { [ACTION_ID]: action },
      journal: [{ day: '2026-08-31', note: '旧日志', emotion: '冷静', updatedAt: 1 }],
      guards: [{ id: RULE_ID, text: '最大风险 1R', active: true, createdAt: 1, updatedAt: 1 }],
      reports: [],
      reviewVersions: { [TRADE_ID]: 2 },
      actionVersions: { [ACTION_ID]: 3 },
      actionBindings: { [ACTION_ID]: { reviewId: REVIEW_ID, tradeId: TRADE_ID } },
      journalVersions: { '2026-08-31': 4 },
      riskVersions: { [RULE_ID]: 5 },
      reportVersions: {},
      capabilities: {
        experiments: { decision: 'ALLOW', reasonCodes: [] },
      },
      ...overrides,
    },
  };
}

function Harness() {
  const store = useStore();
  const [result, setResult] = useState('idle');
  const run = (operation: Promise<boolean>) => {
    void operation.then((ok) => setResult(ok ? 'ok' : 'failed'));
  };
  return (
    <div>
      <output aria-label="phase">{store.session.phase}</output>
      <output aria-label="lesson">{store.session.reviews[TRADE_ID]?.lesson ?? 'none'}</output>
      <output aria-label="action">{store.session.actions[ACTION_ID]?.status ?? 'none'}</output>
      <output aria-label="decision">{store.session.actions[ACTION_ID]?.experiment?.decision ?? 'none'}</output>
      <output aria-label="observed">{store.session.actions[ACTION_ID]?.experiment?.observedCount ?? 0}</output>
      <output aria-label="journal">{store.session.journal[0]?.note ?? 'none'}</output>
      <output aria-label="guard">{store.session.guards[0]?.active ? 'active' : 'paused'}</output>
      <output aria-label="guard-count">{store.session.guards.length}</output>
      <output aria-label="result">{result}</output>
      <button type="button" onClick={() => void store.loadBinance()}>load</button>
      <button type="button" onClick={() => run(store.saveTradeReview(TRADE_ID, {
        saw: '形态', happened: '执行', lesson: '只做确认', grade: 'A', reviewed: true,
      }))}>review</button>
      <button type="button" onClick={() => run(store.setActionStatus(ACTION_ID, 'done'))}>action</button>
      <button type="button" onClick={() => run(store.setActionExperiment(ACTION_ID, {
        hypothesis: '等待确认能减少追单', targetCount: 1,
        windowStart: '2026-08-31', windowEnd: '2026-09-06', successCriterion: 1,
      }))}>experiment</button>
      <button type="button" onClick={() => run(store.recordActionExperimentObservation(ACTION_ID, {
        day: '2026-08-31', followed: true, evidenceNote: '已按计划等待确认',
      }))}>observation</button>
      <button type="button" onClick={() => run(store.decideActionExperiment(
        ACTION_ID, 'adopt', '一次执行符合规则，保留动作。',
      ))}>decision</button>
      <button type="button" onClick={() => run(store.saveJournal('2026-08-31', '新日志', '平静'))}>journal</button>
      <button type="button" onClick={() => run(store.setGuardActive(RULE_ID, false))}>guard</button>
      <button type="button" onClick={() => run(store.saveGuard('连续亏损 3 笔后停止'))}>new guard</button>
      <button type="button" onClick={() => run(store.saveReportSnapshot({
        reportType: 'WEEKLY', periodStart: '2026-08-24', periodEnd: '2026-08-30',
        payload: { tradeCount: 1 },
      }))}>report</button>
    </div>
  );
}

function renderStore() {
  return render(
    <AuthProvider>
      <WorkspaceProvider>
        <StoreProvider><Harness /></StoreProvider>
      </WorkspaceProvider>
    </AuthProvider>,
  );
}

describe('Store invitation Beta relational persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.review.mockResolvedValue({});
    mocks.action.mockResolvedValue({});
    mocks.journal.mockResolvedValue({});
    mocks.risk.mockResolvedValue({});
    mocks.report.mockResolvedValue({});
  });

  it('hydrates and mutates cloud state through CAS adapters without browser persistence', async () => {
    const updatedReview = cloudSnapshot({
      reviews: {
        [TRADE_ID]: {
          saw: '形态', happened: '执行', lesson: '只做确认', grade: 'A', reviewed: true, updatedAt: 2,
        },
      },
      reviewVersions: { [TRADE_ID]: 3 },
    });
    const updatedAction = cloudSnapshot({
      actions: {
        [ACTION_ID]: {
          ...cloudSnapshot().cloudWorkspace.actions[ACTION_ID],
          status: 'done', updatedAt: 2, completedAt: 2,
        },
      },
      actionVersions: { [ACTION_ID]: 4 },
    });
    const updatedJournal = cloudSnapshot({
      journal: [{ day: '2026-08-31', note: '新日志', emotion: '平静', updatedAt: 2 }],
      journalVersions: { '2026-08-31': 5 },
    });
    const updatedRisk = cloudSnapshot({
      guards: [{ id: RULE_ID, text: '最大风险 1R', active: false, createdAt: 1, updatedAt: 2 }],
      riskVersions: { [RULE_ID]: 6 },
    });
    const updatedReport = cloudSnapshot({
      reportVersions: { 'WEEKLY:2026-08-24:2026-08-30': 1 },
    });
    mocks.load
      .mockResolvedValueOnce(cloudSnapshot())
      .mockResolvedValueOnce(updatedReview)
      .mockResolvedValueOnce(updatedAction)
      .mockResolvedValueOnce(updatedJournal)
      .mockResolvedValueOnce(updatedRisk)
      .mockResolvedValueOnce(updatedReport);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_OBSERVED_READY'));
    const writesAfterLoad = setItem.mock.calls.length;
    expect(screen.getByLabelText('lesson')).toHaveTextContent('等待确认');

    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByLabelText('lesson')).toHaveTextContent('只做确认'));
    expect(mocks.review).toHaveBeenCalledWith(
      CONNECTION_ID,
      TRADE_ID,
      2,
      { saw: '形态', happened: '执行', lesson: '只做确认', grade: 'A', reviewed: true },
    );

    fireEvent.click(screen.getByRole('button', { name: 'action' }));
    await waitFor(() => expect(screen.getByLabelText('action')).toHaveTextContent('done'));
    expect(mocks.action).toHaveBeenCalledWith(CONNECTION_ID, ACTION_ID, expect.objectContaining({
      expectedVersion: 3,
      reviewId: REVIEW_ID,
      tradeId: TRADE_ID,
      status: 'DONE',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => expect(screen.getByLabelText('journal')).toHaveTextContent('新日志'));
    expect(mocks.journal).toHaveBeenCalledWith(
      CONNECTION_ID, '2026-08-31', 4, { note: '新日志', emotion: '平静' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'guard' }));
    await waitFor(() => expect(screen.getByLabelText('guard')).toHaveTextContent('paused'));
    expect(mocks.risk).toHaveBeenCalledWith(CONNECTION_ID, RULE_ID, {
      expectedVersion: 5,
      status: 'PAUSED',
      payload: { text: '最大风险 1R', active: false },
    });

    fireEvent.click(screen.getByRole('button', { name: 'report' }));
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(6));
    expect(mocks.report).toHaveBeenCalledWith(CONNECTION_ID, {
      expectedVersion: 0,
      reportType: 'WEEKLY',
      periodStart: '2026-08-24',
      periodEnd: '2026-08-30',
      sourceGeneration: 7,
      payload: { tradeCount: 1 },
    });
    expect(setItem.mock.calls).toHaveLength(writesAfterLoad);
  });

  it('does not optimistically mutate or claim success when the cloud CAS fails', async () => {
    mocks.load.mockResolvedValueOnce(cloudSnapshot());
    mocks.review.mockRejectedValueOnce(new Error('conflict'));
    renderStore();
    fireEvent.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByLabelText('lesson')).toHaveTextContent('等待确认'));

    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByLabelText('result')).toHaveTextContent('failed'));
    expect(screen.getByLabelText('lesson')).toHaveTextContent('等待确认');
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it('keeps a trusted server lifecycle reviewable while outcome analytics remain locked', async () => {
    const browse = {
      ...cloudSnapshot(),
      access: { phase: 'BINANCE_BROWSE_ONLY' },
      trades: [{ id: TRADE_ID, symbol: 'BTCUSDT', pnl: 0, fee: 0, exitTime: 1 }],
      cloudWorkspace: {
        ...cloudSnapshot().cloudWorkspace,
        capabilities: {
          experiments: { decision: 'DENY', reasonCodes: ['RECONCILIATION_UNKNOWN'] },
        },
      },
    };
    const refreshed = {
      ...browse,
      cloudWorkspace: {
        ...browse.cloudWorkspace,
        reviews: {
          [TRADE_ID]: {
            saw: '形态', happened: '执行', lesson: '只做确认',
            grade: 'A', reviewed: true, updatedAt: 2,
          },
        },
        reviewVersions: { [TRADE_ID]: 3 },
      },
    };
    mocks.load.mockResolvedValueOnce(browse).mockResolvedValueOnce(refreshed);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_BROWSE_ONLY'));
    const writesAfterLoad = setItem.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByLabelText('lesson')).toHaveTextContent('只做确认'));
    expect(mocks.review).toHaveBeenCalledWith(
      CONNECTION_ID,
      TRADE_ID,
      2,
      { saw: '形态', happened: '执行', lesson: '只做确认', grade: 'A', reviewed: true },
    );
    expect(setItem.mock.calls).toHaveLength(writesAfterLoad);
    mocks.action.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'experiment' }));
    await waitFor(() => expect(screen.getByLabelText('result')).toHaveTextContent('failed'));
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it('persists experiment setup, observation, conclusion, and new risk guards through cloud CAS', async () => {
    const configuredExperiment = {
      hypothesis: '等待确认能减少追单', targetCount: 1, observedCount: 0, successfulCount: 0,
      windowStart: '2026-08-31', windowEnd: '2026-09-06', successCriterion: 1,
      evidenceNote: '', decision: 'pending', observations: [], updatedAt: 2,
    } as const;
    const observedExperiment = {
      ...configuredExperiment,
      observedCount: 1,
      successfulCount: 1,
      evidenceNote: '',
      observations: [{ day: '2026-08-31', followed: true, evidenceNote: '已按计划等待确认' }],
      updatedAt: 3,
    } as const;
    const decidedExperiment = {
      ...observedExperiment,
      decision: 'adopt',
      evidenceNote: '一次执行符合规则，保留动作。',
      updatedAt: 4,
    } as const;
    const actionSnapshot = (experiment: Readonly<Record<string, unknown>>, version: number) => cloudSnapshot({
      actions: {
        [ACTION_ID]: {
          ...cloudSnapshot().cloudWorkspace.actions[ACTION_ID],
          experiment,
          updatedAt: version,
        },
      },
      actionVersions: { [ACTION_ID]: version },
    });
    const guardSnapshot = cloudSnapshot({
      guards: [
        ...cloudSnapshot().cloudWorkspace.guards,
        { id: NEW_RULE_ID, text: '连续亏损 3 笔后停止', active: true, createdAt: 5, updatedAt: 5 },
      ],
      riskVersions: { [RULE_ID]: 5, [NEW_RULE_ID]: 1 },
    });
    mocks.load
      .mockResolvedValueOnce(cloudSnapshot())
      .mockResolvedValueOnce(actionSnapshot(configuredExperiment, 4))
      .mockResolvedValueOnce(actionSnapshot(observedExperiment, 5))
      .mockResolvedValueOnce(actionSnapshot(decidedExperiment, 6))
      .mockResolvedValueOnce(guardSnapshot);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(NEW_RULE_ID);
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'load' }));
    await waitFor(() => expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_OBSERVED_READY'));
    const writesAfterLoad = setItem.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'experiment' }));
    await waitFor(() => expect(screen.getByLabelText('decision')).toHaveTextContent('pending'));
    expect(mocks.action).toHaveBeenLastCalledWith(CONNECTION_ID, ACTION_ID, expect.objectContaining({
      expectedVersion: 3,
      status: 'OPEN',
      payload: expect.objectContaining({ experiment: expect.objectContaining({ decision: 'pending' }) }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'observation' }));
    await waitFor(() => expect(screen.getByLabelText('observed')).toHaveTextContent('1'));
    expect(mocks.action).toHaveBeenLastCalledWith(CONNECTION_ID, ACTION_ID, expect.objectContaining({
      expectedVersion: 4,
      payload: expect.objectContaining({
        experiment: expect.objectContaining({ observedCount: 1, successfulCount: 1 }),
      }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'decision' }));
    await waitFor(() => expect(screen.getByLabelText('decision')).toHaveTextContent('adopt'));
    expect(mocks.action).toHaveBeenLastCalledWith(CONNECTION_ID, ACTION_ID, expect.objectContaining({
      expectedVersion: 5,
      status: 'DONE',
      payload: expect.objectContaining({ experiment: expect.objectContaining({ decision: 'adopt' }) }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'new guard' }));
    await waitFor(() => expect(screen.getByLabelText('guard-count')).toHaveTextContent('2'));
    expect(mocks.risk).toHaveBeenLastCalledWith(CONNECTION_ID, NEW_RULE_ID, {
      expectedVersion: 0,
      status: 'ACTIVE',
      payload: { text: '连续亏损 3 笔后停止', active: true },
    });
    expect(setItem.mock.calls).toHaveLength(writesAfterLoad);
  });
});
