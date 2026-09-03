import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthRuntime } from './auth-context';
import { saveAuthSession } from './auth-session-storage';
import {
  MemoryVaultBackend,
  MemoryVaultRepository,
  VaultRepositoryError,
  type PublishVaultHeadInput,
  type VaultHead,
  type VaultOperationOptions,
} from './vault-repository';
import { WorkspaceProvider, useWorkspace } from './workspace-context';
import { WORKSPACE_SNAPSHOT_FORMAT, type WorkspaceSnapshotV1 } from './workspace-snapshot';
import { isRootRecoveryKit, type RecoveryKit } from './recovery-code';

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

let observedRecoveryKit: RecoveryKit | null = null;

function Harness() {
  const workspace = useWorkspace();
  observedRecoveryKit = workspace.recoveryKit;
  const [code, setCode] = useState('');
  const [saveSettled, setSaveSettled] = useState(false);
  return (
    <div>
      <span>{workspace.phase}</span>
      <span data-testid="generation">{workspace.unlocked?.generation ?? 0}</span>
      <span data-testid="kit">{workspace.recoveryKit?.recoveryCode ?? ''}</span>
      <span data-testid="kit-acknowledged">{workspace.recoveryKitAcknowledged ? 'yes' : 'no'}</span>
      <button type="button" onClick={() => void workspace.createWorkspace()}>create</button>
      <button type="button" onClick={workspace.lockWorkspace}>lock</button>
      <input aria-label="recovery" value={code} onChange={(event) => setCode(event.target.value)} />
      <button type="button" onClick={() => void workspace.unlockWorkspace(code)}>unlock</button>
      <button type="button" onClick={workspace.dismissRecoveryKit}>ack</button>
      <button type="button" onClick={() => void workspace.saveSnapshot({
        format: WORKSPACE_SNAPSHOT_FORMAT,
        createdAt: Date.now(),
        engineVersion: '2.0.0-alpha',
        source: { kind: 'empty', accepted: 0, dropped: 0, coverage: 'unknown', importedAt: Date.now() },
        archive: null,
        reviews: {},
        actions: {},
        journal: [],
        guards: [],
      } satisfies Omit<WorkspaceSnapshotV1, 'generation'>).finally(() => setSaveSettled(true))}>save</button>
      <span data-testid="save-settled">{saveSettled ? 'settled' : 'pending'}</span>
    </div>
  );
}

class DeferredPublishRepository extends MemoryVaultRepository {
  private calls = 0;
  private releaseGate!: () => void;
  private markStarted!: () => void;
  private markFinished!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  readonly finished = new Promise<void>((resolve) => { this.markFinished = resolve; });
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  constructor(options: ConstructorParameters<typeof MemoryVaultRepository>[0], private readonly rejectLate: boolean) {
    super(options);
  }

  release(): void { this.releaseGate(); }

  override async publishHead(
    input: PublishVaultHeadInput,
    options?: VaultOperationOptions,
  ): Promise<VaultHead> {
    this.calls += 1;
    if (this.calls === 1) return super.publishHead(input, options);
    this.markStarted();
    await this.gate;
    try {
      if (this.rejectLate) throw new VaultRepositoryError('REMOTE_UNAVAILABLE');
      return await super.publishHead(input, options);
    } finally {
      this.markFinished();
    }
  }
}

describe('WorkspaceProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    observedRecoveryKit = null;
    saveAuthSession(session);
  });

  it('prepares locally, commits only after acknowledgement, locks, and restores without persisting secrets', async () => {
    const backend = new MemoryVaultBackend();
    const factory = () => new MemoryVaultRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={factory}>
          <Harness />
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('NEEDS_SETUP')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitFor(() => expect(screen.getByText('RECOVERY_READY')).toBeInTheDocument(), { timeout: 5_000 });
    const code = screen.getByTestId('kit').textContent ?? '';
    expect(code).toMatch(/^rvk1_/);
    expect(observedRecoveryKit && isRootRecoveryKit(observedRecoveryKit)).toBe(true);
    if (!observedRecoveryKit || !isRootRecoveryKit(observedRecoveryKit)) {
      throw new Error('expected an in-memory v2 recovery kit');
    }
    const privateRoot = observedRecoveryKit.signingPrivateKeyPkcs8;
    expect(screen.getByTestId('generation')).toHaveTextContent('0');
    expect(backend.users.size).toBe(0);
    expect(localStorage.getItem('rv-production-device-v1')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).not.toContain(code);
    expect(JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })).not.toContain(privateRoot);

    await user.click(screen.getByRole('button', { name: 'ack' }));
    await waitFor(() => expect(screen.getByText('UNLOCKED')).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByTestId('generation')).toHaveTextContent('1');
    expect(backend.users.size).toBe(1);
    await user.click(screen.getByRole('button', { name: 'lock' }));
    expect(screen.getByText('LOCKED')).toBeInTheDocument();
    await user.type(screen.getByLabelText('recovery'), code);
    await user.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => expect(screen.getByText('UNLOCKED')).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByTestId('generation')).toHaveTextContent('1');
  });

  it.each([
    ['late success', false],
    ['late failure', true],
  ])('does not revive an unlocked snapshot after lock on %s', async (_label, rejectLate) => {
    const backend = new MemoryVaultBackend();
    const repository = new DeferredPublishRepository({ subject: 'alice', backend }, rejectLate);
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <Harness />
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('NEEDS_SETUP')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitFor(() => expect(screen.getByText('RECOVERY_READY')).toBeInTheDocument(), { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: 'ack' }));
    await waitFor(() => expect(screen.getByText('UNLOCKED')).toBeInTheDocument(), { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await repository.started;

    await user.click(screen.getByRole('button', { name: 'lock' }));
    expect(screen.getByText('LOCKED')).toBeInTheDocument();
    repository.release();
    await repository.finished;

    await waitFor(() => {
      expect(screen.getByTestId('save-settled')).toHaveTextContent('settled');
      expect(screen.getByText('LOCKED')).toBeInTheDocument();
      expect(screen.getByTestId('generation')).toHaveTextContent('0');
    });
  });

  it('blocks every remote mutation and every snapshot write until the recovery kit is acknowledged', async () => {
    const backend = new MemoryVaultBackend();
    const repository = new MemoryVaultRepository({ subject: 'alice', backend });
    const user = userEvent.setup();
    render(
      <AuthProvider runtime={authRuntime}>
        <WorkspaceProvider repositoryFactory={() => repository}>
          <Harness />
        </WorkspaceProvider>
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText('NEEDS_SETUP')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'create' }));
    await waitFor(() => expect(screen.getByText('RECOVERY_READY')).toBeInTheDocument());
    expect(screen.getByTestId('generation')).toHaveTextContent('0');
    expect(screen.getByTestId('kit-acknowledged')).toHaveTextContent('no');
    expect(backend.users.size).toBe(0);

    await user.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(screen.getByTestId('save-settled')).toHaveTextContent('settled'));
    expect(screen.getByTestId('generation')).toHaveTextContent('0');
    expect(backend.users.size).toBe(0);

    await user.click(screen.getByRole('button', { name: 'ack' }));
    await waitFor(() => {
      expect(screen.getByTestId('kit-acknowledged')).toHaveTextContent('yes');
      expect(screen.getByTestId('generation')).toHaveTextContent('1');
    }, { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(screen.getByTestId('generation')).toHaveTextContent('2'));
  });
});
