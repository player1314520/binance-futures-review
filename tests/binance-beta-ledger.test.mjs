import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceLedgerPromotion,
  createLedgerPromotionState,
  projectBinanceUsdmLedger,
  reconcileLedgerProjection,
} from '../supabase/functions/binance-beta/ledger.mjs';

function fill(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    id: '1',
    time: 1_800_000_000_000,
    side: 'BUY',
    positionSide: 'BOTH',
    qty: '1',
    price: '100',
    realizedPnl: '0',
    realizedPnlAsset: 'USDT',
    commission: '0',
    commissionAsset: 'USDT',
    ...overrides,
  };
}

function income(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    tranId: '9001',
    time: 1_800_000_000_100,
    incomeType: 'FUNDING_FEE',
    asset: 'USDT',
    income: '0',
    ...overrides,
  };
}

function total(projection, asset) {
  return projection.assetTotals.find((row) => row.asset === asset);
}

function assertEveryEntryBalances(projection) {
  for (const entry of projection.entries) {
    const postingsByAsset = Map.groupBy(entry.postings, (posting) => posting.asset);
    for (const postings of postingsByAsset.values()) {
      const parsed = postings.map((posting) => {
        const [whole, fraction = ''] = posting.signedAmount.split('.');
        return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
      });
      const maxScale = Math.max(...parsed.map((value) => value.scale));
      const sum = parsed.reduce(
        (result, value) => result + value.units * (10n ** BigInt(maxScale - value.scale)),
        0n,
      );
      assert.equal(sum, 0n, entry.entryId);
    }
  }
}

test('projects exact decimal double entries and never mutates caller-owned inputs', () => {
  const input = {
    fills: [
      fill({ id: '1', qty: '0.3', commission: '0.1' }),
      fill({ id: '2', time: 1_800_000_000_010, side: 'SELL', qty: '0.1', commission: '0.2', realizedPnl: '0.3' }),
    ],
    income: [income({ income: '-0.00000001' })],
    incomeCoverage: 'PARTIAL',
  };
  const before = structuredClone(input);

  const projection = projectBinanceUsdmLedger(input);

  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.entries[0].postings), true);
  assertEveryEntryBalances(projection);
  assert.deepEqual(total(projection, 'USDT'), {
    asset: 'USDT',
    walletChange: '-0.00000001',
    realizedPnl: '0.3',
    commission: '-0.3',
    funding: '-0.00000001',
    suspense: '0',
  });
});

test('keeps assets isolated instead of inventing a cross-asset conversion', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [fill({ commission: '0.01', commissionAsset: 'BNB', realizedPnl: '2' })],
    income: [],
    incomeCoverage: 'PARTIAL',
  });

  assert.deepEqual(projection.assetTotals, [
    {
      asset: 'BNB', walletChange: '-0.01', realizedPnl: '0', commission: '-0.01', funding: '0', suspense: '0',
    },
    {
      asset: 'USDT', walletChange: '2', realizedPnl: '2', commission: '0', funding: '0', suspense: '0',
    },
  ]);
  assert.equal('portfolioTotal' in projection, false);
  assertEveryEntryBalances(projection);
});

test('uses complete income as the sole monetary authority while fills still drive positions', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [fill({ commission: '1', realizedPnl: '10' })],
    income: [
      income({ tranId: '1', incomeType: 'REALIZED_PNL', income: '10' }),
      income({ tranId: '2', incomeType: 'COMMISSION', income: '-1' }),
      income({ tranId: '3', incomeType: 'FUNDING_FEE', income: '0.5' }),
    ],
    incomeCoverage: 'COMPLETE',
  });

  assert.equal(projection.entries.length, 3);
  assert.equal(projection.entries.every((entry) => entry.source.dataset === 'income'), true);
  assert.equal(projection.positionDeltas.length, 1);
  assert.deepEqual(total(projection, 'USDT'), {
    asset: 'USDT',
    walletChange: '9.5',
    realizedPnl: '10',
    commission: '-1',
    funding: '0.5',
    suspense: '0',
  });
});

test('projects deterministic one-way partial closes and splits a fill that flips through zero', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [
      fill({ id: '1', side: 'BUY', qty: '2' }),
      fill({ id: '2', time: 1_800_000_000_010, side: 'SELL', qty: '0.5' }),
      fill({ id: '3', time: 1_800_000_000_020, side: 'SELL', qty: '2' }),
    ],
    income: [],
  });

  assert.deepEqual(
    projection.positionDeltas.map(({ transition, quantityBefore, closeQuantity, openQuantity, quantityAfter }) => ({
      transition, quantityBefore, closeQuantity, openQuantity, quantityAfter,
    })),
    [
      { transition: 'OPEN_LONG', quantityBefore: '0', closeQuantity: '0', openQuantity: '2', quantityAfter: '2' },
      { transition: 'REDUCE_LONG', quantityBefore: '2', closeQuantity: '0.5', openQuantity: '0', quantityAfter: '1.5' },
      { transition: 'FLIP_LONG_TO_SHORT', quantityBefore: '1.5', closeQuantity: '1.5', openQuantity: '0.5', quantityAfter: '-0.5' },
    ],
  );
  assert.deepEqual(projection.positions, [{ symbol: 'BTCUSDT', positionSide: 'BOTH', quantity: '-0.5' }]);
});

test('keeps Hedge Mode LONG and SHORT books separate across partial closes', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [
      fill({ id: '1', side: 'BUY', positionSide: 'LONG', qty: '2' }),
      fill({ id: '2', time: 1_800_000_000_010, side: 'SELL', positionSide: 'SHORT', qty: '3' }),
      fill({ id: '3', time: 1_800_000_000_020, side: 'SELL', positionSide: 'LONG', qty: '0.5' }),
      fill({ id: '4', time: 1_800_000_000_030, side: 'BUY', positionSide: 'SHORT', qty: '1' }),
    ],
    income: [],
  });

  assert.deepEqual(projection.positions, [
    { symbol: 'BTCUSDT', positionSide: 'LONG', quantity: '1.5' },
    { symbol: 'BTCUSDT', positionSide: 'SHORT', quantity: '-2' },
  ]);
  assert.deepEqual(projection.positionDeltas.map((row) => row.transition), [
    'OPEN_LONG', 'OPEN_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT',
  ]);
});

test('sorts same-millisecond fills by provider trade id and rejects a Hedge Mode over-close', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [
      fill({ id: '10', side: 'SELL', qty: '1' }),
      fill({ id: '2', side: 'BUY', qty: '1' }),
    ],
    income: [],
  });
  assert.deepEqual(projection.positionDeltas.map((row) => row.sourceKey), ['BTCUSDT:2', 'BTCUSDT:10']);
  assert.deepEqual(projection.positions, [{ symbol: 'BTCUSDT', positionSide: 'BOTH', quantity: '0' }]);

  assert.throws(
    () => projectBinanceUsdmLedger({
      fills: [fill({ side: 'SELL', positionSide: 'LONG', qty: '0.1' })],
      income: [],
    }),
    /LEDGER_HEDGE_DIRECTION_INVALID/,
  );
});

test('Hedge Mode cannot cross zero in either isolated book', () => {
  for (const [positionSide, openSide, closeSide] of [
    ['LONG', 'BUY', 'SELL'],
    ['SHORT', 'SELL', 'BUY'],
  ]) {
    assert.throws(
      () => projectBinanceUsdmLedger({
        fills: [
          fill({ id: '1', positionSide, side: openSide, qty: '1' }),
          fill({ id: '2', time: 1_800_000_000_001, positionSide, side: closeSide, qty: '1.000000000000000001' }),
        ],
        income: [],
      }),
      /LEDGER_HEDGE_OVER_CLOSE/,
    );
  }
});

test('fails closed on non-array datasets and imprecise numeric provider ids', () => {
  assert.throws(
    () => projectBinanceUsdmLedger({ fills: {}, income: [] }),
    /LEDGER_INVALID_INPUT_COLLECTION/,
  );
  assert.throws(
    () => projectBinanceUsdmLedger({
      fills: [fill({ id: Number.MAX_SAFE_INTEGER + 1 })],
      income: [],
    }),
    /LEDGER_INVALID_SOURCE_ID/,
  );
  assert.throws(
    () => projectBinanceUsdmLedger({
      fills: [fill({ realizedPnlAsset: undefined })],
      income: [],
    }),
    /LEDGER_INVALID_ASSET/,
  );
  assert.throws(
    () => projectBinanceUsdmLedger({
      fills: [fill({ realizedPnlAsset: 'USDC' })],
      income: [],
    }),
    /LEDGER_SETTLEMENT_ASSET_MISMATCH/,
  );
});

test('accepts canonical exact-string provider timestamps and orders them without Number coercion', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [
      fill({ id: '2', time: '18000000000000002' }),
      fill({ id: '1', time: '18000000000000001' }),
    ],
    income: [],
  });
  assert.deepEqual(projection.positionDeltas.map((row) => row.sourceKey), ['BTCUSDT:1', 'BTCUSDT:2']);
});

test('rv-reconciliation/2 compares exact per-asset totals and position books', () => {
  const projection = projectBinanceUsdmLedger({
    fills: [fill({ commission: '0.01', realizedPnl: '1' })],
    income: [income({ income: '-0.25' })],
  });
  const matchingOracle = {
    assetTotals: structuredClone(projection.assetTotals),
    positions: structuredClone(projection.positions),
  };

  const pass = reconcileLedgerProjection({
    generation: 41,
    realGeneration: true,
    projection,
    oracle: matchingOracle,
  });
  assert.equal(pass.protocol, 'rv-reconciliation/2');
  assert.equal(pass.status, 'PASS');
  assert.deepEqual(pass.diffs, []);
  assert.deepEqual(pass.checks, {
    balancedEntries: 'PASS', assetParity: 'PASS', positionParity: 'PASS',
  });

  matchingOracle.assetTotals[0].walletChange = '0.74000001';
  const fail = reconcileLedgerProjection({
    generation: 42,
    realGeneration: true,
    projection,
    oracle: matchingOracle,
  });
  assert.equal(fail.status, 'FAIL');
  assert.deepEqual(fail.reasonCodes, ['ASSET_PARITY_MISMATCH']);
  assert.deepEqual(fail.diffs, [{
    scope: 'asset',
    key: 'USDT',
    metric: 'walletChange',
    projected: '0.74',
    oracle: '0.74000001',
    delta: '-0.00000001',
  }]);
});

function parity(generation, { realGeneration = true, status = 'PASS' } = {}) {
  const passed = status === 'PASS';
  return Object.freeze({
    protocol: 'rv-reconciliation/2',
    generation,
    realGeneration,
    status,
    reasonCodes: passed ? [] : ['ASSET_PARITY_MISMATCH'],
    checks: {
      balancedEntries: 'PASS',
      assetParity: passed ? 'PASS' : 'FAIL',
      positionParity: 'PASS',
    },
    diffs: passed ? [] : [{ metric: 'walletChange' }],
  });
}

test('promotion rejects caller-forged or internally contradictory PASS documents', () => {
  const state = createLedgerPromotionState();
  assert.throws(
    () => advanceLedgerPromotion(state, {
      protocol: 'rv-reconciliation/2', generation: 1, realGeneration: true,
      status: 'PASS', diffs: [],
    }),
    /LEDGER_INVALID_PROMOTION_RECONCILIATION/,
  );
  assert.throws(
    () => advanceLedgerPromotion(state, {
      ...parity(1),
      checks: { balancedEntries: 'PASS', assetParity: 'FAIL', positionParity: 'PASS' },
    }),
    /LEDGER_RECONCILIATION_INCONSISTENT/,
  );
});

test('promotion requires seven consecutive zero-diff real generations and an explicit PRIMARY activation', () => {
  let state = createLedgerPromotionState();
  assert.equal(state.stage, 'SHADOW');

  state = advanceLedgerPromotion(state, parity(100, { realGeneration: false }));
  assert.equal(state.stage, 'SHADOW');
  assert.equal(state.consecutiveZeroDiffRealGenerations, 0);

  for (let generation = 1; generation <= 6; generation += 1) {
    state = advanceLedgerPromotion(state, parity(generation));
    assert.equal(state.stage, 'PARITY_OBSERVING');
    assert.equal(state.consecutiveZeroDiffRealGenerations, generation);
  }
  state = advanceLedgerPromotion(state, parity(7));
  assert.equal(state.stage, 'PARITY_PASSED');
  assert.equal(state.consecutiveZeroDiffRealGenerations, 7);

  state = advanceLedgerPromotion(state, parity(8), { activatePrimary: true });
  assert.equal(state.stage, 'PRIMARY');
  assert.equal(state.consecutiveZeroDiffRealGenerations, 8);
  assert.equal(Object.isFrozen(state), true);
});

test('a real mismatch resets observation and replay cannot manufacture a streak', () => {
  let state = createLedgerPromotionState();
  state = advanceLedgerPromotion(state, parity(1));
  state = advanceLedgerPromotion(state, parity(2));
  state = advanceLedgerPromotion(state, parity(3, { status: 'FAIL' }));
  assert.equal(state.stage, 'PARITY_OBSERVING');
  assert.equal(state.consecutiveZeroDiffRealGenerations, 0);

  assert.throws(() => advanceLedgerPromotion(state, parity(3)), /LEDGER_GENERATION_REPLAY/);
  assert.throws(
    () => advanceLedgerPromotion(state, parity(4), { activatePrimary: true }),
    /LEDGER_PROMOTION_NOT_READY/,
  );
});

test('a PRIMARY mismatch halts immediately and later passes cannot silently re-enable it', () => {
  let state = createLedgerPromotionState();
  for (let generation = 1; generation <= 7; generation += 1) {
    state = advanceLedgerPromotion(state, parity(generation));
  }
  state = advanceLedgerPromotion(state, parity(8), { activatePrimary: true });
  assert.equal(state.stage, 'PRIMARY');
  state = advanceLedgerPromotion(state, parity(9, { status: 'FAIL' }));
  assert.equal(state.stage, 'HALTED');
  assert.equal(state.consecutiveZeroDiffRealGenerations, 0);
  state = advanceLedgerPromotion(state, parity(10));
  assert.equal(state.stage, 'HALTED');
  assert.equal(state.lastOutcome, 'PASS_AFTER_HALT');
  assert.throws(
    () => advanceLedgerPromotion(state, parity(11), { activatePrimary: true }),
    /LEDGER_PROMOTION_NOT_READY/,
  );
});
