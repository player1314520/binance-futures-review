import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RESTORE_LOCK_KEY,
  BROWSER_RESTORE_TRANSACTION_KEY,
  BROWSER_STORAGE_EPOCH_KEY,
  BROWSER_STORAGE_GENERATION_KEY,
  captureBrowserWriteToken,
  clearBrowserRestoreTransaction,
  clearBrowserUserData,
  commitBrowserRestoreTransaction,
  mutateBrowserWorkspace,
  recoverBrowserRestoreTransaction,
  type BrowserRestoreWebLocks,
  type BrowserRestoreReplacement,
} from './browser-restore-transaction';

const scope = 'csv-ledger-abcdef123456';
const replacements: readonly BrowserRestoreReplacement[] = [
  { key: `rv-review-v1:${scope}`, serialized: '{"new":"reviews"}' },
  { key: `rv-action-v1:${scope}`, serialized: '{"new":"actions"}' },
  { key: `rv-practice-v1:${scope}`, serialized: '{"new":"practice"}' },
];

const exclusiveWebLocks: BrowserRestoreWebLocks = {
  request: async (_name, _options, callback) => callback({ held: true }),
};

class CapacityStorage implements Storage {
  readonly #values = new Map<string, string>();
  failGenerationWrites = false;

  constructor(public capacity: number) {}

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    if (this.failGenerationWrites && normalizedKey === BROWSER_STORAGE_GENERATION_KEY) {
      throw new DOMException('simulated crash', 'SecurityError');
    }
    const candidate = new Map(this.#values);
    candidate.set(normalizedKey, normalizedValue);
    const used = [...candidate].reduce(
      (total, [entryKey, entryValue]) => total + entryKey.length + entryValue.length,
      0,
    );
    if (used > this.capacity) throw new DOMException('quota', 'QuotaExceededError');
    this.#values.set(normalizedKey, normalizedValue);
  }

  used(): number {
    return [...this.#values].reduce(
      (total, [entryKey, entryValue]) => total + entryKey.length + entryValue.length,
      0,
    );
  }
}

describe('browser restore transaction', () => {
  beforeEach(() => localStorage.clear());

  const fallback = (ownerId: string) => ({
    locks: null,
    ownerId,
    settle: async () => undefined,
    testOnlyAllowNonAtomicLease: true,
  }) as const;

  it.each([2, 3])('rolls every key back exactly when replacement write %s fails', async (failureAt) => {
    const previous = ['{"old":"reviews"}', '{"old":"actions"}', '{"old":"practice"}'];
    replacements.forEach(({ key }, index) => localStorage.setItem(key, previous[index]));
    const nativeSetItem = Storage.prototype.setItem;
    let replacementWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
      if (KEYS.has(String(key)) && String(value).includes('"new"')) {
        replacementWrites += 1;
        if (replacementWrites === failureAt) throw new DOMException('quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await expect(commitBrowserRestoreTransaction(replacements, fallback('rollback-owner'))).resolves.toBe(false);
    replacements.forEach(({ key }, index) => expect(localStorage.getItem(key)).toBe(previous[index]));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('recovers a PREPARED crash journal before a later restore', async () => {
    const entries = replacements.map(({ key }, index) => ({ key, previous: `old-${index}` }));
    replacements.forEach(({ key, serialized }) => localStorage.setItem(key, serialized));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, JSON.stringify({
      format: 'rv-browser-restore-transaction/1', status: 'PREPARED', entries,
    }));

    await expect(recoverBrowserRestoreTransaction(fallback('recovery-owner'))).resolves.toBe(true);
    entries.forEach(({ key, previous }) => expect(localStorage.getItem(key)).toBe(previous));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('commits all three scoped values and removes the local rollback journal', async () => {
    await expect(commitBrowserRestoreTransaction(replacements, fallback('commit-owner'))).resolves.toBe(true);
    replacements.forEach(({ key, serialized }) => expect(localStorage.getItem(key)).toBe(serialized));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
    expect(localStorage.getItem(BROWSER_RESTORE_LOCK_KEY)).toBeNull();
  });

  it('uses an injected Web Lock and fails closed when the exclusive lock is unavailable', async () => {
    const callbacks: string[] = [];
    const available: BrowserRestoreWebLocks = {
      request: async (name, options, callback) => {
        callbacks.push(`${name}:${options.mode}:${String(options.ifAvailable)}`);
        return callback({ name });
      },
    };
    await expect(commitBrowserRestoreTransaction(replacements, {
      locks: available, ownerId: 'web-lock-owner',
    })).resolves.toBe(true);
    expect(callbacks).toEqual(['rv-browser-restore-transaction:exclusive:true']);

    const unavailable: BrowserRestoreWebLocks = {
      request: async (_name, _options, callback) => callback(null),
    };
    await expect(commitBrowserRestoreTransaction(replacements.map((entry) => ({
      ...entry, serialized: '{"blocked":true}',
    })), { locks: unavailable, ownerId: 'blocked-owner' })).resolves.toBe(false);
    replacements.forEach(({ key, serialized }) => expect(localStorage.getItem(key)).toBe(serialized));
  });

  it('fails closed with LOCK_UNAVAILABLE unless the non-atomic test lease is explicit', async () => {
    const token = captureBrowserWriteToken()!;
    await expect(mutateBrowserWorkspace(scope, token, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), { locks: null, ownerId: 'no-lock-owner' })).resolves.toEqual({
      ok: false,
      code: 'LOCK_UNAVAILABLE',
    });
    await expect(clearBrowserUserData({ locks: null, ownerId: 'no-clear-lock-owner' })).resolves.toEqual({
      ok: false,
      code: 'LOCK_UNAVAILABLE',
    });
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
  });

  it('rejects a second fallback owner while the first owner holds an unexpired lease', async () => {
    let release!: () => void;
    let markClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { markClaimed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = commitBrowserRestoreTransaction(replacements, {
      locks: null,
      ownerId: 'first-tab-owner',
      testOnlyAllowNonAtomicLease: true,
      settle: async () => { markClaimed(); await gate; },
    });
    await claimed;
    await expect(commitBrowserRestoreTransaction(replacements, fallback('second-tab-owner'))).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(localStorage.getItem(BROWSER_RESTORE_LOCK_KEY)).toBeNull();
  });

  it('fails closed instead of overwriting an unverifiable fallback lock', async () => {
    localStorage.setItem(BROWSER_RESTORE_LOCK_KEY, '{corrupt-lock');
    await expect(commitBrowserRestoreTransaction(replacements, fallback('new-tab-owner'))).resolves.toBe(false);
    expect(localStorage.getItem(BROWSER_RESTORE_LOCK_KEY)).toBe('{corrupt-lock');
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
  });

  it('writes nothing when a newer file intent cancels the restore while lock acquisition settles', async () => {
    let release!: () => void;
    let markClaimed!: () => void;
    let current = true;
    const claimed = new Promise<void>((resolve) => { markClaimed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const committing = commitBrowserRestoreTransaction(replacements, {
      locks: null,
      ownerId: 'cancelled-tab-owner',
      testOnlyAllowNonAtomicLease: true,
      isCurrent: () => current,
      settle: async () => { markClaimed(); await gate; },
    });
    await claimed;
    current = false;
    release();

    await expect(committing).resolves.toBe(false);
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('never rolls back a newer successful transaction after ownership evidence changes', async () => {
    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;
    let winnerInstalled = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
      if (!winnerInstalled && KEYS.has(String(key)) && String(value).includes('"new"')) {
        winnerInstalled = true;
        replacements.forEach(({ key: target }) => nativeSetItem.call(this, target, '{"winner":true}'));
        nativeRemoveItem.call(this, BROWSER_RESTORE_TRANSACTION_KEY);
        return;
      }
      nativeSetItem.call(this, key, value);
    });

    await expect(commitBrowserRestoreTransaction(replacements, fallback('stale-tab-owner'))).resolves.toBe(false);
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBe('{"winner":true}'));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('clears only a damaged transaction journal so readiness can be retried safely', async () => {
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `keep-${index}`));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, '{not-json');
    localStorage.setItem('unrelated', 'keep');

    await expect(recoverBrowserRestoreTransaction(fallback('bad-journal-owner'))).resolves.toBe(false);
    await expect(clearBrowserRestoreTransaction(fallback('repair-owner'))).resolves.toBe(true);
    await expect(recoverBrowserRestoreTransaction(fallback('retry-owner'))).resolves.toBe(true);
    replacements.forEach(({ key }, index) => expect(localStorage.getItem(key)).toBe(`keep-${index}`));
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('runs the builder under the lock against the latest committed three-family state', async () => {
    replacements.forEach(({ key }, index) => localStorage.setItem(key, JSON.stringify({ version: index })));
    const token = captureBrowserWriteToken();
    expect(token).toEqual({ generation: 0, epoch: 'legacy-v1' });

    const first = await mutateBrowserWorkspace(scope, token!, ({ latest }) => ({
      next: {
        reviews: '{"version":"first"}',
        actions: latest.actions!,
        practice: latest.practice!,
      },
      value: 'first-value',
    }), fallback('builder-first-owner'));
    expect(first).toMatchObject({ ok: true, value: 'first-value', generation: 0 });

    let observed: string | null = null;
    const second = await mutateBrowserWorkspace(scope, token!, ({ latest }) => {
      observed = latest.reviews;
      return {
        next: {
          reviews: latest.reviews!,
          actions: '{"version":"second"}',
          practice: latest.practice!,
        },
        value: 2,
      };
    }, fallback('builder-second-owner'));
    expect(second).toMatchObject({ ok: true, value: 2, generation: 0 });
    expect(observed).toBe('{"version":"first"}');
    expect(localStorage.getItem(replacements[1].key)).toBe('{"version":"second"}');
  });

  it('rejects a token captured before clear and accepts a freshly captured token', async () => {
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"before":true}'));
    const stale = captureBrowserWriteToken()!;
    await expect(clearBrowserUserData(fallback('generation-clear-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      generation: 1,
    });

    const oldWrite = await mutateBrowserWorkspace(scope, stale, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' },
      value: null,
    }), fallback('generation-stale-owner'));
    expect(oldWrite).toEqual({ ok: false, code: 'STALE_AFTER_CLEAR' });
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());

    const fresh = captureBrowserWriteToken()!;
    expect(fresh).toEqual({ generation: 1, epoch: 'legacy-v1' });
    const newWrite = await mutateBrowserWorkspace(scope, fresh, () => ({
      next: {
        reviews: '{"after":1}', actions: '{"after":2}', practice: '{"after":3}',
      },
      value: 'saved',
    }), fallback('generation-fresh-owner'));
    expect(newWrite).toMatchObject({ ok: true, value: 'saved', generation: 1 });
    expect(localStorage.getItem(replacements[0].key)).toBe('{"after":1}');
  });

  it('returns LOCK_BUSY when clear already owns the fallback lease', async () => {
    let release!: () => void;
    let claimed!: () => void;
    const acquired = new Promise<void>((resolve) => { claimed = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clearing = clearBrowserUserData({
      locks: null,
      ownerId: 'clear-first-owner',
      testOnlyAllowNonAtomicLease: true,
      settle: async () => { claimed(); await gate; },
    });
    await acquired;
    await expect(clearBrowserUserData(fallback('clear-second-owner'))).resolves.toEqual({
      ok: false,
      code: 'LOCK_BUSY',
    });
    release();
    await expect(clearing).resolves.toMatchObject({ ok: true });
  });

  it('continues a crashed compact CLEAR_ALL journal forward during recovery', async () => {
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `clear-${index}`));
    localStorage.setItem('rv2-session', 'legacy');
    const nativeRemoveItem = Storage.prototype.removeItem;
    const crashKey = replacements[2].key;
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function removeItem(
      this: Storage,
      key,
    ) {
      if (String(key) === crashKey) throw new DOMException('crash', 'UnknownError');
      return nativeRemoveItem.call(this, key);
    });

    await expect(clearBrowserUserData(fallback('clear-crash-owner'))).resolves.toEqual({
      ok: false,
      code: 'RECOVERY_REQUIRED',
    });
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).not.toBeNull();
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    removeSpy.mockRestore();

    await expect(recoverBrowserRestoreTransaction(fallback('clear-recover-owner'))).resolves.toBe(true);
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
    expect(localStorage.getItem('rv2-session')).toBeNull();
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
  });

  it('retries an interrupted CLEAR_ALL directly with the recovered count and no extra generation', async () => {
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `retry-${index}`));
    localStorage.setItem('rv2-session', 'retry-legacy');
    const nativeRemoveItem = Storage.prototype.removeItem;
    const crashKey = replacements[2].key;
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function removeItem(
      this: Storage,
      key,
    ) {
      if (String(key) === crashKey) throw new DOMException('crash', 'UnknownError');
      return nativeRemoveItem.call(this, key);
    });
    await expect(clearBrowserUserData(fallback('retry-crash-owner'))).resolves.toEqual({
      ok: false,
      code: 'RECOVERY_REQUIRED',
    });
    removeSpy.mockRestore();
    const remainingBeforeRetry = [...replacements.map(({ key }) => key), 'rv2-session']
      .filter((key) => localStorage.getItem(key) !== null).length;
    expect(remainingBeforeRetry).toBeGreaterThan(0);

    await expect(clearBrowserUserData(fallback('retry-clear-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: remainingBeforeRetry,
      repairedJournal: true,
      generation: 1,
    });
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('recovers the previous key-list v3 CLEAR format for upgrade compatibility', async () => {
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `v3-${index}`));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, JSON.stringify({
      format: 'rv-browser-storage-transaction/3',
      kind: 'CLEAR',
      status: 'PREPARED',
      owner: 'legacy-v3-owner',
      transactionId: 'legacy-v3-transaction',
      leaseExpiresAt: 12345,
      generationBefore: 0,
      generationAfter: 1,
      keys: replacements.map(({ key }) => key),
    }));

    await expect(recoverBrowserRestoreTransaction(fallback('v3-recover-owner'))).resolves.toBe(true);
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('frees one authorized user item when a full storage cannot initially fit the compact journal', async () => {
    const storage = new CapacityStorage(10_000);
    replacements.forEach(({ key }, index) => storage.setItem(key, `${index}-${'x'.repeat(500)}`));
    storage.setItem('unrelated', 'keep');
    storage.capacity = storage.used() + 80;
    const stale = captureBrowserWriteToken(storage)!;

    await expect(clearBrowserUserData({
      storage,
      locks: exclusiveWebLocks,
      ownerId: 'quota-clear-owner',
    })).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      repairedJournal: false,
      generation: 1,
    });
    replacements.forEach(({ key }) => expect(storage.getItem(key)).toBeNull());
    expect(storage.getItem('unrelated')).toBe('keep');
    expect(storage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
    expect(storage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    await expect(mutateBrowserWorkspace(scope, stale, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), {
      storage,
      locks: exclusiveWebLocks,
      ownerId: 'quota-stale-owner',
    })).resolves.toEqual({ ok: false, code: 'STALE_AFTER_CLEAR' });
  });

  it('does not alter any user or metadata value when setItem fails with SecurityError', async () => {
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"private":true}'));
    localStorage.setItem('unrelated', 'keep');
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, '7');
    const baseline = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
    ) {
      throw new DOMException('storage denied', 'SecurityError');
    });

    await expect(clearBrowserUserData({
      locks: exclusiveWebLocks,
      ownerId: 'security-fault-owner',
    })).resolves.toEqual({ ok: false, code: 'STORAGE_FAILED' });
    setSpy.mockRestore();
    const after = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    expect(after).toEqual(baseline);
  });

  it('treats an in-place emergency marker as a fence and excludes its key from retry count', async () => {
    const storage = new CapacityStorage(10_000);
    replacements.forEach(({ key }, index) => storage.setItem(key, `${index}-${'z'.repeat(500)}`));
    storage.capacity = storage.used() + 80;
    storage.failGenerationWrites = true;
    const stale = captureBrowserWriteToken(storage)!;

    await expect(clearBrowserUserData({
      storage,
      locks: exclusiveWebLocks,
      ownerId: 'marker-crash-owner',
    })).resolves.toEqual({ ok: false, code: 'STORAGE_FAILED' });
    expect(storage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBeNull();
    const markerKeys = replacements
      .map(({ key }) => key)
      .filter((key) => storage.getItem(key)?.startsWith('!rv-clear-all/1|'));
    expect(markerKeys).toHaveLength(1);
    expect(captureBrowserWriteToken(storage)).toEqual({ generation: 1, epoch: 'legacy-v1' });

    storage.failGenerationWrites = false;
    await expect(clearBrowserUserData({
      storage,
      locks: exclusiveWebLocks,
      ownerId: 'marker-retry-owner',
    })).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 2,
      repairedJournal: false,
      generation: 1,
    });
    expect(storage.getItem(markerKeys[0])).toBeNull();
    await expect(mutateBrowserWorkspace(scope, stale, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), {
      storage,
      locks: exclusiveWebLocks,
      ownerId: 'marker-stale-owner',
    })).resolves.toEqual({ ok: false, code: 'STALE_AFTER_CLEAR' });
  });

  it('treats the compact journal as a fence before the primary generation write', async () => {
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"private":true}'));
    const nativeSetItem = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (String(key) === BROWSER_STORAGE_GENERATION_KEY) {
        throw new DOMException('generation denied', 'SecurityError');
      }
      return nativeSetItem.call(this, key, value);
    });
    const stale = captureBrowserWriteToken()!;

    await expect(clearBrowserUserData(fallback('journal-fence-owner'))).resolves.toEqual({
      ok: false,
      code: 'STORAGE_FAILED',
    });
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBeNull();
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).not.toBeNull();
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBe('{"private":true}'));
    expect(captureBrowserWriteToken()).toEqual({ generation: 1, epoch: 'legacy-v1' });
    setSpy.mockRestore();

    await expect(clearBrowserUserData(fallback('journal-fence-retry-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      repairedJournal: true,
      generation: 1,
    });
    await expect(mutateBrowserWorkspace(scope, stale, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), fallback('journal-fence-stale-owner'))).resolves.toEqual({
      ok: false,
      code: 'STALE_AFTER_CLEAR',
    });
  });

  it('frees an authorized user item when the generation barrier is quota-blocked after journal install', async () => {
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"private":true}'));
    const nativeSetItem = Storage.prototype.setItem;
    let blocked = 0;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (blocked < 2 && String(key) === BROWSER_STORAGE_GENERATION_KEY) {
        blocked += 1;
        throw new DOMException('generation quota', 'QuotaExceededError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await expect(clearBrowserUserData(fallback('generation-quota-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      repairedJournal: false,
      generation: 1,
    });
    setSpy.mockRestore();
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
  });

  it('clears every user-data family across scopes with an exact count and preserves unrelated keys', async () => {
    for (const candidateScope of ['scope-one', 'scope-two']) {
      for (const family of ['review', 'action', 'practice']) {
        localStorage.setItem(`rv-${family}-v1:${candidateScope}`, `${family}:${candidateScope}`);
      }
    }
    localStorage.setItem('rv2-session', 'legacy');
    localStorage.setItem('rv-unrelated-v1:scope-one', 'keep');
    localStorage.setItem('unrelated', 'keep-too');

    await expect(clearBrowserUserData(fallback('clear-count-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 7,
      repairedJournal: false,
      generation: 1,
    });
    expect(localStorage.getItem('rv-unrelated-v1:scope-one')).toBe('keep');
    expect(localStorage.getItem('unrelated')).toBe('keep-too');
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
  });

  it('continues to recover a valid v2 replacement journal', async () => {
    const entries = replacements.map(({ key }, index) => ({ key, previous: `v2-old-${index}` }));
    replacements.forEach(({ key }) => localStorage.setItem(key, 'v2-new'));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, JSON.stringify({
      format: 'rv-browser-restore-transaction/2',
      status: 'PREPARED',
      owner: 'legacy-v2-owner',
      transactionId: 'legacy-v2-transaction',
      leaseExpiresAt: 12345,
      entries,
    }));

    await expect(recoverBrowserRestoreTransaction(fallback('v2-recover-owner'))).resolves.toBe(true);
    entries.forEach(({ key, previous }) => expect(localStorage.getItem(key)).toBe(previous));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
  });

  it('distinguishes damaged lock and damaged journal failures without changing user data', async () => {
    const token = captureBrowserWriteToken()!;
    localStorage.setItem(BROWSER_RESTORE_LOCK_KEY, '{bad-lock');
    await expect(mutateBrowserWorkspace(scope, token, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), fallback('damaged-lock-owner'))).resolves.toEqual({ ok: false, code: 'LOCK_DAMAGED' });
    localStorage.removeItem(BROWSER_RESTORE_LOCK_KEY);
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, '{bad-journal');
    await expect(mutateBrowserWorkspace(scope, token, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), fallback('damaged-journal-owner'))).resolves.toEqual({ ok: false, code: 'JOURNAL_DAMAGED' });
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBe('{bad-journal');
  });

  it('lets only the explicit user-data clear repair a damaged journal', async () => {
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"private":true}'));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, '{bad-journal');

    await expect(clearBrowserUserData(fallback('damaged-clear-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      repairedJournal: true,
      generation: 1,
    });
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
  });

  it('repairs a malformed generation with an opaque epoch and keeps every old token stale', async () => {
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, '5');
    const stale = captureBrowserWriteToken()!;
    expect(stale).toEqual({ generation: 5, epoch: 'legacy-v1' });
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, '{malformed');
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"private":true}'));

    const repaired = await clearBrowserUserData(fallback('generation-repair-owner'));
    expect(repaired).toMatchObject({
      ok: true,
      removedUserKeys: 3,
      generation: 0,
    });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected repair success');
    expect(repaired.token.epoch).not.toBe('legacy-v1');
    expect(repaired.token).toEqual(captureBrowserWriteToken());
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('0');
    expect(localStorage.getItem(BROWSER_STORAGE_EPOCH_KEY)).toBe(repaired.token.epoch);
    await expect(mutateBrowserWorkspace(scope, stale, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), fallback('generation-repair-stale-owner'))).resolves.toEqual({
      ok: false,
      code: 'STALE_AFTER_CLEAR',
    });

    const fresh = captureBrowserWriteToken()!;
    await expect(mutateBrowserWorkspace(scope, fresh, () => ({
      next: { reviews: '{"fresh":1}', actions: '{"fresh":2}', practice: '{"fresh":3}' },
      value: 'fresh',
    }), fallback('generation-repair-fresh-owner'))).resolves.toMatchObject({
      ok: true,
      value: 'fresh',
      token: fresh,
    });
    const secondClear = await clearBrowserUserData(fallback('generation-repair-second-clear-owner'));
    expect(secondClear).toMatchObject({ ok: true, removedUserKeys: 3, generation: 1 });
    expect(secondClear.ok).toBe(true);
    if (!secondClear.ok) throw new Error('expected second clear success');
    expect(secondClear.token.epoch).toBe(fresh.epoch);
  });

  it('does not delete user data when a malformed-generation repair fence cannot persist', async () => {
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, 'not-a-generation');
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `baseline-${index}`));
    localStorage.setItem('unrelated', 'keep');
    const baseline = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    const nativeSetItem = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (String(key) === BROWSER_RESTORE_TRANSACTION_KEY) {
        throw new DOMException('repair denied', 'SecurityError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await expect(clearBrowserUserData({
      locks: exclusiveWebLocks,
      ownerId: 'generation-repair-denied-owner',
    })).resolves.toEqual({ ok: false, code: 'STORAGE_FAILED' });
    setSpy.mockRestore();
    const after = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    expect(after).toEqual(baseline);
  });

  it('keeps the opaque repair journal as a fence when epoch persistence fails', async () => {
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, 'broken');
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `private-${index}`));
    const nativeSetItem = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (String(key) === BROWSER_STORAGE_EPOCH_KEY) {
        throw new DOMException('epoch denied', 'SecurityError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await expect(clearBrowserUserData(fallback('generation-epoch-fault-owner'))).resolves.toEqual({
      ok: false,
      code: 'STORAGE_FAILED',
    });
    replacements.forEach(({ key }, index) => expect(localStorage.getItem(key)).toBe(`private-${index}`));
    const fenced = captureBrowserWriteToken();
    expect(fenced?.generation).toBe(0);
    expect(fenced?.epoch).not.toBe('legacy-v1');
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).not.toBeNull();
    setSpy.mockRestore();

    await expect(clearBrowserUserData(fallback('generation-epoch-retry-owner'))).resolves.toMatchObject({
      ok: true,
      removedUserKeys: 3,
      generation: 0,
      token: fenced,
    });
  });

  it('advances MAX-1 normally then repairs MAX with a fresh opaque epoch', async () => {
    const max = Number.MAX_SAFE_INTEGER;
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(max - 1));
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"beforeMax":true}'));

    const atMax = await clearBrowserUserData(fallback('max-normal-clear-owner'));
    expect(atMax).toMatchObject({ ok: true, removedUserKeys: 3, generation: max });
    expect(atMax.ok).toBe(true);
    if (!atMax.ok) throw new Error('expected max clear success');
    expect(atMax.token).toEqual({ generation: max, epoch: 'legacy-v1' });
    replacements.forEach(({ key }) => localStorage.setItem(key, '{"atMax":true}'));
    const staleMax = captureBrowserWriteToken()!;

    const repaired = await clearBrowserUserData(fallback('max-repair-clear-owner'));
    expect(repaired).toMatchObject({ ok: true, removedUserKeys: 3, generation: 0 });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected max repair success');
    expect(repaired.token.epoch).not.toBe(staleMax.epoch);
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('0');
    await expect(mutateBrowserWorkspace(scope, staleMax, () => ({
      next: { reviews: '{}', actions: '{}', practice: '{}' }, value: null,
    }), fallback('max-stale-owner'))).resolves.toEqual({
      ok: false,
      code: 'STALE_AFTER_CLEAR',
    });

    const fresh = captureBrowserWriteToken()!;
    await expect(mutateBrowserWorkspace(scope, fresh, () => ({
      next: { reviews: '{"new":1}', actions: '{"new":2}', practice: '{"new":3}' },
      value: 'saved',
    }), fallback('max-fresh-write-owner'))).resolves.toMatchObject({
      ok: true,
      value: 'saved',
      token: fresh,
    });
    const nextClear = await clearBrowserUserData(fallback('max-next-clear-owner'));
    expect(nextClear).toMatchObject({ ok: true, removedUserKeys: 3, generation: 1 });
    expect(nextClear.ok).toBe(true);
    if (!nextClear.ok) throw new Error('expected post-repair clear success');
    expect(nextClear.token.epoch).toBe(fresh.epoch);
  });

  it('does not delete max-generation data when the opaque repair fence gets SecurityError', async () => {
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, String(Number.MAX_SAFE_INTEGER));
    replacements.forEach(({ key }, index) => localStorage.setItem(key, `max-baseline-${index}`));
    const baseline = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    const nativeSetItem = Storage.prototype.setItem;
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (String(key) === BROWSER_RESTORE_TRANSACTION_KEY) {
        throw new DOMException('max repair denied', 'SecurityError');
      }
      return nativeSetItem.call(this, key, value);
    });

    await expect(clearBrowserUserData({
      locks: exclusiveWebLocks,
      ownerId: 'max-repair-denied-owner',
    })).resolves.toEqual({ ok: false, code: 'STORAGE_FAILED' });
    setSpy.mockRestore();
    const after = [...Array(localStorage.length).keys()]
      .map((index) => localStorage.key(index)!)
      .sort()
      .map((key) => [key, localStorage.getItem(key)] as const);
    expect(after).toEqual(baseline);
  });

  it('fails with LOCK_LOST when an async builder outlives its fallback lease', async () => {
    let now = 0;
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const token = captureBrowserWriteToken()!;
    const writing = mutateBrowserWorkspace(scope, token, async () => {
      entered();
      await gate;
      return {
        next: { reviews: '{"late":1}', actions: '{}', practice: '{}' },
        value: null,
      };
    }, {
      locks: null,
      ownerId: 'async-lease-owner',
      testOnlyAllowNonAtomicLease: true,
      now: () => now,
      leaseMs: 1_000,
      settle: async () => undefined,
    });
    await inside;
    now = 1_001;
    release();

    await expect(writing).resolves.toEqual({ ok: false, code: 'LOCK_LOST' });
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
  });

  it('rechecks generation after an async builder before committing', async () => {
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locks: BrowserRestoreWebLocks = {
      request: async (_name, _options, callback) => callback({ held: true }),
    };
    const token = captureBrowserWriteToken()!;
    const writing = mutateBrowserWorkspace(scope, token, async () => {
      entered();
      await gate;
      return {
        next: { reviews: '{"stale":1}', actions: '{}', practice: '{}' },
        value: null,
      };
    }, { locks, ownerId: 'async-generation-owner' });
    await inside;
    localStorage.setItem(BROWSER_STORAGE_GENERATION_KEY, '1');
    release();

    await expect(writing).resolves.toEqual({ ok: false, code: 'STALE_AFTER_CLEAR' });
    replacements.forEach(({ key }) => expect(localStorage.getItem(key)).toBeNull());
  });
});

const KEYS = new Set(replacements.map(({ key }) => key));
