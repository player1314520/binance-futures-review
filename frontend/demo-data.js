// demo-data.js — 逼真的 Binance USDT-M 合约演示数据(2026-05-18 ~ 2026-07-03, UTC+8 口径)
// 故事线:整体小赚,但 6/10 深夜扛单大亏 -507;报复单、深夜单是主要漏洞;近一周纪律连胜。

export const START_EQUITY = 12000;

export const ACCOUNTS = [
  { id: 'all', name: '全部账户', short: '全' },
  { id: 'main', name: '主账户 · U本位合约', short: '主' },
  { id: 'training', name: '山寨训练仓', short: '训' },
];

export const BASE_PRICES = {
  BTCUSDT: 118400, ETHUSDT: 5580, SOLUSDT: 297,
  DOGEUSDT: 0.309, ORDIUSDT: 37.8, '1000PEPEUSDT': 0.0189,
};

const DECIMALS = { BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 2, DOGEUSDT: 5, ORDIUSDT: 3, '1000PEPEUSDT': 6 };
export function priceDecimals(sym) { return DECIMALS[sym] ?? 2; }

// 确定性价格路径:基价 + 缓慢漂移(导出给 α/β 基准对标复用)
export function pathPrice(sym, ms) {
  const base = BASE_PRICES[sym] || 100;
  const day = (ms - Date.UTC(2026, 4, 1)) / 86400000;
  const drift = 1 + day * 0.0007 + 0.012 * Math.sin(day / 4.2) + 0.006 * Math.sin(day / 1.7 + 2);
  return base * drift;
}

function T(mmdd, hhmm) {
  const [mo, d] = mmdd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(2026, mo - 1, d, h - 8, mi); // 北京时间 → UTC
}

// [acct, symbol, side, 'MM-DD', 'HH:mm', durMin, netPnl, emotion, tags, stopRespected, plannedRisk, note]
const ROWS = [
  // —— 第 1 周 · 开局平稳
  ['main','BTCUSDT','LONG','05-18','09:40',95,62,'平静',[],1,120,'早盘回踩确认后做多,按计划止盈。'],
  ['main','ETHUSDT','SHORT','05-18','14:20',130,-48,'专注',[],1,120,'压力位做空,止损打掉,亏损在预算内。'],
  ['main','SOLUSDT','LONG','05-19','10:15',220,88,'自信',[],1,120,''],
  ['main','BTCUSDT','SHORT','05-19','21:30',45,-35,'平静',[],1,120,''],
  ['main','ETHUSDT','LONG','05-20','11:05',320,104,'专注',[],1,120,'趋势日拿住了大部分波段。'],
  ['main','SOLUSDT','SHORT','05-21','15:40',60,-62,'焦虑',['未等确认'],1,120,'信号没走完就进场,进早了。'],
  ['main','BTCUSDT','LONG','05-22','10:20',180,96,'平静',[],1,120,''],
  // —— 第 2 周 · 震荡市过度交易
  ['main','ETHUSDT','LONG','05-25','09:55',70,54,'自信',[],1,120,''],
  ['main','SOLUSDT','LONG','05-25','13:10',40,-58,'兴奋',['追涨杀跌'],1,120,'看到拉升直接追,进在局部顶。'],
  ['main','BTCUSDT','SHORT','05-26','16:20',200,71,'专注',[],1,120,''],
  ['main','DOGEUSDT','LONG','05-27','10:05',25,-44,'兴奋',['冲动交易'],1,120,'计划里没有 DOGE,看到异动手痒。'],
  ['main','SOLUSDT','SHORT','05-27','11:00',35,-51,'报复',['报复交易'],1,120,'上一笔刚亏完 35 分钟内又开,想赢回来。'],
  ['main','ETHUSDT','SHORT','05-27','14:30',90,38,'平静',['提前止盈'],1,120,'目标位没到就跑,少赚一半。'],
  ['main','BTCUSDT','LONG','05-27','22:15',55,-49,'疲惫',['冲动交易'],1,120,'一天第 4 笔,状态已经不对。'],
  ['main','SOLUSDT','LONG','05-28','10:40',150,83,'专注',[],1,120,''],
  ['main','ETHUSDT','LONG','05-29','02:10',120,-95,'疲惫',['逆势硬扛'],1,120,'凌晨两点抄底,越跌越不想砍。'],
  ['main','BTCUSDT','LONG','05-29','10:50',140,58,'平静',[],1,120,''],
  // —— 第 3 周 · 状态回来,6/06 最佳日
  ['main','BTCUSDT','LONG','06-01','10:10',160,92,'专注',[],1,120,''],
  ['main','ETHUSDT','SHORT','06-02','14:45',75,-57,'平静',[],1,120,''],
  ['main','SOLUSDT','LONG','06-02','20:30',240,118,'自信',[],1,120,'周线支撑 + 缩量回踩,标准剧本。'],
  ['main','BTCUSDT','LONG','06-03','11:25',90,49,'平静',['提前止盈'],1,120,''],
  ['main','DOGEUSDT','SHORT','06-04','15:10',65,-41,'专注',[],1,120,''],
  ['main','ETHUSDT','LONG','06-05','09:50',200,87,'自信',[],1,120,''],
  ['main','SOLUSDT','SHORT','06-05','22:40',900,213,'专注',[],1,130,'顶部结构确认后过夜空单,拿满 15 小时。'],
  ['main','BTCUSDT','LONG','06-06','14:20',55,17,'平静',[],1,120,''],
  // —— 6/08-6/10 · 大亏事件
  ['main','ETHUSDT','LONG','06-08','10:30',85,44,'平静',[],1,120,''],
  ['main','SOLUSDT','LONG','06-09','04:05',1625,-507,'焦虑',['止损犹豫','扛单'],0,130,'凌晨进场,跌破失效位没走,想等反弹,一路扛了 27 小时。'],
  ['main','DOGEUSDT','SHORT','06-10','07:28',22,-53,'报复',['报复交易','冲动交易'],1,120,'大亏后 18 分钟就开下一单,纯情绪。'],
  ['main','BTCUSDT','LONG','06-10','23:50',130,-18,'疲惫',[],1,120,'不甘心空仓过夜,小亏出局。'],
  // —— 6/11-6/13 · 缩量疗伤
  ['main','BTCUSDT','LONG','06-11','10:35',95,36,'犹豫',['提前止盈'],1,60,'只敢拿一半仓位,回本心态。'],
  ['main','ETHUSDT','SHORT','06-12','15:20',110,47,'平静',[],1,60,''],
  ['main','SOLUSDT','LONG','06-13','11:10',80,-29,'专注',[],1,60,''],
  // —— 6/15-6/19 · 恢复
  ['main','BTCUSDT','SHORT','06-15','13:40',170,76,'专注',[],1,120,''],
  ['main','ETHUSDT','LONG','06-16','10:05',220,91,'自信',[],1,120,''],
  ['main','SOLUSDT','SHORT','06-16','21:15',60,-47,'平静',[],1,120,''],
  ['main','BTCUSDT','LONG','06-17','09:45',140,63,'专注',[],1,120,''],
  ['main','DOGEUSDT','LONG','06-18','14:30',30,-38,'兴奋',['追涨杀跌'],1,120,''],
  ['main','ETHUSDT','LONG','06-19','10:20',260,85,'平静',[],1,120,''],
  // —— 6/22-6/26 · 两笔深夜单又漏血
  ['main','SOLUSDT','LONG','06-22','11:30',90,52,'平静',[],1,120,''],
  ['main','BTCUSDT','SHORT','06-23','00:40',75,-83,'疲惫',['冲动交易'],1,120,'睡不着爬起来开单。'],
  ['main','ETHUSDT','SHORT','06-23','14:10',120,58,'专注',[],1,120,''],
  ['main','SOLUSDT','SHORT','06-24','10:25',45,-49,'焦虑',['未等确认'],1,120,''],
  ['main','BTCUSDT','LONG','06-25','15:35',210,77,'自信',[],1,120,''],
  ['main','ETHUSDT','LONG','06-26','03:20',95,-88,'疲惫',['追涨杀跌'],1,120,'凌晨追反弹,追在半山腰。'],
  // —— 6/29-7/02 · 纪律连胜周
  ['main','BTCUSDT','LONG','06-29','10:15',130,69,'平静',[],1,120,'按清单逐项确认后进场。'],
  ['main','ETHUSDT','SHORT','06-29','15:40',85,-36,'专注',[],1,120,'止损干脆,单笔亏损 0.3%。'],
  ['main','SOLUSDT','LONG','06-30','11:05',190,94,'自信',[],1,120,''],
  ['main','BTCUSDT','LONG','07-01','09:50',110,57,'平静',[],1,120,''],
  ['main','ETHUSDT','LONG','07-01','14:25',240,81,'专注',[],1,120,''],
  ['main','SOLUSDT','SHORT','07-02','10:45',70,-33,'平静',[],1,120,''],
  ['main','BTCUSDT','SHORT','07-02','16:30',95,48,'专注',[],1,120,''],
  // —— 今日 7/03
  ['main','BTCUSDT','LONG','07-03','09:35',85,86,'平静',[],1,120,'开盘剧本 A:回踩 118k 确认多。'],
  ['main','ETHUSDT','SHORT','07-03','11:20',40,-42,'专注',['未等确认'],1,120,'M15 信号没收线就进,老毛病。'],
  // —— 山寨训练仓(小仓位)
  ['training','DOGEUSDT','LONG','05-21','20:10',35,-12,'兴奋',['计划外品种'],1,20,''],
  ['training','1000PEPEUSDT','LONG','05-27','21:05',50,-18,'兴奋',['追涨杀跌'],1,20,''],
  ['training','ORDIUSDT','SHORT','06-03','16:40',120,22,'专注',[],1,20,''],
  ['training','1000PEPEUSDT','SHORT','06-09','22:30',45,-15,'焦虑',[],1,20,''],
  ['training','DOGEUSDT','LONG','06-12','20:50',60,9,'平静',[],1,20,''],
  ['training','ORDIUSDT','LONG','06-18','21:15',90,-21,'兴奋',['追涨杀跌'],1,20,''],
  ['training','1000PEPEUSDT','LONG','06-24','20:30',30,-11,'兴奋',['冲动交易'],1,20,''],
  ['training','DOGEUSDT','SHORT','06-30','21:40',75,14,'专注',[],1,20,''],
  ['training','ORDIUSDT','LONG','07-01','22:10',40,-9,'平静',[],1,20,''],
];

// —— 策略 / Setup 分类(用于 per-setup edge 分析)——
export const SETUPS = ['回踩确认', '结构破位', '区间反转', '趋势突破', '追突破反抽', '抄底摸顶', '抢跑进场', '消息驱动'];
function assignSetup(t, i) {
  const tg = t.tags || [];
  if (tg.includes('追涨杀跌')) return '追突破反抽';
  if (tg.includes('逆势硬扛') || tg.includes('扛单') || tg.includes('止损犹豫')) return '抄底摸顶';
  if (tg.includes('未等确认')) return '抢跑进场';
  if (tg.includes('计划外品种')) return '消息驱动';
  if (t.pnl > 0) return t.side === 'LONG' ? '回踩确认' : '结构破位';
  return i % 2 === 0 ? '区间反转' : '趋势突破';
}

// —— 订单证据(模拟交易所订单流:止损单轨迹 / 入场成交方式 / 资金费结算)——
// 与自报数据相对:这三行事实由 allOrders + income 还原,故事线与 tags 一致——
// 情绪单往往根本没挂止损;扛单是「挂了又撤」;追单一律市价吃单。
const NAKED_TAGS = ['冲动交易', '报复交易', '计划外品种'];
const CHASE_TAGS = ['追涨杀跌', '冲动交易', '报复交易', '抢跑进场', '未等确认'];
const FUND_MS = 8 * 3600000; // 每 8 小时一次资金费结算(UTC 00/08/16)
function buildEvidence(i, tags, stopOk, side, entryTime, exitTime, entryPrice, qty, notional, plannedRisk, symbol) {
  const dir = side === 'LONG' ? 1 : -1;
  const hesitate = tags.includes('止损犹豫');
  const carried = !stopOk || tags.includes('扛单') || tags.includes('逆势硬扛');
  const naked = stopOk && tags.some(x => NAKED_TAGS.includes(x));
  let stopPlaced, stopCancels, stopHeld;
  if (naked) { stopPlaced = false; stopCancels = 0; stopHeld = false; }
  else if (carried) { stopPlaced = true; stopCancels = hesitate ? 2 : 1; stopHeld = false; }
  else { stopPlaced = true; stopCancels = 0; stopHeld = true; }
  const stopPrice = stopPlaced ? round(entryPrice - dir * (plannedRisk / qty), priceDecimals(symbol)) : null;
  const entryType = tags.some(x => CHASE_TAGS.includes(x)) ? 'MARKET' : (i % 9 === 4 ? 'MARKET' : 'LIMIT');
  const fundingN = Math.max(0, Math.floor(exitTime / FUND_MS) - Math.floor(entryTime / FUND_MS));
  const rate = 0.0001 + ((i % 5) - 2) * 0.00002; // 0.006%~0.014%,恒为正(多付空收)
  const funding = fundingN ? round((side === 'SHORT' ? 1 : -1) * fundingN * rate * notional, 2) : 0;
  return { stopPlaced, stopPrice, stopCancels, stopHeld, entryType, funding, fundingN };
}

export function demoTrades() {
  return ROWS.map((r, i) => {
    const [account, symbol, side, mmdd, hhmm, durMin, pnl, emotion, tags, stopOk, plannedRisk, note] = r;
    const entryTime = T(mmdd, hhmm);
    const exitTime = entryTime + durMin * 60000;
    const isTraining = account === 'training';
    const baseNotional = isTraining ? 380 : (Math.abs(pnl) > 200 ? 4800 : 2600 + ((i * 37) % 5) * 520);
    const entryPrice = round(pathPrice(symbol, entryTime), priceDecimals(symbol));
    const qty = round(baseNotional / entryPrice, symbol === 'BTCUSDT' ? 4 : symbol === 'ETHUSDT' ? 3 : 1);
    const notional = round(qty * entryPrice, 2);
    const fee = round(notional * 0.0005 * 2, 2);
    const dir = side === 'LONG' ? 1 : -1;
    const gross = pnl + fee;
    const exitPrice = round(entryPrice + dir * gross / qty, priceDecimals(symbol));
    return {
      id: 'D' + String(i + 1).padStart(3, '0'),
      account, symbol, side, entryTime, exitTime, entryPrice, exitPrice, qty,
      leverage: isTraining ? 3 : Math.abs(pnl) > 200 ? 8 : 6,
      notional, fee, pnl, plannedRisk, stopRespected: !!stopOk,
      tags: tags.slice(), emotion, note: note || '', isTraining,
      setup: assignSetup({ side, tags, emotion, pnl }, i),
      evidence: buildEvidence(i, tags, !!stopOk, side, entryTime, exitTime, entryPrice, qty, notional, plannedRisk, symbol),
    };
  });
}

function round(v, d) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

// —— 每日日志(仪式打卡 + 盘后笔记 + 明日规则)
export function demoJournal() {
  return {
    '2026-05-22': { done: true, mood: '平静', note: '本周按计划走,唯一问题是周四 SOL 那笔没等确认。', rules: ['只做 A 级信号'] },
    '2026-05-27': { done: true, mood: '烦躁', note: '一天四笔,越做越乱。震荡市就该降频。', rules: ['每天最多 2 笔'] },
    '2026-06-06': { done: true, mood: '自信', note: 'SOL 过夜空单拿满,这才是我该有的样子:结构确认 → 下单 → 不看盘。', rules: ['继续只做结构确认'] },
    '2026-06-10': { done: true, mood: '崩溃', note: '扛了 27 小时,-507。明知道破位该走,一直在等反弹。之后 18 分钟就开报复单。必须写进铁律:破失效位无条件市价走。', rules: ['破失效位无条件离场', '大亏后 24 小时禁止开单'] },
    '2026-06-11': { done: true, mood: '低落', note: '半仓恢复交易,先把流程走对,不求赚。', rules: ['半仓一周'] },
    '2026-06-19': { done: true, mood: '平静', note: '一周 +230,流程感回来了。', rules: [] },
    '2026-06-26': { done: true, mood: '疲惫', note: '又是凌晨的单亏钱。数据说 0-5 点我从来不赚钱,为什么还要开?', rules: ['0-5 点物理断网'] },
    '2026-06-29': { done: true, mood: '平静', note: '清单化进场,止损干脆。', rules: [] },
    '2026-06-30': { done: true, mood: '专注', note: 'SOL 回踩多单教科书级执行。', rules: [] },
    '2026-07-01': { done: true, mood: '平静', note: '两笔都按剧本,拿的时间也够。', rules: [] },
    '2026-07-02': { done: true, mood: '平静', note: '小亏 + 小赚,情绪无波动,连续第 4 天完成复盘。', rules: [] },
  };
}

// 明日/今日交易剧本(仪式第 6 步的默认素材)
export const DEFAULT_RULES = ['破失效位无条件离场', '0-5 点不开新仓', '大亏后 24 小时冷静期', '每天最多 3 笔'];

// —— 确定性 1h 行情重建(市场情境引擎的 demo 数据源)——
// 任意窗口切片结果一致:噪声用 hash(品种, 小时序号) 而非顺序 RNG
function h32(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd01(key) { return (h32(key) % 100000) / 100000; }
const HOUR_MS = 3600000;
export function synthHourly(sym, startMs, endMs) {
  const dec = priceDecimals(sym);
  const rr = v => +v.toFixed(Math.min(6, dec + 1));
  const i0 = Math.floor(startMs / HOUR_MS) - 1, i1 = Math.ceil(endMs / HOUR_MS) + 1;
  const ph = h32(sym) % 63;
  const out = []; let prevC = null;
  for (let i = i0; i <= i1; i++) {
    const t = i * HOUR_MS;
    const base = pathPrice(sym, t);
    const wave = Math.sin(i / 5.3 + ph) * 0.0062 + Math.sin(i / 17.7 + ph * 2) * 0.009 + Math.sin(i / 2.1 + ph) * 0.0028;
    const noise = (rnd01(sym + ':' + i) - 0.5) * 0.006;
    const c = base * (1 + wave + noise);
    const o = prevC == null ? c * (1 + (rnd01(sym + ':o' + i) - 0.5) * 0.004) : prevC;
    const sp = base * (0.0016 + 0.004 * rnd01(sym + ':s' + i)) * (1 + Math.abs(wave) * 30);
    out.push({ t, o: rr(o), h: rr(Math.max(o, c) + sp * 0.55), l: rr(Math.min(o, c) - sp * 0.55), c: rr(c), v: Math.round(300 + rnd01(sym + ':v' + i) * 1200) });
    prevC = c;
  }
  return out;
}
// 任意周期的 BTC 影子线(回放图叠加用,只需收盘价)
export function synthShadow(startMs, endMs, stepMs) {
  const out = [];
  const i0 = Math.floor(startMs / stepMs), i1 = Math.ceil(endMs / stepMs);
  for (let i = i0; i <= i1; i++) {
    const t = i * stepMs;
    const hIdx = t / HOUR_MS;
    const base = pathPrice('BTCUSDT', t);
    const wave = Math.sin(hIdx / 5.3 + 11) * 0.0062 + Math.sin(hIdx / 17.7 + 22) * 0.009;
    out.push({ t, c: Math.round(base * (1 + wave) * 10) / 10 });
  }
  return out;
}
