import * as engine from '@rv/engine';
import type {
  BinanceUsdmCsvExecutionOrderEvidence,
  CanonicalTrade,
  DiagnosticItem,
  EnrichedTrade,
  ImportMeta,
  ResultContract,
  SourceCapabilityValues,
  SourceId,
  SourceTimePrecision,
} from '@rv/engine';
import { canonicalJson } from './canonical-json';
import { MAX_FUPAN_FILE_BYTES } from './import-file-limits';
import { sha256Hex } from './vault-signing';

const LEDGER_VERSION = 'rv-csv-fill-ledger/1' as const;
const ARCHIVE_EXTENSION_KEY = 'rvFillLedger' as const;
const MAX_BATCH_FILLS = 10_000;
const MAX_LEDGER_FILLS = 200_000;
const MAX_LEDGER_ROWS = 400_000;
const MAX_LEDGER_BATCHES = 4_000;
const MAX_CANONICAL_BATCH_BYTES = 8 * 1024 * 1024;
// A ledger is embedded in a .fupan archive whose hard input limit is 12 MiB.
// Reserve 2 MiB for the archive shell and its materialized review data; this
// independent cap prevents a ledger from becoming structurally unrecoverable.
export const MAX_LEDGER_CANONICAL_BYTES = MAX_FUPAN_FILE_BYTES - (2 * 1024 * 1024);
const MAX_SCOPE_CHARS = 128;
const MAX_ID_CHARS = 128;
const MAX_DIAGNOSTICS = 20_000;
const HEX_64 = /^[0-9a-f]{64}$/;
const BINANCE_USDM_EXECUTION_ORDER_EVIDENCE: BinanceUsdmCsvExecutionOrderEvidence = Object.freeze({
  version: 'rv-binance-usdm-csv-execution-order/1',
  adapterId: 'builtin/binance-usdm-futures-csv/1',
  headerSchema: 'date(utc)|symbol|side|price|quantity|fee|realized profit|trade id',
});
const BOOLEAN_CAPABILITIES = [
  'fills', 'orders', 'pnlReported', 'fees', 'income', 'ledger', 'klines',
] as const;
const TIME_PRECISIONS: readonly SourceTimePrecision[] = ['unknown', 'ms', 'minute', 'day', 'mixed'];
const SOURCE_IDS: readonly SourceId[] = [
  'unknown', 'fupan-archive', 'binance', 'local-engine', 'binance-export',
  'csv-report', 'generic-sniffed', 'manual-map', 'csv-trades', 'manual', 'synthetic-demo',
];
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type BooleanCapability = typeof BOOLEAN_CAPABILITIES[number];

export type CsvFillInput = Readonly<{
  providerTradeId?: string | number | null;
  tradeId?: string | number | null;
  orderId?: string | number | null;
  id?: string | number | null;
  time: number;
  symbol: string;
  side: 'BUY' | 'SELL' | string;
  positionSide?: 'BOTH' | 'LONG' | 'SHORT' | string | null;
  price: number | string;
  qty: number | string;
  fee?: number | string | null;
  feeAsset?: string | null;
  pnl?: number | string | null;
}>;

export type CsvImportEvidence = SourceCapabilityValues & Readonly<{
  dropped: number;
  accepted?: number;
  source?: SourceId;
  adapterId?: string;
  /** A strict parser-issued marker, never inferred from Fee/PnL or source name. */
  executionOrderEvidence?: BinanceUsdmCsvExecutionOrderEvidence;
  diagnostics?: readonly DiagnosticItem[];
}>;

export type CsvImportBatch = Readonly<{
  fills: readonly CsvFillInput[];
  evidence?: CsvImportEvidence;
  contract?: ResultContract;
  diagnostics?: readonly DiagnosticItem[];
  meta?: ImportMeta;
}>;

export type CsvLedgerFill = Readonly<{
  providerTradeId: string | null;
  orderId: string | null;
  time: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  price: number;
  qty: number;
  fee: number;
  feeAsset: 'USDT' | null;
  pnl: number | null;
  batchDigest: string;
  rowIndex: number;
  sourceRef: string;
}>;

type CsvBookInterval = Readonly<{
  book: string;
  minTime: number;
  maxTime: number;
}>;

export type CsvLedgerBatch = Readonly<{
  digest: string;
  hasUnidentifiedFills: boolean;
  rowCount: number;
  rows: readonly NormalizedInputFill[];
  rowPlan: readonly (number | string)[];
  intervals: readonly CsvBookInterval[];
  evidence: CsvImportEvidence;
}>;

export type CsvFillLedger = Readonly<{
  version: typeof LEDGER_VERSION;
  accountScope: string;
  scopeDigest: string;
  fills: readonly CsvLedgerFill[];
  batches: readonly CsvLedgerBatch[];
  evidence: CsvImportEvidence;
}>;

export type CsvLedgerReplay = Readonly<{
  trades: readonly EnrichedTrade[];
  openPositions: number;
  meta: ImportMeta;
  diagnostics: readonly DiagnosticItem[];
  contract: ResultContract;
}>;

export type CsvLedgerMergeResult = CsvLedgerReplay & Readonly<{
  ledger: CsvFillLedger;
  addedFills: number;
  duplicateBatch: boolean;
}>;

export class CsvFillLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CsvFillLedgerError';
  }
}

function fail(code: string): never {
  throw new CsvFillLedgerError(code);
}
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).some((symbol) => (
    Object.prototype.propertyIsEnumerable.call(value, symbol)
  ))) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    'value' in descriptor
  ));
};

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_FILL');
  return value;
}

function positiveNumber(value: unknown): number {
  const normalized = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized <= 0) fail('INVALID_FILL');
  return Object.is(normalized, -0) ? 0 : normalized;
}

function optionalFinite(value: unknown, fallback: number | null): number | null {
  if (value == null || value === '') return fallback;
  const normalized = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) fail('INVALID_FILL');
  return Object.is(normalized, -0) ? 0 : normalized;
}

function optionalId(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') fail('INVALID_FILL');
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) fail('INVALID_FILL');
  const result = String(value).trim();
  if (!result || result.length > MAX_ID_CHARS || /[\u0000-\u001f\u007f]/.test(result)) fail('RESOURCE_LIMIT');
  return result;
}

export type NormalizedCsvFill = Omit<CsvLedgerFill, 'batchDigest' | 'rowIndex' | 'sourceRef'>;
type NormalizedInputFill = NormalizedCsvFill;

function normalizeInputFill(input: unknown): NormalizedInputFill {
  if (!isPlainObject(input)) fail('INVALID_FILL');
  const symbol = typeof input.symbol === 'string'
    ? input.symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
  if (!symbol || symbol.length > 32) fail('INVALID_FILL');
  const side = input.side === 'BUY' || input.side === 'SELL' ? input.side : fail('INVALID_FILL');
  const positionSide = input.positionSide == null || input.positionSide === ''
    ? 'BOTH'
    : String(input.positionSide).trim().toUpperCase();
  if (positionSide !== 'BOTH' && positionSide !== 'LONG' && positionSide !== 'SHORT') fail('INVALID_FILL');
  const fee = optionalFinite(input.fee, 0);
  if (fee == null || fee < 0) fail('INVALID_FILL');
  const pnl = optionalFinite(input.pnl, null);
  const feeAssetText = input.feeAsset == null || input.feeAsset === ''
    ? null : String(input.feeAsset).trim().toUpperCase();
  if (feeAssetText !== null && feeAssetText !== 'USDT') fail('INVALID_FILL');
  const providerTradeId = optionalId(
    input.providerTradeId == null || input.providerTradeId === ''
      ? input.tradeId
      : input.providerTradeId,
  );
  return {
    // Generic engine `id` may be a per-file auto counter. It is never stable
    // enough to authorize cross-batch deduplication.
    providerTradeId,
    orderId: optionalId(input.orderId),
    time: (() => {
      const time = safeInteger(input.time);
      if (!Number.isFinite(new Date(time).getTime())) fail('INVALID_FILL');
      return time;
    })(),
    symbol,
    side,
    positionSide,
    price: positiveNumber(input.price),
    qty: positiveNumber(input.qty),
    fee,
    feeAsset: feeAssetText,
    pnl,
  };
}

function canonicalDecimalId(value: string): string {
  return value.replace(/^0+(?=\d)/, '') || '0';
}

function compareCanonicalDecimals(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

function hasDecimalExecutionId(fill: Pick<CsvLedgerFill, 'providerTradeId'> | NormalizedInputFill): boolean {
  return fill.providerTradeId !== null && /^\d+$/.test(fill.providerTradeId);
}

function safeDiagnostic(input: unknown): DiagnosticItem {
  if (!isPlainObject(input)) fail('INVALID_EVIDENCE');
  const index = input.index === null ? null : safeInteger(input.index);
  const code = typeof input.code === 'string'
    && /^[a-z_]{1,64}$/.test(input.code)
    && !DANGEROUS_RECORD_KEYS.has(input.code)
    ? input.code : fail('INVALID_EVIDENCE');
  const field = typeof input.field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.field)
    ? input.field : fail('INVALID_EVIDENCE');
  const severity = input.severity === 'error' || input.severity === 'warning' || input.severity === 'info'
    ? input.severity : fail('INVALID_EVIDENCE');
  return { index, code: code as DiagnosticItem['code'], field, severity };
}

function normalizeEvidence(input: unknown): CsvImportEvidence {
  if (!isPlainObject(input)) fail('INVALID_EVIDENCE');
  const result = {} as Record<BooleanCapability, boolean>;
  for (const key of BOOLEAN_CAPABILITIES) {
    if (typeof input[key] !== 'boolean') fail('INVALID_EVIDENCE');
    result[key] = input[key];
  }
  const timePrecision = TIME_PRECISIONS.includes(input.timePrecision as SourceTimePrecision)
    ? input.timePrecision as SourceTimePrecision : fail('INVALID_EVIDENCE');
  const dropped = safeInteger(input.dropped);
  const accepted = input.accepted == null ? undefined : safeInteger(input.accepted);
  const source = SOURCE_IDS.includes(input.source as SourceId) ? input.source as SourceId : 'csv-report';
  const adapterId = typeof input.adapterId === 'string' && /^[A-Za-z0-9._/-]{1,128}$/.test(input.adapterId)
    ? input.adapterId : 'builtin/csv-fill-ledger';
  const diagnosticsInput = input.diagnostics == null ? [] : input.diagnostics;
  if (!Array.isArray(diagnosticsInput) || diagnosticsInput.length > MAX_DIAGNOSTICS) fail('RESOURCE_LIMIT');
  const marker = input.executionOrderEvidence;
  const trustedExecutionOrder = source === 'binance-export'
    && adapterId === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.adapterId
    && isPlainObject(marker)
    && marker.version === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.version
    && marker.adapterId === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.adapterId
    && marker.headerSchema === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.headerSchema;
  return {
    ...result,
    timePrecision,
    dropped,
    ...(accepted === undefined ? {} : { accepted }),
    source,
    adapterId,
    ...(trustedExecutionOrder ? { executionOrderEvidence: BINANCE_USDM_EXECUTION_ORDER_EVIDENCE } : {}),
    diagnostics: diagnosticsInput.map(safeDiagnostic),
  };
}

function hasTrustedBinanceExecutionOrder(evidence: CsvImportEvidence): boolean {
  const marker = evidence.executionOrderEvidence;
  return evidence.source === 'binance-export'
    && evidence.adapterId === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.adapterId
    && marker?.version === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.version
    && marker.adapterId === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.adapterId
    && marker.headerSchema === BINANCE_USDM_EXECUTION_ORDER_EVIDENCE.headerSchema;
}

function evidenceFromBatch(batch: CsvImportBatch): CsvImportEvidence {
  if (batch.evidence) return normalizeEvidence({
    ...batch.evidence,
    diagnostics: batch.diagnostics ?? batch.evidence.diagnostics,
  });
  const contract = batch.contract;
  if (!contract) fail('INVALID_EVIDENCE');
  const values = contract.capabilities?.values;
  const coverage = contract.provenance?.coverage;
  return normalizeEvidence({
    ...values,
    dropped: batch.meta?.dropped ?? coverage?.dropped,
    accepted: coverage?.accepted,
    source: contract.provenance?.source,
    adapterId: contract.provenance?.adapterId,
    executionOrderEvidence: contract.provenance?.executionOrderEvidence,
    diagnostics: batch.diagnostics ?? contract.diagnostics?.items ?? [],
  });
}

function assertCompleteBatch(evidence: CsvImportEvidence): void {
  if (evidence.dropped > 0 || (evidence.diagnostics ?? []).some((item) => item.severity === 'error')) {
    fail('BATCH_INCOMPLETE');
  }
}

function aggregateEvidence(items: readonly CsvImportEvidence[]): CsvImportEvidence {
  if (!items.length) fail('INVALID_EVIDENCE');
  const booleans = {} as Record<BooleanCapability, boolean>;
  for (const key of BOOLEAN_CAPABILITIES) booleans[key] = items.every((item) => item[key] === true);
  const precisions = new Set(items.map((item) => item.timePrecision));
  const timePrecision = precisions.size === 1 ? items[0].timePrecision : 'mixed';
  const diagnostics = items.flatMap((item) => item.diagnostics ?? []);
  if (diagnostics.length > MAX_DIAGNOSTICS) fail('RESOURCE_LIMIT');
  return normalizeEvidence({
    ...booleans,
    timePrecision,
    dropped: items.reduce((sum, item) => sum + item.dropped, 0),
    accepted: items.reduce((sum, item) => sum + (item.accepted ?? 0), 0),
    source: items.every((item) => item.source === items[0].source) ? items[0].source : 'csv-report',
    adapterId: 'builtin/csv-fill-ledger',
    diagnostics,
  });
}

function mergeSameBatchEvidence(left: CsvImportEvidence, right: CsvImportEvidence): CsvImportEvidence {
  const booleans = {} as Record<BooleanCapability, boolean>;
  for (const key of BOOLEAN_CAPABILITIES) booleans[key] = left[key] && right[key];
  return normalizeEvidence({
    ...booleans,
    timePrecision: left.timePrecision === right.timePrecision ? left.timePrecision : 'mixed',
    dropped: Math.max(left.dropped, right.dropped),
    accepted: Math.max(left.accepted ?? 0, right.accepted ?? 0),
    source: left.source === right.source ? left.source : 'csv-report',
    adapterId: left.adapterId === right.adapterId ? left.adapterId : 'builtin/csv-fill-ledger',
    ...(hasTrustedBinanceExecutionOrder(left) && hasTrustedBinanceExecutionOrder(right)
      ? { executionOrderEvidence: BINANCE_USDM_EXECUTION_ORDER_EVIDENCE }
      : {}),
    diagnostics: (left.diagnostics?.length ?? 0) >= (right.diagnostics?.length ?? 0)
      ? left.diagnostics : right.diagnostics,
  });
}

function fillDigestShape(fill: NormalizedInputFill): Record<string, unknown> {
  return {
    providerTradeId: fill.providerTradeId,
    orderId: fill.orderId,
    time: fill.time,
    symbol: fill.symbol,
    side: fill.side,
    positionSide: fill.positionSide,
    price: fill.price,
    qty: fill.qty,
    fee: fill.fee,
    feeAsset: fill.feeAsset,
    pnl: fill.pnl,
  };
}

function providerContent(fill: Pick<CsvLedgerFill,
  'providerTradeId' | 'orderId' | 'time' | 'symbol' | 'side' | 'positionSide' | 'price' | 'qty' | 'fee' | 'feeAsset' | 'pnl'>): string {
  return canonicalJson(fillDigestShape(fill));
}

function providerKey(fill: Pick<CsvLedgerFill, 'symbol' | 'providerTradeId'>): string {
  if (!fill.providerTradeId) fail('INVALID_FILL');
  return `${fill.symbol}\u0000${fill.providerTradeId}`;
}

function intervalsOf(fills: readonly NormalizedInputFill[]): readonly CsvBookInterval[] {
  const books = new Map<string, { minTime: number; maxTime: number }>();
  for (const fill of fills) {
    const book = `${fill.symbol}\u0000${fill.positionSide}`;
    const current = books.get(book);
    if (!current) books.set(book, { minTime: fill.time, maxTime: fill.time });
    else {
      current.minTime = Math.min(current.minTime, fill.time);
      current.maxTime = Math.max(current.maxTime, fill.time);
    }
  }
  return [...books.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([book, range]) => ({ book, ...range }));
}

function intervalsOverlap(left: readonly CsvBookInterval[], right: readonly CsvBookInterval[]): boolean {
  const byBook = new Map(left.map((item) => [item.book, item]));
  return right.some((item) => {
    const other = byBook.get(item.book);
    return other != null && item.minTime <= other.maxTime && other.minTime <= item.maxTime;
  });
}

async function digestText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

async function digestTextsBounded(texts: readonly string[]): Promise<string[]> {
  const digests = new Array<string>(texts.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(32, texts.length) }, async () => {
    while (cursor < texts.length) {
      const index = cursor++;
      digests[index] = await digestText(texts[index]);
    }
  });
  await Promise.all(workers);
  return digests;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function assertLedgerByteBudget(ledger: CsvFillLedger): void {
  if (byteLength(ledger) > MAX_LEDGER_CANONICAL_BYTES) fail('RESOURCE_LIMIT');
}

function placeholderSourceRef(scopeDigest: string): string {
  return `rvf:${scopeDigest.slice(0, 16)}:${'0'.repeat(32)}`;
}

function canonicalStoredFills(fills: readonly CsvLedgerFill[]): CsvLedgerFill[] {
  return [...fills].sort((left, right) => (
    left.time - right.time
    || left.symbol.localeCompare(right.symbol)
    || left.positionSide.localeCompare(right.positionSide)
    || left.sourceRef.localeCompare(right.sourceRef)
  ));
}

function executionOrderedFills(ledger: CsvFillLedger): CsvLedgerFill[] {
  const batchOrder = new Map(ledger.batches.map((batch, index) => [batch.digest, index]));
  const batchByDigest = new Map(ledger.batches.map((batch) => [batch.digest, batch]));
  const groups = new Map<string, CsvLedgerFill[]>();
  for (const fill of ledger.fills) {
    const key = `${fill.time}\u0000${fill.symbol}\u0000${fill.positionSide}`;
    const group = groups.get(key);
    if (group) group.push(fill);
    else groups.set(key, [fill]);
  }
  const orderedGroups = [...groups.values()].sort((left, right) => (
    left[0].time - right[0].time
    || left[0].symbol.localeCompare(right[0].symbol)
    || left[0].positionSide.localeCompare(right[0].positionSide)
  ));
  return orderedGroups.flatMap((group) => {
    const batches = new Set(group.map((fill) => fill.batchDigest));
    const trustedDecimal = group.every((fill) => {
      const batchEvidence = batchByDigest.get(fill.batchDigest)?.evidence;
      return hasDecimalExecutionId(fill)
        && batchEvidence !== undefined
        && hasTrustedBinanceExecutionOrder(batchEvidence);
    });
    const decimalKeys = trustedDecimal
      ? group.map((fill) => canonicalDecimalId(fill.providerTradeId!))
      : [];
    const uniqueDecimalOrder = trustedDecimal && new Set(decimalKeys).size === decimalKeys.length;
    if (batches.size > 1 && !uniqueDecimalOrder) fail('AMBIGUOUS_EXECUTION_ORDER');
    if (uniqueDecimalOrder) {
      return [...group].sort((left, right) => (
        compareCanonicalDecimals(
          canonicalDecimalId(left.providerTradeId!),
          canonicalDecimalId(right.providerTradeId!),
        )
        || (batchOrder.get(left.batchDigest) ?? 0) - (batchOrder.get(right.batchDigest) ?? 0)
        || left.rowIndex - right.rowIndex
      ));
    }
    return [...group].sort((left, right) => left.rowIndex - right.rowIndex);
  });
}

function canonicalTradeCore(trade: CanonicalTrade): string {
  return canonicalJson({
    id: trade.id, symbol: trade.symbol, side: trade.side,
    entryTime: trade.entryTime, exitTime: trade.exitTime,
    entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    qty: trade.qty, notional: trade.notional ?? null,
    fee: trade.fee, pnl: trade.pnl, currency: trade.currency,
    pnlSelfCalc: trade.pnlSelfCalc ?? null,
  });
}

function assertHistoricalSubset(current: readonly CanonicalTrade[], historical: readonly CanonicalTrade[]): void {
  const currentById = new Map(current.map((trade) => [trade.id, canonicalTradeCore(trade)]));
  for (const trade of historical) {
    if (currentById.get(trade.id) !== canonicalTradeCore(trade)) fail('HISTORICAL_REPLAY_CONFLICT');
  }
}

function contractFor(
  trades: readonly EnrichedTrade[],
  evidence: CsvImportEvidence,
): ResultContract {
  const diagnostics = evidence.diagnostics ?? [];
  // Map-based accumulation cannot consult or mutate Object.prototype even if
  // an upstream diagnostic-code allowlist regresses later.
  const diagnosticCounts = new Map<string, number>();
  for (const item of diagnostics) {
    diagnosticCounts.set(item.code, (diagnosticCounts.get(item.code) ?? 0) + 1);
  }
  const classifiedCount = [...diagnosticCounts.values()].reduce((sum, count) => sum + count, 0);
  if (classifiedCount !== diagnostics.length) fail('INVALID_EVIDENCE');
  const countsByCode = Object.fromEntries(
    [...diagnosticCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const values: SourceCapabilityValues = Object.freeze({
    fills: evidence.fills,
    orders: evidence.orders,
    pnlReported: evidence.pnlReported,
    fees: evidence.fees,
    income: evidence.income,
    ledger: evidence.ledger,
    klines: evidence.klines,
    timePrecision: evidence.timePrecision,
  });
  const fieldOrigins = Object.fromEntries([
    'id', 'symbol', 'side', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice',
    'qty', 'notional', 'fee', 'pnl', 'currency',
  ].map((field) => [field, field === 'symbol' ? 'observed' : 'derived'])) as ResultContract['provenance']['fieldOrigins'];
  return {
    version: 'rv-result/1',
    canonical: { version: 'rv-canonical-trade/1', recordType: 'trade', count: trades.length },
    provenance: {
      version: 'rv-provenance/1',
      source: evidence.source ?? 'csv-report',
      adapterId: 'builtin/csv-fill-ledger',
      fieldOrigins,
      coverage: {
        status: evidence.dropped > 0 ? (trades.length ? 'partial' : 'blocked') : 'complete',
        accepted: trades.length,
        dropped: evidence.dropped,
      },
    },
    capabilities: {
      version: 'rv-capabilities/1',
      sources: [evidence.source ?? 'csv-report'],
      values,
      unavailable: BOOLEAN_CAPABILITIES.filter((key) => !values[key]),
    },
    diagnostics: {
      version: 'rv-diagnostics/1',
      count: diagnostics.length,
      countsByCode,
      items: diagnostics,
    },
  };
}

const engineWithPairing = engine as unknown as {
  pairFills(fills: readonly CsvLedgerFill[]): { trades: CanonicalTrade[]; openPositions: number };
  enrichTrades<T extends CanonicalTrade>(trades: T[]): Array<T & EnrichedTrade>;
};

export function replayCsvFillLedger(
  ledgerInput: CsvFillLedger,
  options: Readonly<{ historicalTrades?: readonly CanonicalTrade[] }> = {},
): CsvLedgerReplay {
  const ledger = normalizeCsvFillLedger(ledgerInput);
  const paired = engineWithPairing.pairFills(executionOrderedFills(ledger));
  const source = ledger.evidence.source ?? 'csv-report';
  const trades = engine.enrichTrades(paired.trades.map((trade) => ({ ...trade, source })));
  if (options.historicalTrades) assertHistoricalSubset(trades, options.historicalTrades);
  const diagnostics = ledger.evidence.diagnostics ?? [];
  const meta: ImportMeta = {
    source: ledger.evidence.source ?? 'csv-report',
    fills: ledger.fills.length,
    badRows: ledger.evidence.dropped,
    openPositions: paired.openPositions,
    imported: trades.length,
    dropped: ledger.evidence.dropped,
  };
  return {
    trades,
    openPositions: paired.openPositions,
    meta,
    diagnostics,
    contract: contractFor(trades, ledger.evidence),
  };
}

async function mergeInternal(
  ledgerInput: CsvFillLedger | null,
  accountScopeInput: string | null,
  batch: CsvImportBatch,
  options: Readonly<{ historicalTrades?: readonly CanonicalTrade[] }> = {},
): Promise<CsvLedgerMergeResult> {
  if (!Array.isArray(batch.fills) || batch.fills.length === 0) fail('EMPTY_BATCH');
  if (batch.fills.length > MAX_BATCH_FILLS) fail('RESOURCE_LIMIT');
  const normalized = batch.fills.map(normalizeInputFill);
  const batchText = canonicalJson(normalized.map(fillDigestShape));
  if (new TextEncoder().encode(batchText).byteLength > MAX_CANONICAL_BATCH_BYTES) fail('RESOURCE_LIMIT');
  const digest = await digestText(batchText);
  const evidence = evidenceFromBatch(batch);
  assertCompleteBatch(evidence);
  // A browser-only import has no authenticated account identifier. Its
  // canonical fill digest gives us a deterministic namespace without storing
  // any raw CSV field or user identifier.
  const accountScope = ledgerInput
    ? ledgerInput.accountScope
    : accountScopeInput === null
      ? `csv-content:${digest}`
      : normalizeAccountScope(accountScopeInput);
  const ledger = ledgerInput ? normalizeCsvFillLedger(ledgerInput, accountScope) : null;
  const scopeDigest = ledger?.scopeDigest ?? await digestText(accountScope);
  const existingBatchIndex = ledger?.batches.findIndex((item) => item.digest === digest) ?? -1;

  if (ledger && existingBatchIndex >= 0) {
    const batches = ledger.batches.map((item, index) => index === existingBatchIndex
      ? { ...item, evidence: mergeSameBatchEvidence(item.evidence, evidence) }
      : item);
    const nextLedger = normalizeCsvFillLedger({
      ...ledger,
      batches,
      evidence: aggregateEvidence(batches.map((item) => item.evidence)),
    }, accountScope);
    const replay = replayCsvFillLedger(nextLedger, options);
    return { ledger: nextLedger, ...replay, addedFills: 0, duplicateBatch: true };
  }

  const existingProviders = new Map<string, CsvLedgerFill>();
  for (const fill of ledger?.fills ?? []) {
    if (fill.providerTradeId) existingProviders.set(providerKey(fill), fill);
  }
  const withinBatch = new Map<string, NormalizedInputFill>();
  for (const fill of normalized) {
    if (!fill.providerTradeId) continue;
    const key = providerKey(fill as CsvLedgerFill);
    const prior = existingProviders.get(key) ?? withinBatch.get(key);
    if (prior && providerContent(prior as CsvLedgerFill) !== providerContent(fill as CsvLedgerFill)) {
      fail('PROVIDER_TRADE_ID_CONFLICT');
    }
    if (!prior) withinBatch.set(key, fill);
  }


  if (ledger) {
    const newProviderIds = new Set<string>();
    const executionPoints = new Map<string, { trusted: boolean; decimalKeys: Set<string> }>();
    const existingBatchByDigest = new Map(ledger.batches.map((item) => [item.digest, item]));
    for (const existing of ledger.fills) {
      const point = `${existing.time}\u0000${existing.symbol}\u0000${existing.positionSide}`;
      const current = executionPoints.get(point) ?? { trusted: true, decimalKeys: new Set<string>() };
      const batchEvidence = existingBatchByDigest.get(existing.batchDigest)?.evidence;
      current.trusted = current.trusted
        && batchEvidence !== undefined
        && hasTrustedBinanceExecutionOrder(batchEvidence)
        && hasDecimalExecutionId(existing);
      if (hasDecimalExecutionId(existing)) current.decimalKeys.add(canonicalDecimalId(existing.providerTradeId!));
      executionPoints.set(point, current);
    }
    for (const fill of normalized) {
      if (fill.providerTradeId) {
        const key = providerKey(fill as CsvLedgerFill);
        if (existingProviders.has(key) || newProviderIds.has(key)) continue;
        newProviderIds.add(key);
      }
      const point = `${fill.time}\u0000${fill.symbol}\u0000${fill.positionSide}`;
      const existingPoint = executionPoints.get(point);
      if (existingPoint !== undefined) {
        const newTrusted = hasTrustedBinanceExecutionOrder(evidence) && hasDecimalExecutionId(fill);
        const decimalKey = newTrusted ? canonicalDecimalId(fill.providerTradeId!) : null;
        if (!existingPoint.trusted || !newTrusted || existingPoint.decimalKeys.has(decimalKey!)) {
          fail('AMBIGUOUS_EXECUTION_ORDER');
        }
      }
    }
  }

  const newRows: NormalizedInputFill[] = [];
  const newProviderIndexes = new Map<string, number>();
  const rowPlan: Array<number | string> = [];
  for (const fill of normalized) {
    if (fill.providerTradeId) {
      const key = providerKey(fill as CsvLedgerFill);
      const existing = existingProviders.get(key);
      if (existing) {
        rowPlan.push(existing.sourceRef);
        continue;
      }
      const priorIndex = newProviderIndexes.get(key);
      if (priorIndex !== undefined) {
        rowPlan.push(priorIndex);
        continue;
      }
      newProviderIndexes.set(key, newRows.length);
    }
    rowPlan.push(newRows.length);
    newRows.push(fill);
  }

  if (!newRows.length && ledger) {
    const sourceRefToBatch = new Map(ledger.fills.map((fill) => [fill.sourceRef, fill.batchDigest]));
    const touchedDigests = new Set(rowPlan.map((item) => {
      if (typeof item !== 'string') fail('INVALID_LEDGER');
      return sourceRefToBatch.get(item) ?? fail('INVALID_LEDGER');
    }));
    const batches = ledger.batches.map((item) => touchedDigests.has(item.digest)
      ? { ...item, evidence: mergeSameBatchEvidence(item.evidence, evidence) }
      : item);
    const nextLedger = normalizeCsvFillLedger({
      ...ledger,
      batches,
      evidence: aggregateEvidence(batches.map((item) => item.evidence)),
    }, accountScope);
    const replay = replayCsvFillLedger(nextLedger, options);
    return { ledger: nextLedger, ...replay, addedFills: 0, duplicateBatch: true };
  }

  const intervals = intervalsOf(newRows);
  const hasUnidentifiedFills = newRows.some((fill) => fill.providerTradeId === null);
  if (ledger && ledger.batches.some((existing) => (
    (hasUnidentifiedFills || existing.hasUnidentifiedFills)
    && intervalsOverlap(intervals, existing.intervals)
  ))) fail('AMBIGUOUS_NO_ID_OVERLAP');

  if ((ledger?.fills.length ?? 0) + newRows.length > MAX_LEDGER_FILLS) fail('RESOURCE_LIMIT');
  if ((ledger?.batches.length ?? 0) + 1 > MAX_LEDGER_BATCHES) fail('RESOURCE_LIMIT');
  const batchRecord: CsvLedgerBatch = {
    digest,
    hasUnidentifiedFills,
    rowCount: normalized.length,
    rows: newRows,
    rowPlan,
    intervals,
    evidence,
  };
  const batches = [...(ledger?.batches ?? []), batchRecord];
  // Check the fully materialized archive shape before deriving per-fill
  // identity hashes. The final hash suffix is fixed-width hex, so this
  // placeholder has the exact serialized byte length of the real sourceRef.
  const budgetCandidate: CsvFillLedger = {
    version: LEDGER_VERSION,
    accountScope,
    scopeDigest,
    fills: canonicalStoredFills([
      ...(ledger?.fills ?? []),
      ...newRows.map((fill, rowIndex) => ({
        ...fill,
        batchDigest: digest,
        rowIndex,
        sourceRef: placeholderSourceRef(scopeDigest),
      })),
    ]),
    batches,
    evidence: aggregateEvidence(batches.map((item) => item.evidence)),
  };
  assertLedgerByteBudget(budgetCandidate);

  const identityDigests = await digestTextsBounded(newRows.map((fill, rowIndex) => (
    fill.providerTradeId
      ? `provider:${providerKey(fill as CsvLedgerFill)}`
      : `batch:${digest}:row:${rowIndex}`
  )));
  const additions: CsvLedgerFill[] = newRows.map((fill, rowIndex) => ({
    ...fill,
    batchDigest: digest,
    rowIndex,
    sourceRef: `rvf:${scopeDigest.slice(0, 16)}:${identityDigests[rowIndex].slice(0, 32)}`,
  }));
  const nextLedger = normalizeCsvFillLedger({
    version: LEDGER_VERSION,
    accountScope,
    scopeDigest,
    fills: canonicalStoredFills([...(ledger?.fills ?? []), ...additions]),
    batches,
    evidence: aggregateEvidence(batches.map((item) => item.evidence)),
  }, accountScope);
  const replay = replayCsvFillLedger(nextLedger, options);
  return { ledger: nextLedger, ...replay, addedFills: additions.length, duplicateBatch: false };
}

function normalizeAccountScope(value: unknown): string {
  if (typeof value !== 'string') fail('INVALID_ACCOUNT_SCOPE');
  const scope = value.trim();
  if (!scope || scope.length > MAX_SCOPE_CHARS || /[\u0000-\u001f\u007f]/.test(scope)) fail('INVALID_ACCOUNT_SCOPE');
  return scope;
}

export async function createCsvFillLedger(
  accountScope: string | null,
  batch: CsvImportBatch,
  options: Readonly<{ historicalTrades?: readonly CanonicalTrade[] }> = {},
): Promise<CsvLedgerMergeResult> {
  return mergeInternal(null, accountScope, batch, options);
}

export async function mergeCsvFillBatch(
  ledger: CsvFillLedger,
  batch: CsvImportBatch,
  options: Readonly<{ historicalTrades?: readonly CanonicalTrade[] }> = {},
): Promise<CsvLedgerMergeResult> {
  return mergeInternal(ledger, null, batch, options);
}

function normalizeStoredFill(input: unknown): CsvLedgerFill {
  if (!isPlainObject(input)) fail('INVALID_LEDGER');
  const normalized = normalizeInputFill(input);
  const batchDigest = typeof input.batchDigest === 'string' && HEX_64.test(input.batchDigest)
    ? input.batchDigest : fail('INVALID_LEDGER');
  const rowIndex = safeInteger(input.rowIndex);
  const sourceRef = typeof input.sourceRef === 'string' && /^rvf:[0-9a-f]{16}:[0-9a-f]{32}$/.test(input.sourceRef)
    ? input.sourceRef : fail('INVALID_LEDGER');
  return { ...normalized, batchDigest, rowIndex, sourceRef };
}

function normalizeStoredBatch(input: unknown): CsvLedgerBatch {
  if (!isPlainObject(input)) fail('INVALID_LEDGER');
  const digest = typeof input.digest === 'string' && HEX_64.test(input.digest)
    ? input.digest : fail('INVALID_LEDGER');
  if (typeof input.hasUnidentifiedFills !== 'boolean') fail('INVALID_LEDGER');
  const rowCount = safeInteger(input.rowCount);
  if (!Array.isArray(input.rows) || input.rows.length > rowCount || rowCount > MAX_BATCH_FILLS) {
    fail('INVALID_LEDGER');
  }
  const rows = input.rows.map(normalizeInputFill);
  if (!Array.isArray(input.rowPlan) || input.rowPlan.length !== rowCount) fail('INVALID_LEDGER');
  const referencedNewRows = new Set<number>();
  const rowPlan = input.rowPlan.map((item): number | string => {
    if (typeof item === 'number') {
      const index = safeInteger(item);
      if (index >= rows.length) fail('INVALID_LEDGER');
      referencedNewRows.add(index);
      return index;
    }
    if (typeof item === 'string' && /^rvf:[0-9a-f]{16}:[0-9a-f]{32}$/.test(item)) return item;
    return fail('INVALID_LEDGER');
  });
  if (referencedNewRows.size !== rows.length) fail('INVALID_LEDGER');
  if (!Array.isArray(input.intervals) || input.intervals.length > MAX_BATCH_FILLS) fail('INVALID_LEDGER');
  const intervals = input.intervals.map((item): CsvBookInterval => {
    if (!isPlainObject(item) || typeof item.book !== 'string' || item.book.length > 64) fail('INVALID_LEDGER');
    const minTime = safeInteger(item.minTime);
    const maxTime = safeInteger(item.maxTime);
    if (minTime > maxTime) fail('INVALID_LEDGER');
    return { book: item.book, minTime, maxTime };
  });
  const batch = {
    digest,
    hasUnidentifiedFills: input.hasUnidentifiedFills,
    rowCount,
    rows,
    rowPlan,
    intervals,
    evidence: normalizeEvidence(input.evidence),
  };
  assertCompleteBatch(batch.evidence);
  return batch;
}

export function normalizeCsvFillLedger(input: unknown, expectedAccountScope?: string): CsvFillLedger {
  if (!isPlainObject(input) || input.version !== LEDGER_VERSION) fail('INVALID_LEDGER');
  const accountScope = normalizeAccountScope(input.accountScope);
  if (expectedAccountScope !== undefined && accountScope !== normalizeAccountScope(expectedAccountScope)) {
    fail('ACCOUNT_SCOPE_MISMATCH');
  }
  const scopeDigest = typeof input.scopeDigest === 'string' && HEX_64.test(input.scopeDigest)
    ? input.scopeDigest : fail('INVALID_LEDGER');
  if (!Array.isArray(input.fills) || input.fills.length > MAX_LEDGER_FILLS) fail('RESOURCE_LIMIT');
  if (!Array.isArray(input.batches) || input.batches.length > MAX_LEDGER_BATCHES || !input.batches.length) {
    fail('INVALID_LEDGER');
  }
  const fills = input.fills.map(normalizeStoredFill);
  const batches = input.batches.map(normalizeStoredBatch);
  if (batches.reduce((sum, batch) => sum + batch.rowCount, 0) > MAX_LEDGER_ROWS) fail('RESOURCE_LIMIT');
  const batchDigests = new Set(batches.map((batch) => batch.digest));
  if (batchDigests.size !== batches.length) fail('INVALID_LEDGER');
  if (fills.some((fill) => !batchDigests.has(fill.batchDigest))) fail('INVALID_LEDGER');
  const batchesByDigest = new Map(batches.map((batch) => [batch.digest, batch]));
  const providerIds = new Set<string>();
  const sourceRefs = new Set<string>();
  for (const fill of fills) {
    if (!fill.sourceRef.startsWith(`rvf:${scopeDigest.slice(0, 16)}:`)) fail('INVALID_LEDGER');
    const batch = batchesByDigest.get(fill.batchDigest);
    if (!batch || fill.rowIndex >= batch.rows.length) fail('INVALID_LEDGER');
    if (sourceRefs.has(fill.sourceRef)) fail('INVALID_LEDGER');
    sourceRefs.add(fill.sourceRef);
    if (fill.providerTradeId) {
      const key = providerKey(fill);
      if (providerIds.has(key)) fail('INVALID_LEDGER');
      providerIds.add(key);
    }
  }
  const evidence = normalizeEvidence(input.evidence);
  if (canonicalJson(evidence) !== canonicalJson(aggregateEvidence(batches.map((batch) => batch.evidence)))) {
    fail('INVALID_LEDGER');
  }
  const ledger: CsvFillLedger = {
    version: LEDGER_VERSION,
    accountScope,
    scopeDigest,
    fills: canonicalStoredFills(fills),
    batches,
    evidence,
  };
  assertLedgerByteBudget(ledger);
  return ledger;
}


/**
 * Performs the cryptographic checks intentionally omitted by the synchronous
 * snapshot parser: account-scope digest, canonical batch digests, intervals,
 * lineage references, and the materialized unique-fill set.
 */
export async function verifyCsvFillLedgerIntegrity(
  input: unknown,
  expectedAccountScope?: string,
): Promise<CsvFillLedger> {
  const ledger = normalizeCsvFillLedger(input, expectedAccountScope);
  executionOrderedFills(ledger);
  const expectedScopeDigest = await digestText(ledger.accountScope);
  if (ledger.scopeDigest !== expectedScopeDigest) fail('LEDGER_INTEGRITY_FAILURE');

  const expectedFills: CsvLedgerFill[] = [];
  const expectedBySourceRef = new Map<string, CsvLedgerFill>();
  const providers = new Map<string, NormalizedInputFill>();
  const verifiedBatches: CsvLedgerBatch[] = [];
  for (const batch of ledger.batches) {
    const reconstructedRows = batch.rowPlan.map((item) => {
      if (typeof item === 'number') return batch.rows[item];
      return expectedBySourceRef.get(item) ?? fail('LEDGER_INTEGRITY_FAILURE');
    });
    const text = canonicalJson(reconstructedRows.map(fillDigestShape));
    if (await digestText(text) !== batch.digest
      || batch.rowCount !== batch.rowPlan.length
      || batch.hasUnidentifiedFills !== batch.rows.some((fill) => fill.providerTradeId === null)
      || canonicalJson(batch.intervals) !== canonicalJson(intervalsOf(batch.rows))) {
      fail('LEDGER_INTEGRITY_FAILURE');
    }
    if (verifiedBatches.some((existing) => (
      (batch.hasUnidentifiedFills || existing.hasUnidentifiedFills)
      && intervalsOverlap(batch.intervals, existing.intervals)
    ))) fail('LEDGER_INTEGRITY_FAILURE');
    verifiedBatches.push(batch);
    const identityMaterials: string[] = [];
    for (let rowIndex = 0; rowIndex < batch.rows.length; rowIndex++) {
      const fill = batch.rows[rowIndex];
      if (fill.providerTradeId) {
        const key = providerKey(fill as CsvLedgerFill);
        const prior = providers.get(key);
        if (prior) {
          fail('LEDGER_INTEGRITY_FAILURE');
        }
        providers.set(key, fill);
      }
      identityMaterials.push(fill.providerTradeId
        ? `provider:${providerKey(fill as CsvLedgerFill)}`
        : `batch:${batch.digest}:row:${rowIndex}`);
    }
    const identityDigests = await digestTextsBounded(identityMaterials);
    for (let rowIndex = 0; rowIndex < batch.rows.length; rowIndex++) {
      const fill = batch.rows[rowIndex];
      const expected = {
        ...fill,
        batchDigest: batch.digest,
        rowIndex,
        sourceRef: `rvf:${expectedScopeDigest.slice(0, 16)}:${identityDigests[rowIndex].slice(0, 32)}`,
      };
      expectedFills.push(expected);
      expectedBySourceRef.set(expected.sourceRef, expected);
    }
  }
  if (canonicalJson(canonicalStoredFills(expectedFills)) !== canonicalJson(canonicalStoredFills(ledger.fills))) {
    fail('LEDGER_INTEGRITY_FAILURE');
  }
  return ledger;
}

export function serializeCsvFillLedger(ledger: CsvFillLedger): string {
  return canonicalJson(normalizeCsvFillLedger(ledger));
}

export function withCsvFillLedger<T extends object>(
  archive: T,
  ledger: CsvFillLedger,
): T & Readonly<{ rvFillLedger: CsvFillLedger }> {
  if (!isPlainObject(archive)) fail('INVALID_ARCHIVE');
  return { ...archive, [ARCHIVE_EXTENSION_KEY]: normalizeCsvFillLedger(ledger) };
}

export function readCsvFillLedgerExtension(
  archive: unknown,
  expectedAccountScope?: string,
): CsvFillLedger | null {
  if (!isPlainObject(archive)) fail('INVALID_ARCHIVE');
  if (!(ARCHIVE_EXTENSION_KEY in archive)) return null;
  return normalizeCsvFillLedger(archive[ARCHIVE_EXTENSION_KEY], expectedAccountScope);
}

export function ledgerEvidenceToImportEvidence(ledger: CsvFillLedger): Readonly<{
  meta: ImportMeta;
  diagnostics: readonly DiagnosticItem[];
  contract: ResultContract;
}> {
  const replay = replayCsvFillLedger(ledger);
  return { meta: replay.meta, diagnostics: replay.diagnostics, contract: replay.contract };
}
