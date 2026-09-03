import { describe, expect, it } from 'vitest';
import { WORKBENCH_NAV } from './navigation';

describe('Classic workbench navigation', () => {
  it('exposes the complete 17-entry desktop information architecture', () => {
    expect(WORKBENCH_NAV.map((item) => item.label)).toEqual([
      '今日速览',
      '复盘总览',
      '复盘卡',
      '归因对标',
      '市场情境',
      'R 复盘',
      '策略手册',
      '今日仪式',
      '交易日历',
      'K线回放',
      'AI 教练',
      '行为实验室',
      '周报月报',
      '对比复盘',
      '成长目标',
      '深度洞察',
      '数据中心',
    ]);
    expect(new Set(WORKBENCH_NAV.map((item) => item.to)).size).toBe(17);
    expect(WORKBENCH_NAV).toHaveLength(17);
  });

  it('labels the coach as a deterministic local rule surface', () => {
    const coach = WORKBENCH_NAV.find((item) => item.to === '/coach');
    expect(coach).toMatchObject({ label: 'AI 教练', capability: 'local-rules' });
  });
});
