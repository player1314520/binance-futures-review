import React from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';

export default function AnalyticsLock() {
  const { session } = useStore();
  const importedWithoutPnl = session.source === 'imported'
    && session.contract?.capabilities.values.pnlReported !== true;
  const reasons = importedWithoutPnl
    ? ['PNL_NOT_REPORTED']
    : session.access?.reasonCodes ?? (
      session.errorCode ? [session.errorCode] : ['RECONCILIATION_REQUIRED']
    );
  return (
    <section className="capability-lock" aria-labelledby="analytics-lock-title">
      <div className="lock-mark" aria-hidden="true">×</div>
      <p className="eyebrow">CAPABILITY GATE</p>
      <h2 id="analytics-lock-title">分析指标暂未解锁</h2>
      <p>{importedWithoutPnl
        ? '导入文件未提供可验证的已实现盈亏，因此不会计算净结果、胜率、利润因子或累计曲线。'
        : '当前只允许浏览净化记录。只有同步窗口、成交集合和双边界证据被同一份可信切片绑定后，才会计算观测指标；这里不会拿旧缓存或演示数据补位。'}</p>
      <div className="reason-list" aria-label="阻断原因">
        {reasons.slice(0, 8).map((reason) => <code key={reason}>{reason}</code>)}
      </div>
      <Link className="button primary" to="/data">查看数据与对账</Link>
    </section>
  );
}
