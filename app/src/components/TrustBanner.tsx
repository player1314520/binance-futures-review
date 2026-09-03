import React from 'react';
import { useStore, type Session } from '../store';

const PHASE_COPY: Record<string, string> = {
  DEMO_READY: '确定性样本 · 可完整演示',
  IMPORT_READY: '本地导入样本 · 仅描述导入范围',
  BINANCE_CONNECTING: '正在读取本机净化数据',
  BINANCE_BROWSE_ONLY: '可信投影未完成 · 仅浏览净化记录',
  BINANCE_OBSERVED_READY: '当前窗口已对账 · 观测分析可用',
  BINANCE_EMPTY: '本机数据为空 · 未生成指标',
  BINANCE_BLOCKED: '可信门禁已阻断 · 未展示旧数据',
};

export function trustPhaseCopy(
  session: Pick<Session, 'contract' | 'phase' | 'source'>,
): string {
  const importCoverage = session.source === 'imported'
    ? session.contract?.provenance.coverage
    : null;
  return importCoverage
    ? `本地导入范围 · 接受 ${importCoverage.accepted} · 丢弃 ${importCoverage.dropped}`
    : PHASE_COPY[session.phase] ?? session.phase;
}

export default function TrustBanner() {
  const { session, sourceLabel } = useStore();
  const phaseCopy = trustPhaseCopy(session);
  const tone = session.phase === 'BINANCE_BLOCKED'
    ? 'danger'
    : session.phase === 'BINANCE_OBSERVED_READY' || session.phase === 'DEMO_READY'
      ? 'positive'
      : 'warning';
  return (
    <div className={`trust-banner ${tone}`} role="status">
      <span className="trust-dot" aria-hidden="true" />
      <div>
        <strong>{sourceLabel}</strong>
        <span>{phaseCopy}</span>
      </div>
      {session.source === 'demo' && <b className="demo-watermark">SYNTHETIC</b>}
    </div>
  );
}
