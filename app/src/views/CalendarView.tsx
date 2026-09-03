// 交易日历(MVP 第 2 批):日盈亏格子 + 月合计。默认锚定最近一笔交易所在月
// (锚「今天」会让老数据用户开局见一片空白——诚实空态 ≠ 无意义空态)。日界为北京时间(UTC+8),与 engine dateKey 同口径。
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { computeAll, calendarMonth, bj, fmtUsd, DOW_CN } from '@rv/engine';
import type { CalendarDayCell } from '@rv/engine';
import { useStore } from '../store';

export default function CalendarView() {
  const { session } = useStore();
  const trades = session.trades;
  const s = useMemo(() => (trades.length ? computeAll(trades, 0) : null), [trades]);
  const anchor = useMemo(() => {
    if (!trades.length) return null;
    const last = trades.reduce((a, b) => (b.exitTime > a.exitTime ? b : a));
    const b = bj(last.exitTime);
    return { y: b.y, mo: b.mo };
  }, [trades]);
  const [ym, setYm] = useState<{ y: number; mo: number } | null>(null);
  const cur = ym || anchor;

  if (!s || !cur) {
    return (
      <div className="empty">
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>还没有交易数据</div>
        <Link to="/import" className="btn" style={{ display: 'inline-flex', marginTop: 8 }}>去导入 →</Link>
      </div>
    );
  }
  const cells = calendarMonth(s.daily, null, cur.y, cur.mo);
  const monthDays = cells.filter((c): c is CalendarDayCell & { pnl: number } => !c.blank && c.pnl != null);
  const monthPnl = Math.round(monthDays.reduce((a, c) => a + c.pnl, 0) * 100) / 100;
  const maxAbs = Math.max(1, ...monthDays.map((c) => Math.abs(c.pnl)));
  const shift = (d: number) => {
    let y = cur.y, mo = cur.mo + d;
    if (mo < 1) { mo = 12; y--; } if (mo > 12) { mo = 1; y++; }
    setYm({ y, mo });
  };
  return (
    <div>
      <div className="sec-t" style={{ fontSize: 20 }}>交易日历 · 哪些日子在给账户放血</div>
      <div className="sec-s">日界为北京时间(UTC+8);格子颜色深浅 = 当日盈亏相对本月的大小</div>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn ghost chip" onClick={() => shift(-1)}>‹ 上月</button>
          <b className="mono" style={{ fontSize: 16 }}>{cur.y} 年 {cur.mo} 月</b>
          <button className="btn ghost chip" onClick={() => shift(1)}>下月 ›</button>
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 700, color: monthPnl >= 0 ? 'var(--up)' : 'var(--down)' }}>
            {monthDays.length ? `本月 ${fmtUsd(monthPnl, true)} · ${monthDays.length} 个交易日` : '本月无交易'}
          </span>
        </div>
        <div className="cal-grid">
          {DOW_CN.map((d) => <div key={'h' + d} className="cal-dow">{d}</div>)}
          {cells.map((c) => {
            if (c.blank) return <div key={c.key} />;
            const has = c.pnl != null;
            const pos = has && c.pnl >= 0;
            const alpha = has ? 0.12 + 0.5 * (Math.abs(c.pnl) / maxAbs) : 0;
            return (
              <div key={c.key} className="cal-cell" style={has ? { background: pos ? `rgba(63,180,131,${alpha})` : `rgba(242,112,138,${alpha})`, borderColor: pos ? 'rgba(63,180,131,.35)' : 'rgba(242,112,138,.35)' } : undefined}>
                <div className="cal-d mono">{c.d}</div>
                {has && <>
                  <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: pos ? 'var(--up)' : 'var(--down)' }}>{fmtUsd(c.pnl, true)}</div>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--sub)' }}>{c.count} 笔 · {c.wins} 胜</div>
                </>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="note">口径:按平仓时间归日;仅计已平仓交易,不含资金费/出入金(CSV 数据源不可观测)。</div>
    </div>
  );
}
