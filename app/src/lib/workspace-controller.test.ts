import { beforeEach, describe, expect, it } from 'vitest';
import { exportArchive } from '@rv/engine';
import { clearDeviceId, getOrCreateDeviceId } from './device-id';
import {
  MemoryVaultBackend,
  MemoryVaultRepository,
  VaultRepositoryError,
  type ActiveVaultGeneration,
  type BootstrapWorkspaceInput,
  type PublishVaultHeadInput,
  type VaultHead,
  type VaultOperationOptions,
  type VaultWorkspace,
} from './vault-repository';
import { WORKSPACE_SNAPSHOT_FORMAT } from './workspace-snapshot';
import type { JsonValue } from './canonical-json';
import { WorkspaceController } from './workspace-controller';

const DEVICE_A = '22222222-2222-4222-8222-222222222222';
const DEVICE_B = '33333333-3333-4333-8333-333333333333';

const archive = exportArchive([{
  id: 'trade-1',
  symbol: 'BTCUSDT',
  market: 'USDM',
  side: 'LONG',
  entryTime: 1_700_000_000_000,
  exitTime: 1_700_000_060_000,
  entryPrice: 60_000,
  exitPrice: 60_100,
  qty: 0.01,
  fee: 0.2,
  pnl: 1,
  currency: 'USDT',
  source: 'csv-report',
}], { source: 'csv-report' });

function controller(backend: MemoryVaultBackend, subject = 'alice', deviceId = DEVICE_A) {
  return new WorkspaceController(
    new MemoryVaultRepository({ subject, backend }),
    subject,
    deviceId,
  );
}

describe('WorkspaceController recovery lifecycle', () => {
  beforeEach(() => localStorage.clear());

  it('persists a non-secret stable device id and can explicitly rotate it', () => {
    const first = getOrCreateDeviceId();
    expect(getOrCreateDeviceId()).toBe(first);
    clearDeviceId();
    expect(getOrCreateDeviceId()).not.toBe(first);
  });

  it('prepares the complete recovery root before any remote mutation, then commits it', async () => {
    const backend = new MemoryVaultBackend();
    const first = controller(backend);
    const kit = await first.prepare();
    expect(kit).toMatchObject({
      format: 'rv-recovery-kit/2',
      recoveryCode: expect.stringMatching(/^rvk1_/),
      signingAlgorithm: 'ed25519-v1',
      signingPublicKeySpki: expect.any(String),
      signingPrivateKeyPkcs8: expect.any(String),
    });
    expect(backend.users.size).toBe(0);

    const created = await first.commitPrepared(kit);
    expect(created).toMatchObject({ generation: 1, snapshot: { source: { kind: 'empty' } } });

    const second = controller(backend, 'alice', DEVICE_B);
    const listed = await second.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].signingPublicKey).toBe(kit.signingPublicKeySpki);
    await expect(second.unlock(listed[0], kit.recoveryCode)).resolves.toMatchObject({
      generation: 1,
      snapshot: { format: WORKSPACE_SNAPSHOT_FORMAT, archive: null },
    });
    await expect(second.unlock(
      listed[0],
      'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
    )).rejects.toEqual(expect.objectContaining({ code: 'FORBIDDEN' } satisfies Partial<VaultRepositoryError>));
  });

  it('saves the first real imported generation and restores it on another device', async () => {
    const backend = new MemoryVaultBackend();
    const first = controller(backend);
    const kit = await first.prepare();
    const created = await first.commitPrepared(kit);
    const realSnapshot = {
      format: WORKSPACE_SNAPSHOT_FORMAT,
      generation: 2,
      createdAt: Date.now(),
      engineVersion: '2.0.0-alpha',
      source: { kind: 'csv' as const, accepted: 1, dropped: 0, coverage: 'complete' as const, importedAt: Date.now() },
      archive: archive as unknown as JsonValue,
      reviews: {},
      actions: {},
      journal: [],
      guards: [],
    };
    await first.save(
      created.workspace.workspaceId,
      kit.recoveryCode,
      realSnapshot,
      1,
    );

    const second = controller(backend, 'alice', DEVICE_B);
    const restored = await second.unlock(
      (await second.list())[0],
      kit.recoveryCode,
    );
    expect(restored).toMatchObject({
      generation: 2,
      snapshot: { source: { kind: 'csv', accepted: 1 } },
    });
  });

  it('retries the same immutable root in a new session after bootstrap applied but its response was lost', async () => {
    class LoseBootstrapResponseRepository extends MemoryVaultRepository {
      private loseOnce = true;

      override async bootstrapWorkspace(
        input: BootstrapWorkspaceInput,
        options?: VaultOperationOptions,
      ): Promise<VaultWorkspace> {
        const workspace = await super.bootstrapWorkspace(input, options);
        if (this.loseOnce) {
          this.loseOnce = false;
          throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
            retryable: false,
            outcome: 'UNKNOWN',
          });
        }
        return workspace;
      }
    }

    const backend = new MemoryVaultBackend();
    const first = new WorkspaceController(
      new LoseBootstrapResponseRepository({ subject: 'alice', backend }),
      'alice',
      DEVICE_A,
    );
    const durableKit = await first.prepare();
    await expect(first.commitPrepared(durableKit)).rejects.toEqual(expect.objectContaining({
      outcome: 'UNKNOWN',
    }));

    const afterLostResponse = controller(backend, 'alice', DEVICE_B);
    const headless = await afterLostResponse.list();
    expect(headless).toHaveLength(1);
    expect(headless[0]).toMatchObject({
      workspaceId: durableKit.workspaceId,
      signingPublicKey: durableKit.signingPublicKeySpki,
      head: null,
    });
    await expect(afterLostResponse.commitPrepared(durableKit)).resolves.toMatchObject({
      generation: 1,
      workspace: { signingPublicKey: durableKit.signingPublicKeySpki },
    });
  });

  it('adopts the exact persisted first head in a new session after publish response and reconciliation are lost', async () => {
    class LosePublishedHeadResponseRepository extends MemoryVaultRepository {
      private headWasPublished = false;

      override async publishHead(
        input: PublishVaultHeadInput,
        options?: VaultOperationOptions,
      ): Promise<VaultHead> {
        const head = await super.publishHead(input, options);
        this.headWasPublished = true;
        throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
          retryable: false,
          outcome: 'UNKNOWN',
          cause: head,
        });
      }

      override async readActiveGeneration(
        workspaceId: string,
        options?: VaultOperationOptions,
      ): Promise<ActiveVaultGeneration | null> {
        if (this.headWasPublished) {
          throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
            retryable: false,
            outcome: 'UNKNOWN',
          });
        }
        return super.readActiveGeneration(workspaceId, options);
      }
    }

    const backend = new MemoryVaultBackend();
    const first = new WorkspaceController(
      new LosePublishedHeadResponseRepository({ subject: 'alice', backend }),
      'alice',
      DEVICE_A,
    );
    const durableKit = await first.prepare();
    await expect(first.commitPrepared(durableKit)).rejects.toEqual(expect.objectContaining({
      outcome: 'UNKNOWN',
    }));

    // Simulate the original tab closing: the second controller has no signing
    // session and receives only the previously downloaded v2 kit.
    first.dispose();
    const restarted = controller(backend, 'alice', DEVICE_B);
    const listed = await restarted.list();
    expect(listed[0]).toMatchObject({
      workspaceId: durableKit.workspaceId,
      signingPublicKey: durableKit.signingPublicKeySpki,
      head: { generation: 1 },
    });
    const resumed = await restarted.commitPrepared(durableKit);
    expect(resumed).toMatchObject({ generation: 1, recoveredFromHistory: false });
    expect(resumed.workspace.signingPublicKey).toBe(durableKit.signingPublicKeySpki);
  });
});
