import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  AccountDeletionClientError,
  createAccountDeletionRecovery,
  loadAccountDeletionRecovery,
  loadAccountDeletionTombstone,
  serializeAccountDeletionRecoveryFile,
  saveAccountDeletionRecovery,
} from '../lib/account-deletion-client';
import { AuthProvider, type AuthRuntime } from '../lib/auth-context';
import { saveAuthSession } from '../lib/auth-session-storage';

vi.mock('../components/WorkspacePanel', () => ({
  default: () => <div data-testid="legacy-workspace-panel">创建云端工作区</div>,
}));

import AccountView, { AccountDeletionPanel, type AccountDeletionClientLike } from './AccountView';

const userId = '92bf60cf-6964-4dcc-b2f4-dd14b82b0741';
const receiptId = '67cbfa9e-a892-417c-ac5b-b6ee3e4511e6';
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const session = {
  accessToken: 'old-access-token-value-that-is-long-enough',
  refreshToken: 'old-refresh-token-value',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId,
  email: 'person@example.com',
} as const;

const freshProof = {
  accessToken: 'fresh-access-token-value-that-is-long-enough',
  expiresAt: Date.now() + 60 * 60 * 1000,
  userId,
  email: 'person@example.com',
} as const;

function fakeClient(overrides: Partial<AccountDeletionClientLike> = {}): AccountDeletionClientLike {
  return {
    sendReverificationCode: vi.fn(async () => undefined),
    verifyReverificationCode: vi.fn(async () => freshProof),
    deleteAccount: vi.fn(async () => ({
      state: 'completed' as const,
      receiptId,
      expiresAt,
    })),
    queryAccountDeletionStatus: vi.fn(async () => ({
      state: 'completed' as const,
      receiptId,
      expiresAt,
    })),
    ...overrides,
  };
}

async function completeReverification(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '发送重新验证码' }));
  await user.type(screen.getByLabelText('重新验证邮件验证码'), '123456');
  await user.click(screen.getByRole('button', { name: '验证验证码' }));
}

async function confirmRecoveryFileSaved(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '下载删除状态恢复文件' }));
  const saved = screen.getByRole('checkbox', { name: '我已保存恢复文件' });
  expect(saved).toBeEnabled();
  await user.click(saved);
}

describe('AccountDeletionPanel', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:account-deletion-recovery'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('requires a matching OTP, exact phrase, recovery-file download, and explicit saved confirmation', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const signOut = vi.fn(async () => undefined);
    render(<AccountDeletionPanel session={session} client={client} signOut={signOut} />);

    await user.click(screen.getByRole('button', { name: '永久删除账户' }));
    await completeReverification(user);
    await waitFor(() => expect(client.verifyReverificationCode)
      .toHaveBeenCalledWith('person@example.com', '123456'));

    const confirmation = screen.getByLabelText(`输入 ${ACCOUNT_DELETE_CONFIRMATION}`);
    const submit = screen.getByRole('button', { name: '永久删除我的账户' });
    expect(screen.getByText(/公网路由时延无法由本文件保证/)).toHaveTextContent(
      '最终以服务端返回的 expiresAt 或 410 为准',
    );
    expect(document.body.textContent).not.toContain('文件最多 67 分钟');
    await user.type(confirmation, 'delete_my_account');
    expect(submit).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, ACCOUNT_DELETE_CONFIRMATION);
    expect(submit).toBeDisabled();
    expect(client.deleteAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '下载删除状态恢复文件' }));
    const prepared = loadAccountDeletionRecovery();
    expect(prepared).not.toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain(prepared?.recoverySecret);
    expect(document.body.textContent).not.toContain(prepared?.requestId);
    expect(submit).toBeDisabled();
    expect(client.deleteAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: '我已保存恢复文件' }));
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(client.deleteAccount).toHaveBeenCalledOnce());
    const [proof, phrase, recovery] = vi.mocked(client.deleteAccount).mock.calls[0];
    expect(proof).toEqual(freshProof);
    expect(phrase).toBe(ACCOUNT_DELETE_CONFIRMATION);
    expect(recovery).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      recoverySecret: expect.stringMatching(/^rvr1_[A-Za-z0-9_-]{43}$/),
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(loadAccountDeletionRecovery()).toBeNull();
    expect(screen.getByText('账户已永久删除。回执 67cbfa9e')).toBeInTheDocument();
  });

  it('requires a fresh recovery-file download when deletion was delayed over five minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const anchor = Date.now();
      vi.setSystemTime(anchor);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const client = fakeClient();
      render(<AccountDeletionPanel session={session} client={client} signOut={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: '永久删除账户' }));
      await completeReverification(user);
      await user.type(screen.getByLabelText(`输入 ${ACCOUNT_DELETE_CONFIRMATION}`), ACCOUNT_DELETE_CONFIRMATION);
      await user.click(screen.getByRole('button', { name: '下载删除状态恢复文件' }));
      const preparedAt = loadAccountDeletionRecovery()?.createdAt;
      expect(preparedAt).toBeTypeOf('number');
      await user.click(screen.getByRole('checkbox', { name: '我已保存恢复文件' }));

      vi.setSystemTime(Number(preparedAt) + 5 * 60 * 1000 + 1);
      await user.click(screen.getByRole('button', { name: '永久删除我的账户' }));

      expect(client.deleteAccount).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('请重新下载并确认保存');
      expect(screen.getByRole('checkbox', { name: '我已保存恢复文件' })).not.toBeChecked();

      await user.click(screen.getByRole('button', { name: '下载删除状态恢复文件' }));
      const refreshedAt = loadAccountDeletionRecovery()?.createdAt;
      expect(Number(refreshedAt)).toBeGreaterThan(Number(preparedAt));
      await user.click(screen.getByRole('checkbox', { name: '我已保存恢复文件' }));
      await user.click(screen.getByRole('button', { name: '永久删除我的账户' }));
      await waitFor(() => expect(client.deleteAccount).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed if the OTP session belongs to a different subject', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      verifyReverificationCode: vi.fn(async () => ({ ...freshProof, userId: 'user-2' })),
    });
    render(<AccountDeletionPanel session={session} client={client} signOut={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '永久删除账户' }));
    await completeReverification(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('重新验证账户与当前账户不一致');
    expect(client.deleteAccount).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(`输入 ${ACCOUNT_DELETE_CONFIRMATION}`)).not.toBeInTheDocument();
  });

  it('recovers a lost delete response by querying the same capability without retrying blindly', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      deleteAccount: vi.fn(async () => {
        throw new AccountDeletionClientError(
          'OUTCOME_RECOVERABLE',
          '未能确认删除结果；请使用当前恢复凭据查询最终状态',
        );
      }),
    });
    const signOut = vi.fn(async () => undefined);
    render(<AccountDeletionPanel session={session} client={client} signOut={signOut} />);

    await user.click(screen.getByRole('button', { name: '永久删除账户' }));
    await completeReverification(user);
    await user.type(screen.getByLabelText(`输入 ${ACCOUNT_DELETE_CONFIRMATION}`), ACCOUNT_DELETE_CONFIRMATION);
    await confirmRecoveryFileSaved(user);
    await user.click(screen.getByRole('button', { name: '永久删除我的账户' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('未能确认删除结果');
    const recovery = loadAccountDeletionRecovery();
    expect(recovery).not.toBeNull();
    expect(client.queryAccountDeletionStatus).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '查询删除结果' }));
    await waitFor(() => expect(client.queryAccountDeletionStatus)
      .toHaveBeenCalledWith(recovery));
    expect(client.deleteAccount).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(loadAccountDeletionRecovery()).toBeNull();
    expect(screen.getByText('账户已永久删除。回执 67cbfa9e')).toBeInTheDocument();
  });

  it('surfaces the server expiresAt as the authority for a pending request', async () => {
    const recovery = createAccountDeletionRecovery(userId);
    saveAccountDeletionRecovery(recovery);
    const client = fakeClient({
      queryAccountDeletionStatus: vi.fn(async () => ({
        state: 'pending' as const,
        receiptId: null,
        expiresAt,
      })),
    });
    const user = userEvent.setup();
    render(<AccountDeletionPanel session={session} client={client} signOut={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '继续确认删除结果' }));
    await user.click(screen.getByRole('button', { name: '查询删除结果' }));

    expect(await screen.findByRole('status')).toHaveTextContent('以该时间为准');
    expect(screen.getByRole('status')).toHaveTextContent(new Date(expiresAt).toLocaleString());
  });

  it('keeps a non-sensitive tombstone visible after real AuthProvider sign-out until acknowledged', async () => {
    saveAuthSession(session);
    const user = userEvent.setup();
    const client = fakeClient();
    const runtime: AuthRuntime = {
      config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' },
      invalidMessage: null,
      client: {
        sendEmailOtp: vi.fn(async () => undefined),
        verifyEmailOtp: vi.fn(async () => session),
        refresh: vi.fn(async () => session),
        signOut: vi.fn(async () => undefined),
      },
    };
    render(
      <AuthProvider runtime={runtime}>
        <AccountView deletionClientOverride={client} />
      </AuthProvider>,
    );

    await screen.findByText('账户已验证。');
    await user.click(screen.getByRole('button', { name: '永久删除账户' }));
    await completeReverification(user);
    await user.type(screen.getByLabelText(`输入 ${ACCOUNT_DELETE_CONFIRMATION}`), ACCOUNT_DELETE_CONFIRMATION);
    await confirmRecoveryFileSaved(user);
    await user.click(screen.getByRole('button', { name: '永久删除我的账户' }));

    expect(await screen.findByText('账户已永久删除。回执 67cbfa9e')).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('rv-production-auth-v1')).toBeNull());
    expect(loadAccountDeletionTombstone()).toMatchObject({ receiptId });
    expect(JSON.stringify(loadAccountDeletionTombstone())).not.toContain(userId);

    await user.click(screen.getByRole('button', { name: '我已知晓，清除回执' }));
    expect(await screen.findByText('登录邀请制复盘账户。')).toBeInTheDocument();
    expect(screen.getByText(/预删除文件不含服务端 expiresAt/)).toHaveTextContent(
      '不承诺公网路由时延',
    );
    expect(loadAccountDeletionTombstone()).toBeNull();
  });

  it('keeps the legacy E2EE vault read-only and hides its write panel in invite beta', async () => {
    saveAuthSession(session);
    const runtime: AuthRuntime = {
      config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' },
      invalidMessage: null,
      client: {
        sendEmailOtp: vi.fn(async () => undefined),
        verifyEmailOtp: vi.fn(async () => session),
        refresh: vi.fn(async () => session),
        signOut: vi.fn(async () => undefined),
      },
    };

    render(
      <AuthProvider runtime={runtime}>
        <AccountView deletionClientOverride={fakeClient()} inviteBeta />
      </AuthProvider>,
    );

    expect(await screen.findByText('账户已验证。')).toBeInTheDocument();
    expect(screen.getByText(/旧端到端加密 vault 已冻结为只读迁移源/)).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-workspace-panel')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('创建云端工作区');
    expect(document.body.textContent).not.toContain('恢复密钥仍需单独解锁');
  });

  it('restores account-status querying while signed out after a refresh-like remount', async () => {
    const recovery = createAccountDeletionRecovery(userId);
    saveAccountDeletionRecovery(recovery);
    const client = fakeClient();
    const runtime: AuthRuntime = {
      config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' },
      invalidMessage: null,
      client: {
        sendEmailOtp: vi.fn(async () => undefined),
        verifyEmailOtp: vi.fn(async () => session),
        refresh: vi.fn(async () => session),
        signOut: vi.fn(async () => undefined),
      },
    };
    render(
      <AuthProvider runtime={runtime}>
        <AccountView deletionClientOverride={client} />
      </AuthProvider>,
    );

    expect(await screen.findByText('删除结果等待确认。')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '查询删除结果' }));
    await waitFor(() => expect(client.queryAccountDeletionStatus).toHaveBeenCalledWith(recovery));
    expect(await screen.findByText('账户已永久删除。回执 67cbfa9e')).toBeInTheDocument();
    expect(loadAccountDeletionRecovery()).toBeNull();
    expect(loadAccountDeletionTombstone()).toMatchObject({ receiptId });
  });

  it('imports a recovery file after tab-close storage loss and queries without a login token', async () => {
    const recovery = createAccountDeletionRecovery(userId);
    const recoveryFile = serializeAccountDeletionRecoveryFile(recovery);
    sessionStorage.clear();
    const client = fakeClient();
    const runtime: AuthRuntime = {
      config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' },
      invalidMessage: null,
      client: {
        sendEmailOtp: vi.fn(async () => undefined),
        verifyEmailOtp: vi.fn(async () => session),
        refresh: vi.fn(async () => session),
        signOut: vi.fn(async () => undefined),
      },
    };
    render(
      <AuthProvider runtime={runtime}>
        <AccountView deletionClientOverride={client} />
      </AuthProvider>,
    );

    expect(await screen.findByText('登录邀请制复盘账户。')).toBeInTheDocument();
    const file = new File([recoveryFile], 'review-workbench-account-deletion-recovery-v1.json', {
      type: 'application/json',
    });
    await userEvent.setup().upload(screen.getByLabelText('导入删除状态恢复文件'), file);

    expect(await screen.findByText('删除结果等待确认。')).toBeInTheDocument();
    expect(loadAccountDeletionRecovery()).toEqual(recovery);
    expect(document.body.textContent).not.toContain(recovery.recoverySecret);
    expect(document.body.textContent).not.toContain(recovery.requestId);
    expect(localStorage).toHaveLength(0);

    await userEvent.setup().click(screen.getByRole('button', { name: '查询删除结果' }));
    await waitFor(() => expect(client.queryAccountDeletionStatus).toHaveBeenCalledWith(recovery));
    expect(await screen.findByText('账户已永久删除。回执 67cbfa9e')).toBeInTheDocument();
    expect(loadAccountDeletionRecovery()).toBeNull();
  });

  it('clears an imported capability when the server says its query window expired', async () => {
    const recovery = createAccountDeletionRecovery(userId);
    const client = fakeClient({
      queryAccountDeletionStatus: vi.fn(async () => {
        throw new AccountDeletionClientError('RECOVERY_EXPIRED', '删除结果查询窗口已过期', 410);
      }),
    });
    const runtime: AuthRuntime = {
      config: { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' },
      invalidMessage: null,
      client: {
        sendEmailOtp: vi.fn(async () => undefined),
        verifyEmailOtp: vi.fn(async () => session),
        refresh: vi.fn(async () => session),
        signOut: vi.fn(async () => undefined),
      },
    };
    render(
      <AuthProvider runtime={runtime}>
        <AccountView deletionClientOverride={client} />
      </AuthProvider>,
    );

    const file = new File([serializeAccountDeletionRecoveryFile(recovery)], 'recovery.json', {
      type: 'application/json',
    });
    await userEvent.setup().upload(await screen.findByLabelText('导入删除状态恢复文件'), file);
    await userEvent.setup().click(await screen.findByRole('button', { name: '查询删除结果' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('删除结果查询窗口已过期');
    expect(loadAccountDeletionRecovery()).toBeNull();
    expect(await screen.findByText('登录邀请制复盘账户。')).toBeInTheDocument();
  });
});
