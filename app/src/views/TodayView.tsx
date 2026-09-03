import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  bj,
  displaySymbol,
  DOW_CN,
  fmtDT,
  fmtNum,
  fmtUsd,
} from '@rv/engine';
import { DEFAULT_RULES } from '@rv/engine/demo-data';
import type { TodayAccountScope } from '../App';
import { trustPhaseCopy } from '../components/TrustBanner';
import { useStore } from '../store';

function dayKey(timestamp: number): string {
  const parts = bj(timestamp);
  return `${parts.y}-${String(parts.mo).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

function dayCaption(timestamp: number): string {
  const parts = bj(timestamp);
  return `${parts.mo}月${parts.d}日 · 周${DOW_CN[parts.dow]}`;
}

function timeCaption(timestamp: number): string {
  const parts = bj(timestamp);
  return `${String(parts.h).padStart(2, '0')}:${String(parts.mi).padStart(2, '0')}`;
}

function tradesHref(accountScope: TodayAccountScope, tradeId?: string): string {
  const params = new URLSearchParams();
  if (tradeId) params.set('tradeId', tradeId);
  if (accountScope !== 'all') params.set('account', accountScope);
  const query = params.toString();
  return query ? `/trades?${query}` : '/trades';
}

export function selectTodayEvidenceDay(
  today: string,
  trades: readonly { readonly exitTime: number }[],
  records: readonly { readonly time: number }[],
): string | null {
  const hasTodayEvidence = trades.some((trade) => dayKey(trade.exitTime) === today)
    || records.some((record) => dayKey(record.time) === today);
  if (hasTodayEvidence) return today;

  const latestEvidenceAt = Math.max(
    trades[0]?.exitTime ?? Number.NEGATIVE_INFINITY,
    records[0]?.time ?? Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(latestEvidenceAt) ? dayKey(latestEvidenceAt) : null;
}

export default function TodayView({ accountScope }: Readonly<{ accountScope: TodayAccountScope }>) {
  const { session, sourceLabel, analyticsReady } = useStore();
  const today = dayKey(Date.now());
  const trades = useMemo(
    () => session.trades
      .filter((trade) => accountScope === 'all' || trade.account === accountScope)
      .sort((left, right) => right.exitTime - left.exitTime),
    [accountScope, session.trades],
  );
  const records = useMemo(
    () => session.records
      // SanitizedFill intentionally has no verified account field. Unknown
      // ownership is browsable only in the aggregate scope; never guess main.
      .filter(() => accountScope === 'all')
      .sort((left, right) => right.time - left.time),
    [accountScope, session.records],
  );
  const selectedDay = selectTodayEvidenceDay(today, trades, records);
  const selectedTrades = selectedDay
    ? trades.filter((trade) => dayKey(trade.exitTime) === selectedDay)
    : [];
  const selectedDayRecords = selectedDay
    ? records.filter((record) => dayKey(record.time) === selectedDay)
    : [];
  const selectedRecords = selectedTrades.length === 0
    ? selectedDayRecords
    : [];
  const selectedTimestamp = Math.max(
    selectedTrades[0]?.exitTime ?? Number.NEGATIVE_INFINITY,
    selectedDayRecords[0]?.time ?? Number.NEGATIVE_INFINITY,
  );
  const safeSelectedTimestamp = Number.isFinite(selectedTimestamp) ? selectedTimestamp : Date.now();
  const selectedDayKind = selectedDay === today
    ? '今日'
    : session.source === 'demo'
      ? '样本日'
      : '最近交易日';

  const selectedReviewed = selectedTrades.filter(
    (trade) => session.reviews[String(trade.id)]?.reviewed,
  ).length;
  const selectedPending = selectedTrades.length - selectedReviewed;
  const allReviewed = trades.filter(
    (trade) => session.reviews[String(trade.id)]?.reviewed,
  ).length;
  const pending = trades.filter(
    (trade) => !session.reviews[String(trade.id)]?.reviewed,
  );
  const focus = pending[0] ?? trades[0];
  const activeGuards = session.guards.filter((guard) => guard.active);
  const journal = selectedDay
    ? session.journal.find((entry) => entry.day === selectedDay)
    : undefined;
  const tradeEmotion = selectedTrades.find((trade) => trade.emotion?.trim())?.emotion?.trim();
  const emotion = journal?.emotion.trim() || tradeEmotion || '';
  const emotionSource = journal?.emotion.trim()
    ? '用户自填'
    : tradeEmotion
      ? session.source === 'demo' ? '样本交易标注' : '交易记录标注'
      : '尚未记录';
  const uniqueSymbols = new Set(
    trades.length
      ? trades.map((trade) => displaySymbol(trade.symbol, trade.market))
      : records.map((record) => record.symbol),
  ).size;

  const dayResult = analyticsReady && selectedTrades.length
    ? {
        net: selectedTrades.reduce((sum, trade) => sum + trade.pnl, 0),
        wins: selectedTrades.filter((trade) => trade.pnl > 0).length,
        losses: selectedTrades.filter((trade) => trade.pnl < 0).length,
        best: Math.max(...selectedTrades.map((trade) => trade.pnl)),
      }
    : null;
  const latestEvidenceAt = session.source === 'binance'
    ? session.runtime?.updatedAt ?? safeSelectedTimestamp
    : session.source === 'imported'
      ? session.meta?.importedAt ?? safeSelectedTimestamp
      : safeSelectedTimestamp;
  const evidenceCaption = session.source === 'demo'
    ? `样本截至 ${fmtDT(latestEvidenceAt)}`
    : session.source === 'imported'
      ? `导入于 ${fmtDT(latestEvidenceAt)}`
      : `本机更新 ${fmtDT(latestEvidenceAt)}`;
  const actionPlans = Object.values(session.actions)
    .filter((action) => action.status !== 'dismissed')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, 6);

  return (
    <div
      className="page-stack flagship-today"
      data-account-scope={accountScope}
      data-visual-lineage="classic-dc-v1-final"
      id="flagship-today"
    >
      <section className="today-command-card" aria-label="今日速览操作台">
        <div className="today-sync-strip">
          <div
            aria-live="polite"
            className={`today-sync-meta ${session.phase === 'BINANCE_BLOCKED' ? 'danger' : analyticsReady ? 'positive' : 'warning'}`}
            role="status"
          >
            <span className={`status-light ${session.phase.toLowerCase()}`} aria-hidden="true" />
            <strong>{sourceLabel}</strong>
            <span>
              {trades.length
                ? `${uniqueSymbols} 品种 · ${trades.length} 笔已平仓`
                : `${uniqueSymbols} 品种 · ${records.length} 条净化记录`}
            </span>
            <small>{evidenceCaption}</small>
            <span className="today-trust-copy">{trustPhaseCopy(session)}</span>
            {session.source === 'demo' && <b>数据为确定性样本 · 非实盘收益</b>}
          </div>
          <div className="today-sync-actions">
            <Link className="button secondary today-sync-button" to="/data">检查数据源</Link>
          </div>
        </div>

        <div className="today-command-grid">
          <section className="today-command-pane result-pane">
            {dayResult ? (
              <>
                <p className="today-pane-kicker">RESULT · {selectedDayKind}</p>
                <span className="today-day-label">{dayCaption(safeSelectedTimestamp)}</span>
                <strong className={`today-result-value mono ${dayResult.net >= 0 ? 'gain' : 'loss'}`}>
                  {fmtUsd(dayResult.net, true)}
                </strong>
                <p className="today-result-meta">
                  {selectedTrades.length} 笔 · {dayResult.wins} 胜 {dayResult.losses} 负 · 最好 {fmtUsd(dayResult.best, true)}
                </p>
              </>
            ) : (
              <>
                <p className="today-pane-kicker">DATA GATE · BROWSE ONLY</p>
                <span className="today-day-label">
                  {selectedDay ? `${selectedDayKind} · ${dayCaption(safeSelectedTimestamp)}` : '当前范围'}
                </span>
                <h2>当前不计算分析指标</h2>
                <p className="today-result-meta">
                  {session.source === 'imported'
                    ? '当前文件没有可靠的已实现盈亏字段，先保留逐笔事实和复盘记录。'
                    : `当前仅可核对 ${records.length} 条净化成交；完成对账后才会解锁分析。`}
                </p>
              </>
            )}
          </section>

          <section className="today-command-pane review-pane">
            <p className="today-pane-kicker">REVIEW DEBT · 待复盘</p>
            <div className="review-debt-count">
              <strong className="mono">{selectedPending}</strong>
              <span>{selectedTrades.length ? `笔待过卡 · ${selectedReviewed}/${selectedTrades.length} 已完成` : '当前日期没有闭环交易'}</span>
            </div>
            <Link className="button primary today-primary-cta" to={tradesHref(accountScope)}>
              {selectedPending ? '开始过卡' : selectedRecords.length ? '浏览净化记录' : '查看复盘记录'}
            </Link>
            <p className="today-result-meta">全部范围仍有 {pending.length} 笔待复盘 · 已完成 {allReviewed} 笔</p>
          </section>

          <section className="today-command-pane discipline-pane">
            <p className="today-pane-kicker">RISK & DISCIPLINE · 事实记录</p>
            <div className="today-fact-list">
              <div className="today-fact-row">
                <span className={`fact-dot ${analyticsReady ? 'positive' : 'warning'}`} aria-hidden="true" />
                <span>分析门禁</span>
                <strong>{analyticsReady ? '已解锁' : '待对账'}</strong>
              </div>
              <div className="today-fact-row">
                <span
                  className={`fact-dot ${selectedTrades.length && selectedReviewed === selectedTrades.length ? 'positive' : 'warning'}`}
                  aria-hidden="true"
                />
                <span>{selectedDayKind}复盘</span>
                <strong>{selectedReviewed} / {selectedTrades.length}</strong>
              </div>
              <div className="today-fact-row">
                <span className={`fact-dot ${activeGuards.length ? 'positive' : 'muted'}`} aria-hidden="true" />
                <span>启用的行动守则</span>
                <strong>{activeGuards.length} 条</strong>
              </div>
            </div>
            <div className="emotion-block">
              <div className="emotion-head">
                <span>情绪记录</span>
                <b>{emotion || '未记录'}</b>
              </div>
              <div className="emotion-track" aria-hidden="true" />
              <p className="emotion-copy">{emotionSource} · 不推断情绪分数或风险等级</p>
            </div>
          </section>
        </div>
      </section>

      <section
        className="today-trades-panel"
        aria-label={analyticsReady && selectedTrades.length ? `${selectedDayKind}交易` : '净化成交预览'}
      >
        <div className="today-trades-head">
          <div className="today-trades-title">
            <p className="eyebrow">TRADE QUEUE</p>
            <h2>{analyticsReady && selectedTrades.length
              ? `${selectedDayKind}的交易`
              : selectedTrades.length || selectedRecords.length
                ? '净化成交预览'
                : '当前交易队列'}</h2>
            <b className="today-trade-count">{selectedTrades.length || selectedRecords.length}</b>
          </div>
          <span>{selectedTrades.length || selectedRecords.length} 条 · 点击进入逐笔复盘</span>
        </div>

        {selectedTrades.length > 0 && (
          <div className="today-trade-table">
            <div
              className={`today-trade-row today-trade-head ${analyticsReady ? 'with-metrics' : 'browse'}`}
              aria-hidden="true"
            >
              <span>时间</span><span>品种</span><span>方向</span><span aria-hidden="true" /><span>过程 × 结果</span><span>分</span>
              {analyticsReady && <><span>R</span><span>净额</span></>}
              <span>复盘</span>
            </div>
            {selectedTrades.slice(0, 5).map((trade) => {
              const review = session.reviews[String(trade.id)];
              const process = trade.setup?.trim() || trade.tags?.[0] || '待归因';
              return (
                <Link
                  className={`today-trade-row ${analyticsReady ? 'with-metrics' : 'browse'}`}
                  key={String(trade.id)}
                  to={tradesHref(accountScope, String(trade.id))}
                  aria-label={`复盘 ${displaySymbol(trade.symbol, trade.market)} ${trade.side === 'LONG' ? '做多' : '做空'}`}
                >
                  <span className="mono" data-label="时间">{timeCaption(trade.exitTime)}</span>
                  <span className="today-trade-main" data-label="品种"><strong>{displaySymbol(trade.symbol, trade.market)}</strong></span>
                  <span data-label="方向"><b className={`today-side-chip ${trade.side === 'LONG' ? 'long' : 'short'}`}>{trade.side === 'LONG' ? '多' : '空'}</b></span>
                  <span className="today-trade-spacer" aria-hidden="true" />
                  <span className="today-process" data-label="过程 / 归因">{process}</span>
                  <span className="today-grade mono" data-label="分">{review?.reviewed ? review.grade : '—'}</span>
                  {analyticsReady && (
                    <>
                      <span className="mono" data-label="R">{trade.riskFallback ? '≈' : ''}{fmtNum(trade.rMultiple)}R</span>
                      <span className={`mono ${trade.pnl >= 0 ? 'gain' : 'loss'}`} data-label="净额">{fmtUsd(trade.pnl, true)}</span>
                    </>
                  )}
                  <span
                    className={`today-review-state ${review?.reviewed ? 'done' : 'pending'}`}
                    data-label="复盘"
                  >
                    {review?.reviewed ? '已复盘' : '待复盘'}
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        {selectedTrades.length === 0 && selectedRecords.length > 0 && (
          <div className="today-raw-list">
            <div className="today-raw-row today-raw-head" aria-hidden="true">
              <span>时间</span><span>品种</span><span>方向</span><span>持仓侧</span><span>状态</span>
            </div>
            {selectedRecords.slice(0, 5).map((record) => (
              <Link className="today-raw-row" key={String(record.id)} to="/trades">
                <span className="mono" data-label="时间">{timeCaption(record.time)}</span>
                <strong data-label="品种">{record.symbol}</strong>
                <span data-label="方向">{record.side}</span>
                <span data-label="持仓侧">{record.positionSide ?? 'BOTH'}</span>
                <span className="today-review-state pending" data-label="状态">只读记录</span>
              </Link>
            ))}
          </div>
        )}

        {selectedTrades.length === 0 && selectedRecords.length === 0 && (
          <div className="today-empty">
            <p>当前范围没有可浏览的成交或闭环交易。</p>
            <Link className="text-link" to="/data">前往数据中心 →</Link>
          </div>
        )}
      </section>

      <section className="two-column">
        <div className="panel focus-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">NEXT REVIEW</p><h2>下一笔该看什么</h2></div>
            <span>{pending.length} 待复盘</span>
          </div>
          {focus ? (
            <div className="focus-trade">
              <div>
                <strong>{displaySymbol(focus.symbol, focus.market)}</strong>
                <span>{focus.side === 'LONG' ? '做多' : '做空'} · {fmtDT(focus.exitTime)}</span>
              </div>
              {analyticsReady
                ? <b className={`mono ${focus.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtUsd(focus.pnl, true)}</b>
                : <b className="mono">结果待验证</b>}
              <p>先写下“当时看到了什么”，再判断结果。复盘的是决策，不是给盈亏找理由。</p>
              <Link className="button secondary" to="/trades">打开复盘台</Link>
            </div>
          ) : <p className="empty-copy">当前范围没有可复盘的闭环交易。</p>}
        </div>

        <div className="panel rules-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">ACTION LOOP</p><h2>下一笔之前</h2></div>
            <span>{actionPlans.filter((action) => action.status === 'open').length} 待执行</span>
          </div>
          {actionPlans.length ? (
            <ol className="rule-list action-list">
              {actionPlans.map((action, index) => (
                <li key={action.id} className={action.status === 'done' ? 'action-done' : ''}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <Link to="/experiments" aria-label={`打开行为实验：${action.text}`}>
                    <b>{action.experiment
                      ? action.experiment.decision === 'pending'
                        ? `取证 ${action.experiment.observedCount}/${action.experiment.targetCount}`
                        : action.experiment.decision === 'revise' ? '待重新设计' : '实验已闭环'
                      : action.status === 'open' ? '待设计实验' : '旧版状态'}</b>
                    {action.text}
                  </Link>
                </li>
              ))}
            </ol>
          ) : session.source === 'demo' ? (
            <ol className="rule-list">
              {DEFAULT_RULES.map((rule, index) => (
                <li key={rule}><span>{String(index + 1).padStart(2, '0')}</span>{rule}</li>
              ))}
            </ol>
          ) : (
            <p className="empty-copy">完成一笔复盘后，“下一次只改哪一件事”会自动进入这里。</p>
          )}
          <p className="panel-footnote">行动项来自你的复盘结论；系统不生成买卖、价格、仓位或杠杆指令。</p>
        </div>
      </section>
    </div>
  );
}
