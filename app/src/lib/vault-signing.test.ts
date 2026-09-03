import { describe, expect, it } from 'vitest';
import {
  SIGNED_VAULT_PAYLOAD_FORMAT,
  VAULT_SIGNING_ALGORITHM,
  buildVaultObjectSignatureManifest,
  createSignedVaultPayload,
  deriveVaultWriteCapability,
  generateVaultSigningKeyPair,
  parseSignedVaultPayload,
  sha256Hex,
  signVaultObject,
  verifyVaultObjectSignature,
} from './vault-signing';

const input = {
  userId: 'alice',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  objectId: '22222222-2222-4222-8222-222222222222',
  generation: 2,
  envelopeVersion: 1,
  ciphertextSha256: 'a'.repeat(64),
  parentObjectId: '33333333-3333-4333-8333-333333333333',
  parentCiphertextSha256: 'b'.repeat(64),
} as const;

describe('vault signing protocol', () => {
  it('uses the exact nine-line manifest without a trailing newline', () => {
    expect(buildVaultObjectSignatureManifest(input)).toBe([
      'rv-vault-object-signature/1',
      'alice',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '2',
      '1',
      'a'.repeat(64),
      '33333333-3333-4333-8333-333333333333',
      'b'.repeat(64),
    ].join('\n'));
    expect(buildVaultObjectSignatureManifest({
      ...input,
      generation: 1,
      parentObjectId: null,
      parentCiphertextSha256: null,
    })).toMatch(/\n-\n-$/);
    expect(() => buildVaultObjectSignatureManifest({ ...input, userId: 'alice\nbob' }))
      .toThrowError(/SIGNING_INVALID_INPUT/);
  });

  it('generates Ed25519 keys and rejects any signed-field replay or tamper', async () => {
    const keys = await generateVaultSigningKeyPair();
    expect(keys.algorithm).toBe(VAULT_SIGNING_ALGORITHM);
    expect(keys.publicKeySpki).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.privateKeyPkcs8).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(keys.publicKeySpki).not.toContain('=');
    expect(keys.privateKeyPkcs8).not.toContain('=');
    const signature = await signVaultObject(keys.privateKeyPkcs8, input);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(verifyVaultObjectSignature(keys.publicKeySpki, input, signature)).resolves.toBe(true);

    for (const changed of [
      { ...input, userId: 'bob' },
      { ...input, workspaceId: '44444444-4444-4444-8444-444444444444' },
      { ...input, objectId: '55555555-5555-4555-8555-555555555555' },
      { ...input, generation: 3 },
      { ...input, envelopeVersion: 2 },
      { ...input, ciphertextSha256: 'c'.repeat(64) },
      { ...input, parentObjectId: '66666666-6666-4666-8666-666666666666' },
      { ...input, parentCiphertextSha256: 'd'.repeat(64) },
    ]) {
      await expect(verifyVaultObjectSignature(keys.publicKeySpki, changed, signature)).resolves.toBe(false);
    }
  });

  it('derives a deterministic domain-separated 64-hex write capability', async () => {
    const first = await deriveVaultWriteCapability(
      'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
      input.workspaceId,
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(deriveVaultWriteCapability(
      'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
      input.workspaceId,
    )).resolves.toBe(first);
    await expect(deriveVaultWriteCapability(
      'rvk1_AQECAwQFBgcICQoLDA0ODxAREhMUFRYX',
      input.workspaceId,
    )).resolves.not.toBe(first);
    await expect(deriveVaultWriteCapability(
      'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
      '77777777-7777-4777-8777-777777777777',
    )).resolves.not.toBe(first);
  });

  it('hashes ciphertext and validates the encrypted signed-payload wrapper', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const keys = await generateVaultSigningKeyPair();
    const payload = createSignedVaultPayload(keys.privateKeyPkcs8, { hello: 'world' });
    expect(payload).toEqual({
      format: SIGNED_VAULT_PAYLOAD_FORMAT,
      signingPrivateKeyPkcs8: keys.privateKeyPkcs8,
      snapshot: { hello: 'world' },
    });
    expect(parseSignedVaultPayload(payload)).toEqual(payload);
    expect(() => parseSignedVaultPayload({ ...payload, extra: true })).toThrowError(/SIGNING_INVALID_INPUT/);
    expect(() => parseSignedVaultPayload({ ...payload, format: 'wrong' })).toThrowError(/SIGNING_INVALID_INPUT/);
  });

  it('fails closed when Ed25519 is unavailable', async () => {
    const unavailable = {
      subtle: {
        generateKey: async () => { throw new DOMException('not supported', 'NotSupportedError'); },
      },
      getRandomValues: crypto.getRandomValues.bind(crypto),
    } as unknown as Crypto;
    await expect(generateVaultSigningKeyPair({ webCrypto: unavailable }))
      .rejects.toThrowError(/SIGNING_CRYPTO_UNAVAILABLE/);
  });
});
