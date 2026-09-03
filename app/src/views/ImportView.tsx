// 导入中心(2.0 正门):拖/选/粘 CSV → parseStatement 嗅探 → 认不出走手动对列 → 能力报告卡 → 进入复盘。
// 单一实现:解析/配对全在 @rv/engine(与 1.x/报告页同一份代码);数据不出浏览器。
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseStatement, enrichTrades, SOURCE_CAPS } from '@rv/engine';
import type { StatementColumnMap, StatementField } from '@rv/engine';
import { useStore } from '../store';
import { csvLedgerImportErrorMessage, importFileSizeError } from '../lib/import-file-limits';

const FIELDS: [StatementField, string][] = [
  ['tradeId', '成交 ID（推荐）'], ['orderId', '订单 ID（可选）'],
  ['time', '时间 *'], ['symbol', '品种/交易对 *'], ['side', '方向(买/卖)*'],
  ['positionSide', '持仓方向（双向仓可选）'], ['price', '价格 *'], ['qty', '数量 *'],
  ['fee', '手续费(可无)'], ['feeAsset', '手续费币种（可选）'], ['pnl', '已实现盈亏(可无)'],
];

export default function ImportView() {
  const nav = useNavigate();
  const { session, setImported, restoreSessionArchive, clear } = useStore();
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState('');
  const [header, setHeader] = useState<string[] | null>(null);
  const [drag, setDrag] = useState(false);
  const mapRef = useRef<StatementColumnMap>({});

  function readFile(f: File) {
    const sizeError = importFileSizeError(f);
    if (sizeError) {
      setHeader(null);
      setErr(sizeError);
      return;
    }
    const r = new FileReader();
    const isArchive = /\.fupan$/i.test(f.name);
    r.onload = () => {
      const t = String(r.result || '');
      if (isArchive) { void loadArchive(t); return; }   // .fupan 走存档导入(无损恢复,不重新配对)
      setRaw(t); void run(t, null);
    };
    r.readAsText(f, 'utf-8');
  }
  // .fupan 存档:engine importArchive 校验+取白名单字段 → enrichTrades → 进 state。与 CSV 不同,它是「恢复」不是「解析」。
  async function loadArchive(text: string) {
    setErr(''); setHeader(null);
    try {
      if (await restoreSessionArchive(text)) nav('/');
      else setErr('存档导入失败：文件无效或云仓未确认保存');
    } catch (error) {
      setErr(csvLedgerImportErrorMessage(error));
    }
  }
  async function run(text: string, manualMap: StatementColumnMap | null) {
    setErr(''); setHeader(null);
    const out = parseStatement(text, manualMap);
    if (out.error === 'unrecognized') {
      setHeader(out.header ?? []);
      setErr(`没认出表头(${out.rowCount ?? 0} 行数据)—— 手动对一下列,30 秒。`);
      return;
    }
    if (out.error !== undefined || !out.fills.length) {
      setErr(out.error || '没有解析出任何逐笔成交');
      return;
    }
    const trades = enrichTrades(out.trades);
    try {
      if (await setImported(
        trades,
        out.meta,
        { contract: out.contract, diagnostics: out.diagnostics },
        out.fills,
      )) nav('/');
    } catch (error) {
      setErr(csvLedgerImportErrorMessage(error));
    }
  }
  function confirmMap() {
    const m = mapRef.current;
    const required: StatementField[] = ['time', 'symbol', 'side', 'price', 'qty'];
    const missing = required.filter((k) => (m[k] ?? -1) < 0);
    if (missing.length) { setErr('必填列未选:' + missing.join(', ')); return; }
    void run(raw, m);
  }

  const caps = SOURCE_CAPS['csv-report'];
  return (
    <div>
      <div className="sec-t" style={{ fontSize: 22 }}>把你的成交记录拖进来,60 秒开始复盘</div>
      <div className="sec-s">支持币安合约导出(中/英)· 其它交易所/软件的 CSV 手动对列即可 · 完全免费</div>
      <div className="privacy">🔒 数据不离开这台设备 —— 解析和全部分析都在你自己的浏览器里完成</div>
      <div className="note">请在一个工作区只放同一 Binance 合约账户的数据；普通 CSV 通常没有可验证账户 UID，系统无法自动证明文件同源。没有成交 ID 的重叠批次会整批拒绝。</div>

      <div className={'drop' + (drag ? ' on' : '')}
        onClick={() => document.getElementById('rv2file')?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}>
        <div style={{ fontSize: 15 }}><b>拖入 / 点击选择</b> 成交记录 CSV,或之前存的 <b>.fupan</b> 存档</div>
        <div className="sec-s" style={{ marginTop: 5, marginBottom: 0 }}>币安:合约 → 订单中心 → 成交历史 → 导出 · .fupan 恢复交易与成交账本；复盘、行动、日志和守则请使用“完整备份”恢复</div>
        <input id="rv2file" type="file" accept=".csv,.txt,.tsv,.fupan" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
      </div>
      <textarea placeholder="…或者把表格内容(含表头)粘贴到这里" value={raw.length > 20000 ? '(已读入 ' + Math.round(raw.length / 1024) + ' KB)' : raw}
        onChange={(e) => setRaw(e.target.value)} style={{ marginTop: 12 }} />
      <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
        <button className="btn" onClick={() => void run(raw, null)} disabled={raw.length < 10}>解析导入</button>
        {(session.trades.length > 0 || session.csvLedger) && <button className="btn ghost" onClick={clear}>清空当前账本重新导入</button>}
      </div>

      {err && <div className="err">{err}</div>}

      {header && (
        <div className="card">
          <div className="sec-t">手动对列</div>
          <div className="sec-s">告诉我每个字段对应哪一列;映射只在本页内存,不上传</div>
          <div className="map-grid">
            {FIELDS.map(([k, label]) => (
              <label key={k} style={{ fontSize: 12, color: 'var(--sub)' }}>{label}
                <select defaultValue={-1} onChange={(e) => { mapRef.current[k] = +e.target.value; }} style={{ marginTop: 4 }}>
                  <option value={-1}>— 无 —</option>
                  {header.map((h, i) => <option key={i} value={i}>{h || '列' + (i + 1)}</option>)}
                </select>
              </label>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 12 }} onClick={confirmMap}>按此映射解析导入</button>
        </div>
      )}

      <div className="card">
        <div className="sec-t">导入后解锁什么(CSV 数据源能力)</div>
        <div className="sec-s">不同数据源解锁的分析不同 —— 我们按证据说话,缺证据的分析会标「不可观测」,不冒充</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className={'badge ' + (caps.fills ? 'ok' : 'na')}>逐笔成交 {caps.fills ? '✓' : '✗'}</span>
          <span className="badge na">已实现盈亏 · 按导入文件逐次判定</span>
          <span className="badge na">订单流 ✗ → 止损纪律不可观测</span>
          <span className="badge na">出入金流水 ✗ → 真实权益不可用</span>
          <span className="badge ok">1m K线铁证 ✓(加密永续,联网拉取)</span>
        </div>
        <div className="note">想要全量解锁(止损证据/真实权益/资金费归因)?本机引擎 + 币安只读 API 是 L3 全家桶 —— key 只存你自己电脑。</div>
      </div>
    </div>
  );
}
