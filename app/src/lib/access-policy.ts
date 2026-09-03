export type BinanceAccessPhase =
  | 'BINANCE_OBSERVED_READY'
  | 'BINANCE_BROWSE_ONLY'
  | 'BINANCE_EMPTY'
  | 'BINANCE_BLOCKED';

export type BinanceAccess = Readonly<{
  phase: BinanceAccessPhase;
  showRecords: boolean;
  showObservedAnalytics: boolean;
  showAccountKpis: boolean;
  showPositions: boolean;
  showEquity: boolean;
  showLedger: boolean;
  reasonCodes: readonly string[];
}>;

type CapabilityDecision = 'ALLOW' | 'LIMITED' | 'DENY';

type Capability = {
  decision?: CapabilityDecision;
  reasonCodes?: unknown;
};

type Quality = {
  status?: string;
  accountScope?: string;
  capabilities?: Record<string, Capability>;
  reasonCodes?: unknown;
};

type BundleLike = {
  fills?: unknown;
  reconciliation?: { protocol?: string; status?: string; reasonCodes?: unknown };
  _meta?: { dataStatus?: string; quality?: Quality };
};

function codes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(item)
  ));
}

function capability(quality: Quality | undefined, name: string): Capability {
  return quality?.capabilities?.[name] ?? { decision: 'DENY', reasonCodes: [] };
}

function isStrong(quality: Quality | undefined, name: string): boolean {
  return quality?.status === 'VALID' && capability(quality, name).decision === 'ALLOW';
}

export function resolveBinanceAccess(input: unknown): BinanceAccess {
  const bundle = (
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {}
  ) as BundleLike;
  const quality = bundle._meta?.quality;
  const records = capability(quality, 'recordsBrowsable');
  const observed = capability(quality, 'observedTradeAnalytics');
  const reasons = new Set<string>([
    ...codes(quality?.reasonCodes),
    ...codes(records.reasonCodes),
    ...codes(observed.reasonCodes),
  ]);

  const recordsAllowed = records.decision === 'ALLOW' || records.decision === 'LIMITED';
  if (!recordsAllowed) {
    reasons.add('RECORDS_NOT_BROWSABLE');
    return Object.freeze({
      phase: 'BINANCE_BLOCKED',
      showRecords: false,
      showObservedAnalytics: false,
      showAccountKpis: false,
      showPositions: false,
      showEquity: false,
      showLedger: false,
      reasonCodes: Object.freeze([...reasons].sort()),
    });
  }

  const fills = Array.isArray(bundle.fills) ? bundle.fills : [];
  if (fills.length === 0) {
    reasons.add('NO_BROWSABLE_RECORDS');
    return Object.freeze({
      phase: 'BINANCE_EMPTY',
      showRecords: true,
      showObservedAnalytics: false,
      showAccountKpis: false,
      showPositions: false,
      showEquity: false,
      showLedger: false,
      reasonCodes: Object.freeze([...reasons].sort()),
    });
  }

  const dataCurrent = bundle._meta?.dataStatus === 'CURRENT';
  const qualityObservedRangeReady = quality?.status === 'PARTIAL'
    || quality?.status === 'VALID';
  const scopeBound = quality?.accountScope === 'BOUND';
  const observedAllowed = observed.decision === 'ALLOW' || observed.decision === 'LIMITED';
  const reconciliationV2 = bundle.reconciliation?.protocol === 'rv-reconciliation/2';
  const reconciliationPass = reconciliationV2 && bundle.reconciliation?.status === 'PASS';

  if (!dataCurrent) reasons.add(`DATA_STATUS_${bundle._meta?.dataStatus || 'UNKNOWN'}`);
  if (!qualityObservedRangeReady) reasons.add(`QUALITY_${quality?.status || 'UNKNOWN'}`);
  if (!scopeBound) reasons.add('ACCOUNT_SCOPE_UNVERIFIED');
  if (!observedAllowed) reasons.add('OBSERVED_ANALYTICS_DENIED');
  if (!reconciliationV2) reasons.add('RECONCILIATION_V2_REQUIRED');
  if (!reconciliationPass) {
    reasons.add('RECONCILIATION_REQUIRED');
    for (const reason of codes(bundle.reconciliation?.reasonCodes)) reasons.add(reason);
  }

  const ready = dataCurrent
    && qualityObservedRangeReady
    && scopeBound
    && observedAllowed
    && reconciliationPass;

  return Object.freeze({
    phase: ready ? 'BINANCE_OBSERVED_READY' : 'BINANCE_BROWSE_ONLY',
    showRecords: true,
    showObservedAnalytics: ready,
    showAccountKpis: ready && isStrong(quality, 'accountKpis'),
    showPositions: ready && isStrong(quality, 'currentPositions'),
    showEquity: ready && isStrong(quality, 'equityAnalytics'),
    showLedger: ready && isStrong(quality, 'ledger'),
    reasonCodes: Object.freeze([...reasons].sort()),
  });
}
