import React, { useId, useMemo, useState } from 'react';
import { fmtUsd } from '@rv/engine';
import MetricCard from '../components/MetricCard';
import { createPortableBackup, serializePortableBackup } from '../lib/portable-backup';
import {
  buildReviewReport,
  reportWindow,
  validateReportWindow,
  type ReviewReport,
  type ReportWindow,
} from '../lib/review-report';
import { sessionArchive, useStore } from '../store';

function downloadBackup(name: string, serialized: string) {
  const blob = new Blob([serialized], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
    anchor.remove();
  }, 100);
}

function cloudReportPayload(
  report: ReviewReport,
  analyticsReady: boolean,
): Readonly<Record<string, unknown>> {
  const reviewEvidence = {
    format: 'rv-cloud-review-report/1',
    analyticsStatus: analyticsReady ? 'VERIFIED' : 'LOCKED',
    from: report.from,
    to: report.to,
    tradeCount: report.tradeCount,
    reviewed: report.reviewed,
    reviewRate: report.reviewRate,
    openActions: report.openActions,
    completedActions: report.completedActions,
    journalDays: report.journalDays,
    activeGuards: report.activeGuards,
    lessons: report.lessons,
  } as const;
  if (!analyticsReady) return Object.freeze(reviewEvidence);
  return Object.freeze({
    ...reviewEvidence,
    netPnl: report.netPnl,
    wins: report.wins,
    losses: report.losses,
    winRate: report.winRate,
    topSymbols: report.topSymbols,
  });
}

export default function ReportsView({ reference = new Date() }: { reference?: Date }) {
  const { session, analyticsReady, saveReportSnapshot } = useStore();
  const [period, setPeriod] = useState<'week' | 'month' | 'custom'>('week');
  const [range, setRange] = useState<ReportWindow>(() => reportWindow(reference, 'week'));
  const [draftRange, setDraftRange] = useState<ReportWindow>(() => reportWindow(reference, 'week'));
  const [rangeError, setRangeError] = useState('');
  const [plaintextConfirmed, setPlaintextConfirmed] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [cloudSaveState, setCloudSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const rangeHelpId = useId();
  const rangeErrorId = useId();
  const report = useMemo(() => buildReviewReport({
    trades: session.trades,
    reviews: session.reviews,
    actions: session.actions,
    journal: session.journal,
    guards: session.guards,
  }, range), [range, session]);

  function applyPreset(nextPeriod: 'week' | 'month') {
    const nextRange = reportWindow(reference, nextPeriod);
    setPeriod(nextPeriod);
    setDraftRange(nextRange);
    setRange(nextRange);
    setRangeError('');
    setCloudSaveState('idle');
  }

  function updateDraft(field: keyof ReportWindow, value: string) {
    setDraftRange((current) => ({ ...current, [field]: value }));
    setRangeError('');
  }

  function applyCustomRange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateReportWindow(draftRange);
    if (!validation.ok) {
      setRangeError(validation.message);
      return;
    }
    setRange(validation.window);
    setPeriod('custom');
    setRangeError('');
    setCloudSaveState('idle');
  }

  async function saveCloudReport() {
    if (!session.cloudWorkspace || period === 'custom' || cloudSaveState === 'saving') return;
    setCloudSaveState('saving');
    const saved = await saveReportSnapshot({
      reportType: period === 'week' ? 'WEEKLY' : 'MONTHLY',
      periodStart: range.from,
      periodEnd: range.to,
      payload: cloudReportPayload(report, analyticsReady),
    });
    setCloudSaveState(saved ? 'saved' : 'failed');
  }

  function exportCompleteBackup() {
    if (!plaintextConfirmed) return;
    setBackupError('');
    try {
      const exportedAt = Date.now();
      const coverageStatus = session.contract?.provenance.coverage.status;
      const backup = createPortableBackup({
        source: session.source,
        archive: sessionArchive(session),
        reviews: session.reviews,
        actions: session.actions,
        journal: session.journal,
        guards: session.guards,
        evidence: {
          accepted: session.contract?.provenance.coverage.accepted ?? session.trades.length,
          dropped: session.contract?.provenance.coverage.dropped ?? 0,
          coverage: coverageStatus === 'complete' || coverageStatus === 'partial'
            ? coverageStatus
            : 'unknown',
        },
      }, { kind: 'full-workspace' }, exportedAt);
      const serialized = serializePortableBackup(backup);
      downloadBackup(`复盘完整备份-${exportedAt}.rvbackup.json`, serialized);
    } catch {
      setBackupError('备份无法生成：当前工作区超出完整备份边界，或包含无法验证的数据。请先检查数据中心再重试。');
    }
  }

  return (
    <div className="page-stack report-page">
      <header className="page-heading">
        <div><p className="eyebrow">PERIODIC REVIEW</p><h1>周报 / 月报</h1></div>
        <p>把交易结果、复盘完成度、行动执行和日志放在同一观察范围内；不把样本范围冒充账户总账。</p>
      </header>

      <div className="report-toolbar">
        <div className="filter-row" role="group" aria-label="报告周期">
          <button type="button" aria-pressed={period === 'week'} className={period === 'week' ? 'active' : ''} onClick={() => applyPreset('week')}>本周</button>
          <button type="button" aria-pressed={period === 'month'} className={period === 'month' ? 'active' : ''} onClick={() => applyPreset('month')}>本月</button>
        </div>
        <div className="report-range-controls">
          <form className="report-range-form" onSubmit={applyCustomRange} noValidate>
            <label>
              起始日期
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="YYYY-MM-DD"
                maxLength={10}
                value={draftRange.from}
                aria-invalid={Boolean(rangeError)}
                aria-describedby={rangeError ? `${rangeHelpId} ${rangeErrorId}` : rangeHelpId}
                onChange={(event) => updateDraft('from', event.target.value)}
              />
            </label>
            <label>
              结束日期
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="YYYY-MM-DD"
                maxLength={10}
                value={draftRange.to}
                aria-invalid={Boolean(rangeError)}
                aria-describedby={rangeError ? `${rangeHelpId} ${rangeErrorId}` : rangeHelpId}
                onChange={(event) => updateDraft('to', event.target.value)}
              />
            </label>
            <button className="button secondary" type="submit">应用范围</button>
          </form>
          <p id={rangeHelpId}>起止日期均使用 YYYY-MM-DD，最多 366 天。已应用：<span>{range.from} — {range.to}</span></p>
          {rangeError && <p className="form-error" id={rangeErrorId} role="alert">{rangeError}</p>}
        </div>
        {session.cloudWorkspace && period !== 'custom' && (
          <button
            className="button secondary"
            type="button"
            disabled={cloudSaveState === 'saving'}
            onClick={() => void saveCloudReport()}
          >{cloudSaveState === 'saving' ? '保存中…' : '保存云端报告'}</button>
        )}
        <button className="button secondary" type="button" onClick={() => window.print()}>打印 / 存为 PDF</button>
      </div>
      {session.cloudWorkspace && cloudSaveState === 'saved' && <p role="status">当前报告已写入云端复盘数据。</p>}
      {session.cloudWorkspace && cloudSaveState === 'failed' && <p className="form-error" role="alert">云端报告保存失败，未覆盖现有版本。</p>}

      <div className="metric-grid">
        <MetricCard label="闭环交易" value={`${report.tradeCount} 笔`} note={analyticsReady ? `${report.wins} 胜 / ${report.losses} 负` : '胜负指标未解锁'} />
        <MetricCard label="复盘完成率" value={`${(report.reviewRate * 100).toFixed(1)}%`} note={`${report.reviewed} 笔已复盘`} />
        <MetricCard label="行动闭环" value={`${report.completedActions} 完成`} note={`${report.openActions} 待执行`} />
        <MetricCard label="日志 / 守则" value={`${report.journalDays} 天`} note={`${report.activeGuards} 条守则启用`} />
      </div>

      <section className="analytics-grid">
        <div className="panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">OBSERVED RESULTS</p><h2>当前周期结果</h2></div>
            <span>{analyticsReady ? '指标门禁通过' : '指标门禁未通过'}</span>
          </div>
          {analyticsReady ? (
            <>
              <strong className={`report-net ${report.netPnl >= 0 ? 'gain' : 'loss'}`}>{fmtUsd(report.netPnl, true)}</strong>
              <div className="symbol-table">
                {report.topSymbols.map((row) => (
                  <div className="symbol-row" key={row.symbol}>
                    <strong>{row.symbol}</strong><span>{row.trades} 笔</span><b className={row.netPnl >= 0 ? 'gain' : 'loss'}>{fmtUsd(row.netPnl, true)}</b>
                  </div>
                ))}
              </div>
            </>
          ) : <p className="empty-copy">数据证据不足，收益类指标保持关闭；复盘完成度与日志仍可查看。</p>}
        </div>

        <div className="panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">LESSONS</p><h2>本期只改什么</h2></div>
          </div>
          <ol className="rule-list">
            {report.lessons.map((lesson, index) => <li key={lesson}><span>{String(index + 1).padStart(2, '0')}</span>{lesson}</li>)}
          </ol>
          {!report.lessons.length && <p className="empty-copy">本期尚无已完成复盘结论。</p>}
        </div>
      </section>

      <section className="panel backup-panel">
        <div>
          <p className="eyebrow">USER-OWNED EXPORT</p>
          <h2>完整复盘备份</h2>
          <p>包含当前逐笔成交账本（可能含 Trade ID、Order ID、时间、价格、数量与费用）、交易存档、复盘、行动、日志和守则。完整备份是未加密明文文件，请只保存到你控制的安全位置。</p>
        </div>
        <label className="check-label"><input type="checkbox" checked={plaintextConfirmed} onChange={(event) => setPlaintextConfirmed(event.target.checked)} />我知道下载后的文件不再受云仓端到端加密保护</label>
        <button className="button secondary" type="button" disabled={!plaintextConfirmed || (!session.trades.length && !session.csvLedger)} onClick={exportCompleteBackup}>下载完整备份</button>
        {backupError && <p className="form-error" role="alert">{backupError}</p>}
      </section>

      <ul className="boundary-list" aria-label="报告边界">
        <li>收益、胜率和排名只代表当前导入或已对账范围，不代表完整账户。</li>
        <li>报告不能替代财务、税务、法律或个性化投资建议。</li>
        <li>系统不下单、不提供开仓价格、仓位或杠杆指令，也不保证避免亏损。</li>
      </ul>
    </div>
  );
}
