import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryVaultBackend,
  MemoryVaultRepository,
  SupabaseVaultRepository,
  VaultRepositoryError,
  type UploadVaultGenerationInput,
} from './vault-repository';
import {
  VAULT_PUBLISH_PROTOCOL_VERSION,
  deriveVaultWriteCapability,
  generateVaultSigningKeyPair,
  sha256Hex,
  signVaultObject,
} from './vault-signing';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-08-28T10:00:00.000Z';
const RECOVERY = 'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';

function expectCode(code: VaultRepositoryError['code']) {
  return expect.objectContaining({ code });
}

async function setupMemory(subject = 'alice', backend = new MemoryVaultBackend()) {
  const [keys, writeCapability] = await Promise.all([
    generateVaultSigningKeyPair(),
    deriveVaultWriteCapability(RECOVERY, WORKSPACE_ID),
  ]);
  const repository = new MemoryVaultRepository({ subject, backend, now: () => new Date(CREATED_AT) });
  await repository.bootstrapWorkspace({
    workspaceId: WORKSPACE_ID,
    signingAlgorithm: 'ed25519-v1',
    signingPublicKey: keys.publicKeySpki,
    writeCapability,
  });
  await repository.registerDevice({ workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID, writeCapability });
  return { repository, keys, writeCapability, backend };
}

async function signedUpload(
  subject: string,
  keys: Awaited<ReturnType<typeof generateVaultSigningKeyPair>>,
  writeCapability: string,
  objectId = FIRST_OBJECT_ID,
  envelope = new Uint8Array(17).fill(1),
  generation = 1,
  parent: { objectId: string; ciphertextSha256: string } | null = null,
): Promise<UploadVaultGenerationInput> {
  const ciphertextSha256 = await sha256Hex(envelope);
  const metadata = {
    userId: subject,
    workspaceId: WORKSPACE_ID,
    objectId,
    generation,
    envelopeVersion: 1,
    ciphertextSha256,
    parentObjectId: parent?.objectId ?? null,
    parentCiphertextSha256: parent?.ciphertextSha256 ?? null,
  } as const;
  return {
    ...metadata,
    deviceId: DEVICE_ID,
    encryptedEnvelope: envelope,
    signature: await signVaultObject(keys.privateKeyPkcs8, metadata),
    writeCapability,
  };
}

describe('MemoryVaultRepository signed tenant semantics', () => {
  it('requires the recovery-derived capability for device registration and upload', async () => {
    const { repository, keys, writeCapability } = await setupMemory();
    await expect(repository.registerDevice({
      workspaceId: WORKSPACE_ID,
      deviceId: '55555555-5555-4555-8555-555555555555',
      writeCapability: 'f'.repeat(64),
    })).rejects.toEqual(expectCode('FORBIDDEN'));
    await expect(repository.uploadGeneration({
      ...await signedUpload('alice', keys, writeCapability),
      writeCapability: 'f'.repeat(64),
    })).rejects.toEqual(expectCode('FORBIDDEN'));
  });

  it('verifies digest/root signature and rejects cross-field or cross-user replay', async () => {
    const backend = new MemoryVaultBackend();
    const alice = await setupMemory('alice', backend);
    const valid = await signedUpload('alice', alice.keys, alice.writeCapability);
    await expect(alice.repository.uploadGeneration(valid)).resolves.toMatchObject({
      objectId: FIRST_OBJECT_ID,
      ciphertextSha256: valid.ciphertextSha256,
    });

    const replayCases = [
      { ...valid, objectId: SECOND_OBJECT_ID },
      { ...valid, generation: 2, parentObjectId: FIRST_OBJECT_ID, parentCiphertextSha256: valid.ciphertextSha256 },
      { ...valid, encryptedEnvelope: new Uint8Array(17).fill(2) },
      { ...valid, ciphertextSha256: 'a'.repeat(64) },
    ];
    for (const replay of replayCases) {
      await expect(alice.repository.uploadGeneration(replay)).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/FORBIDDEN|INTEGRITY_FAILURE|CONFLICT/) }),
      );
    }

    const bob = new MemoryVaultRepository({ subject: 'bob', backend });
    await bob.bootstrapWorkspace({
      workspaceId: WORKSPACE_ID,
      signingAlgorithm: 'ed25519-v1',
      signingPublicKey: alice.keys.publicKeySpki,
      writeCapability: alice.writeCapability,
    });
    await bob.registerDevice({ workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID, writeCapability: alice.writeCapability });
    await expect(bob.uploadGeneration(valid)).rejects.toEqual(expectCode('FORBIDDEN'));
  });

  it('allows immutable concurrent candidates but exactly one CAS winner and bounded history', async () => {
    const { repository, keys, writeCapability } = await setupMemory();
    const [first, second] = await Promise.all([
      signedUpload('alice', keys, writeCapability, FIRST_OBJECT_ID, new Uint8Array(17).fill(1)),
      signedUpload('alice', keys, writeCapability, SECOND_OBJECT_ID, new Uint8Array(17).fill(2)),
    ]);
    await Promise.all([repository.uploadGeneration(first), repository.uploadGeneration(second)]);
    const results = await Promise.allSettled([
      repository.publishHead({ workspaceId: WORKSPACE_ID, objectId: FIRST_OBJECT_ID, expectedGeneration: 0 }),
      repository.publishHead({ workspaceId: WORKSPACE_ID, objectId: SECOND_OBJECT_ID, expectedGeneration: 0 }),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const history = await repository.readGenerationHistory(WORKSPACE_ID, { limit: 999 });
    expect(history).toHaveLength(1);
    expect(history[0].objectId).toBe(winners[0].value.objectId);
  });
});

function repositoryWithFetch(fetcher: typeof fetch, overrides = {}) {
  const accessToken = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({
    role: 'authenticated',
    session_id: '874706c6-9221-45e6-ae68-4c532a9baef9',
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.signature-value-at-least-thirty-two-chars`;
  return new SupabaseVaultRepository({
    supabaseUrl: 'https://review.example.supabase.co',
    publishableKey: 'sb_publishable_public-browser-key',
    getAccessToken: () => accessToken,
    fetch: fetcher,
    ...overrides,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('SupabaseVaultRepository signed browser boundary', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('bootstraps through the capability RPC without sending a user id or recovery code', async () => {
    const keys = await generateVaultSigningKeyPair();
    const writeCapability = await deriveVaultWriteCapability(RECOVERY, WORKSPACE_ID);
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse([{
      workspace_id: WORKSPACE_ID,
      signing_algorithm: 'ed25519-v1',
      signing_public_key: keys.publicKeySpki,
      created_at: CREATED_AT,
    }]));
    const repository = repositoryWithFetch(fetcher);
    await repository.bootstrapWorkspace({
      workspaceId: WORKSPACE_ID,
      signingAlgorithm: 'ed25519-v1',
      signingPublicKey: keys.publicKeySpki,
      writeCapability,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url).endsWith('/rest/v1/rpc/rv_bootstrap_workspace')).toBe(true);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      p_workspace_id: WORKSPACE_ID,
      p_signing_algorithm: 'ed25519-v1',
      p_signing_public_key: keys.publicKeySpki,
      p_write_capability: writeCapability,
      p_session_id: '874706c6-9221-45e6-ae68-4c532a9baef9',
    });
    expect(String(init?.body)).not.toContain('rvk1_');
    expect(String(init?.body)).not.toContain('user_id');
  });

  it('uses RPCs for capability-gated device/upload and the Edge CAS endpoint', async () => {
    const keys = await generateVaultSigningKeyPair();
    const writeCapability = await deriveVaultWriteCapability(RECOVERY, WORKSPACE_ID);
    const upload = await signedUpload('alice', keys, writeCapability);
    const metadata = {
      workspace_id: WORKSPACE_ID,
      object_id: FIRST_OBJECT_ID,
      generation: 1,
      envelope_version: 1,
      ciphertext_sha256: upload.ciphertextSha256,
      signature: upload.signature,
      parent_object_id: null,
      parent_ciphertext_sha256: null,
      created_by_device_id: DEVICE_ID,
      created_at: CREATED_AT,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ workspace_id: WORKSPACE_ID, device_id: DEVICE_ID, created_at: CREATED_AT }]))
      .mockResolvedValueOnce(jsonResponse([metadata]))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: VAULT_PUBLISH_PROTOCOL_VERSION,
        workspaceId: WORKSPACE_ID,
        objectId: FIRST_OBJECT_ID,
        generation: 1,
        updatedAt: CREATED_AT,
      }));
    const repository = repositoryWithFetch(fetcher);
    await repository.registerDevice({ workspaceId: WORKSPACE_ID, deviceId: DEVICE_ID, writeCapability });
    await repository.uploadGeneration(upload);
    await repository.publishHead({ workspaceId: WORKSPACE_ID, objectId: FIRST_OBJECT_ID, expectedGeneration: 0 });

    expect(String(fetcher.mock.calls[0][0]).endsWith('/rest/v1/rpc/rv_register_device')).toBe(true);
    expect(String(fetcher.mock.calls[1][0]).endsWith('/rest/v1/rpc/rv_upload_vault_generation')).toBe(true);
    expect(String(fetcher.mock.calls[2][0]).endsWith('/functions/v1/publish-vault-head')).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).p_session_id)
      .toBe('874706c6-9221-45e6-ae68-4c532a9baef9');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).p_session_id)
      .toBe('874706c6-9221-45e6-ae68-4c532a9baef9');
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({
      protocolVersion: VAULT_PUBLISH_PROTOCOL_VERSION,
      workspaceId: WORKSPACE_ID,
      objectId: FIRST_OBJECT_ID,
      expectedGeneration: 0,
    });
  });

  it('fails closed before a write RPC when the authenticated JWT has no valid session_id', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const repository = repositoryWithFetch(fetcher, {
      getAccessToken: () => 'authenticated-user-access-token-without-jwt-claims',
    });
    const keys = await generateVaultSigningKeyPair();
    const writeCapability = await deriveVaultWriteCapability(RECOVERY, WORKSPACE_ID);
    await expect(repository.bootstrapWorkspace({
      workspaceId: WORKSPACE_ID,
      signingAlgorithm: 'ed25519-v1',
      signingPublicKey: keys.publicKeySpki,
      writeCapability,
    })).rejects.toMatchObject({ code: 'AUTH_REQUIRED', outcome: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps the RLS live-session guard to reauthentication instead of invalid data', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      code: 'P0003',
      message: 'live auth session required',
    }, 400));
    const repository = repositoryWithFetch(fetcher);
    await expect(repository.listWorkspaces()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 400,
      outcome: 'NOT_APPLIED',
    });
  });

  it.each(['P0004', 'P0005'])('maps database admission rejection %s to a retryable refusal', async (remoteCode) => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      code: remoteCode,
      message: 'database admission rejected',
    }, 400));
    const repository = repositoryWithFetch(fetcher);
    await expect(repository.listWorkspaces()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 400,
      retryable: true,
      outcome: 'NOT_APPLIED',
    });
  });

  it('reconciles an uploaded candidate by exact workspace/object id without treating it as committed history', async () => {
    const envelope = new Uint8Array(17).fill(1);
    const ciphertextSha256 = await sha256Hex(envelope);
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse([{
      workspace_id: WORKSPACE_ID,
      object_id: FIRST_OBJECT_ID,
      generation: 1,
      envelope_version: 1,
      ciphertext_sha256: ciphertextSha256,
      signature: 'A'.repeat(86),
      parent_object_id: null,
      parent_ciphertext_sha256: null,
      created_by_device_id: DEVICE_ID,
      created_at: CREATED_AT,
      ciphertext: btoa(String.fromCharCode(...envelope)),
    }]));
    const repository = repositoryWithFetch(fetcher);

    await expect(repository.readGenerationObject(WORKSPACE_ID, FIRST_OBJECT_ID))
      .resolves.toMatchObject({
        workspaceId: WORKSPACE_ID,
        objectId: FIRST_OBJECT_ID,
        generation: 1,
        ciphertextSha256,
      });

    const requested = String(fetcher.mock.calls[0][0]);
    expect(requested).toContain('/rest/v1/rpc/rv_read_generation_object');
    const requestBody = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(requestBody).toEqual({
      p_workspace_id: WORKSPACE_ID,
      p_object_id: FIRST_OBJECT_ID,
      p_session_id: '874706c6-9221-45e6-ae68-4c532a9baef9',
    });
    expect(requested).not.toContain('vault_head_history');
  });

  it('keeps POST read RPC timeouts safely retryable and NOT_APPLIED', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const repository = repositoryWithFetch(fetcher, { timeoutMs: 25 });
    const pending = repository.readGenerationObject(WORKSPACE_ID, FIRST_OBJECT_ID);
    const rejection = expect(pending).rejects.toEqual(expect.objectContaining({
      code: 'TIMEOUT', outcome: 'NOT_APPLIED', retryable: true,
    }));
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(String(fetcher.mock.calls[0][0])).toContain('/rest/v1/rpc/rv_read_generation_object');
  });

  it('marks a dispatched Edge timeout UNKNOWN and never sends service credentials', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const repository = repositoryWithFetch(fetcher, { timeoutMs: 25 });
    const pending = repository.publishHead({ workspaceId: WORKSPACE_ID, objectId: FIRST_OBJECT_ID, expectedGeneration: 0 });
    const rejection = expect(pending).rejects.toEqual(expect.objectContaining({
      code: 'TIMEOUT', outcome: 'UNKNOWN', retryable: false,
    }));
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get('apikey')).toBe('sb_publishable_public-browser-key');
    expect(headers.get('authorization')).toMatch(/^Bearer eyJ/);
  });
});
