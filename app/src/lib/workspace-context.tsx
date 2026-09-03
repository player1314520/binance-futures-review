import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './auth-context';
import { getOrCreateDeviceId } from './device-id';
import {
  isRootRecoveryKit,
  normalizeRecoveryCode,
  type RecoveryKit,
} from './recovery-code';
import {
  SupabaseVaultRepository,
  VaultRepositoryError,
  type VaultHead,
  type VaultRepository,
  type VaultWorkspace,
} from './vault-repository';
import type { WorkspaceSnapshotV1 } from './workspace-snapshot';
import { WorkspaceController, type UnlockedWorkspace } from './workspace-controller';
import { VaultCryptoError } from './vault-crypto';
import { WorkspaceVaultError } from './workspace-vault-service';

export type WorkspacePhase =
  | 'SIGNED_OUT'
  | 'LOADING'
  | 'NEEDS_SETUP'
  | 'LOCKED'
  | 'CREATING'
  | 'RECOVERY_READY'
  | 'COMMITTING'
  | 'UNLOCKING'
  | 'UNLOCKED'
  | 'SAVING'
  | 'ERROR';

export type WorkspaceRepositoryFactory = (getAccessToken: () => string | null) => VaultRepository;

type WorkspaceContextValue = Readonly<{
  phase: WorkspacePhase;
  workspaces: readonly VaultWorkspace[];
  selected: VaultWorkspace | null;
  unlocked: UnlockedWorkspace | null;
  recoveryKit: RecoveryKit | null;
  recoveryKitAcknowledged: boolean;
  error: string;
  refresh: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  createWorkspace: () => Promise<boolean>;
  resumeWorkspaceFromRecoveryKit: (kit: RecoveryKit) => Promise<boolean>;
  unlockWorkspace: (recoveryCode: string) => Promise<boolean>;
  lockWorkspace: () => void;
  dismissRecoveryKit: () => Promise<boolean>;
  saveSnapshot: (snapshot: Omit<WorkspaceSnapshotV1, 'generation'>) => Promise<VaultHead | null>;
}>;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function publicError(error: unknown): string {
  if (error instanceof VaultCryptoError) return '恢复密钥错误，或云端密文已损坏';
  if (error instanceof WorkspaceVaultError) {
    if (error.code === 'SIGNATURE_INTEGRITY_FAILED') return '云端版本的根签名校验失败，已拒绝加载';
    if (error.code === 'RECOVERED_HISTORY_READ_ONLY') return '当前是历史只读恢复，不能覆盖云端；请先导出完整备份再新建工作区';
    if (error.code === 'MUTATION_OUTCOME_UNKNOWN') return '云端写入结果暂时无法确认，请刷新工作区后核对';
  }
  if (error instanceof VaultRepositoryError) {
    if (error.code === 'CONFLICT') return '另一台设备已先保存，请重新加载后再提交';
    if (error.code === 'AUTH_REQUIRED') return '登录已过期，请重新登录';
    if (error.code === 'RATE_LIMITED') return '请求过于频繁，请稍后重试';
    if (error.code === 'ABORTED') return '操作已取消';
    if (error.code === 'TIMEOUT') return '云仓请求超时';
  }
  return '加密工作区暂时不可用';
}

export function WorkspaceProvider({
  children,
  repositoryFactory,
}: {
  children: React.ReactNode;
  repositoryFactory?: WorkspaceRepositoryFactory;
}) {
  const auth = useAuth();
  const [phase, setPhase] = useState<WorkspacePhase>('SIGNED_OUT');
  const [workspaces, setWorkspaces] = useState<readonly VaultWorkspace[]>([]);
  const [selected, setSelected] = useState<VaultWorkspace | null>(null);
  const [unlocked, setUnlocked] = useState<UnlockedWorkspace | null>(null);
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [recoveryKitAcknowledged, setRecoveryKitAcknowledged] = useState(true);
  const [error, setError] = useState('');
  const controllerRef = useRef<WorkspaceController | null>(null);
  const recoveryCodeRef = useRef<string | null>(null);
  const selectedRef = useRef<VaultWorkspace | null>(null);
  const unlockedRef = useRef<UnlockedWorkspace | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const authUserIdRef = useRef<string | null>(auth.session?.userId ?? null);
  const recoveryKitAcknowledgedRef = useRef(true);
  const epoch = useRef(0);
  authUserIdRef.current = auth.session?.userId ?? null;

  const buildController = useCallback(() => {
    if (!auth.session || !auth.config) return null;
    const repository = repositoryFactory
      ? repositoryFactory(auth.accessToken)
      : new SupabaseVaultRepository({
          supabaseUrl: auth.config.supabaseUrl,
          publishableKey: auth.config.publishableKey,
          getAccessToken: auth.accessToken,
        });
    return new WorkspaceController(repository, auth.session.userId, getOrCreateDeviceId());
  }, [auth.accessToken, auth.config, auth.session, repositoryFactory]);

  const resetPrivateState = useCallback(() => {
    saveAbortRef.current?.abort('private state reset');
    saveAbortRef.current = null;
    recoveryCodeRef.current = null;
    controllerRef.current?.dispose();
    controllerRef.current = null;
    setWorkspaces([]);
    setSelected(null);
    setUnlocked(null);
    selectedRef.current = null;
    unlockedRef.current = null;
    setRecoveryKit(null);
    recoveryKitAcknowledgedRef.current = true;
    setRecoveryKitAcknowledged(true);
  }, []);

  const refresh = useCallback(async () => {
    const controller = buildController();
    if (!controller) {
      resetPrivateState();
      setPhase('SIGNED_OUT');
      return;
    }
    saveAbortRef.current?.abort('workspace refresh');
    saveAbortRef.current = null;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    recoveryCodeRef.current = null;
    setUnlocked(null);
    setRecoveryKit(null);
    recoveryKitAcknowledgedRef.current = true;
    setRecoveryKitAcknowledged(true);
    setError('');
    setPhase('LOADING');
    try {
      const rows = await controller.list();
      if (epoch.current !== currentEpoch) return;
      controllerRef.current?.dispose();
      controllerRef.current = controller;
      setWorkspaces(rows);
      setSelected(rows[0] ?? null);
      selectedRef.current = rows[0] ?? null;
      setPhase(rows.length ? 'LOCKED' : 'NEEDS_SETUP');
    } catch (caught) {
      if (epoch.current !== currentEpoch) return;
      setError(publicError(caught));
      setPhase('ERROR');
    }
  }, [buildController, resetPrivateState]);

  useEffect(() => {
    void refresh();
    return () => {
      epoch.current += 1;
      saveAbortRef.current?.abort('workspace provider disposed');
      saveAbortRef.current = null;
      recoveryCodeRef.current = null;
      controllerRef.current?.dispose();
    };
  }, [auth.session?.userId, refresh]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    epoch.current += 1;
    saveAbortRef.current?.abort('workspace selection changed');
    saveAbortRef.current = null;
    const workspace = workspaces.find((row) => row.workspaceId === workspaceId) ?? null;
    controllerRef.current?.lock(selectedRef.current?.workspaceId);
    recoveryCodeRef.current = null;
    setUnlocked(null);
    setRecoveryKit(null);
    setSelected(workspace);
    selectedRef.current = workspace;
    unlockedRef.current = null;
    setError('');
    setPhase(workspace ? 'LOCKED' : workspaces.length ? 'LOCKED' : 'NEEDS_SETUP');
  }, [workspaces]);

  const createWorkspace = useCallback(async () => {
    const controller = controllerRef.current ?? buildController();
    if (!controller) return false;
    saveAbortRef.current?.abort('workspace preparation started');
    saveAbortRef.current = null;
    controllerRef.current?.lock(selectedRef.current?.workspaceId);
    recoveryCodeRef.current = null;
    setUnlocked(null);
    unlockedRef.current = null;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    setError('');
    setPhase('CREATING');
    try {
      const prepared = await controller.prepare();
      if (epoch.current !== currentEpoch) return false;
      controllerRef.current = controller;
      recoveryCodeRef.current = null;
      setRecoveryKit(prepared);
      recoveryKitAcknowledgedRef.current = false;
      setRecoveryKitAcknowledged(false);
      setUnlocked(null);
      unlockedRef.current = null;
      setPhase('RECOVERY_READY');
      return true;
    } catch (caught) {
      if (epoch.current !== currentEpoch) return false;
      setError(publicError(caught));
      setPhase(workspaces.length ? 'LOCKED' : 'NEEDS_SETUP');
      return false;
    }
  }, [buildController, workspaces.length]);

  const commitRecoveryKit = useCallback(async (kit: RecoveryKit) => {
    const controller = controllerRef.current ?? buildController();
    if (!controller || !isRootRecoveryKit(kit)) {
      setError('该旧版恢复文件只能解锁已存在的工作区，不能恢复中断的创建');
      return false;
    }
    saveAbortRef.current?.abort('workspace commit started');
    const abortController = new AbortController();
    saveAbortRef.current = abortController;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    const currentUserId = authUserIdRef.current;
    const isCurrentOperation = () => (
      epoch.current === currentEpoch
      && saveAbortRef.current === abortController
      && !abortController.signal.aborted
      && authUserIdRef.current === currentUserId
      && auth.accessToken() !== null
    );
    controllerRef.current = controller;
    setRecoveryKit(kit);
    recoveryKitAcknowledgedRef.current = false;
    setRecoveryKitAcknowledged(false);
    setError('');
    setPhase('COMMITTING');
    try {
      const created = await controller.commitPrepared(kit, { signal: abortController.signal });
      if (!isCurrentOperation()) return false;
      recoveryCodeRef.current = kit.recoveryCode;
      const workspace = created.workspace;
      setWorkspaces((rows) => {
        const withoutCurrent = rows.filter((row) => row.workspaceId !== workspace.workspaceId);
        return Object.freeze([workspace, ...withoutCurrent]);
      });
      setSelected(workspace);
      setUnlocked(created);
      selectedRef.current = workspace;
      unlockedRef.current = created;
      setRecoveryKit(null);
      recoveryKitAcknowledgedRef.current = true;
      setRecoveryKitAcknowledged(true);
      setPhase('UNLOCKED');
      return true;
    } catch (caught) {
      if (!isCurrentOperation()) return false;
      recoveryCodeRef.current = null;
      setError(publicError(caught));
      setPhase('RECOVERY_READY');
      return false;
    } finally {
      if (saveAbortRef.current === abortController) saveAbortRef.current = null;
    }
  }, [auth.accessToken, buildController]);

  const unlockWorkspace = useCallback(async (recoveryCodeInput: string) => {
    const controller = controllerRef.current;
    if (!controller || !selected) return false;
    let recoveryCode: string;
    try {
      recoveryCode = normalizeRecoveryCode(recoveryCodeInput);
    } catch {
      setError('恢复密钥格式无效');
      return false;
    }
    saveAbortRef.current?.abort('workspace unlock started');
    saveAbortRef.current = null;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    setError('');
    setPhase('UNLOCKING');
    try {
      const restored = await controller.unlock(selected, recoveryCode);
      if (epoch.current !== currentEpoch) return false;
      recoveryCodeRef.current = recoveryCode;
      setUnlocked(restored);
      setSelected(restored.workspace);
      unlockedRef.current = restored;
      selectedRef.current = restored.workspace;
      setRecoveryKit(null);
      recoveryKitAcknowledgedRef.current = true;
      setRecoveryKitAcknowledged(true);
      setPhase('UNLOCKED');
      return true;
    } catch (caught) {
      if (epoch.current !== currentEpoch) return false;
      recoveryCodeRef.current = null;
      setError(publicError(caught));
      setPhase('LOCKED');
      return false;
    }
  }, [selected]);

  const resumeWorkspaceFromRecoveryKit = useCallback(async (kit: RecoveryKit) => {
    if (!isRootRecoveryKit(kit)) return unlockWorkspace(kit.recoveryCode);
    const matching = workspaces.find((row) => row.workspaceId === kit.workspaceId) ?? null;
    if (workspaces.length > 0 && !matching) {
      setError('恢复文件与当前账户的工作区不匹配');
      return false;
    }
    if (matching) {
      setSelected(matching);
      selectedRef.current = matching;
    }
    return commitRecoveryKit(kit);
  }, [commitRecoveryKit, unlockWorkspace, workspaces]);

  const lockWorkspace = useCallback(() => {
    epoch.current += 1;
    saveAbortRef.current?.abort('workspace locked');
    saveAbortRef.current = null;
    controllerRef.current?.lock(selectedRef.current?.workspaceId);
    recoveryCodeRef.current = null;
    setUnlocked(null);
    unlockedRef.current = null;
    setRecoveryKit(null);
    setError('');
    setPhase(selected ? 'LOCKED' : 'NEEDS_SETUP');
  }, [selected]);

  const saveSnapshot = useCallback(async (snapshotDraft: Omit<WorkspaceSnapshotV1, 'generation'>) => {
    const controller = controllerRef.current;
    const recoveryCode = recoveryCodeRef.current;
    const currentSelected = selectedRef.current;
    const currentUnlocked = unlockedRef.current;
    const currentUserId = authUserIdRef.current;
    if (!controller || !currentSelected || !currentUnlocked || !recoveryCode || !currentUserId) return null;
    if (currentUnlocked.readOnlyRecovery) {
      setError('当前是历史只读恢复，不能覆盖云端；请先导出完整备份再新建工作区');
      setPhase('UNLOCKED');
      return null;
    }
    if (!recoveryKitAcknowledgedRef.current) {
      setError('请先下载并确认恢复文件，再写入工作区');
      setPhase('UNLOCKED');
      return null;
    }
    saveAbortRef.current?.abort('save superseded');
    const abortController = new AbortController();
    saveAbortRef.current = abortController;
    const currentEpoch = epoch.current + 1;
    epoch.current = currentEpoch;
    const isCurrentOperation = () => (
      epoch.current === currentEpoch
      && saveAbortRef.current === abortController
      && !abortController.signal.aborted
      && authUserIdRef.current === currentUserId
      && auth.accessToken() !== null
      && controllerRef.current === controller
      && recoveryCodeRef.current === recoveryCode
      && selectedRef.current === currentSelected
      && unlockedRef.current === currentUnlocked
    );
    const snapshot = Object.freeze({
      ...snapshotDraft,
      generation: currentUnlocked.generation + 1,
    }) as WorkspaceSnapshotV1;
    setError('');
    setPhase('SAVING');
    try {
      const head = await controller.save(
        currentSelected.workspaceId,
        recoveryCode,
        snapshot,
        currentUnlocked.generation,
        { signal: abortController.signal },
      );
      if (!isCurrentOperation()) return null;
      const workspace = Object.freeze({ ...currentSelected, head });
      const nextUnlocked = Object.freeze({
        workspace,
        snapshot,
        generation: head.generation,
        recoveredFromHistory: false,
        activeHead: head,
        readOnlyRecovery: false,
      });
      selectedRef.current = workspace;
      unlockedRef.current = nextUnlocked;
      setSelected(workspace);
      setWorkspaces((rows) => rows.map((row) => row.workspaceId === workspace.workspaceId ? workspace : row));
      setUnlocked(nextUnlocked);
      setPhase('UNLOCKED');
      return head;
    } catch (caught) {
      if (!isCurrentOperation()) return null;
      setError(publicError(caught));
      setPhase('UNLOCKED');
      return null;
    } finally {
      if (saveAbortRef.current === abortController) saveAbortRef.current = null;
    }
  }, [auth.accessToken]);

  const value = useMemo<WorkspaceContextValue>(() => Object.freeze({
    phase,
    workspaces,
    selected,
    unlocked,
    recoveryKit,
    recoveryKitAcknowledged,
    error,
    refresh,
    selectWorkspace,
    createWorkspace,
    resumeWorkspaceFromRecoveryKit,
    unlockWorkspace,
    lockWorkspace,
    dismissRecoveryKit: () => recoveryKit ? commitRecoveryKit(recoveryKit) : Promise.resolve(false),
    saveSnapshot,
  }), [
    commitRecoveryKit,
    createWorkspace,
    error,
    lockWorkspace,
    phase,
    recoveryKit,
    recoveryKitAcknowledged,
    refresh,
    resumeWorkspaceFromRecoveryKit,
    saveSnapshot,
    selectWorkspace,
    selected,
    unlockWorkspace,
    unlocked,
    workspaces,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}
