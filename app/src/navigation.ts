export type WorkbenchCapability = 'data' | 'review' | 'analytics' | 'local-rules';

export type WorkbenchNavItem = Readonly<{
  to: string;
  label: string;
  mark: string;
  group: 'daily' | 'review' | 'practice' | 'growth' | 'system';
  capability: WorkbenchCapability;
}>;

/**
 * The complete desktop information architecture. Keep the order stable: it
 * mirrors the review loop from observing today to maintaining the data source.
 */
export const WORKBENCH_NAV: readonly WorkbenchNavItem[] = Object.freeze([
  { to: '/today', label: '今日速览', mark: '01', group: 'daily', capability: 'review' },
  { to: '/overview', label: '复盘总览', mark: '02', group: 'daily', capability: 'analytics' },
  { to: '/trades', label: '复盘卡', mark: '03', group: 'review', capability: 'review' },
  { to: '/attribution', label: '归因对标', mark: '04', group: 'review', capability: 'analytics' },
  { to: '/context', label: '市场情境', mark: '05', group: 'review', capability: 'analytics' },
  { to: '/r', label: 'R 复盘', mark: '06', group: 'review', capability: 'analytics' },
  { to: '/playbook', label: '策略手册', mark: '07', group: 'practice', capability: 'review' },
  { to: '/ritual', label: '今日仪式', mark: '08', group: 'practice', capability: 'review' },
  { to: '/calendar', label: '交易日历', mark: '09', group: 'practice', capability: 'analytics' },
  { to: '/replay', label: 'K线回放', mark: '10', group: 'practice', capability: 'data' },
  { to: '/coach', label: 'AI 教练', mark: '11', group: 'practice', capability: 'local-rules' },
  { to: '/experiments', label: '行为实验室', mark: '12', group: 'growth', capability: 'review' },
  { to: '/reports', label: '周报月报', mark: '13', group: 'growth', capability: 'analytics' },
  { to: '/compare', label: '对比复盘', mark: '14', group: 'growth', capability: 'analytics' },
  { to: '/goals', label: '成长目标', mark: '15', group: 'growth', capability: 'review' },
  { to: '/analytics', label: '深度洞察', mark: '16', group: 'growth', capability: 'analytics' },
  { to: '/data', label: '数据中心', mark: '17', group: 'system', capability: 'data' },
]);

export const MOBILE_NAV = Object.freeze([
  { to: '/today', label: '今日', mark: '01' },
  { to: '/trades', label: '交易', mark: '03' },
  { to: '/analytics', label: '分析', mark: '16' },
  { to: '/data', label: '数据', mark: '17' },
]);
