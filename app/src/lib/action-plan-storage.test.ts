import { beforeEach, describe, expect, it } from 'vitest';
import {
  actionPlanStorageKey,
  clearLocalActionPlans,
  decideActionExperiment,
  exportActionPlansScope,
  loadActionPlans,
  nextActionExperiment,
  nextActionExperimentDecision,
  nextActionExperimentObservation,
  nextActionPlanStatus,
  nextReviewAction,
  normalizeActionPlanMap,
  recordActionExperimentObservation,
  replaceActionPlans,
  replaceActionPlansScope,
  serializeActionPlanMap,
  setActionExperiment,
  setActionPlanStatus,
  upsertReviewAction,
} from './action-plan-storage';

describe('review action plans', () => {
  beforeEach(() => localStorage.clear());

  it('turns one trade lesson into a stable open action', () => {
    expect(upsertReviewAction('import-v2-abc', 'trade-1', '下一笔进场前先写失效条件', 100))
      .toEqual({
        'trade:trade-1': {
          id: 'trade:trade-1',
          sourceTradeId: 'trade-1',
          text: '下一笔进场前先写失效条件',
          status: 'open',
          createdAt: 100,
          updatedAt: 100,
          completedAt: null,
          experiment: null,
        },
      });
  });

  it('normalizes a legacy stored action to an explicit unconfigured experiment', () => {
    localStorage.setItem('rv-action-v1:scope-one', JSON.stringify({
      'trade:trade-1': {
        id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '只改一件事', status: 'open',
        createdAt: 100, updatedAt: 100, completedAt: null,
      },
    }));

    expect(loadActionPlans('scope-one')['trade:trade-1']).toMatchObject({
      text: '只改一件事',
      experiment: null,
    });
  });

  it('preserves a completed action when the same lesson is saved again', () => {
    upsertReviewAction('import-v2-abc', 'trade-1', '遵守同一条规则', 100);
    setActionPlanStatus('import-v2-abc', 'trade:trade-1', 'done', 200);
    const result = upsertReviewAction('import-v2-abc', 'trade-1', '遵守同一条规则', 300);
    expect(result?.['trade:trade-1']).toMatchObject({
      status: 'done',
      createdAt: 100,
      updatedAt: 300,
      completedAt: 200,
    });
  });

  it('reopens the action if its lesson changes', () => {
    upsertReviewAction('import-v2-abc', 'trade-1', '旧动作', 100);
    setActionPlanStatus('import-v2-abc', 'trade:trade-1', 'done', 200);
    expect(upsertReviewAction('import-v2-abc', 'trade-1', '新动作', 300)?.['trade:trade-1'])
      .toMatchObject({ status: 'open', text: '新动作', completedAt: null });
  });

  it('isolates scopes and clears only action-plan keys', () => {
    upsertReviewAction('scope-one', 'trade-1', '动作一', 100);
    upsertReviewAction('scope-two', 'trade-1', '动作二', 100);
    localStorage.setItem('unrelated', 'keep');
    expect(loadActionPlans('scope-one')['trade:trade-1'].text).toBe('动作一');
    expect(loadActionPlans('scope-two')['trade:trade-1'].text).toBe('动作二');
    expect(clearLocalActionPlans()).toBe(2);
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('rejects unsafe identifiers and oversized text', () => {
    expect(upsertReviewAction('scope-one', '../trade', '动作')).toBeNull();
    expect(upsertReviewAction('scope-one', 'trade-1', 'x'.repeat(601))).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('round-trips the longest source trade id whose generated action id remains valid', () => {
    const source154 = 'a'.repeat(154);
    const actionId154 = `trade:${source154}`;

    const stored = upsertReviewAction('scope-one', source154, '边界动作', 100);

    expect(stored).not.toBeNull();
    expect(Object.getPrototypeOf(stored)).toBeNull();
    expect(Object.hasOwn(stored ?? {}, actionId154)).toBe(true);
    expect(loadActionPlans('scope-one')[actionId154]).toMatchObject({
      id: actionId154,
      sourceTradeId: source154,
      text: '边界动作',
    });
  });

  it.each([155, 160])(
    'rejects a %i-character source trade id before writing an oversized generated action id',
    (length) => {
      const sourceTradeId = 'a'.repeat(length);

      expect(upsertReviewAction('scope-one', sourceTradeId, '不应写入', 100)).toBeNull();
      expect(localStorage.length).toBe(0);
    },
  );

  it('uses inheritance-free maps and never treats prototype names as existing actions', () => {
    const empty = loadActionPlans('scope-one');
    expect(Object.getPrototypeOf(empty)).toBeNull();
    expect(Object.hasOwn(empty, 'toString')).toBe(false);
    expect(Object.hasOwn(empty, 'valueOf')).toBe(false);

    for (const actionId of ['__proto__', 'toString', 'valueOf']) {
      expect(nextActionPlanStatus(empty, actionId, 'done', 200)).toBeNull();
      expect(nextActionExperiment(empty, actionId, {
        hypothesis: '不得命中继承属性', targetCount: 1,
        windowStart: '2026-08-29', windowEnd: '2026-08-29', successCriterion: 1,
      }, 200)).toBeNull();
    }

    expect(Object.getPrototypeOf(empty)).toBeNull();
    expect(Object.hasOwn(empty, '__proto__')).toBe(false);
  });

  it('rejects an own __proto__ map entry without changing any object prototype', () => {
    const malicious = JSON.parse(`{
      "__proto__": {
        "id": "__proto__", "sourceTradeId": "trade-1", "text": "污染", "status": "open",
        "createdAt": 100, "updatedAt": 100, "completedAt": null
      }
    }`);

    expect(Object.hasOwn(malicious, '__proto__')).toBe(true);
    expect(normalizeActionPlanMap(malicious)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('updates an in-memory vault action without reading or writing browser storage', () => {
    const current = nextReviewAction({}, 'trade-1', '先写失效条件', 100);
    expect(current).not.toBeNull();
    localStorage.setItem('sentinel', 'keep');

    const next = nextActionPlanStatus(current ?? {}, 'trade:trade-1', 'done', 200);

    expect(next?.['trade:trade-1']).toMatchObject({
      status: 'done',
      completedAt: 200,
      updatedAt: 200,
    });
    expect(current?.['trade:trade-1']).toMatchObject({ status: 'open', completedAt: null });
    expect(localStorage).toHaveLength(1);
    expect(localStorage.getItem('sentinel')).toBe('keep');
  });

  it('creates a bounded single-variable experiment without mutating the source action map', () => {
    const current = nextReviewAction({}, 'trade-1', '进场前写失效条件', 100) ?? {};
    const next = nextActionExperiment(current, 'trade:trade-1', {
      hypothesis: '若先写失效条件，我能在有机会时按计划执行',
      targetCount: 3,
      windowStart: '2026-08-29',
      windowEnd: '2026-09-12',
      successCriterion: 3,
    }, 200);

    expect(current['trade:trade-1'].experiment).toBeNull();
    expect(next?.['trade:trade-1']).toMatchObject({
      status: 'open',
      completedAt: null,
      experiment: {
        hypothesis: '若先写失效条件，我能在有机会时按计划执行',
        targetCount: 3,
        observedCount: 0,
        successfulCount: 0,
        windowStart: '2026-08-29',
        windowEnd: '2026-09-12',
        successCriterion: 3,
        evidenceNote: '',
        decision: 'pending',
        observations: [],
        updatedAt: 200,
      },
    });
  });

  it('records evidence-bearing observations and closes only after the target is reached', () => {
    const action = nextReviewAction({}, 'trade-1', '只在信号确认后进场', 100) ?? {};
    const configured = nextActionExperiment(action, 'trade:trade-1', {
      hypothesis: '等待确认能减少计划外进场', targetCount: 2,
      windowStart: '2026-08-29', windowEnd: '2026-09-05', successCriterion: 2,
    }, 200) ?? {};
    const first = nextActionExperimentObservation(configured, 'trade:trade-1', {
      day: '2026-08-30', followed: true, evidenceNote: '复盘 trade-2：进场前已写确认条件',
    }, 300) ?? {};
    expect(first['trade:trade-1'].experiment).toMatchObject({ observedCount: 1, successfulCount: 1 });
    expect(nextActionExperimentDecision(first, 'trade:trade-1', 'adopt', '样本尚未完成', 350)).toBeNull();

    const second = nextActionExperimentObservation(first, 'trade:trade-1', {
      day: '2026-09-01', followed: false, evidenceNote: '复盘 trade-3：条件未确认仍进场',
    }, 400) ?? {};
    expect(second['trade:trade-1'].experiment).toMatchObject({ observedCount: 2, successfulCount: 1 });
    const decided = nextActionExperimentDecision(
      second, 'trade:trade-1', 'revise', '仅 1/2 次执行，缩小触发条件后再测。', 500,
    );
    expect(decided?.['trade:trade-1']).toMatchObject({
      status: 'open', completedAt: null,
      experiment: { decision: 'revise', evidenceNote: '仅 1/2 次执行，缩小触发条件后再测。' },
    });
    expect(nextActionExperimentObservation(decided ?? {}, 'trade:trade-1', {
      day: '2026-09-02', followed: true, evidenceNote: '不应写入',
    }, 600)).toBeNull();
  });

  it('maps adopt, revise, and discard decisions to an explicit lifecycle', () => {
    const action = nextReviewAction({}, 'trade-1', '执行前复核', 100) ?? {};
    const configured = nextActionExperiment(action, 'trade:trade-1', {
      hypothesis: '复核能提高执行率', targetCount: 1,
      windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
    }, 200) ?? {};
    const ready = nextActionExperimentObservation(configured, 'trade:trade-1', {
      day: '2026-08-29', followed: true, evidenceNote: 'trade-2 已记录',
    }, 300) ?? {};

    expect(nextActionExperimentDecision(ready, 'trade:trade-1', 'adopt', '保留', 400)?.['trade:trade-1'])
      .toMatchObject({ status: 'done', completedAt: 400, experiment: { decision: 'adopt' } });
    expect(nextActionExperimentDecision(ready, 'trade:trade-1', 'revise', '修改后重测', 400)?.['trade:trade-1'])
      .toMatchObject({ status: 'open', completedAt: null, experiment: { decision: 'revise' } });
    expect(nextActionExperimentDecision(ready, 'trade:trade-1', 'discard', '放弃', 400)?.['trade:trade-1'])
      .toMatchObject({ status: 'dismissed', completedAt: 400, experiment: { decision: 'discard' } });
  });

  it('strictly rejects malformed dates, unsafe counts, missing evidence, and premature decisions', () => {
    const action = nextReviewAction({}, 'trade-1', '单变量动作', 100) ?? {};
    const base = {
      hypothesis: '检验动作是否被执行', targetCount: 3,
      windowStart: '2026-08-29', windowEnd: '2026-09-05', successCriterion: 2,
    };
    expect(nextActionExperiment(action, 'trade:trade-1', { ...base, windowStart: '2026-02-30' }, 200)).toBeNull();
    expect(nextActionExperiment(action, 'trade:trade-1', { ...base, windowEnd: '2026-08-28' }, 200)).toBeNull();
    expect(nextActionExperiment(action, 'trade:trade-1', { ...base, targetCount: 0 }, 200)).toBeNull();
    expect(nextActionExperiment(action, 'trade:trade-1', { ...base, targetCount: 51 }, 200)).toBeNull();
    expect(nextActionExperiment(action, 'trade:trade-1', { ...base, successCriterion: 4 }, 200)).toBeNull();
    expect(nextActionExperiment(action, 'trade:trade-1', base, 99)).toBeNull();

    const configured = nextActionExperiment(action, 'trade:trade-1', base, 200) ?? {};
    expect(nextActionExperimentObservation(configured, 'trade:trade-1', {
      day: '2026-08-28', followed: true, evidenceNote: '窗口外',
    }, 300)).toBeNull();
    expect(nextActionExperimentObservation(configured, 'trade:trade-1', {
      day: '2026-08-30', followed: true, evidenceNote: '   ',
    }, 300)).toBeNull();
    expect(nextActionExperimentObservation(configured, 'trade:trade-1', {
      day: '2026-08-30', followed: true, evidenceNote: '时间倒退',
    }, 199)).toBeNull();
    expect(nextActionExperimentDecision(configured, 'trade:trade-1', 'adopt', '证据不足', 400)).toBeNull();
  });

  it('persists experiment configuration, observations, and decision in browser storage', () => {
    upsertReviewAction('scope-one', 'trade-1', '执行前复核一次', 100);
    expect(setActionExperiment('scope-one', 'trade:trade-1', {
      hypothesis: '复核能提高动作执行率', targetCount: 1,
      windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
    }, 200)).not.toBeNull();
    expect(recordActionExperimentObservation('scope-one', 'trade:trade-1', {
      day: '2026-08-29', followed: true, evidenceNote: '复盘 trade-2 已记录复核步骤',
    }, 300)).not.toBeNull();
    expect(decideActionExperiment(
      'scope-one', 'trade:trade-1', 'adopt', '1/1 次按计划执行，保留规则。', 400,
    )?.['trade:trade-1']).toMatchObject({
      status: 'done',
      experiment: { observedCount: 1, successfulCount: 1, decision: 'adopt' },
    });
    expect(loadActionPlans('scope-one')['trade:trade-1'].experiment?.observations).toHaveLength(1);
  });

  it('drops a malformed new experiment instead of treating it as verified evidence', () => {
    localStorage.setItem('rv-action-v1:scope-one', JSON.stringify({
      'trade:trade-1': {
        id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '动作', status: 'done',
        createdAt: 100, updatedAt: 200, completedAt: 200,
        experiment: {
          hypothesis: '假设', targetCount: 1, observedCount: 1, successfulCount: 1,
          windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
          evidenceNote: '结论', decision: 'adopt', observations: [], updatedAt: 200,
        },
      },
    }));
    expect(loadActionPlans('scope-one')).toEqual({});
  });

  it('rejects a claimed experiment decision that is inconsistent with the action lifecycle', () => {
    const malformed = {
      id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '动作', status: 'open',
      createdAt: 100, updatedAt: 200, completedAt: null,
      experiment: {
        hypothesis: '假设', targetCount: 1, observedCount: 1, successfulCount: 1,
        windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
        evidenceNote: '声称保留', decision: 'adopt',
        observations: [{ day: '2026-08-29', followed: true, evidenceNote: '证据' }],
        updatedAt: 200,
      },
    };
    expect(normalizeActionPlanMap({ 'trade:trade-1': malformed })).toBeNull();
  });

  it('strictly validates and exactly restores a complete experiment action map', () => {
    const original = {
      'trade:trade-1': {
        id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '执行前复核', status: 'done' as const,
        createdAt: 100, updatedAt: 500, completedAt: 500,
        experiment: {
          hypothesis: '复核能提高动作执行率', targetCount: 1, observedCount: 1, successfulCount: 1,
          windowStart: '2026-08-29', windowEnd: '2026-08-30', successCriterion: 1,
          evidenceNote: '1/1 次执行，保留。', decision: 'adopt' as const,
          observations: [{ day: '2026-08-29', followed: true, evidenceNote: 'trade-2 有复盘证据' }],
          updatedAt: 500,
        },
      },
    };
    const decoded = JSON.parse(JSON.stringify(original));
    expect(normalizeActionPlanMap(decoded)).toEqual(original);
    expect(JSON.parse(serializeActionPlanMap(decoded) ?? 'null')).toEqual(original);
    expect(replaceActionPlans('scope-one', decoded)).toEqual(original);
    expect(loadActionPlans('scope-one')).toEqual(original);
    const exported = exportActionPlansScope('scope-one');
    expect(JSON.parse(exported ?? 'null')).toEqual(original);
    localStorage.removeItem('rv-action-v1:scope-one');
    expect(replaceActionPlansScope('scope-one', exported ?? '')).toEqual(original);
    expect(loadActionPlans('scope-one')).toEqual(original);
    expect(normalizeActionPlanMap({ ...decoded, extra: decoded['trade:trade-1'] })).toBeNull();
    expect(normalizeActionPlanMap({
      'trade:trade-1': { ...decoded['trade:trade-1'], privateEmail: 'must-not-pass' },
    })).toBeNull();
  });

  it('exports old raw actions as a restorable safe-normalized scope', () => {
    expect(actionPlanStorageKey('scope-one')).toBe('rv-action-v1:scope-one');
    expect(actionPlanStorageKey('../unsafe')).toBeNull();
    localStorage.setItem('rv-action-v1:scope-one', JSON.stringify({
      'trade:trade-1': {
        id: 'trade:trade-1', sourceTradeId: 'trade-1', text: '旧动作', status: 'open',
        createdAt: 100, updatedAt: 100, completedAt: null,
      },
    }));
    const raw = exportActionPlansScope('scope-one');
    expect(JSON.parse(raw ?? 'null')['trade:trade-1'].experiment).toBeNull();
    expect(replaceActionPlansScope('scope-two', raw ?? '')?.['trade:trade-1']).toMatchObject({
      text: '旧动作', experiment: null, createdAt: 100, updatedAt: 100,
    });
    expect(replaceActionPlansScope('scope-two', '{"bad":true}')).toBeNull();
  });
});
