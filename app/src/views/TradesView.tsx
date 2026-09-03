import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  displaySymbol,
  fmtDT,
  fmtDur,
  fmtNum,
  fmtUsd,
} from '@rv/engine';
import type { EnrichedTrade } from '@rv/engine';
import TrustBanner from '../components/TrustBanner';
import { useStore } from '../store';
import {
  MAX_REVIEW_FIELD_LENGTH,
  type ReviewDraft,
  type ReviewGrade,
} from '../lib/review-storage';

type Filter = 'all' | 'pending' | 'win' | 'loss';
type AccountScope = 'all' | 'main' | 'training';

function parseAccountScope(value: string | null): AccountScope {
  return value === 'main' || value === 'training' ? value : 'all';
}

function accountScopeLabel(scope: AccountScope): string {
  return scope === 'main' ? '主账户' : scope === 'training' ? '训练账户' : '全部账户';
}

function CleanRecordTable({ accountScope }: Readonly<{ accountScope: AccountScope }>) {
  const { session, analyticsReady } = useStore();
  const records = accountScope === 'all' ? session.records : [];
  return (
    <section className="panel record-panel">
      <div className="section-heading compact">
        <div><p className="eyebrow">SANITIZED FILLS</p><h2>净化成交记录</h2></div>
        <span>{records.length} 条</span>
      </div>
      <div className="record-scroll">
        <table>
          <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>价格</th><th>数量</th><th>手续费</th>{analyticsReady && <th>已实现 PnL</th>}</tr></thead>
          <tbody>
            {records.map((record) => (
              <tr key={String(record.id)}>
                <td className="mono">{fmtDT(record.time)}</td>
                <td><strong>{record.symbol}</strong><small>{record.positionSide ?? 'BOTH'}</small></td>
                <td>{record.side}</td>
                <td className="mono">{String(record.price)}</td>
                <td className="mono">{String(record.qty)}</td>
                <td className="mono">{String(record.commission)}</td>
                {analyticsReady && <td className="mono">{String(record.realizedPnl)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!records.length && <p className="empty-copy">当前没有可浏览的净化成交记录。</p>}
      {accountScope !== 'all' && session.records.length > 0 && (
        <p className="data-boundary-note" role="status">当前净化记录没有可验证的账户归属，仅能在“全部账户”范围浏览。</p>
      )}
      <p className="panel-footnote">这里是逐条观测记录，不是账户总账，也不会在对账前生成胜率、净收益或权益曲线。</p>
    </section>
  );
}

function ReviewEditor({ trade, onNext, analyticsReady }: { trade: EnrichedTrade; onNext: () => void; analyticsReady: boolean }) {
  const { session, saveTradeReview } = useStore();
  const saved = session.reviews[String(trade.id)];
  const [draft, setDraft] = useState<ReviewDraft>({
    saw: '', happened: '', lesson: '', grade: 'C', reviewed: false,
  });
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(saved
      ? {
          saw: saved.saw,
          happened: saved.happened,
          lesson: saved.lesson,
          grade: saved.grade,
          reviewed: saved.reviewed,
        }
      : { saw: '', happened: '', lesson: '', grade: 'C', reviewed: false });
    setNotice('');
  }, [saved, trade.id]);

  function update(field: keyof ReviewDraft, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveAndNext() {
    if (saving) return;
    setSaving(true);
    const complete = { ...draft, reviewed: true };
    try {
      const persisted = await saveTradeReview(String(trade.id), complete);
      setNotice(persisted ? '已保存到当前数据作用域' : '保存失败；草稿仍保留，请重试');
      if (persisted) onNext();
    } catch {
      setNotice('保存失败；草稿仍保留，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="review-editor">
      <div className="review-trade-head">
        <div><p className="eyebrow">DECISION REVIEW</p><h2>{displaySymbol(trade.symbol, trade.market)} · {trade.side === 'LONG' ? '做多' : '做空'}</h2></div>
        {analyticsReady
          ? <b className={`mono ${trade.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtUsd(trade.pnl, true)}</b>
          : <b className="mono">结果待验证</b>}
      </div>
      <div className="trade-facts">
        <span><small>进场</small>{fmtDT(trade.entryTime)}</span>
        <span><small>持仓</small>{fmtDur((trade.exitTime - trade.entryTime) / 60000)}</span>
        {analyticsReady && <span><small>R</small>{trade.riskFallback ? '≈' : ''}{fmtNum(trade.rMultiple)}R</span>}
      </div>
      <label>当时看到了什么？<textarea maxLength={MAX_REVIEW_FIELD_LENGTH} value={draft.saw} onChange={(event) => update('saw', event.target.value)} placeholder="只写可观察事实：结构、位置、信号…" /><small>{draft.saw.length}/{MAX_REVIEW_FIELD_LENGTH}</small></label>
      <label>实际发生了什么？<textarea maxLength={MAX_REVIEW_FIELD_LENGTH} value={draft.happened} onChange={(event) => update('happened', event.target.value)} placeholder="进场、加仓、止损、退出分别发生了什么…" /><small>{draft.happened.length}/{MAX_REVIEW_FIELD_LENGTH}</small></label>
      <label>下一次只改哪一件事？<textarea maxLength={MAX_REVIEW_FIELD_LENGTH} value={draft.lesson} onChange={(event) => update('lesson', event.target.value)} placeholder="写成可以执行的一句话…" /><small>{draft.lesson.length}/{MAX_REVIEW_FIELD_LENGTH}</small></label>
      <fieldset>
        <legend>执行评分</legend>
        <div className="grade-row">
          {(['A', 'B', 'C', 'D'] as ReviewGrade[]).map((grade) => (
            <button key={grade} type="button" className={draft.grade === grade ? 'active' : ''} onClick={() => update('grade', grade)}>{grade}</button>
          ))}
        </div>
      </fieldset>
      <button className="button primary wide" type="button" onClick={saveAndNext} disabled={saving || !draft.saw.trim() || !draft.happened.trim() || !draft.lesson.trim()}>{saving ? '正在保存…' : '保存并下一笔'}</button>
      {notice && <p className="save-notice" role="status">{notice}</p>}
    </aside>
  );
}

export default function TradesView() {
  const { session, analyticsReady } = useStore();
  const [searchParams] = useSearchParams();
  const accountScope = parseAccountScope(searchParams.get('account'));
  const scopedTrades = useMemo(
    () => session.trades.filter((trade) => accountScope === 'all' || trade.account === accountScope),
    [accountScope, session.trades],
  );
  const requestedTradeId = searchParams.get('tradeId');
  const requestedTrade = requestedTradeId
    ? scopedTrades.find((trade) => String(trade.id) === requestedTradeId)
    : undefined;
  const [filter, setFilter] = useState<Filter>(requestedTrade ? 'all' : 'pending');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(
    requestedTrade ? String(requestedTrade.id) : null,
  );

  const rows = useMemo(() => {
    const normalized = query.trim().toUpperCase();
    return [...scopedTrades]
      .sort((left, right) => right.exitTime - left.exitTime)
      .filter((trade) => {
        if (filter === 'pending' && session.reviews[String(trade.id)]?.reviewed) return false;
        if (analyticsReady && filter === 'win' && trade.pnl <= 0) return false;
        if (analyticsReady && filter === 'loss' && trade.pnl >= 0) return false;
        return !normalized || trade.symbol.includes(normalized);
      });
  }, [analyticsReady, filter, query, scopedTrades, session.reviews]);

  useEffect(() => {
    if (!analyticsReady && (filter === 'win' || filter === 'loss')) setFilter('all');
  }, [analyticsReady, filter]);

  useEffect(() => {
    if (!requestedTrade) return;
    setFilter('all');
    setQuery('');
    setSelected(String(requestedTrade.id));
  }, [requestedTrade, requestedTradeId]);

  useEffect(() => {
    if (!rows.some((trade) => String(trade.id) === selected)) {
      setSelected(rows[0] ? String(rows[0].id) : null);
    }
  }, [rows, selected]);

  if (session.source === 'binance' && session.phase !== 'BINANCE_OBSERVED_READY') {
    return <div className="page-stack"><TrustBanner /><CleanRecordTable accountScope={accountScope} /></div>;
  }

  const current = rows.find((trade) => String(trade.id) === selected) ?? rows[0] ?? null;
  const next = () => {
    if (!current) return;
    const index = rows.findIndex((trade) => trade.id === current.id);
    const candidate = rows[index + 1] ?? rows[0];
    setSelected(candidate ? String(candidate.id) : null);
  };

  return (
    <div className="page-stack">
      <TrustBanner />
      <header className="page-heading">
        <div><p className="eyebrow">TRADE REVIEW QUEUE</p><h1>逐笔看决策，不给结果找借口。</h1></div>
        <p>{accountScopeLabel(accountScope)} · {scopedTrades.filter((trade) => session.reviews[String(trade.id)]?.reviewed).length} 笔已复盘 · {scopedTrades.length} 笔当前范围</p>
      </header>
      <div className="review-layout">
        <section className="trade-queue">
          <div className="queue-tools">
            <div className="filter-row">
              {(['pending', 'all', ...(analyticsReady ? ['win', 'loss'] : [])] as Filter[]).map((value) => (
                <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
                  {value === 'pending' ? '待复盘' : value === 'all' ? '全部' : value === 'win' ? '盈利' : '亏损'}
                </button>
              ))}
            </div>
            <input aria-label="搜索交易对" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="BTCUSDT" />
          </div>
          <div className="trade-list">
            {rows.map((trade) => {
              const id = String(trade.id);
              const done = session.reviews[id]?.reviewed;
              return (
                <button type="button" key={id} className={`trade-list-row ${selected === id ? 'selected' : ''}`} onClick={() => setSelected(id)}>
                  <span className="review-state">{done ? '✓' : '·'}</span>
                  <span><strong>{displaySymbol(trade.symbol, trade.market)}</strong><small>{fmtDT(trade.exitTime)} · {trade.side === 'LONG' ? '多' : '空'}</small></span>
                  {analyticsReady
                    ? <b className={`mono ${trade.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtUsd(trade.pnl, true)}</b>
                    : <b className="mono">待验证</b>}
                </button>
              );
            })}
            {!rows.length && <p className="empty-copy">当前筛选下没有交易。</p>}
          </div>
        </section>
        {current ? <ReviewEditor trade={current} onNext={next} analyticsReady={analyticsReady} /> : <aside className="review-editor"><p className="empty-copy">选择一笔交易开始复盘。</p></aside>}
      </div>
    </div>
  );
}
