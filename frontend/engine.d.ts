export type SourceId =
  | 'unknown'
  | 'fupan-archive'
  | 'binance'
  | 'local-engine'
  | 'binance-export'
  | 'csv-report'
  | 'generic-sniffed'
  | 'manual-map'
  | 'csv-trades'
  | 'manual'
  | 'synthetic-demo';

export type SourceBooleanCapability =
  | 'fills'
  | 'orders'
  | 'pnlReported'
  | 'fees'
  | 'income'
  | 'ledger'
  | 'klines';

export type SourceTimePrecision = 'unknown' | 'ms' | 'minute' | 'day' | 'mixed';

export interface SourceCapabilityValues {
  readonly fills: boolean;
  readonly orders: boolean;
  readonly pnlReported: boolean;
  readonly fees: boolean;
  readonly income: boolean;
  readonly ledger: boolean;
  readonly klines: boolean;
  readonly timePrecision: SourceTimePrecision;
}

/** Evidence advertised by an import source. This is not a runtime grant. */
export interface SourceCapabilityReport {
  readonly version: 'rv-capabilities/1';
  readonly sources: readonly SourceId[];
  readonly values: SourceCapabilityValues;
  readonly unavailable: readonly SourceBooleanCapability[];
}

export type RuntimeCapabilityState = 'ALLOW' | 'LIMITED' | 'DENY';

/** A fail-closed runtime authorization decision derived from current quality state. */
export interface RuntimeCapabilityDecision {
  readonly decision: RuntimeCapabilityState;
  readonly reasonCodes: readonly string[];
}

export type DiagnosticCode =
  | 'invalid_record'
  | 'invalid_id'
  | 'duplicate_id'
  | 'invalid_time'
  | 'empty_symbol'
  | 'invalid_side'
  | 'invalid_number'
  | 'non_positive_qty'
  | 'non_positive_price'
  | 'invalid_time_range'
  | 'invalid_fill'
  | 'invalid_enum'
  | 'invalid_boolean'
  | 'resource_limit'
  | 'invalid_fee'
  | 'invalid_pnl'
  | 'unsupported_position_mode'
  | 'unsupported_fee_asset'
  | 'unsupported_pnl_asset'
  | 'unsupported_settlement_currency';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticItem {
  readonly index: number | null;
  readonly code: DiagnosticCode;
  readonly field: string;
  readonly severity: DiagnosticSeverity;
}

export interface DiagnosticsReport {
  readonly version: 'rv-diagnostics/1';
  readonly count: number;
  readonly countsByCode: Readonly<Record<string, number>>;
  readonly items: readonly DiagnosticItem[];
}

export type CanonicalTradeField =
  | 'id'
  | 'symbol'
  | 'side'
  | 'entryTime'
  | 'exitTime'
  | 'entryPrice'
  | 'exitPrice'
  | 'qty'
  | 'notional'
  | 'fee'
  | 'pnl'
  | 'currency';

export type FieldOrigin =
  | 'observed'
  | 'derived'
  | 'defaulted'
  | 'approximated'
  | 'self-declared'
  | 'unknown';

export interface ResultContract {
  readonly version: 'rv-result/1';
  readonly canonical: {
    readonly version: 'rv-canonical-trade/1';
    readonly recordType: 'trade';
    readonly count: number;
  };
  readonly provenance: {
    readonly version: 'rv-provenance/1';
    readonly source: SourceId;
    readonly adapterId: string;
    readonly fieldOrigins: Readonly<Record<CanonicalTradeField, FieldOrigin>>;
    readonly coverage: {
      readonly status: 'complete' | 'partial' | 'blocked';
      readonly accepted: number;
      readonly dropped: number;
    };
    /** Present only when the built-in USD-M CSV adapter matched its strict
     * export schema, including the exchange Trade Id column. */
    readonly executionOrderEvidence?: BinanceUsdmCsvExecutionOrderEvidence;
  };
  readonly capabilities: SourceCapabilityReport;
  readonly diagnostics: DiagnosticsReport;
}

export interface BinanceUsdmCsvExecutionOrderEvidence {
  readonly version: 'rv-binance-usdm-csv-execution-order/1';
  readonly adapterId: 'builtin/binance-usdm-futures-csv/1';
  readonly headerSchema: 'date(utc)|symbol|side|price|quantity|fee|realized profit|trade id';
}

export type ImportContract = ResultContract;

export type TradeSide = 'LONG' | 'SHORT';
export type OrdersCoverage = 'unknown' | 'partial' | 'complete';

export interface TradeEvidence extends Record<string, unknown> {
  trust?: 'self-declared' | 'observed' | 'unknown';
  ordersCoverage?: OrdersCoverage;
}

export interface CanonicalTrade {
  id: string;
  symbol: string;
  side: TradeSide;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  fee: number;
  pnl: number;
  currency: string;
  source: SourceId;
  declaredSource?: SourceId;
  account?: string;
  leverage?: number;
  notional?: number;
  multiplier?: number;
  pnlSelfCalc?: boolean;
  plannedRisk?: number | null;
  hadSL?: boolean | null;
  stopRespected?: boolean | null;
  ordersCoverage?: OrdersCoverage;
  mfe?: number;
  mae?: number;
  mfePrice?: number;
  maePrice?: number;
  evidence?: TradeEvidence | null;
  tags?: string[];
  emotion?: string;
  note?: string;
  setup?: string;
  plan?: Record<string, unknown>;
  review?: Record<string, unknown> | string;
  market?: string;
}

/** Canonical execution row retained before fills are netted into closed trades. */
export interface CanonicalFill {
  /** Adapter-local compatibility ID; never use this field as an exchange dedupe key. */
  readonly id: string | number;
  /** Stable lineage for deterministic replay. Uses tradeId when present, never orderId. */
  readonly sourceRef: string;
  /** Opaque exchange IDs are strings because they may exceed Number.MAX_SAFE_INTEGER. */
  readonly tradeId?: string;
  readonly orderId?: string;
  readonly time: number;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly positionSide: 'BOTH' | 'LONG' | 'SHORT';
  readonly price: number;
  readonly qty: number;
  readonly fee: number;
  readonly feeAsset: string | null;
  readonly pnl: number | null;
}

export interface EnrichedTradeFields {
  riskFallback: boolean;
  oneR: number;
  rMultiple: number;
  mfeReal: boolean;
  mfeR: number;
  maeR: number;
  leftOnTable: number | null;
  session: string;
  sessionLabel: string;
  sessionClass: string;
  sessionThin: boolean;
}

export type EnrichedTrade = CanonicalTrade & EnrichedTradeFields;

export interface ImportMeta {
  source: SourceId;
  declaredSource?: SourceId;
  note?: string;
  fills?: number;
  badRows?: number;
  openPositions?: number;
  imported?: number;
  dropped?: number;
  droppedByCode?: Readonly<Record<string, number>>;
  importedAt?: number;
  exportedAt?: number;
}

export interface ImportSuccess {
  readonly error?: undefined;
  readonly trades: CanonicalTrade[];
  readonly meta: ImportMeta;
  readonly diagnostics: DiagnosticItem[];
  readonly contract: ResultContract;
}

export interface StatementImportSuccess extends ImportSuccess {
  readonly fills: CanonicalFill[];
}

export interface ImportFailure {
  readonly error: string;
  readonly header?: string[];
  readonly rowCount?: number;
  readonly trades?: CanonicalTrade[];
  readonly meta?: ImportMeta;
  readonly diagnostics?: DiagnosticItem[];
  readonly contract?: ResultContract;
}

export type StatementImportResult = StatementImportSuccess | ImportFailure;
export type ArchiveImportResult = ImportSuccess | ImportFailure;

export interface FupanArchive<TMeta extends object | null = ImportMeta | null> {
  readonly format: 'fupan/1';
  readonly exportedAt: unknown;
  readonly meta: TMeta;
  readonly trades: ReadonlyArray<Partial<CanonicalTrade>>;
}

export interface DailySummary {
  readonly key: string;
  readonly pnl: number;
  readonly count: number;
  readonly wins: number;
  readonly fees: number;
  readonly tags: readonly string[];
  readonly trades: readonly EnrichedTrade[];
}

export interface RDistributionBucket {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
}

export interface REquityPoint {
  readonly t: number;
  readonly v: number;
  readonly r: number;
  readonly id: string;
}

export interface ComputedStats {
  readonly n: number;
  readonly net: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly pf: number;
  readonly grossWin: number;
  readonly grossLoss: number;
  readonly fees: number;
  readonly feeDrag: number;
  readonly maxLossStreak: number;
  readonly revenge: readonly EnrichedTrade[];
  readonly activeDays: number;
  readonly tradesPerDay: number;
  readonly worstTrade: EnrichedTrade | null;
  readonly daily: ReadonlyMap<string, DailySummary>;
  readonly rEstimatedN: number;
  readonly totalR: number;
  readonly expectancyR: number;
  readonly avgWinR: number;
  readonly avgLossR: number;
  readonly payoffR: number | null;
  readonly rWinShare: number;
  readonly bestR: number;
  readonly worstR: number;
  readonly rBelow: number;
  readonly rAbove: number;
  readonly rDist: readonly RDistributionBucket[];
  readonly rEquity: readonly REquityPoint[];
  readonly mfeRealN: number;
  readonly leftOnTable: number;
  readonly winnersUnderwater: number;
  readonly captureRate: number | null;
  readonly deepestMae: number;
}

export interface BeijingDateParts {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
  readonly dow: number;
}

export interface BlankCalendarCell {
  readonly blank: true;
  readonly key: string;
}

export interface CalendarDayCell {
  readonly blank?: false;
  readonly key: string;
  readonly d: number;
  readonly pnl: number | null;
  readonly count: number;
  readonly wins: number;
  readonly journal: boolean;
}

export type CalendarCell = BlankCalendarCell | CalendarDayCell;
export type StatementField =
  | 'tradeId'
  | 'orderId'
  | 'time'
  | 'symbol'
  | 'side'
  | 'positionSide'
  | 'price'
  | 'qty'
  | 'fee'
  | 'feeAsset'
  | 'pnl';
export type StatementColumnMap = Partial<Record<StatementField, number>>;

export interface PairFillsResult {
  readonly trades: CanonicalTrade[];
  readonly openPositions: number;
}

export const RESULT_ENVELOPE_VERSION: 'rv-result/1';
export const CANONICAL_RECORD_VERSION: 'rv-canonical-trade/1';
export const PROVENANCE_VERSION: 'rv-provenance/1';
export const CAPABILITY_VERSION: 'rv-capabilities/1';
export const DIAGNOSTICS_VERSION: 'rv-diagnostics/1';
export const BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE: BinanceUsdmCsvExecutionOrderEvidence;
export const SOURCE_CAPS: Readonly<Record<SourceId, SourceCapabilityValues>>;
export const DOW_CN: readonly string[];
export const FUPAN_FORMAT: 'fupan/1';
export const MAX_ARCHIVE_JSON_CHARS: number;
export const MAX_ARCHIVE_TRADES: number;

export function bj(ms: number): BeijingDateParts;
export function displaySymbol(symbol?: string | null, market?: string | null): string;
export function fmtUsd(value: number | null | undefined, sign?: boolean): string;
export function fmtNum(value: number | null | undefined, digits?: number): string;
export function fmtPct(value: number | null | undefined, digits?: number): string;
export function fmtDT(ms: number): string;
export function fmtDur(minutes: number): string;
export function enrichTrades<T extends CanonicalTrade>(trades: T[]): Array<T & EnrichedTradeFields>;
export function computeAll(trades: readonly EnrichedTrade[], startEquity?: number): ComputedStats;
export function calendarMonth(
  dailyMap: ReadonlyMap<string, DailySummary>,
  journal: Readonly<Record<string, { readonly done?: boolean }>> | null,
  year: number,
  month: number,
): CalendarCell[];
export function parseStatement(text: string, manualMap?: StatementColumnMap | null): StatementImportResult;
export function parseStatementBatch(text: string, manualMap?: StatementColumnMap | null): StatementImportResult;
export function pairFills(fills: readonly CanonicalFill[]): PairFillsResult;
export function bundleToTrades(bundle: unknown): ImportSuccess | ImportFailure;
export function exportArchive<TMeta extends object | null>(
  trades: readonly CanonicalTrade[],
  meta: TMeta,
): FupanArchive<TMeta>;
export function importArchive(input: unknown): ArchiveImportResult;
