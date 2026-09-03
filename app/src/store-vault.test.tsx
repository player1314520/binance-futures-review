import React, { useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { enrichTrades, exportArchive, parseStatement } from '@rv/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthRuntime } from './lib/auth-context';
import { saveAuthSession } from './lib/auth-session-storage';
import {
  MemoryVaultBackend,
  MemoryVaultRepository,
  VaultRepositoryError,
  type PublishVaultHeadInput,
  type VaultHead,
  type VaultOperationOptions,
} from './lib/vault-repository';
import { WorkspaceProvider, useWorkspace } from './lib/workspace-context';
import { sessionArchive, StoreProvider, useStore } from './store';
import { createPortableBackup } from './lib/portable-backup';
import type { JsonValue } from './lib/canonical-json';
import * as fillLedger from './lib/csv-fill-ledger';
import * as binanceSource from './lib/binance-source';
import {
  BROWSER_RESTORE_TRANSACTION_KEY,
  BROWSER_STORAGE_GENERATION_KEY,
  clearBrowserUserData,
} from './lib/browser-restore-transaction';
import * as legacyMigration from './lib/legacy-review-migration';

const CSV = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,0
2026-06-01 10:00:00,BTCUSDT,SELL,68600,0.01,686,0.27,6`;
const CSV_OPEN = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-07-01 09:00:00,ETHUSDT,BUY,3000,0.10,300,0.12,0`;
const CSV_CLOSE = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-07-01 10:00:00,ETHUSDT,SELL,3050,0.10,305,0.12,5`;

const session = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId: 'alice',
  email: 'alice@example.com',
} as const;

const authRuntime: AuthRuntime = {
  config: {
    supabaseUrl: 'https://project.supabase.co',
    publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
  },
  invalidMessage: null,
  client: {
    sendEmailOtp: vi.fn(async () => undefined),
    verifyEmailOtp: vi.fn(async () => session),
    refresh: vi.fn(async () => session),
    signOut: vi.fn(async () => undefined),
  },
};

const CRYPTO_STATE_TIMEOUT_MS = 25_000;
let browserWebLockForcedBusy = false;
let browserWebLockAfterRelease: (() => void | Promise<void>) | null = null;

function installBrowserWebLocksMock(): void {
  let held = false;
  const locks = {
    async request<T>(
      _name: string,
      _options: Readonly<{ mode: 'exclusive'; ifAvailable: true }>,
      callback: (lock: unknown | null) => T | PromiseLike<T>,
    ): Promise<T> {
      if (browserWebLockForcedBusy || held) return callback(null);
      held = true;
      let result!: T;
      try {
        result = await callback({});
      } finally {
        held = false;
      }
      const afterRelease = browserWebLockAfterRelease;
      browserWebLockAfterRelease = null;
      if (afterRelease) await afterRelease();
      return result;
    },
  };
  const testNavigator = Object.create(navigator) as Navigator & { locks: typeof locks };
  Object.defineProperty(testNavigator, 'locks', { value: locks });
  vi.stubGlobal('navigator', testNavigator);
}

function waitForWorkspacePhase(phase: string) {
  return waitFor(
    () => expect(screen.getByTestId('phase')).toHaveTextContent(phase),
    { timeout: CRYPTO_STATE_TIMEOUT_MS },
  );
}

function waitForWorkspaceGeneration(generation: number) {
  return waitFor(
    () => expect(screen.getByTestId('generation')).toHaveTextContent(String(generation)),
    { timeout: CRYPTO_STATE_TIMEOUT_MS },
  );
}

function Harness({
  initialFupan = '',
  initialBackup = '',
}: { initialFupan?: string; initialBackup?: string }) {
  const workspace = useWorkspace();
  const store = useStore();
  const [code, setCode] = useState('');
  const [importRuns, setImportRuns] = useState(0);
  const [backup, setBackup] = useState(initialBackup);
  const [mutationResult, setMutationResult] = useState('idle');
  const [mutationSuccesses, setMutationSuccesses] = useState(0);
  const [restoreResult, setRestoreResult] = useState('idle');
  const [clearResult, setClearResult] = useState('idle');
  const [queuedImportResults, setQueuedImportResults] = useState('idle');
  const [ledgerError, setLedgerError] = useState('none');
  const [fupan, setFupan] = useState(initialFupan);
  const [migrationResult, setMigrationResult] = useState('idle');
  const result = parseStatement(CSV, null);
  if (result.error !== undefined) throw new Error(result.error);
  const openResult = parseStatement(CSV_OPEN, null);
  const closeResult = parseStatement(CSV_CLOSE, null);
  if (openResult.error !== undefined || closeResult.error !== undefined) throw new Error('fixture');

  return (
    <div>
      <span data-testid="phase">{workspace.phase}</span>
      <span data-testid="generation">{workspace.unlocked?.generation ?? 0}</span>
      <span data-testid="workspace-id">{workspace.unlocked?.workspace.workspaceId ?? 'none'}</span>
      <span data-testid="kit">{workspace.recoveryKit?.recoveryCode ?? ''}</span>
      <span data-testid="source">{store.session.source}</span>
      <span data-testid="persistence">{store.session.persistence}</span>
      <span data-testid="session-phase">{store.session.phase}</span>
      <span data-testid="trade-count">{store.session.trades.length}</span>
      <span data-testid="first-trade-id">{store.session.trades[0]?.id ?? 'none'}</span>
      <span data-testid="review-scope">{store.session.reviewScope ?? 'none'}</span>
      <span data-testid="review-count">{Object.keys(store.session.reviews).length}</span>
      <span data-testid="review-updated">
        {Object.values(store.session.reviews)[0]?.updatedAt ?? 0}
      </span>
      <span data-testid="review-lesson">
        {Object.values(store.session.reviews)[0]?.lesson ?? 'none'}
      </span>
      <span data-testid="review-map-prototype">
        {Object.getPrototypeOf(store.session.reviews) === null ? 'null' : 'object'}
      </span>
      <span data-testid="action-map-prototype">
        {Object.getPrototypeOf(store.session.actions) === null ? 'null' : 'object'}
      </span>
      <span data-testid="ledger-fills">{store.session.csvLedger?.fills.length ?? 0}</span>
      <span data-testid="action-status">
        {Object.values(store.session.actions)[0]?.status ?? 'none'}
      </span>
      <span data-testid="action-updated">
        {Object.values(store.session.actions)[0]?.updatedAt ?? 0}
      </span>
      <span data-testid="experiment-decision">
        {Object.values(store.session.actions)[0]?.experiment?.decision ?? 'none'}
      </span>
      <span data-testid="experiment-observed">
        {Object.values(store.session.actions)[0]?.experiment?.observedCount ?? 0}
      </span>
      <span data-testid="import-runs">{importRuns}</span>
      <span data-testid="journal-count">{store.session.journal.length}</span>
      <span data-testid="guard-count">{store.session.guards.length}</span>
      <span data-testid="guard-active">
        {store.session.guards[0]?.active === undefined
          ? 'none' : store.session.guards[0].active ? 'yes' : 'no'}
      </span>
      <span data-testid="error-code">{store.session.errorCode ?? 'none'}</span>
      <span data-testid="mutation-result">{mutationResult}</span>
      <span data-testid="mutation-successes">{mutationSuccesses}</span>
      <span data-testid="restore-result">{restoreResult}</span>
      <span data-testid="clear-result">{clearResult}</span>
      <span data-testid="queued-import-results">{queuedImportResults}</span>
      <span data-testid="ledger-error">{ledgerError}</span>
      <span data-testid="fupan-ready">{fupan ? 'yes' : 'no'}</span>
      <span data-testid="migration-result">{migrationResult}</span>
      <button type="button" onClick={() => void workspace.createWorkspace()}>create</button>
      <button type="button" onClick={workspace.dismissRecoveryKit}>ack recovery</button>
      <button
        type="button"
        onClick={() => void store.setImported(enrichTrades([...result.trades]), result.meta, {
          contract: result.contract,
          diagnostics: [...result.diagnostics],
        }, result.fills).then(() => setImportRuns((value) => value + 1))}
      >import</button>
      <button type="button" onClick={() => {
        void Promise.all([
          store.setImported(enrichTrades([...result.trades]), result.meta, {
            contract: result.contract,
            diagnostics: [...result.diagnostics],
          }, result.fills),
          store.setImported(enrichTrades([...result.trades]), result.meta, {
            contract: result.contract,
            diagnostics: [...result.diagnostics],
          }, result.fills),
        ].map((operation) => operation.catch(() => false)))
          .then((outcomes) => setQueuedImportResults(outcomes.join(',')));
      }}>queue duplicate imports</button>
      <button type="button" onClick={() => void store.setImported(enrichTrades([...result.trades]), result.meta, {
        contract: result.contract,
        diagnostics: [...result.diagnostics],
      })}>import legacy archive</button>
      <button type="button" onClick={() => void store.setImported(enrichTrades([...result.trades]), result.meta, {
        contract: result.contract,
        diagnostics: [...result.diagnostics],
      }, result.fills).catch((error) => setLedgerError(error instanceof Error ? error.message : 'unknown'))}>increment legacy</button>
      <button type="button" onClick={() => void store.setImported([], openResult.meta, {
        contract: openResult.contract,
        diagnostics: [...openResult.diagnostics],
      }, openResult.fills)}>import open</button>
      <button type="button" onClick={() => void store.setImported(enrichTrades([...closeResult.trades]), closeResult.meta, {
        contract: closeResult.contract,
        diagnostics: [...closeResult.diagnostics],
      }, closeResult.fills)}>import close</button>
      <button
        type="button"
        onClick={() => {
          setMutationResult('pending');
          void Promise.resolve(store.saveTradeReview(store.session.trades[0]?.id ?? '', {
            saw: '到达计划区',
            happened: '按计划成交',
            lesson: '下一笔先写失效条件',
            grade: 'A',
            reviewed: true,
          })).then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
        }}
      >review</button>
      <button
        type="button"
        onClick={() => {
          const actionId = Object.keys(store.session.actions)[0];
          if (!actionId) return;
          setMutationResult('pending');
          void store.setActionStatus(actionId, 'done')
            .then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
        }}
      >complete</button>
      <button type="button" onClick={() => {
        const actionId = Object.keys(store.session.actions)[0];
        if (!actionId) return;
        setMutationResult('pending');
        void store.setActionExperiment(actionId, {
          hypothesis: '先写失效条件能提高动作执行率',
          targetCount: 1,
          windowStart: '2026-08-29',
          windowEnd: '2026-09-05',
          successCriterion: 1,
        }).then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>configure experiment</button>
      <button type="button" onClick={() => {
        const actionId = Object.keys(store.session.actions)[0];
        if (!actionId) return;
        setMutationResult('pending');
        void store.recordActionExperimentObservation(actionId, {
          day: '2026-08-30', followed: true, evidenceNote: 'trade-2 已在复盘中记录执行步骤',
        }).then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>observe experiment</button>
      <button type="button" onClick={() => {
        const actionId = Object.keys(store.session.actions)[0];
        if (!actionId) return;
        setMutationResult('pending');
        void store.decideActionExperiment(actionId, 'revise', '1/1 次执行，但需缩小动作后重测。')
          .then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>revise experiment</button>
      <button type="button" onClick={() => {
        const actionId = Object.keys(store.session.actions)[0];
        if (!actionId) return;
        setMutationResult('pending');
        void store.decideActionExperiment(actionId, 'adopt', '1/1 次按计划执行，保留动作。')
          .then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>adopt experiment</button>
      <button type="button" onClick={() => {
        void (async () => {
          const reviewScope = store.session.reviewScope;
          const tradeIds = store.session.trades.map((trade) => String(trade.id));
          if (!reviewScope || tradeIds.length === 0) {
            setMigrationResult('cancelled');
            return;
          }
          const unbound = await legacyMigration.parseLegacyReviewExport({
            format: 'rv-classic-review-export/1',
            reviews: tradeIds.map((tradeId) => ({
              tradeId,
              saw: '回踩支撑',
              did: '按计划执行',
              learn: '迁移后等待下一次确认',
              grade: 'B',
              reviewed: true,
            })),
            riskLimits: null,
          });
          const bound = await legacyMigration.bindLegacyReviewMigrationPlan(unbound, {
            reviewScope,
            currentTradeIds: tradeIds,
          });
          const receipt = await store.applyLegacyReviewMigration(bound, tradeIds);
          setMigrationResult(receipt
            ? `${receipt.insertedCount}/${receipt.skippedExistingCount}`
            : 'cancelled');
        })();
      }}>migrate classic</button>
      <button type="button" onClick={() => {
        void (async () => {
          const reviewScope = store.session.reviewScope;
          const tradeIds = store.session.trades.map((trade) => String(trade.id));
          if (!reviewScope || tradeIds.length === 0) {
            setMigrationResult('cancelled');
            return;
          }
          const unbound = await legacyMigration.parseLegacyReviewExport({
            format: 'rv-classic-review-export/1',
            reviews: [{
              tradeId: tradeIds[0], saw: '旧观察', did: '旧执行', learn: '旧教训',
              grade: 'C', reviewed: true,
            }],
            riskLimits: null,
          });
          const stale = await legacyMigration.bindLegacyReviewMigrationPlan(unbound, {
            reviewScope,
            currentTradeIds: [...tradeIds, 'different-trade-set'],
          });
          const receipt = await store.applyLegacyReviewMigration(stale, [tradeIds[0]]);
          setMigrationResult(receipt ? 'unexpected' : 'cancelled');
        })();
      }}>migrate stale classic</button>
      <button type="button" onClick={workspace.lockWorkspace}>lock</button>
      <button type="button" onClick={() => {
        setMutationResult('pending');
        void store.saveJournal('2026-08-28', '等到计划区', '冷静')
          .then((saved) => {
            setMutationResult(saved ? 'saved' : 'failed');
            if (saved) setMutationSuccesses((value) => value + 1);
          });
      }}>journal</button>
      <button type="button" onClick={() => {
        void store.saveJournal('2026-08-29', '继续等待确认', '专注')
          .then((saved) => {
            if (saved) setMutationSuccesses((value) => value + 1);
          });
      }}>journal next day</button>
      <button type="button" onClick={() => {
        setMutationResult('pending');
        void store.saveGuard('连续亏损 3 笔后停止当天交易')
          .then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>guard</button>
      <button type="button" onClick={() => {
        const guardId = store.session.guards[0]?.id;
        if (!guardId) return;
        setMutationResult('pending');
        void store.setGuardActive(guardId, false)
          .then((saved) => setMutationResult(saved ? 'saved' : 'failed'));
      }}>disable guard</button>
      <button type="button" onClick={() => setBackup(JSON.stringify(createPortableBackup({
        source: store.session.source,
        archive: sessionArchive(store.session),
        reviews: store.session.reviews,
        actions: store.session.actions,
        journal: store.session.journal,
        guards: store.session.guards,
      }, { kind: 'full-workspace' }, 300)))}>capture backup</button>
      <button type="button" onClick={() => setFupan(JSON.stringify(sessionArchive(store.session)))}>capture fupan</button>
      <button type="button" onClick={() => {
        setRestoreResult('pending');
        void store.restoreSessionArchive(fupan)
          .then((restored) => setRestoreResult(restored ? 'restored' : 'cancelled'))
          .catch(() => setRestoreResult('rejected'));
      }}>restore fupan</button>
      <button type="button" onClick={store.activateDemo}>demo</button>
      <button type="button" onClick={() => void store.loadBinance()}>load binance</button>
      <button type="button" onClick={() => void store.syncBinance()}>sync binance</button>
      <button type="button" onClick={() => void store.connectBinance('a'.repeat(24), 'b'.repeat(32))}>
        connect binance
      </button>
      <button type="button" onClick={() => {
        setClearResult('pending');
        void store.clear().then((removed) => setClearResult(String(removed)));
      }}>clear</button>
      <button type="button" onClick={() => {
        setRestoreResult('pending');
        void store.restorePortableBackup(backup)
          .then((restored) => setRestoreResult(restored ? 'restored' : 'cancelled'))
          .catch(() => setRestoreResult('rejected'));
      }}>restore backup</button>
      <input aria-label="recovery" value={code} onChange={(event) => setCode(event.target.value)} />
      <button type="button" onClick={() => void workspace.unlockWorkspace(code)}>unlock</button>
    </div>
  );
}

async function completePortableBackupFixture(
  source: 'imported' | 'binance' = 'imported',
): Promise<string> {
  const fixture = parseStatement(CSV, null);
  if (fixture.error !== undefined) throw new Error(fixture.error);
  const created = await fillLedger.createCsvFillLedger(null, {
    fills: fixture.fills,
    meta: fixture.meta,
    contract: fixture.contract,
    diagnostics: fixture.diagnostics,
  });
  const replay = fillLedger.replayCsvFillLedger(created.ledger);
  const tradeId = replay.trades[0]?.id;
  if (!tradeId) throw new Error('fixture trade');
  const archive = fillLedger.withCsvFillLedger(
    exportArchive([...replay.trades], replay.meta),
    created.ledger,
  );
  return JSON.stringify(createPortableBackup({
    source,
    archive: archive as unknown as JsonValue,
    reviews: {
      [tradeId]: {
        saw: '到达计划区', happened: '按计划成交', lesson: '下一笔先写失效条件',
        grade: 'A', reviewed: true, updatedAt: 200,
      },
    },
    actions: {
      [`trade:${tradeId}`]: {
        id: `trade:${tradeId}`,
        sourceTradeId: tradeId,
        text: '下一笔先写失效条件',
        status: 'done',
        createdAt: 200,
        updatedAt: 300,
        completedAt: 300,
      },
    },
    journal: [{ day: '2026-08-28', note: '等到计划区', emotion: '冷静', updatedAt: 400 }],
    guards: [{
      id: 'guard-1', text: '连续亏损 3 笔后停止当天交易', active: true,
      createdAt: 500, updatedAt: 500,
    }],
  }, { kind: 'full-workspace' }, 600));
}

function storageEntries(storage: Storage): readonly (readonly [string, string | null])[] {
  return Array.from({ length: storage.length }, (_value, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .sort()
    .map((key) => [key, storage.getItem(key)] as const);
}

function dispatchBrowserStorageChange(key = BROWSER_STORAGE_GENERATION_KEY): void {
  window.dispatchEvent(new StorageEvent('storage', {
    key,
    storageArea: localStorage,
    url: window.location.href,
  }));
}

describe('StoreProvider encrypted workspace integration', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    browserWebLockForcedBusy = false;
    browserWebLockAfterRelease = null;
    installBrowserWebLocksMock();
    saveAuthSession(session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists imports and review actions in the vault, clears on lock, and restores cross-session', async () => {
    const backend = new MemoryVaultBackend();
    const factory = () => new MemoryVaultRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={factory}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    const recoveryCode = screen.getByTestId('kit').textContent ?? '';
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);

    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'lock' }));
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('phase')).toHaveTextContent('LOCKED');
    });
    await user.type(screen.getByLabelText('recovery'), recoveryCode);
    await user.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('action-status')).toHaveTextContent('open');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'complete' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('5');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'guard' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('6');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'capture backup' }));
    await user.click(screen.getByRole('button', { name: 'demo' }));
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('7');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('import-runs')).toHaveTextContent('2');
      expect(screen.getByTestId('generation')).toHaveTextContent('7');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^rv-review-v1:/),
        expect.stringMatching(/^rv-action-v1:/),
      ]));
  }, 60_000);

  it('persists the complete experiment loop in browser storage and lets revise start a new pending run', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('action-status')).toHaveTextContent('open'));

    await user.click(screen.getByRole('button', { name: 'configure experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved');
      expect(screen.getByTestId('experiment-decision')).toHaveTextContent('pending');
    });
    await user.click(screen.getByRole('button', { name: 'observe experiment' }));
    await waitFor(() => expect(screen.getByTestId('experiment-observed')).toHaveTextContent('1'));
    await user.click(screen.getByRole('button', { name: 'revise experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('experiment-decision')).toHaveTextContent('revise');
      expect(screen.getByTestId('action-status')).toHaveTextContent('open');
    });

    const scope = screen.getByTestId('review-scope').textContent ?? '';
    const persisted = JSON.parse(localStorage.getItem(`rv-action-v1:${scope}`) ?? '{}');
    expect(Object.values(persisted)[0]).toMatchObject({
      status: 'open', completedAt: null,
      experiment: { decision: 'revise', observedCount: 1, successfulCount: 1 },
    });

    await user.click(screen.getByRole('button', { name: 'configure experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('experiment-decision')).toHaveTextContent('pending');
      expect(screen.getByTestId('experiment-observed')).toHaveTextContent('0');
      expect(screen.getByTestId('action-status')).toHaveTextContent('open');
    });
  }, 45_000);

  it('routes Demo review and practice edits through the browser coordinator', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    expect(screen.getByTestId('persistence')).toHaveTextContent('demo');
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    await user.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => expect(screen.getByTestId('journal-count')).toHaveTextContent('1'));
    await user.click(screen.getByRole('button', { name: 'guard' }));
    await waitFor(() => expect(screen.getByTestId('guard-count')).toHaveTextContent('1'));
    expect(localStorage.getItem('rv-review-v1:demo-v1')).toContain('下一笔先写失效条件');
    expect(localStorage.getItem('rv-action-v1:demo-v1')).toContain('trade:D001');
    expect(localStorage.getItem('rv-practice-v1:demo-v1')).toContain('等到计划区');
  }, 45_000);

  it('fails an ordinary browser write while locked, clears atomically, then accepts a fresh write', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    browserWebLockForcedBusy = true;

    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('0');
    expect(localStorage.getItem(`rv-review-v1:${scope}`)).toBeNull();

    browserWebLockForcedBusy = false;
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    localStorage.setItem('rv2-session', '{"legacy":true}');
    await user.click(screen.getByRole('button', { name: 'clear' }));
    await waitFor(() => expect(screen.getByTestId('clear-result')).toHaveTextContent('4'));
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    expect(localStorage.getItem(`rv-review-v1:${scope}`)).toBeNull();
    expect(localStorage.getItem(`rv-action-v1:${scope}`)).toBeNull();
    expect(localStorage.getItem(`rv-practice-v1:${scope}`)).toBeNull();
    expect(localStorage.getItem('rv2-session')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    await user.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => expect(screen.getByTestId('journal-count')).toHaveTextContent('1'));
    await user.click(screen.getByRole('button', { name: 'guard' }));
    await waitFor(() => expect(screen.getByTestId('guard-active')).toHaveTextContent('yes'));
    await user.click(screen.getByRole('button', { name: 'disable guard' }));
    await waitFor(() => expect(screen.getByTestId('guard-active')).toHaveTextContent('no'));
  }, 45_000);

  it('drops a stale browser session when another tab clear is delivered by storage event', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('review-count')).toHaveTextContent('1'));
    await user.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => expect(screen.getByTestId('journal-count')).toHaveTextContent('1'));

    await act(async () => {
      const cleared = await clearBrowserUserData();
      expect(cleared.ok).toBe(true);
      dispatchBrowserStorageChange();
    });
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('persistence')).toHaveTextContent('demo');
      expect(screen.getByTestId('review-count')).toHaveTextContent('0');
      expect(screen.getByTestId('action-status')).toHaveTextContent('none');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('0');
    });

    // The event also rebinds Demo to the new token, so a genuinely new action
    // can be committed without reloading the application.
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    expect(localStorage.getItem('rv-review-v1:demo-v1')).toContain('下一笔先写失效条件');
  }, 45_000);

  it('rejects stale UI mutation after a cross-tab clear even before its storage event arrives', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('review-count')).toHaveTextContent('1'));

    const cleared = await clearBrowserUserData();
    expect(cleared.ok).toBe(true);
    // No synthetic storage event: the bound old token itself must fence this.
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => {
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('review-count')).toHaveTextContent('0');
      expect(screen.getByTestId('action-status')).toHaveTextContent('none');
    });
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^rv-review-v1:/),
        expect.stringMatching(/^rv-action-v1:/),
        expect.stringMatching(/^rv-practice-v1:/),
      ]));
  }, 45_000);

  it('does not render a browser mutation cleared after lock release but before dispatch', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));

    browserWebLockAfterRelease = async () => {
      const cleared = await clearBrowserUserData();
      expect(cleared.ok).toBe(true);
    };
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => {
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('review-count')).toHaveTextContent('0');
      expect(screen.getByTestId('action-status')).toHaveTextContent('none');
    });
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^rv-review-v1:/),
        expect.stringMatching(/^rv-action-v1:/),
        expect.stringMatching(/^rv-practice-v1:/),
      ]));
  }, 45_000);

  it('keeps an unlocked vault UI intact when browser clear storage events arrive', async () => {
    const backend = new MemoryVaultBackend();
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('persistence')).toHaveTextContent('vault');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await act(async () => {
      const cleared = await clearBrowserUserData();
      expect(cleared.ok).toBe(true);
      dispatchBrowserStorageChange();
    });
    expect(screen.getByTestId('source')).toHaveTextContent('imported');
    expect(screen.getByTestId('persistence')).toHaveTextContent('vault');
    expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    expect(screen.getByTestId('action-status')).toHaveTextContent('open');
  }, 60_000);

  it('uses the latest action and practice families instead of stale UI siblings', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    const actionKey = `rv-action-v1:${scope}`;
    const practiceKey = `rv-practice-v1:${scope}`;
    const actions = JSON.parse(localStorage.getItem(actionKey) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    const actionId = Object.keys(actions)[0] ?? '';
    actions[actionId] = { ...actions[actionId], text: '另一标签页刚更新的动作' };
    localStorage.setItem(actionKey, JSON.stringify(actions));
    localStorage.setItem(practiceKey, JSON.stringify({
      journal: [{
        day: '2026-08-30', note: '另一标签页刚保存的日记', emotion: '专注', updatedAt: 950,
      }],
      guards: [],
    }));

    await user.click(screen.getByRole('button', { name: 'complete' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    expect(screen.getByTestId('action-status')).toHaveTextContent('done');
    expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
    const committedActions = JSON.parse(localStorage.getItem(actionKey) ?? '{}') as Record<
      string,
      { text: string; status: string }
    >;
    expect(committedActions[actionId]).toMatchObject({
      text: '另一标签页刚更新的动作', status: 'done',
    });
    const committedPractice = JSON.parse(localStorage.getItem(practiceKey) ?? '{}') as {
      journal: readonly { note: string }[];
    };
    expect(committedPractice.journal[0]?.note).toBe('另一标签页刚保存的日记');
  }, 45_000);

  it('rejects an ordinary write when any latest browser family is malformed', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('persistence')).toHaveTextContent('browser'));
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    localStorage.setItem(`rv-action-v1:${scope}`, '{not-json');

    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('0');
    expect(localStorage.getItem(`rv-review-v1:${scope}`)).toBeNull();
    expect(localStorage.getItem(`rv-action-v1:${scope}`)).toBe('{not-json');
  }, 45_000);

  it('persists experiment configuration, evidence, and adopt decision through the vault queue', async () => {
    const backend = new MemoryVaultBackend();
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitForWorkspaceGeneration(3);
    await user.click(screen.getByRole('button', { name: 'configure experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('experiment-decision')).toHaveTextContent('pending');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'observe experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('5');
      expect(screen.getByTestId('experiment-observed')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'adopt experiment' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('6');
      expect(screen.getByTestId('experiment-decision')).toHaveTextContent('adopt');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/^rv-action-v1:/)]));
  }, 60_000);

  it('atomically migrates Classic reviews into browser persistence and rejects a stale binding', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'migrate stale classic' }));
    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('cancelled'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('0');

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await waitFor(() => {
      expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-lesson')).toHaveTextContent('迁移后等待下一次确认');
      expect(screen.getByTestId('review-map-prototype')).toHaveTextContent('null');
      expect(screen.getByTestId('action-map-prototype')).toHaveTextContent('null');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .toEqual(expect.arrayContaining([
        `rv-review-v1:${scope}`,
        `rv-action-v1:${scope}`,
        `rv-practice-v1:${scope}`,
      ]));

    const persisted = JSON.parse(localStorage.getItem(`rv-review-v1:${scope}`) ?? '{}');
    expect(Object.values(persisted)[0]).toMatchObject({
      lesson: '迁移后等待下一次确认', grade: 'B', reviewed: true,
    });
  }, 45_000);

  it('fails a restore closed while Classic owns the browser lock, then restores after cancellation', async () => {
    const backup = await completePortableBackupFixture();
    const originalMerge = legacyMigration.mergeLegacyReviewMigration;
    let markStarted!: () => void;
    let releaseMerge!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseMerge = resolve; });
    vi.spyOn(legacyMigration, 'mergeLegacyReviewMigration').mockImplementation(async (...args) => {
      markStarted();
      await gate;
      return originalMerge(...args);
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('trade-count')).toHaveTextContent('1'));

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await started;
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    releaseMerge();

    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('cancelled'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('restored'), {
      timeout: CRYPTO_STATE_TIMEOUT_MS,
    });
    expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    expect(screen.getByTestId('review-lesson')).toHaveTextContent('下一笔先写失效条件');
  }, 60_000);

  it('reads the latest cross-tab state under the lock and skips a matching Classic review', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('trade-count')).toHaveTextContent('1'));
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    const tradeId = screen.getByTestId('first-trade-id').textContent ?? '';
    const actionId = `trade:${tradeId}`;
    let deferMigration = true;
    let markLockRequested!: () => void;
    let releaseLock!: () => void;
    const lockRequested = new Promise<void>((resolve) => { markLockRequested = resolve; });
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locks = {
      async request<T>(
        _name: string,
        _options: Readonly<{ mode: 'exclusive'; ifAvailable: true }>,
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        if (deferMigration) {
          deferMigration = false;
          markLockRequested();
          await lockGate;
        }
        return callback({});
      },
    };
    const testNavigator = Object.create(navigator) as Navigator & { locks: typeof locks };
    Object.defineProperty(testNavigator, 'locks', { value: locks });
    vi.stubGlobal('navigator', testNavigator);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await lockRequested;
    localStorage.setItem(`rv-review-v1:${scope}`, JSON.stringify({
      [tradeId]: {
        saw: '外部标签页观察', happened: '外部标签页执行', lesson: '外部标签页最新教训',
        grade: 'A', reviewed: true, updatedAt: 900,
      },
    }));
    localStorage.setItem(`rv-action-v1:${scope}`, JSON.stringify({
      [actionId]: {
        id: actionId, sourceTradeId: tradeId, text: '外部标签页最新动作', status: 'open',
        createdAt: 901, updatedAt: 901, completedAt: null,
      },
    }));
    localStorage.setItem(`rv-practice-v1:${scope}`, JSON.stringify({
      journal: [{
        day: '2026-08-30', note: '外部标签页日记', emotion: '冷静', updatedAt: 902,
      }],
      guards: [],
    }));
    releaseLock();
    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('0/1'));
    expect(screen.getByTestId('review-lesson')).toHaveTextContent('外部标签页最新教训');
    expect(screen.getByTestId('review-updated')).toHaveTextContent('900');
    expect(screen.getByTestId('action-status')).toHaveTextContent('open');
    expect(screen.getByTestId('action-updated')).toHaveTextContent('901');
    expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
  }, 45_000);

  it('keeps a different cross-tab review while inserting the selected Classic review', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('trade-count')).toHaveTextContent('1'));
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    const tradeId = screen.getByTestId('first-trade-id').textContent ?? '';
    let markLockRequested!: () => void;
    let releaseLock!: () => void;
    const lockRequested = new Promise<void>((resolve) => { markLockRequested = resolve; });
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    let deferred = false;
    const locks = {
      async request<T>(
        _name: string,
        _options: Readonly<{ mode: 'exclusive'; ifAvailable: true }>,
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        if (!deferred) {
          deferred = true;
          markLockRequested();
          await lockGate;
        }
        return callback({});
      },
    };
    const testNavigator = Object.create(navigator) as Navigator & { locks: typeof locks };
    Object.defineProperty(testNavigator, 'locks', { value: locks });
    vi.stubGlobal('navigator', testNavigator);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await lockRequested;
    localStorage.setItem(`rv-review-v1:${scope}`, JSON.stringify({
      'external-trade-1': {
        saw: '另一笔外部观察', happened: '另一笔外部执行', lesson: '另一笔外部教训',
        grade: 'B', reviewed: true, updatedAt: 910,
      },
    }));
    localStorage.setItem(`rv-action-v1:${scope}`, '{}');
    localStorage.setItem(`rv-practice-v1:${scope}`, '{"journal":[],"guards":[]}');
    releaseLock();

    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0'));
    expect(screen.getByTestId('review-count')).toHaveTextContent('2');
    const persisted = JSON.parse(localStorage.getItem(`rv-review-v1:${scope}`) ?? '{}') as Record<
      string,
      { lesson: string }
    >;
    expect(persisted['external-trade-1']?.lesson).toBe('另一笔外部教训');
    expect(persisted[tradeId]?.lesson).toBe('迁移后等待下一次确认');
  }, 45_000);

  it('persists a Classic migration for the local Binance runtime under its storage-only scope alias', async () => {
    const fixture = parseStatement(CSV, null);
    if (fixture.error !== undefined) throw new Error(fixture.error);
    const digest = 'a'.repeat(32);
    vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockResolvedValue({
      runtime: { sync: { state: 'COMPLETED' }, phase: 'READY' },
      access: { phase: 'BINANCE_OBSERVED_READY' },
      trades: enrichTrades([...fixture.trades]),
      records: [],
      bundle: null,
      reviewScope: `rv1_${digest}`,
    } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>);
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'load binance' }));
    await waitFor(() => {
      expect(screen.getByTestId('persistence')).toHaveTextContent('runtime');
      expect(screen.getByTestId('review-scope')).toHaveTextContent(`rv1_${digest}`);
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    });

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0'));
    expect(localStorage.getItem(`rv-review-v1:binance-${digest}`)).toContain('迁移后等待下一次确认');
    expect(localStorage.getItem(`rv-action-v1:binance-${digest}`)).toBe('{}');
    expect(localStorage.getItem(`rv-practice-v1:binance-${digest}`)).toContain('"journal":[]');
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'));
    expect(localStorage.getItem(`rv-review-v1:binance-${digest}`)).toContain('下一笔先写失效条件');
    expect(localStorage.getItem(`rv-action-v1:binance-${digest}`)).toContain('trade:');
  }, 45_000);

  it('commits a Classic migration receipt only after the encrypted vault head succeeds', async () => {
    const backend = new MemoryVaultBackend();
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-map-prototype')).toHaveTextContent('null');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([expect.stringMatching(/^rv-review-v1:/)]));
  }, 60_000);

  it('cancels a Classic migration before vault save when a newer Binance intent arrives during merge', async () => {
    class CountPublishesRepository extends MemoryVaultRepository {
      calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        return super.publishHead(input, options);
      }
    }
    const originalMerge = legacyMigration.mergeLegacyReviewMigration;
    let markStarted!: () => void;
    let releaseMerge!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseMerge = resolve; });
    vi.spyOn(legacyMigration, 'mergeLegacyReviewMigration').mockImplementation(async (...args) => {
      markStarted();
      await gate;
      return originalMerge(...args);
    });
    vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockResolvedValue({
      runtime: { sync: { state: 'COMPLETED' }, phase: 'READY' },
      access: { phase: 'BINANCE_OBSERVED_READY' },
      trades: [], records: [], bundle: null, reviewScope: null,
    } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>);
    const repository = new CountPublishesRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await started;
    await user.click(screen.getByRole('button', { name: 'load binance' }));
    await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('binance'));
    releaseMerge();

    await waitFor(() => expect(screen.getByTestId('migration-result')).toHaveTextContent('cancelled'));
    expect(screen.getByTestId('generation')).toHaveTextContent('2');
    expect(repository.calls).toBe(2);
  }, 60_000);

  it('returns a Classic receipt when the vault head was already in flight and later restores that head', async () => {
    class DeferredMigrationRepository extends MemoryVaultRepository {
      private calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
      release(): void { this.releaseGate(); }
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 3) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        return super.publishHead(input, options);
      }
    }
    vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockResolvedValue({
      runtime: { sync: { state: 'COMPLETED' }, phase: 'READY' },
      access: { phase: 'BINANCE_OBSERVED_READY' },
      trades: [], records: [], bundle: null, reviewScope: null,
    } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>);
    const repository = new DeferredMigrationRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    const recoveryCode = screen.getByTestId('kit').textContent ?? '';
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'load binance' }));
    await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('binance'));
    repository.release();

    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0');
      expect(screen.getByTestId('source')).toHaveTextContent('binance');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'lock' }));
    await user.type(screen.getByRole('textbox', { name: 'recovery' }), recoveryCode);
    await user.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-lesson')).toHaveTextContent('迁移后等待下一次确认');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 60_000);

  it('reports an in-flight Classic head honestly before a newer portable restore supersedes it', async () => {
    class DeferredMigrationRepository extends MemoryVaultRepository {
      private calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
      release(): void { this.releaseGate(); }
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 3) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        return super.publishHead(input, options);
      }
    }
    const backup = await completePortableBackupFixture();
    const repository = new DeferredMigrationRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    repository.release();

    await waitFor(() => {
      expect(screen.getByTestId('migration-result')).toHaveTextContent('1/0');
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-lesson')).toHaveTextContent('下一笔先写失效条件');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 60_000);

  it('returns no Classic receipt and exposes no review when the vault head is rejected', async () => {
    class RejectMigrationRepository extends MemoryVaultRepository {
      private calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls === 3) throw new VaultRepositoryError('CONFLICT');
        return super.publishHead(input, options);
      }
    }
    const repository = new RejectMigrationRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'migrate classic' }));
    await waitFor(() => {
      expect(screen.getByTestId('migration-result')).toHaveTextContent('cancelled');
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('review-count')).toHaveTextContent('0');
      expect(screen.getByTestId('error-code')).toHaveTextContent('VAULT_SAVE_FAILED');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 60_000);

  it('restores a complete portable backup into browser persistence and reloads it with the same CSV scope', async () => {
    class CountPublishesRepository extends MemoryVaultRepository {
      calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        return super.publishHead(input, options);
      }
    }
    const backup = await completePortableBackupFixture();
    const repository = new CountPublishesRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    const first = render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-updated')).toHaveTextContent('200');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
      expect(screen.getByTestId('action-updated')).toHaveTextContent('300');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    const scope = screen.getByTestId('review-scope').textContent ?? '';
    const tradeId = screen.getByTestId('first-trade-id').textContent ?? '';
    expect(scope).toMatch(/^csv-ledger-[a-f0-9]{64}$/);
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .toEqual(expect.arrayContaining([
        `rv-review-v1:${scope}`,
        `rv-action-v1:${scope}`,
        `rv-practice-v1:${scope}`,
      ]));
    expect(repository.calls).toBe(0);
    first.unmount();

    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
      expect(screen.getByTestId('review-scope')).toHaveTextContent(scope);
      expect(screen.getByTestId('first-trade-id')).toHaveTextContent(tradeId);
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-updated')).toHaveTextContent('200');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
      expect(screen.getByTestId('action-updated')).toHaveTextContent('300');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(repository.calls).toBe(0);
  }, 60_000);

  it('restores a Demo complete backup as the deterministic synthetic Demo session', async () => {
    class CountPublishesRepository extends MemoryVaultRepository {
      calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        return super.publishHead(input, options);
      }
    }
    const repository = new CountPublishesRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    const demoTradeCount = screen.getByTestId('trade-count').textContent ?? '';
    const demoFirstTradeId = screen.getByTestId('first-trade-id').textContent ?? '';
    await user.click(screen.getByRole('button', { name: 'capture backup' }));
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
    });

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('persistence')).toHaveTextContent('demo');
      expect(screen.getByTestId('session-phase')).toHaveTextContent('DEMO_READY');
      expect(screen.getByTestId('review-scope')).toHaveTextContent('demo-v1');
      expect(screen.getByTestId('trade-count')).toHaveTextContent(demoTradeCount);
      expect(screen.getByTestId('first-trade-id')).toHaveTextContent(demoFirstTradeId);
      expect(screen.getByTestId('review-map-prototype')).toHaveTextContent('null');
      expect(screen.getByTestId('action-map-prototype')).toHaveTextContent('null');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(repository.calls).toBe(0);
  }, 60_000);

  it('refuses a Demo complete backup while a vault is unlocked without publishing a new head', async () => {
    class CountPublishesRepository extends MemoryVaultRepository {
      calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        return super.publishHead(input, options);
      }
    }
    const repository = new CountPublishesRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'capture backup' }));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    expect(repository.calls).toBe(1);

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled');
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(repository.calls).toBe(1);
  }, 60_000);

  it('restores a Binance complete backup only as an offline imported browser archive', async () => {
    const backup = await completePortableBackupFixture('binance');
    const repository = new MemoryVaultRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));

    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
      expect(screen.getByTestId('session-phase')).toHaveTextContent('IMPORT_READY');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 60_000);

  it('rejects a legacy date-range portable envelope without changing session or storage', async () => {
    const complete = JSON.parse(await completePortableBackupFixture()) as Record<string, unknown>;
    const ranged = JSON.stringify({
      ...complete,
      scope: { from: '2026-06-01', to: '2026-08-28' },
    });
    const repository = new MemoryVaultRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={ranged} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    const localBefore = storageEntries(localStorage);
    const sessionBefore = storageEntries(sessionStorage);
    const firstTradeId = screen.getByTestId('first-trade-id').textContent ?? '';

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));

    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    expect(screen.getByTestId('persistence')).toHaveTextContent('demo');
    expect(screen.getByTestId('session-phase')).toHaveTextContent('DEMO_READY');
    expect(screen.getByTestId('first-trade-id')).toHaveTextContent(firstTradeId);
    expect(storageEntries(localStorage)).toEqual(localBefore);
    expect(storageEntries(sessionStorage)).toEqual(sessionBefore);
  }, 60_000);

  it('fails closed before browser persistence for malformed or unavailable local storage', async () => {
    const user = userEvent.setup();
    const repository = new MemoryVaultRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const first = render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={'{"format":"rv-portable-backup/1"}'} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    first.unmount();

    const backup = await completePortableBackupFixture();
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(this: Storage, key, value) {
      if (String(key).startsWith('rv-review-v1:')) throw new DOMException('quota', 'QuotaExceededError');
      return nativeSetItem.call(this, key, value);
    });
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    expect(screen.getByTestId('persistence')).toHaveTextContent('demo');
  });

  it('does not write browser state when an offline portable restore is cancelled during ledger verification', async () => {
    const backup = await completePortableBackupFixture();
    const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
      markVerificationStarted();
      await verificationGate;
      return originalVerify(ledger);
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await verificationStarted;
    await user.click(screen.getByRole('button', { name: 'demo' }));
    releaseVerification();
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    });
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^rv-review-v1:/),
        expect.stringMatching(/^rv-action-v1:/),
        expect.stringMatching(/^rv-practice-v1:/),
      ]));
  });

  it('does not revive a portable restore whose browser generation predates clear', async () => {
    const backup = await completePortableBackupFixture();
    const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
      markVerificationStarted();
      await verificationGate;
      return originalVerify(ledger);
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await verificationStarted;
    await user.click(screen.getByRole('button', { name: 'clear' }));
    await waitFor(() => expect(screen.getByTestId('clear-result')).toHaveTextContent('0'));
    expect(localStorage.getItem(BROWSER_STORAGE_GENERATION_KEY)).toBe('1');
    releaseVerification();

    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    expect(Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index)))
      .not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^rv-review-v1:/),
        expect.stringMatching(/^rv-action-v1:/),
        expect.stringMatching(/^rv-practice-v1:/),
      ]));
  });

  it('recovers a PREPARED browser restore before the first same-scope CSV reload', async () => {
    const backup = await completePortableBackupFixture();
    const parsed = JSON.parse(backup) as {
      archive: unknown;
      reviews: Record<string, unknown>;
      actions: Record<string, unknown>;
      journal: readonly unknown[];
      guards: readonly unknown[];
    };
    const ledger = fillLedger.readCsvFillLedgerExtension(parsed.archive);
    if (!ledger) throw new Error('fixture ledger');
    const scope = `csv-ledger-${ledger.scopeDigest}`;
    const entries = [
      { key: `rv-review-v1:${scope}`, previous: JSON.stringify(parsed.reviews) },
      { key: `rv-action-v1:${scope}`, previous: JSON.stringify(parsed.actions) },
      { key: `rv-practice-v1:${scope}`, previous: JSON.stringify({ journal: parsed.journal, guards: parsed.guards }) },
    ];
    entries.forEach(({ key }) => localStorage.setItem(key, '{}'));
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, JSON.stringify({
      format: 'rv-browser-restore-transaction/1', status: 'PREPARED', entries,
    }));
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP');
      expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull();
      entries.forEach(({ key, previous }) => expect(localStorage.getItem(key)).toBe(previous));
    });
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('review-updated')).toHaveTextContent('200');
      expect(screen.getByTestId('action-status')).toHaveTextContent('done');
      expect(screen.getByTestId('action-updated')).toHaveTextContent('300');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  });

  it('repairs a corrupt browser journal through clear and makes a later restore ready again', async () => {
    const backup = await completePortableBackupFixture();
    localStorage.setItem(BROWSER_RESTORE_TRANSACTION_KEY, '{damaged-journal');
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
          subject: 'alice', backend: new MemoryVaultBackend(),
        })}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBe('{damaged-journal');

    await user.click(screen.getByRole('button', { name: 'clear' }));
    await waitFor(() => expect(localStorage.getItem(BROWSER_RESTORE_TRANSACTION_KEY)).toBeNull());
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('persistence')).toHaveTextContent('browser');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it('persists an open-only first batch and closes it by replaying the full ledger', async () => {
    const backend = new MemoryVaultBackend();
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitFor(() => {
      expect(screen.getByTestId('phase')).toHaveTextContent('UNLOCKED');
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'import open' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('0');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'import close' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('2');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  });

  it('keeps a legacy archive viewable but refuses silent incremental mutation', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'import legacy archive' }));
    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('0');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    await user.click(screen.getByRole('button', { name: 'increment legacy' }));
    await waitFor(() => expect(screen.getByTestId('ledger-error')).toHaveTextContent('LEGACY_LEDGER_REBASE_REQUIRED'));
    expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    expect(screen.getByTestId('ledger-fills')).toHaveTextContent('0');
  });

  it('restores the ledger from a .fupan archive and can continue with the closing batch', async () => {
    const backend = new MemoryVaultBackend();
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import open' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'capture fupan' }));
    expect(screen.getByTestId('fupan-ready')).toHaveTextContent('yes');
    await user.click(screen.getByRole('button', { name: 'demo' }));
    await user.click(screen.getByRole('button', { name: 'restore fupan' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('3');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('1');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('0');
    });
    await user.click(screen.getByRole('button', { name: 'import close' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('2');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it('reports a vault mutation as saved only after the remote head is confirmed', async () => {
    class RejectThirdPublishRepository extends MemoryVaultRepository {
      private calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls === 3) throw new VaultRepositoryError('REMOTE_UNAVAILABLE');
        return super.publishHead(input, options);
      }
    }

    const backend = new MemoryVaultBackend();
    const repository = new RejectThirdPublishRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    await user.click(screen.getByRole('button', { name: 'review' }));
    expect(screen.getByTestId('mutation-result')).toHaveTextContent('pending');
    await waitFor(() => {
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
      expect(screen.getByTestId('error-code')).toHaveTextContent('VAULT_SAVE_FAILED');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it.each(['review', 'complete', 'journal', 'guard'] as const)(
    'does not expose a rejected %s mutation in the committed session',
    async (mutation) => {
      class RejectNextPublishRepository extends MemoryVaultRepository {
        rejectNext = false;
        override async publishHead(
          input: PublishVaultHeadInput,
          options?: VaultOperationOptions,
        ): Promise<VaultHead> {
          if (this.rejectNext) {
            this.rejectNext = false;
            throw new VaultRepositoryError('CONFLICT');
          }
          return super.publishHead(input, options);
        }
      }

      const repository = new RejectNextPublishRepository({
        subject: 'alice', backend: new MemoryVaultBackend(),
      });
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => repository}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);
      await user.click(screen.getByRole('button', { name: 'import' }));
      await waitForWorkspaceGeneration(2);

      if (mutation === 'complete') {
        await user.click(screen.getByRole('button', { name: 'review' }));
        await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved'), {
          timeout: CRYPTO_STATE_TIMEOUT_MS,
        });
      }
      const before = {
        action: screen.getByTestId('action-status').textContent,
        journal: screen.getByTestId('journal-count').textContent,
        guard: screen.getByTestId('guard-count').textContent,
      };
      repository.rejectNext = true;
      await user.click(screen.getByRole('button', { name: mutation }));
      await waitFor(() => expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed'), {
        timeout: CRYPTO_STATE_TIMEOUT_MS,
      });
      expect(screen.getByTestId('action-status')).toHaveTextContent(before.action ?? 'none');
      expect(screen.getByTestId('journal-count')).toHaveTextContent(before.journal ?? '0');
      expect(screen.getByTestId('guard-count')).toHaveTextContent(before.guard ?? '0');
      if (mutation === 'review') expect(screen.getByTestId('action-status')).toHaveTextContent('none');
    },
    60_000,
  );

  it('serializes concurrent journal mutations without losing either entry', async () => {
    const repository = new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: /^journal$/ }));
    await user.click(screen.getByRole('button', { name: 'journal next day' }));
    await waitFor(() => {
      expect(screen.getByTestId('journal-count')).toHaveTextContent('2');
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('saved');
      expect(screen.getByTestId('mutation-successes')).toHaveTextContent('2');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 60_000);

  it.each([
    ['review', 'review-count', '1'],
    ['journal', 'journal-count', '1'],
    ['guard', 'guard-count', '1'],
  ] as const)(
    'does not overwrite a committed %s mutation when a following import changes request epoch',
    async (mutation, stateTestId, expectedValue) => {
      class DeferredNextPublishRepository extends MemoryVaultRepository {
        private shouldDefer = false;
        private releaseGate: (() => void) | null = null;
        private markStarted: (() => void) | null = null;
        started: Promise<void> = Promise.resolve();

        deferNext(): void {
          this.shouldDefer = true;
          this.started = new Promise<void>((resolve) => { this.markStarted = resolve; });
        }

        release(): void {
          this.releaseGate?.();
        }

        override async publishHead(
          input: PublishVaultHeadInput,
          options?: VaultOperationOptions,
        ): Promise<VaultHead> {
          if (!this.shouldDefer) return super.publishHead(input, options);
          this.shouldDefer = false;
          this.markStarted?.();
          await new Promise<void>((resolve) => { this.releaseGate = resolve; });
          return super.publishHead(input, options);
        }
      }

      const repository = new DeferredNextPublishRepository({
        subject: 'alice', backend: new MemoryVaultBackend(),
      });
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => repository}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      const recoveryCode = screen.getByTestId('kit').textContent ?? '';
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);
      await user.click(screen.getByRole('button', { name: 'import' }));
      await waitForWorkspaceGeneration(2);

      repository.deferNext();
      await user.click(screen.getByRole('button', { name: new RegExp(`^${mutation}$`) }));
      await repository.started;
      await user.click(screen.getByRole('button', { name: 'import open' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      repository.release();

      await waitFor(() => {
        expect(screen.getByTestId('generation')).toHaveTextContent('4');
        expect(screen.getByTestId('ledger-fills')).toHaveTextContent('3');
        expect(screen.getByTestId(stateTestId)).toHaveTextContent(expectedValue);
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

      await user.click(screen.getByRole('button', { name: 'lock' }));
      await user.type(screen.getByRole('textbox', { name: 'recovery' }), recoveryCode);
      await user.click(screen.getByRole('button', { name: 'unlock' }));
      await waitFor(() => {
        expect(screen.getByTestId('generation')).toHaveTextContent('4');
        expect(screen.getByTestId('ledger-fills')).toHaveTextContent('3');
        expect(screen.getByTestId(stateTestId)).toHaveTextContent(expectedValue);
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    },
    60_000,
  );

  it('reuses a content-bound browser ledger scope and trade IDs for the same CSV after reload', async () => {
    const backend = new MemoryVaultBackend();
    const factory = () => new MemoryVaultRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    const renderFresh = () => render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={factory}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );

    const first = renderFresh();
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('trade-count')).toHaveTextContent('1'));
    const firstScope = screen.getByTestId('review-scope').textContent;
    const firstTradeId = screen.getByTestId('first-trade-id').textContent;
    await user.click(screen.getByRole('button', { name: 'review' }));
    await waitFor(() => {
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('action-status')).toHaveTextContent('open');
    });
    await user.click(screen.getByRole('button', { name: 'journal' }));
    await waitFor(() => expect(screen.getByTestId('journal-count')).toHaveTextContent('1'));
    await user.click(screen.getByRole('button', { name: 'guard' }));
    await waitFor(() => {
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    });
    first.unmount();

    const repeated = renderFresh();
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => {
      expect(screen.getByTestId('review-scope')).toHaveTextContent(firstScope ?? '');
      expect(screen.getByTestId('first-trade-id')).toHaveTextContent(firstTradeId ?? '');
      expect(screen.getByTestId('review-count')).toHaveTextContent('1');
      expect(screen.getByTestId('action-status')).toHaveTextContent('open');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
      expect(screen.getByTestId('guard-count')).toHaveTextContent('1');
    });
    repeated.unmount();

    renderFresh();
    await user.click(screen.getByRole('button', { name: 'import open' }));
    await waitFor(() => expect(screen.getByTestId('ledger-fills')).toHaveTextContent('1'));
    expect(screen.getByTestId('review-scope').textContent).not.toBe(firstScope);
    expect(screen.getByTestId('review-count')).toHaveTextContent('0');
    expect(screen.getByTestId('action-status')).toHaveTextContent('none');
    expect(screen.getByTestId('journal-count')).toHaveTextContent('0');
    expect(screen.getByTestId('guard-count')).toHaveTextContent('0');
  }, 45_000);

  it.each([
    ['review', 'demo'],
    ['review', 'clear'],
    ['journal', 'demo'],
    ['journal', 'clear'],
  ] as const)(
    'does not revive a delayed successful %s mutation after %s',
    async (mutation, cancellation) => {
      class DeferredThirdPublishRepository extends MemoryVaultRepository {
        calls = 0;
        private releaseGate!: () => void;
        private markStarted!: () => void;
        readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
        private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
        release(): void { this.releaseGate(); }
        override async publishHead(
          input: PublishVaultHeadInput,
          options?: VaultOperationOptions,
        ): Promise<VaultHead> {
          this.calls += 1;
          if (this.calls !== 3) return super.publishHead(input, options);
          this.markStarted();
          await this.gate;
          return super.publishHead(input, options);
        }
      }

      const repository = new DeferredThirdPublishRepository({
        subject: 'alice', backend: new MemoryVaultBackend(),
      });
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => repository}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);
      await user.click(screen.getByRole('button', { name: 'import' }));
      await waitForWorkspaceGeneration(2);

      await user.click(screen.getByRole('button', { name: new RegExp(`^${mutation}$`) }));
      await repository.started;
      await user.click(screen.getByRole('button', { name: cancellation }));
      repository.release();
      await waitForWorkspaceGeneration(3);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
        expect(screen.getByTestId('source')).toHaveTextContent('demo');
        expect(screen.getByTestId('trade-count')).toHaveTextContent('62');
        expect(screen.getByTestId('journal-count')).toHaveTextContent('0');
        expect(screen.getByTestId('action-status')).toHaveTextContent('none');
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    },
    60_000,
  );

  it.each(['binance-first', 'publish-first'] as const)(
    'keeps the newer Binance intent when a vault mutation completes %s',
    async (order) => {
      class DeferredThirdPublishRepository extends MemoryVaultRepository {
        calls = 0;
        private releaseGate!: () => void;
        private markStarted!: () => void;
        readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
        private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
        release(): void { this.releaseGate(); }
        override async publishHead(
          input: PublishVaultHeadInput,
          options?: VaultOperationOptions,
        ): Promise<VaultHead> {
          this.calls += 1;
          if (this.calls !== 3) return super.publishHead(input, options);
          this.markStarted();
          await this.gate;
          return super.publishHead(input, options);
        }
      }

      let resolveBinance!: (snapshot: Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>) => void;
      const pendingBinance = new Promise<Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>>((resolve) => {
        resolveBinance = resolve;
      });
      vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockReturnValueOnce(pendingBinance);
      const binanceSnapshot = {
        runtime: { sync: { state: 'COMPLETED' } },
        access: { phase: 'BINANCE_OBSERVED_READY' },
        trades: [], records: [], bundle: null, reviewScope: null,
      } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>;
      const repository = new DeferredThirdPublishRepository({
        subject: 'alice', backend: new MemoryVaultBackend(),
      });
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => repository}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);
      await user.click(screen.getByRole('button', { name: 'import' }));
      await waitForWorkspaceGeneration(2);
      await user.click(screen.getByRole('button', { name: /^journal$/ }));
      await repository.started;
      await user.click(screen.getByRole('button', { name: 'load binance' }));

      if (order === 'binance-first') {
        resolveBinance(binanceSnapshot);
        await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('binance'));
        repository.release();
      } else {
        repository.release();
        await waitForWorkspaceGeneration(3);
        resolveBinance(binanceSnapshot);
      }
      await waitForWorkspaceGeneration(3);
      await waitFor(() => {
        expect(screen.getByTestId('source')).toHaveTextContent('binance');
        expect(screen.getByTestId('session-phase')).toHaveTextContent('BINANCE_OBSERVED_READY');
        expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
        expect(screen.getByTestId('journal-count')).toHaveTextContent('0');
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    },
    60_000,
  );

  it.each([
    ['load', 'load binance'],
    ['sync', 'sync binance'],
    ['connect', 'connect binance'],
  ] as const)(
    '%s Binance intent cancels a slow CSV write and the import already queued behind it',
    async (_entry, buttonName) => {
      class DeferredSecondPublishRepository extends MemoryVaultRepository {
        calls = 0;
        private releaseGate!: () => void;
        private markStarted!: () => void;
        private markFinished!: () => void;
        readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
        readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
        private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

        release(): void { this.releaseGate(); }

        override async publishHead(
          input: PublishVaultHeadInput,
          options?: VaultOperationOptions,
        ): Promise<VaultHead> {
          this.calls += 1;
          if (this.calls !== 2) return super.publishHead(input, options);
          this.markStarted();
          await this.gate;
          try {
            return await super.publishHead(input, options);
          } finally {
            this.markFinished();
          }
        }
      }

      const snapshot = {
        runtime: { sync: { state: 'COMPLETED' }, phase: 'READY' },
        access: { phase: 'BINANCE_OBSERVED_READY' },
        trades: [], records: [], bundle: null, reviewScope: null,
      } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>;
      vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockResolvedValue(snapshot);
      vi.spyOn(binanceSource, 'startBinanceSync').mockResolvedValue({ state: 'STARTED', reasonCodes: [] });
      vi.spyOn(binanceSource, 'storeBinanceCredentials').mockResolvedValue(undefined);
      const repository = new DeferredSecondPublishRepository({
        subject: 'alice', backend: new MemoryVaultBackend(),
      });
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => repository}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);

      await user.click(screen.getByRole('button', { name: 'queue duplicate imports' }));
      await repository.started;
      await user.click(screen.getByRole('button', { name: buttonName }));
      await waitFor(() => {
        expect(screen.getByTestId('source')).toHaveTextContent('binance');
        expect(screen.getByTestId('session-phase')).toHaveTextContent('BINANCE_OBSERVED_READY');
      });
      repository.release();
      await repository.finished;

      await waitFor(() => {
        expect(screen.getByTestId('queued-import-results')).toHaveTextContent('false,false');
        expect(screen.getByTestId('source')).toHaveTextContent('binance');
        expect(screen.getByTestId('session-phase')).toHaveTextContent('BINANCE_OBSERVED_READY');
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
      expect(repository.calls).toBe(2);
    },
    60_000,
  );

  it('keeps consecutive CSV imports queued when no newer source intent supersedes them', async () => {
    const repository = new MemoryVaultRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);

    await user.click(screen.getByRole('button', { name: 'queue duplicate imports' }));
    await waitFor(() => {
      expect(screen.getByTestId('queued-import-results')).toHaveTextContent('true,true');
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
      expect(screen.getByTestId('ledger-fills')).toHaveTextContent('2');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it.each([
    ['load', 'load binance'],
    ['sync', 'sync binance'],
    ['connect', 'connect binance'],
  ] as const)(
    '%s Binance intent cancels a .fupan restore still verifying its CSV ledger',
    async (_entry, buttonName) => {
      const fixture = parseStatement(CSV, null);
      if (fixture.error !== undefined) throw new Error(fixture.error);
      const created = await fillLedger.createCsvFillLedger(null, {
        fills: fixture.fills,
        meta: fixture.meta,
        contract: fixture.contract,
        diagnostics: fixture.diagnostics,
      });
      const replay = fillLedger.replayCsvFillLedger(created.ledger);
      const fupan = JSON.stringify(fillLedger.withCsvFillLedger(
        exportArchive([...replay.trades], replay.meta),
        created.ledger,
      ));
      const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
      let releaseVerification!: () => void;
      let markVerificationStarted!: () => void;
      const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
      const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
      vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
        markVerificationStarted();
        await verificationGate;
        return originalVerify(ledger);
      });
      const snapshot = {
        runtime: { sync: { state: 'COMPLETED' }, phase: 'READY' },
        access: { phase: 'BINANCE_OBSERVED_READY' },
        trades: [], records: [], bundle: null, reviewScope: null,
      } as unknown as Awaited<ReturnType<typeof binanceSource.loadBinanceSnapshot>>;
      vi.spyOn(binanceSource, 'loadBinanceSnapshot').mockResolvedValue(snapshot);
      vi.spyOn(binanceSource, 'startBinanceSync').mockResolvedValue({ state: 'STARTED', reasonCodes: [] });
      vi.spyOn(binanceSource, 'storeBinanceCredentials').mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({
            subject: 'alice', backend: new MemoryVaultBackend(),
          })}>
            <StoreProvider><Harness initialFupan={fupan} /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);

      await user.click(screen.getByRole('button', { name: 'restore fupan' }));
      await verificationStarted;
      await user.click(screen.getByRole('button', { name: buttonName }));
      await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('binance'));
      releaseVerification();

      await waitFor(() => {
        expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled');
        expect(screen.getByTestId('source')).toHaveTextContent('binance');
        expect(screen.getByTestId('session-phase')).toHaveTextContent('BINANCE_OBSERVED_READY');
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
    },
    60_000,
  );

  it.each(['demo', 'clear', 'lock'] as const)(
    'does not revive delayed automatic vault hydration after %s',
    async (action) => {
      const backend = new MemoryVaultBackend();
      const factory = () => new MemoryVaultRepository({ subject: 'alice', backend });
      const user = userEvent.setup();
      const first = render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={factory}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
      await user.click(screen.getByRole('button', { name: 'create' }));
      await waitForWorkspacePhase('RECOVERY_READY');
      const recoveryCode = screen.getByTestId('kit').textContent ?? '';
      await user.click(screen.getByRole('button', { name: 'ack recovery' }));
      await waitForWorkspaceGeneration(1);
      await user.click(screen.getByRole('button', { name: 'import' }));
      await waitForWorkspaceGeneration(2);
      first.unmount();

      const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const verificationStarted = new Promise<void>((resolve) => { started = resolve; });
      vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
        started();
        await gate;
        return originalVerify(ledger);
      });

      render(
        <AuthProvider runtime={authRuntime}>
          <WorkspaceProvider repositoryFactory={factory}>
            <StoreProvider><Harness /></StoreProvider>
          </WorkspaceProvider>
        </AuthProvider>,
      );
      await waitForWorkspacePhase('LOCKED');
      await user.type(screen.getByRole('textbox', { name: 'recovery' }), recoveryCode);
      await user.click(screen.getByRole('button', { name: 'unlock' }));
      await verificationStarted;
      await user.click(screen.getByRole('button', { name: action }));
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
      expect(screen.getByTestId('trade-count')).toHaveTextContent('62');
      release();
      await waitFor(() => {
        expect(screen.getByTestId('source')).toHaveTextContent('demo');
        expect(screen.getByTestId('trade-count')).toHaveTextContent('62');
      }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    },
    60_000,
  );

  it('does not switch the local session when the import head loses its CAS publish', async () => {
    class RejectSecondPublishRepository extends MemoryVaultRepository {
      private calls = 0;
      override async publishHead(input: PublishVaultHeadInput, options?: VaultOperationOptions): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls === 2) throw new VaultRepositoryError('CONFLICT');
        return super.publishHead(input, options);
      }
    }
    const repository = new RejectSecondPublishRepository({ subject: 'alice', backend: new MemoryVaultBackend() });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(
      () => expect(screen.getByTestId('import-runs')).toHaveTextContent('1'),
      { timeout: CRYPTO_STATE_TIMEOUT_MS },
    );
    expect(screen.getByTestId('generation')).toHaveTextContent('1');
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    expect(screen.getByTestId('ledger-fills')).toHaveTextContent('0');
  });

  it('does not let a late portable restore replace Demo after the user cancels it', async () => {
    class DeferredThirdPublishRepository extends MemoryVaultRepository {
      private calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      private markFinished!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

      release(): void { this.releaseGate(); }

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 3) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        try {
          return await super.publishHead(input, options);
        } finally {
          this.markFinished();
        }
      }
    }

    const backend = new MemoryVaultBackend();
    const repository = new DeferredThirdPublishRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'capture backup' }));
    await user.click(screen.getByRole('button', { name: 'demo' }));

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'demo' }));
    repository.release();
    await repository.finished;

    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it('never drains queued snapshots from one workspace into a newly created workspace', async () => {
    class DeferredThirdPublishRepository extends MemoryVaultRepository {
      calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      private markFinished!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

      release(): void { this.releaseGate(); }

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 3) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        try {
          return await super.publishHead(input, options);
        } finally {
          this.markFinished();
        }
      }
    }

    const backend = new MemoryVaultBackend();
    const repository = new DeferredThirdPublishRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    const firstWorkspaceId = screen.getByTestId('workspace-id').textContent;
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'review' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'journal' }));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-id').textContent).not.toBe(firstWorkspaceId);
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });

    repository.release();
    await repository.finished;
    await waitFor(() => {
      expect(repository.calls).toBe(4);
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it.each([
    ['demo', 'demo'],
    ['clear', 'clear'],
    ['lock', 'lock'],
  ] as const)('cancels an import already queued behind a write when the user chooses %s', async (_label, action) => {
    class DeferredSecondPublishRepository extends MemoryVaultRepository {
      calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      private markFinished!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

      release(): void { this.releaseGate(); }

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 2) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        try {
          return await super.publishHead(input, options);
        } finally {
          this.markFinished();
        }
      }
    }

    const repository = new DeferredSecondPublishRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);

    await user.click(screen.getByRole('button', { name: 'queue duplicate imports' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: action }));
    if (action === 'lock') {
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('LOCKED'));
    }
    repository.release();
    await repository.finished;

    await waitFor(() => {
      expect(screen.getByTestId('queued-import-results')).toHaveTextContent('false,false');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    });
    expect(repository.calls).toBe(2);
  });

  it('cancels imports queued before a portable backup restore, then commits the restore in queue order', async () => {
    class DeferredSecondPublishRepository extends MemoryVaultRepository {
      calls = 0;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      private markFinished!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

      release(): void { this.releaseGate(); }

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 2) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        try {
          throw new VaultRepositoryError('ABORTED');
        } finally {
          this.markFinished();
        }
      }
    }

    const backup = await completePortableBackupFixture();
    const repository = new DeferredSecondPublishRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'queue duplicate imports' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    // Release the older failed publish. The restore must wait for it rather
    // than abort it, then use the next authoritative generation.
    repository.release();
    await repository.finished;
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('queued-import-results')).toHaveTextContent('false,false');
      expect(screen.getByTestId('generation')).toHaveTextContent('2');
      expect(screen.getByTestId('source')).toHaveTextContent('imported');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(repository.calls).toBe(3);
  }, 30_000);

  it('serializes a portable restore behind an in-flight mutation and cancels the older queued mutation before save', async () => {
    class DeferredThirdPublishRepository extends MemoryVaultRepository {
      calls = 0;
      wasAborted = false;
      private releaseGate!: () => void;
      private markStarted!: () => void;
      readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
      private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

      release(): void { this.releaseGate(); }

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        if (this.calls !== 3) return super.publishHead(input, options);
        this.markStarted();
        await this.gate;
        this.wasAborted = options?.signal?.aborted === true;
        return super.publishHead(input, options);
      }
    }

    const backup = await completePortableBackupFixture();
    const repository = new DeferredThirdPublishRepository({
      subject: 'alice', backend: new MemoryVaultBackend(),
    });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'review' }));
    await repository.started;
    await user.click(screen.getByRole('button', { name: 'journal next day' }));
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    repository.release();

    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('mutation-result')).toHaveTextContent('failed');
      expect(screen.getByTestId('mutation-successes')).toHaveTextContent('0');
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('review-updated')).toHaveTextContent('200');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('1');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
    expect(repository.calls).toBe(4);
    expect(repository.wasAborted).toBe(false);
  }, 45_000);

  it('reserves the vault queue before restore verification so a newer mutation applies after the restored head', async () => {
    const backup = await completePortableBackupFixture();
    const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
      markVerificationStarted();
      await verificationGate;
      return originalVerify(ledger);
    });
    const repository = new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness initialBackup={backup} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);

    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await verificationStarted;
    await user.click(screen.getByRole('button', { name: 'journal next day' }));
    releaseVerification();

    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('restored');
      expect(screen.getByTestId('mutation-successes')).toHaveTextContent('1');
      expect(screen.getByTestId('generation')).toHaveTextContent('4');
      expect(screen.getByTestId('journal-count')).toHaveTextContent('2');
    }, { timeout: CRYPTO_STATE_TIMEOUT_MS });
  }, 45_000);

  it('rejects a portable backup before vault persistence when its restored session exceeds the .fupan ceiling', async () => {
    class CountPublishesRepository extends MemoryVaultRepository {
      calls = 0;
      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        this.calls += 1;
        return super.publishHead(input, options);
      }
    }
    const repository = new CountPublishesRepository({ subject: 'alice', backend: new MemoryVaultBackend() });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'capture backup' }));
    await user.click(screen.getByRole('button', { name: 'demo' }));

    const NativeTextEncoder = TextEncoder;
    class OversizeFupanEncoder extends NativeTextEncoder {
      override encode(value?: string): ReturnType<TextEncoder['encode']> {
        if (String(value).startsWith('{"format":"fupan/1"')) {
          return { byteLength: 12 * 1024 * 1024 + 1 } as ReturnType<TextEncoder['encode']>;
        }
        return super.encode(value);
      }
    }
    vi.stubGlobal('TextEncoder', OversizeFupanEncoder);
    await user.click(screen.getByRole('button', { name: 'restore backup' }));
    await waitFor(() => expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled'));
    expect(repository.calls).toBe(2);
    expect(screen.getByTestId('source')).toHaveTextContent('demo');
    vi.unstubAllGlobals();
  });

  it('rejects a vault restore whose resulting session cannot be exported as .fupan', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    const recoveryCode = screen.getByTestId('kit').textContent ?? '';
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitForWorkspaceGeneration(2);
    await user.click(screen.getByRole('button', { name: 'lock' }));
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('LOCKED'));

    const NativeTextEncoder = TextEncoder;
    class OversizeFupanEncoder extends NativeTextEncoder {
      override encode(value?: string): ReturnType<TextEncoder['encode']> {
        if (String(value).startsWith('{"format":"fupan/1"')) {
          return { byteLength: 12 * 1024 * 1024 + 1 } as ReturnType<TextEncoder['encode']>;
        }
        return super.encode(value);
      }
    }
    vi.stubGlobal('TextEncoder', OversizeFupanEncoder);
    await user.type(screen.getByLabelText('recovery'), recoveryCode);
    await user.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => {
      expect(screen.getByTestId('error-code')).toHaveTextContent('VAULT_ARCHIVE_INVALID');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    });
    vi.unstubAllGlobals();
  });

  it('rejects a browser-only .fupan restore whose resulting session exceeds the export ceiling', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() })}>
          <StoreProvider><Harness /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'import' }));
    await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('imported'));
    await user.click(screen.getByRole('button', { name: 'capture fupan' }));
    await user.click(screen.getByRole('button', { name: 'demo' }));

    const NativeTextEncoder = TextEncoder;
    class OversizeFupanEncoder extends NativeTextEncoder {
      override encode(value?: string): ReturnType<TextEncoder['encode']> {
        if (String(value).startsWith('{"format":"fupan/1"')) {
          return { byteLength: 12 * 1024 * 1024 + 1 } as ReturnType<TextEncoder['encode']>;
        }
        return super.encode(value);
      }
    }
    vi.stubGlobal('TextEncoder', OversizeFupanEncoder);
    await user.click(screen.getByRole('button', { name: 'restore fupan' }));
    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('rejected');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    });
    vi.unstubAllGlobals();
  });

  it.each([
    ['demo', 'demo'],
    ['clear', 'clear'],
    ['lock', 'lock'],
  ] as const)('does not revive a .fupan restore after ledger verification when the user chooses %s', async (_label, action) => {
    let releaseVerification!: () => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const originalVerify = fillLedger.verifyCsvFillLedgerIntegrity;
    vi.spyOn(fillLedger, 'verifyCsvFillLedgerIntegrity').mockImplementation(async (ledger) => {
      markVerificationStarted();
      await verificationGate;
      return originalVerify(ledger);
    });
    const fixture = parseStatement(CSV, null);
    if (fixture.error !== undefined) throw new Error(fixture.error);
    const created = await fillLedger.createCsvFillLedger('restore-test-ledger', {
      fills: fixture.fills,
      meta: fixture.meta,
      contract: fixture.contract,
      diagnostics: fixture.diagnostics,
    });
    const ledger = created.ledger;
    const replay = fillLedger.replayCsvFillLedger(ledger);
    const fupan = JSON.stringify(fillLedger.withCsvFillLedger(
      exportArchive([...replay.trades], replay.meta),
      ledger,
    ));

    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => new MemoryVaultRepository({ subject: 'alice', backend: new MemoryVaultBackend() })}>
          <StoreProvider><Harness initialFupan={fupan} /></StoreProvider>
        </WorkspaceProvider>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('NEEDS_SETUP'));
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitForWorkspacePhase('RECOVERY_READY');
    await user.click(screen.getByRole('button', { name: 'ack recovery' }));
    await waitForWorkspaceGeneration(1);
    await user.click(screen.getByRole('button', { name: 'restore fupan' }));
    await verificationStarted;
    await user.click(screen.getByRole('button', { name: action }));
    if (action === 'lock') {
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('LOCKED'));
    } else {
      await waitFor(() => expect(screen.getByTestId('source')).toHaveTextContent('demo'));
    }
    releaseVerification();

    await waitFor(() => {
      expect(screen.getByTestId('restore-result')).toHaveTextContent('cancelled');
      expect(screen.getByTestId('source')).toHaveTextContent('demo');
    });
  });
});
