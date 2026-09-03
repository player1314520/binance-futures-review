const BUNDLE_DATA_STATUSES = Object.freeze(new Set([
  'CURRENT',
  'CACHED_ONLY',
  'LEGACY_UNBOUND',
]));
const BUNDLE_QUALITY_PROTOCOL = 'rv-data-quality/1';
const BUNDLE_QUALITY_V2_PROTOCOL = 'rv-data-quality/2';
const BUNDLE_QUALITY_STATUSES = Object.freeze(new Set([
  'VALID',
  'PARTIAL',
  'FAILED',
  'STALE',
]));
const BUNDLE_ACCOUNT_SCOPES = Object.freeze(new Set([
  'BOUND',
  'UNVERIFIED',
]));
const BUNDLE_COVERAGE_STATES = Object.freeze(new Set([
  'complete',
  'partial',
  'missing',
  'unknown',
]));
const BUNDLE_DATASETS = Object.freeze([
  'fills',
  'orders',
  'income',
  'positions',
]);
const BUNDLE_V2_CAPABILITIES = Object.freeze([
  'recordsBrowsable',
  'observedTradeAnalytics',
  'accountKpis',
  'currentPositions',
  'equityAnalytics',
  'ledger',
]);
const BUNDLE_V2_DECISIONS = Object.freeze(new Set([
  'ALLOW',
  'LIMITED',
  'DENY',
]));
const BUNDLE_REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const BUNDLE_MAX_REASON_CODES = 64;
const BUNDLE_MAX_FUTURE_EVIDENCE_MS = 5 * 60 * 1000;
const BUNDLE_SYNC_WINDOW_PROTOCOL = 'rv-binance-sync-window/1';
const BUNDLE_SYNC_WINDOW_MODES = Object.freeze(new Set([
  'incremental',
  'prewarm',
]));
const BUNDLE_SYNC_SYMBOL_SCOPES = Object.freeze(new Set([
  'income-discovered',
  'income-position-discovered',
  'income-open-orders-discovered',
  'income-position-open-orders-discovered',
]));

function v2PlainRecord(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_error) {
    return false;
  }
}

function v2OwnDataField(source, field) {
  if (!v2PlainRecord(source)) return { ok: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      return { ok: false };
    }
    return { ok: true, value: descriptor.value };
  } catch (_error) {
    return { ok: false };
  }
}

function v2SnapshotRecord(value, fields, options = {}) {
  const { exact = true } = options;
  try {
    if (!v2PlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) return null;
    if (keys.some((key) => !fields.has(key))) return null;
    if (exact && keys.length !== fields.size) return null;
    const snapshot = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (_error) {
    return null;
  }
}

function v2SnapshotDenseArray(value) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > BUNDLE_MAX_REASON_CODES
      || keys.length !== lengthDescriptor.value + 1
    ) {
      return null;
    }
    const snapshot = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch (_error) {
    return null;
  }
}

function v2SafeTimestamp(value) {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
  ) ? value : null;
}

function v2ReasonCodes(value) {
  const snapshot = v2SnapshotDenseArray(value);
  if (
    !snapshot
    || snapshot.some((code) => (
      typeof code !== 'string'
      || !BUNDLE_REASON_CODE_PATTERN.test(code)
    ))
  ) {
    return null;
  }
  const stable = [...new Set(snapshot)].sort();
  if (
    stable.length !== snapshot.length
    || stable.some((code, index) => code !== snapshot[index])
  ) {
    return null;
  }
  return stable;
}

function v2FrozenDecision(decision, reasonCodes) {
  return Object.freeze({
    decision,
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

function v2FreezeQuality({
  status,
  accountScope,
  updatedAt,
  successfulThrough,
  ageMs,
  coverage,
  observedRange,
  capabilities,
  reasonCodes,
}) {
  const frozenCapabilities = {};
  for (const capability of BUNDLE_V2_CAPABILITIES) {
    const source = capabilities[capability];
    frozenCapabilities[capability] = v2FrozenDecision(
      source.decision,
      source.reasonCodes,
    );
  }
  return Object.freeze({
    protocol: BUNDLE_QUALITY_V2_PROTOCOL,
    status,
    accountScope,
    updatedAt,
    successfulThrough,
    ageMs,
    coverage: Object.freeze({ ...coverage }),
    observedRange: observedRange
      ? Object.freeze({ ...observedRange })
      : null,
    capabilities: Object.freeze(frozenCapabilities),
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

function failedBundleQualityV2(reasonCodes = ['INVALID_QUALITY_CONTRACT']) {
  const stableReasons = [...new Set(reasonCodes)].sort();
  const capabilities = {};
  for (const capability of BUNDLE_V2_CAPABILITIES) {
    capabilities[capability] = {
      decision: 'DENY',
      reasonCodes: ['QUALITY_FAILED'],
    };
  }
  return v2FreezeQuality({
    status: 'FAILED',
    accountScope: 'UNVERIFIED',
    updatedAt: 0,
    successfulThrough: 0,
    ageMs: null,
    coverage: Object.fromEntries(
      BUNDLE_DATASETS.map((dataset) => [dataset, 'unknown']),
    ),
    observedRange: null,
    capabilities,
    reasonCodes: stableReasons,
  });
}

function v2SnapshotCoverage(value) {
  const snapshot = v2SnapshotRecord(value, new Set(BUNDLE_DATASETS));
  if (!snapshot) return null;
  for (const dataset of BUNDLE_DATASETS) {
    if (!BUNDLE_COVERAGE_STATES.has(snapshot[dataset])) return null;
  }
  return snapshot;
}

function v2SnapshotObservedRange(value, successfulThrough) {
  if (value === null) return null;
  const snapshot = v2SnapshotRecord(
    value,
    new Set(['startTime', 'endTimeExclusive']),
  );
  if (!snapshot) return false;
  const startTime = v2SafeTimestamp(snapshot.startTime);
  const endTimeExclusive = v2SafeTimestamp(snapshot.endTimeExclusive);
  if (
    startTime === null
    || endTimeExclusive === null
    || startTime >= endTimeExclusive
    || successfulThrough <= 0
    || successfulThrough >= Number.MAX_SAFE_INTEGER
    || endTimeExclusive > successfulThrough + 1
  ) {
    return false;
  }
  return { startTime, endTimeExclusive };
}

function v2SnapshotCapabilities(value) {
  const snapshot = v2SnapshotRecord(value, new Set(BUNDLE_V2_CAPABILITIES));
  if (!snapshot) return null;
  const capabilities = {};
  for (const capability of BUNDLE_V2_CAPABILITIES) {
    const decision = v2SnapshotRecord(
      snapshot[capability],
      new Set(['decision', 'reasonCodes']),
    );
    if (!decision || !BUNDLE_V2_DECISIONS.has(decision.decision)) return null;
    const reasonCodes = v2ReasonCodes(decision.reasonCodes);
    if (
      !reasonCodes
      || (decision.decision === 'ALLOW' && reasonCodes.length !== 0)
      || (decision.decision !== 'ALLOW' && reasonCodes.length === 0)
    ) {
      return null;
    }
    capabilities[capability] = {
      decision: decision.decision,
      reasonCodes,
    };
  }
  return capabilities;
}

function v2SnapshotSyncWindow(value) {
  const fields = new Set([
    'protocol',
    'mode',
    'symbolScope',
    'startTime',
    'endTimeExclusive',
    'successfulThrough',
    'configuredHistoryDays',
    'reasonCodes',
  ]);
  const snapshot = v2SnapshotRecord(value, fields, { exact: false });
  if (!snapshot) return null;
  const required = [...fields].filter((field) => field !== 'reasonCodes');
  if (required.some((field) => !Object.hasOwn(snapshot, field))) return null;
  if (
    snapshot.protocol !== BUNDLE_SYNC_WINDOW_PROTOCOL
    || !BUNDLE_SYNC_WINDOW_MODES.has(snapshot.mode)
    || !BUNDLE_SYNC_SYMBOL_SCOPES.has(snapshot.symbolScope)
  ) {
    return null;
  }
  const startTime = v2SafeTimestamp(snapshot.startTime);
  const endTimeExclusive = v2SafeTimestamp(snapshot.endTimeExclusive);
  const successfulThrough = v2SafeTimestamp(snapshot.successfulThrough);
  if (
    startTime === null
    || endTimeExclusive === null
    || successfulThrough === null
    || successfulThrough >= Number.MAX_SAFE_INTEGER
    || startTime > successfulThrough
    || endTimeExclusive !== successfulThrough + 1
    || !Number.isSafeInteger(snapshot.configuredHistoryDays)
    || snapshot.configuredHistoryDays <= 0
    || snapshot.configuredHistoryDays > 3_650
  ) {
    return null;
  }
  if (
    Object.hasOwn(snapshot, 'reasonCodes')
    && !v2ReasonCodes(snapshot.reasonCodes)
  ) {
    return null;
  }
  return { startTime, endTimeExclusive, successfulThrough };
}

function normalizeNativeBundleQualityV2(
  quality,
  dataStatus,
  syncWindowValue,
  now,
) {
  const fields = new Set([
    'protocol',
    'status',
    'accountScope',
    'updatedAt',
    'successfulThrough',
    'ageMs',
    'coverage',
    'observedRange',
    'capabilities',
    'reasonCodes',
  ]);
  const snapshot = v2SnapshotRecord(quality, fields);
  if (
    !snapshot
    || snapshot.protocol !== BUNDLE_QUALITY_V2_PROTOCOL
    || !BUNDLE_QUALITY_STATUSES.has(snapshot.status)
    || !BUNDLE_ACCOUNT_SCOPES.has(snapshot.accountScope)
  ) {
    return failedBundleQualityV2();
  }
  const updatedAt = v2SafeTimestamp(snapshot.updatedAt);
  const successfulThrough = v2SafeTimestamp(snapshot.successfulThrough);
  const ageMs = snapshot.ageMs === null
    ? null
    : v2SafeTimestamp(snapshot.ageMs);
  const coverage = v2SnapshotCoverage(snapshot.coverage);
  const reasonCodes = v2ReasonCodes(snapshot.reasonCodes);
  const capabilities = v2SnapshotCapabilities(snapshot.capabilities);
  if (
    updatedAt === null
    || successfulThrough === null
    || ageMs === null && snapshot.ageMs !== null
    || !coverage
    || !reasonCodes
    || !capabilities
  ) {
    return failedBundleQualityV2();
  }
  if (
    updatedAt > now + BUNDLE_MAX_FUTURE_EVIDENCE_MS
    || successfulThrough > now + BUNDLE_MAX_FUTURE_EVIDENCE_MS
  ) {
    return failedBundleQualityV2(['FUTURE_QUALITY_EVIDENCE']);
  }
  const observedRange = v2SnapshotObservedRange(
    snapshot.observedRange,
    successfulThrough,
  );
  if (observedRange === false) return failedBundleQualityV2();

  const hasSnapshot = updatedAt > 0;
  const hasWatermark = successfulThrough > 0;
  const browsableCoverage = ['fills', 'orders', 'income'].some((dataset) => (
    coverage[dataset] === 'complete' || coverage[dataset] === 'partial'
  ));
  const fillsDeclared = (
    coverage.fills === 'complete' || coverage.fills === 'partial'
  );
  const anyAllow = BUNDLE_V2_CAPABILITIES.some(
    (capability) => capabilities[capability].decision === 'ALLOW',
  );
  const anyNonDenyWhenFailed = BUNDLE_V2_CAPABILITIES.some(
    (capability) => capabilities[capability].decision !== 'DENY',
  );
  const strongCapabilityGranted = [
    'accountKpis',
    'currentPositions',
    'equityAnalytics',
    'ledger',
  ].some((capability) => capabilities[capability].decision !== 'DENY');
  const recordsGranted = capabilities.recordsBrowsable.decision !== 'DENY';
  const observedGranted = capabilities.observedTradeAnalytics.decision !== 'DENY';
  const contradictory = (
    snapshot.status === 'VALID'
    || (snapshot.status !== 'FAILED' && snapshot.accountScope !== 'BOUND')
    || (snapshot.status === 'FAILED' && anyNonDenyWhenFailed)
    || ((snapshot.status === 'PARTIAL' || snapshot.status === 'STALE') && anyAllow)
    || dataStatus === 'LEGACY_UNBOUND'
    || (
      dataStatus === 'CACHED_ONLY'
      && hasSnapshot
      && snapshot.status !== 'STALE'
      && snapshot.status !== 'FAILED'
    )
    || (!hasSnapshot && ageMs !== null)
    || (hasSnapshot && ageMs === null)
    || (!hasSnapshot && hasWatermark)
    || (!hasWatermark && observedRange !== null)
    || strongCapabilityGranted
    || (recordsGranted && (
      snapshot.accountScope !== 'BOUND'
      || !hasSnapshot
      || !browsableCoverage
    ))
    || (observedGranted && (
      !recordsGranted
      || !hasWatermark
      || !fillsDeclared
      || observedRange === null
    ))
  );
  if (contradictory) {
    return failedBundleQualityV2(['CONTRADICTORY_QUALITY_CONTRACT']);
  }

  if (hasWatermark) {
    const syncWindow = v2SnapshotSyncWindow(syncWindowValue);
    if (
      !syncWindow
      || syncWindow.successfulThrough !== successfulThrough
      || syncWindow.endTimeExclusive !== successfulThrough + 1
      || (
        observedRange
        && (
          observedRange.startTime < syncWindow.startTime
          || observedRange.endTimeExclusive > syncWindow.endTimeExclusive
        )
      )
    ) {
      return failedBundleQualityV2(['WATERMARK_MISMATCH']);
    }
  }

  return v2FreezeQuality({
    status: snapshot.status,
    accountScope: snapshot.accountScope,
    updatedAt,
    successfulThrough,
    ageMs,
    coverage,
    observedRange,
    capabilities,
    reasonCodes,
  });
}

function normalizeLegacyBundleQualityV1(quality, dataStatus, now) {
  const fields = new Set([
    'protocol',
    'status',
    'accountScope',
    'usableForAnalytics',
    'updatedAt',
    'successfulThrough',
    'ageMs',
    'coverage',
    'reasonCodes',
  ]);
  const snapshot = v2SnapshotRecord(quality, fields);
  if (
    !snapshot
    || snapshot.protocol !== BUNDLE_QUALITY_PROTOCOL
    || !BUNDLE_QUALITY_STATUSES.has(snapshot.status)
    || !BUNDLE_ACCOUNT_SCOPES.has(snapshot.accountScope)
    || typeof snapshot.usableForAnalytics !== 'boolean'
  ) {
    return failedBundleQualityV2();
  }
  const updatedAt = v2SafeTimestamp(snapshot.updatedAt);
  const successfulThrough = v2SafeTimestamp(snapshot.successfulThrough);
  const ageMs = snapshot.ageMs === null
    ? null
    : v2SafeTimestamp(snapshot.ageMs);
  const coverage = v2SnapshotCoverage(snapshot.coverage);
  const reasonCodes = v2ReasonCodes(snapshot.reasonCodes);
  if (
    updatedAt === null
    || successfulThrough === null
    || ageMs === null && snapshot.ageMs !== null
    || !coverage
    || !reasonCodes
  ) {
    return failedBundleQualityV2();
  }
  if (
    updatedAt > now + BUNDLE_MAX_FUTURE_EVIDENCE_MS
    || successfulThrough > now + BUNDLE_MAX_FUTURE_EVIDENCE_MS
  ) {
    return failedBundleQualityV2(['FUTURE_QUALITY_EVIDENCE']);
  }
  const fillsDeclared = (
    coverage.fills === 'complete' || coverage.fills === 'partial'
  );
  const legacyContradiction = (
    (snapshot.status === 'FAILED' && snapshot.usableForAnalytics)
    || (
      snapshot.accountScope === 'UNVERIFIED'
      && (snapshot.status !== 'FAILED' || snapshot.usableForAnalytics)
    )
    || (
      snapshot.status === 'VALID'
      && (
        !snapshot.usableForAnalytics
        || BUNDLE_DATASETS.some((dataset) => coverage[dataset] !== 'complete')
      )
    )
    || (
      snapshot.usableForAnalytics
      && (
        snapshot.accountScope !== 'BOUND'
        || updatedAt <= 0
        || successfulThrough <= 0
        || !fillsDeclared
      )
    )
    || (!updatedAt && ageMs !== null)
    || (updatedAt > 0 && ageMs === null)
  );
  if (legacyContradiction) {
    return failedBundleQualityV2(['CONTRADICTORY_QUALITY_CONTRACT']);
  }
  if (
    dataStatus === 'LEGACY_UNBOUND'
    || snapshot.accountScope !== 'BOUND'
    || snapshot.status === 'FAILED'
  ) {
    return failedBundleQualityV2([
      dataStatus === 'LEGACY_UNBOUND' ? 'LEGACY_UNBOUND' : 'QUALITY_FAILED',
    ]);
  }

  const browsableCoverage = ['fills', 'orders', 'income'].some((dataset) => (
    coverage[dataset] === 'complete' || coverage[dataset] === 'partial'
  ));
  const recordsBrowsable = updatedAt > 0 && browsableCoverage
    ? { decision: 'LIMITED', reasonCodes: ['LEGACY_QUALITY_BROWSE_ONLY'] }
    : { decision: 'DENY', reasonCodes: ['NO_BROWSABLE_RECORDS'] };
  const status = (
    snapshot.status === 'STALE' || dataStatus === 'CACHED_ONLY'
  ) ? 'STALE' : 'PARTIAL';
  return v2FreezeQuality({
    status,
    accountScope: 'BOUND',
    updatedAt,
    successfulThrough,
    ageMs,
    coverage,
    observedRange: null,
    capabilities: {
      recordsBrowsable,
      observedTradeAnalytics: {
        decision: 'DENY',
        reasonCodes: ['LEGACY_QUALITY_BROWSE_ONLY'],
      },
      accountKpis: {
        decision: 'DENY',
        reasonCodes: ['RECONCILIATION_NOT_AVAILABLE'],
      },
      currentPositions: {
        decision: 'DENY',
        reasonCodes: ['CURRENT_POSITIONS_NOT_PUBLISHED'],
      },
      equityAnalytics: {
        decision: 'DENY',
        reasonCodes: ['RECONCILIATION_NOT_AVAILABLE'],
      },
      ledger: {
        decision: 'DENY',
        reasonCodes: ['LEDGER_NOT_IMPLEMENTED'],
      },
    },
    reasonCodes: [...new Set([
      ...reasonCodes,
      'LEGACY_QUALITY_BROWSE_ONLY',
    ])].sort(),
  });
}

export function normalizeBundleQualityV2(bundle, options = {}) {
  const optionSnapshot = v2SnapshotRecord(
    options,
    new Set(['now']),
    { exact: false },
  );
  if (!optionSnapshot) return failedBundleQualityV2();
  const now = Object.hasOwn(optionSnapshot, 'now')
    ? v2SafeTimestamp(optionSnapshot.now)
    : Date.now();
  if (now === null) return failedBundleQualityV2();
  const metaField = v2OwnDataField(bundle, '_meta');
  if (!metaField.ok) return failedBundleQualityV2();
  const dataStatusField = v2OwnDataField(metaField.value, 'dataStatus');
  const qualityField = v2OwnDataField(metaField.value, 'quality');
  if (
    !dataStatusField.ok
    || !BUNDLE_DATA_STATUSES.has(dataStatusField.value)
    || !qualityField.ok
  ) {
    return failedBundleQualityV2();
  }
  const protocolField = v2OwnDataField(qualityField.value, 'protocol');
  if (!protocolField.ok) return failedBundleQualityV2();
  if (protocolField.value === BUNDLE_QUALITY_PROTOCOL) {
    return normalizeLegacyBundleQualityV1(
      qualityField.value,
      dataStatusField.value,
      now,
    );
  }
  if (protocolField.value !== BUNDLE_QUALITY_V2_PROTOCOL) {
    return failedBundleQualityV2();
  }
  const syncWindowField = v2OwnDataField(bundle, 'syncWindow');
  return normalizeNativeBundleQualityV2(
    qualityField.value,
    dataStatusField.value,
    syncWindowField.ok ? syncWindowField.value : null,
    now,
  );
}
