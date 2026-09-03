// R 复盘(MVP 第 2 批):R 是唯一跨市场语言(宪法⑤)——$ 不跨币种加总,R 可以。
// 宪法②:CSV 无计划止损 → 1R 全部为中位亏损估算,页顶黄条明示口径,所有 R 数字带 ≈。
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { computeAll, fmtNum, fmtPct } from '@rv/engine';
import type { ComputedStats } from '@rv/engine';
import { useStore } from '../store';

function KV({ k, v, c, sub }: { k: string; v: string; c?: string; sub?: string }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v mono" style={{ color: c || 'var(--ink)' }}>{v}</div>
      {sub && <div className="note" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// R 分布直方图:纯 CSS 条,桶来自 engine rDist([-4,4) 八桶)+ 两端溢出桶
function RHist({ s, approx }: { s: ComputedStats; approx: string }) {
  const buckets = [
    { label: `<-4`, count: s.rBelow, neg: true },
    ...s.rDist.map((b) => ({ label: `${b.lo}~${b.hi}`, count: b.count, neg: b.hi <= 0 })),
    { label: `≥4`, count: s.rAbove, neg: false },
  ];
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="rhist">
      {buckets.map((b) => (
        <div key={b.label} className="rcol">
          <div className="mono" style={{ fontSize: 11, color: 'var(--sub)' }}>{b.count || ''}</div>
          <div className="rbar" style={{ height: Math.round((b.count / max) * 90) + 2, background: b.neg ? 'var(--down)' : 'var(--up)', opacity: b.count ? 0.9 : 0.15 }} />
          <div className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>{approx}{b.label}</div>
        </div>
      ))}
    </div>
  );
}

// 累计 R 曲线:纯 SVG polyline,零依赖
function RCurve({ s }: { s: ComputedStats }) {
  const pts = s.rEquity;
  if (pts.length < 2) return null;
  const W = 720, H = 140, P = 6;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const x = (i: number) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const y = (v: number) => hi === lo ? H / 2 : P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1].v;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeDasharray="4 4" />
      <polyline points={line} fill="none" stroke={last >= 0 ? 'var(--up)' : 'var(--down)'} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function RView() {
  const { session } = useStore();
  const trades = session.trades;
  const s = useMemo(() => (trades.length ? computeAll(trades, 0) : null), [trades]);

  if (!s) {
    return (
      <div className="empty">
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>还没有交易数据</div>
        <Link to="/import" className="btn" style={{ display: 'inline-flex', marginTop: 8 }}>去导入 →</Link>
      </div>
    );
  }
  const approx = s.rEstimatedN > 0 ? '≈' : '';
  return (
    <div>
      <div className="sec-t" style={{ fontSize: 20 }}>R 复盘 · 用风险单位看清系统</div>
      <div className="sec-s">1 单位 R = 你一笔交易计划亏多少;赚 2R 亏 1R 的系统,胜率 40% 也是印钞机</div>
      {s.rEstimatedN > 0 && (
        <div className="approx-bar">
          ≈ 口径:{s.rEstimatedN}/{s.n} 笔无计划止损记录,1R 以「同市场中位亏损」估算 ——
          反映的是你实际亏损的典型尺寸,不是事前风险预算。接入带订单流的数据源后自动换真实 R。
        </div>
      )}
      <div className="card"><div className="grid4">
        <KV k="累计 R" v={approx + fmtNum(s.totalR) + 'R'} c={s.totalR >= 0 ? 'var(--up)' : 'var(--down)'} />
        <KV k="期望值 / 笔" v={approx + fmtNum(s.expectancyR) + 'R'} c={s.expectancyR >= 0 ? 'var(--up)' : 'var(--down)'} sub="正期望才值得重复" />
        <KV k="平均盈单 / 亏单" v={`${approx}${fmtNum(s.avgWinR)}R / ${fmtNum(s.avgLossR)}R`} sub={s.payoffR != null ? `盈亏比 ${fmtNum(s.payoffR)}` : undefined} />
        <KV k="R 胜率" v={fmtPct(s.rWinShare)} sub={`最好 ${approx}${fmtNum(s.bestR)}R · 最差 ${approx}${fmtNum(s.worstR)}R`} />
      </div></div>

      <div className="card">
        <div className="sec-t">R 分布 · 你的亏损尾巴有多长</div>
        <div className="sec-s">健康系统:亏损全挤在 -1R 附近(止损在工作),盈利有右尾;左尾越长 = 止损越失守</div>
        <RHist s={s} approx={approx} />
      </div>

      <div className="card">
        <div className="sec-t">累计 R 曲线</div>
        <div className="sec-s">按平仓时间累积;虚线为 0R —— 曲线在虚线下方的时间,就是系统为负的时间</div>
        <RCurve s={s} />
      </div>

      <div className="note">
        口径:R = 单笔盈亏 ÷ 该笔风险;{s.rEstimatedN > 0 ? '本页全部 R 值为估算(见页顶);' : ''}
        仅计已平仓交易。本页只描述过去行为,不构成投资建议。
      </div>
    </div>
  );
}
