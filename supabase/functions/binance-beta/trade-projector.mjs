export const TRADE_ID_PROTOCOL = 'rv2-trade-id/1';
export const TRADE_READ_MODEL_PROTOCOL = 'rv2-trade-read-model/1';
export const TRADE_LINEAGE_PROTOCOL = 'rv2-trade-lineage/1';
export const TRADE_PAYLOAD_PROTOCOL = 'rv2-trade-payload/1';

const REQUIRED_FILL_KEYS = Object.freeze([
  'baseQty', 'commission', 'commissionAsset', 'id', 'pair', 'positionSide',
  'price', 'qty', 'quoteQty', 'realizedPnl', 'realizedPnlAsset', 'side',
  'symbol', 'time',
]);
const SORTED_FILL_KEYS = Object.freeze([...REQUIRED_FILL_KEYS].sort());
const SYMBOL_PATTERN = /^[A-Z0-9]{2,24}(?:USDT|USDC)$/u;
const ASSET_PATTERN = /^[A-Z0-9]{2,16}$/u;
const DECIMAL_ID_PATTERN = /^(?:0|[1-9][0-9]{0,39})$/u;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/u;
const SIGNED_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/u;
const OUTPUT_SCALE = 18;

function fail(code) {
  throw new Error(code);
}

function exactObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TRADE_PROJECTOR_INVALID_FILL');
  }
  const actual = Object.keys(value).sort();
  if (actual.length !== SORTED_FILL_KEYS.length
    || actual.some((key, index) => key !== SORTED_FILL_KEYS[index])) {
    fail('TRADE_PROJECTOR_UNEXPECTED_FIELD');
  }
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function fraction(numerator, denominator = 1n) {
  if (denominator === 0n) fail('TRADE_PROJECTOR_DIVIDE_BY_ZERO');
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return Object.freeze({
    numerator: (numerator / divisor) * sign,
    denominator: (denominator / divisor) * sign,
  });
}

function decimal(value, { allowZero = true, signed = false } = {}) {
  const text = typeof value === 'string' ? value : '';
  if (!(signed ? SIGNED_DECIMAL_PATTERN : UNSIGNED_DECIMAL_PATTERN).test(text)) {
    fail('TRADE_PROJECTOR_INVALID_DECIMAL');
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fractional = ''] = unsigned.split('.');
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(`${whole}${fractional}`) * (negative ? -1n : 1n);
  if (!allowZero && numerator <= 0n) fail('TRADE_PROJECTOR_INVALID_DECIMAL');
  return fraction(numerator, denominator);
}

function add(left, right) {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left, right) {
  return fraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left, right) {
  return fraction(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left, right) {
  if (right.numerator === 0n) fail('TRADE_PROJECTOR_DIVIDE_BY_ZERO');
  return fraction(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compare(left, right) {
  const delta = left.numerator * right.denominator - right.numerator * left.denominator;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}

function absolute(value) {
  return fraction(value.numerator < 0n ? -value.numerator : value.numerator, value.denominator);
}

function canonicalFraction(value) {
  if (value.numerator === 0n) return '0';
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  const factor = 10n ** BigInt(OUTPUT_SCALE);
  let scaled = (numerator * factor) / value.denominator;
  const remainder = (numerator * factor) % value.denominator;
  // PostgreSQL round(numeric, 18) rounds a half away from zero.
  if (remainder * 2n >= value.denominator) scaled += 1n;
  const digits = scaled.toString().padStart(OUTPUT_SCALE + 1, '0');
  const whole = digits.slice(0, -OUTPUT_SCALE);
  const fractional = digits.slice(-OUTPUT_SCALE).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fractional ? `.${fractional}` : ''}`;
}

function sourceOrder(left, right) {
  const leftTime = BigInt(left.time);
  const rightTime = BigInt(right.time);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return left.symbol.localeCompare(right.symbol, 'en');
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function tradeIdentityMaterial(payload, sourceLineage) {
  return [
    TRADE_ID_PROTOCOL, 'binance', 'usdm', payload.symbol, payload.side,
    payload.positionSide, String(payload.entryTime), String(payload.exitTime),
    ...sourceLineage,
  ].join('\u0000');
}

export function tradeLineageMaterial(sourceLineage) {
  return [TRADE_LINEAGE_PROTOCOL, ...sourceLineage].join('\u0000');
}

export function tradePayloadMaterial(payload) {
  return [
    TRADE_PAYLOAD_PROTOCOL, payload.id, payload.symbol, payload.side,
    payload.positionSide, String(payload.entryTime), String(payload.exitTime),
    payload.entryPrice, payload.exitPrice, payload.qty, payload.notional,
    payload.realizedPnl, payload.realizedPnlAsset,
    ...payload.commissionByAsset.flatMap((row) => [row.asset, row.amount]),
    payload.source,
  ].join('\u0000');
}

function normalizeFill(fill) {
  exactObject(fill);
  if (!DECIMAL_ID_PATTERN.test(fill.id)) fail('TRADE_PROJECTOR_INVALID_SOURCE_ID');
  if (!SYMBOL_PATTERN.test(fill.symbol)) fail('TRADE_PROJECTOR_INVALID_SYMBOL');
  if (fill.side !== 'BUY' && fill.side !== 'SELL') fail('TRADE_PROJECTOR_INVALID_SIDE');
  if (!['BOTH', 'LONG', 'SHORT'].includes(fill.positionSide)) {
    fail('TRADE_PROJECTOR_INVALID_POSITION_SIDE');
  }
  if (!/^[0-9]{13}$/u.test(fill.time)) fail('TRADE_PROJECTOR_INVALID_TIME');
  if (fill.pair !== fill.symbol
    || decimal(fill.baseQty).numerator !== 0n
    || decimal(fill.quoteQty, { allowZero: false }).numerator <= 0n) {
    fail('TRADE_PROJECTOR_PRODUCT_PROOF_INVALID');
  }
  if (!ASSET_PATTERN.test(fill.commissionAsset)
    || !['USDT', 'USDC'].includes(fill.realizedPnlAsset)) {
    fail('TRADE_PROJECTOR_UNSUPPORTED_ASSET');
  }
  const settlementAsset = fill.symbol.endsWith('USDT') ? 'USDT' : 'USDC';
  if (fill.realizedPnlAsset !== settlementAsset) {
    fail('TRADE_PROJECTOR_PRODUCT_PROOF_INVALID');
  }
  return Object.freeze({
    id: fill.id,
    sourceRef: `binance-usdm:fills:${fill.symbol}:${fill.id}`,
    symbol: fill.symbol,
    side: fill.side,
    positionSide: fill.positionSide,
    time: fill.time,
    price: decimal(fill.price, { allowZero: false }),
    qty: decimal(fill.qty, { allowZero: false }),
    fee: decimal(fill.commission, { signed: true }),
    feeAsset: fill.commissionAsset,
    pnl: decimal(fill.realizedPnl, { signed: true }),
    pnlAsset: fill.realizedPnlAsset,
  });
}

function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function hedgeDirectionAllowed(positionSide, direction) {
  return positionSide === 'BOTH'
    || (positionSide === 'LONG' && direction === 1)
    || (positionSide === 'SHORT' && direction === -1);
}

function addCommission(commissions, asset, amount) {
  commissions.set(asset, add(commissions.get(asset) ?? fraction(0n), amount));
}

function startState(fill, direction, qty = fill.qty, fee = fill.fee, reportedPnl = fill.pnl) {
  const commissions = new Map();
  addCommission(commissions, fill.feeAsset, fee);
  return {
    direction,
    positionQty: multiply(fraction(BigInt(direction)), qty),
    positionValue: multiply(fill.price, qty),
    entryTime: fill.time,
    entryValue: multiply(fill.price, qty),
    entryQty: qty,
    firstEntryPrice: fill.price,
    entryLegs: 1,
    lineage: [fill.sourceRef],
    exitValue: fraction(0n),
    exitQty: fraction(0n),
    firstExitPrice: null,
    exitLegs: 0,
    commissions,
    reportedPnl,
    pnlAsset: fill.pnlAsset,
  };
}

function projectCycles(fills) {
  const books = new Map();
  for (const fill of fills) {
    const key = `${fill.symbol}\u0000${fill.positionSide}\u0000${fill.pnlAsset}`;
    const rows = books.get(key) ?? [];
    rows.push(fill);
    books.set(key, rows);
  }
  const cycles = [];
  for (const rows of [...books.values()].sort((left, right) => (
    left[0].symbol.localeCompare(right[0].symbol, 'en')
      || left[0].positionSide.localeCompare(right[0].positionSide, 'en')
      || left[0].pnlAsset.localeCompare(right[0].pnlAsset, 'en')
  ))) {
    let state = null;
    for (const fill of rows) {
      const direction = fill.side === 'BUY' ? 1 : -1;
      if (state === null) {
        if (!hedgeDirectionAllowed(fill.positionSide, direction)) {
          fail('TRADE_PROJECTOR_HEDGE_DIRECTION_INVALID');
        }
        state = startState(fill, direction);
        continue;
      }
      if (fill.pnlAsset !== state.pnlAsset) fail('TRADE_PROJECTOR_UNSUPPORTED_ASSET');
      if (state.direction === direction) {
        state.positionQty = add(state.positionQty, multiply(fraction(BigInt(direction)), fill.qty));
        state.positionValue = add(state.positionValue, multiply(fill.price, fill.qty));
        state.entryValue = add(state.entryValue, multiply(fill.price, fill.qty));
        state.entryQty = add(state.entryQty, fill.qty);
        state.entryLegs += 1;
        state.lineage.push(fill.sourceRef);
        addCommission(state.commissions, fill.feeAsset, fill.fee);
        state.reportedPnl = add(state.reportedPnl, fill.pnl);
        continue;
      }
      const currentQty = absolute(state.positionQty);
      const comparison = compare(fill.qty, currentQty);
      const crossesZero = comparison > 0;
      if (crossesZero && fill.positionSide !== 'BOTH') {
        fail('TRADE_PROJECTOR_HEDGE_OVER_CLOSE');
      }
      const closingQty = comparison >= 0 ? currentQty : fill.qty;
      const openingQty = crossesZero ? subtract(fill.qty, currentQty) : fraction(0n);
      const closingFee = comparison === 0
        ? fill.fee
        : multiply(fill.fee, divide(closingQty, fill.qty));
      const openingFee = subtract(fill.fee, closingFee);
      const averageEntry = divide(state.positionValue, currentQty);
      state.positionValue = subtract(state.positionValue, multiply(averageEntry, closingQty));
      if (state.exitLegs === 0) state.firstExitPrice = fill.price;
      state.exitLegs += 1;
      state.lineage.push(fill.sourceRef);
      addCommission(state.commissions, fill.feeAsset, closingFee);
      state.reportedPnl = add(state.reportedPnl, fill.pnl);
      state.exitValue = add(state.exitValue, multiply(fill.price, closingQty));
      state.exitQty = add(state.exitQty, closingQty);
      state.exitTime = fill.time;

      if (comparison >= 0) {
        cycles.push({
          symbol: fill.symbol,
          side: state.direction > 0 ? 'LONG' : 'SHORT',
          positionSide: fill.positionSide,
          entryTime: Number(state.entryTime),
          exitTime: Number(state.exitTime),
          entryPrice: state.entryLegs === 1
            ? state.firstEntryPrice : divide(state.entryValue, state.entryQty),
          exitPrice: state.exitLegs === 1
            ? state.firstExitPrice : divide(state.exitValue, state.exitQty),
          qty: state.entryQty,
          commissions: new Map(state.commissions),
          reportedPnl: state.reportedPnl,
          pnlAsset: state.pnlAsset,
          lineageRefs: [...state.lineage],
        });
        state = crossesZero
          ? startState(fill, direction, openingQty, openingFee, fraction(0n))
          : null;
      } else {
        state.positionQty = multiply(fraction(BigInt(state.direction)), subtract(currentQty, fill.qty));
      }
    }
  }
  return cycles;
}

export async function projectTradeReadModels({ generation, fills } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail('TRADE_PROJECTOR_INVALID_GENERATION');
  }
  if (!Array.isArray(fills) || fills.length > 50_000) {
    fail('TRADE_PROJECTOR_INVALID_FILL_BATCH');
  }
  const normalized = fills.map(normalizeFill).sort(sourceOrder);
  const seen = new Set();
  for (const fill of normalized) {
    if (seen.has(fill.sourceRef)) fail('TRADE_PROJECTOR_DUPLICATE_SOURCE');
    seen.add(fill.sourceRef);
  }
  const models = [];
  for (const cycle of projectCycles(normalized)) {
    const sourceLineage = [...cycle.lineageRefs].map(String);
    if (sourceLineage.length < 2 || new Set(sourceLineage).size !== sourceLineage.length) {
      fail('TRADE_PROJECTOR_INVALID_LINEAGE');
    }
    const identityShape = {
      symbol: cycle.symbol,
      side: cycle.side,
      positionSide: cycle.positionSide,
      entryTime: cycle.entryTime,
      exitTime: cycle.exitTime,
    };
    const tradeId = `t_${(await sha256Hex(
      tradeIdentityMaterial(identityShape, sourceLineage),
    )).slice(0, 16)}`;
    const payload = {
      id: tradeId,
      symbol: cycle.symbol,
      side: cycle.side,
      positionSide: cycle.positionSide,
      entryTime: cycle.entryTime,
      exitTime: cycle.exitTime,
      entryPrice: canonicalFraction(cycle.entryPrice),
      exitPrice: canonicalFraction(cycle.exitPrice),
      qty: canonicalFraction(cycle.qty),
      notional: canonicalFraction(multiply(cycle.entryPrice, cycle.qty)),
      realizedPnl: canonicalFraction(cycle.reportedPnl),
      realizedPnlAsset: cycle.pnlAsset,
      commissionByAsset: [...cycle.commissions.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([asset, amount]) => ({ asset, amount: canonicalFraction(amount) })),
      source: 'binance',
    };
    models.push({
      protocol: TRADE_READ_MODEL_PROTOCOL,
      tradeId,
      sourceLineage,
      sourceLineageSha256: await sha256Hex(tradeLineageMaterial(sourceLineage)),
      payload,
      payloadSha256: await sha256Hex(tradePayloadMaterial(payload)),
    });
  }
  models.sort((left, right) => (
    left.payload.exitTime - right.payload.exitTime
      || left.tradeId.localeCompare(right.tradeId)
  ));
  const projectionSha256 = await sha256Hex([
    TRADE_READ_MODEL_PROTOCOL,
    String(generation),
    ...models.flatMap((model) => [
      model.tradeId, model.sourceLineageSha256, model.payloadSha256,
    ]),
  ].join('\u0000'));
  return frozen({
    protocol: TRADE_READ_MODEL_PROTOCOL,
    tradeIdProtocol: TRADE_ID_PROTOCOL,
    generation,
    projectionSha256,
    models,
  });
}
