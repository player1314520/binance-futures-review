import test from 'node:test';
import assert from 'node:assert/strict';

import { fillsToTrades, pairFills } from '../frontend/engine.js';
import { reduceNetPositionsCore } from '../frontend/net-position.js';

const LONG_TO_SHORT = [
  { id: 'f1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 10, fee: 1, pnl: 0 },
  { id: 'f2', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 15, fee: 1.5, pnl: 100 },
  { id: 'f3', time: 3_000, symbol: 'BTCUSDT', side: 'BUY', price: 105, qty: 5, fee: 0.5, pnl: 25 },
];

const SHORT_TO_LONG = [
  { id: 'f1', time: 1_000, symbol: 'ETHUSDT', side: 'SELL', price: 200, qty: 8, fee: 0.8, pnl: 0 },
  { id: 'f2', time: 2_000, symbol: 'ETHUSDT', side: 'BUY', price: 190, qty: 12, fee: 1.2, pnl: 80 },
  { id: 'f3', time: 3_000, symbol: 'ETHUSDT', side: 'SELL', price: 195, qty: 4, fee: 0.4, pnl: -20 },
];

function accountingProjection(trades) {
  return trades.map((trade) => ({
    symbol: trade.symbol,
    side: trade.side,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    qty: trade.qty,
    fee: trade.fee,
    pnl: trade.pnl,
  }));
}

test('pairFills splits a long-to-short zero-crossing into two conserved trades', () => {
  const result = pairFills(LONG_TO_SHORT);

  assert.equal(result.openPositions, 0);
  assert.deepEqual(accountingProjection(result.trades), [
    {
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryTime: 1_000,
      exitTime: 2_000,
      entryPrice: 100,
      exitPrice: 110,
      qty: 10,
      fee: 2,
      pnl: 98,
    },
    {
      symbol: 'BTCUSDT',
      side: 'SHORT',
      entryTime: 2_000,
      exitTime: 3_000,
      entryPrice: 110,
      exitPrice: 105,
      qty: 5,
      fee: 1,
      pnl: 24,
    },
  ]);
  assert.equal(result.trades.reduce((sum, trade) => sum + trade.fee, 0), 3);
  assert.equal(result.trades.reduce((sum, trade) => sum + trade.pnl, 0), 122);
  assert.equal(result.trades.reduce((sum, trade) => sum + trade.qty * 2, 0), 30);
});

test('fillsToTrades is only a field adapter over the same long-to-short state machine', () => {
  const trades = fillsToTrades(LONG_TO_SHORT);

  assert.deepEqual(accountingProjection(trades), accountingProjection(pairFills(LONG_TO_SHORT).trades));
});

test('both adapters split a short-to-long zero-crossing symmetrically', () => {
  const paired = pairFills(SHORT_TO_LONG);
  const imported = fillsToTrades(SHORT_TO_LONG);

  assert.equal(paired.openPositions, 0);
  assert.deepEqual(accountingProjection(paired.trades), [
    {
      symbol: 'ETHUSDT',
      side: 'SHORT',
      entryTime: 1_000,
      exitTime: 2_000,
      entryPrice: 200,
      exitPrice: 190,
      qty: 8,
      fee: 1.6,
      pnl: 78.4,
    },
    {
      symbol: 'ETHUSDT',
      side: 'LONG',
      entryTime: 2_000,
      exitTime: 3_000,
      entryPrice: 190,
      exitPrice: 195,
      qty: 4,
      fee: 0.8,
      pnl: -20.8,
    },
  ]);
  assert.deepEqual(accountingProjection(imported), accountingProjection(paired.trades));
  assert.ok(Math.abs(paired.trades.reduce((sum, trade) => sum + trade.fee, 0) - 2.4) < 1e-9);
  assert.ok(Math.abs(paired.trades.reduce((sum, trade) => sum + trade.pnl, 0) - 57.6) < 1e-9);
  assert.equal(paired.trades.reduce((sum, trade) => sum + trade.qty * 2, 0), 24);
});

test('partial closes followed by adds preserve current cost basis and weighted exit price', () => {
  const fills = [
    { id: 'f1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 10, fee: 1, pnl: null },
    { id: 'f2', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 5, fee: 0.5, pnl: null },
    { id: 'f3', time: 3_000, symbol: 'BTCUSDT', side: 'BUY', price: 105, qty: 3, fee: 0.3, pnl: null },
    { id: 'f4', time: 4_000, symbol: 'BTCUSDT', side: 'SELL', price: 120, qty: 8, fee: 0.8, pnl: null },
  ];

  const paired = pairFills(fills);
  assert.equal(paired.openPositions, 0);
  assert.deepEqual(accountingProjection(paired.trades), [{
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryTime: 1_000,
    exitTime: 4_000,
    entryPrice: 101.15384615384616,
    exitPrice: 116.15384615384616,
    qty: 13,
    fee: 2.6,
    pnl: 192.4,
  }]);
  assert.deepEqual(
    accountingProjection(fillsToTrades(fills)),
    accountingProjection(paired.trades),
  );
  assert.equal(paired.trades[0].qty * 2, 26);
});

test('same-timestamp fills retain source order and split a zero crossing deterministically', () => {
  const fills = [
    { id: 'same-1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 1, fee: 0, pnl: 0 },
    { id: 'same-2', time: 1_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 2, fee: 0, pnl: 10 },
    { id: 'same-3', time: 2_000, symbol: 'BTCUSDT', side: 'BUY', price: 105, qty: 1, fee: 0, pnl: 5 },
  ];

  const first = accountingProjection(pairFills(fills).trades);
  const replay = accountingProjection(pairFills(fills).trades);
  assert.deepEqual(replay, first);
  assert.deepEqual(first.map(({ side, entryPrice, exitPrice, qty, pnl }) => ({
    side, entryPrice, exitPrice, qty, pnl,
  })), [
    { side: 'LONG', entryPrice: 100, exitPrice: 110, qty: 1, pnl: 10 },
    { side: 'SHORT', entryPrice: 110, exitPrice: 105, qty: 1, pnl: 5 },
  ]);
});

test('interleaved symbols close in exit-time order without cross-accounting', () => {
  const fills = [
    { id: 'b1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 1, fee: 1, pnl: 0 },
    { id: 'e1', time: 1_500, symbol: 'ETHUSDT', side: 'SELL', price: 200, qty: 2, fee: 2, pnl: 0 },
    { id: 'e2', time: 2_000, symbol: 'ETHUSDT', side: 'BUY', price: 190, qty: 2, fee: 2, pnl: 20 },
    { id: 'b2', time: 3_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 1, fee: 1, pnl: 10 },
  ];

  const result = pairFills(fills);
  assert.equal(result.openPositions, 0);
  assert.deepEqual(result.trades.map((trade) => [trade.symbol, trade.exitTime, trade.fee, trade.pnl]), [
    ['ETHUSDT', 2_000, 4, 16],
    ['BTCUSDT', 3_000, 2, 8],
  ]);
});

test('unfinished positions remain explicit and never become synthetic closed trades', () => {
  const result = reduceNetPositionsCore([
    { time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 2, fee: 0.2, pnl: 0 },
    { time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 0.5, fee: 0.05, pnl: 5 },
  ]);

  assert.deepEqual(result.closedTrades, []);
  assert.equal(result.openPositions.length, 1);
  assert.deepEqual({
    symbol: result.openPositions[0].symbol,
    side: result.openPositions[0].side,
    entryQty: result.openPositions[0].entryQty,
    openQty: result.openPositions[0].openQty,
    fee: result.openPositions[0].fee,
    reportedPnl: result.openPositions[0].reportedPnl,
  }, {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryQty: 2,
    openQty: 1.5,
    fee: 0.25,
    reportedPnl: 5,
  });
});

test('an opening quantity below the former absolute epsilon remains observable', () => {
  const qty = 1e-10;
  const result = reduceNetPositionsCore([
    { id: 'tiny-open', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty, fee: 0, pnl: 0 },
  ]);

  assert.deepEqual(result.closedTrades, []);
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.openPositions[0].entryQty, qty);
  assert.equal(result.openPositions[0].openQty, qty);
});

test('a tiny partial close conserves the real remainder instead of rounding it to zero', () => {
  const openingQty = 1e-9;
  const closingQty = 5e-10;
  const result = reduceNetPositionsCore([
    { id: 'tiny-partial-open', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: openingQty, fee: 0.001, pnl: null },
    { id: 'tiny-partial-close', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: closingQty, fee: 0.0005, pnl: null },
  ]);

  assert.deepEqual(result.closedTrades, []);
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.openPositions[0].entryQty, openingQty);
  assert.equal(result.openPositions[0].openQty, openingQty - closingQty);
  assert.equal(result.openPositions[0].fee, 0.0015);
  assert.equal(result.openPositions[0].selfPnl, (110 - 100) * closingQty);
});

test('relative quantity comparison still absorbs ordinary floating-point cancellation noise', () => {
  const result = reduceNetPositionsCore([
    { id: 'float-open-a', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 0.1, fee: 0, pnl: null },
    { id: 'float-open-b', time: 2_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 0.2, fee: 0, pnl: null },
    { id: 'float-close', time: 3_000, symbol: 'BTCUSDT', side: 'SELL', price: 110, qty: 0.3, fee: 0, pnl: null },
  ]);

  assert.equal(result.closedTrades.length, 1);
  assert.deepEqual(result.openPositions, []);
});

test('canonical adapters conserve sub-cent fees and high-precision quantities without display rounding', () => {
  const qty = 0.00000000123456789;
  const fills = [
    { id: 'micro-1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100_000.123456789, qty, fee: 0.004, pnl: 0 },
    { id: 'micro-2', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 100_001.123456789, qty, fee: 0.004, pnl: 0.01 },
  ];

  const [trade] = pairFills(fills).trades;
  assert.equal(trade.qty, qty);
  assert.equal(trade.entryPrice, fills[0].price);
  assert.equal(trade.exitPrice, fills[1].price);
  assert.equal(trade.fee, 0.008);
  assert.equal(trade.pnl, 0.002);
  assert.equal(trade.notional, fills[0].price * qty);
  assert.deepEqual(accountingProjection(fillsToTrades(fills)), accountingProjection([trade]));
});

test('lineage-based IDs stay unique for same-millisecond cycles and stable on replay', () => {
  const fills = [
    { id: 'cycle-a-open', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 1, fee: 0, pnl: 0 },
    { id: 'cycle-a-close', time: 1_000, symbol: 'BTCUSDT', side: 'SELL', price: 101, qty: 1, fee: 0, pnl: 1 },
    { id: 'cycle-b-open', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 102, qty: 1, fee: 0, pnl: 0 },
    { id: 'cycle-b-close', time: 1_000, symbol: 'BTCUSDT', side: 'SELL', price: 103, qty: 1, fee: 0, pnl: 1 },
  ];

  const first = pairFills(fills).trades.map((trade) => trade.id);
  const replay = pairFills(fills).trades.map((trade) => trade.id);
  assert.equal(new Set(first).size, 2);
  assert.deepEqual(replay, first);
  assert.deepEqual(
    pairFills(fills.map((fill) => ({ ...fill, positionSide: 'BOTH' }))).trades
      .map((trade) => trade.id),
    first,
    'explicit Binance one-way mode must preserve existing stable IDs',
  );
  assert.deepEqual(
    pairFills([
      { id: 'unrelated-open', time: 500, symbol: 'ETHUSDT', side: 'BUY', price: 200, qty: 1, fee: 0, pnl: 0 },
      ...fills,
    ]).trades.map((trade) => trade.id),
    first,
  );
});

test('pairFills uses explicit sourceRef lineage and never orderId as fill identity', () => {
  const sharedOrderId = '9223372036854775808';
  const fills = [
    {
      id: 1, sourceRef: 'binance-trade:BTCUSDT:101', tradeId: '101', orderId: sharedOrderId,
      time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 1, fee: 0, pnl: 0,
    },
    {
      id: 2, sourceRef: 'binance-trade:BTCUSDT:102', tradeId: '102', orderId: sharedOrderId,
      time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 101, qty: 1, fee: 0, pnl: 1,
    },
  ];

  const first = pairFills(fills).trades.map((trade) => trade.id);
  const replay = pairFills(fills.map((fill) => ({
    ...fill,
    id: `adapter-local-${fill.id}`,
    orderId: 'different-order-metadata',
  }))).trades.map((trade) => trade.id);

  assert.deepEqual(replay, first);
});

test('pairFills keeps Binance Hedge Mode long and short books independent', () => {
  const fills = [
    { id: 'long-open', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', price: 100, qty: 1, fee: 0.1, pnl: 0 },
    { id: 'short-open', time: 1_100, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT', price: 101, qty: 2, fee: 0.2, pnl: 0 },
    { id: 'long-close', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', price: 110, qty: 1, fee: 0.1, pnl: 10 },
    { id: 'short-close', time: 2_100, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'SHORT', price: 90, qty: 2, fee: 0.2, pnl: 22 },
  ];

  const paired = pairFills(fills);
  const imported = fillsToTrades(fills);

  assert.equal(paired.openPositions, 0);
  assert.deepEqual(accountingProjection(paired.trades), [
    {
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryTime: 1_000,
      exitTime: 2_000,
      entryPrice: 100,
      exitPrice: 110,
      qty: 1,
      fee: 0.2,
      pnl: 9.8,
    },
    {
      symbol: 'BTCUSDT',
      side: 'SHORT',
      entryTime: 1_100,
      exitTime: 2_100,
      entryPrice: 101,
      exitPrice: 90,
      qty: 2,
      fee: 0.4,
      pnl: 21.6,
    },
  ]);
  assert.deepEqual(accountingProjection(imported), accountingProjection(paired.trades));
});

test('pairFills rejects unknown position modes and invalid declared money before netting', () => {
  const base = [
    { id: 'strict-1', time: 1_000, symbol: 'BTCUSDT', side: 'BUY', price: 100, qty: 1, fee: 0, pnl: 0 },
    { id: 'strict-2', time: 2_000, symbol: 'BTCUSDT', side: 'SELL', price: 101, qty: 1, fee: 0, pnl: 1 },
  ];
  assert.throws(
    () => pairFills([{ ...base[0], positionSide: 'INVALID' }, base[1]]),
    error => error.code === 'unsupported_position_mode',
  );
  assert.throws(
    () => pairFills([{ ...base[0], fee: 'invalid-private-value' }, base[1]]),
    error => error.code === 'invalid_fee',
  );
  assert.throws(
    () => pairFills([{ ...base[0], feeAsset: 'BNB' }, base[1]]),
    error => error.code === 'unsupported_fee_asset',
  );
});
