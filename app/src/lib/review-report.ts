import type { ActionPlanMap } from './action-plan-storage';
import type { ReviewMap } from './review-storage';
import type { SnapshotGuard, SnapshotJournalEntry } from './workspace-snapshot';

export type ReportWindow = Readonly<{ from: string; to: string }>;
export const REPORT_WINDOW_MAX_DAYS = 366;

export type ReportWindowValidation = Readonly<
  | { ok: true; window: ReportWindow; days: number }
  | {
    ok: false;
    code: 'REPORT_WINDOW_REQUIRED' | 'REPORT_WINDOW_INVALID' | 'REPORT_WINDOW_ORDER' | 'REPORT_WINDOW_TOO_LARGE';
    message: string;
  }
>;

type ReportTrade = Readonly<{
  id: string | number;
  symbol: string;
  pnl: number;
  exitTime: number;
}>;

export type ReviewReportInput = Readonly<{
  trades: readonly ReportTrade[];
  reviews: ReviewMap;
  actions: ActionPlanMap;
  journal: readonly SnapshotJournalEntry[];
  guards: readonly SnapshotGuard[];
}>;

export type ReviewReport = Readonly<{
  from: string;
  to: string;
  tradeCount: number;
  netPnl: number;
  wins: number;
  losses: number;
  winRate: number;
  reviewed: number;
  reviewRate: number;
  openActions: number;
  completedActions: number;
  journalDays: number;
  activeGuards: number;
  topSymbols: readonly Readonly<{ symbol: string; trades: number; netPnl: number }>[];
  lessons: readonly string[];
}>;

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function beijingDay(timestamp: number): string {
  if (!Number.isFinite(timestamp)) throw new Error('REPORT_REFERENCE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function parseDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('REPORT_WINDOW_INVALID');
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || beijingDay(timestamp) !== value) {
    throw new Error('REPORT_WINDOW_INVALID');
  }
  return timestamp;
}

export function validateReportWindow(window: ReportWindow): ReportWindowValidation {
  if (!window.from || !window.to) {
    return Object.freeze({
      ok: false,
      code: 'REPORT_WINDOW_REQUIRED',
      message: '请填写起始日期和结束日期。',
    });
  }
  let fromTimestamp: number;
  let toTimestamp: number;
  try {
    fromTimestamp = parseDay(window.from);
    toTimestamp = parseDay(window.to);
  } catch {
    return Object.freeze({
      ok: false,
      code: 'REPORT_WINDOW_INVALID',
      message: '日期必须是有效的 YYYY-MM-DD。',
    });
  }
  if (fromTimestamp > toTimestamp) {
    return Object.freeze({
      ok: false,
      code: 'REPORT_WINDOW_ORDER',
      message: '起始日期不能晚于结束日期。',
    });
  }
  const days = ((toTimestamp - fromTimestamp) / 86_400_000) + 1;
  if (days > REPORT_WINDOW_MAX_DAYS) {
    return Object.freeze({
      ok: false,
      code: 'REPORT_WINDOW_TOO_LARGE',
      message: `日期范围最多 ${REPORT_WINDOW_MAX_DAYS} 天。`,
    });
  }
  return Object.freeze({ ok: true, window: Object.freeze({ ...window }), days });
}

export function reportWindow(reference: Date, period: 'week' | 'month'): ReportWindow {
  if (!Number.isFinite(reference.getTime())) throw new Error('REPORT_REFERENCE_INVALID');
  const [year, month, date] = beijingDay(reference.getTime()).split('-').map(Number);
  const localCalendar = new Date(Date.UTC(year, month - 1, date));
  if (period === 'week') {
    const mondayOffset = (localCalendar.getUTCDay() + 6) % 7;
    const from = new Date(localCalendar.getTime() - mondayOffset * 86_400_000);
    const to = new Date(from.getTime() + 6 * 86_400_000);
    return Object.freeze({ from: day(from), to: day(to) });
  }
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  return Object.freeze({ from: day(from), to: day(to) });
}

export function buildReviewReport(input: ReviewReportInput, window: ReportWindow): ReviewReport {
  const validation = validateReportWindow(window);
  if (!validation.ok) throw new Error(validation.code);
  const fromTimestamp = parseDay(validation.window.from);
  const toTimestamp = parseDay(validation.window.to) + 86_400_000;
  const trades = input.trades.filter((trade) => (
    Number.isFinite(trade.exitTime)
    && trade.exitTime >= fromTimestamp
    && trade.exitTime < toTimestamp
  ));
  const tradeIds = new Set(trades.map((trade) => String(trade.id)));
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const losses = trades.filter((trade) => trade.pnl < 0).length;
  const reviewedRows = Object.entries(input.reviews)
    .filter(([tradeId, review]) => tradeIds.has(tradeId) && review.reviewed);
  const actions = Object.values(input.actions)
    .filter((action) => tradeIds.has(action.sourceTradeId));
  const symbols = new Map<string, { symbol: string; trades: number; netPnl: number }>();
  for (const trade of trades) {
    const row = symbols.get(trade.symbol) ?? { symbol: trade.symbol, trades: 0, netPnl: 0 };
    row.trades += 1;
    row.netPnl += trade.pnl;
    symbols.set(trade.symbol, row);
  }
  const lessons = [...new Set(reviewedRows
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .map(([, review]) => review.lesson.trim())
    .filter(Boolean))]
    .slice(0, 8);
  return Object.freeze({
    from: window.from,
    to: window.to,
    tradeCount: trades.length,
    netPnl: trades.reduce((sum, trade) => sum + trade.pnl, 0),
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    reviewed: reviewedRows.length,
    reviewRate: trades.length ? reviewedRows.length / trades.length : 0,
    openActions: actions.filter((action) => action.status === 'open').length,
    completedActions: actions.filter((action) => action.status === 'done').length,
    journalDays: input.journal.filter((entry) => entry.day >= window.from && entry.day <= window.to).length,
    activeGuards: input.guards.filter((guard) => guard.active).length,
    topSymbols: Object.freeze([...symbols.values()]
      .sort((left, right) => right.netPnl - left.netPnl || right.trades - left.trades)
      .slice(0, 8)
      .map((row) => Object.freeze(row))),
    lessons: Object.freeze(lessons),
  });
}
