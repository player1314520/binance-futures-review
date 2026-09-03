import React, { useMemo } from 'react';
import { computeAll, displaySymbol, fmtNum, fmtPct, fmtUsd } from '@rv/engine';
import { START_EQUITY } from '@rv/engine/demo-data';
import AnalyticsLock from '../components/AnalyticsLock';
import MetricCard from '../components/MetricCard';
import TrustBanner from '../components/TrustBanner';
import { useStore } from '../store';

function EquityCurve({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const width = 760;
  const height = 210;
  const pad = 10;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(1, high - low);
  const points = values.map((value, index) => {
    const x = pad + index / (values.length - 1) * (width - pad * 2);
    const y = height - pad - (value - low) / range * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="equity-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="当前范围累计净结果曲线">
      <defs>
        <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity=".32" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M ${points} L ${width - pad},${height - pad} L ${pad},${height - pad} Z`} fill="url(#equity-fill)" />
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function AnalyticsView() {
  const { session, analyticsReady } = useStore();
  const stats = useMemo(() => (
    analyticsReady && session.trades.length
      ? computeAll(session.trades, session.source === 'demo' ? START_EQUITY : 0)
      : null
  ), [analyticsReady, session.source, session.trades]);
  const curve = useMemo(() => {
    if (!analyticsReady) return [];
    let cumulative = 0;
    return [0, ...[...session.trades]
      .sort((left, right) => left.exitTime - right.exitTime)
      .map((trade) => (cumulative += trade.pnl))];
  }, [analyticsReady, session.trades]);
  const symbols = useMemo(() => {
    if (!analyticsReady) return [];
    const map = new Map<string, { pnl: number; wins: number; n: number }>();
    for (const trade of session.trades) {
      const row = map.get(trade.symbol) ?? { pnl: 0, wins: 0, n: 0 };
      row.pnl += trade.pnl;
      row.wins += trade.pnl > 0 ? 1 : 0;
      row.n += 1;
      map.set(trade.symbol, row);
    }
    return [...map.entries()].sort((left, right) => right[1].pnl - left[1].pnl);
  }, [analyticsReady, session.trades]);

  if (!stats) {
    return <div className="page-stack"><TrustBanner /><AnalyticsLock /></div>;
  }

  return (
    <div className="page-stack">
      <TrustBanner />
      <header className="page-heading">
        <div><p className="eyebrow">ANALYTICS · OBSERVED ONLY</p><h1>分析不是奖励，是证据门后的结果。</h1></div>
        <p>{session.source === 'binance' ? '当前仅展示已对账窗口的观测成交分析，不等于账户总账。' : '当前为样本范围分析，不外推到完整账户。'}</p>
      </header>

      <div className="metric-grid">
        <MetricCard label="当前范围净结果" value={fmtUsd(stats.net, true)} tone={stats.net >= 0 ? 'positive' : 'negative'} />
        <MetricCard label="每笔期望 R" value={`${stats.rEstimatedN ? '≈' : ''}${fmtNum(stats.expectancyR)}R`} tone={stats.expectancyR >= 0 ? 'positive' : 'negative'} />
        <MetricCard label="胜率" value={fmtPct(stats.winRate)} note={`${stats.n} 笔闭环交易`} />
        <MetricCard label="手续费" value={fmtUsd(stats.fees)} tone="warning" note="不含不可观测费用" />
      </div>

      <section className="analytics-grid">
        <div className="panel chart-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">CUMULATIVE RESULT</p><h2>累计净结果</h2></div>
            <span>{curve.length - 1} 个闭环</span>
          </div>
          <EquityCurve values={curve} />
          <div className="chart-axis"><span>{fmtUsd(Math.min(...curve), true)}</span><span>{fmtUsd(Math.max(...curve), true)}</span></div>
        </div>

        <div className="panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">RISK BEHAVIOR</p><h2>执行代价</h2></div>
          </div>
          <dl className="diagnostic-list">
            <div><dt>最大单笔亏损</dt><dd className="mono loss">{stats.worstTrade ? fmtUsd(stats.worstTrade.pnl) : '—'}</dd></div>
            <div><dt>报复交易信号</dt><dd className="mono">{stats.revenge.length} 次</dd></div>
            <div><dt>日均交易</dt><dd className="mono">{fmtNum(stats.tradesPerDay, 1)} 笔</dd></div>
            <div><dt>R 左尾</dt><dd className="mono">{stats.rBelow} 笔 &lt; -4R</dd></div>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading compact">
          <div><p className="eyebrow">SYMBOL BREAKDOWN</p><h2>品种贡献</h2></div>
          <span>按当前范围</span>
        </div>
        <div className="symbol-table" role="table" aria-label="品种表现">
          {symbols.map(([symbol, row]) => (
            <div className="symbol-row" role="row" key={symbol}>
              <strong role="cell">{displaySymbol(symbol, 'crypto_perp')}</strong>
              <span role="cell">{row.n} 笔</span>
              <span role="cell">胜率 {fmtPct(row.wins / row.n)}</span>
              <b role="cell" className={`mono ${row.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtUsd(row.pnl, true)}</b>
            </div>
          ))}
        </div>
      </section>

      <p className="honest-note">本页只描述过去的观测行为，不提供开仓方向、仓位或收益承诺。</p>
    </div>
  );
}
