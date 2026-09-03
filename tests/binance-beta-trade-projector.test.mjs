import test from 'node:test';
import assert from 'node:assert/strict';

import { pairFills } from '../frontend/engine.js';
import {
  TRADE_ID_PROTOCOL,
  TRADE_READ_MODEL_PROTOCOL,
  projectTradeReadModels,
} from '../supabase/functions/binance-beta/trade-projector.mjs';

const fills = Object.freeze([
  Object.freeze({
    id: '90071992547409930001', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH',
    time: '1788109200000', price: '68000', qty: '0.01', commission: '0.27',
    realizedPnl: '0', commissionAsset: 'USDT', realizedPnlAsset: 'USDT',
    pair: 'BTCUSDT', baseQty: '0', quoteQty: '680',
  }),
  Object.freeze({
    id: '90071992547409930002', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH',
    time: '1788112800000', price: '68600', qty: '0.01', commission: '0.27',
    realizedPnl: '6', commissionAsset: 'USDT', realizedPnlAsset: 'USDT',
    pair: 'BTCUSDT', baseQty: '0', quoteQty: '686',
  }),
]);

test('trusted fills project one versioned server trade identity with closed lineage', async () => {
  const result = await projectTradeReadModels({ generation: 7, fills });

  assert.equal(result.protocol, TRADE_READ_MODEL_PROTOCOL);
  assert.equal(result.tradeIdProtocol, TRADE_ID_PROTOCOL);
  assert.equal(result.generation, 7);
  assert.equal(result.models.length, 1);
  const [model] = result.models;
  assert.match(model.tradeId, /^t_[0-9a-f]{16}$/u);
  assert.deepEqual(model.sourceLineage, fills.map(
    (fill) => `binance-usdm:fills:${fill.symbol}:${fill.id}`,
  ));
  assert.match(model.sourceLineageSha256, /^[0-9a-f]{64}$/u);
  assert.match(model.payloadSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(model.payload, {
    id: model.tradeId,
    symbol: 'BTCUSDT',
    side: 'LONG',
    positionSide: 'BOTH',
    entryTime: 1788109200000,
    exitTime: 1788112800000,
    entryPrice: '68000',
    exitPrice: '68600',
    qty: '0.01',
    notional: '680',
    realizedPnl: '6',
    realizedPnlAsset: 'USDT',
    commissionByAsset: [{ asset: 'USDT', amount: '0.54' }],
    source: 'binance',
  });
});

test('projection is stable across input order and later generations', async () => {
  const first = await projectTradeReadModels({ generation: 7, fills });
  const replay = await projectTradeReadModels({ generation: 8, fills: [...fills].reverse() });

  assert.equal(replay.models[0].tradeId, first.models[0].tradeId);
  assert.equal(replay.models[0].sourceLineageSha256, first.models[0].sourceLineageSha256);
  assert.equal(replay.models[0].payloadSha256, first.models[0].payloadSha256);
  assert.notEqual(replay.generation, first.generation);
});

test('server projection preserves Classic pairing economics while server owns the trade id', async () => {
  const projected = await projectTradeReadModels({ generation: 7, fills });
  const classic = pairFills(fills.map((fill) => ({
    id: fill.id,
    sourceRef: fill.id,
    symbol: fill.symbol,
    side: fill.side,
    positionSide: fill.positionSide,
    time: Number(fill.time),
    price: Number(fill.price),
    qty: Number(fill.qty),
    fee: Number(fill.commission),
    pnl: Number(fill.realizedPnl),
  }))).trades[0];
  const payload = projected.models[0].payload;
  const settlementCommission = payload.commissionByAsset
    .find((row) => row.asset === payload.realizedPnlAsset)?.amount ?? '0';

  assert.deepEqual({
    symbol: payload.symbol,
    side: payload.side,
    entryTime: payload.entryTime,
    exitTime: payload.exitTime,
    entryPrice: Number(payload.entryPrice),
    exitPrice: Number(payload.exitPrice),
    qty: Number(payload.qty),
    fee: Number(settlementCommission),
    pnl: Number(payload.realizedPnl) - Number(settlementCommission),
  }, {
    symbol: classic.symbol,
    side: classic.side,
    entryTime: classic.entryTime,
    exitTime: classic.exitTime,
    entryPrice: classic.entryPrice,
    exitPrice: classic.exitPrice,
    qty: classic.qty,
    fee: classic.fee,
    pnl: classic.pnl,
  });
  assert.notEqual(payload.id, classic.id, 'cloud identity is a versioned server protocol');
});

test('open positions do not become reviewable trades and duplicate provider ids fail closed', async () => {
  assert.deepEqual((await projectTradeReadModels({ generation: 7, fills: [fills[0]] })).models, []);
  await assert.rejects(
    projectTradeReadModels({ generation: 7, fills: [fills[0], { ...fills[1], id: fills[0].id }] }),
    /TRADE_PROJECTOR_DUPLICATE_SOURCE/u,
  );
});

test('credential-shaped source fields are rejected and fee assets remain independent', async () => {
  await assert.rejects(
    projectTradeReadModels({ generation: 7, fills: [{ ...fills[0], apiSecret: 'never' }, fills[1]] }),
    /TRADE_PROJECTOR_UNEXPECTED_FIELD/u,
  );
  const projected = await projectTradeReadModels({
    generation: 7,
    fills: [
      { ...fills[0], commissionAsset: 'BNB' },
      { ...fills[1], commissionAsset: 'BNB' },
    ],
  });
  assert.equal(projected.models[0].payload.realizedPnlAsset, 'USDT');
  assert.deepEqual(projected.models[0].payload.commissionByAsset, [
    { asset: 'BNB', amount: '0.54' },
  ]);
});

test('losses and commission rebates remain signed while distinct lineages get distinct sha identities', async () => {
  const losing = [
    { ...fills[0], commission: '-0.01' },
    { ...fills[1], price: '67900', commission: '0.27', realizedPnl: '-1' },
  ];
  const first = await projectTradeReadModels({ generation: 9, fills: losing });
  assert.deepEqual(first.models[0].payload.commissionByAsset, [
    { asset: 'USDT', amount: '0.26' },
  ]);
  assert.equal(first.models[0].payload.realizedPnl, '-1');

  const distinct = await projectTradeReadModels({
    generation: 9,
    fills: losing.map((fill) => ({ ...fill, id: String(BigInt(fill.id) + 10n) })),
  });
  assert.notEqual(distinct.models[0].tradeId, first.models[0].tradeId);
  assert.notEqual(distinct.models[0].sourceLineageSha256, first.models[0].sourceLineageSha256);
});

test('provider trade ids are symbol-qualified instead of falsely treated as account-global', async () => {
  const secondSymbol = fills.map((fill) => ({ ...fill, symbol: 'ETHUSDT', pair: 'ETHUSDT' }));
  const projected = await projectTradeReadModels({
    generation: 10,
    fills: [...fills, ...secondSymbol],
  });
  assert.equal(projected.models.length, 2);
  assert.deepEqual(projected.models.map((model) => model.payload.symbol), ['BTCUSDT', 'ETHUSDT']);
  assert.notEqual(projected.models[0].tradeId, projected.models[1].tradeId);
});

test('exact decimal state never rounds a >2^53 quantity or epsilon remainder into a false close', async () => {
  const huge = [
    { ...fills[0], qty: '9007199254740993', commission: '0' },
    { ...fills[1], qty: '9007199254740993', commission: '0' },
  ];
  const closed = await projectTradeReadModels({ generation: 11, fills: huge });
  assert.equal(closed.models[0].payload.qty, '9007199254740993');

  const almostClosed = [
    { ...fills[0], qty: '1', commission: '0' },
    { ...fills[1], qty: '0.9999999999999999', commission: '0' },
  ];
  assert.deepEqual(
    (await projectTradeReadModels({ generation: 12, fills: almostClosed })).models,
    [],
  );
});

test('Hedge Mode rejects reverse opening and crossing zero while BOTH may flip', async () => {
  await assert.rejects(
    projectTradeReadModels({
      generation: 13,
      fills: [{ ...fills[1], positionSide: 'LONG' }],
    }),
    /TRADE_PROJECTOR_HEDGE_DIRECTION_INVALID/u,
  );
  await assert.rejects(
    projectTradeReadModels({
      generation: 13,
      fills: [
        { ...fills[0], positionSide: 'LONG', qty: '1' },
        { ...fills[1], positionSide: 'LONG', qty: '2' },
      ],
    }),
    /TRADE_PROJECTOR_HEDGE_OVER_CLOSE/u,
  );
  assert.equal((await projectTradeReadModels({
    generation: 13,
    fills: [
      { ...fills[0], qty: '1' },
      { ...fills[1], qty: '2' },
      { ...fills[0], id: '90071992547409930003', time: '1788116400000', qty: '1' },
    ],
  })).models.length, 2);
});

test('canonical fills require explicit assets without forcing a false conversion', async () => {
  await assert.rejects(
    projectTradeReadModels({
      generation: 14,
      fills: [{ ...fills[0], realizedPnlAsset: undefined }, fills[1]],
    }),
    /TRADE_PROJECTOR_UNSUPPORTED_ASSET/u,
  );
  await assert.rejects(
    projectTradeReadModels({
      generation: 14,
      fills: [{ ...fills[0], realizedPnlAsset: 'USDC' }, fills[1]],
    }),
    /TRADE_PROJECTOR_PRODUCT_PROOF_INVALID/u,
  );
  const projected = await projectTradeReadModels({
    generation: 14,
    fills: [
      { ...fills[0], commissionAsset: 'BNB' },
      { ...fills[1], commissionAsset: 'USDT' },
    ],
  });
  assert.deepEqual(projected.models[0].payload.commissionByAsset, [
    { asset: 'BNB', amount: '0.27' },
    { asset: 'USDT', amount: '0.27' },
  ]);
});
