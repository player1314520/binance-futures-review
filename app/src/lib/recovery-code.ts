const RECOVERY_BYTES = 24;
const RECOVERY_PATTERN = /^rvk1_[A-Za-z0-9_-]{32}$/;
const LEGACY_RECOVERY_FILE_FORMAT = 'rv-recovery-kit/1' as const;
const ROOT_RECOVERY_FILE_FORMAT = 'rv-recovery-kit/2' as const;
const SIGNING_ALGORITHM = 'ed25519-v1' as const;
const RECOVERY_FILE_MAX_LENGTH = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type LegacyRecoveryKit = Readonly<{
  format: typeof LEGACY_RECOVERY_FILE_FORMAT;
  workspaceId: string;
  recoveryCode: string;
  createdAt: string;
}>;

/**
 * Version 2 is deliberately self-contained.  The immutable Ed25519 root is
 * created before the first remote request, so the downloaded file must carry
 * both halves of that root as well as the recovery code.  This lets a user
 * retry an interrupted bootstrap without depending on tab memory.
 */
export type RootRecoveryKit = Readonly<{
  format: typeof ROOT_RECOVERY_FILE_FORMAT;
  workspaceId: string;
  recoveryCode: string;
  signingAlgorithm: typeof SIGNING_ALGORITHM;
  signingPublicKeySpki: string;
  signingPrivateKeyPkcs8: string;
  createdAt: string;
}>;

export type RecoveryKit = LegacyRecoveryKit | RootRecoveryKit;

export class RecoveryCodeError extends Error {
  readonly code = 'RECOVERY_CODE_INVALID';
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function normalizeRecoveryCode(value: string): string {
  const normalized = value.trim();
  if (!RECOVERY_PATTERN.test(normalized)) throw new RecoveryCodeError('恢复密钥格式无效');
  return normalized;
}

export function generateRecoveryCode(random: Crypto = globalThis.crypto): string {
  if (!random?.getRandomValues) throw new RecoveryCodeError('当前浏览器不支持安全随机数');
  const bytes = random.getRandomValues(new Uint8Array(RECOVERY_BYTES));
  try {
    return `rvk1_${encodeBase64Url(bytes)}`;
  } finally {
    bytes.fill(0);
  }
}

export function createRecoveryKit(
  workspaceId: string,
  recoveryCode: string,
  createdAt = new Date().toISOString(),
): LegacyRecoveryKit {
  if (!UUID_PATTERN.test(workspaceId) || !Number.isFinite(Date.parse(createdAt))) {
    throw new RecoveryCodeError('恢复文件元数据无效');
  }
  return Object.freeze({
    format: LEGACY_RECOVERY_FILE_FORMAT,
    workspaceId: workspaceId.toLowerCase(),
    recoveryCode: normalizeRecoveryCode(recoveryCode),
    createdAt,
  });
}

function normalizeSigningKey(value: string): string {
  if (
    typeof value !== 'string'
    || value.length < 32
    || value.length > 1024
    || !BASE64URL_PATTERN.test(value)
  ) throw new RecoveryCodeError('恢复文件签名根无效');
  return value;
}

export function createRootRecoveryKit(
  workspaceId: string,
  recoveryCode: string,
  signingPublicKeySpki: string,
  signingPrivateKeyPkcs8: string,
  createdAt = new Date().toISOString(),
): RootRecoveryKit {
  if (!UUID_PATTERN.test(workspaceId) || !Number.isFinite(Date.parse(createdAt))) {
    throw new RecoveryCodeError('恢复文件元数据无效');
  }
  return Object.freeze({
    format: ROOT_RECOVERY_FILE_FORMAT,
    workspaceId: workspaceId.toLowerCase(),
    recoveryCode: normalizeRecoveryCode(recoveryCode),
    signingAlgorithm: SIGNING_ALGORITHM,
    signingPublicKeySpki: normalizeSigningKey(signingPublicKeySpki),
    signingPrivateKeyPkcs8: normalizeSigningKey(signingPrivateKeyPkcs8),
    createdAt,
  });
}

export function isRootRecoveryKit(kit: RecoveryKit): kit is RootRecoveryKit {
  return kit.format === ROOT_RECOVERY_FILE_FORMAT;
}

export function serializeRecoveryKit(kit: RecoveryKit): string {
  const normalized = isRootRecoveryKit(kit)
    ? createRootRecoveryKit(
        kit.workspaceId,
        kit.recoveryCode,
        kit.signingPublicKeySpki,
        kit.signingPrivateKeyPkcs8,
        kit.createdAt,
      )
    : createRecoveryKit(kit.workspaceId, kit.recoveryCode, kit.createdAt);
  return JSON.stringify(normalized, null, 2);
}

export function parseRecoveryKit(text: string): RecoveryKit {
  if (typeof text !== 'string' || !text || text.length > RECOVERY_FILE_MAX_LENGTH) {
    throw new RecoveryCodeError('恢复文件无效');
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RecoveryCodeError('恢复文件无效');
    }
    const keys = Object.keys(value).sort().join(',');
    if (
      value.format === LEGACY_RECOVERY_FILE_FORMAT
      && keys === 'createdAt,format,recoveryCode,workspaceId'
      && typeof value.workspaceId === 'string'
      && typeof value.recoveryCode === 'string'
      && typeof value.createdAt === 'string'
    ) return createRecoveryKit(value.workspaceId, value.recoveryCode, value.createdAt);
    if (
      value.format === ROOT_RECOVERY_FILE_FORMAT
      && keys === 'createdAt,format,recoveryCode,signingAlgorithm,signingPrivateKeyPkcs8,signingPublicKeySpki,workspaceId'
      && value.signingAlgorithm === SIGNING_ALGORITHM
      && typeof value.workspaceId === 'string'
      && typeof value.recoveryCode === 'string'
      && typeof value.signingPublicKeySpki === 'string'
      && typeof value.signingPrivateKeyPkcs8 === 'string'
      && typeof value.createdAt === 'string'
    ) {
      return createRootRecoveryKit(
        value.workspaceId,
        value.recoveryCode,
        value.signingPublicKeySpki,
        value.signingPrivateKeyPkcs8,
        value.createdAt,
      );
    }
    throw new RecoveryCodeError('恢复文件无效');
  } catch (error) {
    if (error instanceof RecoveryCodeError) throw error;
    throw new RecoveryCodeError('恢复文件无效');
  }
}
