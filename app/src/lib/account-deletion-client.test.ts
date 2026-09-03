import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS,
  ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS,
  ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES,
  ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS,
  ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS,
  ACCOUNT_DELETION_SERVER_STATUS_TTL_MS,
  CLEAR_BUSINESS_CONFIRMATION,
  DELETE_WORKSPACE_CONFIRMATION,
  AccountDeletionClient,
  AccountDeletionClientError,
  clearAccountDeletionRecovery,
  clearBusinessDeletionRecovery,
  clearWorkspaceDeletionRecovery,
  createBusinessDeletionRecovery,
  createAccountDeletionRecovery,
  createWorkspaceDeletionRecovery,
  loadBusinessDeletionRecovery,
  loadAccountDeletionRecovery,
  loadWorkspaceDeletionRecovery,
  parseAccountDeletionRecoveryFile,
  refreshAccountDeletionRecovery,
  saveBusinessDeletionRecovery,
  saveAccountDeletionRecovery,
  saveWorkspaceDeletionRecovery,
  serializeAccountDeletionRecoveryFile,
} from './account-deletion-client';

const config = {
  supabaseUrl: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
} as const;

const userId = '92bf60cf-6964-4dcc-b2f4-dd14b82b0741';
const workspaceId = 'e8614b3f-0da6-4fe5-ae4d-96353ca09e8f';
const requestId = 'a5810db0-9183-478d-a111-f989adbe62f5';
const receiptId = 'd5af4758-ae9a-4603-9624-59b982aa465b';
const recoverySecret = `rvr1_${'A'.repeat(43)}`;
const recoveryFileSecret = 'rvr1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const freshProof = {
  accessToken: 'fresh-access-token-value-that-is-long-enough',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId,
  email: 'person@example.com',
} as const;

const recovery = {
  requestId,
  recoverySecret,
  subjectHint: userId,
  createdAt: Date.now(),
} as const;
const workspaceRecovery = {
  ...recovery,
  requestId: 'b5810db0-9183-478d-a111-f989adbe62f5',
  recoverySecret: `rvr1_${'B'.repeat(43)}`,
  workspaceId,
} as const;
const businessRecovery = {
  ...recovery,
  requestId: 'c5810db0-9183-478d-a111-f989adbe62f5',
  recoverySecret: `rvr1_${'C'.repeat(43)}`,
} as const;

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function bodyOf(fetchImpl: typeof fetch, call = 0): Record<string, unknown> {
  return JSON.parse(String(vi.mocked(fetchImpl).mock.calls[call][1]?.body));
}

describe('account deletion recovery capability', () => {
  beforeEach(() => sessionStorage.clear());

  it('generates a UUIDv4 request and 256-bit base64url recovery secret', () => {
    const generated = createAccountDeletionRecovery(userId, {
      randomUUID: () => requestId,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
      now: () => 1_000,
    });

    expect(generated).toEqual({
      requestId,
      recoverySecret: 'rvr1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      subjectHint: userId,
      createdAt: 1_000,
    });
  });

  it('persists only a minimal capability in sessionStorage and rejects tampering or expiry', () => {
    saveAccountDeletionRecovery(recovery);
    expect(loadAccountDeletionRecovery()).toEqual(recovery);
    expect(localStorage).toHaveLength(0);
    expect(JSON.parse(String(sessionStorage.getItem('rv-account-deletion-recovery-v2'))))
      .toEqual(recovery);

    sessionStorage.setItem('rv-account-deletion-recovery-v2', JSON.stringify({ ...recovery, userId }));
    expect(loadAccountDeletionRecovery()).toBeNull();
    expect(sessionStorage).toHaveLength(0);

    sessionStorage.setItem('rv-account-deletion-recovery-v2', JSON.stringify({
      ...recovery,
      createdAt: Date.now() - 2 * 60 * 60 * 1000,
    }));
    expect(loadAccountDeletionRecovery()).toBeNull();
    clearAccountDeletionRecovery();
  });

  it('keeps workspace scope separate from the business-data recovery capability', () => {
    const workspace = createWorkspaceDeletionRecovery(userId, workspaceId);
    const business = createBusinessDeletionRecovery(userId);
    saveWorkspaceDeletionRecovery(workspace);
    saveBusinessDeletionRecovery(business);
    expect(loadWorkspaceDeletionRecovery()).toEqual(workspace);
    expect(loadBusinessDeletionRecovery()).toEqual(business);
    clearWorkspaceDeletionRecovery();
    clearBusinessDeletionRecovery();
    expect(loadWorkspaceDeletionRecovery()).toBeNull();
    expect(loadBusinessDeletionRecovery()).toBeNull();
  });

  it('round-trips the minimal account status capability in one canonical versioned file', () => {
    const createdAt = 1_000_000;
    const value = { ...recovery, recoverySecret: recoveryFileSecret, createdAt };
    const serialized = serializeAccountDeletionRecoveryFile(value, createdAt + 1_000);

    expect(serialized).toBe(
      `{"version":1,"operation":"delete_account","requestId":"${requestId}",`
      + `"recoverySecret":"${recoveryFileSecret}","subjectHint":"${userId}","createdAt":${createdAt}}`,
    );
    expect(new TextEncoder().encode(serialized).byteLength)
      .toBeLessThanOrEqual(ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES);
    expect(parseAccountDeletionRecoveryFile(serialized, createdAt + 1_000)).toEqual(value);
    expect(localStorage).toHaveLength(0);
  });

  it('refreshes the file lease without changing the deletion capability', () => {
    const anchor = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(anchor);
      const original = createAccountDeletionRecovery(userId);
      vi.setSystemTime(anchor + 5_000);
      const refreshed = refreshAccountDeletionRecovery(original);
      expect(refreshed).toEqual({ ...original, createdAt: anchor + 5_000 });
      expect(loadAccountDeletionRecovery()).toEqual(refreshed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non-canonical, oversized, extra-field, wrong-operation, and weak-secret files', () => {
    const now = Date.now();
    const canonical = serializeAccountDeletionRecoveryFile({
      ...recovery,
      recoverySecret: recoveryFileSecret,
      createdAt: now,
    }, now);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const invalidFiles = [
      ` ${canonical}`,
      JSON.stringify({ ...parsed, email: 'person@example.com' }),
      JSON.stringify({ ...parsed, version: 2 }),
      JSON.stringify({ ...parsed, operation: 'delete_workspace' }),
      JSON.stringify({ ...parsed, requestId: 'a5810db0-9183-178d-a111-f989adbe62f5' }),
      JSON.stringify({ ...parsed, subjectHint: 'not-a-uuid' }),
      JSON.stringify({ ...parsed, recoverySecret: 'rvr1_short' }),
      JSON.stringify({ ...parsed, recoverySecret }),
      `${canonical}${' '.repeat(ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES)}`,
    ];

    for (const source of invalidFiles) {
      expect(() => parseAccountDeletionRecoveryFile(source, now)).toThrowError(
        expect.objectContaining({ code: 'RECOVERY_FILE_INVALID' }),
      );
    }
  });

  it('derives the pre-delete file envelope from every product-controlled deadline', () => {
    expect(ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS).toBe(
      ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS
      + ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS
      + ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS
      + ACCOUNT_DELETION_SERVER_STATUS_TTL_MS,
    );

    const now = Date.now();
    const expired = JSON.stringify({
      version: 1,
      operation: 'delete_account',
      ...recovery,
      recoverySecret: recoveryFileSecret,
      createdAt: now - ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS,
    });
    const future = JSON.stringify({
      version: 1,
      operation: 'delete_account',
      ...recovery,
      recoverySecret: recoveryFileSecret,
      createdAt: now + 1,
    });

    expect(() => parseAccountDeletionRecoveryFile(expired, now)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_FILE_EXPIRED' }),
    );
    const lastLocallyCoveredMillisecond = JSON.stringify({
      version: 1,
      operation: 'delete_account',
      ...recovery,
      recoverySecret: recoveryFileSecret,
      createdAt: now - ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS + 1,
    });
    expect(parseAccountDeletionRecoveryFile(lastLocallyCoveredMillisecond, now).createdAt)
      .toBe(now - ACCOUNT_DELETION_RECOVERY_FILE_TTL_MS + 1);
    expect(() => parseAccountDeletionRecoveryFile(future, now)).toThrowError(
      expect.objectContaining({ code: 'RECOVERY_FILE_INVALID' }),
    );
  });
});

describe('AccountDeletionClient v3', () => {
  beforeEach(() => sessionStorage.clear());

  it('accepts only positive integer client deadlines up to the product maximum', () => {
    expect(() => new AccountDeletionClient(config, {
      timeoutMs: ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS,
    })).not.toThrow();
    for (const timeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS + 1,
    ]) {
      expect(() => new AccountDeletionClient(config, { timeoutMs })).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it('requires fresh proof and exact phrases for workspace and business deletion', async () => {
    saveWorkspaceDeletionRecovery(workspaceRecovery);
    saveBusinessDeletionRecovery(businessRecovery);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 3,
        action: 'delete_workspace',
        state: 'completed',
        receiptId,
        expiresAt,
      }))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 3,
        action: 'clear_business_data',
        state: 'completed',
        receiptId,
        expiresAt,
      })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.deleteWorkspace(freshProof, workspaceId, 'delete_this_workspace'))
      .rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(client.deleteWorkspace(
      freshProof,
      workspaceId,
      DELETE_WORKSPACE_CONFIRMATION,
    )).resolves.toEqual({ state: 'completed', receiptId, expiresAt });
    await expect(client.clearBusinessData(
      freshProof,
      CLEAR_BUSINESS_CONFIRMATION,
    )).resolves.toEqual({ state: 'completed', receiptId, expiresAt });

    expect(bodyOf(fetchImpl, 0)).toEqual({
      protocolVersion: 3,
      action: 'delete_workspace',
      confirmation: DELETE_WORKSPACE_CONFIRMATION,
      workspaceId,
      requestId: workspaceRecovery.requestId,
      recoverySecret: workspaceRecovery.recoverySecret,
    });
    expect(bodyOf(fetchImpl, 1)).toEqual({
      protocolVersion: 3,
      action: 'clear_business_data',
      confirmation: CLEAR_BUSINESS_CONFIRMATION,
      requestId: businessRecovery.requestId,
      recoverySecret: businessRecovery.recoverySecret,
    });
    for (const [, init] of vi.mocked(fetchImpl).mock.calls) {
      expect(init?.headers).toEqual({
        authorization: `Bearer ${freshProof.accessToken}`,
        apikey: config.publishableKey,
        'content-type': 'application/json',
      });
    }
    expect(loadWorkspaceDeletionRecovery()).toBeNull();
    expect(loadBusinessDeletionRecovery()).toBeNull();
  });

  it('sends the same high-entropy capability for account deletion and parses a minimal receipt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      protocolVersion: 3,
      action: 'delete_account',
      state: 'completed',
      receiptId,
      expiresAt,
    })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.deleteAccount(
      freshProof,
      ACCOUNT_DELETE_CONFIRMATION,
      recovery,
    )).resolves.toEqual({ state: 'completed', receiptId, expiresAt });
    expect(bodyOf(fetchImpl)).toEqual({
      protocolVersion: 3,
      action: 'delete_account',
      confirmation: ACCOUNT_DELETE_CONFIRMATION,
      requestId,
      recoverySecret,
    });
  });

  it('keeps a workspace capability after response loss and clears it only after definitive status', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('private transport detail'))
      .mockResolvedValueOnce(jsonResponse({
        protocolVersion: 3,
        action: 'deletion_status',
        operation: 'delete_workspace',
        state: 'completed',
        receiptId,
        expiresAt,
      })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.deleteWorkspace(
      freshProof,
      workspaceId,
      DELETE_WORKSPACE_CONFIRMATION,
    )).rejects.toMatchObject({ code: 'OUTCOME_RECOVERABLE' });
    const pending = loadWorkspaceDeletionRecovery();
    expect(pending).toMatchObject({ subjectHint: userId, workspaceId });
    await expect(client.queryWorkspaceDeletionStatus(pending!)).resolves.toEqual({
      state: 'completed', receiptId, expiresAt,
    });
    expect(bodyOf(fetchImpl, 1)).toEqual({
      protocolVersion: 3,
      action: 'deletion_status',
      operation: 'delete_workspace',
      requestId: pending!.requestId,
      recoverySecret: pending!.recoverySecret,
      subjectHint: userId,
      workspaceId,
    });
    expect(loadWorkspaceDeletionRecovery()).toBeNull();
  });

  it('anchors the local lease at dispatch and clears a server-expired capability', async () => {
    const anchor = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(anchor);
      saveWorkspaceDeletionRecovery({
        ...workspaceRecovery,
        createdAt: anchor - 64 * 60 * 1000,
      });
      const fetchImpl = vi.fn()
        .mockRejectedValueOnce(new TypeError('lost mutation response'))
        .mockResolvedValueOnce(jsonResponse({ error: 'deletion_request_expired' }, 410)) as unknown as typeof fetch;
      const client = new AccountDeletionClient(config, { fetchImpl });

      await expect(client.deleteWorkspace(
        freshProof,
        workspaceId,
        DELETE_WORKSPACE_CONFIRMATION,
      )).rejects.toMatchObject({ code: 'OUTCOME_RECOVERABLE' });
      const renewed = loadWorkspaceDeletionRecovery();
      expect(renewed?.createdAt).toBe(anchor);

      vi.setSystemTime(anchor + 61 * 60 * 1000);
      expect(loadWorkspaceDeletionRecovery()).not.toBeNull();
      await expect(client.queryWorkspaceDeletionStatus(renewed!))
        .rejects.toMatchObject({ code: 'RECOVERY_EXPIRED', status: 410 });
      expect(loadWorkspaceDeletionRecovery()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears business recovery when a mutation receives definitive 410 expiry', async () => {
    saveBusinessDeletionRecovery(businessRecovery);
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: 'deletion_request_expired' },
      410,
    )) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.clearBusinessData(
      freshProof,
      CLEAR_BUSINESS_CONFIRMATION,
    )).rejects.toMatchObject({ code: 'RECOVERY_EXPIRED', status: 410 });
    expect(loadBusinessDeletionRecovery()).toBeNull();
  });

  it('queries final status with the capability and subject hint but without a JWT', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      protocolVersion: 3,
      action: 'deletion_status',
      operation: 'delete_account',
      state: 'completed',
      receiptId,
      expiresAt,
    })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.queryAccountDeletionStatus(recovery)).resolves.toEqual({
      state: 'completed',
      receiptId,
      expiresAt,
    });
    expect(bodyOf(fetchImpl)).toEqual({
      protocolVersion: 3,
      action: 'deletion_status',
      operation: 'delete_account',
      requestId,
      recoverySecret,
      subjectHint: userId,
    });
    expect(vi.mocked(fetchImpl).mock.calls[0][1]?.headers).toEqual({
      apikey: config.publishableKey,
      'content-type': 'application/json',
    });
  });

  it('treats a returned server expiresAt as authoritative over a refreshed local lease', async () => {
    const locallyRefreshed = refreshAccountDeletionRecovery(recovery);
    const fetchImpl = vi.fn(async () => jsonResponse({
      protocolVersion: 3,
      action: 'deletion_status',
      operation: 'delete_account',
      state: 'pending',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.queryAccountDeletionStatus(locallyRefreshed))
      .rejects.toMatchObject({ code: 'RECOVERY_EXPIRED', status: 410 });
    expect(loadAccountDeletionRecovery()).toBeNull();
  });

  it('turns a lost account-delete response into a recoverable outcome', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('private network detail'); }) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await expect(client.deleteAccount(freshProof, ACCOUNT_DELETE_CONFIRMATION, recovery))
      .rejects.toEqual(new AccountDeletionClientError(
        'OUTCOME_RECOVERABLE',
        '未能确认删除结果；请使用当前恢复凭据查询最终状态',
      ));

    const upstreamLost = vi.fn(async () => jsonResponse({ error: 'deletion_unavailable' }, 503)) as unknown as typeof fetch;
    await expect(new AccountDeletionClient(config, { fetchImpl: upstreamLost })
      .deleteAccount(freshProof, ACCOUNT_DELETE_CONFIRMATION, recovery))
      .rejects.toMatchObject({ code: 'OUTCOME_RECOVERABLE' });

    const malformedSuccess = vi.fn(async () => jsonResponse({ deleted: true })) as unknown as typeof fetch;
    await expect(new AccountDeletionClient(config, { fetchImpl: malformedSuccess })
      .deleteAccount(freshProof, ACCOUNT_DELETE_CONFIRMATION, recovery))
      .rejects.toMatchObject({ code: 'OUTCOME_RECOVERABLE' });
  });

  it('rejects stale proof, malformed capabilities, oversized bodies, and non-minimal receipts', async () => {
    const extra = vi.fn(async () => jsonResponse({
      protocolVersion: 3,
      action: 'delete_account',
      state: 'completed',
      receiptId,
      expiresAt,
      email: 'must-not-be-returned@example.com',
    })) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl: extra });

    await expect(client.deleteAccount(
      { ...freshProof, expiresAt: Date.now() - 1 },
      ACCOUNT_DELETE_CONFIRMATION,
      recovery,
    )).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    await expect(client.deleteAccount(
      freshProof,
      ACCOUNT_DELETE_CONFIRMATION,
      { ...recovery, recoverySecret: 'weak' },
    )).rejects.toMatchObject({ code: 'RECOVERY_INVALID' });
    await expect(client.deleteAccount(freshProof, ACCOUNT_DELETE_CONFIRMATION, recovery))
      .rejects.toMatchObject({ code: 'OUTCOME_RECOVERABLE' });

    const streamed = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9 * 1024));
        controller.enqueue(new Uint8Array(9 * 1024));
        controller.close();
      },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(new AccountDeletionClient(config, { fetchImpl: streamed })
      .queryAccountDeletionStatus(recovery))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('uses invite-only OTP and never persists its refresh token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/v1/otp')) return jsonResponse({});
      return jsonResponse({
        access_token: freshProof.accessToken,
        refresh_token: 'must-not-be-persisted',
        expires_in: 3600,
        user: { id: userId, email: 'person@example.com' },
      });
    }) as unknown as typeof fetch;
    const client = new AccountDeletionClient(config, { fetchImpl });

    await client.sendReverificationCode('person@example.com');
    await expect(client.verifyReverificationCode('person@example.com', '123456'))
      .resolves.toMatchObject({
        accessToken: freshProof.accessToken,
        userId,
        email: 'person@example.com',
      });
    const bodies = vi.mocked(fetchImpl).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { email: 'person@example.com', create_user: false },
      { email: 'person@example.com', token: '123456', type: 'email' },
    ]);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
  });
});
