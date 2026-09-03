import React, { useEffect, useMemo, useRef, useState } from 'react';
import { serializeClassicReviewExport } from '../../../shared/legacy-review-export.js';
import {
  bindLegacyReviewMigrationPlan,
  LEGACY_REVIEW_MIGRATION_LIMITS,
  parseLegacyReviewExport,
  type LegacyReviewMigrationPlan,
  type LegacyReviewMigrationReceipt,
} from '../lib/legacy-review-migration';
import type { ReviewMap } from '../lib/review-storage';

type MigrationTrade = Readonly<{
  id: string;
  symbol: string;
  entryTime: number;
}>;

export type LegacyMigrationContext = Readonly<{
  source: 'demo' | 'imported' | 'binance';
  reviewScope: string | null;
  trades: readonly MigrationTrade[];
  reviews: ReviewMap;
}>;

type Props = Readonly<{
  context: LegacyMigrationContext;
  onApply: (
    plan: LegacyReviewMigrationPlan,
    selectedTradeIds: readonly string[],
  ) => Promise<LegacyReviewMigrationReceipt | null>;
}>;

function sameContext(
  left: Readonly<{ source: LegacyMigrationContext['source']; reviewScope: string | null; currentTradeIds: readonly string[] }>,
  right: Readonly<{ source: LegacyMigrationContext['source']; reviewScope: string | null; currentTradeIds: readonly string[] }>,
): boolean {
  return left.source === right.source
    && left.reviewScope === right.reviewScope
    && left.currentTradeIds.length === right.currentTradeIds.length
    && left.currentTradeIds.every((id, index) => id === right.currentTradeIds[index]);
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('FILE_READ_FAILED'));
    reader.readAsText(file, 'utf-8');
  });
}

function errorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : error instanceof Error ? error.message : '';
  if (code === 'RESOURCE_LIMIT') return '旧版导出超过资源上限，未读取也未写入任何数据。';
  if (code === 'CRYPTO_UNAVAILABLE') return '当前浏览器缺少安全摘要能力，不能验证迁移绑定。';
  return '旧版导出格式无效或内容不完整；当前数据未改变。';
}

export default function LegacyMigrationPanel({ context, onApply }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef(0);
  const latestContextRef = useRef({
    source: context.source,
    reviewScope: context.reviewScope,
    currentTradeIds: context.trades.map((trade) => trade.id),
  });
  latestContextRef.current = {
    source: context.source,
    reviewScope: context.reviewScope,
    currentTradeIds: context.trades.map((trade) => trade.id),
  };
  const [plan, setPlan] = useState<LegacyReviewMigrationPlan | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<LegacyReviewMigrationReceipt | null>(null);

  useEffect(() => {
    operationRef.current += 1;
    setPlan(null);
    setSelected(new Set());
    setConfirmed(false);
    setReceipt(null);
    setError('');
  }, [context.source, context.reviewScope, context.trades]);

  useEffect(() => () => {
    operationRef.current += 1;
  }, []);

  const tradeById = useMemo(() => new Map(
    context.trades.map((trade) => [trade.id, trade]),
  ), [context.trades]);

  const eligibleIds = useMemo(() => plan?.candidates
    .map((candidate) => candidate.tradeId)
    .filter((tradeId) => !Object.hasOwn(context.reviews, tradeId)) ?? [], [context.reviews, plan]);

  async function prepare(serialized: string) {
    const epoch = operationRef.current + 1;
    operationRef.current = epoch;
    setBusy(true);
    setError('');
    setReceipt(null);
    setPlan(null);
    setSelected(new Set());
    setConfirmed(false);
    const captured = latestContextRef.current;
    if (
      captured.source === 'demo'
      || !captured.reviewScope
      || captured.currentTradeIds.length === 0
    ) {
      setBusy(false);
      setError('请先导入或连接当前 Binance 合约数据，再绑定旧版复盘。');
      return;
    }
    try {
      const parsed = await parseLegacyReviewExport(serialized);
      const bound = await bindLegacyReviewMigrationPlan(parsed, {
        reviewScope: captured.reviewScope,
        currentTradeIds: captured.currentTradeIds,
      });
      if (operationRef.current !== epoch || !sameContext(captured, latestContextRef.current)) return;
      setPlan(bound);
    } catch (caught) {
      if (operationRef.current === epoch) setError(errorMessage(caught));
    } finally {
      if (operationRef.current === epoch) setBusy(false);
    }
  }

  async function detectCurrentOrigin() {
    try {
      if (localStorage.getItem('rv-reviews') === null && localStorage.getItem('rv-guards') === null) {
        operationRef.current += 1;
        setPlan(null);
        setSelected(new Set());
        setConfirmed(false);
        setReceipt(null);
        setBusy(false);
        setError('当前站点来源未发现 Classic 复盘；若旧版在其他域名或端口，请从旧版导出 JSON 后在此选择。');
        return;
      }
      await prepare(serializeClassicReviewExport(localStorage));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function chooseFile(file: File) {
    const epoch = operationRef.current + 1;
    operationRef.current = epoch;
    setError('');
    if (file.size > LEGACY_REVIEW_MIGRATION_LIMITS.serializedBytes) {
      setError('旧版导出超过资源上限，未读取也未写入任何数据。');
      return;
    }
    try {
      const text = await readFile(file);
      if (operationRef.current !== epoch) return;
      // prepare owns the next epoch and the cryptographic binding checks.
      await prepare(text);
    } catch {
      if (operationRef.current === epoch) setError('旧版导出文件读取失败；当前数据未改变。');
    }
  }

  function toggle(tradeId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(tradeId);
      else next.delete(tradeId);
      return next;
    });
    setReceipt(null);
  }

  async function apply() {
    if (!plan || !confirmed || selected.size === 0) return;
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const result = await onApply(plan, [...selected].sort());
      if (!result) {
        setError('迁移已取消：工作区、成交集合或存储状态已变化；没有写入旧版复盘。');
        return;
      }
      setReceipt(result);
      setSelected(new Set());
      setConfirmed(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="legacy-migration" aria-label="Classic 复盘迁移">
      <div className="section-heading compact">
        <div><p className="eyebrow">CLASSIC MIGRATION</p><h2>找回旧版复盘，不猜交易归属</h2></div>
        <span>只按完全相同成交 ID</span>
      </div>
      <p>先检测当前站点来源；若旧版位于其他域名或端口，选择其只读导出文件。系统不会读取 API 凭据，不会删除旧数据，也不会覆盖已有复盘。</p>
      <div className="button-row">
        <button className="button secondary" type="button" onClick={() => void detectCurrentOrigin()} disabled={busy}>检测当前站点旧版数据</button>
        <button className="button secondary" type="button" onClick={() => fileRef.current?.click()} disabled={busy}>选择 Classic 导出 JSON</button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.rvlegacy.json"
        aria-label="选择 Classic 复盘导出文件"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.currentTarget.value = '';
          if (file) void chooseFile(file);
        }}
      />
      {busy && <p role="status">正在校验并绑定当前成交集合…</p>}
      {plan && (
        <div className="legacy-migration-plan">
          <dl className="runtime-facts">
            <div><dt>可精确匹配</dt><dd>{plan.candidates.length}</dd></div>
            <div><dt>无法匹配</dt><dd>{plan.unmatchedCount}</dd></div>
            <div><dt>字段不完整</dt><dd>{plan.invalidCount}</dd></div>
            <div><dt>待选择写入</dt><dd>{eligibleIds.length}</dd></div>
          </dl>
          {plan.riskLimits.values && (
            <p className="migration-warning">旧版风险参数仅供核对，不自动转换：maxLoss {plan.riskLimits.values.maxLoss}；maxTrades {plan.riskLimits.values.maxTrades}；maxRiskR {plan.riskLimits.values.maxRiskR}。</p>
          )}
          {plan.issues.length > 0 && (
            <p className="migration-warning">有 {plan.issues.length} 个字段问题被阻断；缺失等级不会被默认补成 C。</p>
          )}
          {plan.candidates.length > 0 ? (
            <fieldset className="legacy-candidate-list">
              <legend>逐笔选择要迁移的复盘（默认全不选）</legend>
              {plan.candidates.map((candidate) => {
                const trade = tradeById.get(candidate.tradeId);
                const exists = Object.hasOwn(context.reviews, candidate.tradeId);
                const label = trade
                  ? `${trade.symbol} · ${new Date(trade.entryTime).toLocaleString('zh-CN')}`
                  : candidate.tradeId;
                return (
                  <label key={candidate.tradeId}>
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.tradeId)}
                      disabled={exists}
                      onChange={(event) => toggle(candidate.tradeId, event.target.checked)}
                      aria-label={`选择 ${label}`}
                    />
                    <span><b>{label}</b><small>{exists ? '当前已有复盘，不覆盖' : candidate.review.lesson || '无复盘教训'}</small></span>
                  </label>
                );
              })}
            </fieldset>
          ) : <p className="migration-warning">没有可安全迁移的完全匹配成交；系统不会用时间、价格或盈亏做近似猜测。</p>}
          {eligibleIds.length > 0 && (
            <>
              <button className="text-button" type="button" onClick={() => setSelected(new Set(eligibleIds))}>选择全部可写入项</button>
              <label className="check-label">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                我确认该 Classic 导出属于当前账户与当前数据集，并理解系统只按完全相同的成交 ID 写入。
              </label>
              <button className="button primary" type="button" disabled={busy || !confirmed || selected.size === 0} onClick={() => void apply()}>
                迁移已选择的 {selected.size} 笔复盘
              </button>
            </>
          )}
        </div>
      )}
      {receipt && <p className="migration-success" role="status">迁移完成：新增 {receipt.insertedCount} 笔，已有复盘跳过 {receipt.skippedExistingCount} 笔；旧版原数据仍保留。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="panel-footnote">边界：跨来源自动读取受浏览器同源策略限制；没有完全相同成交 ID 的旧记录不会迁移；旧风险数字只展示、不写入当前风控规则。</p>
    </section>
  );
}
