import {
  VaultRepositoryError,
  type VaultObject,
  type VaultOperationOptions,
  type VaultRepository,
  type VaultWorkspace,
} from './vault-repository';
import {
  createRootRecoveryKit,
  generateRecoveryCode,
  isRootRecoveryKit,
  normalizeRecoveryCode,
  type RecoveryKit,
  type RootRecoveryKit,
} from './recovery-code';
import {
  deriveVaultWriteCapability,
  generateVaultSigningKeyPair,
  signVaultObject,
  verifyVaultObjectSignature,
  type VaultObjectSignatureInput,
} from './vault-signing';
import type { WorkspaceSnapshotV1 } from './workspace-snapshot';
import { WORKSPACE_SNAPSHOT_FORMAT } from './workspace-snapshot';
import { WorkspaceVaultError, WorkspaceVaultService } from './workspace-vault-service';

export type UnlockedWorkspace = Readonly<{
  workspace: VaultWorkspace;
  snapshot: WorkspaceSnapshotV1 | null;
  generation: number;
  recoveredFromHistory: boolean;
  activeHead: VaultWorkspace['head'];
  readOnlyRecovery: boolean;
}>;

type SigningSession = {
  signingPrivateKeyPkcs8: string;
  writeCapability: string;
  parent: Pick<VaultObject, 'objectId' | 'generation' | 'ciphertextSha256'> | null;
  signingPublicKey: string;
  readOnlyRecovery: boolean;
};

const KEY_PAIR_PROBE_OBJECT_ID = '00000000-0000-4000-8000-000000000001';
const KEY_PAIR_PROBE_SHA256 = '0'.repeat(64);

function emptySnapshot(): WorkspaceSnapshotV1 {
  const now = Date.now();
  return Object.freeze({
    format: WORKSPACE_SNAPSHOT_FORMAT,
    generation: 1,
    createdAt: now,
    engineVersion: '2.0.0-alpha',
    source: {
      kind: 'empty' as const,
      accepted: 0,
      dropped: 0,
      coverage: 'unknown' as const,
      importedAt: now,
    },
    archive: null,
    reviews: {},
    actions: {},
    journal: [],
    guards: [],
  });
}

function reconciliationOptions(options: VaultOperationOptions): VaultOperationOptions {
  return options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
}

export class WorkspaceController {
  private readonly signingSessions = new Map<string, SigningSession>();

  constructor(
    private readonly repository: VaultRepository,
    private readonly userId: string,
    private readonly deviceId: string,
  ) {}

  list(options: VaultOperationOptions = {}): Promise<readonly VaultWorkspace[]> {
    return this.repository.listWorkspaces(options);
  }

  /** Purely local preparation.  No repository method is called here. */
  async prepare(): Promise<RootRecoveryKit> {
    if (typeof crypto.randomUUID !== 'function') throw new Error('SECURE_WORKSPACE_ID_UNAVAILABLE');
    const workspaceId = crypto.randomUUID();
    const recoveryCode = generateRecoveryCode();
    const keys = await generateVaultSigningKeyPair();
    return createRootRecoveryKit(
      workspaceId,
      recoveryCode,
      keys.publicKeySpki,
      keys.privateKeyPkcs8,
    );
  }

  private keyPairProbe(kit: RootRecoveryKit): VaultObjectSignatureInput {
    return Object.freeze({
      userId: this.userId,
      workspaceId: kit.workspaceId,
      objectId: KEY_PAIR_PROBE_OBJECT_ID,
      generation: 1,
      envelopeVersion: 1,
      ciphertextSha256: KEY_PAIR_PROBE_SHA256,
      parentObjectId: null,
      parentCiphertextSha256: null,
    });
  }

  private async assertRecoveryRoot(kit: RootRecoveryKit): Promise<void> {
    const input = this.keyPairProbe(kit);
    const proof = await signVaultObject(kit.signingPrivateKeyPkcs8, input);
    if (!await verifyVaultObjectSignature(kit.signingPublicKeySpki, input, proof)) {
      throw new WorkspaceVaultError('SIGNATURE_INTEGRITY_FAILED');
    }
  }

  private activate(
    workspace: VaultWorkspace,
    restored: Readonly<{
      snapshot: WorkspaceSnapshotV1;
      head: NonNullable<VaultWorkspace['head']>;
      activeHead: NonNullable<VaultWorkspace['head']>;
      recoveredFromHistory: boolean;
      signingPrivateKeyPkcs8: string;
      sourceObject: VaultObject;
    }>,
    kit: RootRecoveryKit,
    writeCapability: string,
  ): UnlockedWorkspace {
    if (restored.signingPrivateKeyPkcs8 !== kit.signingPrivateKeyPkcs8) {
      throw new WorkspaceVaultError('SIGNATURE_INTEGRITY_FAILED');
    }
    this.signingSessions.set(kit.workspaceId, {
      signingPrivateKeyPkcs8: kit.signingPrivateKeyPkcs8,
      writeCapability,
      parent: restored.sourceObject,
      signingPublicKey: kit.signingPublicKeySpki,
      readOnlyRecovery: restored.recoveredFromHistory,
    });
    const activeWorkspace = Object.freeze({ ...workspace, head: restored.activeHead });
    return Object.freeze({
      workspace: activeWorkspace,
      snapshot: restored.snapshot,
      generation: restored.head.generation,
      recoveredFromHistory: restored.recoveredFromHistory,
      activeHead: restored.activeHead,
      readOnlyRecovery: restored.recoveredFromHistory,
    });
  }

  /**
   * Commits a previously downloaded v2 kit.  Reusing the same kit is safe:
   * bootstrap is immutable/idempotent and an already-published first head is
   * verified and adopted before another generation is attempted.
   */
  async commitPrepared(
    recoveryKit: RecoveryKit,
    options: VaultOperationOptions = {},
  ): Promise<UnlockedWorkspace> {
    if (!isRootRecoveryKit(recoveryKit)) throw new WorkspaceVaultError('IDENTITY_INVALID');
    const kit = createRootRecoveryKit(
      recoveryKit.workspaceId,
      recoveryKit.recoveryCode,
      recoveryKit.signingPublicKeySpki,
      recoveryKit.signingPrivateKeyPkcs8,
      recoveryKit.createdAt,
    );
    await this.assertRecoveryRoot(kit);
    const writeCapability = await deriveVaultWriteCapability(kit.recoveryCode, kit.workspaceId);
    const service = new WorkspaceVaultService(
      this.repository,
      this.userId,
      kit.workspaceId,
      this.deviceId,
      kit.signingPublicKeySpki,
    );
    const workspace = await service.bootstrap(writeCapability, options);
    const existing = await service.load(kit.recoveryCode, options);
    if (existing) return this.activate(workspace, existing, kit, writeCapability);

    const initialSnapshot = emptySnapshot();
    try {
      const saved = await service.save(
        initialSnapshot,
        kit.recoveryCode,
        0,
        kit.signingPrivateKeyPkcs8,
        writeCapability,
        null,
        options,
      );
      this.signingSessions.set(kit.workspaceId, {
        signingPrivateKeyPkcs8: kit.signingPrivateKeyPkcs8,
        writeCapability,
        parent: saved.object,
        signingPublicKey: kit.signingPublicKeySpki,
        readOnlyRecovery: false,
      });
      const activeWorkspace = Object.freeze({ ...workspace, head: saved.head });
      return Object.freeze({
        workspace: activeWorkspace,
        snapshot: initialSnapshot,
        generation: 1,
        recoveredFromHistory: false,
        activeHead: saved.head,
        readOnlyRecovery: false,
      });
    } catch (error) {
      const shouldReconcile = (
        (error instanceof VaultRepositoryError && (
          error.code === 'CONFLICT'
          || error.outcome === 'UNKNOWN'
        ))
        || (error instanceof WorkspaceVaultError && error.code === 'MUTATION_OUTCOME_UNKNOWN')
      );
      if (!shouldReconcile) throw error;
      const restored = await service.load(kit.recoveryCode, reconciliationOptions(options));
      if (!restored) throw error;
      return this.activate(workspace, restored, kit, writeCapability);
    }
  }

  async unlock(
    workspace: VaultWorkspace,
    recoveryCodeInput: string,
    options: VaultOperationOptions = {},
  ): Promise<UnlockedWorkspace> {
    const recoveryCode = normalizeRecoveryCode(recoveryCodeInput);
    const writeCapability = await deriveVaultWriteCapability(recoveryCode, workspace.workspaceId);
    const service = new WorkspaceVaultService(
      this.repository,
      this.userId,
      workspace.workspaceId,
      this.deviceId,
      workspace.signingPublicKey,
    );
    await service.registerDevice(writeCapability, options);
    const restored = await service.load(recoveryCode, options);
    if (!restored) {
      throw new WorkspaceVaultError('SNAPSHOT_INTEGRITY_FAILED');
    }
    this.signingSessions.set(workspace.workspaceId, {
      signingPrivateKeyPkcs8: restored.signingPrivateKeyPkcs8,
      writeCapability,
      parent: restored.sourceObject,
      signingPublicKey: workspace.signingPublicKey,
      readOnlyRecovery: restored.recoveredFromHistory,
    });
    return Object.freeze({
      workspace: Object.freeze({ ...workspace, head: restored.activeHead }),
      snapshot: restored.snapshot,
      generation: restored.head.generation,
      recoveredFromHistory: restored.recoveredFromHistory,
      activeHead: restored.activeHead,
      readOnlyRecovery: restored.recoveredFromHistory,
    });
  }

  async save(
    workspaceId: string,
    recoveryCodeInput: string,
    snapshot: WorkspaceSnapshotV1,
    expectedGeneration: number,
    options: VaultOperationOptions = {},
  ) {
    const session = this.signingSessions.get(workspaceId);
    if (!session) throw new WorkspaceVaultError('IDENTITY_INVALID');
    if (session.readOnlyRecovery) throw new WorkspaceVaultError('RECOVERED_HISTORY_READ_ONLY');
    const recoveryCode = normalizeRecoveryCode(recoveryCodeInput);
    const capability = await deriveVaultWriteCapability(recoveryCode, workspaceId);
    if (capability !== session.writeCapability) throw new WorkspaceVaultError('IDENTITY_INVALID');
    const service = new WorkspaceVaultService(
      this.repository,
      this.userId,
      workspaceId,
      this.deviceId,
      session.signingPublicKey,
    );
    const saved = await service.save(
      snapshot,
      recoveryCode,
      expectedGeneration,
      session.signingPrivateKeyPkcs8,
      session.writeCapability,
      session.parent,
      options,
    );
    session.parent = saved.object;
    return saved.head;
  }

  lock(workspaceId?: string): void {
    if (workspaceId) this.signingSessions.delete(workspaceId);
    else this.signingSessions.clear();
  }

  dispose(): void {
    this.signingSessions.clear();
  }

  static isRecoverableConflict(error: unknown): boolean {
    return error instanceof VaultRepositoryError && error.code === 'CONFLICT';
  }
}
