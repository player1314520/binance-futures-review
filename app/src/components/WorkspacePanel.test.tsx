import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountDeletionClientError,
  CLEAR_BUSINESS_CONFIRMATION,
  DELETE_WORKSPACE_CONFIRMATION,
  clearBusinessDeletionRecovery,
  clearWorkspaceDeletionRecovery,
  loadWorkspaceDeletionRecovery,
  saveBusinessDeletionRecovery,
  saveWorkspaceDeletionRecovery,
} from '../lib/account-deletion-client';

const workspaceMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const authMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../lib/workspace-context', () => ({ useWorkspace: () => workspaceMock.value }));
vi.mock('../lib/auth-context', () => ({ useAuth: () => authMock.value }));

import WorkspacePanel, {
  WorkspaceDeletionControls,
  type WorkspaceDeletionClientLike,
} from './WorkspacePanel';

const userId = '92bf60cf-6964-4dcc-b2f4-dd14b82b0741';
const workspaceId = 'e8614b3f-0da6-4fe5-ae4d-96353ca09e8f';
const receiptId = '54f55772-50c7-4bf0-82ec-0cbcb9045350';
const freshProof = {
  accessToken: 'fresh-access-token-value-that-is-long-enough',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId,
  email: 'person@example.com',
} as const;

function fakeClient(): WorkspaceDeletionClientLike {
  const expiresAt = '2026-08-29T00:00:00.000Z';
  return {
    sendReverificationCode: vi.fn(async () => undefined),
    verifyReverificationCode: vi.fn(async () => freshProof),
    deleteWorkspace: vi.fn(async () => ({ state: 'completed' as const, receiptId, expiresAt })),
    clearBusinessData: vi.fn(async () => ({ state: 'completed' as const, receiptId, expiresAt })),
    queryWorkspaceDeletionStatus: vi.fn(async () => ({ state: 'completed' as const, receiptId, expiresAt })),
    queryBusinessDeletionStatus: vi.fn(async () => ({ state: 'completed' as const, receiptId, expiresAt })),
  };
}

function workspaceRecovery() {
  return {
    requestId: '10000000-0000-4000-8000-000000000001',
    recoverySecret: `rvr1_${'A'.repeat(43)}`,
    subjectHint: userId,
    workspaceId,
    createdAt: Date.now(),
  } as const;
}

function businessRecovery() {
  const { workspaceId: _workspaceId, ...recovery } = workspaceRecovery();
  return recovery;
}

async function freshOtp(user: ReturnType<typeof userEvent.setup>, client: WorkspaceDeletionClientLike) {
  await user.click(screen.getByRole('button', { name: '发送重新验证码' }));
  await waitFor(() => expect(client.sendReverificationCode).toHaveBeenCalledWith('person@example.com'));
  await user.type(screen.getByLabelText('重新验证邮件验证码'), '123456');
  await user.click(screen.getByRole('button', { name: '验证验证码' }));
  await waitFor(() => expect(client.verifyReverificationCode)
    .toHaveBeenCalledWith('person@example.com', '123456'));
}

describe('WorkspacePanel recent-OTP deletion controls', () => {
  beforeEach(() => {
    clearWorkspaceDeletionRecovery();
    clearBusinessDeletionRecovery();
    authMock.value = {
      session: { userId, email: 'person@example.com' },
      config: {
        supabaseUrl: 'https://project.supabase.co',
        publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz',
      },
    };
    workspaceMock.value = {
      selected: { workspaceId },
      refresh: vi.fn(async () => undefined),
      // These legacy browser-RPC paths must never be reached by this UI.
      deleteWorkspace: vi.fn(async () => true),
      clearAllBusinessData: vi.fn(async () => receiptId),
    };
  });

  afterEach(() => {
    clearWorkspaceDeletionRecovery();
    clearBusinessDeletionRecovery();
  });

  it('requires matching recent OTP plus the exact phrase for selected workspace deletion', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '删除当前工作区' }));
    expect(screen.queryByLabelText(`输入 ${DELETE_WORKSPACE_CONFIRMATION}`)).not.toBeInTheDocument();
    await freshOtp(user, client);

    const input = screen.getByLabelText(`输入 ${DELETE_WORKSPACE_CONFIRMATION}`);
    const submit = screen.getByRole('button', { name: '确认删除当前工作区' });
    await user.type(input, 'delete_this_workspace');
    expect(submit).toBeDisabled();
    await user.clear(input);
    await user.type(input, DELETE_WORKSPACE_CONFIRMATION);
    await user.click(submit);

    await waitFor(() => expect(client.deleteWorkspace).toHaveBeenCalledWith(
      freshProof,
      workspaceId,
      DELETE_WORKSPACE_CONFIRMATION,
    ));
    expect(workspaceMock.value.deleteWorkspace).not.toHaveBeenCalled();
    expect(workspaceMock.value.refresh).toHaveBeenCalledOnce();
    expect(await screen.findByText('当前工作区已删除。')).toBeInTheDocument();
  });

  it('routes all-business deletion through the same fresh-OTP Edge client', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    workspaceMock.value.refresh = vi.fn(async () => { throw new Error('refresh offline'); });
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '清除全部业务数据' }));
    await freshOtp(user, client);
    const input = screen.getByLabelText(`输入 ${CLEAR_BUSINESS_CONFIRMATION}`);
    await user.type(input, CLEAR_BUSINESS_CONFIRMATION);
    await user.click(screen.getByRole('button', { name: '确认清除全部业务数据' }));

    await waitFor(() => expect(client.clearBusinessData).toHaveBeenCalledWith(
      freshProof,
      CLEAR_BUSINESS_CONFIRMATION,
    ));
    expect(workspaceMock.value.clearAllBusinessData).not.toHaveBeenCalled();
    expect(await screen.findByText('全部业务数据已清除。回执 54f55772')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('fails closed when OTP resolves to another account', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    vi.mocked(client.verifyReverificationCode).mockResolvedValue({ ...freshProof, userId: 'user-2' });
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '删除当前工作区' }));
    await freshOtp(user, client);

    expect(await screen.findByRole('alert')).toHaveTextContent('重新验证账户与当前账户不一致');
    expect(screen.queryByLabelText(`输入 ${DELETE_WORKSPACE_CONFIRMATION}`)).not.toBeInTheDocument();
    expect(client.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('queries a recoverable workspace deletion and refreshes after a completed receipt', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const recovery = workspaceRecovery();
    saveWorkspaceDeletionRecovery(recovery);
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '查询上次工作区删除结果' }));

    await waitFor(() => expect(client.queryWorkspaceDeletionStatus).toHaveBeenCalledWith(recovery));
    expect(await screen.findByText('上次工作区删除已完成，回执 54f55772。')).toBeInTheDocument();
    expect(workspaceMock.value.refresh).toHaveBeenCalledOnce();
    expect(loadWorkspaceDeletionRecovery()).toBeNull();
    expect(screen.queryByRole('button', { name: '查询上次工作区删除结果' })).not.toBeInTheDocument();
  });

  it('retains a pending business-deletion capability for safe retry', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const recovery = businessRecovery();
    saveBusinessDeletionRecovery(recovery);
    vi.mocked(client.queryBusinessDeletionStatus).mockResolvedValue({
      state: 'pending',
      receiptId: null,
      expiresAt: '2026-08-29T00:00:00.000Z',
    });
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '查询上次业务数据清除结果' }));

    expect(await screen.findByText(/服务器尚未开始删除/)).toHaveTextContent('恢复凭据已保留');
    expect(screen.getByRole('button', { name: '查询上次业务数据清除结果' })).toBeInTheDocument();
    expect(workspaceMock.value.refresh).not.toHaveBeenCalled();
  });

  it('clears an expired recovery capability after the server returns 410 semantics', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    saveWorkspaceDeletionRecovery(workspaceRecovery());
    vi.mocked(client.queryWorkspaceDeletionStatus).mockRejectedValue(
      new AccountDeletionClientError('RECOVERY_EXPIRED', '删除结果查询窗口已过期', 410),
    );
    render(<WorkspaceDeletionControls client={client} />);

    await user.click(screen.getByRole('button', { name: '查询上次工作区删除结果' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('删除结果查询窗口已过期');
    expect(loadWorkspaceDeletionRecovery()).toBeNull();
    expect(screen.queryByRole('button', { name: '查询上次工作区删除结果' })).not.toBeInTheDocument();
  });

  it('clears the recovery-code input after unlock and immediate lock', async () => {
    const user = userEvent.setup();
    const selected = { workspaceId };
    workspaceMock.value = {
      phase: 'LOCKED',
      workspaces: [selected],
      selected,
      unlocked: null,
      recoveryKit: null,
      error: '',
      unlockWorkspace: vi.fn(async () => true),
      selectWorkspace: vi.fn(),
      lockWorkspace: vi.fn(),
      refresh: vi.fn(async () => undefined),
    };
    const { rerender } = render(<WorkspacePanel />);

    const input = screen.getByLabelText('恢复密钥');
    await user.type(input, 'rvk1_secret-that-must-not-return');
    await user.click(screen.getByRole('button', { name: '解锁工作区' }));

    workspaceMock.value = {
      ...workspaceMock.value,
      phase: 'UNLOCKED',
      unlocked: { generation: 1, snapshot: { archive: null } },
    };
    rerender(<WorkspacePanel />);
    await user.click(screen.getByRole('button', { name: '立即锁定' }));

    workspaceMock.value = { ...workspaceMock.value, phase: 'LOCKED', unlocked: null };
    rerender(<WorkspacePanel />);
    await waitFor(() => expect(screen.getByLabelText('恢复密钥')).toHaveValue(''));
  });

  it('makes a history fallback visibly read-only and directs a full export before replacement', () => {
    workspaceMock.value = {
      phase: 'UNLOCKED',
      workspaces: [],
      selected: { workspaceId },
      unlocked: {
        generation: 4,
        readOnlyRecovery: true,
        snapshot: { archive: null, reviews: {}, actions: {}, journal: [], guards: [] },
      },
      recoveryKit: null,
      error: '',
      lockWorkspace: vi.fn(),
      refresh: vi.fn(async () => undefined),
    };
    render(<WorkspacePanel />);

    expect(screen.getByRole('alert')).toHaveTextContent('当前历史版本只读');
    expect(screen.getByRole('alert')).toHaveTextContent('先导出');
    expect(screen.getByRole('button', { name: '导出历史恢复完整备份' })).toBeInTheDocument();
  });
});

describe('WorkspacePanel two-phase recovery-root creation', () => {
  const recoveryCode = 'rvk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYX';
  const rootKit = {
    format: 'rv-recovery-kit/2' as const,
    workspaceId,
    recoveryCode,
    signingAlgorithm: 'ed25519-v1' as const,
    signingPublicKeySpki: 'A'.repeat(64),
    signingPrivateKeyPkcs8: 'B'.repeat(64),
    createdAt: '2026-08-28T00:00:00.000Z',
  };

  afterEach(() => vi.restoreAllMocks());

  it('requires a download action before the user can authorize the first remote commit', async () => {
    const user = userEvent.setup();
    const createWorkspace = vi.fn(async () => true);
    const dismissRecoveryKit = vi.fn(async () => true);
    workspaceMock.value = {
      phase: 'NEEDS_SETUP',
      workspaces: [],
      selected: null,
      unlocked: null,
      recoveryKit: null,
      error: '',
      createWorkspace,
      dismissRecoveryKit,
    };
    const { rerender } = render(<WorkspacePanel />);

    expect(screen.getByText(/第一步只在本机内存生成/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '生成恢复文件' }));
    expect(createWorkspace).toHaveBeenCalledOnce();
    expect(dismissRecoveryKit).not.toHaveBeenCalled();

    workspaceMock.value = {
      ...workspaceMock.value,
      phase: 'RECOVERY_READY',
      recoveryKit: rootKit,
    };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => 'blob:recovery-kit');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    rerender(<WorkspacePanel />);

    const commit = screen.getByRole('button', { name: '我已下载并核验，创建云端工作区' });
    expect(commit).toBeDisabled();
    expect(screen.getByText(/不会向云端写入任何工作区数据/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下载恢复文件' }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(commit).toBeEnabled();
    expect(dismissRecoveryKit).not.toHaveBeenCalled();

    await user.click(commit);
    expect(dismissRecoveryKit).toHaveBeenCalledOnce();
  });

  it('passes a v2 recovery file to the resumable creation path instead of dropping the signing root', async () => {
    const user = userEvent.setup();
    const resumeWorkspaceFromRecoveryKit = vi.fn(async () => true);
    workspaceMock.value = {
      phase: 'LOCKED',
      workspaces: [{ workspaceId }],
      selected: { workspaceId },
      unlocked: null,
      recoveryKit: null,
      error: '',
      unlockWorkspace: vi.fn(async () => true),
      resumeWorkspaceFromRecoveryKit,
      selectWorkspace: vi.fn(),
      lockWorkspace: vi.fn(),
      refresh: vi.fn(async () => undefined),
    };
    render(<WorkspacePanel />);

    const file = new File([JSON.stringify(rootKit)], 'recovery.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText('选择恢复文件输入'), file);

    await waitFor(() => expect(resumeWorkspaceFromRecoveryKit).toHaveBeenCalledWith(rootKit));
    expect(workspaceMock.value.unlockWorkspace).not.toHaveBeenCalled();
  });
});
