const LEDGER_PROTOCOL = 'rv-ledger-projection/1';
const RECONCILIATION_PROTOCOL = 'rv-reconciliation/2';
const PROMOTION_PROTOCOL = 'rv-ledger-promotion/1';
const MAX_DECIMAL_SCALE = 24;
const MAX_INTEGER_DIGITS = 40;
const ASSET_METRICS = Object.freeze([
  'walletChange',
  'realizedPnl',
  'commission',
  'funding',
  'suspense',
]);
const PROMOTION_STAGES = new Set([
  'SHADOW',
  'PARITY_OBSERVING',
  'PARITY_PASSED',
  'PRIMARY',
  'HALTED',
]);

function ledgerError(code, detail = '') {
  const suffix = detail ? `:${detail}` : '';
  const error = new Error(`${code}${suffix}`);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDecimal(value, field, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw ledgerError('LEDGER_INVALID_DECIMAL', field);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawWhole, rawFraction = ''] = unsigned.split('.');
  if (rawWhole.length > MAX_INTEGER_DIGITS || rawFraction.length > MAX_DECIMAL_SCALE) {
    throw ledgerError('LEDGER_DECIMAL_OUT_OF_RANGE', field);
  }
  const whole = rawWhole.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  const scale = fraction.length;
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  let units = BigInt(digits);
  if (negative && units !== 0n) units = -units;
  if (positive && units <= 0n) throw ledgerError('LEDGER_NON_POSITIVE_DECIMAL', field);
  return { units, scale };
}

function decimalFromInteger(units) {
  return { units: BigInt(units), scale: 0 };
}

function decimalAlign(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.units * (10n ** BigInt(scale - left.scale)),
    right: right.units * (10n ** BigInt(scale - right.scale)),
    scale,
  };
}

function decimalAdd(left, right) {
  const aligned = decimalAlign(left, right);
  return { units: aligned.left + aligned.right, scale: aligned.scale };
}

function decimalSubtract(left, right) {
  return decimalAdd(left, { units: -right.units, scale: right.scale });
}

function decimalNegate(value) {
  return { units: -value.units, scale: value.scale };
}

function decimalCompare(left, right) {
  const aligned = decimalAlign(left, right);
  if (aligned.left < aligned.right) return -1;
  if (aligned.left > aligned.right) return 1;
  return 0;
}

function decimalAbs(value) {
  return { units: value.units < 0n ? -value.units : value.units, scale: value.scale };
}

function decimalText(value) {
  if (value.units === 0n) return '0';
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(value.scale + 1, '0');
  const splitAt = padded.length - value.scale;
  const whole = padded.slice(0, splitAt);
  const fraction = padded.slice(splitAt).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function validateAsset(value, field) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{2,16}$/.test(value)) {
    throw ledgerError('LEDGER_INVALID_ASSET', field);
  }
  return value;
}

function validateSymbol(value, field) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{3,32}$/.test(value)) {
    throw ledgerError('LEDGER_INVALID_SYMBOL', field);
  }
  return value;
}

function validateTime(value, field) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw ledgerError('LEDGER_INVALID_TIME', field);
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,128}$/.test(value)) throw ledgerError('LEDGER_INVALID_TIME', field);
  return BigInt(value).toString();
}

function sourceIdentifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw ledgerError('LEDGER_INVALID_SOURCE_ID', field);
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw ledgerError('LEDGER_INVALID_SOURCE_ID', field);
  }
  const result = String(value);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(result)) throw ledgerError('LEDGER_INVALID_SOURCE_ID', field);
  return result;
}

function compareProviderId(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return left.localeCompare(right, 'en');
}

function normalizeFill(input, index) {
  if (!isRecord(input)) throw ledgerError('LEDGER_INVALID_FILL', String(index));
  const symbol = validateSymbol(input.symbol, `fills[${index}].symbol`);
  const settlementAsset = symbol.endsWith('USDT')
    ? 'USDT'
    : symbol.endsWith('USDC')
      ? 'USDC'
      : null;
  if (settlementAsset === null) {
    throw ledgerError('LEDGER_UNSUPPORTED_SETTLEMENT_ASSET', `fills[${index}].symbol`);
  }
  const id = sourceIdentifier(input.id ?? input.tradeId, `fills[${index}].id`);
  const side = input.side;
  if (side !== 'BUY' && side !== 'SELL') throw ledgerError('LEDGER_INVALID_SIDE', `fills[${index}].side`);
  const positionSide = input.positionSide ?? 'BOTH';
  if (!['BOTH', 'LONG', 'SHORT'].includes(positionSide)) {
    throw ledgerError('LEDGER_INVALID_POSITION_SIDE', `fills[${index}].positionSide`);
  }
  const quantity = parseDecimal(input.qty ?? input.quantity, `fills[${index}].qty`, { positive: true });
  const price = parseDecimal(input.price, `fills[${index}].price`, { positive: true });
  const realizedPnl = parseDecimal(input.realizedPnl ?? '0', `fills[${index}].realizedPnl`);
  const commission = parseDecimal(input.commission ?? '0', `fills[${index}].commission`);
  const realizedPnlAsset = validateAsset(
    input.realizedPnlAsset,
    `fills[${index}].realizedPnlAsset`,
  );
  if (realizedPnlAsset !== settlementAsset) {
    throw ledgerError('LEDGER_SETTLEMENT_ASSET_MISMATCH', `fills[${index}].realizedPnlAsset`);
  }
  const commissionAsset = validateAsset(
    input.commissionAsset,
    `fills[${index}].commissionAsset`,
  );
  return {
    symbol,
    id,
    sourceKey: `${symbol}:${id}`,
    time: validateTime(input.time, `fills[${index}].time`),
    side,
    positionSide,
    quantity,
    price,
    realizedPnl,
    realizedPnlAsset,
    commission,
    commissionAsset,
  };
}

function normalizeIncome(input, index) {
  if (!isRecord(input)) throw ledgerError('LEDGER_INVALID_INCOME', String(index));
  const symbol = input.symbol === '' || input.symbol === undefined || input.symbol === null
    ? null
    : validateSymbol(input.symbol, `income[${index}].symbol`);
  const tranId = sourceIdentifier(input.tranId ?? input.id, `income[${index}].tranId`);
  const incomeType = input.incomeType;
  if (typeof incomeType !== 'string' || !/^[A-Z0-9_]{2,64}$/.test(incomeType)) {
    throw ledgerError('LEDGER_INVALID_INCOME_TYPE', `income[${index}].incomeType`);
  }
  return {
    symbol,
    tranId,
    sourceKey: `${incomeType}:${symbol ?? 'ACCOUNT'}:${tranId}`,
    time: validateTime(input.time, `income[${index}].time`),
    incomeType,
    asset: validateAsset(input.asset, `income[${index}].asset`),
    amount: parseDecimal(input.income ?? input.amount, `income[${index}].income`),
  };
}

function compareSourceRows(left, right) {
  if (left.time !== right.time) return BigInt(left.time) < BigInt(right.time) ? -1 : 1;
  const leftId = left.id ?? left.tranId;
  const rightId = right.id ?? right.tranId;
  const byId = compareProviderId(leftId, rightId);
  if (byId !== 0) return byId;
  return left.sourceKey.localeCompare(right.sourceKey, 'en');
}

function assertUniqueSourceKeys(rows, dataset) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.sourceKey)) throw ledgerError('LEDGER_DUPLICATE_SOURCE', `${dataset}:${row.sourceKey}`);
    seen.add(row.sourceKey);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positionTransition(before, after, delta) {
  const zero = decimalFromInteger(0n);
  const beforeSign = decimalCompare(before, zero);
  const afterSign = decimalCompare(after, zero);
  const direction = (sign) => (sign > 0 ? 'LONG' : 'SHORT');
  if (beforeSign === 0) {
    return {
      transition: `OPEN_${direction(afterSign)}`,
      closeQuantity: zero,
      openQuantity: decimalAbs(delta),
    };
  }
  if (afterSign === 0) {
    return {
      transition: `CLOSE_${direction(beforeSign)}`,
      closeQuantity: decimalAbs(before),
      openQuantity: zero,
    };
  }
  if (beforeSign !== afterSign) {
    return {
      transition: `FLIP_${direction(beforeSign)}_TO_${direction(afterSign)}`,
      closeQuantity: decimalAbs(before),
      openQuantity: decimalAbs(after),
    };
  }
  if (decimalCompare(decimalAbs(after), decimalAbs(before)) > 0) {
    return {
      transition: `INCREASE_${direction(afterSign)}`,
      closeQuantity: zero,
      openQuantity: decimalAbs(delta),
    };
  }
  return {
    transition: `REDUCE_${direction(beforeSign)}`,
    closeQuantity: decimalAbs(delta),
    openQuantity: zero,
  };
}

function projectPositions(fills) {
  const quantities = new Map();
  const deltas = [];
  for (const fill of fills) {
    const key = `${fill.symbol}|${fill.positionSide}`;
    const before = quantities.get(key) ?? decimalFromInteger(0n);
    const delta = fill.side === 'BUY' ? fill.quantity : decimalNegate(fill.quantity);
    const after = decimalAdd(before, delta);
    if (decimalCompare(before, decimalFromInteger(0n)) === 0 && (
      (fill.positionSide === 'LONG' && fill.side !== 'BUY')
      || (fill.positionSide === 'SHORT' && fill.side !== 'SELL')
    )) {
      throw ledgerError('LEDGER_HEDGE_DIRECTION_INVALID', fill.sourceKey);
    }
    if (
      (fill.positionSide === 'LONG' && decimalCompare(after, decimalFromInteger(0n)) < 0)
      || (fill.positionSide === 'SHORT' && decimalCompare(after, decimalFromInteger(0n)) > 0)
    ) {
      throw ledgerError('LEDGER_HEDGE_OVER_CLOSE', fill.sourceKey);
    }
    const allocation = positionTransition(before, after, delta);
    quantities.set(key, after);
    deltas.push({
      sourceKey: fill.sourceKey,
      symbol: fill.symbol,
      positionSide: fill.positionSide,
      side: fill.side,
      executionPrice: decimalText(fill.price),
      delta: decimalText(delta),
      quantityBefore: decimalText(before),
      closeQuantity: decimalText(allocation.closeQuantity),
      openQuantity: decimalText(allocation.openQuantity),
      quantityAfter: decimalText(after),
      transition: allocation.transition,
    });
  }
  const sideOrder = { BOTH: 0, LONG: 1, SHORT: 2 };
  const positions = [...quantities.entries()]
    .map(([key, quantity]) => {
      const separator = key.lastIndexOf('|');
      return {
        symbol: key.slice(0, separator),
        positionSide: key.slice(separator + 1),
        quantity: decimalText(quantity),
      };
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol, 'en')
      || sideOrder[left.positionSide] - sideOrder[right.positionSide]);
  return { positionDeltas: deltas, positions };
}

function accountForEffect(effectType, walletEffect, asset) {
  const positive = decimalCompare(walletEffect, decimalFromInteger(0n)) >= 0;
  if (effectType === 'REALIZED_PNL') {
    return `${positive ? 'income' : 'expense'}:realized_pnl:${asset}`;
  }
  if (effectType === 'COMMISSION') {
    return `${positive ? 'income:commission_rebate' : 'expense:commission'}:${asset}`;
  }
  if (effectType === 'FUNDING') {
    return `${positive ? 'income' : 'expense'}:funding:${asset}`;
  }
  return `suspense:unclassified:${asset}`;
}

function makeEntry({ source, effectType, asset, walletEffect, provisional, occurredAt }) {
  const counter = accountForEffect(effectType, walletEffect, asset);
  return {
    entryId: `ledger:${source.dataset}:${source.sourceKey}:${effectType.toLowerCase()}`,
    occurredAt,
    effectType,
    provisional,
    source,
    postings: [
      { account: `asset:wallet:${asset}`, asset, signedAmount: decimalText(walletEffect) },
      { account: counter, asset, signedAmount: decimalText(decimalNegate(walletEffect)) },
    ],
  };
}

function incomeEffectType(incomeType) {
  if (incomeType === 'REALIZED_PNL') return 'REALIZED_PNL';
  if (incomeType === 'COMMISSION' || incomeType === 'COMMISSION_REBATE') return 'COMMISSION';
  if (incomeType === 'FUNDING_FEE') return 'FUNDING';
  return 'SUSPENSE';
}

function projectMonetaryEntries(fills, incomeRows, incomeCoverage) {
  const entries = [];
  const warnings = [];
  if (incomeCoverage !== 'COMPLETE') {
    for (const fill of fills) {
      const source = { dataset: 'fills', sourceKey: fill.sourceKey };
      if (fill.realizedPnl.units !== 0n) {
        entries.push(makeEntry({
          source,
          effectType: 'REALIZED_PNL',
          asset: fill.realizedPnlAsset,
          walletEffect: fill.realizedPnl,
          provisional: true,
          occurredAt: fill.time,
        }));
      }
      if (fill.commission.units !== 0n) {
        entries.push(makeEntry({
          source,
          effectType: 'COMMISSION',
          asset: fill.commissionAsset,
          walletEffect: decimalNegate(fill.commission),
          provisional: true,
          occurredAt: fill.time,
        }));
      }
    }
  }
  for (const row of incomeRows) {
    const effectType = incomeEffectType(row.incomeType);
    if (incomeCoverage !== 'COMPLETE' && (effectType === 'REALIZED_PNL' || effectType === 'COMMISSION')) {
      warnings.push(`INCOME_NOT_AUTHORITATIVE:${row.sourceKey}`);
      continue;
    }
    if (row.amount.units === 0n) continue;
    entries.push(makeEntry({
      source: { dataset: 'income', sourceKey: row.sourceKey },
      effectType,
      asset: row.asset,
      walletEffect: row.amount,
      provisional: false,
      occurredAt: row.time,
    }));
    if (effectType === 'SUSPENSE') warnings.push(`UNCLASSIFIED_INCOME:${row.sourceKey}`);
  }
  const typeOrder = { REALIZED_PNL: 0, COMMISSION: 1, FUNDING: 2, SUSPENSE: 3 };
  entries.sort((left, right) => left.occurredAt - right.occurredAt
    || left.source.dataset.localeCompare(right.source.dataset, 'en')
    || left.source.sourceKey.localeCompare(right.source.sourceKey, 'en')
    || typeOrder[left.effectType] - typeOrder[right.effectType]);
  warnings.sort((left, right) => left.localeCompare(right, 'en'));
  return { entries, warnings };
}

function sumAssetTotals(entries) {
  const totals = new Map();
  const zero = () => ({
    walletChange: decimalFromInteger(0n),
    realizedPnl: decimalFromInteger(0n),
    commission: decimalFromInteger(0n),
    funding: decimalFromInteger(0n),
    suspense: decimalFromInteger(0n),
  });
  for (const entry of entries) {
    const wallet = entry.postings[0];
    const values = totals.get(wallet.asset) ?? zero();
    const effect = parseDecimal(wallet.signedAmount, `${entry.entryId}.wallet`);
    values.walletChange = decimalAdd(values.walletChange, effect);
    const metric = entry.effectType === 'REALIZED_PNL'
      ? 'realizedPnl'
      : entry.effectType === 'COMMISSION'
        ? 'commission'
        : entry.effectType === 'FUNDING'
          ? 'funding'
          : 'suspense';
    values[metric] = decimalAdd(values[metric], effect);
    totals.set(wallet.asset, values);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([asset, values]) => ({
      asset,
      ...Object.fromEntries(ASSET_METRICS.map((metric) => [metric, decimalText(values[metric])])),
    }));
}

export function projectBinanceUsdmLedger(input) {
  if (!isRecord(input)) throw ledgerError('LEDGER_INVALID_INPUT');
  if (!Array.isArray(input.fills ?? []) || !Array.isArray(input.income ?? [])) {
    throw ledgerError('LEDGER_INVALID_INPUT_COLLECTION');
  }
  const fills = (input.fills ?? []).map(normalizeFill).sort(compareSourceRows);
  const incomeRows = (input.income ?? []).map(normalizeIncome).sort(compareSourceRows);
  assertUniqueSourceKeys(fills, 'fills');
  assertUniqueSourceKeys(incomeRows, 'income');
  const incomeCoverage = input.incomeCoverage ?? 'PARTIAL';
  if (incomeCoverage !== 'PARTIAL' && incomeCoverage !== 'COMPLETE') {
    throw ledgerError('LEDGER_INVALID_INCOME_COVERAGE');
  }
  const monetary = projectMonetaryEntries(fills, incomeRows, incomeCoverage);
  const position = projectPositions(fills);
  return deepFreeze({
    protocol: LEDGER_PROTOCOL,
    incomeCoverage,
    entries: monetary.entries,
    positionDeltas: position.positionDeltas,
    positions: position.positions,
    assetTotals: sumAssetTotals(monetary.entries),
    warnings: monetary.warnings,
  });
}

function normalizeTotals(rows, field) {
  if (!Array.isArray(rows)) throw ledgerError('LEDGER_INVALID_RECONCILIATION_TOTALS', field);
  const result = new Map();
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw ledgerError('LEDGER_INVALID_RECONCILIATION_TOTAL', `${field}[${index}]`);
    const asset = validateAsset(row.asset, `${field}[${index}].asset`);
    if (result.has(asset)) throw ledgerError('LEDGER_DUPLICATE_RECONCILIATION_ASSET', asset);
    result.set(asset, Object.fromEntries(ASSET_METRICS.map((metric) => [
      metric,
      parseDecimal(row[metric] ?? '0', `${field}[${index}].${metric}`),
    ])));
  }
  return result;
}

function normalizePositions(rows, field) {
  if (!Array.isArray(rows)) throw ledgerError('LEDGER_INVALID_RECONCILIATION_POSITIONS', field);
  const result = new Map();
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw ledgerError('LEDGER_INVALID_RECONCILIATION_POSITION', `${field}[${index}]`);
    const symbol = validateSymbol(row.symbol, `${field}[${index}].symbol`);
    const positionSide = row.positionSide;
    if (!['BOTH', 'LONG', 'SHORT'].includes(positionSide)) {
      throw ledgerError('LEDGER_INVALID_POSITION_SIDE', `${field}[${index}].positionSide`);
    }
    const key = `${symbol}|${positionSide}`;
    if (result.has(key)) throw ledgerError('LEDGER_DUPLICATE_RECONCILIATION_POSITION', key);
    result.set(key, parseDecimal(row.quantity, `${field}[${index}].quantity`));
  }
  return result;
}

function entriesBalance(entries) {
  if (!Array.isArray(entries)) return false;
  try {
    for (const [entryIndex, entry] of entries.entries()) {
      if (!isRecord(entry) || !Array.isArray(entry.postings) || entry.postings.length < 2) return false;
      const totals = new Map();
      for (const [postingIndex, posting] of entry.postings.entries()) {
        if (!isRecord(posting)) return false;
        const asset = validateAsset(posting.asset, `entries[${entryIndex}].postings[${postingIndex}].asset`);
        const amount = parseDecimal(
          posting.signedAmount,
          `entries[${entryIndex}].postings[${postingIndex}].signedAmount`,
        );
        totals.set(asset, decimalAdd(totals.get(asset) ?? decimalFromInteger(0n), amount));
      }
      if ([...totals.values()].some((value) => value.units !== 0n)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw ledgerError('LEDGER_INVALID_GENERATION');
  return value;
}

export function reconcileLedgerProjection(input) {
  if (!isRecord(input) || !isRecord(input.projection) || !isRecord(input.oracle)) {
    throw ledgerError('LEDGER_INVALID_RECONCILIATION_INPUT');
  }
  if (input.projection.protocol !== LEDGER_PROTOCOL) throw ledgerError('LEDGER_WRONG_PROJECTION_PROTOCOL');
  if (typeof input.realGeneration !== 'boolean') throw ledgerError('LEDGER_INVALID_REAL_GENERATION');
  const generation = validateGeneration(input.generation);
  const projectedTotals = normalizeTotals(input.projection.assetTotals, 'projection.assetTotals');
  const oracleTotals = normalizeTotals(input.oracle.assetTotals, 'oracle.assetTotals');
  const projectedPositions = normalizePositions(input.projection.positions, 'projection.positions');
  const oraclePositions = normalizePositions(input.oracle.positions, 'oracle.positions');
  const diffs = [];
  const assets = [...new Set([...projectedTotals.keys(), ...oracleTotals.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const zeroTotals = Object.fromEntries(ASSET_METRICS.map((metric) => [metric, decimalFromInteger(0n)]));
  for (const asset of assets) {
    const projected = projectedTotals.get(asset) ?? zeroTotals;
    const oracle = oracleTotals.get(asset) ?? zeroTotals;
    for (const metric of ASSET_METRICS) {
      if (decimalCompare(projected[metric], oracle[metric]) === 0) continue;
      diffs.push({
        scope: 'asset',
        key: asset,
        metric,
        projected: decimalText(projected[metric]),
        oracle: decimalText(oracle[metric]),
        delta: decimalText(decimalSubtract(projected[metric], oracle[metric])),
      });
    }
  }
  const positionKeys = [...new Set([...projectedPositions.keys(), ...oraclePositions.keys()])]
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const key of positionKeys) {
    const projected = projectedPositions.get(key) ?? decimalFromInteger(0n);
    const oracle = oraclePositions.get(key) ?? decimalFromInteger(0n);
    if (decimalCompare(projected, oracle) === 0) continue;
    diffs.push({
      scope: 'position',
      key,
      metric: 'quantity',
      projected: decimalText(projected),
      oracle: decimalText(oracle),
      delta: decimalText(decimalSubtract(projected, oracle)),
    });
  }
  const balanced = entriesBalance(input.projection.entries);
  const assetParity = !diffs.some((diff) => diff.scope === 'asset');
  const positionParity = !diffs.some((diff) => diff.scope === 'position');
  const reasonCodes = [];
  if (!balanced) reasonCodes.push('UNBALANCED_LEDGER_ENTRY');
  if (!assetParity) reasonCodes.push('ASSET_PARITY_MISMATCH');
  if (!positionParity) reasonCodes.push('POSITION_PARITY_MISMATCH');
  return deepFreeze({
    protocol: RECONCILIATION_PROTOCOL,
    generation,
    realGeneration: input.realGeneration,
    status: reasonCodes.length === 0 ? 'PASS' : 'FAIL',
    reasonCodes,
    checks: {
      balancedEntries: balanced ? 'PASS' : 'FAIL',
      assetParity: assetParity ? 'PASS' : 'FAIL',
      positionParity: positionParity ? 'PASS' : 'FAIL',
    },
    diffs,
  });
}

export function createLedgerPromotionState() {
  return deepFreeze({
    protocol: PROMOTION_PROTOCOL,
    stage: 'SHADOW',
    consecutiveZeroDiffRealGenerations: 0,
    lastRealGeneration: null,
    lastOutcome: 'NONE',
  });
}

function validatePromotionState(state) {
  if (
    !isRecord(state)
    || state.protocol !== PROMOTION_PROTOCOL
    || !PROMOTION_STAGES.has(state.stage)
    || !Number.isSafeInteger(state.consecutiveZeroDiffRealGenerations)
    || state.consecutiveZeroDiffRealGenerations < 0
    || (state.lastRealGeneration !== null
      && (!Number.isSafeInteger(state.lastRealGeneration) || state.lastRealGeneration < 1))
  ) {
    throw ledgerError('LEDGER_INVALID_PROMOTION_STATE');
  }
}

function validatePromotionReconciliation(reconciliation) {
  if (
    !isRecord(reconciliation)
    || reconciliation.protocol !== RECONCILIATION_PROTOCOL
    || !['PASS', 'FAIL'].includes(reconciliation.status)
    || !Array.isArray(reconciliation.reasonCodes)
    || !Array.isArray(reconciliation.diffs)
    || !isRecord(reconciliation.checks)
  ) {
    throw ledgerError('LEDGER_INVALID_PROMOTION_RECONCILIATION');
  }
  const checkNames = ['assetParity', 'balancedEntries', 'positionParity'];
  const actualCheckNames = Object.keys(reconciliation.checks).sort();
  if (
    actualCheckNames.length !== checkNames.length
    || actualCheckNames.some((name, index) => name !== checkNames[index])
    || actualCheckNames.some((name) => !['PASS', 'FAIL'].includes(reconciliation.checks[name]))
    || reconciliation.reasonCodes.some((code) => (
      typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ))
  ) {
    throw ledgerError('LEDGER_INVALID_PROMOTION_RECONCILIATION');
  }
  const zeroDiff = reconciliation.diffs.length === 0;
  const zeroReason = reconciliation.reasonCodes.length === 0;
  const allChecksPass = actualCheckNames.every((name) => reconciliation.checks[name] === 'PASS');
  const passConsistent = reconciliation.status === 'PASS' && zeroDiff && zeroReason && allChecksPass;
  const failConsistent = reconciliation.status === 'FAIL'
    && (!zeroDiff || !zeroReason || !allChecksPass);
  if (!passConsistent && !failConsistent) {
    throw ledgerError('LEDGER_RECONCILIATION_INCONSISTENT');
  }
  return passConsistent;
}

export function advanceLedgerPromotion(state, reconciliation, options = {}) {
  validatePromotionState(state);
  const zeroDiffPass = validatePromotionReconciliation(reconciliation);
  if (!isRecord(options) || (options.activatePrimary !== undefined && typeof options.activatePrimary !== 'boolean')) {
    throw ledgerError('LEDGER_INVALID_PROMOTION_OPTIONS');
  }
  const generation = validateGeneration(reconciliation.generation);
  if (typeof reconciliation.realGeneration !== 'boolean') {
    throw ledgerError('LEDGER_INVALID_REAL_GENERATION');
  }
  if (!reconciliation.realGeneration) {
    if (options.activatePrimary) throw ledgerError('LEDGER_PROMOTION_NOT_READY');
    return deepFreeze({ ...state, lastOutcome: 'IGNORED_NON_REAL' });
  }
  if (state.lastRealGeneration !== null && generation <= state.lastRealGeneration) {
    throw ledgerError('LEDGER_GENERATION_REPLAY');
  }
  if (options.activatePrimary && state.stage !== 'PARITY_PASSED' && state.stage !== 'PRIMARY') {
    throw ledgerError('LEDGER_PROMOTION_NOT_READY');
  }
  if (!zeroDiffPass) {
    return deepFreeze({
      ...state,
      stage: state.stage === 'PRIMARY'
        ? 'HALTED'
        : state.stage === 'HALTED'
          ? 'HALTED'
        : state.stage === 'SHADOW'
          ? 'SHADOW'
          : 'PARITY_OBSERVING',
      consecutiveZeroDiffRealGenerations: 0,
      lastRealGeneration: generation,
      lastOutcome: 'FAIL',
    });
  }
  const streak = state.consecutiveZeroDiffRealGenerations + 1;
  let stage = state.stage;
  if (stage === 'HALTED') {
    return deepFreeze({
      ...state,
      stage: 'HALTED',
      consecutiveZeroDiffRealGenerations: 0,
      lastRealGeneration: generation,
      lastOutcome: 'PASS_AFTER_HALT',
    });
  }
  if (stage === 'SHADOW') stage = 'PARITY_OBSERVING';
  if (stage === 'PARITY_OBSERVING' && streak >= 7) stage = 'PARITY_PASSED';
  if (options.activatePrimary && (state.stage === 'PARITY_PASSED' || state.stage === 'PRIMARY')) stage = 'PRIMARY';
  return deepFreeze({
    ...state,
    stage,
    consecutiveZeroDiffRealGenerations: streak,
    lastRealGeneration: generation,
    lastOutcome: 'PASS',
  });
}

export {
  LEDGER_PROTOCOL,
  PROMOTION_PROTOCOL,
  RECONCILIATION_PROTOCOL,
};
