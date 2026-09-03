export type ActionPlanStatus = 'open' | 'done' | 'dismissed';

export type ActionExperimentDecision = 'pending' | 'adopt' | 'revise' | 'discard';

export type ActionExperimentObservation = Readonly<{
  day: string;
  followed: boolean;
  evidenceNote: string;
}>;

export type ActionExperiment = Readonly<{
  hypothesis: string;
  targetCount: number;
  observedCount: number;
  successfulCount: number;
  windowStart: string;
  windowEnd: string;
  successCriterion: number;
  evidenceNote: string;
  decision: ActionExperimentDecision;
  observations: readonly ActionExperimentObservation[];
  updatedAt: number;
}>;

export type ActionExperimentInput = Readonly<{
  hypothesis: string;
  targetCount: number;
  windowStart: string;
  windowEnd: string;
  successCriterion: number;
}>;

export type ActionExperimentObservationInput = Readonly<{
  day: string;
  followed: boolean;
  evidenceNote: string;
}>;

export type ActionPlan = Readonly<{
  id: string;
  sourceTradeId: string;
  text: string;
  status: ActionPlanStatus;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  experiment?: ActionExperiment | null;
}>;

export type ActionPlanMap = Record<string, ActionPlan>;

const PREFIX = 'rv-action-v1:';
const MAX_ACTIONS = 2_000;
export const MAX_ACTION_TEXT_LENGTH = 600;
export const MAX_EXPERIMENT_HYPOTHESIS_LENGTH = 300;
export const MAX_EXPERIMENT_TARGET_COUNT = 50;
export const MAX_EXPERIMENT_OBSERVATION_NOTE_LENGTH = 600;
export const MAX_EXPERIMENT_DECISION_NOTE_LENGTH = 2_000;
export const MAX_EXPERIMENT_WINDOW_DAYS = 366;
const STORAGE_BUDGET = 2_000_000;
const DAY_MS = 86_400_000;

function safeScope(scope: string | null): string | null {
  return typeof scope === 'string' && /^[a-z0-9][a-z0-9-]{2,95}$/i.test(scope)
    ? scope
    : null;
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function emptyActionPlanMap(): ActionPlanMap {
  return Object.create(null) as ActionPlanMap;
}

function defineAction(
  actions: ActionPlanMap,
  id: string,
  action: ActionPlan,
): void {
  Object.defineProperty(actions, id, {
    value: action,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function actionPlanStorageKey(scope: string | null): string | null {
  const normalized = safeScope(scope);
  return normalized ? `${PREFIX}${normalized}` : null;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validWindow(start: string, end: string): boolean {
  if (!validDay(start) || !validDay(end) || end < start) return false;
  const days = ((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS) + 1;
  return Number.isSafeInteger(days) && days >= 1 && days <= MAX_EXPERIMENT_WINDOW_DAYS;
}

function normalizedText(value: unknown, maximum: number, required: boolean): string | null {
  if (typeof value !== 'string' || value.length > maximum || /\u0000/.test(value)) return null;
  const text = value.trim();
  if (required && !text) return null;
  return text;
}

function normalizeExperiment(
  value: unknown,
  actionCreatedAt: number,
  actionUpdatedAt: number,
): ActionExperiment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, [
    'hypothesis', 'targetCount', 'observedCount', 'successfulCount',
    'windowStart', 'windowEnd', 'successCriterion', 'evidenceNote',
    'decision', 'observations', 'updatedAt',
  ])) return null;
  const hypothesis = normalizedText(row.hypothesis, MAX_EXPERIMENT_HYPOTHESIS_LENGTH, true);
  const evidenceNote = normalizedText(row.evidenceNote, MAX_EXPERIMENT_DECISION_NOTE_LENGTH, false);
  const targetCount = row.targetCount;
  const observedCount = row.observedCount;
  const successfulCount = row.successfulCount;
  const successCriterion = row.successCriterion;
  const updatedAt = safeTimestamp(row.updatedAt);
  const decision = String(row.decision) as ActionExperimentDecision;
  if (
    hypothesis === null
    || evidenceNote === null
    || typeof targetCount !== 'number'
    || !Number.isSafeInteger(targetCount)
    || targetCount < 1
    || targetCount > MAX_EXPERIMENT_TARGET_COUNT
    || typeof observedCount !== 'number'
    || !Number.isSafeInteger(observedCount)
    || observedCount < 0
    || observedCount > targetCount
    || typeof successfulCount !== 'number'
    || !Number.isSafeInteger(successfulCount)
    || successfulCount < 0
    || successfulCount > observedCount
    || typeof successCriterion !== 'number'
    || !Number.isSafeInteger(successCriterion)
    || successCriterion < 1
    || successCriterion > targetCount
    || typeof row.windowStart !== 'string'
    || typeof row.windowEnd !== 'string'
    || !validWindow(String(row.windowStart), String(row.windowEnd))
    || typeof row.decision !== 'string'
    || !['pending', 'adopt', 'revise', 'discard'].includes(decision)
    || !Array.isArray(row.observations)
    || row.observations.length !== observedCount
    || updatedAt === null
    || updatedAt < actionCreatedAt
    || updatedAt > actionUpdatedAt
    || (decision === 'pending' ? evidenceNote.length > 0 : observedCount !== targetCount || !evidenceNote)
  ) return null;

  let countedSuccessful = 0;
  const observations: ActionExperimentObservation[] = [];
  for (const candidate of row.observations) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const observationPrototype = Object.getPrototypeOf(candidate);
    if (observationPrototype !== Object.prototype && observationPrototype !== null) return null;
    const observation = candidate as Record<string, unknown>;
    if (!exactKeys(observation, ['day', 'followed', 'evidenceNote'])) return null;
    const note = normalizedText(
      observation.evidenceNote,
      MAX_EXPERIMENT_OBSERVATION_NOTE_LENGTH,
      true,
    );
    if (
      !validDay(observation.day)
      || observation.day < row.windowStart!
      || observation.day > row.windowEnd!
      || typeof observation.followed !== 'boolean'
      || note === null
    ) return null;
    if (observation.followed) countedSuccessful += 1;
    observations.push(Object.freeze({
      day: observation.day,
      followed: observation.followed,
      evidenceNote: note,
    }));
  }
  if (countedSuccessful !== successfulCount) return null;
  return Object.freeze({
    hypothesis,
    targetCount,
    observedCount,
    successfulCount,
    windowStart: row.windowStart as string,
    windowEnd: row.windowEnd as string,
    successCriterion,
    evidenceNote,
    decision,
    observations: Object.freeze(observations),
    updatedAt,
  });
}

export function normalizeActionPlan(value: unknown): ActionPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  const sourceTradeId = typeof row.sourceTradeId === 'string' ? row.sourceTradeId : '';
  const rawText = typeof row.text === 'string' ? row.text : '';
  const text = rawText.trim();
  const status = ['open', 'done', 'dismissed'].includes(String(row.status))
    ? String(row.status) as ActionPlanStatus
    : 'open';
  const createdAt = safeTimestamp(row.createdAt);
  const updatedAt = safeTimestamp(row.updatedAt);
  const completedAt = row.completedAt == null ? null : safeTimestamp(row.completedAt);
  if (
    !safeId(id)
    || !safeId(sourceTradeId)
    || !text
    || rawText.length > MAX_ACTION_TEXT_LENGTH
    || /\u0000/.test(rawText)
    || !['open', 'done', 'dismissed'].includes(String(row.status))
    || createdAt === null
    || updatedAt === null
    || updatedAt < createdAt
    || (row.completedAt != null && completedAt === null)
    || (completedAt !== null && completedAt < createdAt)
  ) return null;
  const experiment = row.experiment === undefined || row.experiment === null
    ? null
    : normalizeExperiment(row.experiment, createdAt, updatedAt);
  if (row.experiment !== undefined && row.experiment !== null && experiment === null) return null;
  if (experiment && (
    (experiment.decision === 'pending' && (status !== 'open' || completedAt !== null))
    || (experiment.decision === 'adopt' && (status !== 'done' || completedAt !== updatedAt))
    || (experiment.decision === 'revise' && (status !== 'open' || completedAt !== null))
    || (experiment.decision === 'discard' && (status !== 'dismissed' || completedAt !== updatedAt))
  )) return null;
  return Object.freeze({
    id, sourceTradeId, text, status, createdAt, updatedAt, completedAt, experiment,
  });
}

export function normalizeActionPlanMap(value: unknown): ActionPlanMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ACTIONS) return null;
  const legacyKeys = ['id', 'sourceTradeId', 'text', 'status', 'createdAt', 'updatedAt', 'completedAt'];
  const currentKeys = [...legacyKeys, 'experiment'];
  const result = emptyActionPlanMap();
  for (const [id, candidate] of entries) {
    if (!safeId(id) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    if (!exactKeys(row, legacyKeys) && !exactKeys(row, currentKeys)) return null;
    const action = normalizeActionPlan(row);
    if (!action || action.id !== id) return null;
    defineAction(result, id, action);
  }
  return Object.freeze(result);
}

function mutableNormalizedActionPlanMap(value: unknown): ActionPlanMap | null {
  const normalized = normalizeActionPlanMap(value);
  if (!normalized) return null;
  const result = emptyActionPlanMap();
  for (const [id, action] of Object.entries(normalized)) {
    if (!safeId(id) || !Object.hasOwn(normalized, id)) return null;
    defineAction(result, id, action);
  }
  return result;
}

export function serializeActionPlanMap(value: unknown): string | null {
  const actions = normalizeActionPlanMap(value);
  if (!actions) return null;
  const serialized = JSON.stringify(actions);
  return serialized.length <= STORAGE_BUDGET ? serialized : null;
}

export function loadActionPlans(scope: string | null): ActionPlanMap {
  const key = actionPlanStorageKey(scope);
  if (!key) return emptyActionPlanMap();
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > STORAGE_BUDGET) return emptyActionPlanMap();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyActionPlanMap();
    const result = emptyActionPlanMap();
    for (const [id, candidate] of Object.entries(parsed).slice(0, MAX_ACTIONS)) {
      if (!safeId(id) || !Object.hasOwn(parsed, id)) continue;
      const action = normalizeActionPlan(candidate);
      if (action && action.id === id) defineAction(result, id, action);
    }
    return result;
  } catch {
    return emptyActionPlanMap();
  }
}

function persist(scope: string | null, actions: ActionPlanMap): boolean {
  const key = actionPlanStorageKey(scope);
  if (!key) return false;
  const serialized = JSON.stringify(actions);
  if (serialized.length > STORAGE_BUDGET) return false;
  try {
    localStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

export function replaceActionPlans(scope: string | null, value: unknown): ActionPlanMap | null {
  const actions = normalizeActionPlanMap(value);
  return actions && persist(scope, actions) ? actions : null;
}

export function exportActionPlansScope(scope: string | null): string | null {
  const key = actionPlanStorageKey(scope);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return serializeActionPlanMap({});
    if (raw.length > STORAGE_BUDGET) return null;
    return serializeActionPlanMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function replaceActionPlansScope(
  scope: string | null,
  rawOrMap: string | unknown,
): ActionPlanMap | null {
  try {
    if (typeof rawOrMap === 'string') {
      if (rawOrMap.length > STORAGE_BUDGET) return null;
      return replaceActionPlans(scope, JSON.parse(rawOrMap));
    }
    return replaceActionPlans(scope, rawOrMap);
  } catch {
    return null;
  }
}

export function upsertReviewAction(
  scope: string | null,
  tradeId: string,
  lesson: string,
  now = Date.now(),
): ActionPlanMap | null {
  const actions = nextReviewAction(loadActionPlans(scope), tradeId, lesson, now);
  return actions && persist(scope, actions) ? actions : null;
}

export function nextReviewAction(
  currentActions: ActionPlanMap,
  tradeId: string,
  lesson: string,
  now = Date.now(),
): ActionPlanMap | null {
  const text = lesson.trim();
  if (!safeId(tradeId) || !text || text.length > MAX_ACTION_TEXT_LENGTH) return null;
  const id = `trade:${tradeId}`;
  if (!safeId(id)) return null;
  const actions = mutableNormalizedActionPlanMap(currentActions);
  const timestamp = safeTimestamp(now);
  if (!actions || timestamp === null) return null;
  const current = Object.hasOwn(actions, id) ? actions[id] : undefined;
  if (current && timestamp < current.updatedAt) return null;
  defineAction(actions, id, Object.freeze({
    id,
    sourceTradeId: tradeId,
    text,
    status: current?.text === text ? current.status : 'open',
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    completedAt: current?.text === text ? current.completedAt : null,
    experiment: current?.text === text ? current.experiment ?? null : null,
  }));
  return actions;
}

export function setActionPlanStatus(
  scope: string | null,
  actionId: string,
  status: ActionPlanStatus,
  now = Date.now(),
): ActionPlanMap | null {
  const actions = loadActionPlans(scope);
  const next = nextActionPlanStatus(actions, actionId, status, now);
  return next && persist(scope, next) ? next : null;
}

export function nextActionPlanStatus(
  currentActions: ActionPlanMap,
  actionId: string,
  status: ActionPlanStatus,
  now = Date.now(),
): ActionPlanMap | null {
  if (!safeId(actionId)) return null;
  const actions = mutableNormalizedActionPlanMap(currentActions);
  if (!actions || !Object.hasOwn(actions, actionId)) return null;
  const current = actions[actionId];
  const timestamp = safeTimestamp(now);
  if (
    !['open', 'done', 'dismissed'].includes(status)
    || timestamp === null
    || timestamp < current.updatedAt
  ) return null;
  if (current.experiment?.decision === 'pending' && status !== 'open') return null;
  let experiment = current.experiment ?? null;
  if (experiment && experiment.decision !== 'pending') {
    const expected = experiment.decision === 'adopt'
      ? 'done'
      : experiment.decision === 'revise' ? 'open' : 'dismissed';
    if (status !== expected) {
      if (status === 'open') experiment = null;
      else return null;
    }
  }
  defineAction(actions, actionId, Object.freeze({
    ...current,
    status,
    updatedAt: timestamp,
    completedAt: status === 'done' || (status === 'dismissed' && experiment) ? timestamp : null,
    experiment,
  }));
  return actions;
}

function mutateStoredActions(
  scope: string | null,
  change: (actions: ActionPlanMap) => ActionPlanMap | null,
): ActionPlanMap | null {
  const actions = change(loadActionPlans(scope));
  return actions && persist(scope, actions) ? actions : null;
}

export function nextActionExperiment(
  currentActions: ActionPlanMap,
  actionId: string,
  input: ActionExperimentInput,
  now = Date.now(),
): ActionPlanMap | null {
  if (!safeId(actionId)) return null;
  const actions = mutableNormalizedActionPlanMap(currentActions);
  if (!actions || !Object.hasOwn(actions, actionId)) return null;
  const current = actions[actionId];
  const timestamp = safeTimestamp(now);
  if (
    timestamp === null
    || timestamp < current.updatedAt
    || !input
    || typeof input !== 'object'
  ) return null;
  const candidate = normalizeExperiment({
    hypothesis: input.hypothesis,
    targetCount: input.targetCount,
    observedCount: 0,
    successfulCount: 0,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    successCriterion: input.successCriterion,
    evidenceNote: '',
    decision: 'pending',
    observations: [],
    updatedAt: timestamp,
  }, current.createdAt, timestamp);
  if (!candidate) return null;
  defineAction(actions, actionId, Object.freeze({
    ...current,
    status: 'open',
    completedAt: null,
    updatedAt: timestamp,
    experiment: candidate,
  }));
  return actions;
}

export function setActionExperiment(
  scope: string | null,
  actionId: string,
  input: ActionExperimentInput,
  now = Date.now(),
): ActionPlanMap | null {
  return mutateStoredActions(scope, (actions) => nextActionExperiment(actions, actionId, input, now));
}

export function nextActionExperimentObservation(
  currentActions: ActionPlanMap,
  actionId: string,
  input: ActionExperimentObservationInput,
  now = Date.now(),
): ActionPlanMap | null {
  if (!safeId(actionId)) return null;
  const actions = mutableNormalizedActionPlanMap(currentActions);
  if (!actions || !Object.hasOwn(actions, actionId)) return null;
  const current = actions[actionId];
  const experiment = current?.experiment;
  const timestamp = safeTimestamp(now);
  const note = normalizedText(input?.evidenceNote, MAX_EXPERIMENT_OBSERVATION_NOTE_LENGTH, true);
  if (
    !experiment
    || experiment.decision !== 'pending'
    || experiment.observedCount >= experiment.targetCount
    || timestamp === null
    || timestamp < current.updatedAt
    || !validDay(input?.day)
    || input.day < experiment.windowStart
    || input.day > experiment.windowEnd
    || typeof input.followed !== 'boolean'
    || note === null
  ) return null;
  const observations = Object.freeze([
    ...experiment.observations,
    Object.freeze({ day: input.day, followed: input.followed, evidenceNote: note }),
  ]);
  const nextExperiment: ActionExperiment = Object.freeze({
    ...experiment,
    observedCount: observations.length,
    successfulCount: experiment.successfulCount + (input.followed ? 1 : 0),
    observations,
    updatedAt: timestamp,
  });
  defineAction(
    actions,
    actionId,
    Object.freeze({ ...current, updatedAt: timestamp, experiment: nextExperiment }),
  );
  return actions;
}

export function recordActionExperimentObservation(
  scope: string | null,
  actionId: string,
  input: ActionExperimentObservationInput,
  now = Date.now(),
): ActionPlanMap | null {
  return mutateStoredActions(
    scope,
    (actions) => nextActionExperimentObservation(actions, actionId, input, now),
  );
}

export function nextActionExperimentDecision(
  currentActions: ActionPlanMap,
  actionId: string,
  decision: Exclude<ActionExperimentDecision, 'pending'>,
  evidenceNote: string,
  now = Date.now(),
): ActionPlanMap | null {
  if (!safeId(actionId)) return null;
  const actions = mutableNormalizedActionPlanMap(currentActions);
  if (!actions || !Object.hasOwn(actions, actionId)) return null;
  const current = actions[actionId];
  const experiment = current?.experiment;
  const timestamp = safeTimestamp(now);
  const note = normalizedText(evidenceNote, MAX_EXPERIMENT_DECISION_NOTE_LENGTH, true);
  if (
    !experiment
    || experiment.decision !== 'pending'
    || experiment.observedCount !== experiment.targetCount
    || !['adopt', 'revise', 'discard'].includes(decision)
    || timestamp === null
    || timestamp < current.updatedAt
    || note === null
  ) return null;
  const nextExperiment: ActionExperiment = Object.freeze({
    ...experiment,
    decision,
    evidenceNote: note,
    updatedAt: timestamp,
  });
  defineAction(actions, actionId, Object.freeze({
    ...current,
    status: decision === 'adopt' ? 'done' : decision === 'revise' ? 'open' : 'dismissed',
    completedAt: decision === 'revise' ? null : timestamp,
    updatedAt: timestamp,
    experiment: nextExperiment,
  }));
  return actions;
}

export function decideActionExperiment(
  scope: string | null,
  actionId: string,
  decision: Exclude<ActionExperimentDecision, 'pending'>,
  evidenceNote: string,
  now = Date.now(),
): ActionPlanMap | null {
  return mutateStoredActions(
    scope,
    (actions) => nextActionExperimentDecision(actions, actionId, decision, evidenceNote, now),
  );
}

export function clearLocalActionPlans(): number {
  let removed = 0;
  try {
    const keys = Array.from({ length: localStorage.length }, (_value, index) => (
      localStorage.key(index)
    )).filter((key): key is string => typeof key === 'string');
    for (const key of keys) {
      if (key.startsWith(PREFIX)) {
        localStorage.removeItem(key);
        removed += 1;
      }
    }
  } catch {}
  return removed;
}
