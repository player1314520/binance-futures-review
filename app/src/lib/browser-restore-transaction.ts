export const BROWSER_RESTORE_TRANSACTION_KEY = 'rv-browser-restore-transaction-v1';
export const BROWSER_RESTORE_LOCK_KEY = 'rv-browser-restore-lock-v1';
export const BROWSER_RESTORE_LOCK_NAME = 'rv-browser-restore-transaction';
export const BROWSER_STORAGE_GENERATION_KEY = 'rv-browser-storage-generation-v1';
export const BROWSER_STORAGE_EPOCH_KEY = 'rv-browser-storage-epoch-v1';
export const MAX_BROWSER_RESTORE_ROLLBACK_BYTES = 12 * 1024 * 1024;

const DEFAULT_LEASE_MS = 15_000;
const LEGACY_SESSION_KEY = 'rv2-session';
const MAX_CLEAR_KEYS = 50_000;

export type BrowserRestoreReplacement = Readonly<{
  key: string;
  serialized: string;
}>;

export type BrowserRestoreWebLocks = Readonly<{
  request: <T>(
    name: string,
    options: Readonly<{ mode: 'exclusive'; ifAvailable: true }>,
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ) => Promise<T>;
}>;

export type BrowserRestoreTransactionOptions = Readonly<{
  storage?: Storage;
  locks?: BrowserRestoreWebLocks | null;
  ownerId?: string;
  now?: () => number;
  settle?: () => Promise<void>;
  leaseMs?: number;
  isCurrent?: () => boolean;
  /** Test-only: localStorage leases cannot provide production-grade exclusion. */
  testOnlyAllowNonAtomicLease?: boolean;
}>;

export type BrowserStorageFailureCode =
  | 'INVALID_INPUT'
  | 'LOCK_BUSY'
  | 'LOCK_UNAVAILABLE'
  | 'LOCK_DAMAGED'
  | 'LOCK_LOST'
  | 'JOURNAL_DAMAGED'
  | 'GENERATION_DAMAGED'
  | 'STALE_AFTER_CLEAR'
  | 'MUTATION_REJECTED'
  | 'STORAGE_FAILED'
  | 'VERIFY_FAILED'
  | 'RECOVERY_REQUIRED';

export type BrowserStorageFailure = Readonly<{
  ok: false;
  code: BrowserStorageFailureCode;
}>;

export type BrowserWriteToken = Readonly<{
  generation: number;
  epoch: string;
}>;

export type BrowserSerializedWorkspace = Readonly<{
  reviews: string | null;
  actions: string | null;
  practice: string | null;
}>;

export type BrowserWorkspaceMutationContext = Readonly<{
  generation: number;
  latest: BrowserSerializedWorkspace;
}>;

export type BrowserWorkspaceMutationDecision<T> = Readonly<{
  next: Readonly<{
    reviews: string;
    actions: string;
    practice: string;
  }>;
  value: T;
}>;

export type BrowserWorkspaceMutationResult<T> =
  | Readonly<{
    ok: true;
    state: BrowserSerializedWorkspace;
    value: T;
    generation: number;
    token: BrowserWriteToken;
  }>
  | BrowserStorageFailure;

export type BrowserClearResult =
  | Readonly<{
    ok: true;
    removedUserKeys: number;
    repairedJournal: boolean;
    generation: number;
    token: BrowserWriteToken;
  }>
  | BrowserStorageFailure;

type RollbackEntry = Readonly<{
  key: string;
  previous: string | null;
}>;

type ParsedReplaceJournal = Readonly<{
  kind: 'REPLACE';
  entries: readonly RollbackEntry[];
  owner: string | null;
}>;

type ParsedClearJournal = Readonly<{
  kind: 'CLEAR';
  keys: readonly string[];
  generationBefore: number;
  generationAfter: number;
  owner: string;
}>;

type ParsedClearAllJournal = Readonly<{
  kind: 'CLEAR_ALL';
  generationBefore: number;
  generationAfter: number;
  owner: string;
}>;

type ParsedRepairClearAllJournal = Readonly<{
  kind: 'REPAIR_CLEAR_ALL';
  generationAfter: 0;
  epochAfter: string;
  owner: string;
}>;

type ParsedJournal = ParsedReplaceJournal
  | ParsedClearJournal
  | ParsedClearAllJournal
  | ParsedRepairClearAllJournal;

type RecoveryOutcome = Readonly<{
  removedUserKeys: number;
  completedClear: boolean;
}>;

type LockContext = Readonly<{
  owner: string;
  expiresAt: number;
  owns: () => boolean;
}>;

type InternalSuccess<T> = Readonly<{ ok: true; value: T }>;
type InternalResult<T> = InternalSuccess<T> | BrowserStorageFailure;

const KEY_PATTERN = /^rv-(review|action|practice)-v1:([a-z0-9][a-z0-9-]{2,95})$/i;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{2,95}$/i;
const OWNER_PATTERN = /^[a-z0-9-]{8,128}$/i;
const GENERATION_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const LEGACY_EPOCH = 'legacy-v1';
const EMERGENCY_CLEAR_MARKER_PATTERN = /^!rv-clear-all\/1\|(0|[1-9][0-9]{0,15})\|(0|[1-9][0-9]{0,15})\|([a-z0-9-]{8,128})$/i;

type EmergencyClearMarker = Readonly<{
  key: string;
  raw: string;
  generationBefore: number;
  generationAfter: number;
  transactionId: string;
}>;

function success<T>(value: T): InternalSuccess<T> {
  return { ok: true, value };
}

function failure(code: BrowserStorageFailureCode): BrowserStorageFailure {
  return { ok: false, code };
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validReplacementSet(replacements: readonly BrowserRestoreReplacement[]): boolean {
  if (replacements.length !== 3) return false;
  const families = new Set<string>();
  const keys = new Set<string>();
  let scope = '';
  let bytes = 0;
  for (const replacement of replacements) {
    if (
      !replacement
      || typeof replacement.key !== 'string'
      || typeof replacement.serialized !== 'string'
    ) return false;
    const match = KEY_PATTERN.exec(replacement.key);
    if (!match || keys.has(replacement.key) || families.has(match[1])) return false;
    if (scope && scope !== match[2]) return false;
    scope = match[2];
    keys.add(replacement.key);
    families.add(match[1]);
    bytes += utf8Bytes(replacement.serialized);
    if (bytes > MAX_BROWSER_RESTORE_ROLLBACK_BYTES) return false;
  }
  return ['review', 'action', 'practice'].every((family) => families.has(family));
}

function workspaceReplacements(
  scope: string,
  state: Readonly<{ reviews: string; actions: string; practice: string }>,
): readonly BrowserRestoreReplacement[] {
  return [
    { key: `rv-review-v1:${scope}`, serialized: state.reviews },
    { key: `rv-action-v1:${scope}`, serialized: state.actions },
    { key: `rv-practice-v1:${scope}`, serialized: state.practice },
  ];
}

function readSerializedWorkspace(storage: Storage, scope: string): InternalResult<BrowserSerializedWorkspace> {
  try {
    return success({
      reviews: storage.getItem(`rv-review-v1:${scope}`),
      actions: storage.getItem(`rv-action-v1:${scope}`),
      practice: storage.getItem(`rv-practice-v1:${scope}`),
    });
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function parseEntries(candidates: unknown): readonly RollbackEntry[] | null {
  if (!Array.isArray(candidates) || candidates.length !== 3) return null;
  const replacements: BrowserRestoreReplacement[] = [];
  const entries: RollbackEntry[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const entry = candidate as Record<string, unknown>;
    if (!exactKeys(entry, ['key', 'previous'])) return null;
    if (typeof entry.key !== 'string' || (entry.previous !== null && typeof entry.previous !== 'string')) {
      return null;
    }
    replacements.push({ key: entry.key, serialized: entry.previous ?? '{}' });
    entries.push({ key: entry.key, previous: entry.previous as string | null });
  }
  return validReplacementSet(replacements) ? entries : null;
}

function validClearKey(value: unknown): value is string {
  return typeof value === 'string' && (value === LEGACY_SESSION_KEY || KEY_PATTERN.test(value));
}

function parseClearKeys(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CLEAR_KEYS) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!validClearKey(candidate) || seen.has(candidate)) return null;
    seen.add(candidate);
    keys.push(candidate);
  }
  return keys;
}

function parsePrepared(raw: string): ParsedJournal | null {
  if (utf8Bytes(raw) > MAX_BROWSER_RESTORE_ROLLBACK_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    // v1 was briefly shipped before ownership was recorded. Keep it readable
    // so an upgrade never strands a valid rollback journal.
    if (exactKeys(row, ['format', 'status', 'entries'])) {
      if (row.format !== 'rv-browser-restore-transaction/1' || row.status !== 'PREPARED') return null;
      const entries = parseEntries(row.entries);
      return entries ? { kind: 'REPLACE', entries, owner: null } : null;
    }
    if (exactKeys(row, ['format', 'status', 'owner', 'transactionId', 'leaseExpiresAt', 'entries'])) {
      if (
        row.format !== 'rv-browser-restore-transaction/2'
        || row.status !== 'PREPARED'
        || typeof row.owner !== 'string'
        || !OWNER_PATTERN.test(row.owner)
        || typeof row.transactionId !== 'string'
        || !OWNER_PATTERN.test(row.transactionId)
        || typeof row.leaseExpiresAt !== 'number'
        || !Number.isSafeInteger(row.leaseExpiresAt)
        || row.leaseExpiresAt < 0
      ) return null;
      const entries = parseEntries(row.entries);
      return entries ? { kind: 'REPLACE', entries, owner: row.owner } : null;
    }
    if (exactKeys(row, [
      'format',
      'kind',
      'status',
      'owner',
      'transactionId',
      'leaseExpiresAt',
      'generationAfter',
      'epochAfter',
    ])) {
      if (
        row.format !== 'rv-browser-storage-transaction/5'
        || row.kind !== 'REPAIR_CLEAR_ALL'
        || row.status !== 'PREPARED'
        || typeof row.owner !== 'string'
        || !OWNER_PATTERN.test(row.owner)
        || typeof row.transactionId !== 'string'
        || !OWNER_PATTERN.test(row.transactionId)
        || typeof row.leaseExpiresAt !== 'number'
        || !Number.isSafeInteger(row.leaseExpiresAt)
        || row.leaseExpiresAt < 0
        || row.generationAfter !== 0
        || typeof row.epochAfter !== 'string'
        || !OWNER_PATTERN.test(row.epochAfter)
        || row.epochAfter === LEGACY_EPOCH
      ) return null;
      return {
        kind: 'REPAIR_CLEAR_ALL',
        generationAfter: 0,
        epochAfter: row.epochAfter,
        owner: row.owner,
      };
    }
    if (exactKeys(row, [
      'format',
      'kind',
      'status',
      'owner',
      'transactionId',
      'leaseExpiresAt',
      'generationBefore',
      'generationAfter',
    ])) {
      if (
        row.format !== 'rv-browser-storage-transaction/4'
        || row.kind !== 'CLEAR_ALL'
        || row.status !== 'PREPARED'
        || typeof row.owner !== 'string'
        || !OWNER_PATTERN.test(row.owner)
        || typeof row.transactionId !== 'string'
        || !OWNER_PATTERN.test(row.transactionId)
        || typeof row.leaseExpiresAt !== 'number'
        || !Number.isSafeInteger(row.leaseExpiresAt)
        || row.leaseExpiresAt < 0
        || !validGeneration(row.generationBefore)
        || !validGeneration(row.generationAfter)
        || row.generationAfter !== row.generationBefore + 1
      ) return null;
      return {
        kind: 'CLEAR_ALL',
        generationBefore: row.generationBefore,
        generationAfter: row.generationAfter,
        owner: row.owner,
      };
    }
    if (!exactKeys(row, [
      'format',
      'kind',
      'status',
      'owner',
      'transactionId',
      'leaseExpiresAt',
      'generationBefore',
      'generationAfter',
      'keys',
    ])) return null;
    if (
      row.format !== 'rv-browser-storage-transaction/3'
      || row.kind !== 'CLEAR'
      || row.status !== 'PREPARED'
      || typeof row.owner !== 'string'
      || !OWNER_PATTERN.test(row.owner)
      || typeof row.transactionId !== 'string'
      || !OWNER_PATTERN.test(row.transactionId)
      || typeof row.leaseExpiresAt !== 'number'
      || !Number.isSafeInteger(row.leaseExpiresAt)
      || row.leaseExpiresAt < 0
      || !validGeneration(row.generationBefore)
      || !validGeneration(row.generationAfter)
      || row.generationAfter !== row.generationBefore + 1
    ) return null;
    const keys = parseClearKeys(row.keys);
    return keys ? {
      kind: 'CLEAR',
      keys,
      generationBefore: row.generationBefore,
      generationAfter: row.generationAfter,
      owner: row.owner,
    } : null;
  } catch {
    return null;
  }
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('-');
  }
}

function defaultLocks(): BrowserRestoreWebLocks | null {
  const candidate = (typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { locks?: BrowserRestoreWebLocks }).locks);
  return candidate && typeof candidate.request === 'function' ? candidate : null;
}

function defaultSettle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function parseLease(raw: string | null): { owner: string; expiresAt: number } | null {
  if (raw === null || utf8Bytes(raw) > 1_024) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!exactKeys(row, ['owner', 'expiresAt'])) return null;
    if (
      typeof row.owner !== 'string'
      || !OWNER_PATTERN.test(row.owner)
      || typeof row.expiresAt !== 'number'
      || !Number.isSafeInteger(row.expiresAt)
    ) return null;
    return { owner: row.owner, expiresAt: row.expiresAt };
  } catch {
    return null;
  }
}

function readStoredGeneration(storage: Storage): InternalResult<number> {
  let raw: string | null;
  try {
    raw = storage.getItem(BROWSER_STORAGE_GENERATION_KEY);
  } catch {
    return failure('STORAGE_FAILED');
  }
  if (raw === null) return success(0);
  if (!GENERATION_PATTERN.test(raw)) return failure('GENERATION_DAMAGED');
  const generation = Number(raw);
  return validGeneration(generation) ? success(generation) : failure('GENERATION_DAMAGED');
}

function parseEmergencyClearMarker(key: string, raw: string): EmergencyClearMarker | null {
  const match = EMERGENCY_CLEAR_MARKER_PATTERN.exec(raw);
  if (!match) return null;
  const generationBefore = Number(match[1]);
  const generationAfter = Number(match[2]);
  if (
    !validClearKey(key)
    || !validGeneration(generationBefore)
    || !validGeneration(generationAfter)
    || generationAfter !== generationBefore + 1
  ) return null;
  return {
    key,
    raw,
    generationBefore,
    generationAfter,
    transactionId: match[3],
  };
}

function findEmergencyClearMarker(storage: Storage): InternalResult<EmergencyClearMarker | null> {
  const keys = enumerateUserDataKeys(storage);
  if (!keys.ok) return keys;
  let marker: EmergencyClearMarker | null = null;
  try {
    for (const key of keys.value) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const candidate = parseEmergencyClearMarker(key, raw);
      if (!candidate) continue;
      if (marker !== null) return failure('GENERATION_DAMAGED');
      marker = candidate;
    }
    return success(marker);
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function readEpoch(storage: Storage): InternalResult<string> {
  try {
    const raw = storage.getItem(BROWSER_STORAGE_EPOCH_KEY);
    if (raw === null) return success(LEGACY_EPOCH);
    return OWNER_PATTERN.test(raw) && raw !== LEGACY_EPOCH
      ? success(raw)
      : failure('GENERATION_DAMAGED');
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function readGenerationState(storage: Storage): InternalResult<BrowserWriteToken> {
  let journal: ParsedJournal | null;
  try {
    const rawJournal = storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY);
    journal = rawJournal === null ? null : parsePrepared(rawJournal);
  } catch {
    return failure('STORAGE_FAILED');
  }
  // A repair journal is an opaque epoch fence and deliberately supersedes a
  // malformed legacy generation/epoch value until recovery normalizes both.
  if (journal?.kind === 'REPAIR_CLEAR_ALL') {
    return success({ generation: journal.generationAfter, epoch: journal.epochAfter });
  }
  const stored = readStoredGeneration(storage);
  if (!stored.ok) return stored;
  const epoch = readEpoch(storage);
  if (!epoch.ok) return epoch;
  const marker = findEmergencyClearMarker(storage);
  if (!marker.ok) return marker;
  let fence = marker.value === null ? null : {
    generationBefore: marker.value.generationBefore,
    generationAfter: marker.value.generationAfter,
  };
  try {
    if (journal?.kind === 'CLEAR' || journal?.kind === 'CLEAR_ALL') {
      if (
        fence !== null
        && (fence.generationBefore !== journal.generationBefore
          || fence.generationAfter !== journal.generationAfter)
      ) return failure('GENERATION_DAMAGED');
      fence = {
        generationBefore: journal.generationBefore,
        generationAfter: journal.generationAfter,
      };
    }
  } catch {
    return failure('STORAGE_FAILED');
  }
  if (fence === null) return success({ generation: stored.value, epoch: epoch.value });
  if (
    stored.value !== fence.generationBefore
    && stored.value !== fence.generationAfter
  ) return failure('GENERATION_DAMAGED');
  // A formal clear journal or in-place emergency marker is itself the durable
  // fence, even before the primary generation key can be expanded at quota.
  return success({ generation: fence.generationAfter, epoch: epoch.value });
}

function readGeneration(storage: Storage): InternalResult<number> {
  const state = readGenerationState(storage);
  return state.ok ? success(state.value.generation) : state;
}

export function captureBrowserWriteToken(storage: Storage = localStorage): BrowserWriteToken | null {
  const state = readGenerationState(storage);
  return state.ok ? Object.freeze({ ...state.value }) : null;
}

async function withExclusiveLock<T>(
  operation: (context: LockContext) => T | Promise<T>,
  options: BrowserRestoreTransactionOptions,
): Promise<T | BrowserStorageFailure> {
  const storage = options.storage ?? localStorage;
  const now = options.now ?? Date.now;
  const owner = options.ownerId ?? randomId();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!OWNER_PATTERN.test(owner) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    return failure('INVALID_INPUT');
  }
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  if (locks) {
    try {
      return await locks.request(
        BROWSER_RESTORE_LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) return failure('LOCK_BUSY');
          const expiresAt = now() + leaseMs;
          const context = {
            owner,
            expiresAt,
            owns: () => (options.isCurrent?.() ?? true),
          };
          if (!context.owns()) return failure('LOCK_LOST');
          return operation(context);
        },
      );
    } catch {
      return failure('LOCK_UNAVAILABLE');
    }
  }

  if (!options.testOnlyAllowNonAtomicLease) return failure('LOCK_UNAVAILABLE');

  const expiresAt = now() + leaseMs;
  const candidate = JSON.stringify({ owner, expiresAt });
  let observed: string | null;
  try {
    observed = storage.getItem(BROWSER_RESTORE_LOCK_KEY);
    const current = parseLease(observed);
    if (observed !== null && !current) return failure('LOCK_DAMAGED');
    if (current && current.expiresAt > now()) return failure('LOCK_BUSY');
    // Compare before setting and verify after one event-loop turn. This is the
    // strongest fail-closed fallback available where Web Locks do not exist.
    if (storage.getItem(BROWSER_RESTORE_LOCK_KEY) !== observed) return failure('LOCK_BUSY');
    storage.setItem(BROWSER_RESTORE_LOCK_KEY, candidate);
    await (options.settle ?? defaultSettle)();
    if (storage.getItem(BROWSER_RESTORE_LOCK_KEY) !== candidate) return failure('LOCK_LOST');
  } catch {
    return failure('STORAGE_FAILED');
  }
  const owns = () => {
    try {
      return storage.getItem(BROWSER_RESTORE_LOCK_KEY) === candidate
        && now() < expiresAt
        && (options.isCurrent?.() ?? true);
    } catch {
      return false;
    }
  };
  try {
    if (!owns()) return failure('LOCK_LOST');
    return await operation({ owner, expiresAt, owns });
  } finally {
    try {
      if (storage.getItem(BROWSER_RESTORE_LOCK_KEY) === candidate) {
        storage.removeItem(BROWSER_RESTORE_LOCK_KEY);
      }
    } catch {
      // A failed release leaves a bounded lease; later work remains fail closed.
    }
  }
}

function rollbackLocked(
  storage: Storage,
  entries: readonly RollbackEntry[],
  expectedJournal: string,
  owns: () => boolean,
): InternalResult<void> {
  try {
    if (!owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
      return failure('LOCK_LOST');
    }
  } catch {
    return failure('STORAGE_FAILED');
  }
  for (const entry of [...entries].reverse()) {
    try {
      if (!owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
        return failure('LOCK_LOST');
      }
      if (entry.previous === null) storage.removeItem(entry.key);
      else storage.setItem(entry.key, entry.previous);
    } catch {
      return failure('RECOVERY_REQUIRED');
    }
  }
  try {
    for (const entry of entries) {
      if (!owns() || storage.getItem(entry.key) !== entry.previous) {
        return owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      }
    }
    if (!owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
      return failure('LOCK_LOST');
    }
    storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
    if (!owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null) {
      return owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
    return success(undefined);
  } catch {
    return failure('RECOVERY_REQUIRED');
  }
}

function recoverClearLocked(
  storage: Storage,
  journal: ParsedClearJournal | ParsedClearAllJournal,
  expectedJournal: string,
  context: LockContext,
): InternalResult<number> {
  const generation = readStoredGeneration(storage);
  if (!generation.ok) return generation;
  let emergencyRemoved = 0;
  // A newer generation is winner evidence. Never let an old clear journal
  // delete data written after that winner.
  if (generation.value > journal.generationAfter || generation.value < journal.generationBefore) {
    return failure('RECOVERY_REQUIRED');
  }
  try {
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
      return failure('LOCK_LOST');
    }
    if (generation.value === journal.generationBefore) {
      try {
        storage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(journal.generationAfter));
      } catch (error) {
        if (!isQuotaExceeded(error)) return failure('STORAGE_FAILED');
        const barrier = installEmergencyGenerationBarrier(
          storage,
          journal.generationAfter,
          context,
          expectedJournal,
        );
        if (!barrier.ok) return barrier;
        emergencyRemoved += barrier.value;
      }
      if (
        !context.owns()
        || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
        || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(journal.generationAfter)
      ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
    const keysResult = journal.kind === 'CLEAR_ALL'
      ? enumerateUserDataKeys(storage)
      : success(journal.keys);
    if (!keysResult.ok) return keysResult;
    let removedUserKeys = emergencyRemoved;
    for (const key of keysResult.value) {
      if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
        return failure('LOCK_LOST');
      }
      if (storage.getItem(key) !== null) removedUserKeys += 1;
      storage.removeItem(key);
    }
    for (const key of keysResult.value) {
      if (!context.owns() || storage.getItem(key) !== null) {
        return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      }
    }
    if (journal.kind === 'CLEAR_ALL') {
      const remaining = enumerateUserDataKeys(storage);
      if (!remaining.ok) return remaining;
      if (remaining.value.length > 0) return failure('VERIFY_FAILED');
    }
    if (
      !context.owns()
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
      || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(journal.generationAfter)
    ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null) {
      return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
    return success(removedUserKeys);
  } catch {
    return failure('RECOVERY_REQUIRED');
  }
}

function recoverEmergencyClearLocked(
  storage: Storage,
  marker: EmergencyClearMarker,
  context: LockContext,
): InternalResult<number> {
  const stored = readStoredGeneration(storage);
  if (!stored.ok) return stored;
  if (stored.value !== marker.generationBefore && stored.value !== marker.generationAfter) {
    return failure('GENERATION_DAMAGED');
  }
  let removedUserKeys = 0;
  if (stored.value === marker.generationBefore) {
    while (context.owns()) {
      try {
        if (storage.getItem(marker.key) !== marker.raw) return failure('LOCK_LOST');
        storage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(marker.generationAfter));
        if (
          context.owns()
          && storage.getItem(marker.key) === marker.raw
          && storage.getItem(BROWSER_STORAGE_GENERATION_KEY) === String(marker.generationAfter)
        ) break;
        return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      } catch (error) {
        if (!isQuotaExceeded(error)) return failure('STORAGE_FAILED');
        const candidates = enumerateUserDataKeys(storage);
        if (!candidates.ok) return candidates;
        const key = candidates.value.find((candidate) => candidate !== marker.key);
        if (key === undefined) return failure('RECOVERY_REQUIRED');
        try {
          if (!context.owns() || storage.getItem(marker.key) !== marker.raw) {
            return failure('LOCK_LOST');
          }
          if (storage.getItem(key) !== null) removedUserKeys += 1;
          storage.removeItem(key);
          if (
            !context.owns()
            || storage.getItem(marker.key) !== marker.raw
            || storage.getItem(key) !== null
          ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
        } catch {
          return context.owns() ? failure('RECOVERY_REQUIRED') : failure('LOCK_LOST');
        }
      }
    }
    if (!context.owns()) return failure('LOCK_LOST');
  }
  const remaining = enumerateUserDataKeys(storage);
  if (!remaining.ok) return remaining;
  try {
    for (const key of remaining.value) {
      if (key === marker.key) continue;
      if (
        !context.owns()
        || storage.getItem(marker.key) !== marker.raw
        || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(marker.generationAfter)
      ) return failure('LOCK_LOST');
      if (storage.getItem(key) !== null) removedUserKeys += 1;
      storage.removeItem(key);
    }
    const beforeMarkerRemoval = enumerateUserDataKeys(storage);
    if (!beforeMarkerRemoval.ok) return beforeMarkerRemoval;
    if (
      beforeMarkerRemoval.value.some((key) => key !== marker.key)
      || !context.owns()
      || storage.getItem(marker.key) !== marker.raw
      || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(marker.generationAfter)
    ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    // The marker key represented data already overwritten by the interrupted
    // clear. Deleting the marker last must not count it a second time on retry.
    storage.removeItem(marker.key);
    const finalKeys = enumerateUserDataKeys(storage);
    if (!finalKeys.ok) return finalKeys;
    if (
      !context.owns()
      || finalKeys.value.length !== 0
      || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(marker.generationAfter)
    ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    return success(removedUserKeys);
  } catch {
    return context.owns() ? failure('RECOVERY_REQUIRED') : failure('LOCK_LOST');
  }
}

function recoverRepairClearAllLocked(
  storage: Storage,
  journal: ParsedRepairClearAllJournal,
  expectedJournal: string,
  context: LockContext,
): InternalResult<number> {
  try {
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
      return failure('LOCK_LOST');
    }
    storage.setItem(BROWSER_STORAGE_EPOCH_KEY, journal.epochAfter);
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal) {
      return failure('LOCK_LOST');
    }
    storage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(journal.generationAfter));
    if (
      !context.owns()
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
      || storage.getItem(BROWSER_STORAGE_EPOCH_KEY) !== journal.epochAfter
      || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(journal.generationAfter)
    ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    const keys = enumerateUserDataKeys(storage);
    if (!keys.ok) return keys;
    let removedUserKeys = 0;
    for (const key of keys.value) {
      if (
        !context.owns()
        || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
        || storage.getItem(BROWSER_STORAGE_EPOCH_KEY) !== journal.epochAfter
        || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(journal.generationAfter)
      ) return failure('LOCK_LOST');
      if (storage.getItem(key) !== null) removedUserKeys += 1;
      storage.removeItem(key);
    }
    const remaining = enumerateUserDataKeys(storage);
    if (!remaining.ok) return remaining;
    if (remaining.value.length > 0) return failure('VERIFY_FAILED');
    storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
    if (
      !context.owns()
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null
      || storage.getItem(BROWSER_STORAGE_EPOCH_KEY) !== journal.epochAfter
      || storage.getItem(BROWSER_STORAGE_GENERATION_KEY) !== String(journal.generationAfter)
    ) return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    return success(removedUserKeys);
  } catch {
    // The v5 repair journal remains the durable opaque fence. No user key is
    // touched until both normalized generation fields have been persisted.
    return context.owns() ? failure('STORAGE_FAILED') : failure('LOCK_LOST');
  }
}

function recoverLocked(storage: Storage, context: LockContext): InternalResult<RecoveryOutcome> {
  let raw: string | null;
  try {
    if (!context.owns()) return failure('LOCK_LOST');
    raw = storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY);
  } catch {
    return failure('STORAGE_FAILED');
  }
  if (raw === null) {
    const marker = findEmergencyClearMarker(storage);
    if (!marker.ok) return marker;
    if (marker.value === null) return success({ removedUserKeys: 0, completedClear: false });
    const recovered = recoverEmergencyClearLocked(storage, marker.value, context);
    return recovered.ok
      ? success({ removedUserKeys: recovered.value, completedClear: true })
      : recovered;
  }
  const journal = parsePrepared(raw);
  if (!journal) return failure('JOURNAL_DAMAGED');
  if (journal.kind === 'REPAIR_CLEAR_ALL') {
    const recovered = recoverRepairClearAllLocked(storage, journal, raw, context);
    return recovered.ok
      ? success({ removedUserKeys: recovered.value, completedClear: true })
      : recovered;
  }
  if (journal.kind === 'CLEAR' || journal.kind === 'CLEAR_ALL') {
    const recovered = recoverClearLocked(storage, journal, raw, context);
    return recovered.ok
      ? success({ removedUserKeys: recovered.value, completedClear: true })
      : recovered;
  }
  const rolledBack = rollbackLocked(storage, journal.entries, raw, context.owns);
  return rolledBack.ok
    ? success({ removedUserKeys: 0, completedClear: false })
    : rolledBack;
}

async function recoverDetailed(
  options: BrowserRestoreTransactionOptions = {},
): Promise<InternalResult<RecoveryOutcome>> {
  const storage = options.storage ?? localStorage;
  return withExclusiveLock((context) => recoverLocked(storage, context), options);
}

export async function recoverBrowserRestoreTransaction(
  options: BrowserRestoreTransactionOptions = {},
): Promise<boolean> {
  return (await recoverDetailed(options)).ok;
}

export async function clearBrowserRestoreTransaction(
  options: BrowserRestoreTransactionOptions = {},
): Promise<boolean> {
  const storage = options.storage ?? localStorage;
  const result = await withExclusiveLock((context): InternalResult<RecoveryOutcome | undefined> => {
    let raw: string | null;
    try {
      if (!context.owns()) return failure('LOCK_LOST');
      raw = storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY);
    } catch {
      return failure('STORAGE_FAILED');
    }
    if (raw === null) return success(undefined);
    if (parsePrepared(raw)) return recoverLocked(storage, context);
    // This compatibility API is an explicit repair action. Ordinary recovery
    // and every mutation continue to fail closed on a damaged journal.
    try {
      if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== raw) {
        return failure('LOCK_LOST');
      }
      storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
      return context.owns() && storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) === null
        ? success(undefined)
        : failure('VERIFY_FAILED');
    } catch {
      return failure('STORAGE_FAILED');
    }
  }, options);
  return result.ok;
}

/** Commits one complete scoped replacement while the coordinator lock is held. */
function commitLocked(
  replacements: readonly BrowserRestoreReplacement[],
  storage: Storage,
  context: LockContext,
): InternalResult<void> {
  if (!validReplacementSet(replacements)) return failure('INVALID_INPUT');
  let entries: RollbackEntry[];
  try {
    if (!context.owns()) return failure('LOCK_LOST');
    entries = replacements.map(({ key }) => ({ key, previous: storage.getItem(key) }));
  } catch {
    return failure('STORAGE_FAILED');
  }
  const prepared = JSON.stringify({
    format: 'rv-browser-restore-transaction/2',
    status: 'PREPARED',
    owner: context.owner,
    transactionId: randomId(),
    leaseExpiresAt: context.expiresAt,
    entries,
  });
  if (utf8Bytes(prepared) > MAX_BROWSER_RESTORE_ROLLBACK_BYTES) return failure('INVALID_INPUT');
  let writeFailure: BrowserStorageFailure = failure('STORAGE_FAILED');
  let journalInstalled = false;
  try {
    if (!context.owns()) return failure('LOCK_LOST');
    storage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, prepared);
    journalInstalled = true;
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== prepared) {
      writeFailure = context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      throw new Error('BROWSER_RESTORE_AUTHORITY_CHANGED');
    }
    for (const replacement of replacements) {
      if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== prepared) {
        writeFailure = failure('LOCK_LOST');
        throw new Error('BROWSER_RESTORE_AUTHORITY_CHANGED');
      }
      storage.setItem(replacement.key, replacement.serialized);
    }
    if (
      !context.owns()
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== prepared
      || replacements.some(({ key, serialized }) => storage.getItem(key) !== serialized)
    ) {
      writeFailure = context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      throw new Error('BROWSER_RESTORE_VERIFY_FAILED');
    }
    storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null) {
      writeFailure = context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
      throw new Error('BROWSER_RESTORE_COMMIT_FAILED');
    }
    return success(undefined);
  } catch {
    // Never roll back under stale authority: a different tab may already have
    // completed a newer transaction after this lease was lost.
    if (!journalInstalled) return writeFailure;
    const rolledBack = rollbackLocked(storage, entries, prepared, context.owns);
    if (!rolledBack.ok && rolledBack.code === 'LOCK_LOST') return rolledBack;
    if (!rolledBack.ok) return failure('RECOVERY_REQUIRED');
    return writeFailure;
  }
}

export async function commitBrowserRestoreTransaction(
  replacements: readonly BrowserRestoreReplacement[],
  options: BrowserRestoreTransactionOptions = {},
): Promise<boolean> {
  if (!validReplacementSet(replacements)) return false;
  const storage = options.storage ?? localStorage;
  const result = await withExclusiveLock((context) => {
    const recovered = recoverLocked(storage, context);
    return recovered.ok ? commitLocked(replacements, storage, context) : recovered;
  }, options);
  return result.ok;
}

export async function mutateBrowserWorkspace<T>(
  scope: string,
  token: BrowserWriteToken,
  mutate: (
    context: BrowserWorkspaceMutationContext,
  ) => BrowserWorkspaceMutationDecision<T> | null
    | PromiseLike<BrowserWorkspaceMutationDecision<T> | null>,
  options: BrowserRestoreTransactionOptions = {},
): Promise<BrowserWorkspaceMutationResult<T>> {
  if (
    !SCOPE_PATTERN.test(scope)
    || !token
    || !validGeneration(token.generation)
    || (token.epoch !== LEGACY_EPOCH && !OWNER_PATTERN.test(token.epoch))
    || typeof mutate !== 'function'
  ) return failure('INVALID_INPUT');
  const storage = options.storage ?? localStorage;
  return withExclusiveLock(async (context): Promise<BrowserWorkspaceMutationResult<T>> => {
    const recovered = recoverLocked(storage, context);
    if (!recovered.ok) return recovered;
    const generation = readGenerationState(storage);
    if (!generation.ok) return generation;
    if (
      generation.value.generation !== token.generation
      || generation.value.epoch !== token.epoch
    ) return failure('STALE_AFTER_CLEAR');
    const latest = readSerializedWorkspace(storage, scope);
    if (!latest.ok) return latest;
    let decision: BrowserWorkspaceMutationDecision<T> | null;
    try {
      decision = await mutate(Object.freeze({
        generation: generation.value.generation,
        latest: Object.freeze({ ...latest.value }),
      }));
    } catch {
      return failure('MUTATION_REJECTED');
    }
    if (
      decision === null
      || !decision
      || typeof decision !== 'object'
      || !decision.next
      || typeof decision.next.reviews !== 'string'
      || typeof decision.next.actions !== 'string'
      || typeof decision.next.practice !== 'string'
    ) return failure('MUTATION_REJECTED');
    if (!context.owns()) return failure('LOCK_LOST');
    const generationBeforeCommit = readGenerationState(storage);
    if (!generationBeforeCommit.ok) return generationBeforeCommit;
    if (
      generationBeforeCommit.value.generation !== token.generation
      || generationBeforeCommit.value.epoch !== token.epoch
    ) return failure('STALE_AFTER_CLEAR');
    const committed = commitLocked(workspaceReplacements(scope, decision.next), storage, context);
    if (!committed.ok) return committed;
    const actual = readSerializedWorkspace(storage, scope);
    if (!actual.ok) return actual;
    const generationAfterCommit = readGenerationState(storage);
    if (!generationAfterCommit.ok) return generationAfterCommit;
    if (
      generationAfterCommit.value.generation !== token.generation
      || generationAfterCommit.value.epoch !== token.epoch
    ) return failure('STALE_AFTER_CLEAR');
    if (
      actual.value.reviews !== decision.next.reviews
      || actual.value.actions !== decision.next.actions
      || actual.value.practice !== decision.next.practice
    ) return failure('VERIFY_FAILED');
    return {
      ok: true,
      state: actual.value,
      value: decision.value,
      generation: generationAfterCommit.value.generation,
      token: Object.freeze({ ...generationAfterCommit.value }),
    };
  }, options);
}

export async function replaceBrowserWorkspace(
  scope: string,
  snapshot: Readonly<{ reviews: string; actions: string; practice: string }>,
  token: BrowserWriteToken,
  options: BrowserRestoreTransactionOptions = {},
): Promise<BrowserWorkspaceMutationResult<void>> {
  return mutateBrowserWorkspace(
    scope,
    token,
    () => ({ next: snapshot, value: undefined }),
    options,
  );
}

function enumerateUserDataKeys(storage: Storage): InternalResult<readonly string[]> {
  try {
    const keys = new Set<string>();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && validClearKey(key)) keys.add(key);
      if (keys.size > MAX_CLEAR_KEYS) return failure('INVALID_INPUT');
    }
    return success([...keys].sort());
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function tryInstallClearAllJournal(
  storage: Storage,
  prepared: string,
  context: LockContext,
): InternalResult<'INSTALLED' | 'QUOTA_EXCEEDED'> {
  if (!context.owns()) return failure('LOCK_LOST');
  try {
    storage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, prepared);
  } catch (error) {
    return isQuotaExceeded(error) ? success('QUOTA_EXCEEDED') : failure('STORAGE_FAILED');
  }
  try {
    if (!context.owns()) return failure('LOCK_LOST');
    return storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) === prepared
      ? success('INSTALLED')
      : failure('VERIFY_FAILED');
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function removeOneUserKeyForClear(
  storage: Storage,
  context: LockContext,
  expectedJournal: string,
): InternalResult<number> {
  const candidates = enumerateUserDataKeys(storage);
  if (!candidates.ok) return candidates;
  const key = candidates.value[0];
  if (key === undefined) return success(0);
  try {
    if (
      !context.owns()
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
    ) return failure('LOCK_LOST');
    const existed = storage.getItem(key) !== null;
    storage.removeItem(key);
    if (
      !context.owns()
      || storage.getItem(key) !== null
      || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
    ) {
      return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
    return success(existed ? 1 : 0);
  } catch {
    return failure('RECOVERY_REQUIRED');
  }
}

function installEmergencyGenerationBarrier(
  storage: Storage,
  generationAfter: number,
  context: LockContext,
  expectedJournal: string,
): InternalResult<number> {
  let removedUserKeys = 0;
  while (context.owns()) {
    try {
      if (
        storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== expectedJournal
      ) return failure('LOCK_LOST');
      storage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(generationAfter));
      if (
        context.owns()
        && storage.getItem(BROWSER_STORAGE_GENERATION_KEY) === String(generationAfter)
        && storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) === expectedJournal
      ) return success(removedUserKeys);
      return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    } catch (error) {
      if (!isQuotaExceeded(error)) return failure('STORAGE_FAILED');
      const removed = removeOneUserKeyForClear(storage, context, expectedJournal);
      if (!removed.ok) return removed;
      removedUserKeys += removed.value;
      if (removed.value === 0) return failure('RECOVERY_REQUIRED');
    }
  }
  return failure('LOCK_LOST');
}

function installEmergencyClearMarker(
  storage: Storage,
  keys: readonly string[],
  generationBefore: number,
  generationAfter: number,
  context: LockContext,
): InternalResult<EmergencyClearMarker> {
  const transactionId = randomId();
  const raw = `!rv-clear-all/1|${generationBefore}|${generationAfter}|${transactionId}`;
  let selected: { key: string; previous: string; bytes: number } | null = null;
  try {
    for (const key of keys) {
      const previous = storage.getItem(key);
      if (previous === null || parseEmergencyClearMarker(key, previous)) continue;
      const bytes = utf8Bytes(previous);
      if (bytes <= utf8Bytes(raw)) continue;
      if (selected === null || bytes > selected.bytes) selected = { key, previous, bytes };
    }
    if (selected === null || !context.owns()) return failure('STORAGE_FAILED');
    try {
      // Replacing one existing value with a shorter marker needs no new key.
      // The marker is both a forward-clear instruction and generation fence.
      storage.setItem(selected.key, raw);
    } catch {
      return storage.getItem(selected.key) === selected.previous
        ? failure('STORAGE_FAILED')
        : failure('RECOVERY_REQUIRED');
    }
    if (!context.owns() || storage.getItem(selected.key) !== raw) {
      return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
    const marker = parseEmergencyClearMarker(selected.key, raw);
    return marker ? success(marker) : failure('VERIFY_FAILED');
  } catch {
    return failure('STORAGE_FAILED');
  }
}

function repairDamagedGenerationAndClear(
  storage: Storage,
  context: LockContext,
): InternalResult<{ removedUserKeys: number; token: BrowserWriteToken }> {
  const epochAfter = randomId();
  const prepared = JSON.stringify({
    format: 'rv-browser-storage-transaction/5',
    kind: 'REPAIR_CLEAR_ALL',
    status: 'PREPARED',
    owner: context.owner,
    transactionId: randomId(),
    leaseExpiresAt: context.expiresAt,
    generationAfter: 0,
    epochAfter,
  });
  try {
    if (!context.owns()) return failure('LOCK_LOST');
    storage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, prepared);
    if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== prepared) {
      return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
    }
  } catch {
    // Without the opaque v5 fence, destructive repair must not touch user data.
    return context.owns() ? failure('STORAGE_FAILED') : failure('LOCK_LOST');
  }
  const journal = parsePrepared(prepared);
  if (!journal || journal.kind !== 'REPAIR_CLEAR_ALL') return failure('VERIFY_FAILED');
  const recovered = recoverRepairClearAllLocked(storage, journal, prepared, context);
  return recovered.ok
    ? success({
      removedUserKeys: recovered.value,
      token: Object.freeze({ generation: 0, epoch: epochAfter }),
    })
    : recovered;
}

export async function clearBrowserUserData(
  options: BrowserRestoreTransactionOptions = {},
): Promise<BrowserClearResult> {
  const storage = options.storage ?? localStorage;
  return withExclusiveLock((context): BrowserClearResult => {
    let previousJournal: string | null;
    try {
      if (!context.owns()) return failure('LOCK_LOST');
      previousJournal = storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY);
    } catch {
      return failure('STORAGE_FAILED');
    }
    const repairedJournal = previousJournal !== null;
    const parsedPrevious = previousJournal === null ? null : parsePrepared(previousJournal);
    let recoveredUserKeys = 0;
    let completedPriorClear = false;
    let generationRepairRequired = false;
    if (parsedPrevious || previousJournal === null) {
      const recovered = recoverLocked(storage, context);
      if (!recovered.ok) {
        if (recovered.code !== 'GENERATION_DAMAGED') return recovered;
        generationRepairRequired = true;
      } else {
        recoveredUserKeys = recovered.value.removedUserKeys;
        completedPriorClear = recovered.value.completedClear;
      }
    } else {
      // Only explicit clear may combine emergency-marker recovery with repair
      // of a damaged primary journal.
      const marker = findEmergencyClearMarker(storage);
      if (!marker.ok) return marker;
      if (marker.value !== null) {
        const recovered = recoverEmergencyClearLocked(storage, marker.value, context);
        if (!recovered.ok) return recovered;
        recoveredUserKeys = recovered.value;
        completedPriorClear = true;
        try {
          if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== previousJournal) {
            return failure('LOCK_LOST');
          }
          storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
          if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null) {
            return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
          }
        } catch {
          return context.owns() ? failure('RECOVERY_REQUIRED') : failure('LOCK_LOST');
        }
      }
    }
    // A damaged journal is repaired only by this explicit destructive action.
    // It is overwritten by the durable forward-clear journal below.
    const generation = readGenerationState(storage);
    if (generationRepairRequired || !generation.ok) {
      if (!generation.ok && generation.code !== 'GENERATION_DAMAGED') return generation;
      const repaired = repairDamagedGenerationAndClear(storage, context);
      if (!repaired.ok) return repaired;
      return {
        ok: true,
        removedUserKeys: recoveredUserKeys + repaired.value.removedUserKeys,
        repairedJournal,
        generation: repaired.value.token.generation,
        token: repaired.value.token,
      };
    }
    if (generation.value.generation >= Number.MAX_SAFE_INTEGER) {
      const repaired = repairDamagedGenerationAndClear(storage, context);
      if (!repaired.ok) return repaired;
      return {
        ok: true,
        removedUserKeys: recoveredUserKeys + repaired.value.removedUserKeys,
        repairedJournal,
        generation: repaired.value.token.generation,
        token: repaired.value.token,
      };
    }
    const enumerated = enumerateUserDataKeys(storage);
    if (!enumerated.ok) return enumerated;
    // A direct retry of an interrupted clear reports what recovery actually
    // removed, without manufacturing another generation when nothing is left.
    if (completedPriorClear && enumerated.value.length === 0) {
      return {
        ok: true,
        removedUserKeys: recoveredUserKeys,
        repairedJournal,
        generation: generation.value.generation,
        token: Object.freeze({ ...generation.value }),
      };
    }
    const generationAfter = generation.value.generation + 1;
    const prepared = JSON.stringify({
      format: 'rv-browser-storage-transaction/4',
      kind: 'CLEAR_ALL',
      status: 'PREPARED',
      owner: context.owner,
      transactionId: randomId(),
      leaseExpiresAt: context.expiresAt,
      generationBefore: generation.value.generation,
      generationAfter,
    });
    if (utf8Bytes(prepared) > MAX_BROWSER_RESTORE_ROLLBACK_BYTES) return failure('INVALID_INPUT');
    const installed = tryInstallClearAllJournal(storage, prepared, context);
    if (!installed.ok) return installed;
    if (installed.value === 'QUOTA_EXCEEDED') {
      // Never remove data before fencing. When a new journal cannot fit, a
      // shorter marker atomically replaces one existing authorized user value.
      const marker = installEmergencyClearMarker(
        storage,
        enumerated.value,
        generation.value.generation,
        generationAfter,
        context,
      );
      if (!marker.ok) return marker;
      const emergency = recoverEmergencyClearLocked(storage, marker.value, context);
      if (!emergency.ok) return emergency;
      try {
        if (!context.owns()) return failure('LOCK_LOST');
        // This may be a damaged primary journal that only explicit clear is
        // authorized to repair. The emergency fence and deletion are complete.
        storage.removeItem(BROWSER_RESTORE_TRANSACTION_KEY);
        if (!context.owns() || storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY) !== null) {
          return context.owns() ? failure('VERIFY_FAILED') : failure('LOCK_LOST');
        }
      } catch {
        return context.owns() ? failure('RECOVERY_REQUIRED') : failure('LOCK_LOST');
      }
      const committedState = readGenerationState(storage);
      if (
        !committedState.ok
        || committedState.value.generation !== generationAfter
        || committedState.value.epoch !== generation.value.epoch
      ) return committedState.ok ? failure('VERIFY_FAILED') : committedState;
      return {
        ok: true,
        removedUserKeys: recoveredUserKeys + 1 + emergency.value,
        repairedJournal,
        generation: generationAfter,
        token: Object.freeze({ ...committedState.value }),
      };
    }
    const forward = recoverClearLocked(storage, {
      kind: 'CLEAR_ALL',
      generationBefore: generation.value.generation,
      generationAfter,
      owner: context.owner,
    }, prepared, context);
    if (!forward.ok) return forward;
    const committedState = readGenerationState(storage);
    if (
      !committedState.ok
      || committedState.value.generation !== generationAfter
      || committedState.value.epoch !== generation.value.epoch
    ) return committedState.ok ? failure('VERIFY_FAILED') : committedState;
    return {
      ok: true,
      removedUserKeys: recoveredUserKeys + forward.value,
      repairedJournal,
      generation: generationAfter,
      token: Object.freeze({ ...committedState.value }),
    };
  }, options);
}
