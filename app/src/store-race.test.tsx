import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  start: vi.fn(),
  credentials: vi.fn(),
}));

vi.mock('./lib/binance-source', () => ({
  loadBinanceSnapshot: mocks.load,
  startBinanceSync: mocks.start,
  storeBinanceCredentials: mocks.credentials,
  safeRuntimeError: (error: unknown) => (
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'LOCAL_RUNTIME_UNAVAILABLE'
  ),
}));

import { StoreProvider, useStore } from './store';
import { AuthProvider } from './lib/auth-context';
import { WorkspaceProvider } from './lib/workspace-context';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const store = useStore();
  return (
    <div>
      <output aria-label="source">{store.session.source}</output>
      <output aria-label="phase">{store.session.phase}</output>
      <button type="button" onClick={() => void store.connectBinance('12345678', '12345678')}>connect</button>
      <button type="button" onClick={() => void store.syncBinance()}>sync</button>
      <button type="button" onClick={store.activateDemo}>demo</button>
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

describe('store data-source generations', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.load.mockReset();
    mocks.start.mockReset();
    mocks.credentials.mockReset();
  });

  it('discards a late credential response after the user returns to demo', async () => {
    const pending = deferred<void>();
    mocks.credentials.mockReturnValueOnce(pending.promise);
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_CONNECTING');
    fireEvent.click(screen.getByRole('button', { name: 'demo' }));
    pending.resolve();
    await act(async () => pending.promise);

    expect(screen.getByLabelText('source')).toHaveTextContent('demo');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('discards a late sync response after the user returns to demo', async () => {
    const pending = deferred<{ state: 'STARTED'; reasonCodes: readonly string[] }>();
    mocks.start.mockReturnValueOnce(pending.promise);
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'sync' }));
    expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_CONNECTING');
    fireEvent.click(screen.getByRole('button', { name: 'demo' }));
    pending.resolve({ state: 'STARTED', reasonCodes: [] });
    await act(async () => pending.promise);

    expect(screen.getByLabelText('source')).toHaveTextContent('demo');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('polls a first credential connection until the background sync is terminal', async () => {
    vi.useFakeTimers();
    try {
      mocks.credentials.mockResolvedValueOnce(undefined);
      mocks.load
        .mockResolvedValueOnce({
          runtime: { sync: { state: 'RUNNING' } },
          access: { phase: 'BINANCE_BROWSE_ONLY' },
          trades: [], records: [], bundle: null, reviewScope: null,
        })
        .mockResolvedValueOnce({
          runtime: { sync: { state: 'COMPLETED' } },
          access: { phase: 'BINANCE_BROWSE_ONLY' },
          trades: [], records: [], bundle: null, reviewScope: null,
        });
      renderStore();

      fireEvent.click(screen.getByRole('button', { name: 'connect' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_CONNECTING');
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });

      expect(mocks.credentials).toHaveBeenCalledTimes(1);
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_BROWSE_ONLY');
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits migration-required idle as a terminal review state', async () => {
    mocks.credentials.mockResolvedValueOnce(undefined);
    mocks.load.mockResolvedValueOnce({
      runtime: {
        phase: 'MIGRATION_REQUIRED',
        sync: { state: 'IDLE' },
      },
      access: { phase: 'BINANCE_BROWSE_ONLY' },
      trades: [], records: [], bundle: null, reviewScope: null,
    });
    renderStore();

    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_BROWSE_ONLY');
  });

  it('polls until the runtime leaves RUNNING and commits only the terminal snapshot', async () => {
    vi.useFakeTimers();
    try {
      mocks.start.mockResolvedValueOnce({ state: 'STARTED', reasonCodes: [] });
      mocks.load
        .mockResolvedValueOnce({
          runtime: { sync: { state: 'RUNNING' } },
          access: { phase: 'BINANCE_BROWSE_ONLY' },
        })
        .mockResolvedValueOnce({
          runtime: { sync: { state: 'COMPLETED' } },
          access: { phase: 'BINANCE_OBSERVED_READY' },
          trades: [], records: [], bundle: null, reviewScope: null,
        });
      renderStore();

      fireEvent.click(screen.getByRole('button', { name: 'sync' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_CONNECTING');
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });

      expect(mocks.load).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText('phase')).toHaveTextContent('BINANCE_OBSERVED_READY');
    } finally {
      vi.useRealTimers();
    }
  });
});
