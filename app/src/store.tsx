import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { enrichTrades, exportArchive, importArchive } from '@rv/engine';
import { demoTrades } from '@rv/engine/demo-data';
import type {
  DiagnosticItem,
  EnrichedTrade,
  ImportMeta,
  ResultContract,
} from '@rv/engine';
import type { BinanceAccess } from './lib/access-policy';
import {
  loadActionPlans,
  nextActionExperiment,
  nextActionExperimentDecision,
  nextActionExperimentObservation,
  nextActionPlanStatus,
  nextReviewAction,
  normalizeActionPlanMap,
  serializeActionPlanMap,
  type ActionPlanMap,
  type ActionPlan,
  type ActionPlanStatus,
  type ActionExperimentDecision,
  type ActionExperimentInput,
  type ActionExperimentObservationInput,
} from './lib/action-plan-storage';
import {
  loadBinanceSnapshot,
  safeRuntimeError,
  startBinanceSync,
  storeBinanceCredentials,
  updateCloudAction,
  upsertCloudJournal,
  upsertCloudReport,
  upsertCloudRiskRule,
  upsertCloudTradeReview,
  type BinanceSnapshot,
  type CloudWorkspaceSnapshot,
  type SanitizedFill,
} from './lib/binance-source';
import {
  datasetReviewScope,
  loadReviews,
  normalizeReviewMap,
  serializeReviewMap,
  type ReviewDraft,
  type ReviewMap,
} from './lib/review-storage';
import type { JsonValue } from './lib/canonical-json';
import { canonicalJson } from './lib/canonical-json';
import {
  createCsvFillLedger,
  mergeCsvFillBatch,
  readCsvFillLedgerExtension,
  replayCsvFillLedger,
  verifyCsvFillLedgerIntegrity,
  withCsvFillLedger,
  type CsvFillInput,
  type CsvFillLedger,
} from './lib/csv-fill-ledger';
import { MAX_FUPAN_FILE_BYTES } from './lib/import-file-limits';
import {
  BROWSER_RESTORE_TRANSACTION_KEY,
  BROWSER_STORAGE_EPOCH_KEY,
  BROWSER_STORAGE_GENERATION_KEY,
  captureBrowserWriteToken,
  clearBrowserUserData,
  mutateBrowserWorkspace,
  recoverBrowserRestoreTransaction,
  replaceBrowserWorkspace,
  type BrowserSerializedWorkspace,
  type BrowserWriteToken,
} from './lib/browser-restore-transaction';
import { useWorkspace } from './lib/workspace-context';
import {
  WORKSPACE_SNAPSHOT_FORMAT,
  type SnapshotGuard,
  type SnapshotJournalEntry,
  type WorkspaceSnapshotV1,
} from './lib/workspace-snapshot';
import {
  loadPractice,
  nextGuard,
  nextGuardActive,
  nextJournal,
  normalizePracticeState,
  serializePracticeState,
} from './lib/practice-state';
import { parseCompletePortableBackup } from './lib/portable-backup';
import {
  mergeLegacyReviewMigration,
  type LegacyReviewMigrationPlan,
  type LegacyReviewMigrationReceipt,
} from './lib/legacy-review-migration';

const DEMO_SCOPE = 'demo-v1';
const SYNC_POLL_INTERVAL_MS = 250;
const SYNC_POLL_ATTEMPTS = 240;
const BINANCE_REVIEW_SCOPE_PATTERN = /^rv1_([0-9a-f]{32})$/u;

function emptyReviewMap(): ReviewMap {
  return Object.create(null) as ReviewMap;
}

function copyReviewMap(reviews: ReviewMap): ReviewMap {
  return Object.assign(emptyReviewMap(), reviews);
}

function emptyActionPlanMap(): ActionPlanMap {
  return Object.create(null) as ActionPlanMap;
}

function copyActionPlanMap(actions: ActionPlanMap): ActionPlanMap {
  return Object.assign(emptyActionPlanMap(), actions);
}

function currentTradeIds(session: Pick<Session, 'trades'>): string[] {
  return session.trades.map((trade) => String(trade.id)).sort();
}

function sameTradeIds(session: Pick<Session, 'trades'>, expected: readonly string[]): boolean {
  const actual = currentTradeIds(session);
  return actual.length === expected.length
    && actual.every((tradeId, index) => tradeId === expected[index]);
}

function cloudActionStatus(status: ActionPlanStatus): 'OPEN' | 'DONE' | 'CANCELLED' {
  return status === 'open' ? 'OPEN' : status === 'done' ? 'DONE' : 'CANCELLED';
}

async function persistCloudAction(
  current: Session & { cloudWorkspace: CloudWorkspaceSnapshot },
  actionId: string,
  action: ActionPlan | undefined,
): Promise<boolean> {
  const binding = current.cloudWorkspace.actionBindings[actionId];
  const expectedVersion = current.cloudWorkspace.actionVersions[actionId] ?? -1;
  if (
    !action
    || !binding
    || action.sourceTradeId !== binding.tradeId
    || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 1
  ) return false;
  await updateCloudAction(current.cloudWorkspace.connectionId, actionId, {
    expectedVersion,
    reviewId: binding.reviewId,
    tradeId: binding.tradeId,
    status: cloudActionStatus(action.status),
    payload: {
      text: action.text,
      experiment: (action.experiment ?? null) as unknown as Readonly<Record<string, unknown>> | null,
    },
  });
  return true;
}

function cloudExperimentsAllowed(
  current: Session & { cloudWorkspace: CloudWorkspaceSnapshot },
): boolean {
  return current.cloudWorkspace.capabilities.experiments.decision === 'ALLOW';
}

function isDeterministicDemoTradeSet(trades: readonly EnrichedTrade[]): boolean {
  try {
    const expected = enrichTrades(demoTrades() as unknown as EnrichedTrade[]);
    // Archive import intentionally rewrites provenance/source fields and
    // recomputes enrichment. Compare only the stable, exported trade facts
    // that define the built-in deterministic fixture.
    const fingerprint = (value: readonly EnrichedTrade[]) => JSON.parse(JSON.stringify(
      value.map((trade) => ({
        id: trade.id,
        account: trade.account,
        symbol: trade.symbol,
        side: trade.side,
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        qty: trade.qty,
        leverage: trade.leverage,
        notional: trade.notional,
        fee: trade.fee,
        pnl: trade.pnl,
        plannedRisk: trade.plannedRisk,
        stopRespected: trade.stopRespected,
        tags: trade.tags,
        emotion: trade.emotion,
        note: trade.note,
        setup: trade.setup,
      })),
    )) as JsonValue;
    return canonicalJson(fingerprint(trades)) === canonicalJson(fingerprint(expected));
  } catch {
    return false;
  }
}

function browserStorageScope(scope: string | null): string | null {
  if (typeof scope !== 'string') return null;
  if (/^[a-z0-9][a-z0-9-]{2,95}$/i.test(scope)) return scope;
  const binance = BINANCE_REVIEW_SCOPE_PATTERN.exec(scope);
  // Runtime account scopes contain an underscore, while the long-standing
  // browser key contract permits only hyphens. Keep the cryptographic binding
  // scope unchanged and use a collision-resistant storage-only namespace.
  return binance ? `binance-${binance[1]}` : null;
}

export type SourceKind = 'demo' | 'imported' | 'binance';
export type DataPhase =
  | 'DEMO_READY'
  | 'IMPORT_READY'
  | 'BINANCE_CONNECTING'
  | 'BINANCE_BROWSE_ONLY'
  | 'BINANCE_OBSERVED_READY'
  | 'BINANCE_EMPTY'
  | 'BINANCE_BLOCKED';

export type Session = {
  persistence: 'demo' | 'browser' | 'vault' | 'runtime';
  vaultWorkspaceId: string | null;
  source: SourceKind;
  phase: DataPhase;
  trades: EnrichedTrade[];
  records: readonly SanitizedFill[];
  meta: (ImportMeta & { importedAt: number }) | null;
  contract: ResultContract | null;
  diagnostics: DiagnosticItem[];
  runtime: BinanceSnapshot['runtime'] | null;
  bundle: BinanceSnapshot['bundle'] | null;
  access: BinanceAccess | null;
  cloudWorkspace: CloudWorkspaceSnapshot | null;
  errorCode: string | null;
  reviewScope: string | null;
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
  csvLedger: CsvFillLedger | null;
};

type ImportEvidence = {
  contract: ResultContract;
  diagnostics: DiagnosticItem[];
};

type State = { session: Session; warn: boolean };
type Action =
  | { type: 'DEMO' }
  | { type: 'IMPORT'; session: Session }
  | { type: 'BINANCE_LOADING' }
  | { type: 'BINANCE_READY'; snapshot: BinanceSnapshot }
  | { type: 'BINANCE_ERROR'; code: string }
  | { type: 'REVIEWS'; reviews: ReviewMap }
  | { type: 'ACTIONS'; actions: ActionPlanMap }
  | { type: 'SESSION'; session: Session; warn?: boolean }
  | { type: 'ACK_WARN' };

function demoSession(loadBrowserState = true): Session {
  const trades = enrichTrades(demoTrades() as unknown as EnrichedTrade[]);
  const practice = loadBrowserState
    ? loadPractice(DEMO_SCOPE)
    : { journal: [], guards: [] };
  return {
    persistence: 'demo',
    vaultWorkspaceId: null,
    source: 'demo',
    phase: 'DEMO_READY',
    trades,
    records: [],
    meta: null,
    contract: null,
    diagnostics: [],
    runtime: null,
    bundle: null,
    access: null,
    cloudWorkspace: null,
    errorCode: null,
    reviewScope: DEMO_SCOPE,
    reviews: loadBrowserState ? loadReviews(DEMO_SCOPE) : emptyReviewMap(),
    actions: loadBrowserState ? loadActionPlans(DEMO_SCOPE) : emptyActionPlanMap(),
    journal: practice.journal,
    guards: practice.guards,
    csvLedger: null,
  };
}

const initialState = (token: BrowserWriteToken | null): State => ({
  session: demoSession(token !== null),
  warn: false,
});

function binanceSession(snapshot: BinanceSnapshot): Session {
  const cloud = snapshot.cloudWorkspace;
  const storageScope = cloud ? null : browserStorageScope(snapshot.reviewScope);
  const practice = cloud ? null : loadPractice(storageScope);
  return {
    persistence: 'runtime',
    vaultWorkspaceId: null,
    source: 'binance',
    phase: snapshot.access.phase,
    trades: [...snapshot.trades],
    records: snapshot.records,
    meta: null,
    contract: null,
    diagnostics: [],
    runtime: snapshot.runtime,
    bundle: snapshot.bundle,
    access: snapshot.access,
    cloudWorkspace: cloud,
    errorCode: null,
    reviewScope: snapshot.reviewScope,
    reviews: cloud?.reviews ?? loadReviews(storageScope),
    actions: cloud?.actions ?? loadActionPlans(storageScope),
    journal: cloud?.journal ?? practice!.journal,
    guards: cloud?.guards ?? practice!.guards,
    csvLedger: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'DEMO':
      return { session: demoSession(), warn: false };
    case 'IMPORT':
      return { session: action.session, warn: true };
    case 'BINANCE_LOADING':
      return {
        session: {
          persistence: 'runtime',
          vaultWorkspaceId: null,
          source: 'binance',
          phase: 'BINANCE_CONNECTING',
          trades: [],
          records: [],
          meta: null,
          contract: null,
          diagnostics: [],
          runtime: null,
          bundle: null,
        access: null,
        cloudWorkspace: null,
        errorCode: null,
          reviewScope: null,
          reviews: emptyReviewMap(),
          actions: emptyActionPlanMap(),
          journal: [],
          guards: [],
          csvLedger: null,
        },
        warn: false,
      };
    case 'BINANCE_READY': {
      return {
        session: binanceSession(action.snapshot),
        warn: false,
      };
    }
    case 'BINANCE_ERROR':
      return {
        session: {
          ...state.session,
          source: 'binance',
          phase: 'BINANCE_BLOCKED',
          trades: [],
          records: [],
          runtime: null,
          bundle: null,
          access: null,
          cloudWorkspace: null,
          reviewScope: null,
          reviews: emptyReviewMap(),
          actions: emptyActionPlanMap(),
          errorCode: action.code,
        },
        warn: false,
      };
    case 'REVIEWS':
      return { ...state, session: { ...state.session, reviews: action.reviews } };
    case 'ACTIONS':
      return { ...state, session: { ...state.session, actions: action.actions } };
    case 'SESSION':
      return {
        ...state,
        session: action.session,
        warn: action.warn ?? state.warn,
      };
    case 'ACK_WARN':
      return { ...state, warn: false };
    default:
      return state;
  }
}

type Store = {
  session: Session;
  sourceLabel: string;
  analyticsReady: boolean;
  warn: boolean;
  activateDemo: () => void;
  setImported: (
    trades: EnrichedTrade[],
    meta: ImportMeta,
    evidence: ImportEvidence,
    fills?: readonly CsvFillInput[],
    restoredLedger?: CsvFillLedger,
  ) => Promise<boolean>;
  restoreSessionArchive: (text: string) => Promise<boolean>;
  restorePortableBackup: (text: string) => Promise<boolean>;
  cancelRestoreIntent: () => void;
  loadBinance: () => Promise<void>;
  syncBinance: () => Promise<void>;
  connectBinance: (apiKey: string, apiSecret: string) => Promise<void>;
  exportSession: () => void;
  saveTradeReview: (tradeId: string, draft: ReviewDraft) => Promise<boolean>;
  setActionStatus: (actionId: string, status: ActionPlanStatus) => Promise<boolean>;
  setActionExperiment: (actionId: string, input: ActionExperimentInput) => Promise<boolean>;
  recordActionExperimentObservation: (
    actionId: string,
    input: ActionExperimentObservationInput,
  ) => Promise<boolean>;
  decideActionExperiment: (
    actionId: string,
    decision: Exclude<ActionExperimentDecision, 'pending'>,
    evidenceNote: string,
  ) => Promise<boolean>;
  applyLegacyReviewMigration: (
    plan: LegacyReviewMigrationPlan,
    selectedTradeIds: readonly string[],
  ) => Promise<LegacyReviewMigrationReceipt | null>;
  saveJournal: (day: string, note: string, emotion: string) => Promise<boolean>;
  saveGuard: (text: string) => Promise<boolean>;
  setGuardActive: (guardId: string, active: boolean) => Promise<boolean>;
  saveReportSnapshot: (input: Readonly<{
    reportType: 'WEEKLY' | 'MONTHLY';
    periodStart: string;
    periodEnd: string;
    payload: Readonly<Record<string, unknown>>;
  }>) => Promise<boolean>;
  ackWarn: () => void;
  clear: () => Promise<number>;
  clearBrowserData: () => Promise<number>;
};

const Ctx = createContext<Store | null>(null);

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
  }, 100);
}

function importedSession(
  trades: EnrichedTrade[],
  meta: ImportMeta,
  evidence: ImportEvidence,
  scope: string | null,
  options: {
    persistence?: Session['persistence'];
    vaultWorkspaceId?: string | null;
    reviews?: ReviewMap;
    actions?: ActionPlanMap;
    journal?: readonly SnapshotJournalEntry[];
    guards?: readonly SnapshotGuard[];
    importedAt?: number;
    csvLedger?: CsvFillLedger | null;
  } = {},
): Session {
  const storageScope = browserStorageScope(scope);
  const practice = loadPractice(storageScope);
  return {
    persistence: options.persistence ?? 'browser',
    vaultWorkspaceId: options.vaultWorkspaceId ?? null,
    source: 'imported',
    phase: 'IMPORT_READY',
    trades,
    records: [],
    meta: { ...meta, importedAt: options.importedAt ?? Date.now() },
    contract: evidence.contract,
    diagnostics: [...evidence.diagnostics],
    runtime: null,
    bundle: null,
    access: null,
    cloudWorkspace: null,
    errorCode: null,
    reviewScope: scope,
    reviews: options.reviews ?? loadReviews(storageScope),
    actions: options.actions ?? loadActionPlans(storageScope),
    journal: options.journal ?? practice.journal,
    guards: options.guards ?? practice.guards,
    csvLedger: options.csvLedger ?? null,
  };
}

export function sessionArchive(session: Session): JsonValue {
  const archive = exportArchive(session.trades, {
    ...session.meta,
    sourceKind: session.source,
    exportedAt: Date.now(),
  });
  return (session.csvLedger ? withCsvFillLedger(archive, session.csvLedger) : archive) as unknown as JsonValue;
}

function serializeExportableSessionArchive(session: Session): string {
  const serialized = JSON.stringify(sessionArchive(session));
  if (new TextEncoder().encode(serialized).byteLength > MAX_FUPAN_FILE_BYTES) {
    throw new Error('RESOURCE_LIMIT');
  }
  return serialized;
}

function importWorkspaceIdentity(workspace: {
  phase: string;
  selected: { workspaceId: string } | null;
  unlocked: { workspace: { workspaceId: string } } | null;
}): string {
  if (workspace.unlocked) return `unlocked:${workspace.unlocked.workspace.workspaceId}`;
  return `${workspace.phase}:${workspace.selected?.workspaceId ?? 'none'}`;
}

function snapshotCoverage(session: Session): 'complete' | 'partial' | 'unknown' {
  return snapshotCoverageStatus(session.contract?.provenance.coverage.status);
}

function snapshotCoverageStatus(status: string | undefined): 'complete' | 'partial' | 'unknown' {
  if (status === 'complete' || status === 'partial') return status;
  return 'unknown';
}

function snapshotDraft(
  session: Session,
  reviews: ReviewMap,
  actions: ActionPlanMap,
  previous: WorkspaceSnapshotV1 | null,
): Omit<WorkspaceSnapshotV1, 'generation'> {
  const importedAt = session.meta?.importedAt ?? previous?.source.importedAt ?? Date.now();
  const archive = sessionArchive(session);
  return Object.freeze({
    format: WORKSPACE_SNAPSHOT_FORMAT,
    createdAt: Date.now(),
    engineVersion: '2.0.0-alpha',
    source: Object.freeze({
      kind: session.source === 'binance' ? 'binance-local' : 'csv',
      accepted: session.contract?.provenance.coverage.accepted ?? session.trades.length,
      dropped: session.contract?.provenance.coverage.dropped ?? 0,
      coverage: snapshotCoverage(session),
      importedAt,
    }),
    archive,
    reviews,
    actions,
    journal: session.journal,
    guards: session.guards,
  });
}

function retainedReviewState(
  previous: Pick<WorkspaceSnapshotV1, 'reviews' | 'actions'> | null,
  trades: readonly EnrichedTrade[],
): { reviews: ReviewMap; actions: ActionPlanMap } {
  if (!previous) return { reviews: emptyReviewMap(), actions: emptyActionPlanMap() };
  const tradeIds = new Set(trades.map((trade) => trade.id));
  const reviews = emptyReviewMap();
  for (const [tradeId, review] of Object.entries(previous.reviews)) {
    if (tradeIds.has(tradeId)) reviews[tradeId] = review;
  }
  const actions = emptyActionPlanMap();
  for (const [actionId, action] of Object.entries(previous.actions)) {
    if (tradeIds.has(action.sourceTradeId)) actions[actionId] = action;
  }
  return { reviews, actions };
}

function validBrowserReviewScope(scope: string | null): scope is string {
  return browserStorageScope(scope) !== null;
}

function sameBrowserWriteToken(
  left: BrowserWriteToken | null,
  right: BrowserWriteToken | null,
): boolean {
  if (left === null || right === null) return left === right;
  try {
    // BrowserWriteToken is deliberately opaque to Store. Comparing its whole
    // canonical value keeps future repair epochs/nonces inside the fence.
    return canonicalJson(left as unknown as JsonValue)
      === canonicalJson(right as unknown as JsonValue);
  } catch {
    return false;
  }
}

function browserResultMatchesToken(
  bound: BrowserWriteToken,
  resultToken: BrowserWriteToken,
  generation: number,
): boolean {
  return Number.isSafeInteger(generation)
    && resultToken.generation === generation
    && sameBrowserWriteToken(bound, resultToken);
}

function relevantBrowserStorageEventKey(key: string | null): boolean {
  return key === null
    || key === BROWSER_RESTORE_TRANSACTION_KEY
    || key === BROWSER_STORAGE_GENERATION_KEY
    || key === BROWSER_STORAGE_EPOCH_KEY
    || key === 'rv2-session'
    || /^rv-(review|action|practice)-v1:/i.test(key);
}

type BrowserWorkspaceState = Readonly<{
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
}>;

type BrowserWorkspaceMutation<T> = (
  current: BrowserWorkspaceState,
) => Readonly<{ state: BrowserWorkspaceState; value: T }> | null
  | PromiseLike<Readonly<{ state: BrowserWorkspaceState; value: T }> | null>;

function decodeBrowserWorkspace(
  serialized: BrowserSerializedWorkspace,
): BrowserWorkspaceState | null {
  try {
    const reviews = normalizeReviewMap(JSON.parse(serialized.reviews ?? '{}'));
    const actions = normalizeActionPlanMap(JSON.parse(serialized.actions ?? '{}'));
    const practice = normalizePracticeState(JSON.parse(
      serialized.practice ?? '{"journal":[],"guards":[]}',
    ));
    if (!reviews || !actions || !practice) return null;
    return Object.freeze({
      reviews,
      actions,
      journal: practice.journal,
      guards: practice.guards,
    });
  } catch {
    return null;
  }
}

function encodeBrowserWorkspace(
  state: BrowserWorkspaceState,
): Readonly<{ reviews: string; actions: string; practice: string }> | null {
  const reviews = serializeReviewMap(state.reviews);
  const actions = serializeActionPlanMap(state.actions);
  const practice = serializePracticeState({ journal: state.journal, guards: state.guards });
  return reviews !== null && actions !== null && practice !== null
    ? Object.freeze({ reviews, actions, practice })
    : null;
}

async function coordinateBrowserWorkspaceMutation<T>(
  scope: string,
  token: BrowserWriteToken,
  mutation: BrowserWorkspaceMutation<T>,
  isCurrent: () => boolean,
): Promise<Readonly<{
  state: BrowserWorkspaceState;
  value: T;
  generation: number;
  token: BrowserWriteToken;
}> | null> {
  const result = await mutateBrowserWorkspace(scope, token, async ({ latest }) => {
    const current = decodeBrowserWorkspace(latest);
    if (!current) return null;
    const changed = await mutation(current);
    if (!changed) return null;
    const next = encodeBrowserWorkspace(changed.state);
    return next ? { next, value: changed.value } : null;
  }, { isCurrent });
  if (!result.ok) return null;
  const state = decodeBrowserWorkspace(result.state);
  return state ? Object.freeze({
    state,
    value: result.value,
    generation: result.generation,
    token: result.token,
  }) : null;
}

async function replacePortableBrowserState(
  scope: string | null,
  snapshot: Pick<WorkspaceSnapshotV1, 'reviews' | 'actions' | 'journal' | 'guards'>,
  token: BrowserWriteToken,
  isCurrent: () => boolean,
): Promise<Readonly<{
  state: BrowserWorkspaceState;
  generation: number;
  token: BrowserWriteToken;
}> | null> {
  const storageScope = browserStorageScope(scope);
  if (!storageScope) return null;
  const serialized = encodeBrowserWorkspace({
    reviews: snapshot.reviews,
    actions: snapshot.actions,
    journal: snapshot.journal,
    guards: snapshot.guards,
  });
  if (!serialized) return null;
  const result = await replaceBrowserWorkspace(storageScope, serialized, token, { isCurrent });
  if (!result.ok) return null;
  const state = decodeBrowserWorkspace(result.state);
  return state ? Object.freeze({
    state,
    generation: result.generation,
    token: result.token,
  }) : null;
}

function sameBrowserMutationTarget(expected: Session, current: Session): boolean {
  return current.persistence === expected.persistence
    && current.source === expected.source
    && current.reviewScope === expected.reviewScope
    && current.vaultWorkspaceId === expected.vaultWorkspaceId
    && sameTradeIds(current, currentTradeIds(expected));
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const browserSessionTokenRef = useRef<BrowserWriteToken | null>(null);
  const browserSessionTokenInitializedRef = useRef(false);
  if (!browserSessionTokenInitializedRef.current) {
    browserSessionTokenRef.current = captureBrowserWriteToken();
    browserSessionTokenInitializedRef.current = true;
  }
  const [state, dispatch] = useReducer(
    reducer,
    browserSessionTokenRef.current,
    initialState,
  );
  const workspace = useWorkspace();
  const requestEpoch = useRef(0);
  const sessionRef = useRef(state.session);
  const restoredRef = useRef('');
  const suppressedVaultHydrationWorkspaceRef = useRef<string | null>(null);
  const vaultQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const vaultQueueKeyRef = useRef<string | null>(null);
  const vaultQueueEpochRef = useRef(0);
  const vaultMutationIntentEpochRef = useRef(0);
  const pendingVaultSavesRef = useRef(0);
  const committedVaultSessionRef = useRef<{
    workspaceId: string;
    generation: number;
    session: Session;
  } | null>(null);
  const importQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cloudMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const importCancellationEpochRef = useRef(0);
  const restoreIntentEpochRef = useRef(0);
  const browserRestoreRecoveryReadyRef = useRef(false);
  const browserRestoreRecoveryPromiseRef = useRef<Promise<boolean> | null>(null);
  const workspaceRef = useRef(workspace);
  sessionRef.current = state.session;
  workspaceRef.current = workspace;

  const ensureBrowserRestoreReady = useCallback(() => {
    if (browserRestoreRecoveryReadyRef.current) return Promise.resolve(true);
    if (!browserRestoreRecoveryPromiseRef.current) {
      // A browser/process interruption can leave a PREPARED local replacement.
      // Recover its exact prior scoped values before any later import reads it.
      browserRestoreRecoveryPromiseRef.current = recoverBrowserRestoreTransaction()
        .then((ready) => {
          browserRestoreRecoveryReadyRef.current = ready;
          return ready;
        })
        .catch(() => false)
        .finally(() => {
          browserRestoreRecoveryPromiseRef.current = null;
        });
    }
    return browserRestoreRecoveryPromiseRef.current;
  }, []);

  useEffect(() => {
    void ensureBrowserRestoreReady();
  }, [ensureBrowserRestoreReady]);

  const invalidateBrowserSession = useCallback((observed: BrowserWriteToken | null) => {
    // Update the binding before dispatch so event handlers/actions from the
    // previous render cannot reuse the cleared generation in this same tick.
    browserSessionTokenRef.current = observed;
    restoreIntentEpochRef.current += 1;
    importCancellationEpochRef.current += 1;
    requestEpoch.current += 1;
    if (sessionRef.current.persistence === 'vault') return;
    const next = demoSession(false);
    sessionRef.current = next;
    dispatch({ type: 'SESSION', session: next, warn: false });
  }, []);

  const enterBrowserDemo = useCallback((token: BrowserWriteToken | null) => {
    browserSessionTokenRef.current = token;
    const next = demoSession(token !== null);
    sessionRef.current = next;
    dispatch({ type: 'SESSION', session: next, warn: false });
  }, []);

  useEffect(() => {
    const synchronizeBrowserGeneration = (event: StorageEvent) => {
      if (!relevantBrowserStorageEventKey(event.key)) return;
      try {
        if (event.storageArea !== null && event.storageArea !== localStorage) return;
      } catch {
        // If storage itself became inaccessible, capture below fails closed.
      }
      // Re-read the effective token for every relevant family event. During a
      // quota emergency, the forward-clear fence can live in a user data value
      // before either the generation or epoch key changes.
      const observed = captureBrowserWriteToken();
      if (sameBrowserWriteToken(browserSessionTokenRef.current, observed)) return;
      invalidateBrowserSession(observed);
    };
    window.addEventListener('storage', synchronizeBrowserGeneration);
    return () => window.removeEventListener('storage', synchronizeBrowserGeneration);
  }, [invalidateBrowserSession]);

  const commitBrowserMutation = useCallback(async <T,>(
    expected: Session,
    mutation: BrowserWorkspaceMutation<T>,
    stillCurrent: () => boolean = () => true,
  ): Promise<Readonly<{
    state: BrowserWorkspaceState;
    value: T;
    generation: number;
    token: BrowserWriteToken;
  }> | null> => {
    if (
      expected.persistence === 'vault'
      || (expected.persistence !== 'browser'
        && expected.persistence !== 'runtime'
        && expected.persistence !== 'demo')
    ) return null;
    const scope = browserStorageScope(expected.reviewScope);
    const token = browserSessionTokenRef.current;
    const observedBefore = captureBrowserWriteToken();
    if (!scope || !token || !sameBrowserWriteToken(token, observedBefore)) {
      if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedBefore)) {
        invalidateBrowserSession(observedBefore);
      }
      return null;
    }
    const isCurrent = () => stillCurrent()
      && sameBrowserMutationTarget(expected, sessionRef.current)
      && sameBrowserWriteToken(browserSessionTokenRef.current, token);
    const result = await coordinateBrowserWorkspaceMutation(scope, token, mutation, isCurrent);
    const observedAfter = captureBrowserWriteToken();
    if (
      !sameBrowserWriteToken(browserSessionTokenRef.current, token)
      || !sameBrowserWriteToken(observedAfter, token)
      || (result !== null && !browserResultMatchesToken(
        token,
        result.token,
        result.generation,
      ))
    ) {
      if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedAfter)) {
        invalidateBrowserSession(observedAfter);
      } else if (sessionRef.current.persistence !== 'vault') {
        // A malformed coordinator success is also fail-closed even when the
        // observable token itself has not moved.
        invalidateBrowserSession(observedAfter);
      }
      return null;
    }
    if (!result || !isCurrent()) return null;
    // Do not merge any stale family from the render that initiated the write.
    // The coordinator result is the complete three-family state read and
    // committed while holding the browser-wide transaction lock.
    const latest = sessionRef.current;
    const committed = {
      ...latest,
      reviews: result.state.reviews,
      actions: result.state.actions,
      journal: result.state.journal,
      guards: result.state.guards,
      errorCode: null,
    };
    sessionRef.current = committed;
    dispatch({ type: 'SESSION', session: committed });
    return result;
  }, [invalidateBrowserSession]);

  const commitCloudMutation = useCallback((
    expected: Session,
    mutate: (current: Session & { cloudWorkspace: CloudWorkspaceSnapshot }) => Promise<boolean>,
  ): Promise<boolean> => {
    const expectedCloud = expected.cloudWorkspace;
    if (expected.persistence !== 'runtime' || !expectedCloud) return Promise.resolve(false);
    const connectionId = expectedCloud.connectionId;
    const operationEpoch = requestEpoch.current;
    const task = cloudMutationQueueRef.current.then(async () => {
      const current = sessionRef.current;
      if (
        current.persistence !== 'runtime'
        || !current.cloudWorkspace
        || current.cloudWorkspace.connectionId !== connectionId
      ) return false;
      const committed = await mutate(
        current as Session & { cloudWorkspace: CloudWorkspaceSnapshot },
      );
      if (!committed) return false;
      let snapshot: BinanceSnapshot;
      try {
        snapshot = await loadBinanceSnapshot();
      } catch {
        // The validated mutation receipt proves that the remote CAS committed.
        // Keep the current UI unchanged; the next dataset refresh will reconcile it.
        return true;
      }
      if (
        snapshot.cloudWorkspace?.connectionId !== connectionId
        || requestEpoch.current !== operationEpoch
        || sessionRef.current.cloudWorkspace?.connectionId !== connectionId
      ) return true;
      const next = binanceSession(snapshot);
      sessionRef.current = next;
      dispatch({ type: 'SESSION', session: next });
      return true;
    });
    cloudMutationQueueRef.current = task.then(() => undefined, () => undefined);
    return task.catch(() => false);
  }, []);

  // Imports can wait behind a slow ledger hash or vault write. Track the
  // workspace target independently of requestEpoch so a later queued import
  // cannot revive data after the user deliberately changes context.
  const currentImportWorkspaceIdentity = importWorkspaceIdentity(workspace);
  const observedImportWorkspaceIdentityRef = useRef(currentImportWorkspaceIdentity);
  if (observedImportWorkspaceIdentityRef.current !== currentImportWorkspaceIdentity) {
    observedImportWorkspaceIdentityRef.current = currentImportWorkspaceIdentity;
    importCancellationEpochRef.current += 1;
  }

  const activeVaultKey = workspace.unlocked?.workspace.workspaceId ?? null;
  if (vaultQueueKeyRef.current !== activeVaultKey) {
    vaultQueueKeyRef.current = activeVaultKey;
    vaultQueueEpochRef.current += 1;
    vaultQueueRef.current = Promise.resolve();
    committedVaultSessionRef.current = null;
  }

  const queueVaultSave = useCallback((session: Session) => {
    const currentWorkspace = workspaceRef.current;
    const workspaceId = currentWorkspace.unlocked?.workspace.workspaceId ?? null;
    const queueEpoch = vaultQueueEpochRef.current;
    const writeIntentEpoch = vaultMutationIntentEpochRef.current;
    if (
      !workspaceId
      || session.persistence !== 'vault'
      || session.vaultWorkspaceId !== workspaceId
    ) return Promise.resolve(false);
    pendingVaultSavesRef.current += 1;
    const task = vaultQueueRef.current.then(async () => {
      const active = workspaceRef.current;
      if (
        vaultQueueEpochRef.current !== queueEpoch
        || vaultMutationIntentEpochRef.current !== writeIntentEpoch
        || active.unlocked?.workspace.workspaceId !== workspaceId
      ) return false;
      const head = await active.saveSnapshot(snapshotDraft(
        session,
        session.reviews,
        session.actions,
        active.unlocked.snapshot,
      ));
      if (
        vaultQueueEpochRef.current !== queueEpoch
        || vaultMutationIntentEpochRef.current !== writeIntentEpoch
        || workspaceRef.current.unlocked?.workspace.workspaceId !== workspaceId
      ) return false;
      if (!head) {
        if (sessionRef.current.persistence === 'vault') {
          const failed = { ...sessionRef.current, errorCode: 'VAULT_SAVE_FAILED' };
          sessionRef.current = failed;
          dispatch({ type: 'SESSION', session: failed });
        }
        return false;
      }
      return true;
    });
    vaultQueueRef.current = task.catch(() => undefined);
    return task.catch(() => {
      if (
        vaultQueueEpochRef.current === queueEpoch
        && vaultMutationIntentEpochRef.current === writeIntentEpoch
        && workspaceRef.current.unlocked?.workspace.workspaceId === workspaceId
        && sessionRef.current.persistence === 'vault'
      ) {
        const failed = { ...sessionRef.current, errorCode: 'VAULT_SAVE_FAILED' };
        sessionRef.current = failed;
        dispatch({ type: 'SESSION', session: failed });
      }
      return false;
    }).finally(() => {
      pendingVaultSavesRef.current = Math.max(0, pendingVaultSavesRef.current - 1);
    });
  }, []);

  const queueVaultMutation = useCallback((
    mutate: (current: Session) => Session | null | Promise<Session | null>,
    options: Readonly<{ onHeadCommitted?: () => void }> = {},
  ) => {
    const currentWorkspace = workspaceRef.current;
    const workspaceId = currentWorkspace.unlocked?.workspace.workspaceId ?? null;
    const queueEpoch = vaultQueueEpochRef.current;
    const cancellationEpoch = importCancellationEpochRef.current;
    const operationRestoreIntentEpoch = restoreIntentEpochRef.current;
    const mutationIntentEpoch = vaultMutationIntentEpochRef.current;
    const operationRequestEpoch = requestEpoch.current;
    if (!workspaceId) return Promise.resolve(false);
    pendingVaultSavesRef.current += 1;
    const task = vaultQueueRef.current.then(async () => {
      const active = workspaceRef.current;
      if (
        vaultQueueEpochRef.current !== queueEpoch
        || vaultMutationIntentEpochRef.current !== mutationIntentEpoch
        || active.unlocked?.workspace.workspaceId !== workspaceId
      ) return false;
      const current = sessionRef.current;
      if (current.persistence !== 'vault' || current.vaultWorkspaceId !== workspaceId) return false;
      const next = await mutate(current);
      if (!next) return false;
      // A restore is a full replacement. Re-check immediately before the
      // irreversible save so a mutation queued before that intent cannot write.
      if (
        vaultQueueEpochRef.current !== queueEpoch
        || vaultMutationIntentEpochRef.current !== mutationIntentEpoch
        || importCancellationEpochRef.current !== cancellationEpoch
        || restoreIntentEpochRef.current !== operationRestoreIntentEpoch
        || requestEpoch.current !== operationRequestEpoch
        || workspaceRef.current.unlocked?.workspace.workspaceId !== workspaceId
      ) return false;
      const head = await active.saveSnapshot(snapshotDraft(
        next, next.reviews, next.actions, active.unlocked.snapshot,
      ));
      // A confirmed head is a real remote write even when a newer restore or
      // source intent will supersede it. Report that fact to callers; the
      // mutation-intent gate below separately decides whether this head may be
      // used as the base for queued incremental work.
      if (head) options.onHeadCommitted?.();
      if (head && vaultMutationIntentEpochRef.current === mutationIntentEpoch) {
        restoredRef.current = `${workspaceId}:${head.generation}`;
        // A newer UI intent can suppress rendering this mutation, but a
        // confirmed head must remain the base of any following queued import.
        committedVaultSessionRef.current = {
          workspaceId,
          generation: head.generation,
          session: next,
        };
      }
      if (
        !head
        || vaultQueueEpochRef.current !== queueEpoch
        || vaultMutationIntentEpochRef.current !== mutationIntentEpoch
        || importCancellationEpochRef.current !== cancellationEpoch
        || requestEpoch.current !== operationRequestEpoch
        || workspaceRef.current.unlocked?.workspace.workspaceId !== workspaceId
      ) {
        if (
          !head
          && vaultQueueEpochRef.current === queueEpoch
          && vaultMutationIntentEpochRef.current === mutationIntentEpoch
          && importCancellationEpochRef.current === cancellationEpoch
          && requestEpoch.current === operationRequestEpoch
          && workspaceRef.current.unlocked?.workspace.workspaceId === workspaceId
          && sessionRef.current.persistence === 'vault'
          && sessionRef.current.vaultWorkspaceId === workspaceId
        ) {
          const failed = { ...sessionRef.current, errorCode: 'VAULT_SAVE_FAILED' };
          sessionRef.current = failed;
          dispatch({ type: 'SESSION', session: failed });
        }
        return false;
      }
      sessionRef.current = next;
      dispatch({ type: 'SESSION', session: next });
      return true;
    });
    vaultQueueRef.current = task.catch(() => undefined);
    return task.catch(() => false).finally(() => {
      pendingVaultSavesRef.current = Math.max(0, pendingVaultSavesRef.current - 1);
    });
  }, []);

  useEffect(() => {
    const guardPendingSave = (event: BeforeUnloadEvent) => {
      if (pendingVaultSavesRef.current < 1) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guardPendingSave);
    return () => window.removeEventListener('beforeunload', guardPendingSave);
  }, []);

  useEffect(() => {
    const unlocked = workspace.unlocked;
    if (!unlocked) {
      requestEpoch.current += 1;
      restoredRef.current = '';
      suppressedVaultHydrationWorkspaceRef.current = null;
      if (sessionRef.current.persistence === 'vault') {
        enterBrowserDemo(captureBrowserWriteToken());
      }
      return;
    }
    const snapshot = unlocked.snapshot;
    if (!snapshot || snapshot.archive === null) {
      if (
        sessionRef.current.persistence === 'vault'
        && sessionRef.current.vaultWorkspaceId !== unlocked.workspace.workspaceId
      ) {
        enterBrowserDemo(captureBrowserWriteToken());
      }
      return;
    }
    const restoreKey = `${unlocked.workspace.workspaceId}:${unlocked.generation}`;
    if (restoredRef.current === restoreKey) return;
    if (suppressedVaultHydrationWorkspaceRef.current === unlocked.workspace.workspaceId) {
      restoredRef.current = restoreKey;
      return;
    }
    const hydrationRequestEpoch = requestEpoch.current;
    const hydrationImportEpoch = importCancellationEpochRef.current;
    const hydrationWorkspaceIdentity = currentImportWorkspaceIdentity;
    const hydrationIsCurrent = () => (
      requestEpoch.current === hydrationRequestEpoch
      && importCancellationEpochRef.current === hydrationImportEpoch
      && observedImportWorkspaceIdentityRef.current === hydrationWorkspaceIdentity
      && workspaceRef.current.unlocked?.workspace.workspaceId === unlocked.workspace.workspaceId
    );
    let cancelled = false;
    void (async () => {
      try {
        const structural = readCsvFillLedgerExtension(snapshot.archive);
        const ledger = structural ? await verifyCsvFillLedgerIntegrity(structural) : null;
        const replay = ledger ? replayCsvFillLedger(ledger) : null;
        const archived = ledger ? null : importArchive(snapshot.archive);
        if (!replay && (archived?.error !== undefined || !archived?.trades?.length)) throw new Error();
        if (cancelled || !hydrationIsCurrent()) return;
        restoredRef.current = restoreKey;
        const next = importedSession(
          replay ? [...replay.trades] : enrichTrades([...archived!.trades!]),
          replay?.meta ?? archived!.meta!,
          {
            contract: replay?.contract ?? archived!.contract!,
            diagnostics: [...(replay?.diagnostics ?? archived!.diagnostics!)],
          },
          ledger ? `csv-ledger-${ledger.scopeDigest}` : null,
          {
            persistence: 'vault',
            vaultWorkspaceId: unlocked.workspace.workspaceId,
            reviews: snapshot.reviews,
            actions: snapshot.actions,
            journal: snapshot.journal,
            guards: snapshot.guards,
            importedAt: snapshot.source.importedAt,
            csvLedger: ledger,
          },
        );
        serializeExportableSessionArchive(next);
        if (cancelled || !hydrationIsCurrent()) return;
        committedVaultSessionRef.current = {
          workspaceId: unlocked.workspace.workspaceId,
          generation: unlocked.generation,
          session: next,
        };
        sessionRef.current = next;
        dispatch({ type: 'SESSION', session: next, warn: false });
      } catch {
        if (cancelled || !hydrationIsCurrent()) return;
        const failed = { ...sessionRef.current, errorCode: 'VAULT_ARCHIVE_INVALID' };
        sessionRef.current = failed;
        dispatch({ type: 'SESSION', session: failed });
      }
    })();
    return () => { cancelled = true; };
  }, [enterBrowserDemo, workspace.unlocked]);

  const cancelRestoreIntent = useCallback(() => {
    // This is deliberately synchronous. A newly selected file (even one that
    // later proves invalid) must revoke every older parse/restore before its
    // next awaited verification or persistence boundary.
    restoreIntentEpochRef.current += 1;
    importCancellationEpochRef.current += 1;
    requestEpoch.current += 1;
  }, []);

  const activateDemo = useCallback(() => {
    cancelRestoreIntent();
    suppressedVaultHydrationWorkspaceRef.current =
      workspaceRef.current.unlocked?.workspace.workspaceId ?? null;
    enterBrowserDemo(captureBrowserWriteToken());
  }, [cancelRestoreIntent, enterBrowserDemo]);

  const setImported = useCallback(async (
    trades: EnrichedTrade[],
    meta: ImportMeta,
    evidence: ImportEvidence,
    fills?: readonly CsvFillInput[],
    restoredLedger?: CsvFillLedger,
  ) => {
    const enqueueWorkspaceIdentity = importWorkspaceIdentity(workspaceRef.current);
    const enqueueVaultWorkspaceId = workspaceRef.current.unlocked?.workspace.workspaceId ?? null;
    const enqueueBrowserToken = enqueueVaultWorkspaceId ? null : captureBrowserWriteToken();
    if (
      enqueueVaultWorkspaceId === null
      && !sameBrowserWriteToken(browserSessionTokenRef.current, enqueueBrowserToken)
    ) {
      // A new CSV/FUPAN load may join the new generation, but it must first
      // discard every in-memory family inherited from the cleared one.
      invalidateBrowserSession(enqueueBrowserToken);
    }
    if (enqueueVaultWorkspaceId === null && enqueueBrowserToken === null) return false;
    const enqueueCancellationEpoch = importCancellationEpochRef.current;
    const precedingImport = importQueueRef.current;
    let releaseImport!: () => void;
    importQueueRef.current = new Promise<void>((resolve) => { releaseImport = resolve; });
    await precedingImport;
    try {
      if (
        importCancellationEpochRef.current !== enqueueCancellationEpoch
        || importWorkspaceIdentity(workspaceRef.current) !== enqueueWorkspaceIdentity
      ) return false;
      const epoch = requestEpoch.current + 1;
      requestEpoch.current = epoch;
      const prepare = async (base: Session) => {
        let nextTrades = trades;
        let nextMeta = meta;
        let nextEvidence = evidence;
        let csvLedger: CsvFillLedger | null = restoredLedger ?? null;
        let unchangedLedger = false;
        if (restoredLedger) {
          const replay = replayCsvFillLedger(restoredLedger, { historicalTrades: trades });
          if (replay.trades.length !== trades.length) throw new Error('ARCHIVE_LEDGER_MISMATCH');
          nextTrades = [...replay.trades];
          nextMeta = replay.meta;
          nextEvidence = { contract: replay.contract, diagnostics: [...replay.diagnostics] };
        } else if (fills) {
          const unlockedWorkspaceId = workspaceRef.current.unlocked?.workspace.workspaceId;
          if (
            workspaceRef.current.unlocked?.snapshot?.archive
            && (base.persistence !== 'vault' || base.vaultWorkspaceId !== unlockedWorkspaceId)
          ) throw new Error('VAULT_LEDGER_RESTORE_PENDING');
          if (base.source === 'imported' && base.trades.length && !base.csvLedger) {
            throw new Error('LEGACY_LEDGER_REBASE_REQUIRED');
          }
          const batch = { fills, meta, contract: evidence.contract, diagnostics: evidence.diagnostics };
          const merged = base.csvLedger
            ? await mergeCsvFillBatch(base.csvLedger, batch, { historicalTrades: base.trades })
            : await createCsvFillLedger(null, batch);
          unchangedLedger = base.csvLedger !== null
            && merged.duplicateBatch
            && canonicalJson(base.csvLedger.evidence) === canonicalJson(merged.ledger.evidence);
          csvLedger = merged.ledger;
          nextTrades = [...merged.trades];
          nextMeta = merged.meta;
          nextEvidence = { contract: merged.contract, diagnostics: [...merged.diagnostics] };
        }
        const scope = csvLedger
          ? `csv-ledger-${csvLedger.scopeDigest}`
          : await datasetReviewScope(nextTrades as unknown as Record<string, unknown>[]);
        return { nextTrades, nextMeta, nextEvidence, csvLedger, unchangedLedger, scope };
      };

      const targetWorkspace = workspaceRef.current.unlocked;
      if (targetWorkspace) {
        const workspaceId = targetWorkspace.workspace.workspaceId;
        const queueEpoch = vaultQueueEpochRef.current;
        const importIsCurrent = () => (
          requestEpoch.current === epoch
          && importCancellationEpochRef.current === enqueueCancellationEpoch
          && importWorkspaceIdentity(workspaceRef.current) === enqueueWorkspaceIdentity
          && vaultQueueEpochRef.current === queueEpoch
          && workspaceRef.current.unlocked?.workspace.workspaceId === workspaceId
        );
        pendingVaultSavesRef.current += 1;
        const task = vaultQueueRef.current.then(async () => {
          if (!importIsCurrent()) return false;
          const committed = committedVaultSessionRef.current;
          const currentSession = committed?.workspaceId === workspaceId
            ? committed.session
            : sessionRef.current;
          const snapshotBeforeImport = workspaceRef.current.unlocked?.snapshot ?? null;
          if (
            snapshotBeforeImport?.archive
            && (currentSession.persistence !== 'vault' || currentSession.vaultWorkspaceId !== workspaceId)
          ) {
            return false;
          }
          const prepared = await prepare(currentSession);
          if (!importIsCurrent()) return false;
          const activeWorkspace = workspaceRef.current;
          const currentSnapshot = activeWorkspace.unlocked?.snapshot ?? null;
          if (prepared.unchangedLedger) return true;
          if (!fills && currentSession.trades.length) {
            const currentScope = await datasetReviewScope(
              currentSession.trades as unknown as Record<string, unknown>[],
            );
            if (!importIsCurrent()) return false;
            if (
              currentScope === prepared.scope
              && currentSnapshot?.source.kind === 'csv'
              && currentSnapshot.source.accepted === prepared.nextEvidence.contract.provenance.coverage.accepted
              && currentSnapshot.source.dropped === prepared.nextEvidence.contract.provenance.coverage.dropped
              && currentSnapshot.source.coverage === snapshotCoverageStatus(
                prepared.nextEvidence.contract.provenance.coverage.status,
              )
            ) return true;
          }
          const retained = currentSession.source === 'imported'
            ? retainedReviewState(
                { reviews: currentSession.reviews, actions: currentSession.actions },
                prepared.nextTrades,
              )
            : retainedReviewState(currentSnapshot, prepared.nextTrades);
          const session = importedSession(
            prepared.nextTrades,
            prepared.nextMeta,
            prepared.nextEvidence,
            prepared.csvLedger ? prepared.scope : null,
            {
              persistence: 'vault',
              vaultWorkspaceId: workspaceId,
              reviews: retained.reviews,
              actions: retained.actions,
              journal: currentSession.source === 'imported'
                ? currentSession.journal : currentSnapshot?.journal ?? [],
              guards: currentSession.source === 'imported'
                ? currentSession.guards : currentSnapshot?.guards ?? [],
              csvLedger: prepared.csvLedger,
            },
          );
          serializeExportableSessionArchive(session);
          const head = await activeWorkspace.saveSnapshot(snapshotDraft(
            session,
            session.reviews,
            session.actions,
            currentSnapshot,
          ));
          if (head) {
            restoredRef.current = `${workspaceId}:${head.generation}`;
            committedVaultSessionRef.current = { workspaceId, generation: head.generation, session };
          }
          if (!head || !importIsCurrent()) return false;
          sessionRef.current = session;
          dispatch({ type: 'IMPORT', session });
          return true;
        });
        vaultQueueRef.current = task.catch(() => undefined);
        try {
          return await task;
        } finally {
          pendingVaultSavesRef.current = Math.max(0, pendingVaultSavesRef.current - 1);
        }
      }

      const prepared = await prepare(sessionRef.current);
      if (requestEpoch.current !== epoch) return false;
      if (!browserRestoreRecoveryReadyRef.current) return false;
      const observedBeforeLoad = captureBrowserWriteToken();
      if (
        !enqueueBrowserToken
        || !sameBrowserWriteToken(browserSessionTokenRef.current, enqueueBrowserToken)
        || !sameBrowserWriteToken(observedBeforeLoad, enqueueBrowserToken)
      ) {
        if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedBeforeLoad)) {
          invalidateBrowserSession(observedBeforeLoad);
        }
        return false;
      }
      // Hashing/replay is asynchronous. Re-read browser state so reviews or
      // practice saved during hashing are retained in the replacement.
      const currentSession = sessionRef.current;
      if (prepared.unchangedLedger && currentSession.persistence === 'browser') return true;
      const sameBrowserDataset = currentSession.persistence === 'browser'
        && currentSession.source === 'imported'
        && currentSession.reviewScope === prepared.scope;
      const retained = sameBrowserDataset
        ? retainedReviewState({
            reviews: currentSession.reviews,
            actions: currentSession.actions,
          }, prepared.nextTrades)
        : {
            reviews: loadReviews(prepared.scope),
            actions: loadActionPlans(prepared.scope),
          };
      const session = importedSession(
        prepared.nextTrades,
        prepared.nextMeta,
        prepared.nextEvidence,
        prepared.scope,
        {
          persistence: 'browser',
          reviews: retained.reviews,
          actions: retained.actions,
          journal: sameBrowserDataset ? currentSession.journal : undefined,
          guards: sameBrowserDataset ? currentSession.guards : undefined,
          csvLedger: prepared.csvLedger,
        },
      );
      serializeExportableSessionArchive(session);
      const observedBeforeDispatch = captureBrowserWriteToken();
      if (
        requestEpoch.current !== epoch
        || !sameBrowserWriteToken(browserSessionTokenRef.current, enqueueBrowserToken)
        || !sameBrowserWriteToken(observedBeforeDispatch, enqueueBrowserToken)
      ) {
        if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedBeforeDispatch)) {
          invalidateBrowserSession(observedBeforeDispatch);
        }
        return false;
      }
      sessionRef.current = session;
      dispatch({ type: 'IMPORT', session });
      return true;
    } finally {
      releaseImport();
    }
  }, [invalidateBrowserSession]);

  const restoreSessionArchive = useCallback(async (text: string) => {
    // A restore is a replacement operation, not an incremental import. It
    // therefore cancels work already queued before it and retains the target
    // it was requested for while ledger integrity verification is in flight.
    cancelRestoreIntent();
    vaultMutationIntentEpochRef.current += 1;
    const restoreIntentEpoch = restoreIntentEpochRef.current;
    const restoreCancellationEpoch = importCancellationEpochRef.current;
    const restoreWorkspaceIdentity = importWorkspaceIdentity(workspaceRef.current);
    const restoreIsCurrent = () => (
      importCancellationEpochRef.current === restoreCancellationEpoch
      && restoreIntentEpochRef.current === restoreIntentEpoch
      && importWorkspaceIdentity(workspaceRef.current) === restoreWorkspaceIdentity
    );
    let archive: unknown;
    try {
      archive = JSON.parse(text);
    } catch {
      return false;
    }
    let ledger: CsvFillLedger | null;
    try {
      const structural = readCsvFillLedgerExtension(archive);
      ledger = structural ? await verifyCsvFillLedgerIntegrity(structural) : null;
    } catch {
      throw new Error('ARCHIVE_LEDGER_INVALID');
    }
    if (!restoreIsCurrent()) return false;
    const imported = importArchive(archive);
    if (ledger) {
      const replay = replayCsvFillLedger(
        ledger,
        { historicalTrades: imported.error === undefined ? imported.trades : [] },
      );
      if (imported.error === undefined && replay.trades.length !== imported.trades.length) {
        throw new Error('ARCHIVE_LEDGER_MISMATCH');
      }
      if (imported.error !== undefined && replay.trades.length > 0) throw new Error('ARCHIVE_LEDGER_MISMATCH');
      if (!restoreIsCurrent()) return false;
      return setImported(
        [...replay.trades],
        replay.meta,
        { contract: replay.contract, diagnostics: [...replay.diagnostics] },
        undefined,
        ledger,
      );
    }
    if (imported.error !== undefined || !imported.trades.length) return false;
    if (!restoreIsCurrent()) return false;
    return setImported(
      enrichTrades([...imported.trades]),
      imported.meta,
      { contract: imported.contract, diagnostics: [...imported.diagnostics] },
    );
  }, [cancelRestoreIntent, setImported]);

  const clearBrowserData = useCallback(async () => {
    cancelRestoreIntent();
    vaultMutationIntentEpochRef.current += 1;
    suppressedVaultHydrationWorkspaceRef.current =
      workspaceRef.current.unlocked?.workspace.workspaceId ?? null;
    browserRestoreRecoveryReadyRef.current = false;
    browserRestoreRecoveryPromiseRef.current = null;
    const cleared = await clearBrowserUserData();
    if (!cleared.ok) return -1;
    // The coordinator committed both the forward-clear journal and generation
    // bump. A later mutation can recover normally without a second lock pass.
    browserRestoreRecoveryReadyRef.current = true;
    const observed = captureBrowserWriteToken();
    if (
      !browserResultMatchesToken(cleared.token, cleared.token, cleared.generation)
      || !sameBrowserWriteToken(cleared.token, observed)
    ) {
      // The requested clear did commit, so report its exact removal count; a
      // newer/damaged fence merely decides which token the empty UI binds to.
      enterBrowserDemo(observed);
      return cleared.removedUserKeys;
    }
    enterBrowserDemo(cleared.token);
    return cleared.removedUserKeys;
  }, [cancelRestoreIntent, enterBrowserDemo]);

  const restorePortableBackup = useCallback(async (text: string) => {
    cancelRestoreIntent();
    // Full restore owns the next vault replacement intent. Mutations that were
    // already queued capture the prior token and must stop before saveSnapshot.
    vaultMutationIntentEpochRef.current += 1;
    const operationVaultIntentEpoch = vaultMutationIntentEpochRef.current;
    const operationRestoreIntentEpoch = restoreIntentEpochRef.current;
    const operationCancellationEpoch = importCancellationEpochRef.current;
    const operationWorkspaceIdentity = importWorkspaceIdentity(workspaceRef.current);
    const operationEpoch = requestEpoch.current;
    const targetVaultWorkspaceId = workspaceRef.current.unlocked?.workspace.workspaceId ?? null;
    // A full replacement belongs to the already loaded browser session. It
    // must never join a generation that appeared after restore was requested.
    const browserWriteToken = targetVaultWorkspaceId
      ? null
      : browserSessionTokenRef.current;
    const restoreIsCurrent = () => (
      importCancellationEpochRef.current === operationCancellationEpoch
      && restoreIntentEpochRef.current === operationRestoreIntentEpoch
      && importWorkspaceIdentity(workspaceRef.current) === operationWorkspaceIdentity
      && (targetVaultWorkspaceId !== null
        || sameBrowserWriteToken(browserSessionTokenRef.current, browserWriteToken))
    );
    if (targetVaultWorkspaceId === null) {
      const observed = captureBrowserWriteToken();
      if (!browserWriteToken || !sameBrowserWriteToken(browserWriteToken, observed)) {
        if (!sameBrowserWriteToken(browserSessionTokenRef.current, observed)) {
          invalidateBrowserSession(observed);
        }
        return false;
      }
    }
    const preparation = (async () => {
      try {
        const parsedBackup = parseCompletePortableBackup(text);
        const snapshot = parsedBackup.snapshot;
        const structural = readCsvFillLedgerExtension(snapshot.archive);
        const ledger = structural ? await verifyCsvFillLedgerIntegrity(structural) : null;
        if (!restoreIsCurrent()) return null;
        const replay = ledger ? replayCsvFillLedger(ledger) : null;
        const archived = ledger ? null : importArchive(snapshot.archive);
        if (!replay && (archived?.error !== undefined || !archived?.trades?.length)) return null;
        return {
          source: parsedBackup.source,
          snapshot,
          ledger,
          trades: replay ? [...replay.trades] : enrichTrades([...archived!.trades!]),
          meta: replay?.meta ?? archived!.meta!,
          evidence: {
            contract: replay?.contract ?? archived!.contract!,
            diagnostics: [...(replay?.diagnostics ?? archived!.diagnostics!)],
          },
        };
      } catch {
        return null;
      }
    })();

    if (targetVaultWorkspaceId) {
      // Reserve the vault queue slot before preparation yields. Mutations
      // initiated after this restore therefore run after it; mutations already
      // queued carry the revoked token and stop immediately before save.
      const queueEpoch = vaultQueueEpochRef.current;
      pendingVaultSavesRef.current += 1;
      const task = vaultQueueRef.current.then(async () => {
        const prepared = await preparation;
        // A declared Demo backup must never become encrypted production data:
        // its synthetic identity and metric gates would be lost in a vault
        // snapshot, while the declaration itself is not a live-source proof.
        if (!prepared || prepared.source === 'demo') return false;
        const currentWorkspace = workspaceRef.current;
        if (
          vaultQueueEpochRef.current !== queueEpoch
          || vaultMutationIntentEpochRef.current !== operationVaultIntentEpoch
          || requestEpoch.current !== operationEpoch
          || !restoreIsCurrent()
          || currentWorkspace.phase !== 'UNLOCKED'
          || currentWorkspace.unlocked?.workspace.workspaceId !== targetVaultWorkspaceId
        ) return false;
        const next = importedSession(
          prepared.trades,
          prepared.meta,
          prepared.evidence,
          prepared.ledger ? `csv-ledger-${prepared.ledger.scopeDigest}` : null,
          {
            persistence: 'vault',
            vaultWorkspaceId: targetVaultWorkspaceId,
            reviews: prepared.snapshot.reviews,
            actions: prepared.snapshot.actions,
            journal: prepared.snapshot.journal,
            guards: prepared.snapshot.guards,
            importedAt: prepared.snapshot.source.importedAt,
            csvLedger: prepared.ledger,
          },
        );
        try {
          serializeExportableSessionArchive(next);
        } catch {
          return false;
        }
        // Keep this token check immediately adjacent to the irreversible call.
        if (
          vaultMutationIntentEpochRef.current !== operationVaultIntentEpoch
          || requestEpoch.current !== operationEpoch
          || !restoreIsCurrent()
        ) return false;
        const head = await currentWorkspace.saveSnapshot(snapshotDraft(
          next,
          next.reviews,
          next.actions,
          currentWorkspace.unlocked.snapshot,
        ));
        if (
          !head
          || vaultQueueEpochRef.current !== queueEpoch
          || vaultMutationIntentEpochRef.current !== operationVaultIntentEpoch
          || requestEpoch.current !== operationEpoch
          || !restoreIsCurrent()
          || workspaceRef.current.unlocked?.workspace.workspaceId !== targetVaultWorkspaceId
        ) return false;
        restoredRef.current = `${targetVaultWorkspaceId}:${head.generation}`;
        committedVaultSessionRef.current = {
          workspaceId: targetVaultWorkspaceId,
          generation: head.generation,
          session: next,
        };
        sessionRef.current = next;
        dispatch({ type: 'SESSION', session: next, warn: false });
        return true;
      });
      vaultQueueRef.current = task.catch(() => undefined);
      return task.catch(() => false).finally(() => {
        pendingVaultSavesRef.current = Math.max(0, pendingVaultSavesRef.current - 1);
      });
    }

    const prepared = await preparation;
    if (!prepared || !browserWriteToken) return false;
    const acceptBrowserReplacement = (
      persisted: Awaited<ReturnType<typeof replacePortableBrowserState>>,
    ): BrowserWorkspaceState | null => {
      const observed = captureBrowserWriteToken();
      const tokenMismatch = !sameBrowserWriteToken(browserSessionTokenRef.current, browserWriteToken)
        || !sameBrowserWriteToken(observed, browserWriteToken);
      const resultMismatch = persisted !== null
        && !browserResultMatchesToken(
          browserWriteToken,
          persisted.token,
          persisted.generation,
        );
      if (tokenMismatch || resultMismatch) {
        if (!sameBrowserWriteToken(browserSessionTokenRef.current, observed) || resultMismatch) {
          invalidateBrowserSession(observed);
        }
        return null;
      }
      return persisted?.state ?? null;
    };
    if (prepared.source === 'demo') {
      if (
        prepared.ledger !== null
        || !isDeterministicDemoTradeSet(prepared.trades)
        || requestEpoch.current !== operationEpoch
        || !restoreIsCurrent()
      ) return false;
      if (!await ensureBrowserRestoreReady() || !restoreIsCurrent()) return false;
      const persisted = await replacePortableBrowserState(
        DEMO_SCOPE,
        prepared.snapshot,
        browserWriteToken,
        () => requestEpoch.current === operationEpoch && restoreIsCurrent(),
      );
      const persistedState = acceptBrowserReplacement(persisted);
      if (!persistedState || requestEpoch.current !== operationEpoch || !restoreIsCurrent()) return false;
      const committed = {
        ...demoSession(false),
        reviews: persistedState.reviews,
        actions: persistedState.actions,
        journal: persistedState.journal,
        guards: persistedState.guards,
      };
      const observedBeforeDispatch = captureBrowserWriteToken();
      if (!sameBrowserWriteToken(browserSessionTokenRef.current, browserWriteToken)
        || !sameBrowserWriteToken(observedBeforeDispatch, browserWriteToken)) {
        if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedBeforeDispatch)) {
          invalidateBrowserSession(observedBeforeDispatch);
        }
        return false;
      }
      sessionRef.current = committed;
      dispatch({ type: 'SESSION', session: committed, warn: false });
      return true;
    }
    const scope = prepared.ledger
      ? `csv-ledger-${prepared.ledger.scopeDigest}`
      : await datasetReviewScope(prepared.trades as unknown as Record<string, unknown>[]);
    if (
      requestEpoch.current !== operationEpoch
      || !restoreIsCurrent()
      || !validBrowserReviewScope(scope)
    ) return false;
    const next = importedSession(
      prepared.trades,
      prepared.meta,
      prepared.evidence,
      scope,
      {
        persistence: 'browser',
        reviews: prepared.snapshot.reviews,
        actions: prepared.snapshot.actions,
        journal: prepared.snapshot.journal,
        guards: prepared.snapshot.guards,
        importedAt: prepared.snapshot.source.importedAt,
        csvLedger: prepared.ledger,
      },
    );
    try {
      serializeExportableSessionArchive(next);
    } catch {
      return false;
    }
    if (requestEpoch.current !== operationEpoch || !restoreIsCurrent()) return false;
    if (!await ensureBrowserRestoreReady() || !restoreIsCurrent()) return false;
    const persisted = await replacePortableBrowserState(
      scope,
      prepared.snapshot,
      browserWriteToken,
      () => requestEpoch.current === operationEpoch && restoreIsCurrent(),
    );
    const persistedState = acceptBrowserReplacement(persisted);
    if (!persistedState || requestEpoch.current !== operationEpoch || !restoreIsCurrent()) return false;
    const committed = {
      ...next,
      reviews: persistedState.reviews,
      actions: persistedState.actions,
      journal: persistedState.journal,
      guards: persistedState.guards,
    };
    const observedBeforeDispatch = captureBrowserWriteToken();
    if (!sameBrowserWriteToken(browserSessionTokenRef.current, browserWriteToken)
      || !sameBrowserWriteToken(observedBeforeDispatch, browserWriteToken)) {
      if (!sameBrowserWriteToken(browserSessionTokenRef.current, observedBeforeDispatch)) {
        invalidateBrowserSession(observedBeforeDispatch);
      }
      return false;
    }
    sessionRef.current = committed;
    dispatch({ type: 'SESSION', session: committed, warn: false });
    return true;
  }, [cancelRestoreIntent, ensureBrowserRestoreReady, invalidateBrowserSession]);

  const beginBinanceIntent = useCallback(() => {
    // requestEpoch protects completed UI transitions, while the import
    // cancellation epoch also invalidates work that has not left its queue or
    // is still hashing/verifying a ledger. Advance both synchronously before
    // any Binance runtime request can yield.
    cancelRestoreIntent();
    const token = captureBrowserWriteToken();
    if (!token) {
      invalidateBrowserSession(null);
      return null;
    }
    if (!sameBrowserWriteToken(browserSessionTokenRef.current, token)) {
      invalidateBrowserSession(token);
    }
    const epoch = requestEpoch.current;
    browserSessionTokenRef.current = token;
    suppressedVaultHydrationWorkspaceRef.current =
      workspaceRef.current.unlocked?.workspace.workspaceId ?? null;
    dispatch({ type: 'BINANCE_LOADING' });
    return Object.freeze({ epoch, token });
  }, [cancelRestoreIntent, invalidateBrowserSession]);

  const binanceIntentIsCurrent = useCallback((operation: Readonly<{
    epoch: number;
    token: BrowserWriteToken;
  }>) => {
    if (requestEpoch.current !== operation.epoch) return false;
    const observed = captureBrowserWriteToken();
    if (
      !sameBrowserWriteToken(browserSessionTokenRef.current, operation.token)
      || !sameBrowserWriteToken(observed, operation.token)
    ) {
      if (!sameBrowserWriteToken(browserSessionTokenRef.current, observed)) {
        invalidateBrowserSession(observed);
      }
      return false;
    }
    return true;
  }, [invalidateBrowserSession]);

  const loadBinance = useCallback(async () => {
    const operation = beginBinanceIntent();
    if (!operation) return;
    try {
      const snapshot = await loadBinanceSnapshot();
      if (!binanceIntentIsCurrent(operation)) return;
      dispatch({ type: 'BINANCE_READY', snapshot });
    } catch (error) {
      if (!binanceIntentIsCurrent(operation)) return;
      dispatch({ type: 'BINANCE_ERROR', code: safeRuntimeError(error) });
    }
  }, [beginBinanceIntent, binanceIntentIsCurrent]);

  const pollBinanceUntilTerminal = useCallback(async (operation: Readonly<{
    epoch: number;
    token: BrowserWriteToken;
  }>) => {
    for (let attempt = 0; attempt < SYNC_POLL_ATTEMPTS; attempt += 1) {
      if (!binanceIntentIsCurrent(operation)) return null;
      const snapshot = await loadBinanceSnapshot();
      if (!binanceIntentIsCurrent(operation)) return null;
      if (['COMPLETED', 'PARTIAL', 'BLOCKED', 'ERROR'].includes(
        snapshot.runtime.sync.state,
      ) || snapshot.runtime.phase === 'MIGRATION_REQUIRED') return snapshot;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, SYNC_POLL_INTERVAL_MS);
      });
    }
    throw Object.assign(new Error('Sync timed out'), { code: 'SYNC_TIMEOUT' });
  }, [binanceIntentIsCurrent]);

  const syncBinance = useCallback(async () => {
    const operation = beginBinanceIntent();
    if (!operation) return;
    try {
      const start = await startBinanceSync();
      if (!binanceIntentIsCurrent(operation)) return;
      if (start.state === 'BLOCKED') {
        throw Object.assign(new Error('Sync blocked'), {
          code: start.reasonCodes[0] ?? 'SYNC_BLOCKED',
        });
      }
      const snapshot = await pollBinanceUntilTerminal(operation);
      if (!snapshot) return;
      if (binanceIntentIsCurrent(operation)) {
        dispatch({ type: 'BINANCE_READY', snapshot });
      }
    } catch (error) {
      if (binanceIntentIsCurrent(operation)) {
        dispatch({ type: 'BINANCE_ERROR', code: safeRuntimeError(error) });
      }
    }
  }, [beginBinanceIntent, binanceIntentIsCurrent, pollBinanceUntilTerminal]);

  const connectBinance = useCallback(async (apiKey: string, apiSecret: string) => {
    const operation = beginBinanceIntent();
    if (!operation) return;
    try {
      await storeBinanceCredentials(apiKey, apiSecret);
      if (!binanceIntentIsCurrent(operation)) return;
      const snapshot = await pollBinanceUntilTerminal(operation);
      if (!snapshot) return;
      if (binanceIntentIsCurrent(operation)) {
        dispatch({ type: 'BINANCE_READY', snapshot });
      }
    } catch (error) {
      if (binanceIntentIsCurrent(operation)) {
        dispatch({ type: 'BINANCE_ERROR', code: safeRuntimeError(error) });
      }
    }
  }, [beginBinanceIntent, binanceIntentIsCurrent, pollBinanceUntilTerminal]);

  const exportSession = useCallback(() => {
    const session = state.session;
    if (!session.trades.length && !session.csvLedger) return;
    const date = new Date();
    const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
      .join('');
    download(`复盘存档-${stamp}.fupan`, serializeExportableSessionArchive(session));
  }, [state.session]);

  const saveTradeReview = useCallback(async (tradeId: string, draft: ReviewDraft) => {
    const currentSession = sessionRef.current;
    if (currentSession.cloudWorkspace) {
      return commitCloudMutation(currentSession, async (current) => {
        if (!current.trades.some((trade) => String(trade.id) === tradeId)) return false;
        await upsertCloudTradeReview(
          current.cloudWorkspace.connectionId,
          tradeId,
          current.cloudWorkspace.reviewVersions[tradeId] ?? 0,
          draft,
        );
        return true;
      });
    }
    if (currentSession.persistence === 'vault') {
      return queueVaultMutation((current) => {
        const now = Date.now();
        const reviews = copyReviewMap(current.reviews);
        reviews[tradeId] = { ...draft, updatedAt: now };
        const actions = draft.reviewed && draft.lesson.trim()
          ? nextReviewAction(current.actions, tradeId, draft.lesson, now) : current.actions;
        return actions ? { ...current, reviews, actions, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(currentSession, (latest) => {
      const now = Date.now();
      const reviews = copyReviewMap(latest.reviews);
      reviews[tradeId] = { ...draft, updatedAt: now };
      const actions = draft.reviewed && draft.lesson.trim()
        ? nextReviewAction(latest.actions, tradeId, draft.lesson, now)
        : latest.actions;
      return actions ? {
        state: { ...latest, reviews, actions },
        value: true,
      } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const setActionStatus = useCallback(async (actionId: string, status: ActionPlanStatus) => {
    const currentSession = sessionRef.current;
    if (currentSession.cloudWorkspace) {
      return commitCloudMutation(currentSession, async (current) => {
        const actions = nextActionPlanStatus(current.actions, actionId, status);
        return actions ? persistCloudAction(current, actionId, actions[actionId]) : false;
      });
    }
    if (currentSession.persistence === 'vault') {
      return queueVaultMutation((current) => {
        const actions = nextActionPlanStatus(current.actions, actionId, status);
        return actions ? { ...current, actions, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(currentSession, (latest) => {
      const actions = nextActionPlanStatus(latest.actions, actionId, status);
      return actions ? { state: { ...latest, actions }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const setActionExperiment = useCallback(async (
    actionId: string,
    input: ActionExperimentInput,
  ) => {
    const currentSession = sessionRef.current;
    if (currentSession.cloudWorkspace) {
      return commitCloudMutation(currentSession, async (current) => {
        if (!cloudExperimentsAllowed(current)) return false;
        const actions = nextActionExperiment(current.actions, actionId, input);
        return actions ? persistCloudAction(current, actionId, actions[actionId]) : false;
      });
    }
    if (currentSession.persistence === 'vault') {
      return queueVaultMutation((current) => {
        const actions = nextActionExperiment(current.actions, actionId, input);
        return actions ? { ...current, actions, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(currentSession, (latest) => {
      const actions = nextActionExperiment(latest.actions, actionId, input);
      return actions ? { state: { ...latest, actions }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const recordActionExperimentObservation = useCallback(async (
    actionId: string,
    input: ActionExperimentObservationInput,
  ) => {
    const currentSession = sessionRef.current;
    if (currentSession.cloudWorkspace) {
      return commitCloudMutation(currentSession, async (current) => {
        if (!cloudExperimentsAllowed(current)) return false;
        const actions = nextActionExperimentObservation(current.actions, actionId, input);
        return actions ? persistCloudAction(current, actionId, actions[actionId]) : false;
      });
    }
    if (currentSession.persistence === 'vault') {
      return queueVaultMutation((current) => {
        const actions = nextActionExperimentObservation(current.actions, actionId, input);
        return actions ? { ...current, actions, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(currentSession, (latest) => {
      const actions = nextActionExperimentObservation(latest.actions, actionId, input);
      return actions ? { state: { ...latest, actions }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const decideActionExperiment = useCallback(async (
    actionId: string,
    decision: Exclude<ActionExperimentDecision, 'pending'>,
    evidenceNote: string,
  ) => {
    const currentSession = sessionRef.current;
    if (currentSession.cloudWorkspace) {
      return commitCloudMutation(currentSession, async (current) => {
        if (!cloudExperimentsAllowed(current)) return false;
        const actions = nextActionExperimentDecision(
          current.actions,
          actionId,
          decision,
          evidenceNote,
        );
        return actions ? persistCloudAction(current, actionId, actions[actionId]) : false;
      });
    }
    if (currentSession.persistence === 'vault') {
      return queueVaultMutation((current) => {
        const actions = nextActionExperimentDecision(
          current.actions,
          actionId,
          decision,
          evidenceNote,
        );
        return actions ? { ...current, actions, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(currentSession, (latest) => {
      const actions = nextActionExperimentDecision(
        latest.actions,
        actionId,
        decision,
        evidenceNote,
      );
      return actions ? { state: { ...latest, actions }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const saveJournal = useCallback(async (day: string, note: string, emotion: string) => {
    const current = sessionRef.current;
    if (current.cloudWorkspace) {
      return commitCloudMutation(current, async (latest) => {
        const journal = nextJournal(latest.journal, { day, note, emotion });
        const entry = journal?.find((candidate) => candidate.day === day.trim());
        if (!entry) return false;
        await upsertCloudJournal(
          latest.cloudWorkspace.connectionId,
          entry.day,
          latest.cloudWorkspace.journalVersions[entry.day] ?? 0,
          { note: entry.note, emotion: entry.emotion },
        );
        return true;
      });
    }
    if (current.persistence === 'vault') {
      return queueVaultMutation((latest) => {
        const journal = nextJournal(latest.journal, { day, note, emotion });
        return journal ? { ...latest, journal, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(current, (latest) => {
      const journal = nextJournal(latest.journal, { day, note, emotion });
      return journal ? { state: { ...latest, journal }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const saveGuard = useCallback(async (text: string) => {
    const current = sessionRef.current;
    const guardId = crypto.randomUUID();
    if (current.cloudWorkspace) {
      return commitCloudMutation(current, async (latest) => {
        const guards = nextGuard(latest.guards, guardId, text);
        const guard = guards?.find((candidate) => candidate.id === guardId);
        if (!guard) return false;
        await upsertCloudRiskRule(latest.cloudWorkspace.connectionId, guard.id, {
          expectedVersion: 0,
          status: 'ACTIVE',
          payload: { text: guard.text, active: true },
        });
        return true;
      });
    }
    if (current.persistence === 'vault') {
      return queueVaultMutation((latest) => {
        const guards = nextGuard(latest.guards, guardId, text);
        return guards ? { ...latest, guards, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(current, (latest) => {
      const guards = nextGuard(latest.guards, guardId, text);
      return guards ? { state: { ...latest, guards }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const setGuardActive = useCallback(async (guardId: string, active: boolean) => {
    const current = sessionRef.current;
    if (current.cloudWorkspace) {
      return commitCloudMutation(current, async (latest) => {
        const guards = nextGuardActive(latest.guards, guardId, active);
        const guard = guards?.find((candidate) => candidate.id === guardId);
        const expectedVersion = latest.cloudWorkspace.riskVersions[guardId] ?? -1;
        if (!guard || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return false;
        await upsertCloudRiskRule(latest.cloudWorkspace.connectionId, guard.id, {
          expectedVersion,
          status: active ? 'ACTIVE' : 'PAUSED',
          payload: { text: guard.text, active },
        });
        return true;
      });
    }
    if (current.persistence === 'vault') {
      return queueVaultMutation((latest) => {
        const guards = nextGuardActive(latest.guards, guardId, active);
        return guards ? { ...latest, guards, errorCode: null } : null;
      });
    }
    const committed = await commitBrowserMutation(current, (latest) => {
      const guards = nextGuardActive(latest.guards, guardId, active);
      return guards ? { state: { ...latest, guards }, value: true } : null;
    });
    return committed?.value === true;
  }, [commitBrowserMutation, commitCloudMutation, queueVaultMutation]);

  const saveReportSnapshot = useCallback(async (input: Readonly<{
    reportType: 'WEEKLY' | 'MONTHLY';
    periodStart: string;
    periodEnd: string;
    payload: Readonly<Record<string, unknown>>;
  }>) => {
    const current = sessionRef.current;
    if (!current.cloudWorkspace) return false;
    return commitCloudMutation(current, async (latest) => {
      const key = `${input.reportType}:${input.periodStart}:${input.periodEnd}`;
      await upsertCloudReport(latest.cloudWorkspace.connectionId, {
        expectedVersion: latest.cloudWorkspace.reportVersions[key] ?? 0,
        reportType: input.reportType,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        sourceGeneration: latest.cloudWorkspace.generation,
        payload: input.payload,
      });
      return true;
    });
  }, [commitCloudMutation]);

  const applyLegacyReviewMigration = useCallback(async (
    plan: LegacyReviewMigrationPlan,
    selectedTradeIds: readonly string[],
  ): Promise<LegacyReviewMigrationReceipt | null> => {
    const selection = [...selectedTradeIds];
    const initial = sessionRef.current;
    if (initial.cloudWorkspace) return null;
    if (
      initial.source === 'demo'
      || initial.persistence === 'demo'
      || !validBrowserReviewScope(initial.reviewScope)
      || initial.trades.length === 0
    ) return null;

    if (initial.persistence === 'vault') {
      let receipt: LegacyReviewMigrationReceipt | null = null;
      let headCommitted = false;
      const saved = await queueVaultMutation(async (current) => {
        if (
          current.source === 'demo'
          || !validBrowserReviewScope(current.reviewScope)
          || current.trades.length === 0
        ) return null;
        try {
          const merged = await mergeLegacyReviewMigration(plan, {
            reviewScope: current.reviewScope,
            currentTradeIds: currentTradeIds(current),
            selectedTradeIds: selection,
            existingReviews: current.reviews,
          });
          receipt = merged.receipt;
          return {
            ...current,
            reviews: copyReviewMap(merged.reviews),
            errorCode: null,
          };
        } catch {
          return null;
        }
      }, {
        onHeadCommitted: () => { headCommitted = true; },
      });
      return saved || headCommitted ? receipt : null;
    }

    if (initial.persistence !== 'browser' && initial.persistence !== 'runtime') return null;
    const reviewScope = initial.reviewScope as string;
    const tradeIds = currentTradeIds(initial);
    const operationRequestEpoch = requestEpoch.current;
    const operationRestoreEpoch = restoreIntentEpochRef.current;
    const operationImportEpoch = importCancellationEpochRef.current;
    const migrationIsCurrent = () => requestEpoch.current === operationRequestEpoch
      && restoreIntentEpochRef.current === operationRestoreEpoch
      && importCancellationEpochRef.current === operationImportEpoch;
    const committed = await commitBrowserMutation(initial, async (latest) => {
      try {
        const merged = await mergeLegacyReviewMigration(plan, {
          reviewScope,
          currentTradeIds: tradeIds,
          selectedTradeIds: selection,
          existingReviews: latest.reviews,
        });
        return {
          state: { ...latest, reviews: copyReviewMap(merged.reviews) },
          value: merged.receipt,
        };
      } catch {
        return null;
      }
    }, migrationIsCurrent);
    return committed?.value ?? null;
  }, [commitBrowserMutation, queueVaultMutation]);

  const sourceLabel = state.session.persistence === 'vault'
    ? '端到端加密云仓'
    : state.session.source === 'demo'
    ? '合成演示'
    : state.session.source === 'imported'
      ? 'CSV 导入'
      : state.session.cloudWorkspace
        ? 'Binance 云端'
        : '本机 Binance';
  const analyticsReady = state.session.source === 'demo'
    || (state.session.source === 'imported'
      && state.session.trades.length > 0
      && state.session.contract?.capabilities.values.pnlReported === true)
    || (state.session.source === 'binance'
      && state.session.phase === 'BINANCE_OBSERVED_READY');

  const store = useMemo<Store>(() => ({
    session: state.session,
    sourceLabel,
    analyticsReady,
    warn: state.warn,
    activateDemo,
    setImported,
    restoreSessionArchive,
    restorePortableBackup,
    cancelRestoreIntent,
    loadBinance,
    syncBinance,
    connectBinance,
    exportSession,
    saveTradeReview,
    setActionStatus,
    setActionExperiment,
    recordActionExperimentObservation,
    decideActionExperiment,
    applyLegacyReviewMigration,
    saveJournal,
    saveGuard,
    setGuardActive,
    saveReportSnapshot,
    ackWarn: () => dispatch({ type: 'ACK_WARN' }),
    clear: clearBrowserData,
    clearBrowserData,
  }), [
    state,
    sourceLabel,
    analyticsReady,
    activateDemo,
    cancelRestoreIntent,
    clearBrowserData,
    setImported,
    restoreSessionArchive,
    restorePortableBackup,
    loadBinance,
    syncBinance,
    connectBinance,
    exportSession,
    saveTradeReview,
    setActionStatus,
    setActionExperiment,
    recordActionExperimentObservation,
    decideActionExperiment,
    applyLegacyReviewMigration,
    saveJournal,
    saveGuard,
    setGuardActive,
    saveReportSnapshot,
  ]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore() {
  const store = useContext(Ctx);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}
