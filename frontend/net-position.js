// 唯一净持仓状态机。输入必须由 adapter 规范为：
// {time,symbol,side:'BUY'|'SELL',price,qty,fee,pnl:number|null,sourceRef?}
// 核心不舍入、不生成产品字段；1.0、2.0、report 与 legacy ingest 只做字段适配。
// 这是相对误差因子，不是数量下限。绝对 epsilon 会吞掉合法的微小仓位。
export const NET_POSITION_EPSILON = Number.EPSILON * 2;
export const netPositionNumber = (value) => +(+value).toPrecision(8);

function quantitiesEqual(left, right) {
  if (left === right) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * NET_POSITION_EPSILON;
}

function stableHash(value) {
  const text = String(value);
  const hash32 = (seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return hash32(0x811c9dc5) + hash32(0x9e3779b9);
}

function stableFillContent(fill) {
  const positionBook = fill && (fill.positionSide === 'LONG' || fill.positionSide === 'SHORT')
    ? fill.positionSide
    : '';
  const fields = [
    fill && fill.time,
    fill && fill.symbol,
    fill && fill.side,
    fill && fill.price,
    fill && fill.qty,
    fill && fill.fee,
    fill && fill.pnl,
  ];
  if (positionBook) fields.push(`positionBook:${positionBook}`);
  return fields.map(value => value == null ? '' : String(value)).join('|');
}

export function stableCycleId(cycle, {
  prefix = 'trade',
  account = '',
  market = 'crypto_perp',
} = {}) {
  const lineage = [...(cycle && cycle.lineageRefs || [])].map(String).sort();
  const positionBook = cycle && (cycle.positionSide === 'LONG' || cycle.positionSide === 'SHORT')
    ? cycle.positionSide
    : '';
  const fields = [
    'rv-cycle/1', account, market,
    cycle && cycle.symbol, cycle && cycle.side,
    cycle && cycle.entryTime, cycle && cycle.exitTime,
    lineage.join(','),
  ];
  if (positionBook) fields.push(`positionBook:${positionBook}`);
  const payload = fields.join('|');
  return `${prefix}_${stableHash(payload)}`;
}

export function reduceNetPositionsCore(fills) {
  const fallbackOccurrences = new Map();
  const ordered = (fills || [])
    .map((fill, index) => {
      let sourceRef = fill && (fill.sourceRef ?? fill.id);
      if (sourceRef == null) {
        const fingerprint = `content:${stableHash(stableFillContent(fill))}`;
        const occurrence = fallbackOccurrences.get(fingerprint) || 0;
        fallbackOccurrences.set(fingerprint, occurrence + 1);
        sourceRef = `${fingerprint}:${occurrence}`;
      }
      return { fill: { ...fill, sourceRef }, index };
    })
    .sort((a, b) => (+a.fill.time - +b.fill.time) || (a.index - b.index));
  const byPositionBook = new Map();
  for (const item of ordered) {
    const symbol = item.fill.symbol;
    const positionSide = item.fill.positionSide === 'LONG' || item.fill.positionSide === 'SHORT'
      ? item.fill.positionSide
      : 'BOTH';
    const bookKey = `${symbol}\u0000${positionSide}`;
    if (!byPositionBook.has(bookKey)) {
      byPositionBook.set(bookKey, { symbol, positionSide, rows: [] });
    }
    byPositionBook.get(bookKey).rows.push(item.fill);
  }

  const closedTrades = [];
  const openPositions = [];
  for (const { symbol, positionSide, rows } of byPositionBook.values()) {
    let state = null;
    const openState = (fill, direction, qty, fee, reportedPnl) => ({
      symbol,
      positionSide,
      direction,
      positionQty: direction * qty,
      positionValue: +fill.price * qty,
      entryTime: +fill.time,
      entryValue: +fill.price * qty,
      entryQty: qty,
      firstEntryPrice: +fill.price,
      entryLegs: 1,
      entryRefs: new Set(fill.sourceRef == null ? [] : [fill.sourceRef]),
      lineageRefs: new Set(fill.sourceRef == null ? [] : [fill.sourceRef]),
      exitValue: 0,
      exitQty: 0,
      firstExitPrice: null,
      exitLegs: 0,
      fee,
      reportedPnl: reportedPnl == null ? (fill.pnl == null ? 0 : +fill.pnl) : reportedPnl,
      reportedComplete: true,
      selfPnl: 0,
    });
    const closeState = (fill) => {
      const entryPrice = state.entryLegs === 1 ? state.firstEntryPrice : state.entryValue / state.entryQty;
      closedTrades.push({
        symbol,
        positionSide,
        side: state.direction > 0 ? 'LONG' : 'SHORT',
        entryTime: state.entryTime,
        exitTime: +fill.time,
        entryPrice,
        exitPrice: state.exitLegs === 1 ? state.firstExitPrice : state.exitQty ? state.exitValue / state.exitQty : +fill.price,
        qty: state.entryQty,
        fee: state.fee,
        grossPnl: state.reportedComplete ? state.reportedPnl : state.selfPnl,
        pnlSelfCalc: !state.reportedComplete,
        entryRefs: [...state.entryRefs],
        lineageRefs: [...state.lineageRefs],
      });
    };

    for (const fill of rows) {
      const direction = fill.side === 'BUY' ? 1 : -1;
      const qty = +fill.qty;
      const price = +fill.price;
      const fee = +fill.fee || 0;
      if (!state) {
        state = openState(fill, direction, qty, fee);
        continue;
      }
      if (state.direction === direction) {
        state.positionQty += direction * qty;
        state.positionValue += price * qty;
        state.entryValue += price * qty;
        state.entryQty += qty;
        state.entryLegs += 1;
        if (fill.sourceRef != null) state.entryRefs.add(fill.sourceRef);
        if (fill.sourceRef != null) state.lineageRefs.add(fill.sourceRef);
        state.fee += fee;
        if (fill.pnl != null) state.reportedPnl += +fill.pnl;
        continue;
      }

      const currentQty = Math.abs(state.positionQty);
      const closesExactly = quantitiesEqual(currentQty, qty);
      const crossesZero = !closesExactly && qty > currentQty;
      const closingQty = closesExactly || crossesZero ? currentQty : qty;
      const openingQty = crossesZero ? qty - currentQty : 0;
      const closingFee = closesExactly ? fee : fee * (closingQty / qty);
      const openingFee = fee - closingFee;
      const avgEntryPrice = state.positionValue / currentQty;
      if (fill.sourceRef != null) state.lineageRefs.add(fill.sourceRef);
      state.fee += closingFee;
      state.selfPnl += (state.direction > 0 ? price - avgEntryPrice : avgEntryPrice - price) * closingQty;
      state.positionValue -= avgEntryPrice * closingQty;
      state.exitValue += price * closingQty;
      state.exitQty += closingQty;
      if (state.exitLegs === 0) state.firstExitPrice = price;
      state.exitLegs += 1;
      if (fill.pnl == null) state.reportedComplete = false;
      else state.reportedPnl += +fill.pnl;

      if (closesExactly) {
        state.positionQty = 0;
        state.positionValue = 0;
        closeState(fill);
        state = null;
      } else if (crossesZero) {
        state.positionQty = 0;
        state.positionValue = 0;
        closeState(fill);
        state = openState(fill, direction, openingQty, openingFee, 0);
      } else {
        state.positionQty = state.direction * (currentQty - qty);
      }
    }

    if (state && state.positionQty !== 0) {
      openPositions.push({
        symbol,
        positionSide,
        side: state.direction > 0 ? 'LONG' : 'SHORT',
        entryTime: state.entryTime,
        entryPrice: state.entryLegs === 1 ? state.firstEntryPrice : state.positionValue / Math.abs(state.positionQty),
        cycleEntryPrice: state.entryLegs === 1 ? state.firstEntryPrice : state.entryValue / state.entryQty,
        entryQty: state.entryQty,
        openQty: Math.abs(state.positionQty),
        fee: state.fee,
        reportedPnl: state.reportedPnl,
        selfPnl: state.selfPnl,
        pnlSelfCalc: !state.reportedComplete,
        entryRefs: [...state.entryRefs],
        lineageRefs: [...state.lineageRefs],
      });
    }
  }
  closedTrades.sort((a, b) => a.exitTime - b.exitTime);
  return { closedTrades, openPositions };
}
