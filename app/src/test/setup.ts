import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

const heldBrowserLocks = new Set<string>();
const browserLocks = {
  async request<T>(
    name: string,
    _options: Readonly<{ mode: 'exclusive'; ifAvailable: true }>,
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (heldBrowserLocks.has(name)) return callback(null);
    heldBrowserLocks.add(name);
    try {
      return await callback({ name });
    } finally {
      heldBrowserLocks.delete(name);
    }
  },
};

// jsdom does not implement the Web Locks API. Application tests model a
// supported production browser with the same ifAvailable behavior; explicit
// unsupported-browser cases pass `locks: null` directly to the coordinator.
const testNavigator = Object.create(navigator) as Navigator & { locks: typeof browserLocks };
Object.defineProperty(testNavigator, 'locks', { value: browserLocks });
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: testNavigator,
});

afterEach(() => {
  cleanup();
  heldBrowserLocks.clear();
  localStorage.clear();
  window.location.hash = '';
});
