// 速览(2.0 首屏):computeAll 真渲染 —— 与 1.x/report 同一个引擎、同一组合成 fixture 指标。
// 宪法⑦:数据不足显示 — + 原因,禁 0/NaN;宪法②:估算值明示。
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { computeAll, fmtUsd, fmtNum, fmtPct, fmtDur, displaySymbol } from '@rv/engine';
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
const pc = (v: number) => (v >= 0 ? 'var(--up)' : 'var(--down)');

export default function OverviewView() {
  const { session, warn, ackWarn, exportSession } = useStore();
  const trades = session.trades;
  const s = useMemo(() => (trades.length ? computeAll(trades, 0) : null), [trades]);

  if (!s) {
    return (
      <div className="empty">
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>还没有交易数据</div>
        <div className="sec-s">导入你的成交记录,60 秒看清赚过多少没拿住、扛单扛了多深。</div>
        <Link to="/import" className="btn" style={{ display: 'inline-flex', marginTop: 8 }}>去导入 →</Link>
      </div>
    );
  }

  const selfCalc = trades.some((t) => t.pnlSelfCalc);
  const worst = s.worstTrade;
  const mfeN = s.mfeRealN || 0;
  return (
    <div>
      {warn && (
        <div className="volwarn">
          <div>
            <b>你的数据只存在这台浏览器里</b> —— 清缓存 / 换设备就没了。这不是云端账户,是你自己的本地数据。
            <span className="sec-s" style={{ display: 'block', marginTop: 2 }}>现在花 3 秒把它存成一个 .fupan 文件放你硬盘上 —— 那是你唯一的备份,也是以后一拖就恢复的钥匙。</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn" onClick={() => { exportSession(); ackWarn(); }}>⤓ 存档</button>
            <button className="btn ghost" onClick={ackWarn}>知道了</button>
          </div>
        </div>
      )}
      <div className="sec-t" style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>总账 · {s.n} 笔已平仓</span>
        {!warn && <button className="btn ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={exportSession}>⤓ 存档 .fupan</button>}
      </div>
      <div className="sec-s">
        {session.meta ? `来源 ${session.meta.source} · 导入于 ${new Date(session.meta.importedAt).toLocaleString('zh-CN')}` : ''}
        {selfCalc ? ' · 部分盈亏为价差自算(近似,不含资金费)' : ''}
      </div>

      <div className="card"><div className="grid4">
        <KV k="净盈亏" v={fmtUsd(s.net, true)} c={pc(s.net)} />
        <KV k="胜率" v={fmtPct(s.winRate)} sub={`${s.wins} 胜 / ${s.losses} 负`} />
        <KV k="利润因子" v={s.pf === Infinity ? '∞' : fmtNum(s.pf)} c={s.pf >= 1 ? 'var(--up)' : 'var(--down)'} />
        <KV k="手续费拖累" v={fmtUsd(s.fees)} c="var(--amber)" sub={s.grossWin > 0 ? Math.round(s.feeDrag * 100) + '% 毛利' : undefined} />
      </div></div>

      <div className="card">
        <div className="sec-t">残酷四格 · 行为的代价</div>
        <div className="grid4">
          <KV k="最大单笔亏损" v={worst ? fmtUsd(worst.pnl) : '—'} c="var(--down)"
            sub={worst ? `${displaySymbol(worst.symbol, worst.market)} · 持仓 ${fmtDur((worst.exitTime - worst.entryTime) / 60000)}` : '无亏损样本'} />
          <KV k="最长连亏" v={s.maxLossStreak + ' 笔'} c={s.maxLossStreak >= 4 ? 'var(--down)' : 'var(--ink)'} />
          <KV k="报复单" v={s.revenge.length + ' 次'} c={s.revenge.length ? 'var(--down)' : 'var(--up)'} sub="大亏后 45 分钟内再开仓" />
          <KV k="日均交易" v={fmtNum(s.tradesPerDay, 1) + ' 笔'} c={s.tradesPerDay > 3 ? 'var(--amber)' : 'var(--ink)'} sub={s.activeDays + ' 个交易日'} />
        </div>
      </div>

      <div className="card">
        <div className="sec-t">执行真相 · 该止盈没走 × 该止损死扛</div>
        {mfeN > 0 ? (
          <div className="grid4">
            <KV k="桌上留的钱" v={fmtUsd(s.leftOnTable)} c="var(--amber)" sub={`峰值上限口径 · ${mfeN} 笔实测`} />
            <KV k="赢家抓取率" v={s.captureRate == null ? '—' : fmtPct(Math.min(1, Math.max(0, s.captureRate)))} sub="落袋 ÷ 峰值浮盈" />
            <KV k="盈利单先扛过单" v={String(s.winnersUnderwater)} c="var(--down)" />
            <KV k="单笔最深扛单" v={fmtUsd(s.deepestMae)} c="var(--down)" />
          </div>
        ) : (
          <div className="sec-s" style={{ marginBottom: 0 }}>
            此数据源暂无 1m K 线实测(MFE/MAE)—— CSV 导入后可在复盘卡逐笔拉取铁证;当前列出的其余指标不受影响。
          </div>
        )}
      </div>

      <div className="note">
        口径:仅计已平仓交易;盈亏为净额(已扣手续费);不含资金费/出入金(CSV 数据源不可观测)。
        本页只描述过去行为,不构成投资建议。
      </div>
    </div>
  );
}
