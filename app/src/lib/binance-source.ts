import { bundleToTrades, enrichTrades } from '@rv/engine';
import {
  normalizeBundleResponseV1,
  normalizeRuntimeStatusV1,
  normalizeSyncRecentV1,
} from '@rv/engine/loopback-api';
import {
  CANONICAL_RUNTIME_ORIGIN,
  RuntimeClientError,
  createRuntimeClient,
} from '@rv/engine/runtime-client';
import type { EnrichedTrade } from '@rv/engine';
import { resolveBinanceAccess, type BinanceAccess } from './access-policy';
import { loadAuthSession } from './auth-session-storage';
import {
  CloudBetaClient,
  type CloudActionMutation,
  type CloudCredentialInput,
  type CloudMutationReceipt,
  type CloudOwnerRecoveryReceipt,
  type CloudReportMutation,
  type CloudReviewPayload,
  type CloudReviewReceipt,
  type CloudRiskMutation,
} from './cloud-beta-client';
import {
  BINANCE_BETA_CONSENT_VERSION,
  type CloudConnection,
  type CloudConnectionMutation,
  type CloudConnectionStatus,
  type CloudConnections,
  type CloudDisconnectReceipt,
} from './cloud-beta-connection';
import type { CloudDatasetV1 } from './cloud-beta-contract';
import { normalizeActionPlanMap, type ActionPlanMap } from './action-plan-storage';
import { normalizePracticeState } from './practice-state';
import { normalizeReviewMap, type ReviewMap } from './review-storage';
import type { SnapshotGuard, SnapshotJournalEntry } from './workspace-snapshot';
import { ProductionConfigError, readProductionConfig, type ProductionConfig } from './production-config';
import { INVITE_BETA_CANONICAL_ORIGIN } from './release-config';

export type SanitizedFill = Readonly<{
  id: string | number;
  symbol: string;
  side: string;
  positionSide?: string;
  time: number;
  price: string | number;
  qty: string | number;
  commission: string | number;
  realizedPnl: string | number;
}>;

export type RuntimeSnapshotDto = Readonly<{
  protocol: string;
  phase: string;
  updatedAt: number;
  rows: number;
  failedWindows: number;
  cooldownUntil: number;
  reviewScope?: string | null;
  sync: Readonly<{
    state: string;
    phase: string;
    startedAt: number | null;
    updatedAt: number;
    fills: number;
    reasonCodes: readonly string[];
  }>;
  binance: Readonly<{ connected: boolean; state: string; canSync: boolean }>;
}>;

export type BundleSnapshotDto = Readonly<{
  updatedAt: number;
  reviewScope?: string | null;
  fills: readonly SanitizedFill[];
  income: readonly unknown[];
  orders: readonly unknown[];
  symbols: readonly string[];
  done: readonly string[];
  coverage: Readonly<Record<string, string>>;
  reconciliation?: Readonly<{
    protocol?: string;
    status?: string;
    reasonCodes?: readonly string[];
    checks?: Readonly<Record<string, Readonly<{ status?: string; reasonCodes?: readonly string[] }>>>;
  }>;
  _meta: Readonly<{
    dataStatus: string;
    connected: boolean;
    canSync: boolean;
    syncState: string;
    quality: any;
    legacyMigrationAvailable: boolean;
  }>;
}>;

export type BinanceSnapshot = Readonly<{
  runtime: RuntimeSnapshotDto;
  bundle: BundleSnapshotDto;
  records: readonly SanitizedFill[];
  trades: readonly EnrichedTrade[];
  access: BinanceAccess;
  reviewScope: string | null;
  cloudWorkspace: CloudWorkspaceSnapshot | null;
}>;

export type CloudWorkspaceSnapshot = Readonly<{
  connectionId: string;
  generation: number;
  capabilities: CloudDatasetV1['capabilities'];
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
  reports: CloudDatasetV1['reports'];
  reviewVersions: Readonly<Record<string, number>>;
  actionVersions: Readonly<Record<string, number>>;
  actionBindings: Readonly<Record<string, Readonly<{ reviewId: string; tradeId: string }>>>;
  journalVersions: Readonly<Record<string, number>>;
  riskVersions: Readonly<Record<string, number>>;
  reportVersions: Readonly<Record<string, number>>;
}>;

export type SyncStartResult = Readonly<{
  state: 'STARTED' | 'BUSY' | 'BLOCKED';
  reasonCodes: readonly string[];
}>;

type CloudAuthIdentity = Readonly<{
  accessToken: string;
  userId: string;
}>;

export type BinanceSourceOptions = Readonly<{
  origin?: string;
  env?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  authSession?: () => CloudAuthIdentity | null;
}>;

export type BinanceSourceMode = 'local-runtime' | 'invite-beta' | 'unavailable';

let client: ReturnType<typeof createRuntimeClient> | null = null;
const REVIEW_SCOPE_PATTERN = /^rv1_[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let selectedCloudConnectionId: string | null = null;

function runtimeFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function resolveSnapshotReviewScope(
  runtime: Pick<RuntimeSnapshotDto, 'reviewScope' | 'binance'>,
  bundle: Pick<BundleSnapshotDto, 'reviewScope' | '_meta'>,
): string {
  if (!runtime.binance.connected || !bundle._meta.connected) {
    throw runtimeFailure('BINANCE_NOT_CONNECTED');
  }
  const runtimeScope = runtime.reviewScope;
  const bundleScope = bundle.reviewScope;
  if (
    typeof runtimeScope !== 'string'
    || typeof bundleScope !== 'string'
    || !REVIEW_SCOPE_PATTERN.test(runtimeScope)
    || !REVIEW_SCOPE_PATTERN.test(bundleScope)
    || runtimeScope !== bundleScope
  ) throw runtimeFailure('BINANCE_SCOPE_MISMATCH');
  return `binance-${runtimeScope.replace('_', '-')}`;
}

function runtimeClient() {
  if (!client) client = createRuntimeClient();
  return client;
}

export function runtimeAvailable(): boolean {
  return typeof window !== 'undefined' && window.location.origin === CANONICAL_RUNTIME_ORIGIN;
}

function sourceOrigin(options: BinanceSourceOptions): string {
  if (typeof options.origin === 'string') return options.origin;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function sourceEnv(options: BinanceSourceOptions): Record<string, unknown> {
  if (options.env) return options.env;
  // Keep this allowlist explicit. Passing the whole import.meta.env object makes
  // Vite serialize every VITE_* variable, including unrelated build secrets.
  return {
    VITE_RELEASE_CHANNEL: import.meta.env.VITE_RELEASE_CHANNEL,
    VITE_BACKEND_MODE: import.meta.env.VITE_BACKEND_MODE,
    VITE_APP_ORIGIN: import.meta.env.VITE_APP_ORIGIN,
    VITE_EXPECTED_SUPABASE_PROJECT_REF: import.meta.env.VITE_EXPECTED_SUPABASE_PROJECT_REF,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}

function exactCloudConfig(options: BinanceSourceOptions): ProductionConfig | null {
  const env = sourceEnv(options);
  if (
    env.VITE_RELEASE_CHANNEL !== 'production'
    || env.VITE_BACKEND_MODE !== 'invite-beta'
    || env.VITE_APP_ORIGIN !== INVITE_BETA_CANONICAL_ORIGIN
    || sourceOrigin(options) !== INVITE_BETA_CANONICAL_ORIGIN
  ) return null;
  const expectedRef = typeof env.VITE_EXPECTED_SUPABASE_PROJECT_REF === 'string'
    ? env.VITE_EXPECTED_SUPABASE_PROJECT_REF.trim()
    : '';
  if (!/^[a-z0-9]{20}$/.test(expectedRef)) return null;
  let config: ProductionConfig | null;
  try {
    config = readProductionConfig(env);
  } catch (error) {
    if (error instanceof ProductionConfigError) return null;
    throw error;
  }
  if (!config) return null;
  let endpoint: URL;
  try {
    endpoint = new URL(config.supabaseUrl);
  } catch {
    return null;
  }
  if (
    endpoint.origin !== config.supabaseUrl
    || endpoint.hostname !== `${expectedRef}.supabase.co`
  ) return null;
  return config;
}

export function resolveBinanceSourceMode(
  options: BinanceSourceOptions = {},
): BinanceSourceMode {
  if (sourceOrigin(options) === CANONICAL_RUNTIME_ORIGIN) return 'local-runtime';
  return exactCloudConfig(options) ? 'invite-beta' : 'unavailable';
}

export function cloudBetaAvailable(options: BinanceSourceOptions = {}): boolean {
  return resolveBinanceSourceMode(options) === 'invite-beta';
}

export function selectCloudConnection(connectionId: string | null): void {
  if (connectionId !== null && !UUID_PATTERN.test(connectionId)) {
    throw runtimeFailure('CLOUD_CONNECTION_INVALID');
  }
  selectedCloudConnectionId = connectionId;
}

function cloudReviewScope(userId: string): string {
  if (!UUID_PATTERN.test(userId)) throw runtimeFailure('CLOUD_SCOPE_INVALID');
  return `binance-rv1-${userId.toLowerCase().replaceAll('-', '')}`;
}

function cloudSession(options: BinanceSourceOptions): Readonly<{
  api: CloudBetaClient;
  identity: CloudAuthIdentity;
}> {
  const config = exactCloudConfig(options);
  if (!config) throw runtimeFailure('RUNTIME_UNAVAILABLE');
  const identity = (options.authSession ?? (() => loadAuthSession()))();
  if (!identity) throw runtimeFailure('CLOUD_AUTH_REQUIRED');
  cloudReviewScope(identity.userId);
  return Object.freeze({
    api: new CloudBetaClient(config, {
      fetchImpl: options.fetchImpl,
      accessToken: () => identity.accessToken,
    }),
    identity,
  });
}

function chooseConnection(connections: CloudConnections): CloudConnection {
  if (connections.connections.length === 0) throw runtimeFailure('BINANCE_NOT_CONNECTED');
  const selected = selectedCloudConnectionId === null
    ? connections.connections[0]
    : connections.connections.find((entry) => entry.connectionId === selectedCloudConnectionId);
  if (!selected) throw runtimeFailure('CLOUD_CONNECTION_NOT_FOUND');
  selectedCloudConnectionId = selected.connectionId;
  return selected;
}

function coverageLabel(state: CloudDatasetV1['coverage']['trades']['state']): string {
  if (state === 'VERIFIED') return 'complete';
  return state.toLowerCase();
}

function subtractCloudDecimal(left: string, right: string): number {
  const parts = (value: string) => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, decimals = ''] = unsigned.split('.');
    return { negative, whole, decimals };
  };
  const leftParts = parts(left);
  const rightParts = parts(right);
  const scale = Math.max(leftParts.decimals.length, rightParts.decimals.length);
  const units = (value: ReturnType<typeof parts>) => {
    const magnitude = BigInt(`${value.whole}${value.decimals.padEnd(scale, '0')}`);
    return value.negative ? -magnitude : magnitude;
  };
  const difference = units(leftParts) - units(rightParts);
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference).toString().padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const decimals = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/u, '');
  const numeric = Number(`${negative ? '-' : ''}${whole}${decimals ? `.${decimals}` : ''}`);
  if (!Number.isFinite(numeric)) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');
  return numeric;
}

function finiteCloudNumber(value: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');
  return numeric;
}

function exactPayload(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw runtimeFailure('CLOUD_WORKSPACE_INVALID');
  }
  return value;
}

function cloudWorkspace(
  connectionId: string,
  dataset: CloudDatasetV1,
  capabilities: CloudDatasetV1['capabilities'],
): CloudWorkspaceSnapshot {
  const reviewRows: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const reviewVersions: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const row of dataset.reviews) {
    const payload = exactPayload(row.payload, ['saw', 'happened', 'lesson', 'grade', 'reviewed']);
    reviewRows[row.tradeId] = {
      ...payload,
      updatedAt: Date.parse(row.updatedAt),
    };
    reviewVersions[row.tradeId] = row.version;
  }
  const reviews = normalizeReviewMap(reviewRows);
  if (!reviews) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');

  const actionRows: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const actionVersions: Record<string, number> = Object.create(null) as Record<string, number>;
  const actionBindings: Record<string, Readonly<{ reviewId: string; tradeId: string }>> =
    Object.create(null) as Record<string, Readonly<{ reviewId: string; tradeId: string }>>;
  for (const row of dataset.actions) {
    const payload = exactPayload(row.payload, ['text', 'experiment']);
    const createdAt = Date.parse(row.createdAt);
    const updatedAt = Date.parse(row.updatedAt);
    const experiment = payload.experiment ?? null;
    const completedAt = row.status === 'DONE'
      || (row.status === 'CANCELLED'
        && experiment !== null
        && typeof experiment === 'object'
        && !Array.isArray(experiment)
        && (experiment as Record<string, unknown>).decision === 'discard')
      ? updatedAt
      : null;
    actionRows[row.actionId] = {
      id: row.actionId,
      sourceTradeId: row.tradeId,
      text: payload.text,
      status: row.status === 'OPEN' ? 'open' : row.status === 'DONE' ? 'done' : 'dismissed',
      createdAt,
      updatedAt,
      completedAt,
      experiment,
    };
    actionVersions[row.actionId] = row.version;
    actionBindings[row.actionId] = Object.freeze({ reviewId: row.reviewId, tradeId: row.tradeId });
  }
  const actions = normalizeActionPlanMap(actionRows);
  if (!actions) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');

  const journalVersions: Record<string, number> = Object.create(null) as Record<string, number>;
  const journal = dataset.journal.map((row) => {
    const payload = exactPayload(row.payload, ['note', 'emotion']);
    journalVersions[row.day] = row.version;
    return {
      day: row.day,
      note: payload.note,
      emotion: payload.emotion,
      updatedAt: Date.parse(row.updatedAt),
    };
  });
  const riskVersions: Record<string, number> = Object.create(null) as Record<string, number>;
  const guards = dataset.risk.map((row) => {
    const payload = exactPayload(row.payload, ['text', 'active']);
    const active = row.status === 'ACTIVE';
    if (payload.active !== active) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');
    riskVersions[row.ruleId] = row.version;
    return {
      id: row.ruleId,
      text: payload.text,
      active,
      createdAt: Date.parse(row.createdAt),
      updatedAt: Date.parse(row.updatedAt),
    };
  });
  const practice = normalizePracticeState({ journal, guards });
  if (!practice) throw runtimeFailure('CLOUD_WORKSPACE_INVALID');

  const reportVersions = Object.fromEntries(dataset.reports.map((row) => [
    `${row.reportType}:${row.periodStart}:${row.periodEnd}`,
    row.version,
  ]));
  return Object.freeze({
    connectionId,
    generation: dataset.generation,
    capabilities,
    reviews,
    actions,
    journal: practice.journal,
    guards: practice.guards,
    reports: dataset.reports,
    reviewVersions: Object.freeze(reviewVersions),
    actionVersions: Object.freeze(actionVersions),
    actionBindings: Object.freeze(actionBindings),
    journalVersions: Object.freeze(journalVersions),
    riskVersions: Object.freeze(riskVersions),
    reportVersions: Object.freeze(reportVersions),
  });
}

function cloudAnalyticsBoundaryReason(dataset: CloudDatasetV1): string | null {
  const settlementAssets = new Set(
    dataset.tradeModels.map((model) => model.payload.realizedPnlAsset),
  );
  if (settlementAssets.size > 1) return 'CLOUD_MULTI_SETTLEMENT_ANALYTICS_UNAVAILABLE';
  for (const model of dataset.tradeModels) {
    if (model.payload.commissionByAsset.some((entry) => (
      entry.asset !== model.payload.realizedPnlAsset && entry.amount !== '0'
    ))) return 'CLOUD_CROSS_ASSET_ANALYTICS_UNAVAILABLE';
  }
  return null;
}

function effectiveCloudCapabilities(
  dataset: CloudDatasetV1,
  analyticsBoundaryReason: string | null,
): CloudDatasetV1['capabilities'] {
  if (analyticsBoundaryReason === null) return dataset.capabilities;
  return Object.freeze(Object.fromEntries(Object.entries(dataset.capabilities).map(([name, value]) => [
    name,
    name === 'recordsBrowsable'
      ? value
      : Object.freeze({
        decision: 'DENY' as const,
        reasonCodes: Object.freeze([...new Set([
          ...value.reasonCodes,
          analyticsBoundaryReason,
        ])].sort()),
      }),
  ]))) as CloudDatasetV1['capabilities'];
}

function cloudProjection(
  identity: CloudAuthIdentity,
  status: CloudConnectionStatus,
  dataset: CloudDatasetV1,
  capabilities: CloudDatasetV1['capabilities'],
): Readonly<{ runtime: RuntimeSnapshotDto; bundle: BundleSnapshotDto }> {
  const connection = status.connection;
  const connected = !['PENDING', 'DISCONNECTED', 'ERROR'].includes(connection.status);
  const canSync = connected && connection.status !== 'SYNCING';
  const localScope = `rv1_${cloudReviewScope(identity.userId).slice('binance-rv1-'.length)}`;
  const records = Object.freeze(dataset.trades.map((trade) => Object.freeze({ ...trade })));
  const coverage = Object.freeze(Object.fromEntries(
    Object.entries(dataset.coverage).map(([name, value]) => [name, coverageLabel(value.state)]),
  ));
  const symbols = Object.freeze([...new Set(records.map((record) => record.symbol))].sort());
  const reasonCodes = new Set<string>(dataset.reconciliation.reasonCodes);
  for (const capability of Object.values(capabilities)) {
    for (const reason of capability.reasonCodes) reasonCodes.add(reason);
  }
  const allVerified = Object.values(dataset.coverage).every((entry) => entry.state === 'VERIFIED');
  const dataStatus = dataset.reconciliation.status === 'PASS' && allVerified
    ? 'CURRENT'
    : dataset.reconciliation.status;
  const qualityStatus = dataset.reconciliation.status === 'PASS'
    ? 'VALID'
    : dataset.reconciliation.status;
  const failedWindows = Object.values(dataset.coverage)
    .reduce((total, entry) => total + entry.gaps.length, 0);
  const updatedAt = Date.parse(dataset.asOf);
  const runtime: RuntimeSnapshotDto = Object.freeze({
    protocol: 'rv-cloud-runtime/1',
    phase: connection.status,
    updatedAt,
    rows: records.length,
    failedWindows,
    cooldownUntil: 0,
    reviewScope: localScope,
    sync: Object.freeze({
      state: connection.status === 'SYNCING' ? 'RUNNING' : 'IDLE',
      phase: connection.status,
      startedAt: null,
      updatedAt,
      fills: records.length,
      reasonCodes: Object.freeze([...reasonCodes].sort()),
    }),
    binance: Object.freeze({ connected, state: connection.status, canSync }),
  });
  const bundle: BundleSnapshotDto = Object.freeze({
    updatedAt,
    reviewScope: localScope,
    fills: records,
    income: Object.freeze([]),
    orders: Object.freeze([]),
    symbols,
    done: Object.freeze([]),
    coverage,
    reconciliation: dataset.reconciliation,
    _meta: Object.freeze({
      dataStatus,
      connected,
      canSync,
      syncState: runtime.sync.state,
      quality: Object.freeze({
        status: qualityStatus,
        accountScope: 'BOUND',
        capabilities,
        reasonCodes: Object.freeze([...reasonCodes].sort()),
      }),
      legacyMigrationAvailable: false,
    }),
  });
  return Object.freeze({ runtime, bundle });
}

export function safeRuntimeError(error: unknown): string {
  if (error instanceof RuntimeClientError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code ?? '');
    if (/^[A-Z][A-Z0-9_:-]{0,127}$/.test(code)) return code;
  }
  return 'LOCAL_RUNTIME_UNAVAILABLE';
}

async function loadLocalBinanceSnapshot(): Promise<BinanceSnapshot> {
  const api = runtimeClient();
  const [statusRaw, bundleRaw] = await Promise.all([
    api.get('/local/status'),
    api.get('/local/bundle'),
  ]);
  const runtime = normalizeRuntimeStatusV1(statusRaw) as unknown as RuntimeSnapshotDto;
  const bundle = normalizeBundleResponseV1(bundleRaw) as unknown as BundleSnapshotDto;
  const reviewScope = resolveSnapshotReviewScope(runtime, bundle);
  const access = resolveBinanceAccess(bundle);
  let trades: readonly EnrichedTrade[] = [];
  if (access.showObservedAnalytics) {
    const paired = bundleToTrades(bundle);
    if (paired.error !== undefined) {
      throw Object.assign(new Error('Bundle pairing failed'), { code: 'BINANCE_PAIRING_FAILED' });
    }
    trades = enrichTrades([...paired.trades]);
  }
  return Object.freeze({
    runtime,
    bundle,
    records: bundle.fills,
    trades,
    access,
    reviewScope,
    cloudWorkspace: null,
  });
}

async function loadCloudBinanceSnapshot(options: BinanceSourceOptions): Promise<BinanceSnapshot> {
  const { api, identity } = cloudSession(options);
  const listed = await api.listConnections();
  const connection = chooseConnection(listed);
  const [status, dataset] = await Promise.all([
    api.getConnectionStatus(connection.connectionId),
    api.getCurrentDataset(connection.connectionId),
  ]);
  if (status.connection.connectionId !== connection.connectionId) {
    throw runtimeFailure('CLOUD_CONNECTION_MISMATCH');
  }
  const analyticsBoundaryReason = cloudAnalyticsBoundaryReason(dataset);
  const capabilities = effectiveCloudCapabilities(dataset, analyticsBoundaryReason);
  const { runtime, bundle } = cloudProjection(
    identity,
    status,
    dataset,
    capabilities,
  );
  const reviewScope = resolveSnapshotReviewScope(runtime, bundle);
  const access = resolveBinanceAccess(bundle);
  let trades: readonly EnrichedTrade[] = [];
  if (access.showRecords) {
    trades = enrichTrades(dataset.tradeModels.map((model) => {
      const settlementCommission = model.payload.commissionByAsset.find(
        (entry) => entry.asset === model.payload.realizedPnlAsset,
      )?.amount ?? '0';
      // A published lifecycle remains reviewable when reconciliation, Ledger,
      // or cross-asset analytics are locked. Outcome fields are deliberately
      // neutral in that browse-only adapter so hidden downstream calculations
      // cannot accidentally turn unverified values into a KPI or report.
      const fee = access.showObservedAnalytics ? finiteCloudNumber(settlementCommission) : 0;
      return {
        id: model.tradeId,
        symbol: model.payload.symbol,
        side: model.payload.side,
        positionSide: model.payload.positionSide,
        entryTime: model.payload.entryTime,
        exitTime: model.payload.exitTime,
        entryPrice: finiteCloudNumber(model.payload.entryPrice),
        exitPrice: finiteCloudNumber(model.payload.exitPrice),
        qty: finiteCloudNumber(model.payload.qty),
        notional: finiteCloudNumber(model.payload.notional),
        fee,
        pnl: access.showObservedAnalytics
          ? subtractCloudDecimal(model.payload.realizedPnl, settlementCommission)
          : 0,
        pnlSelfCalc: false,
        plannedRisk: null,
        tags: [],
        emotion: '',
        note: '',
        setup: '',
        plan: {},
        market: 'crypto_perp',
        currency: model.payload.realizedPnlAsset,
        source: 'binance',
      };
    })) as EnrichedTrade[];
  }
  return Object.freeze({
    runtime,
    bundle,
    records: bundle.fills,
    trades,
    access,
    reviewScope,
    cloudWorkspace: cloudWorkspace(connection.connectionId, dataset, capabilities),
  });
}

export async function listCloudBinanceConnections(
  options: BinanceSourceOptions = {},
): Promise<CloudConnections> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.listConnections();
}

export async function disconnectCloudBinanceConnection(
  connectionId: string,
  options: BinanceSourceOptions = {},
): Promise<CloudDisconnectReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  const receipt = await cloudSession(options).api.disconnectConnection(connectionId);
  if (selectedCloudConnectionId === connectionId) selectedCloudConnectionId = null;
  return receipt;
}

export async function recoverCloudRestoredOwner(
  restoreId: string,
  options: BinanceSourceOptions = {},
): Promise<CloudOwnerRecoveryReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.recoverRestoredOwner(restoreId);
}

export async function upsertCloudTradeReview(
  connectionId: string,
  tradeId: string,
  expectedVersion: number,
  payload: CloudReviewPayload,
  options: BinanceSourceOptions = {},
): Promise<CloudReviewReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.upsertReview(connectionId, tradeId, {
    expectedVersion,
    idempotencyKey: idempotencyKey(),
    payload,
  });
}

export async function updateCloudAction(
  connectionId: string,
  actionId: string,
  input: Omit<CloudActionMutation, 'idempotencyKey'>,
  options: BinanceSourceOptions = {},
): Promise<CloudMutationReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.updateAction(connectionId, actionId, {
    ...input,
    idempotencyKey: idempotencyKey(),
  });
}

export async function upsertCloudJournal(
  connectionId: string,
  day: string,
  expectedVersion: number,
  payload: Readonly<{ note: string; emotion: string }>,
  options: BinanceSourceOptions = {},
): Promise<CloudMutationReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.upsertJournal(connectionId, day, {
    expectedVersion,
    idempotencyKey: idempotencyKey(),
    payload,
  });
}

export async function upsertCloudRiskRule(
  connectionId: string,
  ruleId: string,
  input: Omit<CloudRiskMutation, 'idempotencyKey'>,
  options: BinanceSourceOptions = {},
): Promise<CloudMutationReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.upsertRiskRule(connectionId, ruleId, {
    ...input,
    idempotencyKey: idempotencyKey(),
  });
}

export async function upsertCloudReport(
  connectionId: string,
  input: Omit<CloudReportMutation, 'idempotencyKey'>,
  options: BinanceSourceOptions = {},
): Promise<CloudMutationReceipt> {
  if (resolveBinanceSourceMode(options) !== 'invite-beta') {
    throw runtimeFailure('RUNTIME_UNAVAILABLE');
  }
  return cloudSession(options).api.upsertReport(connectionId, {
    ...input,
    idempotencyKey: idempotencyKey(),
  });
}

export async function loadBinanceSnapshot(
  options: BinanceSourceOptions = {},
): Promise<BinanceSnapshot> {
  const mode = resolveBinanceSourceMode(options);
  if (mode === 'local-runtime') return loadLocalBinanceSnapshot();
  if (mode === 'invite-beta') return loadCloudBinanceSnapshot(options);
  throw runtimeFailure('RUNTIME_UNAVAILABLE');
}

function idempotencyKey(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw runtimeFailure('CRYPTO_UNAVAILABLE');
  }
  return crypto.randomUUID();
}

export async function startBinanceSync(
  options: BinanceSourceOptions = {},
): Promise<SyncStartResult> {
  const mode = resolveBinanceSourceMode(options);
  if (mode === 'local-runtime') {
    const result = await runtimeClient().post('/local/sync-recent', {});
    return normalizeSyncRecentV1(result) as SyncStartResult;
  }
  if (mode !== 'invite-beta') throw runtimeFailure('RUNTIME_UNAVAILABLE');
  const { api } = cloudSession(options);
  const connection = chooseConnection(await api.listConnections());
  await api.queueSync(connection.connectionId, idempotencyKey());
  return Object.freeze({ state: 'STARTED', reasonCodes: Object.freeze([]) });
}

export async function storeBinanceCredentials(
  apiKey: string,
  apiSecret: string,
  options: BinanceSourceOptions = {},
): Promise<void> {
  const mode = resolveBinanceSourceMode(options);
  if (mode === 'local-runtime') {
    await runtimeClient().request('/local/credentials/binance', {
      method: 'PUT',
      json: { apiKey, apiSecret },
    });
    return;
  }
  if (mode !== 'invite-beta') throw runtimeFailure('RUNTIME_UNAVAILABLE');
  const { api } = cloudSession(options);
  const exactInput: CloudCredentialInput = Object.freeze({
    apiKey,
    apiSecret,
    consentVersion: BINANCE_BETA_CONSENT_VERSION,
    idempotencyKey: idempotencyKey(),
  });
  const listed = await api.listConnections();
  let result: CloudConnectionMutation;
  if (listed.connections.length === 0) result = await api.createConnection(exactInput);
  else result = await api.rotateConnection(chooseConnection(listed).connectionId, exactInput);
  selectedCloudConnectionId = result.connectionId;
}
