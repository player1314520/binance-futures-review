import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLEAR_BUSINESS_CONFIRMATION,
  DELETE_WORKSPACE_CONFIRMATION,
  AccountDeletionClient,
  AccountDeletionClientError,
  clearBusinessDeletionRecovery,
  clearWorkspaceDeletionRecovery,
  loadBusinessDeletionRecovery,
  loadWorkspaceDeletionRecovery,
  type AccountDeletionProof,
  type AccountDeletionState,
  type BusinessDeletionRecovery,
  type BusinessDeletionReceipt,
  type WorkspaceDeletionRecovery,
  type WorkspaceDeletionReceipt,
} from '../lib/account-deletion-client';
import { useAuth } from '../lib/auth-context';
import { parseRecoveryKit, serializeRecoveryKit } from '../lib/recovery-code';
import { useWorkspace } from '../lib/workspace-context';

function downloadRecoveryKit(text: string, workspaceId: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `复盘工作区恢复文件-${workspaceId.slice(0, 8)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
  }, 100);
}

function downloadRecoveredWorkspace(snapshot: unknown, workspaceId: string) {
  const text = JSON.stringify({
    format: 'rv-history-recovery-export/1',
    exportedAt: new Date().toISOString(),
    workspaceId,
    snapshot,
  });
  const blob = new Blob([text], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `复盘工作区历史恢复完整备份-${workspaceId.slice(0, 8)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
  }, 100);
}

export type WorkspaceDeletionClientLike = Readonly<{
  sendReverificationCode: (email: string) => Promise<void>;
  verifyReverificationCode: (email: string, otp: string) => Promise<AccountDeletionProof>;
  deleteWorkspace: (
    proof: AccountDeletionProof,
    workspaceId: string,
    confirmation: string,
  ) => Promise<WorkspaceDeletionReceipt>;
  clearBusinessData: (
    proof: AccountDeletionProof,
    confirmation: string,
  ) => Promise<BusinessDeletionReceipt>;
  queryWorkspaceDeletionStatus: (
    recovery: WorkspaceDeletionRecovery,
  ) => Promise<AccountDeletionState>;
  queryBusinessDeletionStatus: (
    recovery: BusinessDeletionRecovery,
  ) => Promise<AccountDeletionState>;
}>;

type DeletionMode = 'NONE' | 'WORKSPACE' | 'ALL';
type DeletionPhase = 'IDLE' | 'SENDING' | 'CODE_SENT' | 'VERIFYING' | 'VERIFIED' | 'DELETING';

function deletionMessage(error: unknown): string {
  return error instanceof AccountDeletionClientError
    ? error.message
    : '数据删除流程暂时不可用';
}

export function WorkspaceDeletionControls({
  client: suppliedClient,
}: {
  client?: WorkspaceDeletionClientLike;
}) {
  const auth = useAuth();
  const workspace = useWorkspace();
  const defaultClient = useMemo(
    () => auth.config ? new AccountDeletionClient(auth.config) : null,
    [auth.config],
  );
  const client = suppliedClient ?? defaultClient;
  const [mode, setMode] = useState<DeletionMode>('NONE');
  const [phase, setPhase] = useState<DeletionPhase>('IDLE');
  const [otp, setOtp] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [workspaceRecovery, setWorkspaceRecovery] = useState<WorkspaceDeletionRecovery | null>(
    () => loadWorkspaceDeletionRecovery(),
  );
  const [businessRecovery, setBusinessRecovery] = useState<BusinessDeletionRecovery | null>(
    () => loadBusinessDeletionRecovery(),
  );
  const [querying, setQuerying] = useState<'WORKSPACE' | 'ALL' | null>(null);
  const freshProofRef = useRef<AccountDeletionProof | null>(null);

  useEffect(() => () => { freshProofRef.current = null; }, []);

  const open = (next: 'WORKSPACE' | 'ALL') => {
    setMode(next);
    setPhase('IDLE');
    setOtp('');
    setConfirmation('');
    setStatus('');
    setError('');
    freshProofRef.current = null;
  };

  const cancel = () => {
    freshProofRef.current = null;
    setMode('NONE');
    setPhase('IDLE');
    setOtp('');
    setConfirmation('');
    setError('');
  };

  const sendCode = async () => {
    const email = auth.session?.email;
    if (!client || !email) {
      setError('当前账户没有可重新验证的邮箱，无法删除云端数据');
      return;
    }
    freshProofRef.current = null;
    setOtp('');
    setConfirmation('');
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

  const verifyCode = async () => {
    const email = auth.session?.email;
    if (!client || !email || !auth.session) return;
    setError('');
    setPhase('VERIFYING');
    try {
      const proof = await client.verifyReverificationCode(email, otp);
      if (proof.userId !== auth.session.userId) {
        freshProofRef.current = null;
        setPhase('CODE_SENT');
        setError('重新验证账户与当前账户不一致');
        return;
      }
      freshProofRef.current = proof;
      setOtp('');
      setPhase('VERIFIED');
    } catch (caught) {
      freshProofRef.current = null;
      setPhase('CODE_SENT');
      setError(deletionMessage(caught));
    }
  };

  const deleteCurrent = async () => {
    const proof = freshProofRef.current;
    const workspaceId = workspace.selected?.workspaceId;
    if (!client || !proof || !workspaceId || confirmation !== DELETE_WORKSPACE_CONFIRMATION) return;
    setPhase('DELETING');
    setError('');
    try {
      await client.deleteWorkspace(proof, workspaceId, confirmation);
      freshProofRef.current = null;
      setWorkspaceRecovery(null);
      setStatus('当前工作区已删除。');
      setMode('NONE');
      setPhase('IDLE');
      setConfirmation('');
      try { await workspace.refresh(); } catch {}
    } catch (caught) {
      freshProofRef.current = null;
      setWorkspaceRecovery(loadWorkspaceDeletionRecovery());
      setPhase('CODE_SENT');
      setConfirmation('');
      setError(deletionMessage(caught));
    }
  };

  const clearAll = async () => {
    const proof = freshProofRef.current;
    if (!client || !proof || confirmation !== CLEAR_BUSINESS_CONFIRMATION) return;
    setPhase('DELETING');
    setError('');
    try {
      const receipt = await client.clearBusinessData(proof, confirmation);
      freshProofRef.current = null;
      setBusinessRecovery(null);
      setStatus(`全部业务数据已清除。回执 ${receipt.receiptId.slice(0, 8)}`);
      setMode('NONE');
      setPhase('IDLE');
      setConfirmation('');
      try { await workspace.refresh(); } catch {}
    } catch (caught) {
      freshProofRef.current = null;
      setBusinessRecovery(loadBusinessDeletionRecovery());
      setPhase('CODE_SENT');
      setConfirmation('');
      setError(deletionMessage(caught));
    }
  };

  const queryDeletionStatus = async (kind: 'WORKSPACE' | 'ALL') => {
    const recovery = kind === 'WORKSPACE' ? workspaceRecovery : businessRecovery;
    if (!client || !recovery) return;
    setError('');
    setStatus('');
    setQuerying(kind);
    try {
      const result = kind === 'WORKSPACE'
        ? await client.queryWorkspaceDeletionStatus(recovery as WorkspaceDeletionRecovery)
        : await client.queryBusinessDeletionStatus(recovery);
      if (result.state === 'completed') {
        const receipt = result.receiptId ? `，回执 ${result.receiptId.slice(0, 8)}` : '';
        if (kind === 'WORKSPACE') {
          clearWorkspaceDeletionRecovery();
          setWorkspaceRecovery(null);
        } else {
          clearBusinessDeletionRecovery();
          setBusinessRecovery(null);
        }
        setStatus(`${kind === 'WORKSPACE' ? '上次工作区删除' : '上次业务数据清除'}已完成${receipt}。`);
        try { await workspace.refresh(); } catch {}
      } else {
        const progress = result.state === 'deleting' ? '服务器正在删除' : '服务器尚未开始删除';
        setStatus(`${progress}。恢复凭据已保留；如需重试，请重新验证邮件，系统会安全复用同一请求。`);
      }
    } catch (caught) {
      if (
        caught instanceof AccountDeletionClientError
        && ['RECOVERY_EXPIRED', 'RECOVERY_NOT_FOUND', 'RECOVERY_INVALID'].includes(caught.code)
      ) {
        if (kind === 'WORKSPACE') {
          clearWorkspaceDeletionRecovery();
          setWorkspaceRecovery(null);
        } else {
          clearBusinessDeletionRecovery();
          setBusinessRecovery(null);
        }
      }
      setError(deletionMessage(caught));
    } finally {
      setQuerying(null);
    }
  };

  const busy = phase === 'SENDING' || phase === 'VERIFYING' || phase === 'DELETING';
  const phrase = mode === 'WORKSPACE' ? DELETE_WORKSPACE_CONFIRMATION : CLEAR_BUSINESS_CONFIRMATION;

  return (
    <div className="workspace-danger-zone">
      <div>
        <p className="eyebrow">DATA DELETION</p>
        <h3>删除云端数据</h3>
        <p>可只删除当前工作区，也可清除该账户的全部复盘业务数据；两者都不等于删除登录账户。</p>
      </div>
      {(workspaceRecovery || businessRecovery) && (
        <div className="confirmation-row deletion-recovery-row">
          <p>检测到上次删除请求的会话恢复凭据。可查询最终状态；页面不会显示恢复密钥。</p>
          <div className="button-row">
            {workspaceRecovery && (
              <button
                className="button secondary"
                type="button"
                disabled={querying !== null}
                onClick={() => void queryDeletionStatus('WORKSPACE')}
              >{querying === 'WORKSPACE' ? '查询中…' : '查询上次工作区删除结果'}</button>
            )}
            {businessRecovery && (
              <button
                className="button secondary"
                type="button"
                disabled={querying !== null}
                onClick={() => void queryDeletionStatus('ALL')}
              >{querying === 'ALL' ? '查询中…' : '查询上次业务数据清除结果'}</button>
            )}
          </div>
        </div>
      )}
      {mode === 'NONE' ? (
        <div className="button-row">
          <button className="button danger-quiet" type="button" onClick={() => open('WORKSPACE')}>删除当前工作区</button>
          <button className="button danger" type="button" onClick={() => open('ALL')}>清除全部业务数据</button>
        </div>
      ) : (
        <div className="confirmation-row">
          <p>先用当前账户的邮件验证码重新验证，再输入完整确认短语。</p>
          <button className="button secondary" type="button" disabled={busy} onClick={() => void sendCode()}>
            {phase === 'SENDING' ? '发送中…' : '发送重新验证码'}
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
              <button className="button secondary" type="button" disabled={phase === 'VERIFYING' || otp.length < 6} onClick={() => void verifyCode()}>
                {phase === 'VERIFYING' ? '验证中…' : '验证验证码'}
              </button>
            </div>
          )}
          {(phase === 'VERIFIED' || phase === 'DELETING') && (
            <div className="confirmation-row">
              <label>输入 {phrase}
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <div className="button-row">
                {mode === 'WORKSPACE' ? (
                  <button className="button danger" type="button" disabled={busy || confirmation !== phrase} onClick={() => void deleteCurrent()}>
                    {phase === 'DELETING' ? '删除中…' : '确认删除当前工作区'}
                  </button>
                ) : (
                  <button className="button danger" type="button" disabled={busy || confirmation !== phrase} onClick={() => void clearAll()}>
                    {phase === 'DELETING' ? '清除中…' : '确认清除全部业务数据'}
                  </button>
                )}
              </div>
            </div>
          )}
          <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
        </div>
      )}
      {status && <p className="delete-status" role="status">{status}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function WorkspacePanel() {
  const workspace = useWorkspace();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [kitSaved, setKitSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecoveryCode('');
  }, [workspace.selected?.workspaceId, workspace.unlocked]);

  useEffect(() => {
    setKitSaved(false);
  }, [workspace.recoveryKit?.workspaceId, workspace.recoveryKit?.recoveryCode]);

  if (workspace.phase === 'LOADING') return <section className="panel account-panel"><p>正在读取加密工作区列表…</p></section>;
  if (workspace.recoveryKit) {
    const serialized = serializeRecoveryKit(workspace.recoveryKit);
    const committing = workspace.phase === 'COMMITTING';
    return (
      <section className="panel account-panel recovery-panel">
        <p className="eyebrow">RECOVERY KIT V2 · BEFORE CLOUD COMMIT</p>
        <h2>先下载并核验恢复文件，再创建云端工作区</h2>
        <p>文件包含恢复密钥和不可变签名根；在你确认之前，页面不会向云端写入任何工作区数据。不要发给客服，不要放进公开仓库。</p>
        <code>{workspace.recoveryKit.recoveryCode}</code>
        <div className="button-row">
          <button className="button primary" type="button" disabled={committing} onClick={() => {
            downloadRecoveryKit(serialized, workspace.recoveryKit!.workspaceId);
            setKitSaved(true);
          }}>下载恢复文件</button>
          <button className="button secondary" type="button" disabled={!kitSaved || committing} onClick={() => void workspace.dismissRecoveryKit()}>
            {committing ? '正在校验并创建…' : '我已下载并核验，创建云端工作区'}
          </button>
        </div>
        {!kitSaved && <p className="panel-footnote">关闭前必须先下载；页面不会把恢复密钥或签名私钥写入 localStorage / sessionStorage。</p>}
        {workspace.error && <p className="form-error" role="alert">{workspace.error}</p>}
      </section>
    );
  }

  if (
    workspace.phase === 'NEEDS_SETUP'
    || workspace.phase === 'CREATING'
    || (workspace.phase === 'ERROR' && !workspace.selected)
  ) {
    return (
      <section className="panel account-panel">
        <p className="eyebrow">ENCRYPTED WORKSPACE</p>
        <h2>创建你的第一个加密工作区</h2>
        <p>第一步只在本机内存生成恢复文件；下载并确认后才会创建云端密文工作区。</p>
        <button className="button primary" type="button" onClick={() => void workspace.createWorkspace()} disabled={workspace.phase === 'CREATING'}>
          {workspace.phase === 'CREATING' ? '正在本机生成…' : '生成恢复文件'}
        </button>
        {workspace.error && <p className="form-error" role="alert">{workspace.error}</p>}
      </section>
    );
  }

  if (workspace.phase === 'LOCKED' || workspace.phase === 'UNLOCKING') {
    return (
      <section className="panel account-panel">
        <p className="eyebrow">WORKSPACE LOCKED</p>
        <h2>解锁加密工作区</h2>
        {workspace.workspaces.length > 1 && (
          <label>工作区<select value={workspace.selected?.workspaceId ?? ''} onChange={(event) => workspace.selectWorkspace(event.target.value)}>
            {workspace.workspaces.map((row, index) => <option key={row.workspaceId} value={row.workspaceId}>工作区 {index + 1} · {row.workspaceId.slice(0, 8)}</option>)}
          </select></label>
        )}
        <label>恢复密钥<input type="password" autoComplete="off" value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} placeholder="rvk1_…" /></label>
        <div className="button-row">
          <button className="button primary" type="button" onClick={() => void workspace.unlockWorkspace(recoveryCode)} disabled={workspace.phase === 'UNLOCKING'}>
            {workspace.phase === 'UNLOCKING' ? '验证并解密中…' : '解锁工作区'}
          </button>
          <button className="button secondary" type="button" onClick={() => fileRef.current?.click()}>选择恢复文件</button>
        </div>
        <input ref={fileRef} aria-label="选择恢复文件输入" type="file" accept=".json" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file || file.size > 16 * 1024) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const kit = parseRecoveryKit(String(reader.result ?? ''));
              if (workspace.selected && kit.workspaceId !== workspace.selected.workspaceId) return;
              setRecoveryCode(kit.recoveryCode);
              void workspace.resumeWorkspaceFromRecoveryKit(kit);
            } catch {}
          };
          reader.readAsText(file, 'utf-8');
        }} />
        {workspace.error && <p className="form-error" role="alert">{workspace.error}</p>}
        <WorkspaceDeletionControls />
      </section>
    );
  }

  if (workspace.unlocked) {
    const hasTrades = workspace.unlocked.snapshot?.archive !== null;
    const recoveredReadOnly = workspace.unlocked.readOnlyRecovery;
    return (
      <section className="panel account-panel">
        <div className="section-heading compact">
          <div><p className="eyebrow">{recoveredReadOnly ? 'HISTORY RECOVERY · READ ONLY' : 'VAULT UNLOCKED'}</p><h2>{recoveredReadOnly ? '已从最近可验证历史版本恢复' : hasTrades ? '真实工作区已恢复' : '工作区已就绪'}</h2></div>
          <span>GEN {workspace.unlocked.generation}</span>
        </div>
        {recoveredReadOnly ? (
          <div className="form-error" role="alert">
            <p>活动版本未通过根签名或密文校验。当前历史版本只读，系统已禁止继续保存，避免覆盖证据链。</p>
            <p>请先导出下面的完整明文备份并离线妥善保存，再新建工作区重新导入；不要把备份上传到公开仓库。</p>
            <button className="button primary" type="button" onClick={() => {
              if (workspace.unlocked?.snapshot && workspace.selected) {
                downloadRecoveredWorkspace(workspace.unlocked.snapshot, workspace.selected.workspaceId);
              }
            }}>导出历史恢复完整备份</button>
          </div>
        ) : (
          <p>{hasTrades ? '当前设备已在内存中解密工作区，可继续复盘和保存。' : '下一步导入 Binance CSV；原始文件不会上传。'}</p>
        )}
        <button className="button secondary" type="button" onClick={() => {
          setRecoveryCode('');
          workspace.lockWorkspace();
        }}>立即锁定</button>
        {workspace.error && <p className="form-error" role="alert">{workspace.error}</p>}
        <WorkspaceDeletionControls />
      </section>
    );
  }

  return null;
}
