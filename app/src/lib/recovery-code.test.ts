import { describe, expect, it } from 'vitest';
import {
  createRecoveryKit,
  createRootRecoveryKit,
  generateRecoveryCode,
  isRootRecoveryKit,
  normalizeRecoveryCode,
  parseRecoveryKit,
  serializeRecoveryKit,
} from './recovery-code';
import { generateVaultSigningKeyPair } from './vault-signing';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('recovery kit', () => {
  it('generates 192 bits in a versioned, copy-safe code', () => {
    const cryptoStub = {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_value, index) => { bytes[index] = index; });
        return bytes;
      },
    } as Crypto;
    expect(generateRecoveryCode(cryptoStub)).toBe('rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX');
  });

  it('round-trips an exact recovery file without accepting extra fields', () => {
    const code = 'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
    const kit = createRecoveryKit(WORKSPACE_ID, code, '2026-08-28T00:00:00.000Z');
    expect(parseRecoveryKit(serializeRecoveryKit(kit))).toEqual(kit);
    expect(() => parseRecoveryKit(JSON.stringify({ ...kit, email: 'private@example.com' }))).toThrow();
  });

  it('round-trips a self-contained v2 kit with the immutable signing root', async () => {
    const code = 'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
    const keys = await generateVaultSigningKeyPair();
    const kit = createRootRecoveryKit(
      WORKSPACE_ID,
      code,
      keys.publicKeySpki,
      keys.privateKeyPkcs8,
      '2026-08-28T00:00:00.000Z',
    );
    const parsed = parseRecoveryKit(serializeRecoveryKit(kit));

    expect(isRootRecoveryKit(parsed)).toBe(true);
    if (!isRootRecoveryKit(parsed)) throw new Error('expected a v2 root recovery kit');
    expect(parsed).toEqual(kit);
    expect(parsed).toMatchObject({
      format: 'rv-recovery-kit/2',
      signingAlgorithm: 'ed25519-v1',
      signingPublicKeySpki: keys.publicKeySpki,
      signingPrivateKeyPkcs8: keys.privateKeyPkcs8,
    });
    expect(() => parseRecoveryKit(JSON.stringify({ ...kit, accountEmail: 'private@example.com' }))).toThrow();
    const { signingPrivateKeyPkcs8: _missing, ...withoutPrivateRoot } = kit;
    expect(() => parseRecoveryKit(JSON.stringify(withoutPrivateRoot))).toThrow();
  });

  it('rejects short or unversioned secrets', () => {
    expect(() => normalizeRecoveryCode('password')).toThrow(/格式无效/);
    expect(() => normalizeRecoveryCode('AAECAwQFBgcICQoLDA0ODxAREhMUFRYX')).toThrow(/格式无效/);
  });
});
