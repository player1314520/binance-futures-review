import { describe, expect, it } from 'vitest';
import { exportArchive } from '@rv/engine';
import {
  MemoryVaultBackend,
  MemoryVaultRepository,
  VaultRepositoryError,
  type ActiveVaultGeneration,
  type UploadVaultGenerationInput,
  type VaultHead,
  type VaultOperationOptions,
} from './vault-repository';
import { VaultCryptoError } from './vault-crypto';
import {
  deriveVaultWriteCapability,
  generateVaultSigningKeyPair,
} from './vault-signing';
import { WORKSPACE_SNAPSHOT_FORMAT } from './workspace-snapshot';
import { WorkspaceVaultError, WorkspaceVaultService } from './workspace-vault-service';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_A = '22222222-2222-4222-8222-222222222222';
const SECRET = 'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
const ARCHIVE = exportArchive([{
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

function snapshot(generation: number, action = '进场前写失效条件') {
  return {
    format: WORKSPACE_SNAPSHOT_FORMAT,
    generation,
    createdAt: 1_700_000_100_000 + generation,
    engineVersion: '2.0.0-alpha',
    source: { kind: 'csv' as const, accepted: 1, dropped: 0, coverage: 'complete' as const, importedAt: 1_700_000_100_000 },
    archive: ARCHIVE,
    reviews: {},
    actions: { marker: { id: 'marker', sourceTradeId: 'trade-1', text: action, status: 'open' as const, createdAt: 1, updatedAt: 1, completedAt: null } },
    journal: [],
    guards: [],
  };
}

async function setup(repository?: MemoryVaultRepository) {
  const backend = new MemoryVaultBackend();
  const repo = repository ?? new MemoryVaultRepository({ subject: 'alice', backend });
  const keys = await generateVaultSigningKeyPair();
  const capability = await deriveVaultWriteCapability(SECRET, WORKSPACE_ID);
  const service = new WorkspaceVaultService(repo, 'alice', WORKSPACE_ID, DEVICE_A, keys.publicKeySpki);
  await service.bootstrap(capability);
  return { backend, repo, keys, capability, service };
}

class CorruptActiveRepository extends MemoryVaultRepository {
  override async readActiveGeneration(
    workspaceId: string,
    options?: VaultOperationOptions,
  ): Promise<ActiveVaultGeneration | null> {
    const active = await super.readActiveGeneration(workspaceId, options);
    if (!active) return null;
    const bytes = new Uint8Array(active.object.encryptedEnvelope);
    bytes[bytes.length - 1] ^= 1;
    return { ...active, object: { ...active.object, encryptedEnvelope: bytes } };
  }
}

class LostResponseRepository extends MemoryVaultRepository {
  override async uploadGeneration(input: UploadVaultGenerationInput, options?: VaultOperationOptions) {
    const uploaded = await super.uploadGeneration(input, options);
    if (input.generation === 2) {
      throw new VaultRepositoryError('REMOTE_UNAVAILABLE', { outcome: 'UNKNOWN' });
    }
    return uploaded;
  }

  override async publishHead(input: Parameters<MemoryVaultRepository['publishHead']>[0], options?: VaultOperationOptions): Promise<VaultHead> {
    const head = await super.publishHead(input, options);
    if (head.generation === 2) {
      throw new VaultRepositoryError('REMOTE_UNAVAILABLE', { outcome: 'UNKNOWN' });
    }
    return head;
  }
}

describe('WorkspaceVaultService signed recovery loop', () => {
  it('signs the encrypted wrapper, restores it, and keeps the private key out of repository/local storage', async () => {
    const { backend, keys, capability, service } = await setup();
    const saved = await service.save(snapshot(1), SECRET, 0, keys.privateKeyPkcs8, capability, null);
    await expect(service.load(SECRET)).resolves.toMatchObject({
      snapshot: { generation: 1, actions: { marker: { text: '进场前写失效条件' } } },
      recoveredFromHistory: false,
    });
    expect(saved.object.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(backend)).not.toContain(keys.privateKeyPkcs8);
    expect(JSON.stringify(backend)).not.toContain(capability);
    expect(JSON.stringify({ ...localStorage })).not.toContain(keys.privateKeyPkcs8);
  });

  it('verifies the root signature before AEAD, while a valid signature with the wrong recovery code still fails', async () => {
    const { keys, capability, service } = await setup();
    await service.save(snapshot(1), SECRET, 0, keys.privateKeyPkcs8, capability, null);
    await expect(service.load('rvk1_AQECAwQFBgcICQoLDA0ODxAREhMUFRYX'))
      .rejects.toBeInstanceOf(VaultCryptoError);
  });

  it('falls back to the newest valid signed+AEAD history and marks it read-only', async () => {
    const backend = new MemoryVaultBackend();
    const repository = new CorruptActiveRepository({ subject: 'alice', backend });
    const { keys, capability, service } = await setup(repository);
    const first = await service.save(snapshot(1), SECRET, 0, keys.privateKeyPkcs8, capability, null);
    await service.save(snapshot(2, '第二代'), SECRET, 1, keys.privateKeyPkcs8, capability, first.object);

    await expect(service.load(SECRET)).resolves.toMatchObject({
      snapshot: { generation: 1 },
      head: { generation: 1 },
      activeHead: { generation: 2 },
      recoveredFromHistory: true,
    });
  });

  it('reconciles lost upload and publish responses instead of blind retrying or falsely failing', async () => {
    const backend = new MemoryVaultBackend();
    const repository = new LostResponseRepository({ subject: 'alice', backend });
    const { keys, capability, service } = await setup(repository);
    const first = await service.save(snapshot(1), SECRET, 0, keys.privateKeyPkcs8, capability, null);
    await expect(service.save(
      snapshot(2), SECRET, 1, keys.privateKeyPkcs8, capability, first.object,
    )).resolves.toMatchObject({ head: { generation: 2 } });
  });

  it('rejects generation gaps before encryption/upload', async () => {
    const { keys, capability, service } = await setup();
    await expect(service.save(snapshot(2), SECRET, 0, keys.privateKeyPkcs8, capability, null))
      .rejects.toEqual(new WorkspaceVaultError('GENERATION_MISMATCH'));
  });
});
