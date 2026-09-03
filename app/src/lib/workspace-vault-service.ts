import {
  decryptVaultPayload,
  deserializeVaultEnvelope,
  encryptVaultPayload,
  serializeVaultEnvelope,
  VaultCryptoError,
  type VaultAad,
} from './vault-crypto';
import {
  VAULT_ENVELOPE_VERSION,
  VaultRepositoryError,
  type ActiveVaultGeneration,
  type VaultHead,
  type VaultObject,
  type VaultOperationOptions,
  type VaultRepository,
  type VaultWorkspace,
} from './vault-repository';
import {
  createSignedVaultPayload,
  deriveVaultWriteCapability,
  parseSignedVaultPayload,
  sha256Hex,
  signVaultObject,
  verifyVaultObjectSignature,
  type VaultObjectSignatureInput,
} from './vault-signing';
import {
  normalizeWorkspaceSnapshot,
  type WorkspaceSnapshotV1,
} from './workspace-snapshot';

const SNAPSHOT_KIND = 'workspace-snapshot';
const SNAPSHOT_LOGICAL_KEY = 'primary';
const SNAPSHOT_SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 8;
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceVaultError extends Error {
  constructor(
    readonly code:
      | 'IDENTITY_INVALID'
      | 'GENERATION_MISMATCH'
      | 'SNAPSHOT_INTEGRITY_FAILED'
      | 'SIGNATURE_INTEGRITY_FAILED'
      | 'RECOVERED_HISTORY_READ_ONLY'
      | 'MUTATION_OUTCOME_UNKNOWN',
  ) {
    super(code);
    this.name = 'WorkspaceVaultError';
  }
}

export type WorkspaceVaultLoadResult = Readonly<{
  snapshot: WorkspaceSnapshotV1;
  head: VaultHead;
  activeHead: VaultHead;
  recoveredFromHistory: boolean;
  signingPrivateKeyPkcs8: string;
  sourceObject: VaultObject;
}>;

export type WorkspaceVaultSaveResult = Readonly<{
  head: VaultHead;
  object: Omit<VaultObject, 'encryptedEnvelope'>;
}>;

function aad(userId: string, workspaceId: string, generation: number): VaultAad {
  return Object.freeze({
    user: userId,
    workspace: workspaceId,
    kind: SNAPSHOT_KIND,
    logicalKey: SNAPSHOT_LOGICAL_KEY,
    generation,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  });
}

function requireIdentity(
  userId: string,
  workspaceId: string,
  deviceId: string,
  signingPublicKey: string,
): void {
  if (
    !ID_PATTERN.test(userId)
    || !UUID_PATTERN.test(workspaceId)
    || !UUID_PATTERN.test(deviceId)
    || !/^[A-Za-z0-9_-]{16,1024}$/.test(signingPublicKey)
  ) throw new WorkspaceVaultError('IDENTITY_INVALID');
}

function signatureInput(
  userId: string,
  object: Pick<VaultObject,
    | 'workspaceId'
    | 'objectId'
    | 'generation'
    | 'envelopeVersion'
    | 'ciphertextSha256'
    | 'parentObjectId'
    | 'parentCiphertextSha256'>,
): VaultObjectSignatureInput {
  return Object.freeze({
    userId,
    workspaceId: object.workspaceId,
    objectId: object.objectId,
    generation: object.generation,
    envelopeVersion: object.envelopeVersion,
    ciphertextSha256: object.ciphertextSha256,
    parentObjectId: object.parentObjectId,
    parentCiphertextSha256: object.parentCiphertextSha256,
  });
}

function reconciliationOptions(options: VaultOperationOptions): VaultOperationOptions {
  return options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
}

export class WorkspaceVaultService {
  constructor(
    private readonly repository: VaultRepository,
    private readonly userId: string,
    private readonly workspaceId: string,
    private readonly deviceId: string,
    private readonly signingPublicKey: string,
  ) {
    requireIdentity(userId, workspaceId, deviceId, signingPublicKey);
  }

  async bootstrap(writeCapability: string, options: VaultOperationOptions = {}): Promise<VaultWorkspace> {
    const workspace = await this.repository.bootstrapWorkspace({
      workspaceId: this.workspaceId,
      signingAlgorithm: 'ed25519-v1',
      signingPublicKey: this.signingPublicKey,
      writeCapability,
    }, options);
    await this.registerDevice(writeCapability, options);
    return workspace;
  }

  async registerDevice(writeCapability: string, options: VaultOperationOptions = {}): Promise<void> {
    try {
      await this.repository.registerDevice({
        workspaceId: this.workspaceId,
        deviceId: this.deviceId,
        writeCapability,
      }, options);
    } catch (error) {
      if (!(error instanceof VaultRepositoryError) || error.code !== 'CONFLICT') throw error;
    }
  }

  async save(
    snapshotInput: unknown,
    recoverySecret: string | Uint8Array,
    expectedGeneration: number,
    signingPrivateKeyPkcs8: string,
    writeCapability: string,
    parent: Pick<VaultObject, 'objectId' | 'generation' | 'ciphertextSha256'> | null,
    options: VaultOperationOptions = {},
  ): Promise<WorkspaceVaultSaveResult> {
    const snapshot = normalizeWorkspaceSnapshot(snapshotInput);
    if (
      !Number.isSafeInteger(expectedGeneration)
      || expectedGeneration < 0
      || snapshot.generation !== expectedGeneration + 1
      || (expectedGeneration === 0) !== (parent === null)
      || (parent !== null && parent.generation !== expectedGeneration)
    ) throw new WorkspaceVaultError('GENERATION_MISMATCH');

    const envelope = await encryptVaultPayload(
      createSignedVaultPayload(signingPrivateKeyPkcs8, snapshot),
      recoverySecret,
      aad(this.userId, this.workspaceId, snapshot.generation),
    );
    if (typeof crypto.randomUUID !== 'function') throw new WorkspaceVaultError('IDENTITY_INVALID');
    const objectId = crypto.randomUUID();
    const encryptedEnvelope = serializeVaultEnvelope(envelope);
    const ciphertextSha256 = await sha256Hex(encryptedEnvelope);
    const unsigned = {
      workspaceId: this.workspaceId,
      objectId,
      generation: snapshot.generation,
      envelopeVersion: VAULT_ENVELOPE_VERSION,
      ciphertextSha256,
      parentObjectId: parent?.objectId ?? null,
      parentCiphertextSha256: parent?.ciphertextSha256 ?? null,
    } as const;
    const signature = await signVaultObject(
      signingPrivateKeyPkcs8,
      signatureInput(this.userId, unsigned),
    );
    const uploadInput = {
      ...unsigned,
      deviceId: this.deviceId,
      encryptedEnvelope,
      signature,
      writeCapability,
    } as const;

    let uploaded: Omit<VaultObject, 'encryptedEnvelope'>;
    try {
      uploaded = await this.repository.uploadGeneration(uploadInput, options);
    } catch (error) {
      if (!(error instanceof VaultRepositoryError) || error.outcome !== 'UNKNOWN') throw error;
      let candidate: VaultObject | null;
      try {
        candidate = await this.repository.readGenerationObject(
          this.workspaceId,
          objectId,
          reconciliationOptions(options),
        );
      } catch (cause) {
        throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
          cause,
          retryable: false,
          outcome: 'UNKNOWN',
        });
      }
      if (
        !candidate
        || candidate.workspaceId !== this.workspaceId
        || candidate.objectId !== objectId
        || candidate.generation !== snapshot.generation
        || candidate.envelopeVersion !== VAULT_ENVELOPE_VERSION
        || candidate.ciphertextSha256 !== ciphertextSha256
        || candidate.signature !== signature
        || candidate.parentObjectId !== unsigned.parentObjectId
        || candidate.parentCiphertextSha256 !== unsigned.parentCiphertextSha256
        || candidate.createdByDeviceId !== this.deviceId
        || await sha256Hex(candidate.encryptedEnvelope) !== ciphertextSha256
      ) throw new WorkspaceVaultError('MUTATION_OUTCOME_UNKNOWN');
      uploaded = candidate;
    }

    let head: VaultHead;
    try {
      head = await this.repository.publishHead({
        workspaceId: this.workspaceId,
        objectId: uploaded.objectId,
        expectedGeneration,
      }, options);
    } catch (error) {
      if (!(error instanceof VaultRepositoryError) || error.outcome !== 'UNKNOWN') throw error;
      let active: ActiveVaultGeneration | null;
      try {
        active = await this.repository.readActiveGeneration(
          this.workspaceId,
          reconciliationOptions(options),
        );
      } catch (cause) {
        throw new VaultRepositoryError('REMOTE_UNAVAILABLE', {
          cause,
          retryable: false,
          outcome: 'UNKNOWN',
        });
      }
      if (
        active
        && active.head.objectId === uploaded.objectId
        && active.head.generation === uploaded.generation
        && active.object.ciphertextSha256 === uploaded.ciphertextSha256
      ) {
        head = active.head;
      } else if (active && active.head.generation >= uploaded.generation) {
        throw new VaultRepositoryError('CONFLICT', { retryable: false, outcome: 'NOT_APPLIED' });
      } else {
        throw new WorkspaceVaultError('MUTATION_OUTCOME_UNKNOWN');
      }
    }
    return Object.freeze({ head, object: uploaded });
  }

  private async verifyAndDecrypt(
    object: VaultObject,
    recoverySecret: string | Uint8Array,
  ): Promise<Readonly<{ snapshot: WorkspaceSnapshotV1; signingPrivateKeyPkcs8: string }>> {
    if (await sha256Hex(object.encryptedEnvelope) !== object.ciphertextSha256) {
      throw new WorkspaceVaultError('SIGNATURE_INTEGRITY_FAILED');
    }
    const input = signatureInput(this.userId, object);
    if (!await verifyVaultObjectSignature(this.signingPublicKey, input, object.signature)) {
      throw new WorkspaceVaultError('SIGNATURE_INTEGRITY_FAILED');
    }

    const decrypted = await decryptVaultPayload(
      deserializeVaultEnvelope(object.encryptedEnvelope),
      recoverySecret,
      aad(this.userId, this.workspaceId, object.generation),
    );
    const payload = parseSignedVaultPayload(decrypted);
    const snapshot = normalizeWorkspaceSnapshot(payload.snapshot);
    if (snapshot.generation !== object.generation) {
      throw new WorkspaceVaultError('SNAPSHOT_INTEGRITY_FAILED');
    }
    const selfProof = await signVaultObject(payload.signingPrivateKeyPkcs8, input);
    if (!await verifyVaultObjectSignature(this.signingPublicKey, input, selfProof)) {
      throw new WorkspaceVaultError('SNAPSHOT_INTEGRITY_FAILED');
    }
    return Object.freeze({ snapshot, signingPrivateKeyPkcs8: payload.signingPrivateKeyPkcs8 });
  }

  async load(
    recoverySecret: string | Uint8Array,
    options: VaultOperationOptions = {},
  ): Promise<WorkspaceVaultLoadResult | null> {
    let active: ActiveVaultGeneration | null = null;
    let activeHead: VaultHead | null = null;
    let activeFailure: unknown = null;
    try {
      active = await this.repository.readActiveGeneration(this.workspaceId, options);
      if (!active) return null;
      activeHead = active.head;
    } catch (error) {
      if (!(error instanceof VaultRepositoryError) || error.code !== 'INTEGRITY_FAILURE') throw error;
      const workspace = (await this.repository.listWorkspaces(options))
        .find((row) => row.workspaceId === this.workspaceId);
      if (!workspace?.head) throw error;
      activeHead = workspace.head;
      activeFailure = error;
    }
    if (active) {
      try {
        const restored = await this.verifyAndDecrypt(active.object, recoverySecret);
        return Object.freeze({
          ...restored,
          head: active.head,
          activeHead: active.head,
          recoveredFromHistory: false,
          sourceObject: active.object,
        });
      } catch (error) {
        activeFailure = error;
      }
    }

    const history = await this.repository.readGenerationHistory(
      this.workspaceId,
      { ...options, limit: HISTORY_LIMIT },
    );
    let lastCryptoFailure: VaultCryptoError | null = activeFailure instanceof VaultCryptoError
      ? activeFailure
      : null;
    for (const object of history) {
      if (object.objectId === activeHead.objectId && object.generation === activeHead.generation) continue;
      try {
        const restored = await this.verifyAndDecrypt(object, recoverySecret);
        return Object.freeze({
          ...restored,
          head: Object.freeze({
            workspaceId: object.workspaceId,
            objectId: object.objectId,
            generation: object.generation,
            updatedAt: object.createdAt,
          }),
          activeHead,
          recoveredFromHistory: true,
          sourceObject: object,
        });
      } catch (error) {
        if (error instanceof VaultCryptoError) lastCryptoFailure = error;
      }
    }
    if (lastCryptoFailure) throw lastCryptoFailure;
    if (activeFailure instanceof Error) throw activeFailure;
    throw new WorkspaceVaultError('SIGNATURE_INTEGRITY_FAILED');
  }

  deriveWriteCapability(recoveryCode: string): Promise<string> {
    return deriveVaultWriteCapability(recoveryCode, this.workspaceId);
  }

}
