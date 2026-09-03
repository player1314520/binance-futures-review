import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLocalPractice,
  exportPracticeScope,
  loadPractice,
  nextGuard,
  nextGuardActive,
  nextJournal,
  normalizePracticeState,
  persistPractice,
  practiceStorageKey,
  replacePracticeScope,
} from './practice-state';

describe('journal and risk-guard state', () => {
  beforeEach(() => localStorage.clear());

  it('upserts one journal entry per day without mutating the input', () => {
    const first = nextJournal([], {
      day: '2026-08-28',
      note: '等到计划区才进场',
      emotion: '冷静',
    }, 100);
    const next = nextJournal(first ?? [], {
      day: '2026-08-28',
      note: '等待确认后才进场',
      emotion: '专注',
    }, 200);

    expect(first?.[0].note).toBe('等到计划区才进场');
    expect(next).toEqual([{
      day: '2026-08-28',
      note: '等待确认后才进场',
      emotion: '专注',
      updatedAt: 200,
    }]);
  });

  it('creates and toggles a concrete pre-trade guard', () => {
    const guards = nextGuard([], 'guard-1', '连续亏损 3 笔后停止当天交易', 100);
    const disabled = nextGuardActive(guards ?? [], 'guard-1', false, 200);

    expect(disabled).toEqual([{
      id: 'guard-1',
      text: '连续亏损 3 笔后停止当天交易',
      active: false,
      createdAt: 100,
      updatedAt: 200,
    }]);
    expect(guards?.[0].active).toBe(true);
  });

  it('persists only scoped validated practice state and clears its own keys', () => {
    const state = {
      journal: nextJournal([], { day: '2026-08-28', note: '记录', emotion: '平静' }, 100) ?? [],
      guards: nextGuard([], 'guard-1', '不追涨', 100) ?? [],
    };
    expect(persistPractice('scope-one', state)).toBe(true);
    localStorage.setItem('unrelated', 'keep');
    expect(loadPractice('scope-one')).toEqual(state);
    expect(clearLocalPractice()).toBe(1);
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('rejects invalid dates, unsafe ids, and oversized text', () => {
    expect(nextJournal([], { day: '2026-02-31', note: 'x', emotion: '' }, 1)).toBeNull();
    expect(nextGuard([], '../guard', 'x', 1)).toBeNull();
    expect(nextGuard([], 'guard-1', 'x'.repeat(601), 1)).toBeNull();
  });

  it('strictly replaces a whole scope with exact journal and guard timestamps', () => {
    const state = {
      journal: [{ day: '2026-08-28', note: '记录', emotion: '冷静', updatedAt: 123 }],
      guards: [{ id: 'guard-1', text: '不追涨', active: false, createdAt: 100, updatedAt: 200 }],
    };
    expect(replacePracticeScope('scope-one', state)).toEqual(state);
    expect(exportPracticeScope('scope-one')).toBe(JSON.stringify(state));
    expect(loadPractice('scope-one')).toEqual(state);
  });

  it('rejects malformed whole-scope state without changing the previous raw value', () => {
    const state = {
      journal: [{ day: '2026-08-28', note: '记录', emotion: '冷静', updatedAt: 123 }],
      guards: [],
    };
    expect(replacePracticeScope('scope-one', state)).not.toBeNull();
    const key = practiceStorageKey('scope-one')!;
    const before = localStorage.getItem(key);
    expect(replacePracticeScope('scope-one', {
      ...state,
      journal: [{ ...state.journal[0], day: '2026-02-31' }],
    })).toBeNull();
    expect(localStorage.getItem(key)).toBe(before);
  });

  it.each([
    ['journal string updatedAt', {
      journal: [{ day: '2026-08-28', note: '记录', emotion: '冷静', updatedAt: '123' }],
      guards: [],
    }],
    ['journal boolean updatedAt', {
      journal: [{ day: '2026-08-28', note: '记录', emotion: '冷静', updatedAt: true }],
      guards: [],
    }],
    ['guard string createdAt', {
      journal: [],
      guards: [{ id: 'guard-1', text: '不追涨', active: true, createdAt: '100', updatedAt: 200 }],
    }],
    ['guard boolean updatedAt', {
      journal: [],
      guards: [{ id: 'guard-1', text: '不追涨', active: true, createdAt: 100, updatedAt: true }],
    }],
  ])('strictly rejects %s without replacing prior storage', (_label, candidate) => {
    const baseline = {
      journal: [{ day: '2026-08-27', note: '基线', emotion: '', updatedAt: 99 }],
      guards: [],
    };
    expect(replacePracticeScope('scope-one', baseline)).toEqual(baseline);
    const key = practiceStorageKey('scope-one')!;
    const before = localStorage.getItem(key);

    expect(normalizePracticeState(candidate)).toBeNull();
    expect(replacePracticeScope('scope-one', candidate)).toBeNull();
    expect(localStorage.getItem(key)).toBe(before);
  });

  it('keeps legacy timestamp coercion confined to the compatibility loader', () => {
    const key = practiceStorageKey('scope-one')!;
    localStorage.setItem(key, JSON.stringify({
      journal: [{ day: '2026-08-28', note: '旧记录', emotion: '', updatedAt: '123' }],
      guards: [],
    }));

    expect(loadPractice('scope-one').journal[0]?.updatedAt).toBe(123);
    expect(normalizePracticeState(JSON.parse(localStorage.getItem(key)!))).toBeNull();
  });
});
