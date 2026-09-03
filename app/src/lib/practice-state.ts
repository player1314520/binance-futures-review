import type { SnapshotGuard, SnapshotJournalEntry } from './workspace-snapshot';

const PREFIX = 'rv-practice-v1:';
const MAX_JOURNAL = 3_650;
const MAX_GUARDS = 200;
const MAX_NOTE = 4_000;
const MAX_EMOTION = 80;
const MAX_GUARD_TEXT = 600;
const STORAGE_BUDGET = 2_000_000;

export type PracticeState = Readonly<{
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
}>;

function validScope(scope: string | null): scope is string {
  return typeof scope === 'string' && /^[a-z0-9][a-z0-9-]{2,95}$/i.test(scope);
}

export function practiceStorageKey(scope: string | null): string | null {
  return validScope(scope) ? `${PREFIX}${scope}` : null;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function nextJournal(
  current: readonly SnapshotJournalEntry[],
  draft: Pick<SnapshotJournalEntry, 'day' | 'note' | 'emotion'>,
  now = Date.now(),
): readonly SnapshotJournalEntry[] | null {
  const day = draft.day.trim();
  const note = draft.note.trim();
  const emotion = draft.emotion.trim();
  if (
    !validDay(day)
    || !note
    || note.length > MAX_NOTE
    || emotion.length > MAX_EMOTION
    || !validTimestamp(now)
  ) return null;
  const next = current.filter((entry) => entry.day !== day);
  next.push(Object.freeze({ day, note, emotion, updatedAt: now }));
  if (next.length > MAX_JOURNAL) return null;
  return Object.freeze(next.sort((left, right) => right.day.localeCompare(left.day)));
}

export function nextGuard(
  current: readonly SnapshotGuard[],
  guardId: string,
  textInput: string,
  now = Date.now(),
): readonly SnapshotGuard[] | null {
  const text = textInput.trim();
  if (!validId(guardId) || !text || text.length > MAX_GUARD_TEXT || !validTimestamp(now)) return null;
  const existing = current.find((guard) => guard.id === guardId);
  const next = current.filter((guard) => guard.id !== guardId);
  next.push(Object.freeze({
    id: guardId,
    text,
    active: existing?.active ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }));
  if (next.length > MAX_GUARDS) return null;
  return Object.freeze(next.sort((left, right) => left.createdAt - right.createdAt));
}

export function nextGuardActive(
  current: readonly SnapshotGuard[],
  guardId: string,
  active: boolean,
  now = Date.now(),
): readonly SnapshotGuard[] | null {
  if (!validId(guardId) || typeof active !== 'boolean' || !validTimestamp(now)) return null;
  let found = false;
  const next = current.map((guard) => {
    if (guard.id !== guardId) return guard;
    found = true;
    return Object.freeze({ ...guard, active, updatedAt: now });
  });
  return found ? Object.freeze(next) : null;
}

function normalize(value: unknown): PracticeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { journal: [], guards: [] };
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.journal) || !Array.isArray(row.guards)) return { journal: [], guards: [] };
  let journal: readonly SnapshotJournalEntry[] = [];
  for (const candidate of row.journal.slice(0, MAX_JOURNAL)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const next = nextJournal(journal, {
      day: typeof item.day === 'string' ? item.day : '',
      note: typeof item.note === 'string' ? item.note : '',
      emotion: typeof item.emotion === 'string' ? item.emotion : '',
    }, Number(item.updatedAt));
    if (next) journal = next;
  }
  let guards: readonly SnapshotGuard[] = [];
  for (const candidate of row.guards.slice(0, MAX_GUARDS)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const text = typeof item.text === 'string' ? item.text : '';
    const createdAt = Number(item.createdAt);
    const updatedAt = Number(item.updatedAt);
    const inserted = nextGuard(guards, id, text, createdAt);
    if (!inserted || !validTimestamp(updatedAt) || updatedAt < createdAt) continue;
    guards = inserted.map((guard) => guard.id === id
      ? Object.freeze({ ...guard, active: item.active === true, updatedAt })
      : guard);
  }
  return Object.freeze({ journal, guards });
}

function strictRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function normalizePracticeState(value: unknown): PracticeState | null {
  const row = strictRecord(value);
  if (!row || !exactKeys(row, ['journal', 'guards'])) return null;
  if (
    !Array.isArray(row.journal)
    || !Array.isArray(row.guards)
    || row.journal.length > MAX_JOURNAL
    || row.guards.length > MAX_GUARDS
  ) return null;
  let journal: readonly SnapshotJournalEntry[] = [];
  for (const candidate of row.journal) {
    const entry = strictRecord(candidate);
    if (!entry || !exactKeys(entry, ['day', 'note', 'emotion', 'updatedAt'])) return null;
    if (typeof entry.updatedAt !== 'number') return null;
    const next = nextJournal(journal, {
      day: typeof entry.day === 'string' ? entry.day : '',
      note: typeof entry.note === 'string' ? entry.note : '',
      emotion: typeof entry.emotion === 'string' ? entry.emotion : '',
    }, entry.updatedAt);
    if (!next || next.length !== journal.length + 1) return null;
    journal = next;
  }
  let guards: readonly SnapshotGuard[] = [];
  for (const candidate of row.guards) {
    const guard = strictRecord(candidate);
    if (!guard || !exactKeys(guard, ['id', 'text', 'active', 'createdAt', 'updatedAt'])) return null;
    const id = typeof guard.id === 'string' ? guard.id : '';
    const text = typeof guard.text === 'string' ? guard.text : '';
    if (typeof guard.createdAt !== 'number' || typeof guard.updatedAt !== 'number') return null;
    const createdAt = guard.createdAt;
    const updatedAt = guard.updatedAt;
    if (typeof guard.active !== 'boolean' || !validTimestamp(updatedAt) || updatedAt < createdAt) return null;
    const inserted = nextGuard(guards, id, text, createdAt);
    if (!inserted || inserted.length !== guards.length + 1) return null;
    const next = guard.active === true && updatedAt === createdAt
      ? inserted
      : nextGuardActive(inserted, id, guard.active, updatedAt);
    if (!next) return null;
    guards = next;
  }
  return Object.freeze({ journal, guards });
}

export function serializePracticeState(value: unknown): string | null {
  const normalized = normalizePracticeState(value);
  if (!normalized) return null;
  const serialized = JSON.stringify(normalized);
  return serialized.length <= STORAGE_BUDGET ? serialized : null;
}

export function exportPracticeScope(scope: string | null): string | null {
  if (!practiceStorageKey(scope)) return null;
  return serializePracticeState(loadPractice(scope));
}

export function replacePracticeScope(scope: string | null, rawOrState: string | unknown): PracticeState | null {
  const key = practiceStorageKey(scope);
  if (!key) return null;
  let value = rawOrState;
  if (typeof rawOrState === 'string') {
    if (rawOrState.length > STORAGE_BUDGET) return null;
    try {
      value = JSON.parse(rawOrState);
    } catch {
      return null;
    }
  }
  const normalized = normalizePracticeState(value);
  const serialized = normalized ? serializePracticeState(normalized) : null;
  if (!normalized || serialized === null) return null;
  try {
    localStorage.setItem(key, serialized);
    return normalized;
  } catch {
    return null;
  }
}

export function loadPractice(scope: string | null): PracticeState {
  const key = practiceStorageKey(scope);
  if (!key) return { journal: [], guards: [] };
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > STORAGE_BUDGET) return { journal: [], guards: [] };
    return normalize(JSON.parse(raw));
  } catch {
    return { journal: [], guards: [] };
  }
}

export function persistPractice(scope: string | null, state: PracticeState): boolean {
  const key = practiceStorageKey(scope);
  if (!key) return false;
  const normalized = normalize(state);
  const serialized = JSON.stringify(normalized);
  if (serialized.length > STORAGE_BUDGET) return false;
  try {
    localStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearLocalPractice(): number {
  let removed = 0;
  try {
    const keys = Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index));
    for (const key of keys) {
      if (key?.startsWith(PREFIX)) {
        localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {}
  return removed;
}
