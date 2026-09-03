import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';
import {
  VAULT_CRYPTO_LIMITS,
  VAULT_KDF_ITERATIONS,
  VaultCryptoError,
  assertVaultCiphertextSize,
  assertVaultEnvelopeSize,
  assertVaultPlaintextSize,
  assertVaultSourceFileSize,
  deserializeVaultEnvelope,
  decryptVaultPayload,
  encryptVaultPayload,
  serializeVaultEnvelope,
  type VaultAad,
  type VaultEnvelopeV1,
} from './vault-crypto';

const SECRET = 'correct horse battery staple';
const OTHER_SECRET = 'wrong horse battery staple!';
const AAD: VaultAad = Object.freeze({
  user: '8b91ef76-3d75-48fc-8336-44e0a5c857e3',
  workspace: 'primary',
  kind: 'workspace-snapshot',
  logicalKey: 'binance-usdm/main',
  generation: 7,
  schemaVersion: 1,
});
const PAYLOAD = Object.freeze({
  trades: [{ id: 'trade-1', pnl: 12.34, symbol: 'BTCUSDT' }],
  review: { grade: 'B', lesson: '等待确认后执行' },
});

function sequentialRandom(): (length: number) => Uint8Array {
  let next = 0;
  return (length) => Uint8Array.from(
    { length },
    () => (next += 1) - 1,
  );
}

function replaceBase64Byte(value: string): string {
  const replacement = value.endsWith('A') ? 'B' : 'A';
  return `${value.slice(0, -1)}${replacement}`;
}

function authenticationFailure(promise: Promise<unknown>): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: 'VaultCryptoError',
    code: 'VAULT_AUTHENTICATION_FAILED',
    message: 'VAULT_AUTHENTICATION_FAILED',
  });
}

describe('E2EE vault envelope', () => {
  let fixedEnvelope: VaultEnvelopeV1;

  beforeAll(async () => {
    fixedEnvelope = await encryptVaultPayload(PAYLOAD, SECRET, AAD, {
      randomBytes: sequentialRandom(),
    });
  });

  it('matches the versioned deterministic encryption vector', () => {
    expect(fixedEnvelope).toEqual({
      format: 'rv-e2ee-vault',
      version: 1,
      aad: AAD,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: VAULT_KDF_ITERATIONS,
        salt: 'ICEiIyQlJicoKSorLC0uLw',
      },
      keyWrap: {
        name: 'AES-GCM-256',
        iv: 'MDEyMzQ1Njc4OTo7',
        ciphertext: 'dnk3JhhcGj0DFF6lMaUtQxuAcdgmpST6239S58nnLdmyLI4slEYFFnloC09IzAh2',
      },
      payload: {
        name: 'AES-GCM-256',
        iv: 'PD0-P0BBQkNERUZH',
        ciphertext: 'DPxLlYImsMCOmBQOSTgdRcA-oVdgrwxrTmPXtUeXMmrBz4wMnWXBW_UyigTgBvvoT20dKOzGD0OhmZfsPgz0ik6oN59XWdQgh4vLu1czBriKnNQFyzYio9LvXvErD45Hx6TJG8ce_gOyvonlqbdBlxYLI-rMcUlR8p-OWiswLmEY8NOc',
        plaintextBytes: 116,
      },
    });
  });

  it('round-trips canonical JSON', async () => {
    await expect(decryptVaultPayload(fixedEnvelope, SECRET, AAD)).resolves.toEqual(PAYLOAD);
  });

  it('round-trips canonical repository bytes before decryption', async () => {
    const serialized = serializeVaultEnvelope(fixedEnvelope);
    const restored = deserializeVaultEnvelope(serialized);

    expect(new TextDecoder().decode(serialized)).toBe(canonicalJson(fixedEnvelope));
    await expect(decryptVaultPayload(restored, SECRET, AAD)).resolves.toEqual(PAYLOAD);
  });

  it('uses fresh content keys, salt and IVs by default', async () => {
    const first = await encryptVaultPayload(PAYLOAD, SECRET, AAD);
    const second = await encryptVaultPayload(PAYLOAD, SECRET, AAD);

    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.keyWrap.iv).not.toBe(second.keyWrap.iv);
    expect(first.payload.iv).not.toBe(second.payload.iv);
    expect(first.payload.ciphertext).not.toBe(second.payload.ciphertext);
  });

  it('uses one indistinguishable failure for a wrong secret or altered ciphertext', async () => {
    await authenticationFailure(decryptVaultPayload(fixedEnvelope, OTHER_SECRET, AAD));

    const payloadTampered = {
      ...fixedEnvelope,
      payload: {
        ...fixedEnvelope.payload,
        ciphertext: replaceBase64Byte(fixedEnvelope.payload.ciphertext),
      },
    };
    await authenticationFailure(decryptVaultPayload(payloadTampered, SECRET, AAD));

    const wrappedKeyTampered = {
      ...fixedEnvelope,
      keyWrap: {
        ...fixedEnvelope.keyWrap,
        ciphertext: replaceBase64Byte(fixedEnvelope.keyWrap.ciphertext),
      },
    };
    await authenticationFailure(decryptVaultPayload(wrappedKeyTampered, SECRET, AAD));
  });

  it('binds user, workspace, kind, logical key, generation and schema version', async () => {
    for (const replacement of [
      { user: 'another-user' },
      { workspace: 'secondary' },
      { kind: 'review-card' },
      { logicalKey: 'binance-usdm/other' },
      { generation: 8 },
      { schemaVersion: 2 },
    ]) {
      await authenticationFailure(decryptVaultPayload(
        fixedEnvelope,
        SECRET,
        { ...AAD, ...replacement },
      ));
    }

    const replacedAad = {
      ...fixedEnvelope,
      aad: { ...AAD, logicalKey: 'binance-usdm/other' },
    };
    await authenticationFailure(decryptVaultPayload(
      replacedAad,
      SECRET,
      replacedAad.aad,
    ));
  });

  it('rejects unsupported versions, weak secrets and malformed random sources', async () => {
    await expect(decryptVaultPayload(
      { ...fixedEnvelope, version: 2 },
      SECRET,
      AAD,
    )).rejects.toMatchObject({ code: 'VAULT_UNSUPPORTED_VERSION' });

    await expect(encryptVaultPayload(PAYLOAD, 'too-short', AAD))
      .rejects.toBeInstanceOf(VaultCryptoError);
    await expect(encryptVaultPayload(PAYLOAD, SECRET, AAD, {
      randomBytes: (length) => new Uint8Array(length - 1),
    })).rejects.toMatchObject({ code: 'VAULT_INVALID_INPUT' });
  });

  it('exposes and enforces source, plaintext and ciphertext byte ceilings', () => {
    expect(() => assertVaultSourceFileSize(VAULT_CRYPTO_LIMITS.sourceFileBytes)).not.toThrow();
    expect(() => assertVaultPlaintextSize(VAULT_CRYPTO_LIMITS.plaintextBytes)).not.toThrow();
    expect(() => assertVaultCiphertextSize(VAULT_CRYPTO_LIMITS.ciphertextBytes)).not.toThrow();
    expect(() => assertVaultEnvelopeSize(VAULT_CRYPTO_LIMITS.envelopeBytes)).not.toThrow();

    expect(() => assertVaultSourceFileSize(VAULT_CRYPTO_LIMITS.sourceFileBytes + 1))
      .toThrowError(expect.objectContaining({ code: 'VAULT_LIMIT_EXCEEDED' }));
    expect(() => assertVaultPlaintextSize(VAULT_CRYPTO_LIMITS.plaintextBytes + 1))
      .toThrowError(expect.objectContaining({ code: 'VAULT_LIMIT_EXCEEDED' }));
    expect(() => assertVaultCiphertextSize(VAULT_CRYPTO_LIMITS.ciphertextBytes + 1))
      .toThrowError(expect.objectContaining({ code: 'VAULT_LIMIT_EXCEEDED' }));
    expect(() => assertVaultEnvelopeSize(VAULT_CRYPTO_LIMITS.envelopeBytes + 1))
      .toThrowError(expect.objectContaining({ code: 'VAULT_LIMIT_EXCEEDED' }));
  });
});
