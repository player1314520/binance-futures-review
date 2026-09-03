// engine.js — 复盘指标引擎(纯函数,UTC+8 口径)
import { reduceNetPositionsCore, stableCycleId } from './net-position.js';
const HOUR = 3600000, DAY = 86400000, TZ = 8 * HOUR;

// —— 时间/格式化 ——
export function bj(ms) {
  const d = new Date(ms + TZ);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
export function dateKey(ms) { const b = bj(ms); return `${b.y}-${String(b.mo).padStart(2, '0')}-${String(b.d).padStart(2, '0')}`; }
export function keyToMs(key) { const [y, mo, d] = key.split('-').map(Number); return Date.UTC(y, mo - 1, d) - TZ; }
// —— 市场注册表(2026-07-13 Phase 0.3,多市场地基):每市场一份描述符,单一真相 ——
// 新市场(美股/A股/期货)进场时在此登记:时区/交易日历/时段表/配对策略/年化天数——不再散落硬编码。
// crypto_perp = 现有全部存量的口径;它的时段细分由 assetClass/tradeSession(美股token/金属/加密路由)承担。
export const MARKETS = {
  crypto_perp: { label: '加密永续', currency: 'USDT', annualDays: 365, symbolSuffix: 'USDT', pairing: 'net-position' },
  // equity_us: Phase 3(FIFO 配对/NY 日历/USD);equity_cn: 远期(T+1/手/CNY)。登记前不写一行市场专属代码。
};
export const CURRENCIES = { USDT: '$', USD: '$', CNY: '¥', HKD: 'HK$', EUR: '€', JPY: '¥' };
export const RESULT_ENVELOPE_VERSION = 'rv-result/1';
export const CANONICAL_RECORD_VERSION = 'rv-canonical-trade/1';
export const PROVENANCE_VERSION = 'rv-provenance/1';
export const CAPABILITY_VERSION = 'rv-capabilities/1';
export const DIAGNOSTICS_VERSION = 'rv-diagnostics/1';
// This is intentionally narrower than a source label.  A CSV can look like a
// Binance report (or simply contain Fee/PnL columns) without being safe to use
// its trade IDs as a cross-file execution clock.  Only the parser below may
// emit this exact marker after it has matched the USD-M futures header schema.
export const BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE = Object.freeze({
  version: 'rv-binance-usdm-csv-execution-order/1',
  adapterId: 'builtin/binance-usdm-futures-csv/1',
  headerSchema: 'date(utc)|symbol|side|price|quantity|fee|realized profit|trade id',
});
export const DIAGNOSTIC_CODES = Object.freeze({
  invalid_record: 'invalid_record',
  invalid_id: 'invalid_id',
  duplicate_id: 'duplicate_id',
  invalid_time: 'invalid_time',
  empty_symbol: 'empty_symbol',
  invalid_side: 'invalid_side',
  invalid_number: 'invalid_number',
  non_positive_qty: 'non_positive_qty',
  non_positive_price: 'non_positive_price',
  invalid_time_range: 'invalid_time_range',
  invalid_fill: 'invalid_fill',
  invalid_enum: 'invalid_enum',
  invalid_boolean: 'invalid_boolean',
  resource_limit: 'resource_limit',
  invalid_fee: 'invalid_fee',
  invalid_pnl: 'invalid_pnl',
  unsupported_position_mode: 'unsupported_position_mode',
  unsupported_fee_asset: 'unsupported_fee_asset',
  unsupported_pnl_asset: 'unsupported_pnl_asset',
  unsupported_settlement_currency: 'unsupported_settlement_currency',
});
// —— 数据源能力注册表(2.0 蓝图第1期):5+1 个正交 capability flag ——
// 宪法①:代码只查 flag,不查等级数字(真实数据源是锯齿状的,线性等级会被打穿);L0-L3 只是给人看的标签。
// 宪法②:不可观测 ≠ 通过 ≠ 隐藏——flag 为 false 的分析显示「此数据源不可观测」,不进分母、不冒充通过。
const sourceCaps = (values = {}) => Object.freeze({
  fills: false,
  orders: false,
  pnlReported: false,
  fees: false,
  income: false,
  ledger: false,
  klines: false,
  timePrecision: 'unknown',
  ...values,
});
export const SOURCE_CAPS = {
  unknown: sourceCaps(),
  'fupan-archive': sourceCaps(),
  binance: sourceCaps({ fills: true, orders: true, pnlReported: true, fees: true, income: true, ledger: true, timePrecision: 'ms' }),
  'local-engine': sourceCaps({ fills: true, orders: true, pnlReported: true, fees: true, income: true, ledger: true, timePrecision: 'ms' }),
  'binance-export': sourceCaps({ fills: true, pnlReported: true, fees: true, timePrecision: 'ms' }),
  'csv-report': sourceCaps({ fills: true, timePrecision: 'ms' }),
  'generic-sniffed': sourceCaps({ fills: true, timePrecision: 'ms' }),
  'manual-map': sourceCaps({ fills: true, timePrecision: 'unknown' }),
  'csv-trades': sourceCaps({ pnlReported: true, fees: true, timePrecision: 'day' }),
  manual: sourceCaps({ pnlReported: true, timePrecision: 'minute' }),
  'synthetic-demo': sourceCaps({ fills: true, pnlReported: true, fees: true, timePrecision: 'ms' }),
};
const CONTRACT_SOURCE_IDS = new Set(Object.keys(SOURCE_CAPS));
const CONTRACT_ADAPTER_IDS = new Set([
  'builtin/binance-local',
  'builtin/binance-usdm-futures-csv/1',
  'builtin/csv-manual-map',
  'builtin/csv-sniffer',
  'builtin/fupan-archive',
  'builtin/unknown',
]);
const CONTRACT_FIELD_ORIGINS = new Set(['observed', 'derived', 'defaulted', 'approximated', 'self-declared', 'unknown']);
const CONTRACT_DIAGNOSTIC_CODES = new Set(Object.values(DIAGNOSTIC_CODES));
const CONTRACT_DIAGNOSTIC_FIELDS = new Set([
  'record', 'trade', 'row', 'fill',
  'id', 'symbol', 'side', 'entryTime', 'exitTime', 'time',
  'entryPrice', 'exitPrice', 'price', 'qty', 'notional', 'fee', 'pnl', 'currency',
  'ordersCoverage', 'hadSL', 'stopRespected', 'evidence', 'source',
  'positionSide', 'feeAsset', 'pnlAsset',
  'archive', 'tags', 'plan', 'review', 'note', 'emotion', 'setup',
]);
const CONTRACT_SEVERITIES = new Set(['error', 'warning', 'info']);
function contractSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return CONTRACT_SOURCE_IDS.has(source) ? source : 'unknown';
}
function contractAdapterId(value) {
  const adapterId = typeof value === 'string' ? value.trim() : '';
  return CONTRACT_ADAPTER_IDS.has(adapterId) ? adapterId : 'builtin/unknown';
}
export function capsOf(value) {
  const source = contractSource(typeof value === 'string' ? value : value && value.source);
  return SOURCE_CAPS[source] || SOURCE_CAPS.unknown;
}

const CONTRACT_BOOLEAN_CAPABILITIES = ['fills', 'orders', 'pnlReported', 'fees', 'income', 'ledger', 'klines'];
const CANONICAL_TRADE_FIELDS = [
  'id', 'symbol', 'side', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice',
  'qty', 'notional', 'fee', 'pnl', 'currency',
];

export function capabilityReport(records, fallbackSource = 'unknown', overrides = null) {
  const sources = [...new Set((records || []).map(record => contractSource(record && record.source)))];
  if (!sources.length) sources.push(contractSource(fallbackSource));
  const profiles = sources.map(source => capsOf(source));
  const values = {};
  for (const key of CONTRACT_BOOLEAN_CAPABILITIES) values[key] = profiles.every(profile => profile[key] === true);
  const precisions = [...new Set(profiles.map(profile => profile.timePrecision))];
  values.timePrecision = precisions.length === 1 ? precisions[0] : 'mixed';
  // Public callers may only downgrade an advertised boolean capability. An
  // adapter cannot promote absent base evidence by passing an arbitrary flag.
  if (overrides && typeof overrides === 'object') {
    for (const key of CONTRACT_BOOLEAN_CAPABILITIES) {
      if (overrides[key] !== undefined) values[key] = values[key] === true && overrides[key] === true;
    }
  }
  return {
    version: CAPABILITY_VERSION,
    sources,
    values,
    unavailable: CONTRACT_BOOLEAN_CAPABILITIES.filter(key => values[key] !== true),
  };
}

export function diagnosticsReport(items = []) {
  const safeItems = (items || []).map((item) => ({
    index: Number.isInteger(item && item.index) && item.index >= 0 ? item.index : null,
    code: CONTRACT_DIAGNOSTIC_CODES.has(item && item.code) ? item.code : DIAGNOSTIC_CODES.invalid_record,
    field: CONTRACT_DIAGNOSTIC_FIELDS.has(item && item.field) ? item.field : 'record',
    severity: CONTRACT_SEVERITIES.has(item && item.severity) ? item.severity : 'error',
  }));
  const countsByCode = {};
  for (const item of safeItems) countsByCode[item.code] = (countsByCode[item.code] || 0) + 1;
  return {
    version: DIAGNOSTICS_VERSION,
    count: safeItems.length,
    countsByCode: Object.fromEntries(Object.entries(countsByCode).sort(([a], [b]) => a.localeCompare(b))),
    items: safeItems,
  };
}

export function createResultContract(records, {
  source = 'unknown',
  adapterId = `builtin/${source || 'unknown'}`,
  fieldOrigins = {},
  diagnostics = [],
  accepted = (records || []).length,
  dropped = diagnostics.length,
  capabilityOverrides = null,
  executionOrderEvidence = null,
} = {}) {
  const safeSource = contractSource(source);
  const safeAdapterId = contractAdapterId(adapterId);
  const safeAccepted = Number.isInteger(accepted) && accepted >= 0 ? accepted : (records || []).length;
  const safeDropped = Number.isInteger(dropped) && dropped >= 0 ? dropped : (diagnostics || []).length;
  const origins = Object.fromEntries(CANONICAL_TRADE_FIELDS.map(field => [
    field,
    CONTRACT_FIELD_ORIGINS.has(fieldOrigins[field]) ? fieldOrigins[field] : 'unknown',
  ]));
  const safeExecutionOrderEvidence = safeSource === 'binance-export'
    && safeAdapterId === BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE.adapterId
    && executionOrderEvidence
    && executionOrderEvidence.version === BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE.version
    && executionOrderEvidence.adapterId === BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE.adapterId
    && executionOrderEvidence.headerSchema === BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE.headerSchema
    ? BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE
    : null;
  return {
    version: RESULT_ENVELOPE_VERSION,
    canonical: {
      version: CANONICAL_RECORD_VERSION,
      recordType: 'trade',
      count: (records || []).length,
    },
    provenance: {
      version: PROVENANCE_VERSION,
      source: safeSource,
      adapterId: safeAdapterId,
      fieldOrigins: origins,
      coverage: {
        status: safeDropped > 0 ? (safeAccepted > 0 ? 'partial' : 'blocked') : 'complete',
        accepted: safeAccepted,
        dropped: safeDropped,
      },
      ...(safeExecutionOrderEvidence ? { executionOrderEvidence: safeExecutionOrderEvidence } : {}),
    },
    capabilities: capabilityReport(records, safeSource, capabilityOverrides),
    diagnostics: diagnosticsReport(diagnostics),
  };
}

function withResultContract(result, records, options) {
  return { ...result, contract: createResultContract(records, options) };
}
// K 线能力 = 市场×品种×时间窗 三维,不属于数据源(蓝图裁决):crypto_perp 公开 1m 可达;
// 未登记市场一律 'none' —— 绝不返回 'synth'(合成K线极值是编的,禁入 MFE/MAE,宪法③)。
export function klinesCapOf(market, _symbol, _range) { return (market || 'crypto_perp') === 'crypto_perp' ? '1m' : 'none'; }
export function marketOf(t) { return MARKETS[(t && t.market) || 'crypto_perp'] || MARKETS.crypto_perp; }
// 展示名:收口散落各处的 .replace('USDT','')——按市场剥后缀(股票代码原样),新代码一律走这里
export function displaySymbol(symbol, market) {
  const m = MARKETS[market || 'crypto_perp'];
  let s = String(symbol || '');
  if (m && m.symbolSuffix && s.endsWith(m.symbolSuffix)) s = s.slice(0, -m.symbolSuffix.length);
  return s.replace('1000', 'k');
}
// 多币种金额格式化:fmtUsd 的真实实现。fmtUsd 保留为 USDT 薄壳(views 78 处调用零改动、输出逐字节不变)。
export function fmtMoney(v, currency, sign) {
  if (v == null || Number.isNaN(v)) return '--';
  const sym = CURRENCIES[currency || 'USDT'] || '$';
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a.toFixed(a < 10 ? 2 : 1);
  return (v < 0 ? '-' + sym : sign && v > 0 ? '+' + sym : sym) + s;
}
export function fmtUsd(v, sign) { return fmtMoney(v, 'USDT', sign); }
export function fmtNum(v, d = 2) { return v == null || Number.isNaN(v) ? '--' : Number(v).toFixed(d); }
export function fmtPct(v, d = 0) { return v == null || Number.isNaN(v) ? '--' : (v * 100).toFixed(d) + '%'; }
export function fmtTime(ms) { const b = bj(ms); return `${String(b.h).padStart(2, '0')}:${String(b.mi).padStart(2, '0')}`; }
export function fmtDT(ms) { const b = bj(ms); return `${String(b.mo).padStart(2, '0')}-${String(b.d).padStart(2, '0')} ${fmtTime(ms)}`; }
export function fmtDur(min) {
  if (min == null) return '--';
  const m = Math.round(min);   // 先归一再拆位:59.6→60 走小时分支,不再出现 1h60 / 1d24h 这类进位怪胎
  if (m < 60) return m + '分';
  if (m < 1440) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
  const h = Math.round((m % 1440) / 60);
  return h === 24 ? (Math.floor(m / 1440) + 1) + 'd0h' : Math.floor(m / 1440) + 'd' + h + 'h';
}
export const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];

// —— 单笔「过程 × 结果」评估:纪律是否被执行,与盈亏无关 ——
// 五项自检对照交易者的护栏(守止损 / 风险预算 / 深夜 / 情绪 / 等确认),
// 过程分只看纪律;结果只看盈亏;两轴交叉出四象限 verdict(教科书 / 侥幸 / 成本 / 错误)。
const REV_TAGS = ['报复交易', '报复', '冲动交易'];
const CONF_TAGS = ['未等确认', '追涨杀跌', '抢跑进场', '追突破反抽'];
function rTxt(r) { return r == null ? '—' : (r >= 0 ? '+' : '') + (Math.round(r * 10) / 10) + 'R'; }
function stopDisciplineStatus(t) {
  if (t && t.stopRespected === true) return 'pass';
  if (t && t.stopRespected === false) return 'fail';
  const coverage = t && (t.ordersCoverage || (t.evidence && t.evidence.ordersCoverage));
  if (t && t.hadSL === false && coverage === 'complete') return 'fail';
  return 'unknown';
}
export function evidenceOutcomeText(check) {
  if (!check || check.unknown || check.ok == null) return '无法判断';
  return check.ok === true ? '记录为通过' : '记录为未通过';
}
export function tradeProcess(t, guards) {
  const tags = t.tags || [];
  const has = arr => arr.some(x => tags.includes(x));
  const h = bj(t.entryTime).h;
  const maxR = (guards && guards.maxRiskR) || 1.5;
  const withinRisk = t.rMultiple == null ? true : t.rMultiple >= -(maxR + 0.05);
  // 「深夜」重定义为「薄流动性时段」(TradFi 化):金属亚洲盘/美股盘前盘后休市=薄;加密24/7不罚。
  // 旧的北京 0-5 点对做美股/金属的用户错配(北京深夜=美股盘中黄金时段)。未富化 sessionThin 时退回旧口径。
  const night = t.sessionThin != null ? !!t.sessionThin : (h >= 0 && h <= 5);
  const hh = String(h).padStart(2, '0');
  // 止损三态:true=守住 / false=扛单 / null=无订单证据(未观测,不计入通过率、不当作守住)。
  // 证据来源:hadSL(交易所是否收到止损委托,null=订单流未同步/超币安90天保留)+ 用户手填 stopRespected。
  const stopStatus = stopDisciplineStatus(t);
  const stopUnknown = stopStatus === 'unknown';
  const stopOk = stopStatus === 'pass' ? true : stopStatus === 'fail' ? false : null;
  const checks = [
    { key: 'stop', label: '守住止损', ok: stopOk, unknown: stopUnknown,
      reason: t.stopRespected === false ? '人工记录：未按计划执行止损'
        : t.stopRespected === true ? '人工记录：按计划执行止损'
        : t.hadSL === false && (t.ordersCoverage || (t.evidence && t.evidence.ordersCoverage)) === 'complete'
          ? '完整订单覆盖内未检出止损委托 · 记录为未通过'
        : t.hadSL === false ? '当前订单窗口未检出止损委托 · 覆盖不完整,不能判定纪律'
        : t.hadSL === true ? '当前订单窗口检出止损委托 · 执行结果尚未确认'
        : '订单流未同步 · 无法判定是否守止损' },
    { key: 'risk', label: '亏损在预算内', ok: withinRisk,
      reason: withinRisk ? `单笔 ${rTxt(t.rMultiple)} · 未超 ${maxR}R 风险上限` : `单笔亏 ${rTxt(t.rMultiple)} · 击穿 ${maxR}R 风险预算` },
    { key: 'night', label: '非薄流动性时段', ok: !night,
      reason: !night ? `${t.sessionLabel || (hh + ':xx')} 进场 · 主流动性时段` : `${t.sessionLabel || (hh + ':xx 深夜')} 进场 · 薄流动性/休市,滑点与假突破偏多` },
    { key: 'revenge', label: '情绪克制', ok: !has(REV_TAGS),
      reason: !has(REV_TAGS) ? '无报复 / 冲动开单' : '带着报复或冲动情绪进场' },
    { key: 'confirm', label: '等到确认', ok: !has(CONF_TAGS),
      reason: !has(CONF_TAGS) ? '等到信号确认后才进场' : '没等收线确认 · 追单进场' },
  ];
  const passed = checks.filter(c => c.ok === true).length;
  const total = checks.filter(c => !c.unknown).length;
  const score = total ? passed / total : 0;
  const good = score >= 0.6;
  const win = t.pnl >= 0;
  let verdict;
  if (win && good) verdict = { key: 'textbook', label: '教科书', tone: '#0E9268', sub: '赚钱 + 好流程 —— 这就是该复制的样子,把它设成范本反复看。' };
  else if (win && !good) verdict = { key: 'luck', label: '侥幸', tone: '#B7791F', sub: '赚了钱,但流程有漏洞 —— 这次是行情赏饭,别把运气当能力。' };
  else if (!win && good) verdict = { key: 'cost', label: '成本', tone: '#6E56CF', sub: '亏损,但流程正确 —— 这是做生意该付的成本,系统没坏,继续。' };
  else verdict = { key: 'mistake', label: '错误', tone: '#D6455D', sub: '又亏又错 —— 这才是真正要堵的洞,把教训写成下次的铁律。' };
  const grade = score >= 0.9 ? 'A' : score >= 0.7 ? 'B' : score >= 0.45 ? 'C' : 'D';
  return { checks, passed, total, score, good, verdict, grade };
}

// —— 复盘雷达:把单一评分拆成六维(0-100),每维附「怎么算的」——
export function reviewRadar(trades, s, extra) {
  const { reviews = {}, journal = {}, todayKey = '', guards = {}, startEq = 12000 } = extra || {};
  const clamp01 = x => Math.max(0, Math.min(1, x));
  if (!trades.length || !s) return { dims: [] };
  let pass = 0, total = 0;
  for (const t of trades) { const p = tradeProcess(t, guards); pass += p.passed; total += p.total; }
  const disc = total ? pass / total : 0;
  const ddRatio = Math.abs(s.maxDD || 0) / Math.max(1, startEq * 0.15);
  const overR = trades.filter(t => t.rMultiple != null && t.rMultiple < -((+guards.maxRiskR || 1.5) + 0.05)).length / trades.length;
  const risk = clamp01(1 - 0.65 * clamp01(ddRatio) - 0.35 * clamp01(overR * 4));
  const revRate = trades.filter(t => reviews[t.id] && reviews[t.id].reviewed).length / trades.length;
  const streak = journalStreak(journal, todayKey, s && s.daily);
  const habit = clamp01(0.6 * revRate + 0.4 * Math.min(1, streak / 7));
  const A = advancedStats(trades);
  const stab = A.sqn == null ? 0.4 : clamp01(A.sqn / 3.2);
  return { dims: [
    { key: 'win', label: '胜率', score: Math.round(clamp01((s.winRate || 0) / 0.62) * 100), detail: `胜率 ${Math.round((s.winRate || 0) * 100)}% · 62% 拉满` },
    { key: 'payoff', label: '盈亏比', score: Math.round(clamp01((s.payoff || 0) / 2.2) * 100), detail: `盈亏比 ${(s.payoff || 0).toFixed(2)} · 2.2 拉满` },
    { key: 'disc', label: '纪律', score: Math.round(disc * 100), detail: `五项自检通过率 ${Math.round(disc * 100)}%` },
    { key: 'risk', label: '风控', score: Math.round(risk * 100), detail: `最大回撤 ${fmtUsd(s.maxDD)} · 超限单占 ${Math.round(overR * 100)}%` },
    { key: 'habit', label: '习惯', score: Math.round(habit * 100), detail: `复盘率 ${Math.round(revRate * 100)}% · 打卡连胜 ${streak} 天` },
    { key: 'stab', label: '稳定性', score: Math.round(stab * 100), detail: A.sqn == null ? '样本不足,先攒 30 笔' : `SQN ${A.sqn.toFixed(2)}(Van Tharp)` },
  ] };
}

// —— Tilt 情绪倾斜仪:盘中实时(0-100)+ 从你自己的历史提取「连亏后下一单」证据 ——
export function tiltScore(todayTrades, allTrades, guards) {
  const ts = todayTrades.slice().sort((a, b) => a.exitTime - b.exitTime);
  const factors = [];
  let score = 0;
  let streak = 0;
  for (let i = ts.length - 1; i >= 0; i--) { if (ts[i].pnl < 0) streak++; else break; }
  if (streak >= 2) { score += 25 + (streak - 2) * 12; factors.push(`连亏 ${streak} 笔`); }
  else if (streak === 1) { score += 8; factors.push('刚亏 1 笔'); }
  let revengeN = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i - 1].pnl < 0 && ts[i].entryTime - ts[i - 1].exitTime < 30 * 60000) revengeN++;
  if (revengeN) { score += 22 + (revengeN - 1) * 10; factors.push(`亏后 30 分钟内又开 ×${revengeN}`); }
  const maxT = +((guards || {}).maxTrades) || 3;
  if (ts.length >= maxT) { score += 18; factors.push(`笔数打满 ${ts.length}/${maxT}`); }
  else if (maxT && ts.length / maxT > 0.66) { score += 8; factors.push(`笔数 ${ts.length}/${maxT}`); }
  if (ts.some(t => t.sessionThin != null ? t.sessionThin : (bj(t.entryTime).h >= 0 && bj(t.entryTime).h <= 5))) { score += 15; factors.push('薄流动性时段单'); }
  const net = ts.reduce((a, t) => a + t.pnl, 0);
  const lossUse = Math.max(0, -net) / Math.max(1, +((guards || {}).maxLoss) || 400);
  if (lossUse > 0.6) { score += 15; factors.push(`亏损额度已用 ${Math.round(lossUse * 100)}%`); }
  score = Math.min(100, Math.round(score));
  const level = score >= 65 ? 'tilt' : score >= 35 ? 'warm' : 'calm';
  // 个人 tilt 档案:历史上同一天内连亏 2 笔后的下一单表现
  let evN = 0, evW = 0, evR = 0;
  const hist = allTrades.slice().sort((a, b) => a.entryTime - b.entryTime);
  for (let i = 2; i < hist.length; i++) {
    if (hist[i - 1].pnl < 0 && hist[i - 2].pnl < 0 && dateKey(hist[i - 1].exitTime) === dateKey(hist[i].entryTime)) {
      evN++; if (hist[i].pnl >= 0) evW++; if (hist[i].rMultiple != null) evR += hist[i].rMultiple;
    }
  }
  const evidence = evN >= 3 ? { n: evN, winRate: evW / evN, avgR: evR / evN } : null;
  return { score, level, factors, evidence };
}

// —— 订单证据:把交易所订单流还原成三行事实(与自报清单相对,tone: good/warn/bad/neutral/mute)——
export function orderEvidence(t) {
  const ev = t && t.evidence;
  if (!ev) return { has: false, rows: [], planRisk: null };
  const selfDeclared = ev.trust === 'self-declared';
  const px = p => (p == null ? '--' : p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 8 }) : String(p));
  let stop;
  if (selfDeclared && ev.stopPlaced === true) stop = { key: 'stop', label: '止损单', tone: 'neutral', value: `存档自报已设置 · @${px(ev.stopPrice)}`, sub: '普通 .fupan 不含真实性证明；该记录只能视为用户自报，不能证明交易所连续覆盖' };
  else if (ev.stopUnknown === true || ev.stopPlaced == null) stop = { key: 'stop', label: '止损单', tone: 'neutral', value: '— 不可观测', sub: selfDeclared ? '普通 .fupan 证据为存档自报，不能验证交易所订单状态' : '订单覆盖不足,不能判断是否曾设置或持续保留止损' };
  else if (ev.stopPlaced === false) stop = { key: 'stop', label: '止损单', tone: 'neutral', value: '当前窗口未检出', sub: '只陈述当前订单窗口；不证明窗口外保护或手动离场情况' };
  else if (ev.continuousCoverage === true && ev.trust === 'verified') stop = { key: 'stop', label: '止损单', tone: 'good', value: `✓ 连续覆盖 · @${px(ev.stopPrice)}`, sub: '订单证据明确覆盖从入场到平仓的完整区间' };
  else if (ev.stopHeld === false) stop = { key: 'stop', label: '止损单', tone: 'warn', value: `检出撤销记录 ×${ev.stopCancels || 1}`, sub: `检出 @${px(ev.stopPrice)} 相关撤销；可能是撤单、改单或替换，后续保护不可观测` };
  else stop = { key: 'stop', label: '止损单', tone: 'neutral', value: `检出止损委托 · @${px(ev.stopPrice)}`, sub: '未取得连续覆盖证据，不能判断是否一直有效至平仓' };
  let entry;
  if (ev.entryType == null) entry = { key: 'entry', label: '入场方式', tone: 'neutral', value: '— 不可观测', sub: '未提供入场订单类型' };
  else if (ev.entryType === 'MARKET') entry = { key: 'entry', label: '入场方式', tone: 'neutral', value: '市价单 · MARKET', sub: '订单类型可观测；不能仅凭类型判断是否追价' };
  else if (ev.entryType === 'LIMIT') entry = { key: 'entry', label: '入场方式', tone: 'neutral', value: '限价单 · LIMIT', sub: '订单类型可观测；是否 Maker 取决于实际流动性角色' };
  else entry = { key: 'entry', label: '入场方式', tone: 'neutral', value: `混合类型 · ${String(ev.entryType)}`, sub: '包含多种入场订单类型，不能归为单一 Maker/Taker' };
  const fundingKnown = ev.funding != null && Number.isFinite(Number(ev.funding));
  const f = fundingKnown ? Number(ev.funding) : null;
  const funding = {
    key: 'funding', label: '资金费', tone: selfDeclared || !fundingKnown ? 'neutral' : f > 0 ? 'good' : f < 0 ? 'neutral' : 'mute',
    value: !fundingKnown ? '— 不可观测' : f === 0 ? '$0.00' : (f > 0 ? '+$' : '-$') + Math.abs(f).toFixed(2),
    sub: selfDeclared ? '普通 .fupan 中的资金费只能视为存档自报' : ev.fundingN == null ? '资金费结算次数不可观测' : ev.fundingN > 0 ? `持仓跨 ${ev.fundingN} 个结算点(每 8h 一次)` : '观测窗口内未跨资金费结算点',
  };
  const planRisk = ev.stopPlaced && ev.stopPrice != null
    ? { usd: Math.round(Math.abs(t.entryPrice - ev.stopPrice) * t.qty * 100) / 100, stopPrice: px(ev.stopPrice), note: selfDeclared ? `由存档自报止损 @${px(ev.stopPrice)} 估算` : `由真实止损单 @${px(ev.stopPrice)} 反推` }
    : null;
  return { has: true, rows: [stop, entry, funding], planRisk };
}

// —— 纪律计分卡:按周聚合五项纪律的遵守率 + 每条规则的近期趋势 ——
// anchorMs(可选):「近两周」的锚。真实数据源传 Date.now()(近两周=真实的近两周,停手期显示「样本不足」
// 而非拿陈旧交易周冒充最新);不传时退回旧行为(最后有交易的两周,demo 用)。
export function disciplineTimeline(trades, guards, anchorMs) {
  const ts = trades.slice().sort((a, b) => a.entryTime - b.entryTime);
  if (!ts.length) return { weeks: [], rules: [] };
  const weekKey = ms => { const b = bj(ms); const d = new Date(Date.UTC(b.y, b.mo - 1, b.d)); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.getTime(); };
  const procs = ts.map(t => ({ t, p: tradeProcess(t, guards), wk: weekKey(t.entryTime) }));
  const wkMap = new Map();
  for (const { t, p, wk } of procs) {
    const e = wkMap.get(wk) || { wk, n: 0, pass: 0, total: 0, pnl: 0 };
    e.n++; e.pnl = round2(e.pnl + t.pnl); e.pass += p.passed; e.total += p.total;
    wkMap.set(wk, e);
  }
  const weeks = [...wkMap.values()].sort((a, b) => a.wk - b.wk).map(e => { const b = bj(e.wk); return { ...e, rate: e.total ? e.pass / e.total : 0, label: `${b.mo}/${String(b.d).padStart(2, '0')}` }; });
  const cutoff = anchorMs != null ? weekKey(anchorMs) - 7 * DAY
    : (weeks.length > 2 ? weeks[weeks.length - 2].wk : (weeks[0] || { wk: 0 }).wk);
  const ruleMap = new Map();
  for (const { p, wk } of procs) for (const c of p.checks) {
    const r = ruleMap.get(c.key) || { key: c.key, label: c.label, ok: 0, n: 0, rOk: 0, rN: 0 };
    if (!c.unknown) {
      r.n++; if (c.ok === true) r.ok++;
      if (wk >= cutoff) { r.rN++; if (c.ok === true) r.rOk++; }
    }
    ruleMap.set(c.key, r);
  }
  const rules = [...ruleMap.values()]
    .map(r => ({ ...r, rate: r.n ? r.ok / r.n : null, recentRate: r.rN ? r.rOk / r.rN : null }))
    .sort((a, b) => a.rate == null ? 1 : b.rate == null ? -1 : a.rate - b.rate);
  return { weeks, rules };
}

// —— 盈亏归因瀑布:净额被谁吃掉(毛额口径分桶,手续费单列,合计恒等于净盈亏)——
export function pnlAttribution(trades) {
  let winG = 0, normal = 0, night = 0, revenge = 0, breach = 0, fees = 0;
  const lists = { win: [], normal: [], night: [], revenge: [], breach: [] };
  const BREACH = ['未等确认', '追涨杀跌', '抢跑进场', '计划外品种', '逆势硬扛', '扛单', '止损犹豫'];
  for (const t of trades) {
    fees += t.fee || 0;
    const gross = t.pnl + (t.fee || 0);
    if (gross >= 0) { winG += gross; lists.win.push(t); continue; }
    const tags = t.tags || [];
    const thin = t.sessionThin != null ? t.sessionThin : (bj(t.entryTime).h >= 0 && bj(t.entryTime).h <= 5);
    if (tags.some(x => REV_TAGS.includes(x))) { revenge += gross; lists.revenge.push(t); }
    else if (thin) { night += gross; lists.night.push(t); }
    else if (t.stopRespected === false || tags.some(x => BREACH.includes(x))) { breach += gross; lists.breach.push(t); }
    else { normal += gross; lists.normal.push(t); }
  }
  const net = round2(winG + normal + night + revenge + breach - fees);
  return { winG: round2(winG), normal: round2(normal), night: round2(night), revenge: round2(revenge), breach: round2(breach), fees: round2(fees), net, lists };
}

// —— 回撤解剖:从权益曲线切出峰→谷→修复片段,并归因窗口内的亏损来源 ——
export function drawdownEpisodes(equity, trades) {
  if (!equity || equity.length < 3) return [];
  const eps = [];
  let peakIdx = 0, i = 1;
  while (i < equity.length) {
    if (equity[i].v >= equity[peakIdx].v) { peakIdx = i; i++; continue; }
    let troughIdx = i, j = i, endIdx = null;
    while (j < equity.length) {
      if (equity[j].v < equity[troughIdx].v) troughIdx = j;
      if (equity[j].v >= equity[peakIdx].v) { endIdx = j; break; }
      j++;
    }
    eps.push({ peakT: equity[peakIdx].t, troughT: equity[troughIdx].t, endT: endIdx != null ? equity[endIdx].t : null, depth: round2(equity[peakIdx].v - equity[troughIdx].v), peakV: equity[peakIdx].v, recovered: endIdx != null });
    if (endIdx == null) break;
    peakIdx = endIdx; i = endIdx + 1;
  }
  eps.sort((a, b) => b.depth - a.depth);
  const top = eps.slice(0, 3);
  for (const ep of top) {
    const win = trades.filter(t => t.exitTime > ep.peakT && t.exitTime <= ep.troughT);
    const losers = win.filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl);
    ep.nTrades = win.length; ep.nLosers = losers.length;
    ep.worst = losers[0] || null;
    const tagDmg = new Map();
    for (const t of losers) for (const tag of (t.tags || [])) tagDmg.set(tag, round2((tagDmg.get(tag) || 0) + t.pnl));
    ep.topTags = [...tagDmg.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([tag, dmg]) => ({ tag, dmg }));
    ep.fallDays = Math.max(1, Math.round((ep.troughT - ep.peakT) / DAY));
    ep.recoverDays = ep.recovered ? Math.max(1, Math.round((ep.endT - ep.troughT) / DAY)) : null;
    ep.depthPct = ep.peakV ? ep.depth / ep.peakV : 0;
  }
  return top;
}

// —— α/β 基准对标:你的日度权益 vs 同期等额 BTC 躺平 ——
export function benchmarkCompare(trades, startEquity, priceFn) {
  if (!trades || !trades.length || !priceFn) return null;
  const ts = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  const d0 = keyToMs(dateKey(ts[0].entryTime));
  const d1 = keyToMs(dateKey(ts[ts.length - 1].exitTime));
  const daily = new Map();
  for (const t of ts) { const k = keyToMs(dateKey(t.exitTime)); daily.set(k, (daily.get(k) || 0) + t.pnl); }
  const p0 = priceFn(d0 + 12 * HOUR);
  if (!p0 || !Number.isFinite(p0)) return null;
  const units = startEquity / p0;
  const points = []; let acc = startEquity;
  for (let d = d0; d <= d1; d += DAY) {
    acc += (daily.get(d) || 0);
    const bp = priceFn(d + 12 * HOUR);
    if (!bp || !Number.isFinite(bp)) continue;
    points.push({ t: d, you: round2(acc), btc: round2(units * bp) });
  }
  if (points.length < 2) return null;
  const youRet = (acc - startEquity) / startEquity;
  const btcRet = (points[points.length - 1].btc - startEquity) / startEquity;
  return { points, youRet, btcRet, alpha: youRet - btcRet, startEquity };
}

// —— 主统计 ——
export function computeAll(trades, startEquity = 12000) {
  const ts = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  const n = ts.length;
  const wins = ts.filter(t => t.pnl > 0), losses = ts.filter(t => t.pnl < 0);
  const net = sum(ts.map(t => t.pnl));
  const grossWin = sum(wins.map(t => t.pnl)), grossLoss = Math.abs(sum(losses.map(t => t.pnl)));
  const fees = sum(ts.map(t => t.fee || 0));
  // 权益曲线 + 回撤
  let eq = startEquity, peak = startEquity, maxDD = 0, ddStart = null, ddDays = 0;
  let peakTime = ts.length ? ts[0].entryTime - DAY : Date.now();   // 最近一次创新高的时刻(算「至今未创新高」天数)
  const equity = [{ t: ts.length ? ts[0].entryTime - DAY : Date.now(), v: startEquity, dd: 0 }];
  let curDDStart = null;
  for (const t of ts) {
    eq += t.pnl;
    if (eq > peak) { peak = eq; peakTime = t.exitTime; curDDStart = null; }
    else if (curDDStart == null) curDDStart = t.exitTime;
    const dd = eq - peak;
    if (dd < maxDD) { maxDD = dd; ddStart = curDDStart; ddDays = curDDStart ? (t.exitTime - curDDStart) / DAY : 0; }
    equity.push({ t: t.exitTime, v: round2(eq), dd: round2(dd), id: t.id, pnl: t.pnl });
  }
  // 日聚合
  const daily = new Map();
  for (const t of ts) {
    const k = dateKey(t.exitTime);
    const d = daily.get(k) || { key: k, pnl: 0, count: 0, wins: 0, fees: 0, tags: [], trades: [] };
    d.pnl = round2(d.pnl + t.pnl); d.count++; if (t.pnl > 0) d.wins++;
    d.fees += t.fee || 0; d.tags.push(...(t.tags || [])); d.trades.push(t);
    daily.set(k, d);
  }
  const dailyArr = [...daily.values()].sort((a, b) => a.key < b.key ? -1 : 1);
  // 时段
  const byHour = Array.from({ length: 24 }, (_, h) => ({ h, pnl: 0, count: 0 }));
  for (const t of ts) { const b = bj(t.entryTime); byHour[b.h].pnl = round2(byHour[b.h].pnl + t.pnl); byHour[b.h].count++; }
  // 品种
  const symMap = new Map();
  for (const t of ts) {
    const s = symMap.get(t.symbol) || { symbol: t.symbol, pnl: 0, count: 0, wins: 0, long: 0, short: 0 };
    s.pnl = round2(s.pnl + t.pnl); s.count++; if (t.pnl > 0) s.wins++;
    if (t.side === 'LONG') s.long = round2(s.long + t.pnl); else s.short = round2(s.short + t.pnl);
    symMap.set(t.symbol, s);
  }
  const bySymbol = [...symMap.values()].sort((a, b) => b.pnl - a.pnl);
  // 情绪
  const emoMap = new Map();
  for (const t of ts) {
    const e = emoMap.get(t.emotion || '未记录') || { emotion: t.emotion || '未记录', pnl: 0, count: 0, wins: 0 };
    e.pnl = round2(e.pnl + t.pnl); e.count++; if (t.pnl > 0) e.wins++;
    emoMap.set(t.emotion || '未记录', e);
  }
  const byEmotion = [...emoMap.values()].sort((a, b) => b.pnl - a.pnl);
  // 错误标签聚类(只统计亏损伤害 + 出现次数)
  const tagMap = new Map();
  for (const t of ts) for (const tag of (t.tags || [])) {
    const c = tagMap.get(tag) || { tag, count: 0, damage: 0, pnl: 0, trades: [] };
    c.count++; c.pnl = round2(c.pnl + t.pnl); if (t.pnl < 0) c.damage = round2(c.damage + t.pnl);
    c.trades.push(t.id); tagMap.set(tag, c);
  }
  const clusters = [...tagMap.values()].sort((a, b) => a.damage - b.damage);
  // 连胜/连亏
  let curW = 0, curL = 0, maxW = 0, maxL = 0;
  for (const t of ts) {
    if (t.pnl > 0) { curW++; curL = 0; } else if (t.pnl < 0) { curL++; curW = 0; }
    maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
  }
  // 滚动胜率(近20笔)
  const rolling = ts.map((t, i) => {
    const win = ts.slice(Math.max(0, i - 19), i + 1);
    return { t: t.exitTime, v: win.filter(x => x.pnl > 0).length / win.length };
  });
  // 持仓时长
  const holds = ts.map(t => (t.exitTime - t.entryTime) / 60000);
  // 薄流动性时段入场(TradFi:金属亚洲盘/美股盘前盘后休市;未富化时退回北京 0-6 点)
  const late = ts.filter(t => t.sessionThin != null ? t.sessionThin : bj(t.entryTime).h < 6);
  // 报复单:大亏(≥1.5x 计划风险)后 45 分钟内再开
  let revenge = [];
  for (let i = 1; i < ts.length; i++) {
    const prev = ts[i - 1];
    // 阈值随账户自适应:亏超 1.2×计划风险,无计划风险时退回 1.2×典型亏损(oneR,enrichTrades 算),不再硬编码 $100
    if (prev.pnl < -Math.max(80, (prev.plannedRisk || prev.oneR || 100) * 1.2) && ts[i].entryTime - prev.exitTime < 45 * 60000) revenge.push(ts[i]);
  }
  const bestDay = dailyArr.length ? dailyArr.reduce((a, b) => b.pnl > a.pnl ? b : a) : null;
  const worstDay = dailyArr.length ? dailyArr.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;
  const dayPnls = dailyArr.map(d => d.pnl);
  const sd = stdev(dayPnls);
  const activeDays = dailyArr.length;
  // —— R 体系聚合(trades 已由 enrichTrades 富化 rMultiple / maeR / mfeR) ——
  const rArr = ts.map(t => t.rMultiple || 0);
  const totalR = round2(sum(rArr));
  const avgWinR = wins.length ? round2(avg(wins.map(t => t.rMultiple || 0))) : 0;
  const avgLossR = losses.length ? round2(avg(losses.map(t => t.rMultiple || 0))) : 0;
  let _cr = 0;
  const rEquity = ts.map(t => { _cr = round2(_cr + (t.rMultiple || 0)); return { t: t.exitTime, v: _cr, r: t.rMultiple || 0, id: t.id }; });
  const rDefs = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
  const rDist = [];
  for (let i = 0; i < rDefs.length - 1; i++) rDist.push({ lo: rDefs[i], hi: rDefs[i + 1], count: rArr.filter(r => r >= rDefs[i] && r < rDefs[i + 1]).length });
  const rBelow = rArr.filter(r => r < -4).length, rAbove = rArr.filter(r => r >= 4).length;
  const avgMaeR = round2(avg(ts.map(t => t.maeR || 0))), avgMfeR = round2(avg(ts.map(t => t.mfeR || 0)));
  const exitEff = wins.length ? round2(avg(wins.map(t => t.mfeR > 0 ? Math.min(1, (t.rMultiple || 0) / t.mfeR) : 0))) : 0;
  const giveBackR = wins.length ? round2(avg(wins.map(t => Math.max(0, (t.mfeR || 0) - (t.rMultiple || 0))))) : 0;
  // —— MFE/MAE 真实 $ 聚合(H2:仅统计已回填 t.mfeReal 的交易)——
  const realX = ts.filter(t => t.mfeReal);
  const realWins = realX.filter(t => t.pnl > 0);
  const leftOnTable = round2(sum(realX.map(t => t.leftOnTable || 0)));   // 峰值本可赚到但没落袋的钱总和($)
  const winnersUnderwater = realX.filter(t => t.pnl > 0 && t.mae < -1).length;   // 盈利单里先扛过单的
  const sumMfeWins = sum(realWins.map(t => Math.max(0, t.mfe)));
  const captureRate = sumMfeWins > 0 ? round2(sum(realWins.map(t => t.pnl)) / sumMfeWins) : null;   // 赢家落袋 ÷ 峰值 = 抓住了几成
  const deepestMae = realX.length ? round2(Math.min(...realX.map(t => t.mae))) : 0;
  const worstLeftTrade = realX.length ? realX.reduce((a, b) => ((b.leftOnTable || 0) > (a.leftOnTable || 0) ? b : a)) : null;
  const setupMap = new Map();
  for (const t of ts) { const k = t.setup || '未分类'; const e = setupMap.get(k) || { setup: k, pnl: 0, count: 0, wins: 0, r: 0, sumWin: 0, sumLoss: 0, nWin: 0, nLoss: 0 }; e.pnl = round2(e.pnl + t.pnl); e.count++; e.r = round2(e.r + (t.rMultiple || 0)); if (t.pnl > 0) { e.wins++; e.sumWin += t.pnl; e.nWin++; } else if (t.pnl < 0) { e.sumLoss += Math.abs(t.pnl); e.nLoss++; } setupMap.set(k, e); }
  const bySetup = [...setupMap.values()].map(e => ({ setup: e.setup, pnl: e.pnl, count: e.count, wins: e.wins, r: e.r, winRate: e.wins / e.count, expectancyR: round2(e.r / e.count), avgPnl: round2(e.pnl / e.count), payoff: e.nWin && e.nLoss ? (e.sumWin / e.nWin) / (e.sumLoss / e.nLoss) : null })).sort((a, b) => b.r - a.r);
  const stopStatuses = ts.map(stopDisciplineStatus);
  const stopOrderEvidenceN = ts.filter(t => t.hadSL != null).length;
  const stopDisciplineN = stopStatuses.filter(status => status !== 'unknown').length;
  const stopBreaks = stopStatuses.filter(status => status === 'fail').length;
  return {
    n, net: round2(net), wins: wins.length, losses: losses.length,
    winRate: n ? wins.length / n : 0,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    grossWin: round2(grossWin), grossLoss: round2(grossLoss),
    expectancy: n ? round2(net / n) : 0,
    avgWin: wins.length ? round2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : 0,
    payoff: wins.length && losses.length ? (grossWin / wins.length) / (grossLoss / losses.length) : null,
    fees: round2(fees), feeDrag: grossWin > 0 ? fees / grossWin : 0,
    maxDD: round2(maxDD), ddDays: Math.ceil(ddDays), curEquity: round2(eq),
    recovered: eq >= peak - 1e-6, underwaterDays: eq >= peak - 1e-6 ? 0 : Math.max(0, Math.round((Date.now() - peakTime) / DAY)),
    stopEvidenceN: stopOrderEvidenceN,
    stopOrderEvidenceN,
    stopDisciplineN,
    stopUnknownN: n - stopDisciplineN,
    stopAbsentN: ts.filter(t => t.hadSL === false && (t.ordersCoverage || (t.evidence && t.evidence.ordersCoverage)) === 'complete').length,
    stopWindowAbsentN: ts.filter(t => t.hadSL === false).length,
    stopPlacedN: ts.filter(t => t.hadSL === true).length,
    rEstimatedN: ts.filter(t => t.riskFallback).length,
    equity, daily, dailyArr, byHour, bySymbol, byEmotion, clusters,
    maxWinStreak: maxW, maxLossStreak: maxL,
    rolling, holdAvg: holds.length ? avg(holds) : null, holdMax: holds.length ? Math.max(...holds) : null,
    late: { count: late.length, pnl: round2(sum(late.map(t => t.pnl))) },
    revenge, bestDay, worstDay,
    bestTrade: n ? ts.reduce((a, b) => b.pnl > a.pnl ? b : a) : null,
    worstTrade: n ? ts.reduce((a, b) => b.pnl < a.pnl ? b : a) : null,
    tradesPerDay: activeDays ? n / activeDays : 0, activeDays,
    sharpeDay: sd > 0 ? avg(dayPnls) / sd * Math.sqrt(252) : null,
    stopBreaks,
    totalR, expectancyR: n ? round2(totalR / n) : 0, avgWinR, avgLossR,
    payoffR: avgLossR ? round2(Math.abs(avgWinR / avgLossR)) : null,
    rEquity, rDist, rBelow, rAbove, bestR: n ? Math.max(...rArr) : 0, worstR: n ? Math.min(...rArr) : 0,
    rWinShare: n ? rArr.filter(r => r > 0).length / n : 0,
    avgMaeR, avgMfeR, exitEff, giveBackR, bySetup,
    mfeRealN: realX.length, leftOnTable, winnersUnderwater, captureRate, deepestMae, worstLeftTrade,
  };
}

// —— 真实权益模型(2026-07-12「彻底修」:重度出入金 + 爆仓账户)——
// 动机:computeAll 的 equity = startEquity + Σtrade.pnl,只认交易,漏掉全部转账(入金/出金)、
// 资金费、保险清算、事件合约,于是「当前权益」显示 $513 而真实余额是 $327。且它把回撤建在
// 交易线上,却又用一个假的起始资金 —— 出金被当成亏损、入金被当成恢复,两头都错。
// 本函数消费 account_equity_series RPC(按北京日的现金流累计序列),产出三条相互印证的线:
//   • 余额线 balance   = 全部 income 累计   → 账户真实余额(含转账),末点 = 现在钱包里有多少
//   • 净投入线 deposited = 转账累计(入金−出金) → 你一共往里搬了多少钱
//   • 业绩线 perf       = 非转账累计         → 交易活动真实盈亏(回撤只能锚这条)
// 恒等式:余额 = 净投入 + 业绩(≈ $327 = $2,927 − $2,600)。回撤锚业绩线:出金≠亏损、入金≠恢复。
export function equityModel(series, nowMs = Date.now()) {
  if (!Array.isArray(series) || !series.length) return null;
  const rows = series.slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));   // 合法比较器:相等返 0
  const dayMs = (s) => Date.parse(s + 'T00:00:00+08:00');   // 北京日零点(RPC 已按 Asia/Shanghai 归日)
  // 0 锚点:首个有现金流的日子前一天,三线归零 —— 避免图从某个假 startEquity 起跳。
  const t0 = dayMs(rows[0].day) - DAY;
  const points = [{ t: t0, balance: 0, deposited: 0, perf: 0, dd: 0 }];
  let perfPeak = 0, maxDD = 0, peakTime = t0, ddDays = 0;
  const liquidations = [];
  let sumTrade = 0, sumFunding = 0, sumInsurance = 0, sumEvent = 0;
  for (const r of rows) {
    const t = dayMs(r.day);
    // 累计值来自 SQL 窗口函数(与日内成交顺序无关);中间的空档天由折线自然水平前向填充,永不掉 0。
    sumTrade += +r.trade_pnl; sumFunding += +r.funding; sumInsurance += +r.insurance; sumEvent += +r.event;
    const perf = +r.cum_perf;
    if (perf > perfPeak) { perfPeak = perf; peakTime = t; }
    const dd = round2(perf - perfPeak);
    // 回撤持续天数锚在「峰值时刻」peakTime(与 underwaterDays 同锚),不是峰后第一天,避免系统性少算 1 天
    if (dd < maxDD) { maxDD = dd; ddDays = (t - peakTime) / DAY; }
    if (+r.insurance !== 0) liquidations.push({ t, day: r.day, fee: round2(+r.insurance) });
    points.push({ t, balance: round2(+r.cum_balance), deposited: round2(+r.cum_deposited), perf: round2(perf), dd, id: r.day });
  }
  const last = points[points.length - 1];
  const recovered = last.perf >= perfPeak - 1e-6;
  return {
    points,
    curBalance: last.balance,          // 真实账户余额(余额线末点)
    netDeposits: last.deposited,       // 净投入 = 入金 − 出金
    activityPnl: last.perf,            // 交易活动净盈亏(业绩线末点)= 纯交易 + 资金费 + 保险 + 事件
    tradingPnl: round2(sumTrade),      // 纯交易(已实现盈亏 + 手续费)
    funding: round2(sumFunding), insurance: round2(sumInsurance), event: round2(sumEvent),
    maxDD: round2(maxDD), ddDays: Math.ceil(ddDays),   // 回撤锚业绩线,真实交易回撤
    recovered, underwaterDays: recovered ? 0 : Math.max(0, Math.round((nowMs - peakTime) / DAY)),
    liquidations, liquidationDays: liquidations.length,  // 发生强平清算费的北京日数(markers 用)
    returnOnDeposits: last.deposited > 0 ? last.perf / last.deposited : null,   // 回报率(活动盈亏 ÷ 净投入)
    firstDay: rows[0].day, lastDay: rows[rows.length - 1].day,
  };
}

// —— 本机模式(2026-07-13):从引擎 /local/bundle 的原始 income 客户端复算账本 + 权益序列 ——
// 镜像云端 account_ledger / account_equity_series RPC,使「本机直读、免登录」也能显示资金真相 + 真实权益模型。
// 恒等式同款按构造闭合:day_flow = transfer + Σ(已按日舍入的桶),故 cum_balance ≡ 净投入 + 业绩。
export function incomeToLedger(income) {
  if (!Array.isArray(income) || !income.length) return null;
  const agg = {};
  for (const r of income) {
    const ty = r.incomeType || r.income_type || '', amt = +r.income || 0, t = +(r.time || r.ts) || 0;
    if (!agg[ty]) agg[ty] = { total: 0, n: 0, firstTs: t, lastTs: t };
    const a = agg[ty]; a.total += amt; a.n++; if (t && t < a.firstTs) a.firstTs = t; if (t > a.lastTs) a.lastTs = t;
  }
  for (const k in agg) agg[k].total = round2(agg[k].total);
  return agg;
}
export function incomeToEquitySeries(income) {
  if (!Array.isArray(income) || !income.length) return [];
  const byDay = new Map();
  for (const r of income) {
    const amt = +r.income || 0, ty = r.incomeType || r.income_type || '', k = dateKey(+(r.time || r.ts) || 0);
    let d = byDay.get(k); if (!d) { d = { day: k, transfer: 0, trade_pnl: 0, funding: 0, insurance: 0, event: 0 }; byDay.set(k, d); }
    if (ty === 'TRANSFER') d.transfer += amt;
    else if (ty === 'REALIZED_PNL' || ty === 'COMMISSION') d.trade_pnl += amt;
    else if (ty === 'FUNDING_FEE') d.funding += amt;
    else if (ty === 'INSURANCE_CLEAR') d.insurance += amt;
    else if (ty === 'EVENT_CONTRACTS_ORDER') d.event += amt;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let cb = 0, cp = 0, cd = 0;
  for (const d of days) {
    for (const kk of ['transfer', 'trade_pnl', 'funding', 'insurance', 'event']) d[kk] = round2(d[kk]);
    const perf = round2(d.trade_pnl + d.funding + d.insurance + d.event);
    const flow = round2(d.transfer + perf);
    cb = round2(cb + flow); cp = round2(cp + perf); cd = round2(cd + d.transfer);
    d.day_flow = flow; d.cum_balance = cb; d.cum_perf = cp; d.cum_deposited = cd;
  }
  return days;
}

// —— TradFi 时段引擎:按资产类别(美股token / 贵金属 / 加密)+ America/New_York 真实时区(自动夏令时)给每笔挂时段 ——
// 动机:用户主做代币化传统资产,「北京墙钟 4 桶」测不出真实结构。真时段揭示:白银亚洲盘(北京白天)是失血核心、
// 美股开盘半小时是唯一正期望窗。加密 24/7 无时段概念(不参与时段惩罚)。2026-07-12 TradFi 扫描 P0/P1。
const US_STOCK_SET = new Set(['NVDAUSDT', 'MRVLUSDT', 'NOKUSDT', 'AXTIUSDT', 'SKHYNIXUSDT', 'TSLAUSDT', 'AAPLUSDT', 'AMZNUSDT', 'METAUSDT', 'GOOGLUSDT', 'MSFTUSDT', 'AMDUSDT', 'COINUSDT', 'MSTRUSDT']);
const METAL_SET = new Set(['XAUUSDT', 'XAGUSDT', 'XPTUSDT', 'XPDUSDT']);
export function assetClass(symbol) { return US_STOCK_SET.has(symbol) ? 'us' : METAL_SET.has(symbol) ? 'metal' : 'crypto'; }
const _ET_FMT = (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null;
const _ET_DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// 返回纽约时区的 { dow:0=周日..6=周六, hm:当日分钟数 0-1439 }(夏令时由 Intl 自动处理;无 Intl 时按 EDT 近似兜底)
function etParts(ms) {
  if (!_ET_FMT) { const d = new Date(ms - 4 * HOUR); return { dow: d.getUTCDay(), hm: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
  let wd = 'Sun', h = 0, mi = 0;
  for (const p of _ET_FMT.formatToParts(new Date(ms))) { if (p.type === 'weekday') wd = p.value; else if (p.type === 'hour') h = +p.value; else if (p.type === 'minute') mi = +p.value; }
  return { dow: _ET_DOW[wd] ?? 0, hm: (h % 24) * 60 + mi };
}
// 时段桶:key 稳定标识,label 中文展示,liquidity 弱(true=薄流动性/休市,深夜规则改判它)
export function tradeSession(t) {
  const cls = assetClass(t.symbol);
  const { dow, hm } = etParts(t.entryTime);
  const weekend = dow === 0 || dow === 6;
  if (cls === 'crypto') return { class: 'crypto', key: 'crypto', label: '加密 24/7', thin: false };
  if (cls === 'us') {
    if (weekend) return { class: 'us', key: 'closed', label: '美股休市(周末)', thin: true };
    if (hm < 240 || hm >= 1200) return { class: 'us', key: 'closed', label: '美股休市(夜)', thin: true };   // 20:00-04:00 ET
    if (hm < 570) return { class: 'us', key: 'pre', label: '盘前', thin: true };            // 04:00-09:30
    if (hm < 600) return { class: 'us', key: 'open', label: '开盘半小时', thin: false };     // 09:30-10:00
    if (hm < 930) return { class: 'us', key: 'rth', label: '午盘', thin: false };           // 10:00-15:30
    if (hm < 960) return { class: 'us', key: 'power', label: '尾盘', thin: false };         // 15:30-16:00
    return { class: 'us', key: 'after', label: '盘后', thin: true };                        // 16:00-20:00
  }
  // metal(CME Globex,ET):亚洲盘(薄)18:00-03:00 / 伦敦 03:00-08:00 / 纽约(最厚)08:00-13:30 / 纽约午后 13:30-17:00 / 间歇 17:00-18:00
  if (weekend) return { class: 'metal', key: 'weekend', label: '金属周末', thin: true };
  if (hm >= 1020 && hm < 1080) return { class: 'metal', key: 'break', label: '金属收盘间歇', thin: true };
  if (hm >= 1080 || hm < 180) return { class: 'metal', key: 'asia', label: '金属亚洲盘', thin: true };
  if (hm < 480) return { class: 'metal', key: 'london', label: '金属伦敦盘', thin: false };
  if (hm < 810) return { class: 'metal', key: 'ny', label: '金属纽约盘', thin: false };
  return { class: 'metal', key: 'nypm', label: '金属纽约午后', thin: false };
}
// 按时段聚合(n/胜率/净/均值/期望R);samples<5 标 thinSample 供 UI 降级
export function sessionAgg(trades) {
  const m = new Map();
  for (const t of trades) {
    const key = t.sessionLabel || tradeSession(t).label;
    const e = m.get(key) || { label: key, class: t.sessionClass || assetClass(t.symbol), n: 0, wins: 0, pnl: 0, r: 0 };
    e.n++; if (t.pnl > 0) e.wins++; e.pnl = round2(e.pnl + t.pnl); e.r = round2(e.r + (t.rMultiple || 0)); m.set(key, e);
  }
  return [...m.values()].map(e => ({ ...e, winRate: e.n ? e.wins / e.n : 0, avgPnl: round2(e.pnl / e.n), expectancyR: round2(e.r / e.n), thinSample: e.n < 5 })).sort((a, b) => a.pnl - b.pnl);
}

// —— 全球市况:多品种近日收盘 → 最新日涨跌(mkt = {symbol:[{day,close}...]} 升序)——
// inv=true 的品种(VIX)涨=风险上升,配色反转。
const MKT_META = [['SPX', '标普', false], ['NDX', '纳指', false], ['DJI', '道指', false], ['XAUUSDT', '金', false], ['XAGUSDT', '银', false], ['BTCUSDT', 'BTC', false], ['ETHUSDT', 'ETH', false], ['VIX', 'VIX', true]];
export function marketRows(mkt) {
  if (!mkt) return [];
  const out = [];
  for (const [sym, label, inv] of MKT_META) {
    const arr = mkt[sym];
    if (!arr || arr.length < 2) continue;
    const last = arr[arr.length - 1], prev = arr[arr.length - 2];
    const pct = prev.close ? (last.close - prev.close) / prev.close : 0;
    out.push({ sym, label, pct, close: last.close, day: last.day, inv, up: inv ? pct < 0 : pct > 0 });
  }
  return out;
}

// —— R 体系:风险归一化 + MAE/MFE 偏移(在载入时对每笔富化)——
// oneR 中位数 fallback 按 (market, currency) 分组(Phase 0.5):单市场时与旧全局中位数完全一致;
// 多市场数据进来那天,A股的 ¥ 亏损不会污染加密的 $R 体系。
export function enrichTrades(trades) {
  const grpKey = (t) => ((t.market || 'crypto_perp') + '|' + (t.currency || 'USDT'));
  const oneRByGroup = new Map();
  for (const t of trades) {
    const k = grpKey(t);
    if (!oneRByGroup.has(k)) oneRByGroup.set(k, []);
    if (t.pnl < 0) oneRByGroup.get(k).push(Math.abs(t.pnl));
  }
  for (const [k, arr] of oneRByGroup) { arr.sort((a, b) => a - b); oneRByGroup.set(k, arr.length ? arr[Math.floor(arr.length / 2)] : 100); }
  for (const t of trades) {
    const oneR = oneRByGroup.get(grpKey(t));
    const risk = t.plannedRisk || oneR;
    t.riskFallback = !t.plannedRisk;
    t.oneR = risk;
    t.rMultiple = risk ? round2(t.pnl / risk) : 0;
    // MFE/MAE:优先真实 1m K线回填($,H2 已写库 t.mfe/t.mae),换算成 R;缺则退回确定性估算(demo/未回填)。
    // 真实值把「出场效率/让利/最深扛单」从旧 rng 伪数据升级为可信证据(诚实铁律)。
    if (t.mfe != null && t.mae != null) {
      t.mfeReal = true;
      t.mfeR = risk ? round2(Math.max(0, t.mfe) / risk) : 0;
      t.maeR = risk ? round2(Math.abs(Math.min(0, t.mae)) / risk) : 0;
      t.leftOnTable = round2(Math.max(0, t.mfe - t.pnl));   // 峰值本可赚到但没落袋的钱($)
    } else {
      t.mfeReal = false;
      const ex = tradeExcursion(t);
      t.maeR = ex.maeR; t.mfeR = ex.mfeR;
      t.leftOnTable = null;
    }
    const ss = tradeSession(t);   // TradFi 时段(资产类别 + 纽约真时区)
    t.session = ss.key; t.sessionLabel = ss.label; t.sessionClass = ss.class; t.sessionThin = ss.thin;
  }
  return trades;
}
// 确定性的持仓内偏移模型(demo/无逐笔数据时):赢家高点比落袋更远、进场先回撤;
// 输家不利偏移≈亏损幅度、仅有短暂浮盈。接入真实逐笔行情后可替换为实测 MAE/MFE。
function tradeExcursion(t) {
  let seed = 9; const id = t.id || 'x'; for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const rr = t.rMultiple || 0;
  let maeR, mfeR;
  if (t.pnl >= 0) { mfeR = rr + 0.3 + rng() * 1.2; maeR = 0.15 + rng() * 0.8; }
  else { maeR = Math.abs(rr) + rng() * 0.5; mfeR = rng() * 0.7; }
  return { maeR: round2(maeR), mfeR: round2(mfeR) };
}

// —— 复盘评分(0-10)+ 一句话判词 ——
export function reviewScore(s) {
  if (!s.n) return { score: null, verdict: '等待交易数据', detail: '导入或抓取成交后自动评分。' };
  let score = 5;
  if (s.expectancy > 0) score += 1.2; else score -= 1.5;
  if (s.pf >= 1.3) score += 1; else if (s.pf < 1) score -= 1;
  if (s.payoff != null) { if (s.payoff >= 1) score += 0.8; else if (s.payoff < 0.5) score -= 1.2; }
  if (s.worstTrade && s.avgLoss && s.worstTrade.pnl < s.avgLoss * 3.2) score -= 1.2;
  if (s.revenge.length) score -= 0.8;
  if (s.late.pnl < -150) score -= 0.8;
  const stopDisciplineN = s.stopDisciplineN == null ? s.stopEvidenceN : s.stopDisciplineN;
  if (stopDisciplineN > 0 && s.stopBreaks === 0) score += 0.6;
  score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
  let verdict, detail;
  const payoffBad = s.payoff != null && s.payoff < 0.6;
  if (s.net > 0 && payoffBad) { verdict = '胜率不差,但亏损尺寸正在吞掉盈利'; detail = `平均亏损是平均盈利的 ${(1 / s.payoff).toFixed(1)} 倍,单笔大亏是主要矛盾。`; }
  else if (s.net > 0 && s.pf >= 1.3) { verdict = '系统为正,重点是守住纪律漏洞'; detail = '期望值健康,把薄流动性时段单和报复单堵住即可放大。'; }
  else if (s.net > 0) { verdict = '小幅领先,但优势还不稳固'; detail = '利润因子偏低,先收敛错误标签,再谈加仓。'; }
  else { verdict = '系统当前为负,先降频止血'; detail = '优先修复最大亏损来源,再恢复正常仓位。'; }
  return { score, verdict, detail };
}

// —— 纪律风险灯 ——
export function behaviorFlags(s) {
  if (!s.n) return [];
  const flags = [];
  const worstOverrun = s.worstTrade && s.worstTrade.plannedRisk ? Math.abs(s.worstTrade.pnl) / s.worstTrade.plannedRisk : 0;
  if (worstOverrun > 2) flags.push({ level: 'red', title: '止损失守', metric: `最大亏损 = 计划风险的 ${worstOverrun.toFixed(1)} 倍`, detail: `${s.worstTrade.symbol} ${s.worstTrade.side} 亏 ${fmtUsd(s.worstTrade.pnl)},计划风险仅 ${fmtUsd(s.worstTrade.plannedRisk)}。破失效位必须无条件离场。`, tid: s.worstTrade.id });
  // 不依赖 planned_risk 的兜底红旗:单笔亏损 > 5 倍平均亏损 = 失控级亏损(用户不挂止损时 worstOverrun 恒 0,这条才兜得住)
  else if (s.worstTrade && s.avgLoss && s.worstTrade.pnl < s.avgLoss * 5) flags.push({ level: 'red', title: '单笔失控亏损', metric: `${fmtUsd(s.worstTrade.pnl)} = 平均亏损的 ${(s.worstTrade.pnl / s.avgLoss).toFixed(1)} 倍`, detail: `${s.worstTrade.symbol} ${s.worstTrade.side}。远超正常亏损尺寸——这类爆仓级单笔是净值的头号杀手,必须预设离场位。`, tid: s.worstTrade.id });
  if (s.revenge.length) flags.push({ level: 'red', title: '报复交易', metric: `${s.revenge.length} 笔大亏后 45 分钟内再开`, detail: `合计 ${fmtUsd(sum(s.revenge.map(t => t.pnl)), true)}。大亏后设 24 小时冷静期。`, tid: s.revenge[0].id });
  const stopDisciplineN = s.stopDisciplineN == null ? s.stopEvidenceN : s.stopDisciplineN;
  const stopUnknownN = s.stopUnknownN == null ? Math.max(0, s.n - stopDisciplineN) : s.stopUnknownN;
  if (s.stopAbsentN > 0) flags.push({ level: 'amber', title: '检出未预设止损', metric: `${s.stopAbsentN} 笔有完整覆盖证据`, detail: '这些交易在明确覆盖完整的订单区间内未检出预设止损；请逐笔确认并收紧离场纪律。' });
  if (stopUnknownN > 0) flags.push({
    level: 'amber',
    title: stopDisciplineN === 0 ? '止损纪律不可观测' : '止损证据覆盖不足',
    metric: `${stopUnknownN}/${s.n} 笔无法判定`,
    detail: '订单覆盖或人工确认不足，不能判定是否预设、持续持有或遵守止损。',
  });
  if (s.late.count && s.late.pnl < 0) flags.push({ level: s.late.pnl < -300 ? 'red' : 'amber', title: '薄流动性时段失血', metric: `${s.late.count} 笔,合计 ${fmtUsd(s.late.pnl, true)}`, detail: '金属亚洲盘 / 美股盘前盘后 / 休市等薄流动性窗口亏损集中——搬到主流动性时段(纽约盘 / 开盘后)。' });
  const over = s.dailyArr.filter(d => d.count >= 4);
  if (over.length) flags.push({ level: 'amber', title: '单日过度交易', metric: `${over.length} 天 ≥4 笔`, detail: `频率最高的一天 ${over[0].count} 笔;震荡市降频是唯一解。` });
  const cluster = s.clusters[0];
  if (cluster && cluster.damage < -100) flags.push({ level: 'amber', title: `高频错误:${cluster.tag}`, metric: `${cluster.count} 次,伤害 ${fmtUsd(cluster.damage)}`, detail: '在行为实验室查看该标签的完整聚类与推演。' });
  if (!flags.length) flags.push({ level: 'green', title: '暂无高危行为信号', metric: '继续保持', detail: '频率、时段、单笔尺寸均在预算内。' });
  return flags;
}

// —— 假设推演 ——
export function whatIf(trades, opts, startEquity = 12000) {
  let removedIds = new Set(), saved = 0, adj = new Map();
  const ts = trades.slice().sort((a, b) => a.exitTime - b.exitTime);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (opts.night && (t.sessionThin != null ? t.sessionThin : bj(t.entryTime).h < 6)) { removedIds.add(t.id); continue; }
    if (opts.revenge && i > 0) {
      const prev = ts[i - 1];
      if (prev.pnl < -Math.max(80, (prev.plannedRisk || prev.oneR || 100) * 1.2) && t.entryTime - prev.exitTime < 45 * 60000 && !removedIds.has(prev.id)) { removedIds.add(t.id); continue; }
    }
    if (opts.tag && (t.tags || []).includes(opts.tag)) { removedIds.add(t.id); continue; }
    if (opts.stops && t.pnl < 0 && t.plannedRisk && t.pnl < -t.plannedRisk) adj.set(t.id, -t.plannedRisk);
  }
  const simTrades = ts.filter(t => !removedIds.has(t.id)).map(t => adj.has(t.id) ? { ...t, pnl: adj.get(t.id) } : t);
  const base = computeAll(ts, startEquity), sim = computeAll(simTrades, startEquity);
  saved = round2(sim.net - base.net);
  return { base, sim, saved, removed: removedIds.size, capped: adj.size };
}

// —— 日历 ——
export function calendarMonth(dailyMap, journal, y, mo) {
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const startDow = first.getUTCDay(); // 0=周日
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push({ blank: true, key: 'b' + i });
  for (let d = 1; d <= dim; d++) {
    const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const day = dailyMap.get(key);
    cells.push({ key, d, pnl: day ? day.pnl : null, count: day ? day.count : 0, wins: day ? day.wins : 0, journal: !!(journal && journal[key] && journal[key].done) });
  }
  return cells;
}

// —— 周报/月报 ——
export function periodReport(trades, journal, startMs, endMs, label) {
  const inRange = trades.filter(t => t.exitTime >= startMs && t.exitTime < endMs);
  const s = computeAll(inRange, 0);
  const jDays = [];
  for (let ms = startMs; ms < endMs; ms += DAY) { const k = dateKey(ms + TZ); if (journal[k]) jDays.push({ key: k, ...journal[k] }); }
  return { label, startMs, endMs, stats: s, journalDays: jDays, trades: inRange };
}

// —— 打卡连胜 ——
// dailyMap(可选,dateKey→当日交易聚合 Map):提供时按「交易日连胜」计——回溯跳过「无交易且无日志」
// 的空仓日(周末/停手不断链),有交易没复盘才断;与 consistencyGrid 的 missedN(traded&&!reviewed)
// 口径一致。不提供时退回「日历日连胜」旧语义(每个自然日都要打卡)。今天没打卡不清零,只是不 +1。
// (todayKey 改锚真实今天后,旧日历日语义会让空仓日清零连胜,激励功能名存实亡——2026-07-12 时间轴扫描 P1)
export function journalStreak(journal, todayKey, dailyMap) {
  const done = (k) => !!(journal[k] && journal[k].done);
  const traded = (k) => { const d = dailyMap && dailyMap.get && dailyMap.get(k); return !!(d && d.count); };
  let streak = 0, ms = keyToMs(todayKey);
  if (done(todayKey)) streak++;
  ms -= DAY;
  for (let i = 0; i < 730; i++) {   // 硬上限:跳过语义下防长空窗死循环
    const k = dateKey(ms + TZ);
    if (done(k)) streak++;
    else if (!dailyMap || traded(k)) break;   // 无 dailyMap=旧语义任一日断;有=只在交易日缺卡时断
    ms -= DAY;
  }
  return streak;
}

// —— 本地复盘智能体(binance-review-studio)快照 → 工作台交易 ——
// ID 用智能体行 id(或 symbol+closeTime)确定化:跨轮询稳定,复盘卡评级/三段复盘不丢。
export function agentTradesToWorkbench(snapshot) {
  const rows = (snapshot && snapshot.analysis && snapshot.analysis.closedTrades) || [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.closeTime || !r.symbol) continue;
    const entryTime = Number(r.openTime || r.closeTime), exitTime = Number(r.closeTime);
    const qty = Math.abs(Number(r.quantity ?? r.qty ?? 0)) || 0;
    const entryPrice = Number(r.entryPrice ?? r.price ?? 0) || 0;
    const gross = Number(r.grossPnl ?? ((r.pnl || 0) + (r.fee || 0))) || 0;
    const dir = r.side === 'SHORT' ? -1 : 1;
    const exitPrice = Number(r.exitPrice ?? r.closePrice ?? (qty ? entryPrice + dir * gross / qty : entryPrice)) || entryPrice;
    out.push({
      id: 'A' + String(r.id ?? (r.symbol + '-' + exitTime)),
      account: (r.isTraining || r.training) ? 'training' : 'main',
      symbol: String(r.symbol).toUpperCase(), side: r.side === 'SHORT' ? 'SHORT' : 'LONG',
      entryTime, exitTime, entryPrice, exitPrice, qty,
      leverage: r.leverage ?? null, notional: Math.abs(Number(r.notional) || entryPrice * qty) || 0,
      fee: Math.abs(Number(r.fee) || 0), pnl: round2(Number(r.pnl ?? (gross - (r.fee || 0))) || 0),
      plannedRisk: null, stopRespected: null,
      tags: Array.isArray(r.tags) ? r.tags.slice() : [], emotion: r.emotion || '', note: r.note || r.reviewNote || '',
      isTraining: !!(r.isTraining || r.training), imported: true, agent: true,
    });
  }
  out.sort((a, b) => a.exitTime - b.exitTime);
  return out;
}

// —— CSV 导入(Binance 导出别名映射,聚合成交为闭环) ——
const ALIASES = {
  tradeId: ['tradeid', 'trade id', 'trade_id', '成交编号', '成交id', '交易id'],
  orderId: ['orderid', 'order id', 'order_id', '订单编号', '订单id'],
  time: ['time', 'date', 'dateutc', 'createdtime', 'transactiontime', 'ordertime', '成交时间', '订单时间', '时间', '日期'],
  symbol: ['symbol', 'market', 'pair', 'contract', '交易对', '合约', '币种', '标的'],
  side: ['side', 'direction', 'positionside', 'type', '买卖', '方向', '多空', '类型'],
  price: ['price', 'avgprice', 'averageprice', 'filledprice', '成交价', '平均成交价', '成交均价', '价格'],
  qty: ['quantity', 'qty', 'amount', 'executed', 'filledamount', 'filled', '成交量', '数量', '币数'],
  fee: ['fee', 'commission', 'commissionfee', '手续费'],
  feeAsset: ['feecoin', 'feeasset', 'commissionasset', '手续费币种'],
  pnl: ['realizedprofit', 'realizedpnl', 'realizedpl', 'pnl', 'profit', 'closingpnl', '盈亏', '已实现盈亏', '实现盈亏', '收益'],
  positionSide: ['positionside', 'positiondirection', '持仓方向', '仓位方向'],
};
function normKey(v) { return String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
// —— 通用成交单解析(2026-07-13 融合自 report/parse.js,单一实现):CSV 解析 + 表头嗅探(币安中/英)+
// 手动列映射 + fills→trades 配对(与云端 ingest EF fillsToTrades 同源,净持仓穿零,pnl=净额)。
// 消费方:①主工作台数据中心 CSV 导入(importCsvText 三级回退)②残酷报告页(build 内联 engine)③report/verify。
export function parseCsvText(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text || '');
  // 分隔符探测:首行引号外计数,取最高频(tab/分号/逗号),平手兜底逗号。
  // 分号是欧式与部分交易所导出的标配——只认逗号会把整行吞成一个单元格(2.0 陌生CSV烟测抓到的真缺口)。
  const _first = s.split('\n')[0] || '';
  const _cnt = (ch) => { let n = 0, q = false; for (const c of _first) { if (c === '"') q = !q; else if (!q && c === ch) n++; } return n; };
  const delim = ['\t', ';'].reduce((a, b) => (_cnt(b) > _cnt(a) ? b : a), ',');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0].trim() !== '') rows.push(row); }
  return rows;
}
export function sniffHeader(header) {
  const h = header.map((x) => String(x || '').replace(/^\uFEFF/, '').trim().toLowerCase());
  const find = (...cands) => {
    // Exact matches must win globally before substring fallbacks. Otherwise a
    // leading "Position Side" column steals the later exact "Side" column.
    for (const c of cands) { const i = h.findIndex((x) => x === c); if (i >= 0) return i; }
    for (const c of cands) { const i = h.findIndex((x) => x.includes(c)); if (i >= 0) return i; }
    return -1;
  };
  const map = {
    tradeId: find('trade id', 'trade_id', 'tradeid', '成交编号', '成交id', '交易id'),
    orderId: find('order id', 'order_id', 'orderid', '订单编号', '订单id'),
    time: find('date(utc)', 'time(utc)', '时间', 'date', 'time'),
    symbol: find('symbol', '交易对', '合约', 'market'),
    side: find('side', '方向', 'direction'),
    price: find('price', '价格', '成交价'),
    qty: find('quantity', '数量', 'qty', 'amount(qty)', 'size', '成交量'),
    fee: find('fee', '手续费'),
    feeAsset: find('fee coin', 'fee asset', 'commission asset', '手续费币种'),
    pnl: find('realized profit', 'realized pnl', '已实现盈亏', 'realized_profit', 'pnl'),
    positionSide: find('position side', 'position_side', '持仓方向', '仓位方向'),
  };
  const core = ['time', 'symbol', 'side', 'price', 'qty'];
  if (core.every((k) => map[k] >= 0)) {
    // Do not promote a generic CSV merely because it has Fee and PnL.  The
    // recognized contract is deliberately exact, including Date(UTC) and
    // Realized Profit. Trade Id is additionally mandatory for execution-order
    // authority; without it the file can still be imported as a Binance-shaped
    // report, but never orders rows across batches by a guessed ID.
    const binanceHeaderColumns = new Set([
      'date(utc)', 'symbol', 'position side', 'side', 'price', 'quantity',
      'amount', 'total', 'fee', 'fee coin', 'realized profit', 'trade id', 'order id',
    ]);
    const binanceBaseRequired = ['date(utc)', 'symbol', 'side', 'price', 'quantity', 'fee', 'realized profit'];
    const exactBinanceHeader = h.length === new Set(h).size
      && h.every((column) => binanceHeaderColumns.has(column))
      && binanceBaseRequired.every((column) => h.includes(column));
    const trustedExecutionOrder = exactBinanceHeader && h.includes('trade id');
    const executionOrderEvidence = trustedExecutionOrder
      ? BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE
      : null;
    return {
      source: exactBinanceHeader ? 'binance-export' : 'generic-sniffed',
      map,
      note: map.pnl < 0 ? '无已实现盈亏列:将用价差自算(近似,不含资金费)' : '',
      executionOrderEvidence,
    };
  }
  return null;
}
const _stNum = (v) => { const m = String(v ?? '').replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?([eE]-?\d+)?/); return m ? +m[0] : NaN; };
const _ST_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function _stMoney(v) {
  const text = String(v ?? '').trim();
  const match = text.match(/^([+-]?(?:[\d,]+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z][A-Za-z0-9]*)?$/);
  if (!match) return null;
  const numeric = match[1].replace(/,/g, '');
  if (!_ST_DECIMAL.test(numeric)) return null;
  const value = Number(numeric);
  return Number.isFinite(value) ? { value, asset: match[2] ? match[2].toUpperCase() : null } : null;
}
const _stSide = (v) => {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'BUY' || s === '买入' || s === '买' || s.startsWith('开多') || s.startsWith('平空')) return 'BUY';
  if (s === 'SELL' || s === '卖出' || s === '卖' || s.startsWith('开空') || s.startsWith('平多')) return 'SELL';
  return null;
};
const _stTime = (v) => {
  const s = String(v || '').trim();
  if (/^\d{13}$/.test(s)) return +s;
  if (/^\d{10}$/.test(s)) return +s * 1000;
  const iso = s.replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');   // 无时区标注按 UTC(币安导出即 UTC)
  return Number.isFinite(t) ? t : NaN;
};
export function rowsToFills(rows, map, opts) {
  const hasHeader = !opts || opts.hasHeader !== false;
  const out = [], bad = [];
  const body = hasHeader ? rows.slice(1) : rows;
  let autoId = 1;
  for (let index = 0; index < body.length; index++) {
    const r = body[index];
    const side = _stSide(r[map.side]);
    const symbol = String(r[map.symbol] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const time = _stTime(r[map.time]);
    const priceCell = _stMoney(r[map.price]);
    const qtyCell = _stMoney(r[map.qty]);
    const price = priceCell ? priceCell.value : NaN;
    const qty = qtyCell ? qtyCell.value : NaN;
    const positionSide = map.positionSide >= 0 ? String(r[map.positionSide] || '').trim().toUpperCase() : '';
    const reject = (code, field) => bad.push({ index, code, field, severity: 'error' });
    if (!side || !symbol || !Number.isFinite(time) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) {
      reject(DIAGNOSTIC_CODES.invalid_fill, 'row');
      continue;
    }
    if (opts && opts.enforceUsdt === true && !symbol.endsWith('USDT')) {
      reject(DIAGNOSTIC_CODES.unsupported_settlement_currency, 'symbol');
      continue;
    }
    if (positionSide && !['BOTH', 'LONG', 'SHORT'].includes(positionSide)) {
      reject(DIAGNOSTIC_CODES.unsupported_position_mode, 'positionSide');
      continue;
    }
    const feeMoney = map.fee >= 0 ? _stMoney(r[map.fee]) : { value: 0, asset: null };
    if (!feeMoney || feeMoney.value < 0) {
      reject(DIAGNOSTIC_CODES.invalid_fee, 'fee');
      continue;
    }
    const feeAsset = map.feeAsset >= 0
      ? String(r[map.feeAsset] || '').trim().toUpperCase()
      : feeMoney.asset;
    if (feeAsset && feeAsset !== 'USDT') {
      reject(DIAGNOSTIC_CODES.unsupported_fee_asset, 'feeAsset');
      continue;
    }
    const pnlMoney = map.pnl >= 0 ? _stMoney(r[map.pnl]) : null;
    if (map.pnl >= 0 && !pnlMoney) {
      reject(DIAGNOSTIC_CODES.invalid_pnl, 'pnl');
      continue;
    }
    if (pnlMoney && pnlMoney.asset && pnlMoney.asset !== 'USDT') {
      reject(DIAGNOSTIC_CODES.unsupported_pnl_asset, 'pnlAsset');
      continue;
    }
    // Exchange identifiers are opaque decimal strings. Never coerce them through Number:
    // Binance IDs can exceed IEEE-754's safe integer range, and one order may own many fills.
    const tradeId = map.tradeId >= 0 ? String(r[map.tradeId] ?? '').trim() : '';
    const orderId = map.orderId >= 0 ? String(r[map.orderId] ?? '').trim() : '';
    const legacyId = autoId++;
    const sourceRef = tradeId
      ? `binance-trade:${symbol}:${tradeId}`
      // Keep the frozen parseStatement trade IDs for files that predate an
      // exchange Trade ID column. The ledger does not trust this local value
      // for cross-batch dedupe; it assigns its own batch-scoped lineage.
      : String(legacyId);
    const f = {
      id: legacyId,
      sourceRef,
      ...(tradeId ? { tradeId } : {}),
      ...(orderId ? { orderId } : {}),
      time,
      symbol,
      side,
      positionSide: positionSide || 'BOTH',
      price,
      qty,
      fee: feeMoney.value,
      feeAsset,
      pnl: pnlMoney ? pnlMoney.value : null,
    };
    out.push(f);
  }
  return { fills: out, bad };
}
export function reduceNetPositions(fills) {
  return reduceNetPositionsCore(fills);
}

function _fillBatchError(code) {
  const error = new Error(`INVALID_FILL_BATCH:${code}`);
  error.code = code;
  return error;
}

function _assertCanonicalFills(fills) {
  for (const fill of fills || []) {
    const time = _archiveFiniteNumber(fill && fill.time);
    const price = _archiveFiniteNumber(fill && fill.price);
    const qty = _archiveFiniteNumber(fill && fill.qty);
    if (!fill || typeof fill !== 'object' || !String(fill.symbol || '').trim()
      || (fill.side !== 'BUY' && fill.side !== 'SELL')
      || !Number.isSafeInteger(time) || time < 0
      || !Number.isFinite(new Date(time).getTime())
      || price == null || price <= 0
      || qty == null || qty <= 0) {
      throw _fillBatchError(DIAGNOSTIC_CODES.invalid_fill);
    }
    if (fill.positionSide != null
      && !['BOTH', 'LONG', 'SHORT'].includes(String(fill.positionSide).trim().toUpperCase())) {
      throw _fillBatchError(DIAGNOSTIC_CODES.unsupported_position_mode);
    }
    const fee = fill.fee == null ? null : _archiveFiniteNumber(fill.fee);
    if (fill.fee != null && (fee == null || fee < 0)) {
      throw _fillBatchError(DIAGNOSTIC_CODES.invalid_fee);
    }
    if (fill.pnl != null && _archiveFiniteNumber(fill.pnl) == null) {
      throw _fillBatchError(DIAGNOSTIC_CODES.invalid_pnl);
    }
    if (fill.feeAsset != null && String(fill.feeAsset).trim()
      && String(fill.feeAsset).trim().toUpperCase() !== 'USDT') {
      throw _fillBatchError(DIAGNOSTIC_CODES.unsupported_fee_asset);
    }
  }
}

export function pairFills(fills) {
  _assertCanonicalFills(fills);
  const result = reduceNetPositions(fills);
  const trades = result.closedTrades.map((cycle) => ({
    id: stableCycleId(cycle, { prefix: 't' }),
    symbol: cycle.symbol, side: cycle.side, entryTime: cycle.entryTime, exitTime: cycle.exitTime,
    entryPrice: cycle.entryPrice, exitPrice: cycle.exitPrice, qty: cycle.qty,
    notional: cycle.entryPrice * cycle.qty, fee: cycle.fee, pnl: cycle.grossPnl - cycle.fee,
    pnlSelfCalc: cycle.pnlSelfCalc, plannedRisk: null, tags: [], emotion: '', note: '', setup: '', plan: {},
    market: 'crypto_perp', currency: 'USDT', source: 'csv-report',
  }));
  return { trades, openPositions: result.openPositions.length };
}
export function parseStatementBatch(text, manualMap = null) {
  const rows = parseCsvText(text);
  if (rows.length < 2) return { error: 'CSV 行数不足(需要表头+至少一行成交)' };
  const sniff = manualMap ? { source: 'manual-map', map: manualMap, note: '' } : sniffHeader(rows[0]);
  if (!sniff) return { error: 'unrecognized', header: rows[0], rowCount: rows.length - 1 };
  const trustedExecutionOrder = sniff.executionOrderEvidence === BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE;
  const adapterId = trustedExecutionOrder
    ? BINANCE_USDM_CSV_EXECUTION_ORDER_EVIDENCE.adapterId
    : `builtin/${manualMap ? 'csv-manual-map' : 'csv-sniffer'}`;
  const { fills, bad } = rowsToFills(rows, sniff.map, { enforceUsdt: sniff.source === 'binance-export' });
  const recordSource = sniff.source || 'unknown';
  const diagnostics = bad.map((item, index) => ({
    index: Number.isInteger(item && item.index) ? item.index : index,
    code: (item && item.code) || DIAGNOSTIC_CODES.invalid_fill,
    field: (item && item.field) || 'row',
    severity: 'error',
  }));
  if (!fills.length) {
    return withResultContract({
      error: '没有一行能解析成有效成交(检查列映射/格式)',
      header: rows[0],
      trades: [],
      diagnostics,
    }, [], {
      source: recordSource,
      adapterId,
      diagnostics,
      accepted: 0,
      dropped: bad.length,
      capabilityOverrides: {
        fills: false, fees: false, pnlReported: false, orders: false, income: false, ledger: false, klines: false,
      },
    });
  }
  const paired = pairFills(fills);
  const trades = paired.trades.map(trade => ({ ...trade, source: recordSource }));
  const result = {
    fills,
    trades,
    meta: { source: recordSource, note: sniff.note, fills: fills.length, badRows: bad.length, openPositions: paired.openPositions },
    diagnostics,
  };
  return withResultContract(result, trades, {
    source: recordSource,
    adapterId,
    executionOrderEvidence: sniff.executionOrderEvidence,
    fieldOrigins: {
      id: 'derived', symbol: 'observed', side: 'derived', entryTime: 'derived', exitTime: 'derived',
      entryPrice: 'derived', exitPrice: 'derived', qty: 'derived', notional: 'derived',
      fee: sniff.map.fee >= 0 ? 'derived' : 'defaulted',
      pnl: sniff.map.pnl >= 0 ? 'derived' : 'approximated',
      currency: 'defaulted',
    },
    diagnostics,
    accepted: trades.length,
    dropped: bad.length,
    capabilityOverrides: {
      fills: bad.length === 0,
      fees: bad.length === 0 && sniff.map.fee >= 0 && fills.every(fill => fill.feeAsset === 'USDT'),
      pnlReported: bad.length === 0 && sniff.map.pnl >= 0,
      ledger: false,
    },
  });
}

// Backward-compatible entry point. Batch consumers additionally receive canonical raw fills.
export function parseStatement(text, manualMap = null) {
  return parseStatementBatch(text, manualMap);
}

// —— .fupan 存档格式(v1):无账户的「文件即账户」——报告页导出、工作台导入,同一份实现(宪法⑥ additive)。
// 动机:localStorage 清缓存即丢 + 免注册无留存,两个死结用「导出到你自己硬盘的一个文件」一并解开。
// 只存原始 slim 字段(与 store.tsx / pairFills 白名单一致);富化字段(rMultiple/session/mfeR…)不进文件,
// 导入时重跑 enrichTrades——engine 是唯一真相,防旧富化结果与新引擎版本打架。
export const FUPAN_FORMAT = 'fupan/1';
export const MAX_ARCHIVE_JSON_CHARS = 32 * 1024 * 1024;
export const MAX_ARCHIVE_TRADES = 200_000;
const MAX_ARCHIVE_TEXT_CHARS = 200_000;
const MAX_ARCHIVE_ARRAY_ITEMS = 1_000;
const MAX_ARCHIVE_OBJECT_KEYS = 256;
const MAX_ARCHIVE_NESTING = 8;
// 白名单判据:存一切「原始观测」,不存任何「富化派生」。
//   原始 = 数据源直接给的事实(成交/证据/用户手写),换引擎版本也不会变;
//   富化 = enrichTrades/computeAll 从原始算出来的(oneR/rMultiple/session/mfeR/leftOnTable…),导入后必须重算,
//          否则旧富化结果会与新引擎打架(宪法⑥的延伸)。
// 关键:hadSL/stopRespected/evidence 是订单流证据(进 computeAll 的 stopEvidenceN/stopBreaks 与复盘卡),
//       漏存会让往返后这些指标漂移——CSV 用户它们本就是 null(无损),L3 用户有值(必须保真)。
const ARCHIVE_KEYS = [
  // 成交事实
  'id', 'account', 'symbol', 'side', 'entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'qty',
  'leverage', 'notional', 'multiplier', 'fee', 'pnl', 'pnlSelfCalc',
  // 风险与证据(原始观测)
  'plannedRisk', 'hadSL', 'stopRespected', 'ordersCoverage', 'mfe', 'mae', 'mfePrice', 'maePrice', 'evidence',
  // 用户手写内容(最珍贵,绝不能丢)
  'tags', 'emotion', 'note', 'setup', 'plan', 'review',
  // 分类
  'market', 'currency', 'source', 'declaredSource',
];
const ARCHIVE_REQUIRED_NUMBERS = ['entryTime', 'exitTime', 'entryPrice', 'exitPrice', 'qty', 'pnl'];
const ARCHIVE_OPTIONAL_NUMBERS = [
  'leverage', 'notional', 'multiplier', 'fee', 'plannedRisk',
  'mfe', 'mae', 'mfePrice', 'maePrice',
];
const ARCHIVE_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ARCHIVE_ORDERS_COVERAGE = new Set(['unknown', 'partial', 'complete']);
function _archiveWithinBudget(value, depth = 0, seen = new Set()) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_ARCHIVE_TEXT_CHARS;
  if (typeof value !== 'object' || depth >= MAX_ARCHIVE_NESTING || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARCHIVE_ARRAY_ITEMS) return false;
    return value.every(item => _archiveWithinBudget(item, depth + 1, seen));
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ARCHIVE_OBJECT_KEYS) return false;
  return keys.every(key => key.length <= 128 && _archiveWithinBudget(value[key], depth + 1, seen));
}
function _archiveEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const finite = value => value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const boolean = value => typeof value === 'boolean' ? value : null;
  const coverage = ARCHIVE_ORDERS_COVERAGE.has(input.ordersCoverage) ? input.ordersCoverage : 'unknown';
  const entryType = ['MARKET', 'LIMIT', 'MIXED'].includes(input.entryType) ? input.entryType : null;
  const stopCancels = finite(input.stopCancels);
  const fundingN = finite(input.fundingN);
  return {
    trust: 'self-declared',
    ordersCoverage: coverage,
    stopUnknown: boolean(input.stopUnknown),
    stopPlaced: boolean(input.stopPlaced),
    stopHeld: boolean(input.stopHeld),
    continuousCoverage: boolean(input.continuousCoverage),
    stopCancels: stopCancels != null && stopCancels >= 0 ? stopCancels : null,
    stopPrice: finite(input.stopPrice),
    entryType,
    funding: finite(input.funding),
    fundingN: fundingN != null && fundingN >= 0 ? fundingN : null,
  };
}
function _archiveFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !ARCHIVE_DECIMAL.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
function _archiveCanonicalId(value, record) {
  if (value != null) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    const explicit = String(value).trim();
    if (explicit) return explicit.length <= 512 ? explicit : null;
  }
  const fingerprint = [
    'fupan-record/1',
    record.entryPrice,
    record.exitPrice,
    record.qty,
    record.fee,
    record.pnl,
    record.currency,
  ].map(part => part == null ? '' : String(part)).join('|');
  return stableCycleId({
    symbol: record.symbol,
    side: record.side,
    entryTime: record.entryTime,
    exitTime: record.exitTime,
    lineageRefs: [fingerprint],
  }, {
    prefix: 'archive',
    account: typeof record.account === 'string' || typeof record.account === 'number'
      ? String(record.account)
      : '',
    market: typeof record.market === 'string' && record.market.trim()
      ? record.market.trim()
      : 'crypto_perp',
  });
}
function _archiveDiagnostic(index, code, field) {
  return { index, code, field, severity: 'error' };
}
function _normalizeArchiveTrade(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { diagnostic: _archiveDiagnostic(index, 'invalid_record', 'trade') };
  }
  if (!_archiveWithinBudget(input)) {
    return { diagnostic: _archiveDiagnostic(index, 'resource_limit', 'trade') };
  }
  const normalized = {};
  for (const k of ARCHIVE_KEYS) if (input[k] !== undefined) normalized[k] = input[k];
  for (const field of ['tags', 'plan', 'review', 'evidence', 'note', 'emotion', 'setup']) {
    if (input[field] !== undefined && !_archiveWithinBudget(input[field])) {
      return { diagnostic: _archiveDiagnostic(index, 'resource_limit', field) };
    }
  }

  for (const field of ['entryTime', 'exitTime']) {
    const value = _archiveFiniteNumber(input[field]);
    if (value == null || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
      return { diagnostic: _archiveDiagnostic(index, 'invalid_time', field) };
    }
    normalized[field] = value;
  }
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  if (!symbol) return { diagnostic: _archiveDiagnostic(index, 'empty_symbol', 'symbol') };
  normalized.symbol = symbol;
  const side = String(input.side ?? '').trim().toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return { diagnostic: _archiveDiagnostic(index, 'invalid_side', 'side') };
  normalized.side = side;
  if (input.ordersCoverage != null) {
    const coverage = String(input.ordersCoverage).trim().toLowerCase();
    if (!ARCHIVE_ORDERS_COVERAGE.has(coverage)) {
      return { diagnostic: _archiveDiagnostic(index, 'invalid_enum', 'ordersCoverage') };
    }
    normalized.ordersCoverage = coverage;
  }
  for (const field of ['hadSL', 'stopRespected']) {
    if (input[field] != null && typeof input[field] !== 'boolean') {
      return { diagnostic: _archiveDiagnostic(index, 'invalid_boolean', field) };
    }
  }

  for (const field of ARCHIVE_REQUIRED_NUMBERS.slice(2)) {
    const value = _archiveFiniteNumber(input[field]);
    if (value == null) return { diagnostic: _archiveDiagnostic(index, 'invalid_number', field) };
    normalized[field] = value;
  }
  for (const field of ARCHIVE_OPTIONAL_NUMBERS) {
    if (input[field] == null) continue;
    const value = _archiveFiniteNumber(input[field]);
    if (value == null) return { diagnostic: _archiveDiagnostic(index, 'invalid_number', field) };
    normalized[field] = value;
  }
  if (normalized.qty <= 0) return { diagnostic: _archiveDiagnostic(index, 'non_positive_qty', 'qty') };
  if (normalized.entryPrice <= 0) return { diagnostic: _archiveDiagnostic(index, 'non_positive_price', 'entryPrice') };
  if (normalized.exitPrice <= 0) return { diagnostic: _archiveDiagnostic(index, 'non_positive_price', 'exitPrice') };
  if (normalized.exitTime < normalized.entryTime) return { diagnostic: _archiveDiagnostic(index, 'invalid_time_range', 'exitTime') };

  normalized.fee = normalized.fee == null ? 0 : normalized.fee;
  normalized.tags = Array.isArray(normalized.tags) ? normalized.tags : [];
  normalized.plan = normalized.plan && typeof normalized.plan === 'object' && !Array.isArray(normalized.plan) ? normalized.plan : {};
  normalized.evidence = _archiveEvidence(normalized.evidence);
  normalized.market = normalized.market || 'crypto_perp';
  normalized.currency = String(normalized.currency || 'USDT').trim().toUpperCase();
  normalized.source = contractSource(normalized.source);
  normalized.declaredSource = contractSource(normalized.declaredSource);
  normalized.id = _archiveCanonicalId(input.id, normalized);
  if (!normalized.id) return { diagnostic: _archiveDiagnostic(index, 'invalid_id', 'id') };
  return { trade: normalized };
}
export function normalizeCanonicalTrade(input, index = 0) {
  const result = _normalizeArchiveTrade(input, index);
  return result.trade ? { record: result.trade } : { diagnostic: result.diagnostic };
}
export function exportArchive(trades, meta) {
  const slim = (trades || []).map((t) => {
    const o = {};
    for (const k of ARCHIVE_KEYS) if (t[k] !== undefined) o[k] = t[k];
    return o;
  });
  return { format: FUPAN_FORMAT, exportedAt: (meta && meta.exportedAt) || null, meta: meta || null, trades: slim };
}
// 反向:接受 exportArchive 的产物(或裸 trades 数组的宽容回退),返回 {trades, meta, error}。不在此处 enrich——
// 调用方拿到 trades 后自己 enrichTrades(与 parseStatement 一致的契约:解析层不富化)。
export function importArchive(json) {
  let data = json;
  if (typeof json === 'string') {
    if (json.length > MAX_ARCHIVE_JSON_CHARS) return { error: '存档文件过大,超过 32 MB 上限' };
    try { data = JSON.parse(json); } catch (e) { return { error: '不是有效的存档文件(JSON 解析失败)' }; }
  }
  if (Array.isArray(data)) data = { format: FUPAN_FORMAT, trades: data, meta: null };   // 宽容:裸数组也认
  if (!data || typeof data !== 'object') return { error: '存档文件为空或格式错误' };
  if (data.meta != null && !_archiveWithinBudget(data.meta)) return { error: '存档元数据超过安全解析上限' };
  const fmt = String(data.format || '');
  if (fmt && fmt.split('/')[0] !== 'fupan') return { error: '这不是复盘工作台的存档文件(format=' + fmt + ')' };
  const ver = +(fmt.split('/')[1] || 1);
  if (ver > 1) return { error: '存档版本(v' + ver + ')比当前工作台新,请升级后再导入' };   // 向前兼容护栏
  if (!Array.isArray(data.trades) || !data.trades.length) return { error: '存档里没有任何交易' };
  if (data.trades.length > MAX_ARCHIVE_TRADES) return { error: `存档交易过多,超过 ${MAX_ARCHIVE_TRADES} 笔上限` };
  // 逐笔规范化 + 只取白名单字段。坏记录只返回稳定位置/原因码，不回显原始值。
  const trades = [], diagnostics = [], seenIds = new Set();
  for (let index = 0; index < data.trades.length; index++) {
    const result = normalizeCanonicalTrade(data.trades[index], index);
    if (result.record) {
      if (seenIds.has(result.record.id)) {
        diagnostics.push(_archiveDiagnostic(index, 'duplicate_id', 'id'));
        continue;
      }
      seenIds.add(result.record.id);
      const declaredSource = result.record.declaredSource !== 'unknown'
        ? result.record.declaredSource
        : contractSource(result.record.source);
      trades.push({
        ...result.record,
        source: 'fupan-archive',
        declaredSource,
        ordersCoverage: 'unknown',
        evidence: result.record.evidence ? {
          ...result.record.evidence,
          trust: 'self-declared',
          ordersCoverage: 'unknown',
        } : null,
      });
    }
    else diagnostics.push(result.diagnostic);
  }
  const droppedByCode = {};
  for (const diagnostic of diagnostics) droppedByCode[diagnostic.code] = (droppedByCode[diagnostic.code] || 0) + 1;
  const importMeta = {
    ...(data.meta || {}),
    source: 'fupan-archive',
    declaredSource: contractSource(data.meta && data.meta.source),
    imported: trades.length,
    dropped: diagnostics.length,
    droppedByCode: Object.fromEntries(Object.entries(droppedByCode).sort(([a], [b]) => a.localeCompare(b))),
  };
  if (!trades.length) {
    return withResultContract(
      { error: '存档里的交易都缺少必要字段或不是有效交易', trades: [], meta: importMeta, diagnostics },
      [],
      {
        source: importMeta.source,
        adapterId: 'builtin/fupan-archive',
        diagnostics,
        accepted: 0,
        dropped: diagnostics.length,
      },
    );
  }
  // 透传原始 meta(importedAt/exportedAt/来源都保留)再叠加本次导入统计——否则 localStorage 往返会丢 importedAt,
  // 刷新后「导入于」变 Invalid Date(本地实跑抓到的回归)。
  return withResultContract({ trades, meta: importMeta, diagnostics }, trades, {
    source: importMeta.source,
    adapterId: 'builtin/fupan-archive',
    fieldOrigins: Object.fromEntries(CANONICAL_TRADE_FIELDS.map(field => [field, 'self-declared'])),
    diagnostics,
    accepted: trades.length,
    dropped: diagnostics.length,
  });
}

// 本机引擎 bundle → trades(残酷报告页「API 选项」正解):引擎 /local/bundle 返回缓存的原始 {fills,orders,income},
// 同源 session+CSRF 客户端取真实成交；交易所凭据由 runtime 的 DPAPI store 管理且不会随 bundle 返回。
function _normalizeBinanceFill(fill, index) {
  const diagnostic = (code, field) => ({ index, code, field, severity: 'error' });
  if (!fill || typeof fill !== 'object') return { diagnostic: diagnostic(DIAGNOSTIC_CODES.invalid_fill, 'fill') };
  const symbol = String(fill.symbol || '').trim().toUpperCase();
  const side = String(fill.side || '').trim().toUpperCase();
  const positionSide = fill.positionSide == null ? '' : String(fill.positionSide).trim().toUpperCase();
  const time = _archiveFiniteNumber(fill.time);
  const price = _archiveFiniteNumber(fill.price);
  const qty = _archiveFiniteNumber(fill.qty);
  if (!symbol || (side !== 'BUY' && side !== 'SELL') || !Number.isSafeInteger(time) || time < 0
    || !Number.isFinite(new Date(time).getTime()) || !Number.isFinite(price) || price <= 0
    || !Number.isFinite(qty) || qty <= 0) {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.invalid_fill, 'fill') };
  }
  if (!symbol.endsWith('USDT')) {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.unsupported_settlement_currency, 'symbol') };
  }
  if (positionSide && !['BOTH', 'LONG', 'SHORT'].includes(positionSide)) {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.unsupported_position_mode, 'positionSide') };
  }
  const rawFee = fill.commission ?? fill.fee;
  const feeDeclared = rawFee != null;
  const fee = feeDeclared ? _archiveFiniteNumber(rawFee) : 0;
  if (fee == null || fee < 0) {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.invalid_fee, 'fee') };
  }
  const feeAsset = String(fill.commissionAsset ?? fill.feeAsset ?? '').trim().toUpperCase();
  if (feeAsset && feeAsset !== 'USDT') {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.unsupported_fee_asset, 'feeAsset') };
  }
  const rawPnl = fill.realizedPnl ?? fill.pnl;
  const pnlDeclared = rawPnl != null;
  const pnl = pnlDeclared ? _archiveFiniteNumber(rawPnl) : null;
  if (pnlDeclared && pnl == null) {
    return { diagnostic: diagnostic(DIAGNOSTIC_CODES.invalid_pnl, 'pnl') };
  }
  return {
    fill: {
      id: fill.id,
      sourceRef: fill.sourceRef ?? fill.id,
      time,
      symbol,
      side,
      positionSide: positionSide || 'BOTH',
      price,
      qty,
      fee,
      feeAsset: feeAsset || null,
      pnl,
    },
    feeVerified: feeDeclared && feeAsset === 'USDT',
    pnlVerified: pnlDeclared,
  };
}

export function bundleToTrades(bundle) {
  const raw = (bundle && Array.isArray(bundle.fills)) ? bundle.fills : [];
  const fills = []; const diagnostics = []; let autoId = 1;
  let feesVerified = raw.length > 0;
  let pnlVerified = raw.length > 0;
  for (let index = 0; index < raw.length; index++) {
    const normalized = _normalizeBinanceFill(raw[index], index);
    if (normalized.diagnostic) {
      diagnostics.push(normalized.diagnostic);
      continue;
    }
    const fill = normalized.fill;
    fills.push({ ...fill, id: fill.id != null ? fill.id : autoId++ });
    feesVerified = feesVerified && normalized.feeVerified;
    pnlVerified = pnlVerified && normalized.pnlVerified;
  }
  if (diagnostics.length) {
    const result = {
      error: '本机成交包含无效或暂不支持的数据,已停止配对',
      trades: [],
      meta: { source: 'local-engine', fills: 0, badRows: diagnostics.length, openPositions: 0 },
      diagnostics,
    };
    return withResultContract(result, [], {
      source: 'local-engine',
      adapterId: 'builtin/binance-local',
      diagnostics,
      accepted: 0,
      dropped: diagnostics.length,
      capabilityOverrides: {
        fills: false, fees: false, pnlReported: false, orders: false, income: false, ledger: false,
      },
    });
  }
  const paired = pairFills(fills);
  const trades = paired.trades.map(trade => ({ ...trade, source: 'binance' }));
  const result = {
    trades,
    meta: { source: 'local-engine', note: '', fills: fills.length, badRows: raw.length - fills.length, openPositions: paired.openPositions },
    diagnostics,
  };
  return withResultContract(result, trades, {
    source: 'local-engine',
    adapterId: 'builtin/binance-local',
    fieldOrigins: {
      id: 'derived', symbol: 'observed', side: 'derived', entryTime: 'derived', exitTime: 'derived',
      entryPrice: 'derived', exitPrice: 'derived', qty: 'derived', notional: 'derived',
      fee: 'derived', pnl: 'derived', currency: 'declared',
    },
    diagnostics,
    accepted: trades.length,
    dropped: diagnostics.length,
    capabilityOverrides: {
      fills: true,
      fees: feesVerified,
      pnlReported: pnlVerified,
      orders: bundle?.coverage?.orders === 'complete',
      income: bundle?.coverage?.income === 'complete',
      ledger: feesVerified && pnlVerified && bundle?.coverage?.income === 'complete',
      klines: false,
    },
  });
}

export function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV 至少需要表头 + 1 行数据');
  const delim = [',', '\t', ';'].reduce((a, b) => lines[0].split(b).length > lines[0].split(a).length ? b : a);
  const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
  const headers = split(lines[0]).map(normKey);
  const col = {};
  for (const [field, names] of Object.entries(ALIASES)) col[field] = headers.findIndex(h => names.some(n => normKey(n) === h || h.includes(normKey(n))));
  if (col.time < 0 || col.symbol < 0 || col.price < 0) throw new Error('无法识别时间/交易对/价格列,请确认是 Binance 导出格式');
  const timeIsUtc = /utc|gmt/.test(headers[col.time] || '');
  const fills = [];
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]); if (c.length < 3) continue;
    const rawT = c[col.time];
    const time = /^\d{12,}$/.test(rawT) ? +rawT : Date.parse(rawT.replace(' ', 'T') + (rawT.includes('+') || rawT.includes('Z') ? '' : timeIsUtc ? 'Z' : '+08:00'));
    if (!Number.isFinite(time)) continue;
    const sideRaw = col.side >= 0 ? c[col.side] : '';
    const feeMoney = col.fee >= 0 ? _stMoney(c[col.fee]) : null;
    const pnlMoney = col.pnl >= 0 ? _stMoney(c[col.pnl]) : null;
    const symbol = c[col.symbol].toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tradeId = col.tradeId >= 0 ? String(c[col.tradeId] ?? '').trim() : '';
    const orderId = col.orderId >= 0 ? String(c[col.orderId] ?? '').trim() : '';
    fills.push({
      // parseCsv is a frozen legacy adapter. Preserve its content-derived
      // cycle IDs; the modern parseStatementBatch path owns fill lineage.
      ...(tradeId ? { tradeId } : {}),
      ...(orderId ? { orderId } : {}),
      time, symbol,
      side: _stSide(sideRaw),
      positionSide: col.positionSide >= 0 ? c[col.positionSide] : undefined,
      price: Number(c[col.price]), qty: col.qty >= 0 ? Number(c[col.qty]) : NaN,
      fee: feeMoney ? feeMoney.value : col.fee >= 0 ? c[col.fee] : undefined,
      feeAsset: col.feeAsset >= 0 ? c[col.feeAsset] : feeMoney && feeMoney.asset,
      pnl: pnlMoney ? pnlMoney.value : col.pnl >= 0 ? c[col.pnl] : undefined,
    });
  }
  return fillsToTrades(fills);
}
// 原始成交 → 闭环交易。正确处理【穿零翻仓】(多→空一笔打过头)与【部分平仓/分批建仓】:
// 一笔交易 = 带符号持仓从 0 离开到回到 0(翻仓在穿零处拆成两笔)。pnl 直接累计币安每笔 realizedPnl(f.pnl),
// 不自算价差(避开逐仓/多资产计价坑);qty=累计开仓量、entryPrice=开仓 VWAP。旧版曾在穿零翻仓时无法收口。
export function fillsToTrades(fills) {
  // 兼容原始 Binance userTrades(realizedPnl/commission)与归一化 fill(pnl/fee)两种字段名。
  // 任一坏行都会停止整批：静默丢行会改变持仓路径，比响亮失败更危险。
  const canonical = [];
  for (let index = 0; index < (fills || []).length; index++) {
    const normalized = _normalizeBinanceFill(fills[index], index);
    if (normalized.diagnostic) {
      const error = new Error(`INVALID_FILL_BATCH:${normalized.diagnostic.code}`);
      error.code = normalized.diagnostic.code;
      throw error;
    }
    canonical.push(normalized.fill);
  }
  const cycles = reduceNetPositions(canonical).closedTrades;
  const trades = cycles.map((cycle) => ({
    id: stableCycleId(cycle, { prefix: 'I', account: 'main' }), account: 'main',
    symbol: cycle.symbol, side: cycle.side, entryTime: cycle.entryTime, exitTime: cycle.exitTime,
    entryPrice: cycle.entryPrice, exitPrice: cycle.exitPrice, qty: cycle.qty,
    leverage: null, notional: cycle.entryPrice * cycle.qty, fee: cycle.fee,
    pnl: cycle.grossPnl - cycle.fee, plannedRisk: null, stopRespected: null,
    tags: [], emotion: '', note: '', isTraining: false, imported: true,
    market: 'crypto_perp', currency: 'USDT', source: 'binance',
  }));
  if (!trades.length) throw new Error('没有配对出闭环交易(仓位未回到 0)');
  return trades;
}

// —— K线:真实 Binance 公共行情 + 受保护本机 runtime 可选通道 ——
function klineContinuationActive(options = {}) {
  if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return false;
  if (options.signal?.aborted) return false;
  return true;
}
export async function fetchKlines(symbol, interval, endTime, limit = 200, proxy, ...runtimeArgs) {
  const runtimeRequest = runtimeArgs[0];
  const options = runtimeArgs[1] || {};
  const query = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${endTime ? '&endTime=' + endTime : ''}`;
  let raw;
  if (proxy && typeof runtimeRequest === 'function') {
    try { raw = await runtimeRequest(query); } catch (error) {
      if (!klineContinuationActive(options)) throw error;
      const res = await fetch(`https://fapi.binance.com${query}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('K线 HTTP ' + res.status);
      raw = await res.json();
    }
  } else {
    if (!klineContinuationActive(options)) throw new Error('K线请求已取消');
    const res = await fetch(`https://fapi.binance.com${query}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('K线 HTTP ' + res.status);
    raw = await res.json();
  }
  return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}
// 区间分页拉取(startTime→endTime 全覆盖;代理优先,失败回退直连)
export async function fetchKlinesRange(symbol, interval, startTime, endTime, proxy, ...runtimeArgs) {
  const runtimeRequest = runtimeArgs[0];
  const options = runtimeArgs[1] || {};
  const step = INTERVAL_MS[interval] || HOUR;
  const trySource = async (useRuntime) => {
    const out = []; let cur = startTime, guard = 0;
    while (cur < endTime && guard++ < 10) {
      if (!klineContinuationActive(options)) {
        if (out.length) return out;
        throw new Error('K线请求已取消');
      }
      const query = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${endTime}&limit=990`;
      let raw;
      if (useRuntime) {
        raw = await runtimeRequest(query);
      } else {
        const res = await fetch(`https://fapi.binance.com${query}`, { signal: AbortSignal.timeout(11000) });
        if (!res.ok) throw new Error('K线 HTTP ' + res.status);
        raw = await res.json();
      }
      if (!raw.length) break;
      for (const k of raw) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      if (!klineContinuationActive(options)) return out;
      cur = raw[raw.length - 1][0] + step;
      if (raw.length < 990) break;
    }
    if (!out.length) throw new Error('K线返回空');
    return out;
  };
  if (proxy && typeof runtimeRequest === 'function') {
    try { return await trySource(true); } catch (e) {
      if (!klineContinuationActive(options)) throw e;
    }
  }
  if (!klineContinuationActive(options)) throw new Error('K线请求已取消');
  return trySource(false);
}
export const INTERVAL_MS = { '5m': 300000, '15m': 900000, '1h': HOUR, '4h': 4 * HOUR, '8h': 8 * HOUR, '1d': DAY };
// 围绕一笔交易重建行情:路径强制穿过 entry/exit 价格点
export function synthKlines(trade, interval, count = 55) {
  const step = INTERVAL_MS[interval] || HOUR;
  const pre = Math.floor(count * 0.35);
  const start = trade.entryTime - pre * step;
  const total = Math.max(count, Math.ceil((trade.exitTime - start) / step) + Math.floor(count * 0.2));
  const anchors = [
    { i: 0, p: trade.entryPrice * (1 + (trade.side === 'LONG' ? -0.5 : 0.5) * 0.012) },
    { i: pre, p: trade.entryPrice },
    { i: Math.min(total - 8, Math.round((trade.exitTime - start) / step)), p: trade.exitPrice },
    { i: total - 1, p: trade.exitPrice * (1 + (trade.pnl >= 0 ? 0.3 : -0.2) * 0.008) },
  ];
  let seed = 7; for (const ch of trade.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const out = []; let prev = anchors[0].p;
  for (let i = 0; i < total; i++) {
    let a0 = anchors[0], a1 = anchors[anchors.length - 1];
    for (let j = 0; j < anchors.length - 1; j++) if (i >= anchors[j].i && i <= anchors[j + 1].i) { a0 = anchors[j]; a1 = anchors[j + 1]; break; }
    const f = a1.i === a0.i ? 0 : (i - a0.i) / (a1.i - a0.i);
    const base = a0.p + (a1.p - a0.p) * (f * f * (3 - 2 * f));
    const vol = base * 0.0035;
    const c = base + (rng() - 0.5) * vol * 1.6;
    const o = prev;
    const h = Math.max(o, c) + rng() * vol * 0.8;
    const l = Math.min(o, c) - rng() * vol * 0.8;
    out.push({ t: start + i * step, o: r4(o), h: r4(h), l: r4(l), c: r4(c), v: Math.round(200 + rng() * 900) });
    prev = c;
  }
  return out;
}

// —— Binance 私有数据只允许经受保护的同源 runtime 请求；浏览器不再持有或签名密钥。——
// 保留 N-1 的六参数位置契约；前两项旧密钥参数永远不读取，第七项才接受 runtime request。
export async function fetchMyTrades(_retiredKey, _retiredSecret, symbol, startTime, endTime, _retiredProxy, ...runtimeArgs) {
  const runtimeRequest = runtimeArgs[0];
  if (typeof runtimeRequest !== 'function') throw new Error('本机 runtime 不可用');
  const rows = await runtimeRequest(`/fapi/v1/userTrades?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`);
  return rows.map(r => ({ time: r.time, symbol: r.symbol, side: r.side, price: +r.price, qty: +r.qty, fee: +r.commission, pnl: +r.realizedPnl }));
}

// 经本地代理用收益流水发现近段时间交易过的合约品种(无需逐个猜 symbol)
// 同样保留 N-1 的 (proxy, startTime, endTime) 位置；第四项才接受 runtime request。
export async function fetchIncomeSymbols(_retiredProxy, startTime, endTime, ...runtimeArgs) {
  const runtimeRequest = runtimeArgs[0];
  if (typeof runtimeRequest !== 'function') throw new Error('本机 runtime 不可用');
  const rows = await runtimeRequest(`/fapi/v1/income?incomeType=REALIZED_PNL&startTime=${startTime}&endTime=${endTime}&limit=1000`);
  return [...new Set(rows.map(r => r.symbol).filter(Boolean))];
}

// —— 纪律账单:遵守纪律 vs 破坏纪律(错误标签 / 止损失守) ——
export function disciplineSplit(trades) {
  const agg = arr => {
    const n = arr.length, net = round2(sum(arr.map(t => t.pnl)));
    const wins = arr.filter(t => t.pnl > 0).length;
    const totalR = round2(sum(arr.map(t => t.rMultiple || 0)));
    return { n, net, wins, winRate: n ? wins / n : 0, expectancy: n ? round2(net / n) : 0, expectancyR: n ? round2(totalR / n) : 0 };
  };
  const groups = { clean: [], dirty: [], unknown: [] };
  for (const t of trades) {
    const hasNegativeTag = Boolean(t.tags && t.tags.length);
    const stopStatus = stopDisciplineStatus(t);
    if (hasNegativeTag || stopStatus === 'fail') groups.dirty.push(t);
    else if (stopStatus === 'pass') groups.clean.push(t);
    else groups.unknown.push(t);
  }
  const clean = agg(groups.clean);
  const dirty = agg(groups.dirty);
  const unknown = agg(groups.unknown);
  const wouldBe = round2(dirty.n * clean.expectancy);      // 破纪律那些笔若按守纪律期望执行应得
  const cost = round2(wouldBe - dirty.net);                // 正数 = 破坏纪律让你损失的金额
  const covered = clean.n + dirty.n;
  return { clean, dirty, unknown, wouldBe, cost, covered, coverage: trades.length ? covered / trades.length : 0 };
}

// —— 逐月成长聚合(每笔期望R + 纪律分 + 利润因子)——
export function growthByMonth(trades, startEquity = 12000) {
  const byMo = new Map();
  for (const t of trades) { const b = bj(t.exitTime); const k = `${b.y}-${String(b.mo).padStart(2, '0')}`; if (!byMo.has(k)) byMo.set(k, []); byMo.get(k).push(t); }
  return [...byMo.keys()].sort().map(k => {
    const arr = byMo.get(k), st = computeAll(arr, startEquity), sc = reviewScore(st);
    return { key: k, label: `${+k.split('-')[1]}月`, n: st.n, net: st.net, expR: st.expectancyR, pf: st.pf === Infinity ? null : round2(st.pf), disc: sc.score == null ? 0 : sc.score, winRate: st.winRate };
  });
}

// —— 深度洞察:时段热力 / 持仓时长 / 系统健康 ——
// 热力图:weekday × 时段(TradFi 化,纽约交易所时区)。4 桶:亚洲夜(18-04 ET)/欧洲·盘前(04-9:30)/美国盘(9:30-16)/美盘后(16-18)
export function heatmapCells(trades) {
  const sess = hm => (hm >= 1080 || hm < 240) ? 0 : hm < 570 ? 1 : hm < 960 ? 2 : 3;
  const grid = new Map();
  for (const t of trades) { const { dow: edow, hm } = etParts(t.entryTime); const dow = (edow + 6) % 7; const s = sess(hm); const k = dow + '-' + s; const g = grid.get(k) || { dow, s, net: 0, count: 0, wins: 0 }; g.net = round2(g.net + t.pnl); g.count++; if (t.pnl > 0) g.wins++; grid.set(k, g); }
  return [...grid.values()];
}
export function holdingBuckets(trades) {
  const defs = [[0, 15, '<15分'], [15, 60, '15–60分'], [60, 240, '1–4h'], [240, 1440, '4–24h'], [1440, 1e12, '>1天']];
  return defs.map(([lo, hi, label]) => {
    const arr = trades.filter(t => { const m = (t.exitTime - t.entryTime) / 60000; return m >= lo && m < hi; });
    const n = arr.length, wins = arr.filter(t => t.pnl > 0).length, net = round2(sum(arr.map(t => t.pnl))), totalR = round2(sum(arr.map(t => t.rMultiple || 0)));
    return { label, n, wins, winRate: n ? wins / n : 0, expR: n ? round2(totalR / n) : 0, net, avgPnl: n ? round2(net / n) : 0 };
  });
}
export function advancedStats(trades) {
  const R = trades.map(t => t.rMultiple || 0), n = R.length;
  if (!n) return { sqn: null, kelly: null, mcMedianDD: null, mcWorstDD: null, mcDist: [], sqnGrade: '—' };
  const mean = avg(R), sd = stdev(R);
  const sqn = sd > 0 ? round2(mean / sd * Math.sqrt(Math.min(n, 100))) : null;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0), wr = wins.length / n;
  const avgW = wins.length ? avg(wins.map(t => t.rMultiple || 0)) : 0, avgL = losses.length ? Math.abs(avg(losses.map(t => t.rMultiple || 0))) : 1;
  const payoff = avgL > 0 ? avgW / avgL : 0;
  const kelly = payoff > 0 ? round2((wr - (1 - wr) / payoff) * 100) : null;
  let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const M = 600, dds = [];
  for (let m = 0; m < M; m++) { const a = R.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = a[i]; a[i] = a[j]; a[j] = tmp; } let cum = 0, peak = 0, dd = 0; for (const r of a) { cum += r; if (cum > peak) peak = cum; if (cum - peak < dd) dd = cum - peak; } dds.push(dd); }
  dds.sort((x, y) => x - y);
  const sqnGrade = sqn == null ? '—' : sqn < 1.6 ? '偏弱' : sqn < 2 ? '及格' : sqn < 2.5 ? '良好' : sqn < 3.9 ? '优秀' : '卓越';
  return { sqn, sqnGrade, kelly, mcMedianDD: round2(dds[Math.floor(M * 0.5)]), mcWorstDD: round2(dds[Math.floor(M * 0.05)]), mcDist: dds, expR: round2(mean) };
}

// —— 机构级体检指标(2026-07-13 K:对标华尔街/对冲基金 + quantstats·pyfolio·empyrical 标配)——
// 口径:全部从「交易业绩」算(s.dailyArr 日已实现盈亏 + s.equity 交易权益线,剔除出入金 —— 评估交易技艺的正确分母)。
// 诚实边界:日内合约无连续 NAV,这些是基于「每日已实现盈亏」的估算;CAGR/年化是外推,小样本抖动大,UI 必须标注估算。
function kRatioOf(cum) {   // Kestner K-ratio:权益曲线线性回归斜率 ÷ 斜率标准误(÷√n 归一),衡量"爬得稳不稳"
  const n = cum.length; if (n < 3) return null;
  const xbar = (n - 1) / 2, ybar = avg(cum);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (i - xbar) * (i - xbar); sxy += (i - xbar) * (cum[i] - ybar); }
  if (sxx === 0) return null;
  const slope = sxy / sxx, intercept = ybar - slope * xbar;
  let sse = 0; for (let i = 0; i < n; i++) { const pr = intercept + slope * i; sse += (cum[i] - pr) * (cum[i] - pr); }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return se > 0 ? round2(slope / se / Math.sqrt(n)) : null;
}
export function institutionalStats(s, startEq = 12000) {
  const days = (s && s.dailyArr) || [], pnls = days.map(d => d.pnl), n = pnls.length;
  const base = Math.max(1, startEq || 0);
  if (n < 2) return { insufficient: true, low: true, n };
  const eq = (s && s.equity) || [];
  const spanDays = eq.length >= 2 ? Math.max(1, (eq[eq.length - 1].t - eq[0].t) / DAY) : n;
  // 年化因子按【实际交易频率】而非固定 √252:pnls 只含活跃交易日,稀疏账户用 √252 会系统性高估 ~2.3×(审查 P1)。
  const freqPerYear = spanDays > 0 ? Math.min(252, n / spanDays * 365) : n;
  const ANN = Math.sqrt(Math.max(1, freqPerYear));
  const mean = avg(pnls), sd = stdev(pnls);
  const dsd = Math.sqrt(sum(pnls.map(p => (p < 0 ? p * p : 0))) / n);   // 下行偏差(MAR=0)
  const sharpe = sd > 0 ? round2(mean / sd * ANN) : null;
  const sortino = dsd > 0 ? round2(mean / dsd * ANN) : null;
  // Ulcer 指数:权益曲线回撤深度(%)的均方根(按记录点加权,非日历时长)
  let peak = -Infinity, sq = 0, mm = 0;
  for (const p of eq) { if (p.v > peak) peak = p.v; if (peak > 0) { const d = (p.v - peak) / peak * 100; sq += d * d; mm++; } }
  const ulcer = mm ? round2(Math.sqrt(sq / mm)) : null;
  const totalRet = s.net / base;
  const cagr = (1 + totalRet) > 0 ? round2((Math.pow(1 + totalRet, 365 / spanDays) - 1) * 100) : null;   // % 外推
  const maxDDpct = round2(Math.abs(s.maxDD) / base * 100);
  // 短跨度年化=荒谬外推(5天→6462%);<90天 或 <60交易日 都不可靠 → 依赖 cagr 的 calmar/upi 直接置 null 不误导(审查 P2)
  const cagrShaky = spanDays < 90 || n < 60;
  const calmar = (cagr != null && cagr > 0 && maxDDpct > 0.5 && !cagrShaky) ? round2(cagr / maxDDpct) : null;
  const recoveryFactor = Math.abs(s.maxDD) > 0.01 ? round2(s.net / Math.abs(s.maxDD)) : null;
  const grossLossD = Math.abs(sum(pnls.filter(p => p < 0)));
  const gainToPain = grossLossD > 0 ? round2(sum(pnls) / grossLossD) : null;
  // 尾部比率:样本 <20 时 |max|/|min| 坍缩成单点比,无统计意义 → 置 null 不渲染评级(审查 P2)
  let tailRatio = null;
  if (n >= 20) { const sorted = pnls.slice().sort((a, b) => a - b); const pct = f => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))]; const p05 = pct(0.05); tailRatio = Math.abs(p05) > 1e-9 ? round2(Math.abs(pct(0.95)) / Math.abs(p05)) : null; }
  let c = 0; const cum = pnls.map(p => (c += p));
  const kRatio = kRatioOf(cum);
  const annVol = round2(sd / base * ANN * 100);
  const upi = (ulcer && ulcer > 0.01 && cagr != null && !cagrShaky) ? round2(cagr / ulcer) : null;   // UPI / Martin ratio
  // 触底压力(有放回自助抽样):从历史日盈亏【有放回】抽 n 天拼一条路径 ×1500,统计中途余额 ≤0 的比例。
  // 有放回让累计能漂到比历史 net 更差的水平——无放回排列做不到(累计恒=Σpnl,总亏<本金则永远 0%,审查 P1)。
  // 诚实:从满额净投入 base 起跑,真实账户逐笔滴灌入金,故此数低估薄权益期真实爆仓风险 → 仅作【相对压力】参考,非真实归零概率。
  let seed = 20260713 >>> 0; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let hit = 0; const RM = 1500;
  for (let m = 0; m < RM; m++) { let bal = base; for (let i = 0; i < n; i++) { bal += pnls[Math.floor(rnd() * n)]; if (bal <= 0) { hit++; break; } } }
  const drawdownStress = round2(hit / RM * 100);   // % 触底压力(改名:不再叫「账户归零概率」)
  return {
    n, insufficient: n < 20, statShaky: n < 60, netPos: s.net >= 0, sharpe, sortino, ulcer, upi, cagr, calmar, recoveryFactor,
    gainToPain, tailRatio, kRatio, annVol, maxDDpct, drawdownStress, spanDays: Math.round(spanDays), cagrShaky,
  };
}

// —— 机构级指标的双渲染卡(新手/专业)。新手:大白话名 + 人话解释 + 好/中/差色;专业:学名 + 数值 + 公式脚注。——
// higher=true:越大越好;false:越小越好。样本不足返回灰。
function _g3(v, good, ok, higher = true, gray = false) {
  if (v == null) return { t: '样本不足', c: '#8A8A82' };
  if (gray) return { t: '样本少·仅参考', c: '#8A8A82' };   // 小样本护栏:不给绿"优秀"(审查 P1)
  const okGood = higher ? v >= good : v <= good, okOk = higher ? v >= ok : v <= ok;
  return okGood ? { t: '优秀', c: '#0E9268' } : okOk ? { t: '及格', c: '#B7791F' } : { t: '偏弱', c: '#D6455D' };
}
export function institutionalCards(k) {
  if (!k || k.low) return [];
  const nS = v => (v == null ? '—' : String(v)), pAbs = v => (v == null ? '—' : v + '%');   // 概率/波动率恒非负,不加 ± 号(审查 P2)
  const sk = !!k.statShaky;   // <60 交易日 → 年化类比率置灰、加"仅参考"(审查 P1)
  const skNote = sk ? '(你只有 ' + k.n + ' 个交易日,这数是从几十天外推的估算、会逐月大幅抖动,别据一次「优秀」就加仓。)' : '';
  const D = [
    { key: 'sortino', proLabel: 'Sortino 比率', novLabel: '亏损稳定性', val: nS(k.sortino), grade: _g3(k.sortino, 2, 1, true, sk),
      say: '只看你亏钱时的颠簸来算稳定性。越高越稳,>2 算优秀。它比 Sharpe 更公道——不会因为你某天赚太多就说你"波动大"。' + skNote,
      formula: '年化下行波动调整收益(MAR=0):日盈亏均值 ÷ 下行偏差 × √(实际交易频率)。' },
    { key: 'sharpe', proLabel: 'Sharpe 比率', novLabel: '整体稳定性', val: nS(k.sharpe), grade: _g3(k.sharpe, 1.5, 0.8, true, sk),
      say: '每承受 1 块钱的上下颠簸,换来多少收益。>1 及格,>2 优秀。华尔街最常挂嘴边的数。' + skNote,
      formula: '日盈亏均值 ÷ 标准差 × √(实际交易频率;非固定√252,因只含活跃交易日)。' },
    { key: 'ulcer', proLabel: 'Ulcer 指数', novLabel: '扛单煎熬度', val: nS(k.ulcer), grade: _g3(k.ulcer, 3, 8, false, sk),
      say: '把你账户"水下"有多深算成一个煎熬分。越低越舒服;越高说明你经常深套。' + skNote,
      formula: '权益回撤深度(%)的均方根(按记录点加权,非日历时长)。' },
    { key: 'recoveryFactor', proLabel: '恢复因子', novLabel: '填坑能力', val: nS(k.recoveryFactor), grade: _g3(k.recoveryFactor, 2, 1, true, sk),
      say: '你赚到的总利润,是你最深那个坑的几倍。>2 填坑有力;<1 说明还没爬出最深的坑。' + skNote,
      formula: '净利润 ÷ 最大回撤($)。' },
    { key: 'calmar', proLabel: 'Calmar 比率', novLabel: '收益配得上回撤吗', val: nS(k.calmar), grade: _g3(k.calmar, 3, 1, true, sk || k.cagrShaky),
      say: k.calmar == null ? '需要更长的数据跨度才能可靠年化——你现在跨度太短,这个数暂不显示(免得给你一个荒唐的外推值)。' : '你年化赚的,是你最大回撤的几倍——衡量"赚这些钱值不值得担这么大回撤"。',
      formula: '年化收益 ÷ 最大回撤%。' + (k.cagrShaky ? ' ⚠跨度<90天或<60交易日,年化不可靠,已隐藏数值。' : '') },
    { key: 'gainToPain', proLabel: 'Gain-to-Pain', novLabel: '赚痛比', val: nS(k.gainToPain), grade: _g3(k.gainToPain, 1, 0.3, true, sk),
      say: '你赚的每一分,是用多少"亏损的痛"换来的。>1 说明赚得比亏得多;对冲基金月报必看。' + skNote,
      formula: '总盈亏 ÷ 亏损日绝对值之和(Schwager Gain-to-Pain)。' },
    { key: 'tailRatio', proLabel: '尾部比率', novLabel: '大赚 vs 大亏', val: nS(k.tailRatio),
      // 符号护栏:tailRatio 不含净盈亏符号——净亏账户就算大赚日更极端(>1),也绝不能判绿"优秀"(终审 P1)
      grade: _g3(k.tailRatio, 1, 0.7, true, sk || (k.netPos === false && k.tailRatio != null)),
      say: k.tailRatio == null ? '样本还不到 20 个交易日,大赚/大亏比会坍缩成单点、没意义,先攒够再看。'
        : (k.netPos === false ? '你最大盈利日 vs 最大亏损日的极端度比值。⚠ 你整体是净亏的——这个比就算 >1(大赚日更猛),也不代表你在赚钱,只说明盈亏分布右尾更长;别把它读成"我很行"。'
          : '你最猛的赚和最狠的亏,哪个更极端。>1 说明大赚 > 大亏(肥在右边,好);<1 说明大亏更凶。'),
      formula: '|日盈亏 95 分位| ÷ |5 分位|(样本 <20 不计算;净亏时不判绿——尾部形状 ≠ 是否赚钱)。' },
    { key: 'kRatio', proLabel: 'K-ratio', novLabel: '爬坡稳不稳', val: nS(k.kRatio), grade: _g3(k.kRatio, 1, 0.3, true, sk),
      say: '你的权益是稳步往上爬,还是坐过山车。越高说明曲线越平滑、越像一条稳稳的上坡路。' + skNote,
      formula: 'Kestner:权益曲线回归斜率 ÷ 斜率标准误 ÷ √n。' },
    { key: 'drawdownStress', proLabel: '触底压力·压测', novLabel: '余额触零压力', val: pAbs(k.drawdownStress),
      grade: k.drawdownStress >= 20 ? { t: '偏高', c: '#D6455D' } : { t: '压测值', c: '#8A8A82' }, alert: k.drawdownStress >= 20,
      say: '把你的日盈亏有放回随机抽 ' + k.n + ' 天拼成一条条假想路径压测,有多少条中途余额就触零了。⚠ 这是从满额净投入满血起跑算的相对压力,不是你真实的历史归零概率——你真实账户是逐笔滴灌入金、真实爆仓看「资金真相卡」。',
      formula: '有放回自助抽样 1500 次(从满额净投入起跑),统计中途余额 ≤0 的路径比例。非真实爆仓概率(未含出入金时序)。' },
    { key: 'annVol', proLabel: '年化波动率', novLabel: '账户颠簸幅度', val: pAbs(k.annVol), grade: { t: '', c: '#8A8A82' },
      say: '你账户价值一年上下晃动的幅度。越大越刺激也越危险;它本身没好坏,是给上面那些比率当分母的。',
      formula: '日盈亏标准差 ÷ 起始基数 × √(实际交易频率)。' },
  ];
  return D;
}

// —— 情绪 × 表现(净额 / 胜率 / 每笔期望R)——
export function emotionPerformance(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = t.emotion || '未记录';
    const e = m.get(k) || { emotion: k, pnl: 0, count: 0, wins: 0, r: 0 };
    e.pnl = round2(e.pnl + t.pnl); e.count++; if (t.pnl > 0) e.wins++; e.r = round2(e.r + (t.rMultiple || 0));
    m.set(k, e);
  }
  return [...m.values()].map(e => ({ emotion: e.emotion, pnl: e.pnl, count: e.count, wins: e.wins, winRate: e.count ? e.wins / e.count : 0, expR: e.count ? round2(e.r / e.count) : 0, avgPnl: e.count ? round2(e.pnl / e.count) : 0 })).sort((a, b) => b.pnl - a.pnl);
}

// —— 复盘一致性:最近 N 周按日打卡格(GitHub 贡献图式) ——
export function consistencyGrid(journal, dailyMap, todayKey, weeks = 16) {
  const todayMs = keyToMs(todayKey);
  const dowMon = (bj(todayMs).dow + 6) % 7;      // 0=周一
  const endSun = todayMs + (6 - dowMon) * DAY;   // 本周周日(可能是未来)
  const start = endSun - (weeks * 7 - 1) * DAY;
  const cells = [], monthTicks = [];
  let lastMo = -1;
  for (let i = 0; i < weeks * 7; i++) {
    const ms = start + i * DAY, b = bj(ms), key = dateKey(ms + TZ);
    const dow = (b.dow + 6) % 7, week = Math.floor(i / 7);
    const day = dailyMap.get(key);
    const reviewed = !!(journal[key] && journal[key].done);
    if (dow === 0 && b.mo !== lastMo) { monthTicks.push({ week, label: b.mo + '月' }); lastMo = b.mo; }
    cells.push({ key, dow, week, future: ms > todayMs, reviewed, traded: !!(day && day.count), count: day ? day.count : 0, pnl: day ? day.pnl : 0, mo: b.mo, d: b.d });
  }
  const past = cells.filter(c => !c.future);
  const reviewedN = past.filter(c => c.reviewed).length;
  const tradedN = past.filter(c => c.traded).length;
  const coveredN = past.filter(c => c.traded && c.reviewed).length;
  const missedN = past.filter(c => c.traded && !c.reviewed).length;
  return { cells, weeks, monthTicks, reviewedN, tradedN, coveredN, missedN, coverage: tradedN ? coveredN / tradedN : (reviewedN > 0 ? 1 : 0), streak: journalStreak(journal, todayKey, dailyMap) };
}

// —— 给 AI 的上下文打包 ——
export function buildContext(s, trades, journal, scope) {
  const score = reviewScore(s);
  const flags = behaviorFlags(s);
  const lines = [];
  lines.push(`# 交易复盘数据快照(${scope},北京时间口径,USDT 永续合约)`);
  lines.push(`总览: ${s.n} 笔闭环 | 净盈亏 ${fmtUsd(s.net, true)} | 胜率 ${fmtPct(s.winRate)} (${s.wins}胜${s.losses}负) | 利润因子 ${fmtNum(s.pf)} | 期望值 ${fmtUsd(s.expectancy, true)}/笔 | 盈亏比 ${s.payoff ? fmtNum(s.payoff) : '--'} | 最大回撤 ${fmtUsd(s.maxDD)} | 手续费 ${fmtUsd(s.fees)}`);
  // 让 AI 知道自己不知道:worstTrade 无计划风险时说明是裸单/证据缺失,而非编造一个数字
  lines.push(`平均盈利 ${fmtUsd(s.avgWin)} vs 平均亏损 ${fmtUsd(s.avgLoss)};最大单笔亏损 ${s.worstTrade ? `${s.worstTrade.symbol} ${s.worstTrade.side} ${fmtUsd(s.worstTrade.pnl)}(${s.worstTrade.plannedRisk != null ? `计划风险 ${fmtUsd(s.worstTrade.plannedRisk)}` : '计划风险未记录'},持仓 ${fmtDur((s.worstTrade.exitTime - s.worstTrade.entryTime) / 60000)})` : '--'}`);
  lines.push(`R 视角${s.rEstimatedN === s.n && s.n ? '(⚠ 全部按典型亏损中位数估算 —— 该账户无任何止损单证据,R 非实测风险)' : s.rEstimatedN ? `(其中 ${s.rEstimatedN}/${s.n} 笔 R 为估算)` : ''}: 累计 ${s.totalR}R | 期望 ${s.expectancyR}R/笔 | 盈利均值 ${s.avgWinR}R vs 亏损均值 ${s.avgLossR}R(R盈亏比 ${s.payoffR ?? '--'}) | 最佳 ${s.bestR}R 最差 ${s.worstR}R`);
  lines.push(`执行效率: 平均有利偏移 ${s.avgMfeR}R,平均不利偏移 ${s.avgMaeR}R,出场效率 ${fmtPct(s.exitEff)}(赢家平均让利 ${s.giveBackR}R)`);
  if (s.bySetup && s.bySetup.length) lines.push('各策略R: ' + s.bySetup.map(x => `${x.setup} ${x.count}笔 ${x.r >= 0 ? '+' : ''}${x.r}R 胜率${fmtPct(x.winRate)}`).join(' | '));
  const _dsc = disciplineSplit(trades);
  if (_dsc.coverage < 0.3) lines.push(`纪律账单: 无法评判 —— ${trades.length} 笔中仅 ${_dsc.covered} 笔有行为标签或止损证据(其余未标注/订单流未同步)。切勿把「破坏纪律 0 笔」当成用户守纪律的证据。`);
  else lines.push(`纪律账单: 未检出违例 ${_dsc.clean.n}笔 期望${_dsc.clean.expectancyR}R/笔 净${fmtUsd(_dsc.clean.net, true)} | 检出违例 ${_dsc.dirty.n}笔 期望${_dsc.dirty.expectancyR}R/笔 净${fmtUsd(_dsc.dirty.net, true)} | 不可观测 ${_dsc.unknown.n}笔 | 违例估算代价 ${fmtUsd(_dsc.cost)}(覆盖率 ${Math.round(_dsc.coverage * 100)}%)`);
  lines.push(`薄流动性时段(金属亚洲盘/美股盘前盘后/休市): ${s.late.count} 笔合计 ${fmtUsd(s.late.pnl, true)};报复单 ${s.revenge.length} 笔;止损订单: ${s.stopOrderEvidenceN ?? s.stopEvidenceN}/${s.n} 笔有窗口观测;止损纪律: ${s.stopDisciplineN ?? 0}/${s.n} 笔可判定,${s.stopAbsentN || 0} 笔有完整覆盖下未检出证据,${s.stopUnknownN ?? s.n} 笔不可观测(不可观测不得当作通过);单日最多 ${Math.max(0, ...s.dailyArr.map(d => d.count))} 笔`);
  if (s.clusters.length) lines.push('错误标签聚类: ' + s.clusters.map(c => `${c.tag}×${c.count}(伤害${fmtUsd(c.damage)})`).join(' | '));
  lines.push('情绪×盈亏: ' + s.byEmotion.map(e => `${e.emotion}${e.count}笔${fmtUsd(e.pnl, true)}`).join(' | '));
  lines.push('品种: ' + s.bySymbol.map(x => `${x.symbol} ${x.count}笔 ${fmtUsd(x.pnl, true)} 胜率${fmtPct(x.wins / x.count)}`).join(' | '));
  lines.push(`系统评分 ${score.score}/10 — ${score.verdict}`);
  lines.push('风险灯: ' + flags.map(f => `[${f.level}] ${f.title}: ${f.metric}`).join(' | '));
  const recent = trades.slice().sort((a, b) => b.exitTime - a.exitTime).slice(0, 12);
  lines.push('\n最近逐笔(新→旧):');
  for (const t of recent) lines.push(`- ${fmtDT(t.exitTime)} ${t.symbol} ${t.side} ${fmtUsd(t.pnl, true)} 持仓${fmtDur((t.exitTime - t.entryTime) / 60000)} 情绪:${t.emotion || '-'}${t.tags && t.tags.length ? ' 标签:' + t.tags.join(',') : ''}${t.note ? ' 笔记:' + t.note : ''}`);
  const jKeys = Object.keys(journal || {}).sort().slice(-4);
  if (jKeys.length) { lines.push('\n最近盘后日志:'); for (const k of jKeys) lines.push(`- ${k} 心情:${journal[k].mood} ${journal[k].note}${journal[k].rules && journal[k].rules.length ? ' 新规则:' + journal[k].rules.join(';') : ''}`); }
  return lines.join('\n');
}

// ============================================================
// 市场情境引擎:EMA/ATR 情境标注 · 九宫格 · 入场/出场质量 · 同类对照 · 法医叙事
// ============================================================
export function emaSeries(vals, period) {
  const k = 2 / (period + 1); const out = new Array(vals.length);
  let e = vals[0] || 0;
  for (let i = 0; i < vals.length; i++) { e = i ? vals[i] * k + e * (1 - k) : e; out[i] = e; }
  return out;
}
export function atrSeries(kl, period = 14) {
  const out = new Array(kl.length).fill(0);
  if (!kl.length) return out;
  let prevC = kl[0].c, acc = 0;
  for (let i = 0; i < kl.length; i++) {
    const k = kl[i];
    const tr = i === 0 ? (k.h - k.l) : Math.max(k.h - k.l, Math.abs(k.h - prevC), Math.abs(k.l - prevC));
    acc = i === 0 ? tr : (acc * (period - 1) + tr) / period;
    out[i] = acc; prevC = k.c;
  }
  return out;
}
function idxAtOrBefore(kl, t) { let lo = 0, hi = kl.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (kl[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
export function closeAt(series, t) { const i = idxAtOrBefore(series, t); return i >= 0 ? series[i].c : null; }

// 为一笔交易标注「它出生的行情」:趋势对齐 / 波动分位 / 追价 / 日内位置 / BTC 同期 / 实测 MAE·MFE / 极值出场
export function buildTradeContext(t, kl, btc) {
  if (!kl || kl.length < 60) return null;
  const iE = idxAtOrBefore(kl, t.entryTime);
  if (iE < 52) return null;
  const iX = Math.max(iE, Math.min(kl.length - 1, idxAtOrBefore(kl, t.exitTime)));
  const closes = kl.map(k => k.c);
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const atr = atrSeries(kl, 14);
  const px = closes[iE], a = atr[iE] || px * 0.004;
  const flat = Math.abs(e20[iE] - e50[iE]) < a * 0.45;
  const trendDir = flat ? 'flat' : (e20[iE] > e50[iE] ? 'up' : 'down');
  const align = flat ? 'flat' : ((trendDir === 'up') === (t.side === 'LONG') ? 'with' : 'against');
  const atrPct = a / px;
  let below = 0, tot = 0;
  for (let i = 20; i < kl.length; i++) { if (atr[i] / closes[i] <= atrPct) below++; tot++; }
  const volPct = tot ? Math.round(below / tot * 100) : 50;
  const volBand = volPct < 34 ? 0 : volPct < 67 ? 1 : 2;
  // 追价:入场价在近 24h(24 根 1h)区间中的位置;多头越高越追,空头取反
  const w0 = Math.max(0, iE - 23);
  let hi = -Infinity, lo = Infinity;
  for (let i = w0; i <= iE; i++) { if (kl[i].h > hi) hi = kl[i].h; if (kl[i].l < lo) lo = kl[i].l; }
  const rawPos = hi > lo ? Math.min(1, Math.max(0, (t.entryPrice - lo) / (hi - lo))) : 0.5;
  const chase = t.side === 'LONG' ? rawPos : 1 - rawPos;
  // 当日(北京时间)高低点位置:当日 0 点 → 入场时刻
  const dayStart = keyToMs(dateKey(t.entryTime));
  let dh = -Infinity, dl = Infinity;
  for (let i = 0; i <= iE; i++) { if (kl[i].t < dayStart) continue; if (kl[i].h > dh) dh = kl[i].h; if (kl[i].l < dl) dl = kl[i].l; }
  const dayPos = dh > dl ? Math.min(1, Math.max(0, (t.entryPrice - dl) / (dh - dl))) : null;
  let btcRet = null;
  if (btc && btc.length > 2) { const b0 = closeAt(btc, t.entryTime), b1 = closeAt(btc, t.exitTime); if (b0 && b1) btcRet = b1 / b0 - 1; }
  // 持仓窗口实测偏移与极值出场
  const dir = t.side === 'LONG' ? 1 : -1;
  let adv = t.entryPrice, fav = t.entryPrice;
  for (let i = iE; i <= iX; i++) {
    const k = kl[i];
    if (dir === 1) { if (k.l < adv) adv = k.l; if (k.h > fav) fav = k.h; }
    else { if (k.h > adv) adv = k.h; if (k.l < fav) fav = k.l; }
  }
  const rDist = (t.oneR && t.qty) ? t.oneR / t.qty : a * 1.2;
  const maeR = round2(Math.max(0, dir * (t.entryPrice - adv)) / rDist);
  const mfeR = round2(Math.max(0, dir * (fav - t.entryPrice)) / rDist);
  const advSpan = Math.abs(t.entryPrice - adv);
  const exitNearExtreme = t.pnl < 0 && advSpan > 0 ? Math.abs(t.exitPrice - adv) / advSpan <= 0.25 : false;
  let postFav = 0;
  for (let i = iX + 1; i <= Math.min(kl.length - 1, iX + 2); i++) {
    const k = kl[i];
    const mv = dir === 1 ? (k.h - t.exitPrice) / t.exitPrice : (t.exitPrice - k.l) / t.exitPrice;
    if (mv > postFav) postFav = mv;
  }
  return { ok: true, align, trendDir, flat, volBand, volPct, atrPct: Math.round(atrPct * 1e4) / 1e4, chase: Math.round(chase * 1000) / 1000, rawPos: Math.round(rawPos * 1000) / 1000, dayPos, btcRet, maeR, mfeR, exitNearExtreme, postFav: Math.round(postFav * 1e4) / 1e4 };
}

// 顺势/震荡/逆势分层 + 趋势对齐×波动 九宫格期望
export function marketBreakdown(trades, ctxMap) {
  const mk = () => ({ n: 0, wins: 0, r: 0, net: 0 });
  const rows = { with: mk(), flat: mk(), against: mk() };
  const cells = [];
  for (let a = 0; a < 3; a++) for (let v = 0; v < 3; v++) cells.push({ a, v, n: 0, wins: 0, r: 0, net: 0 });
  let covered = 0;
  for (const t of trades) {
    const c = ctxMap && ctxMap.get ? ctxMap.get(t.id) : null;
    if (!c || !c.ok) continue;
    covered++;
    const row = rows[c.align]; row.n++; row.net = round2(row.net + t.pnl); row.r += (t.rMultiple || 0); if (t.pnl > 0) row.wins++;
    const ai = c.align === 'with' ? 0 : c.align === 'flat' ? 1 : 2;
    const cell = cells[ai * 3 + c.volBand]; cell.n++; cell.net = round2(cell.net + t.pnl); cell.r += (t.rMultiple || 0); if (t.pnl > 0) cell.wins++;
  }
  for (const k of Object.keys(rows)) { const r = rows[k]; r.expR = r.n ? round2(r.r / r.n) : null; r.winRate = r.n ? r.wins / r.n : null; }
  for (const c of cells) { c.expR = c.n ? round2(c.r / c.n) : null; c.winRate = c.n ? c.wins / c.n : null; }
  return { rows, cells, covered, total: trades.length };
}

// —— 入场质量分:追价百分位 / 距上笔亏损间隔 / 当日第几笔 ——
export function entryQuality(t, all, ctx) {
  const parts = []; let score = 100;
  const dk = dateKey(t.entryTime);
  const dayList = all.filter(x => dateKey(x.entryTime) === dk && x.entryTime <= t.entryTime).sort((a, b) => a.entryTime - b.entryTime);
  const idx = dayList.findIndex(x => x.id === t.id);
  const nth = idx >= 0 ? idx + 1 : dayList.length + 1;
  const nTone = nth <= 2 ? 'good' : nth === 3 ? 'warn' : 'bad';
  if (nTone === 'warn') score -= 12; else if (nTone === 'bad') score -= 26;
  parts.push({ key: 'nth', label: '当日第几笔', value: `第 ${nth} 笔`, tone: nTone, detail: nth <= 2 ? '出手克制' : nth === 3 ? '已到日内 3 笔上限' : '超出 3 笔上限 · 过度交易区' });
  const prevLoss = all.filter(x => x.exitTime <= t.entryTime && x.pnl < 0 && x.id !== t.id).sort((a, b) => b.exitTime - a.exitTime)[0];
  const gap = prevLoss ? Math.round((t.entryTime - prevLoss.exitTime) / 60000) : null;
  let gTone = 'good', gVal = '—', gDet = '此前没有亏损记录';
  if (gap != null) {
    gVal = gap < 60 ? gap + ' 分钟' : gap < 2880 ? Math.round(gap / 60) + ' 小时' : Math.round(gap / 1440) + ' 天';
    if (gap < 45) { gTone = 'bad'; gDet = '报复窗口内进场 · 情绪开单概率高'; score -= 30; }
    else if (gap < 120) { gTone = 'warn'; gDet = '刚亏完不久 · 确认不是在找回场子'; score -= 12; }
    else gDet = '与上笔亏损间隔充分';
  }
  parts.push({ key: 'gap', label: '距上笔亏损', value: gVal, tone: gTone, detail: gDet });
  if (ctx && ctx.ok && ctx.chase != null) {
    const pct = Math.round(ctx.chase * 100);
    const word = t.side === 'LONG' ? '高位' : '低位';
    let cTone = 'good', cDet = `入场贴近近 24h 区间${t.side === 'LONG' ? '下沿' : '上沿'} · 不追价`;
    if (pct >= 85) { cTone = 'bad'; cDet = `追在近 24h 极端${word} · 容易接最后一棒`; score -= 30; }
    else if (pct >= 62) { cTone = 'warn'; cDet = `偏${word}进场 · 留意回撤空间`; score -= 13; }
    parts.push({ key: 'chase', label: '追价百分位', value: `${pct}% ${word}`, tone: cTone, detail: cDet });
  } else {
    parts.push({ key: 'chase', label: '追价百分位', value: '待同步', tone: 'na', detail: '同步行情后可评(近 24h 区间位置)' });
  }
  return { score: Math.max(4, Math.round(score)), parts };
}

// —— 出场质量分:MFE 捕获率 / 是否砍在极值附近 / 出场后打脸 ——
export function exitQuality(t, ctx) {
  const parts = []; let score = 100;
  const real = !!(ctx && ctx.ok);
  const mfe = real ? ctx.mfeR : (t.mfeR || 0);
  const mae = real ? ctx.maeR : (t.maeR || 0);
  const r = t.rMultiple || 0;
  if (t.pnl >= 0) {
    const cap = mfe > 0 ? Math.max(0, Math.min(1, r / mfe)) : 1;
    const pct = Math.round(cap * 100);
    let tone = 'good', det = '把行情给的肉基本吃满';
    if (cap < 0.35) { tone = 'bad'; det = `浮盈最高 +${fmtNum(mfe, 1)}R 只落袋 ${fmtNum(r, 1)}R · 止盈过早`; score -= 32; }
    else if (cap < 0.6) { tone = 'warn'; det = `让利 ${fmtNum(Math.max(0, mfe - r), 1)}R · 可用移动止损咬住`; score -= 14; }
    parts.push({ key: 'cap', label: 'MFE 捕获率', value: pct + '%', tone, detail: det });
    if (mae > 1.15) { parts.push({ key: 'heat', label: '过程承压', value: '-' + fmtNum(mae, 1) + 'R', tone: 'warn', detail: '浮亏一度超过 1R · 赢得侥幸' }); score -= 10; }
    else parts.push({ key: 'heat', label: '过程承压', value: '-' + fmtNum(mae, 1) + 'R', tone: 'good', detail: '持仓过程压力可控' });
  } else {
    if (real) {
      let tone = 'good', det = '出场离本笔最不利极值尚有距离 · 不算割在地板';
      if (ctx.exitNearExtreme) { tone = 'bad'; det = '砍在本笔最不利极值 ±25% 区内 · 典型割在地板 / 天花板'; score -= 30; }
      parts.push({ key: 'ext', label: '砍在极值附近', value: ctx.exitNearExtreme ? '是' : '否', tone, detail: det });
      const pf = Math.round((ctx.postFav || 0) * 1000) / 10;
      if (pf >= 0.8) { parts.push({ key: 'post', label: '出场后 2h', value: '反向 ' + pf + '%', tone: pf >= 1.5 ? 'bad' : 'warn', detail: '刚离场价格就朝原持仓方向走 · 出场点踩在情绪最差处' }); score -= (pf >= 1.5 ? 22 : 10); }
      else parts.push({ key: 'post', label: '出场后 2h', value: '反向 ' + pf + '%', tone: 'good', detail: '离场后行情没有明显打脸 · 认赔动作正确' });
    } else {
      parts.push({ key: 'ext', label: '砍在极值附近', value: '待同步', tone: 'na', detail: '同步行情后可评' });
    }
    if (mfe >= 0.8) { parts.push({ key: 'cap', label: '浮盈利用', value: '曾 +' + fmtNum(mfe, 1) + 'R', tone: 'warn', detail: '一度有可观浮盈未处理,最终亏损离场' }); score -= 12; }
    else parts.push({ key: 'cap', label: '浮盈利用', value: '几乎无浮盈', tone: 'good', detail: '进场即错方向,快速认赔是唯一正解' });
  }
  return { score: Math.max(4, Math.round(score)), parts, real };
}

// —— 同类对照:该笔 vs 同剧本(退级:同品种同方向 → 全部)均值,离群标红 ——
export function peerCompare(t, all) {
  let peers = t.setup ? all.filter(x => x.id !== t.id && x.setup === t.setup) : [];
  let base = t.setup ? `同剧本「${t.setup}」` : '';
  if (peers.length < 3) { peers = all.filter(x => x.id !== t.id && x.symbol === t.symbol && x.side === t.side); base = '同品种同方向'; }
  if (peers.length < 3) { peers = all.filter(x => x.id !== t.id); base = '全部交易'; }
  if (peers.length < 3) return { has: false };
  const dur = x => (x.exitTime - x.entryTime) / 60000;
  const defs = [
    ['R 倍数', x => x.rMultiple || 0, v => (v >= 0 ? '+' : '') + fmtNum(v, 2) + 'R'],
    ['持仓时长', dur, v => fmtDur(v)],
    ['不利偏移 MAE', x => x.maeR || 0, v => '-' + fmtNum(v, 2) + 'R'],
  ];
  const rows = defs.map(([label, fn, disp]) => {
    const vs = peers.map(fn); const m = avg(vs); const sd = stdev(vs);
    const mine = fn(t); const z = sd > 0 ? (mine - m) / sd : 0;
    return { label, mine: disp(mine), avg: disp(Math.round(m * 100) / 100), z: Math.round(z * 10) / 10, outlier: Math.abs(z) >= 1.75 };
  });
  return { has: true, base: `${base} ${peers.length} 笔均值`, rows };
}

// —— 法医叙事(本地确定性生成;AI 可在其上润色)——
export function forensicText(t, ctx, eq, xq, guards) {
  const p = tradeProcess(t, guards);
  const bits = [];
  const nth = eq.parts.find(x => x.key === 'nth'), gap = eq.parts.find(x => x.key === 'gap'), chase = eq.parts.find(x => x.key === 'chase');
  let open = `${String(bj(t.entryTime).h).padStart(2, '0')} 点档、当日${nth ? nth.value : ''}${t.side === 'LONG' ? '做多' : '做空'} ${t.symbol.replace('USDT', '')}`;
  if (gap && gap.tone === 'bad') open += `,距上笔亏损仅 ${gap.value}`;
  bits.push(open);
  if (chase && chase.tone !== 'na') bits.push(chase.tone === 'good' ? `入场位置 ${chase.value},不追价` : `追在近 24h ${chase.value}`);
  if (ctx && ctx.ok) {
    const alignW = ctx.align === 'with' ? '顺 1h 趋势' : ctx.align === 'flat' ? '1h 无趋势' : '逆 1h 趋势';
    const volW = ['低', '中', '高'][ctx.volBand];
    bits.push(`${alignW} · ${volW}波动(ATR ${ctx.volPct} 分位)${ctx.btcRet != null ? ` · BTC 同期 ${ctx.btcRet >= 0 ? '+' : ''}${(ctx.btcRet * 100).toFixed(1)}%` : ''}`);
  }
  if (t.pnl >= 0) {
    const cap = xq.parts.find(x => x.key === 'cap');
    bits.push(cap && cap.tone !== 'good' ? `浮盈只捕获 ${cap.value}` : `捕获率 ${cap ? cap.value : '—'},出场干净`);
  } else {
    if (ctx && ctx.ok && ctx.exitNearExtreme) bits.push(`割在本笔极值附近${ctx.postFav >= 0.008 ? `,离场后 2h 反向 ${(ctx.postFav * 100).toFixed(1)}%` : ''}`);
    else bits.push(`${rTxt(t.rMultiple)} 认赔离场`);
  }
  bits.push(`定性:${p.verdict.label} · 入场分 ${eq.score} / 出场分 ${xq.score}`);
  return bits.join(';') + '。';
}

const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sum(a) / a.length : 0;
function stdev(a) { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1)); }
function round2(v) { return Math.round(v * 100) / 100; }
function r4(v) { return v >= 1000 ? Math.round(v * 10) / 10 : v >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 1e6) / 1e6; }
