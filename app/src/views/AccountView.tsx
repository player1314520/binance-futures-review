import React, { useEffect, useMemo, useRef, useState } from 'react';
import WorkspacePanel from '../components/WorkspacePanel';
import {
  ACCOUNT_DELETE_CONFIRMATION,
  ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS,
  ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS,
  ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES,
  ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS,
  ACCOUNT_DELETION_SERVER_STATUS_TTL_MS,
  AccountDeletionClient,
  AccountDeletionClientError,
  clearAccountDeletionRecovery,
  clearAccountDeletionTombstone,
  createAccountDeletionRecovery,
  downloadAccountDeletionRecoveryFile,
  loadAccountDeletionRecovery,
  loadAccountDeletionTombstone,
  parseAccountDeletionRecoveryFile,
  refreshAccountDeletionRecovery,
  saveAccountDeletionRecovery,
  saveAccountDeletionTombstone,
  type AccountDeletionProof,
  type AccountDeletionRecovery,
  type AccountDeletionReceipt,
  type AccountDeletionState,
  type AccountDeletionTombstone,
} from '../lib/account-deletion-client';
import type { AuthSession } from '../lib/auth-client';
import { useAuth } from '../lib/auth-context';

function maskedEmail(email: string | null): string {
  if (!email) return '已验证账户';
  const [name, domain] = email.split('@');
  if (!domain) return '已验证账户';
  return `${name.slice(0, 2)}***@${domain}`;
}

export type AccountDeletionClientLike = Readonly<{
  sendReverificationCode: (email: string) => Promise<void>;
  verifyReverificationCode: (email: string, otp: string) => Promise<AccountDeletionProof>;
  deleteAccount: (
    freshSession: AccountDeletionProof,
    confirmation: string,
    recovery: AccountDeletionRecovery,
  ) => Promise<AccountDeletionReceipt>;
  queryAccountDeletionStatus: (
    recovery: AccountDeletionRecovery,
  ) => Promise<AccountDeletionState>;
}>;

type DeletePhase =
  | 'IDLE'
  | 'SENDING'
  | 'CODE_SENT'
  | 'VERIFYING'
  | 'VERIFIED'
  | 'DELETING'
  | 'RECOVERING'
  | 'CHECKING'
  | 'DONE';

function deletionMessage(error: unknown): string {
  return error instanceof AccountDeletionClientError
    ? error.message
    : '账户删除流程暂时不可用';
}

function serverExpiryNotice(expiresAt: string): string {
  return `服务端返回的查询截止时间：${new Date(expiresAt).toLocaleString()}；以该时间为准。`;
}

export function AccountDeletionPanel({
  session,
  client,
  signOut,
  onCompleted,
  onRecoveryChange,
  downloadRecoveryFile = downloadAccountDeletionRecoveryFile,
}: {
  session: AuthSession;
  client: AccountDeletionClientLike;
  signOut: () => Promise<void>;
  onCompleted?: (tombstone: AccountDeletionTombstone) => void;
  onRecoveryChange?: (recovery: AccountDeletionRecovery | null) => void;
  downloadRecoveryFile?: (recovery: AccountDeletionRecovery) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<DeletePhase>('IDLE');
  const [otp, setOtp] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [recovery, setRecovery] = useState<AccountDeletionRecovery | null>(
    () => loadAccountDeletionRecovery(),
  );
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveryFileDownloaded, setRecoveryFileDownloaded] = useState(false);
  const [recoveryFileSaved, setRecoveryFileSaved] = useState(false);
  const freshSessionRef = useRef<AccountDeletionProof | null>(null);

  useEffect(() => () => {
    freshSessionRef.current = null;
  }, []);

  if (phase === 'DONE') {
    return (
      <section className="panel account-panel danger-panel" aria-live="polite">
        <p className="eyebrow">ACCOUNT DELETED</p>
        <h2>账户已永久删除。回执 {receipt}</h2>
        <p>本机登录令牌已清除；该回执不含邮箱、用户编号或交易内容。</p>
      </section>
    );
  }

  if (!expanded) {
    return (
      <section className="panel account-panel danger-panel">
        <p className="eyebrow">PERMANENT ACCOUNT DELETION</p>
        <h2>永久删除身份与全部云端工作区</h2>
        <p>{recovery
          ? '检测到一个结果尚未确认的删除请求，可继续查询；恢复密钥不会显示在页面上。'
          : '此操作不可撤销，需要重新验证邮件验证码并输入完整确认短语。'}</p>
        <button className="button danger" type="button" onClick={() => {
          setExpanded(true);
          if (recovery) setPhase('RECOVERING');
        }}>{recovery ? '继续确认删除结果' : '永久删除账户'}</button>
      </section>
    );
  }

  const email = session.email;
  const canDelete = phase === 'VERIFIED'
    && confirmation === ACCOUNT_DELETE_CONFIRMATION
    && recovery !== null
    && recoveryFileDownloaded
    && recoveryFileSaved;
  const recoveryMatchesSession = !recovery || recovery.subjectHint === session.userId;

  const sendCode = async () => {
    if (!email || !recoveryMatchesSession) {
      setError('当前账户没有可重新验证的邮箱，无法在网页内永久删除');
      return;
    }
    freshSessionRef.current = null;
    setOtp('');
    setConfirmation('');
    setRecoveryFileDownloaded(false);
    setRecoveryFileSaved(false);
    setRecoveryStatus('');
    setError('');
    setPhase('SENDING');
    try {
      await client.sendReverificationCode(email);
      setPhase('CODE_SENT');
    } catch (caught) {
      setPhase('IDLE');
      setError(deletionMessage(caught));
    }
  };

  const prepareRecoveryFile = () => {
    let currentRecovery = recovery;
    try {
      if (!currentRecovery) {
        currentRecovery = createAccountDeletionRecovery(session.userId);
      }
      currentRecovery = refreshAccountDeletionRecovery(currentRecovery);
      setRecovery(currentRecovery);
      onRecoveryChange?.(currentRecovery);
      downloadRecoveryFile(currentRecovery);
      setRecoveryFileDownloaded(true);
      setRecoveryFileSaved(false);
      setError('');
      setRecoveryStatus('下载已发起；请确认文件已实际保存后再继续。');
    } catch (caught) {
      setRecoveryFileDownloaded(false);
      setRecoveryFileSaved(false);
      setError(deletionMessage(caught));
    }
  };

  const verifyCode = async () => {
    if (!email) return;
    setError('');
    setPhase('VERIFYING');
    try {
      const fresh = await client.verifyReverificationCode(email, otp);
      if (fresh.userId !== session.userId) {
        freshSessionRef.current = null;
        setPhase('CODE_SENT');
        setError('重新验证账户与当前账户不一致');
        return;
      }
      freshSessionRef.current = fresh;
      setOtp('');
      setPhase('VERIFIED');
    } catch (caught) {
      freshSessionRef.current = null;
      setPhase('CODE_SENT');
      setError(deletionMessage(caught));
    }
  };

  const deleteAccount = async () => {
    const fresh = freshSessionRef.current;
    if (
      !fresh
      || confirmation !== ACCOUNT_DELETE_CONFIRMATION
      || !recovery
      || !recoveryFileDownloaded
      || !recoveryFileSaved
    ) return;
    const currentRecovery = recovery;
    if (currentRecovery.createdAt <= Date.now() - ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS) {
      setRecoveryFileDownloaded(false);
      setRecoveryFileSaved(false);
      setError('恢复文件已准备超过 5 分钟。请重新下载并确认保存后再删除，确保文件覆盖完整查询时限。');
      return;
    }
    setError('');
    setRecoveryStatus('');
    setPhase('DELETING');
    let result: AccountDeletionReceipt;
    try {
      result = await client.deleteAccount(fresh, confirmation, currentRecovery);
    } catch (caught) {
      freshSessionRef.current = null;
      setConfirmation('');
      setError(deletionMessage(caught));
      if (caught instanceof AccountDeletionClientError && caught.code === 'OUTCOME_RECOVERABLE') {
        setPhase('RECOVERING');
      } else if (
        caught instanceof AccountDeletionClientError
        && ['RECOVERY_INVALID', 'RECOVERY_CONFLICT', 'RECOVERY_EXPIRED'].includes(caught.code)
      ) {
        clearAccountDeletionRecovery();
        setRecovery(null);
        setRecoveryFileDownloaded(false);
        setRecoveryFileSaved(false);
        onRecoveryChange?.(null);
        setPhase('CODE_SENT');
      } else {
        setPhase('CODE_SENT');
      }
      return;
    }
    freshSessionRef.current = null;
    setConfirmation('');
    clearAccountDeletionRecovery();
    setRecovery(null);
    setRecoveryFileDownloaded(false);
    setRecoveryFileSaved(false);
    onRecoveryChange?.(null);
    const tombstone = Object.freeze({ receiptId: result.receiptId, completedAt: Date.now() });
    saveAccountDeletionTombstone(tombstone);
    onCompleted?.(tombstone);
    setReceipt(result.receiptId.slice(0, 8));
    setPhase('DONE');
    // Account deletion is already authoritative. Local sign-out is best-effort
    // cleanup and must never turn a successful deletion into a failure state.
    try { await signOut(); } catch {}
  };

  const queryDeletionStatus = async () => {
    if (!recovery) return;
    setError('');
    setRecoveryStatus('');
    setPhase('CHECKING');
    try {
      const result = await client.queryAccountDeletionStatus(recovery);
      if (result.state === 'completed' && result.receiptId) {
        clearAccountDeletionRecovery();
        setRecovery(null);
        setRecoveryFileDownloaded(false);
        setRecoveryFileSaved(false);
        onRecoveryChange?.(null);
        const tombstone = Object.freeze({ receiptId: result.receiptId, completedAt: Date.now() });
        saveAccountDeletionTombstone(tombstone);
        onCompleted?.(tombstone);
        setReceipt(result.receiptId.slice(0, 8));
        setPhase('DONE');
        try { await signOut(); } catch {}
        return;
      }
      setRecoveryStatus(result.state === 'deleting'
        ? `服务端仍在确认身份删除结果，请稍后再次查询。${serverExpiryNotice(result.expiresAt)}`
        : `删除请求尚未执行，可重新验证后使用同一请求安全重试。${serverExpiryNotice(result.expiresAt)}`);
      setPhase('RECOVERING');
    } catch (caught) {
      if (
        caught instanceof AccountDeletionClientError
        && ['RECOVERY_NOT_FOUND', 'RECOVERY_EXPIRED', 'RECOVERY_INVALID'].includes(caught.code)
      ) {
        clearAccountDeletionRecovery();
        setRecovery(null);
        setRecoveryFileDownloaded(false);
        setRecoveryFileSaved(false);
        onRecoveryChange?.(null);
      }
      setPhase('RECOVERING');
      setError(deletionMessage(caught));
    }
  };

  return (
    <section className="panel account-panel danger-panel">
      <p className="eyebrow">DELETION CEREMONY</p>
      <h2>永久删除账户</h2>
      <p>第一步重新验证 {maskedEmail(email)}；第二步输入不可撤销确认短语。</p>
      <div className="deletion-flow">
        {recovery && (
          <div className="deletion-recovery-state">
            <p>已有短时删除恢复凭据。先查询最终状态，不要创建新的删除请求。</p>
            <button
              className="button secondary"
              type="button"
              onClick={() => void queryDeletionStatus()}
              disabled={phase === 'CHECKING' || phase === 'DELETING'}
            >{phase === 'CHECKING' ? '查询中…' : '查询删除结果'}</button>
          </div>
        )}
        <button
          className="button secondary"
          type="button"
          onClick={() => void sendCode()}
          disabled={!recoveryMatchesSession || phase === 'SENDING' || phase === 'VERIFYING' || phase === 'DELETING' || phase === 'CHECKING'}
        >
          {phase === 'SENDING' ? '发送中…' : recovery ? '重新验证后安全重试' : '发送重新验证码'}
        </button>
        {(phase === 'CODE_SENT' || phase === 'VERIFYING') && (
          <div className="confirmation-row">
            <label>重新验证邮件验证码
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 10))}
              />
            </label>
            <button
              className="button secondary"
              type="button"
              onClick={() => void verifyCode()}
              disabled={phase === 'VERIFYING' || otp.length < 6}
            >
              {phase === 'VERIFYING' ? '验证中…' : '验证验证码'}
            </button>
          </div>
        )}
        {(phase === 'VERIFIED' || phase === 'DELETING') && (
          <div className="confirmation-row">
            <label>输入 {ACCOUNT_DELETE_CONFIRMATION}
              <input
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className="recovery-file-step">
              <p>
                此文件不是数据备份，也不含尚未生成的服务端到期时间。删除需在下载后
                {' '}{ACCOUNT_DELETION_RECOVERY_PREPARE_WINDOW_MS / 60_000} 分钟内发起；本地导入校验只覆盖产品控制的客户端最长
                {' '}{ACCOUNT_DELETION_CLIENT_TIMEOUT_MAX_MS / 1_000} 秒、Edge 最长
                {' '}{ACCOUNT_DELETION_EDGE_DEADLINE_CONTRACT_MS / 1_000} 秒和服务端
                {' '}{ACCOUNT_DELETION_SERVER_STATUS_TTL_MS / 60_000} 分钟状态窗口。公网路由时延无法由本文件保证，最终以服务端返回的 expiresAt 或 410 为准。
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={prepareRecoveryFile}
                disabled={phase === 'DELETING'}
              >下载删除状态恢复文件</button>
              <label className="recovery-file-confirmation">
                <input
                  type="checkbox"
                  checked={recoveryFileSaved}
                  onChange={(event) => setRecoveryFileSaved(event.target.checked)}
                  disabled={!recoveryFileDownloaded || phase === 'DELETING'}
                />
                我已保存恢复文件
              </label>
            </div>
            <button
              className="button danger"
              type="button"
              onClick={() => void deleteAccount()}
              disabled={!canDelete}
            >
              {phase === 'DELETING' ? '永久删除中…' : '永久删除我的账户'}
            </button>
          </div>
        )}
      </div>
      <button
        className="text-button"
        type="button"
        onClick={() => {
          freshSessionRef.current = null;
          setExpanded(false);
          setPhase('IDLE');
          setOtp('');
          setConfirmation('');
          setRecoveryFileDownloaded(false);
          setRecoveryFileSaved(false);
          setError('');
          setRecoveryStatus('');
        }}
        disabled={phase === 'DELETING' || phase === 'CHECKING'}
      >取消删除</button>
      {recoveryStatus && <p className="delete-status" role="status">{recoveryStatus}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

export function AccountDeletionCompletionPanel({
  tombstone,
  acknowledge,
}: {
  tombstone: AccountDeletionTombstone;
  acknowledge: () => void;
}) {
  return (
    <section className="panel account-panel danger-panel" aria-live="polite">
      <p className="eyebrow">ACCOUNT DELETED</p>
      <h2>账户已永久删除。回执 {tombstone.receiptId.slice(0, 8)}</h2>
      <p>登录令牌已清除；本次浏览器会话只保留不含身份或交易数据的随机回执。</p>
      <button className="button secondary" type="button" onClick={acknowledge}>
        我已知晓，清除回执
      </button>
    </section>
  );
}

export function AccountDeletionRecoveryPanel({
  recovery,
  client,
  onCompleted,
  onRecoveryChange,
  onRecoveryDiscarded,
}: {
  recovery: AccountDeletionRecovery;
  client: AccountDeletionClientLike;
  onCompleted: (tombstone: AccountDeletionTombstone) => void;
  onRecoveryChange: (recovery: AccountDeletionRecovery | null) => void;
  onRecoveryDiscarded?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const query = async () => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await client.queryAccountDeletionStatus(recovery);
      if (result.state === 'completed' && result.receiptId) {
        clearAccountDeletionRecovery();
        onRecoveryChange(null);
        const tombstone = Object.freeze({ receiptId: result.receiptId, completedAt: Date.now() });
        saveAccountDeletionTombstone(tombstone);
        onCompleted(tombstone);
        return;
      }
      setStatus(result.state === 'deleting'
        ? `服务端仍在确认删除结果，请稍后再次查询。${serverExpiryNotice(result.expiresAt)}`
        : `删除请求尚未执行；请重新登录同一账户后安全重试。${serverExpiryNotice(result.expiresAt)}`);
    } catch (caught) {
      const message = deletionMessage(caught);
      if (
        caught instanceof AccountDeletionClientError
        && ['RECOVERY_NOT_FOUND', 'RECOVERY_EXPIRED', 'RECOVERY_INVALID'].includes(caught.code)
      ) {
        clearAccountDeletionRecovery();
        onRecoveryDiscarded?.(message);
        onRecoveryChange(null);
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel account-panel danger-panel">
      <p className="eyebrow">DELETION RECOVERY</p>
      <h2>确认上次账户删除的最终状态</h2>
      <p>查询使用本次浏览器会话中的短时能力，不需要已失效的登录令牌，也不会显示恢复密钥。</p>
      <button className="button secondary" type="button" onClick={() => void query()} disabled={busy}>
        {busy ? '查询中…' : '查询删除结果'}
      </button>
      {status && <p className="delete-status" role="status">{status}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

function readRecoveryFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('invalid file result'));
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('file read failed')), { once: true });
    reader.readAsText(file, 'utf-8');
  });
}

export function AccountDeletionRecoveryImportPanel({
  notice,
  onImported,
}: {
  notice: string;
  onImported: (recovery: AccountDeletionRecovery) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size === 0 || file.size > ACCOUNT_DELETION_RECOVERY_FILE_MAX_BYTES) {
        throw new AccountDeletionClientError(
          'RECOVERY_FILE_INVALID',
          '删除状态恢复文件无效或已被修改',
        );
      }
      const recovery = parseAccountDeletionRecoveryFile(await readRecoveryFile(file));
      saveAccountDeletionRecovery(recovery);
      onImported(recovery);
    } catch (caught) {
      clearAccountDeletionRecovery();
      setError(deletionMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel account-panel recovery-import-panel">
      <p className="eyebrow">DELETION STATUS RECOVERY</p>
      <h2>关页后继续确认账户删除结果</h2>
      <p>恢复文件不是数据备份，只能查询一次删除请求的状态。预删除文件不含服务端 expiresAt；本地期限不能延长服务端能力，能否继续查询以服务端返回的 expiresAt 或 410 为准，且不承诺公网路由时延。完成或过期后请安全删除。</p>
      <label>导入删除状态恢复文件
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void importFile(file);
          }}
        />
      </label>
      {busy && <p className="delete-status" role="status">正在校验恢复文件…</p>}
      {notice && <p className="form-error" role="alert">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

export default function AccountView({
  deletionClientOverride,
  inviteBeta = import.meta.env.VITE_BACKEND_MODE === 'invite-beta',
}: {
  deletionClientOverride?: AccountDeletionClientLike;
  inviteBeta?: boolean;
} = {}) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [tombstone, setTombstone] = useState<AccountDeletionTombstone | null>(
    () => loadAccountDeletionTombstone(),
  );
  const [pendingRecovery, setPendingRecovery] = useState<AccountDeletionRecovery | null>(
    () => loadAccountDeletionRecovery(),
  );
  const [recoveryImportNotice, setRecoveryImportNotice] = useState('');
  const defaultDeletionClient = useMemo(
    () => auth.config ? new AccountDeletionClient(auth.config) : null,
    [auth.config],
  );
  const deletionClient = deletionClientOverride ?? defaultDeletionClient;

  if (tombstone) {
    return (
      <div className="page-stack">
        <AccountDeletionCompletionPanel
          tombstone={tombstone}
          acknowledge={() => {
            clearAccountDeletionTombstone();
            setTombstone(null);
          }}
        />
      </div>
    );
  }

  if (auth.phase === 'UNCONFIGURED' || auth.phase === 'CONFIG_INVALID') {
    return (
      <div className="page-stack">
        <header className="page-heading">
          <div><p className="eyebrow">PRODUCTION ACCOUNT</p><h1>生产账户尚未绑定。</h1></div>
          <p>当前构建继续保持离线：不会上传 CSV、复盘文字或任何交易数据。</p>
        </header>
        <section className="panel account-panel">
          <h2>{auth.phase === 'CONFIG_INVALID' ? '配置未通过安全校验' : '等待独立生产项目'}</h2>
          <p>{auth.error || '必须使用新的独立 Supabase 项目；旧交易库和其它产品数据库不会被复用。'}</p>
          <ul className="boundary-list">
            <li>浏览器只接受 publishable key，管理密钥会被代码拒绝。</li>
            <li>未配置构建不会上传记录；旧端到端加密 vault 只作为只读迁移源，新 Beta 数据面须另行部署并重新确认数据处理方式。</li>
            <li>登录固定为邀请制；客户端没有自行开放注册的开关。</li>
          </ul>
        </section>
      </div>
    );
  }

  if (auth.session) {
    return (
      <div className="page-stack">
        <header className="page-heading">
          <div><p className="eyebrow">PRODUCTION ACCOUNT</p><h1>账户已验证。</h1></div>
          <p>{inviteBeta
            ? '登录只证明身份；Binance 连接与服务端数据处理仍需单独确认。'
            : '登录只证明身份；恢复密钥仍需单独解锁旧版交易工作区。'}</p>
        </header>
        <section className="panel account-panel">
          <div className="account-state"><span className="trust-dot" /><strong>{maskedEmail(auth.session.email)}</strong></div>
          <p>{inviteBeta
            ? '会话令牌只保留在当前浏览器会话；旧端到端加密 vault 已冻结为只读迁移源，不提供创建或写入入口。'
            : '会话令牌只保留在当前浏览器会话；恢复密钥不会写入本地持久存储。'}</p>
          <button className="button secondary" type="button" onClick={() => void auth.signOut()} disabled={auth.phase === 'SIGNING_OUT'}>
            {auth.phase === 'SIGNING_OUT' ? '退出中…' : '退出全部会话'}
          </button>
        </section>
        {!inviteBeta && <WorkspacePanel />}
        {deletionClient && (
          <AccountDeletionPanel
            session={auth.session}
            client={deletionClient}
            signOut={auth.signOut}
            onCompleted={setTombstone}
            onRecoveryChange={setPendingRecovery}
          />
        )}
      </div>
    );
  }

  if (pendingRecovery && deletionClient) {
    return (
      <div className="page-stack">
        <header className="page-heading">
          <div><p className="eyebrow">ACCOUNT DELETION</p><h1>删除结果等待确认。</h1></div>
          <p>即使登录令牌已失效，也可使用本次浏览器会话的短时恢复能力查询。</p>
        </header>
        <AccountDeletionRecoveryPanel
          recovery={pendingRecovery}
          client={deletionClient}
          onCompleted={setTombstone}
          onRecoveryChange={setPendingRecovery}
          onRecoveryDiscarded={setRecoveryImportNotice}
        />
      </div>
    );
  }

  const codeSent = auth.phase === 'CODE_SENT' || auth.phase === 'VERIFYING';
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">INVITE-ONLY ACCESS</p><h1>登录邀请制复盘账户。</h1></div>
        <p>验证码只验证受邀邮箱，原始 CSV 不上传；连接 Binance 须在数据中心另行确认 Key/Secret 会进入服务器并加密保存。</p>
      </header>
      <section className="panel account-panel">
        {!codeSent ? (
          <form onSubmit={(event) => { event.preventDefault(); void auth.sendCode(email); }}>
            <label>邀请邮箱<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} /></label>
            <button className="button primary" type="submit" disabled={auth.phase === 'SENDING_CODE' || email.length < 5}>
              {auth.phase === 'SENDING_CODE' ? '发送中…' : '发送验证码'}
            </button>
          </form>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void auth.verifyCode(otp); }}>
            <p>验证码已发送到 {maskedEmail(auth.pendingEmail)}。</p>
            <label>邮件验证码<input inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 10))} /></label>
            <button className="button primary" type="submit" disabled={auth.phase === 'VERIFYING' || otp.length < 6}>
              {auth.phase === 'VERIFYING' ? '验证中…' : '验证并进入'}
            </button>
          </form>
        )}
        {auth.error && <p className="form-error" role="alert">{auth.error}</p>}
      </section>
      {deletionClient && (
        <AccountDeletionRecoveryImportPanel
          notice={recoveryImportNotice}
          onImported={(recovery) => {
            setRecoveryImportNotice('');
            setPendingRecovery(recovery);
          }}
        />
      )}
    </div>
  );
}
