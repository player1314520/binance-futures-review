import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  computeAll,
  displaySymbol,
  fmtNum,
  fmtPct,
  fmtUsd,
  type ComputedStats,
  type EnrichedTrade,
} from '@rv/engine';
import { useStore } from '../store';
import { beijingDay } from '../lib/review-report';
import {
  MAX_EXPERIMENT_DECISION_NOTE_LENGTH,
  MAX_EXPERIMENT_HYPOTHESIS_LENGTH,
  MAX_EXPERIMENT_OBSERVATION_NOTE_LENGTH,
  MAX_EXPERIMENT_TARGET_COUNT,
  type ActionExperimentDecision,
  type ActionExperimentInput,
  type ActionExperimentObservationInput,
  type ActionPlan,
} from '../lib/action-plan-storage';

export type WorkbenchMode =
  | 'overview'
  | 'attribution'
  | 'context'
  | 'r'
  | 'playbook'
  | 'ritual'
  | 'calendar'
  | 'replay'
  | 'coach'
  | 'experiments'
  | 'reports'
  | 'compare'
  | 'goals';

type PageDefinition = Readonly<{
  eyebrow: string;
  title: string;
  lead: string;
  boundary: readonly [string, string, string];
}>;

const PAGE: Record<WorkbenchMode, PageDefinition> = {
  overview: {
    eyebrow: 'REVIEW LEDGER',
    title: '复盘总览',
    lead: '把交易、复盘和下一步行动放在同一本账上。',
    boundary: ['只统计已导入且能解析的记录。', '盈亏字段未通过可信性检查时不展示盈亏指标。', '页面只描述历史行为，不给出下单建议。'],
  },
  attribution: {
    eyebrow: 'SELF BENCHMARK',
    title: '归因对标',
    lead: '按品种和方向对比你自己的样本，找到盈亏从哪里来。',
    boundary: ['对标基线是当前导入数据，不是外部市场基准。', '小样本分组不能证明因果。', '资金费、未平仓与账户出入金仅在源数据提供时可观测。'],
  },
  context: {
    eyebrow: 'TIME CONTEXT',
    title: '市场情境',
    lead: '先用交易时段做可复现的情境切片，不伪造外部行情。',
    boundary: ['当前情境是时段代理变量，不等于牛熊或波动率体制。', '没有 OHLCV 就不标注趋势、震荡或事件。', '分组差异只用于提问，不自动生成交易规则。'],
  },
  r: {
    eyebrow: 'RISK UNIT',
    title: 'R 复盘',
    lead: '用单笔风险单位对齐不同合约，同时把估算 R 明确标出。',
    boundary: ['没有事前止损时，R 只能按历史亏损尺寸估算。', '估算 R 不是事前风险预算。', '不用 R 结果建议仓位、杠杆或入场。'],
  },
  playbook: {
    eyebrow: 'USER EVIDENCE',
    title: '策略手册',
    lead: '只收录你自己复盘留下的教训和执行规则。',
    boundary: ['不会把单笔复盘自动包装成已验证策略。', '没有样本外测试和统计检验就不声称有效。', '手册不提供信号、下单或仓位建议。'],
  },
  ritual: {
    eyebrow: 'DAILY LOOP',
    title: '今日仪式',
    lead: '用最短清单完成“数据 → 复盘 → 行动”。',
    boundary: ['仪式只跟踪当前工作区的记录状态。', '它不会控制 Binance 账户或阻止交易。', '行为实验是用户自证记录，不代表系统验证交易结果改善。'],
  },
  calendar: {
    eyebrow: 'BEIJING DAY',
    title: '交易日历',
    lead: '按北京时间平仓日归档，把交易频率和复盘节奏放在一起。',
    boundary: ['日归属以平仓时间为准。', '无可信盈亏时只展示笔数和复盘覆盖。', '日级聚合不能解释市场事件或价格变动原因。'],
  },
  replay: {
    eyebrow: 'EVIDENCE REPLAY',
    title: 'K线回放',
    lead: '先回放成交事件和已写复盘；有真实 K 线证据后才画蜡烛。',
    boundary: ['当前导入若不含 OHLCV，页面只是成交事件回放。', '不使用后验价格伪造入场时可见信息。', '回放用于检查执行，不提供下一笔信号。'],
  },
  coach: {
    eyebrow: 'LOCAL RULE ENGINE',
    title: 'AI 教练',
    lead: '当前版本只用本地、可解释的确定性规则反馈，不调用外部大模型。',
    boundary: ['没有外部 AI 请求，不伪称为模型推理。', '规则只基于当前数据和你的复盘文字。', '反馈不是个性化投资建议，不能代替人工判断。'],
  },
  experiments: {
    eyebrow: 'ONE CHANGE',
    title: '行为实验室',
    lead: '给“一次只改一件事”设窗口、样本和逐次证据，再决定保留、修改或放弃。',
    boundary: ['成功标准只验证动作是否执行，不用盈亏证明动作有效。', '自填证据没有对照组，不能据此声称因果。', '实验不会自动改变交易系统、下单参数或 Binance 账户。'],
  },
  reports: {
    eyebrow: 'AUDITABLE SNAPSHOT',
    title: '周报月报',
    lead: '生成当前工作区的可打印摘要，同时保留 .fupan 数据存档出口。',
    boundary: ['报告只覆盖当前已导入样本。', '没有可信盈亏时不生成盈亏结论。', '报告是复盘材料，不是业绩证明或投资建议。'],
  },
  compare: {
    eyebrow: 'PERIOD SPLIT',
    title: '对比复盘',
    lead: '把当前样本按时间一分为二，检查复盘和执行是否有变化。',
    boundary: ['两段样本可能处在不同市场环境，不能直接归因。', '小样本差异可能是随机波动。', '比较结果不自动产生交易规则。'],
  },
  goals: {
    eyebrow: 'PROCESS GOALS',
    title: '成长目标',
    lead: '目标只锁定可控制的过程：复盘覆盖、行动闭环和数据完整性。',
    boundary: ['不以收益率或赚钱金额作为系统承诺。', '当前目标是动态进度而非专业风控限额。', '完成进度不证明未来交易表现。'],
  },
};

type GroupRow = Readonly<{
  key: string;
  trades: readonly EnrichedTrade[];
  stats: ComputedStats;
}>;

function groupTrades(
  trades: readonly EnrichedTrade[],
  keyOf: (trade: EnrichedTrade) => string,
): GroupRow[] {
  const groups = new Map<string, EnrichedTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade) || '未标注';
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, trades: rows, stats: computeAll(rows, 0) }))
    .sort((a, b) => b.trades.length - a.trades.length || a.key.localeCompare(b.key));
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="workbench-metric">
      <span>{label}</span>
      <strong className="mono">{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function EmptyData() {
  return (
    <section className="workbench-empty" aria-label="暂无交易数据">
      <strong>还没有可复盘的交易</strong>
      <p>导入 Binance 合约 CSV 或 .fupan 存档后，本页会用同一份真实工作区数据计算。</p>
      <Link className="button primary" to="/data">去数据中心</Link>
    </section>
  );
}

function GroupTable({ rows, analyticsReady }: { rows: readonly GroupRow[]; analyticsReady: boolean }) {
  return (
    <div className="workbench-table" role="table" aria-label="分组对比">
      <div className="workbench-table-row head" role="row">
        <span role="columnheader">分组</span><span role="columnheader">笔数</span>
        <span role="columnheader">{analyticsReady ? '胜率' : '指标状态'}</span><span role="columnheader">{analyticsReady ? '净盈亏' : '结果状态'}</span>
      </div>
      {rows.slice(0, 12).map((row) => (
        <div className="workbench-table-row" role="row" key={row.key}>
          <strong role="cell">{row.key}</strong>
          <span role="cell" className="mono">{row.stats.n}</span>
          <span role="cell" className="mono">{analyticsReady ? fmtPct(row.stats.winRate) : '未解锁'}</span>
          <span role="cell" className="mono">{analyticsReady ? fmtUsd(row.stats.net, true) : '不展示'}</span>
        </div>
      ))}
    </div>
  );
}

function ChecklistRow({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <div className={`workbench-check ${done ? 'done' : ''}`}>
      <b aria-hidden="true">{done ? '✓' : '·'}</b>
      <span><strong>{label}</strong><small>{detail}</small></span>
    </div>
  );
}

function dateKey(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function shiftDay(day: string, days: number): string {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

const DECISION_LABEL: Record<Exclude<ActionExperimentDecision, 'pending'>, string> = {
  adopt: '保留动作',
  revise: '修改后重测',
  discard: '放弃动作',
};

type ExperimentCardProps = Readonly<{
  action: ActionPlan;
  setActionStatus: (actionId: string, status: 'open' | 'done' | 'dismissed') => Promise<boolean>;
  setActionExperiment: (actionId: string, input: ActionExperimentInput) => Promise<boolean>;
  recordActionExperimentObservation: (
    actionId: string,
    input: ActionExperimentObservationInput,
  ) => Promise<boolean>;
  decideActionExperiment: (
    actionId: string,
    decision: Exclude<ActionExperimentDecision, 'pending'>,
    evidenceNote: string,
  ) => Promise<boolean>;
}>;

function ExperimentCard({
  action,
  setActionStatus,
  setActionExperiment,
  recordActionExperimentObservation,
  decideActionExperiment,
}: ExperimentCardProps) {
  const today = beijingDay(Date.now());
  const [hypothesis, setHypothesis] = useState(
    `若出现执行机会，我将按计划做到“${action.text}”`.slice(0, MAX_EXPERIMENT_HYPOTHESIS_LENGTH),
  );
  const [targetCount, setTargetCount] = useState('3');
  const [successCriterion, setSuccessCriterion] = useState('3');
  const [windowStart, setWindowStart] = useState(today);
  const [windowEnd, setWindowEnd] = useState(shiftDay(today, 13));
  const [observationDay, setObservationDay] = useState(today);
  const [followed, setFollowed] = useState<'yes' | 'no'>('yes');
  const [observationNote, setObservationNote] = useState('');
  const [decision, setDecision] = useState<Exclude<ActionExperimentDecision, 'pending'>>('adopt');
  const [decisionNote, setDecisionNote] = useState('');
  const [redesigning, setRedesigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const experiment = action.experiment ?? null;

  async function run(operation: () => Promise<boolean>, failure: string): Promise<boolean> {
    setBusy(true);
    setFeedback('');
    try {
      const saved = await operation();
      if (!saved) setFeedback(failure);
      return saved;
    } catch {
      setFeedback(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function configure(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await run(() => setActionExperiment(action.id, {
      hypothesis,
      targetCount: Number(targetCount),
      windowStart,
      windowEnd,
      successCriterion: Number(successCriterion),
    }), '实验未保存。请检查日期、样本数和成功标准。');
    if (saved) setRedesigning(false);
  }

  async function recordObservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await run(() => recordActionExperimentObservation(action.id, {
      day: observationDay,
      followed: followed === 'yes',
      evidenceNote: observationNote,
    }), '观察未保存。日期必须在实验窗口内，并填写可核对的复盘证据。');
    if (saved) setObservationNote('');
  }

  async function closeExperiment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () => decideActionExperiment(action.id, decision, decisionNote),
      '结论未保存。必须完成目标样本并写明证据结论。',
    );
  }

  const configurationForm = (
    <form className="experiment-form" onSubmit={configure}>
      <label className="wide">可检验假设
        <textarea required maxLength={MAX_EXPERIMENT_HYPOTHESIS_LENGTH} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} />
      </label>
      <label>目标机会数
        <input required type="number" min="1" max={MAX_EXPERIMENT_TARGET_COUNT} step="1" value={targetCount} onChange={(event) => setTargetCount(event.target.value)} />
      </label>
      <label>至少执行次数
        <input required type="number" min="1" max={targetCount || MAX_EXPERIMENT_TARGET_COUNT} step="1" value={successCriterion} onChange={(event) => setSuccessCriterion(event.target.value)} />
      </label>
      <label>开始日期
        <input required type="date" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
      </label>
      <label>结束日期
        <input required type="date" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
      </label>
      <p className="experiment-form-note wide">只检验这一个动作是否按计划执行；目标最多 {MAX_EXPERIMENT_TARGET_COUNT} 次，窗口最多 366 天。</p>
      <button className="button primary wide" type="submit" disabled={busy}>{busy ? '保存中…' : experiment?.decision === 'revise' ? '保存新版实验并重新取证' : '开始实验并持久化'}</button>
    </form>
  );

  return (
    <article className={`experiment-card ${experiment?.decision !== 'pending' ? 'closed' : ''}`} aria-label={`行为实验：${action.text}`}>
      <header>
        <div><span>单一动作</span><h3>{action.text}</h3><small>源交易 {action.sourceTradeId}</small></div>
        <b>{experiment
          ? experiment.decision === 'pending' ? '取证中' : DECISION_LABEL[experiment.decision]
          : action.status === 'open' ? '待设计' : '旧版记录'}</b>
      </header>

      {!experiment && action.status !== 'open' ? (
        <div className="experiment-legacy">
          <p>这条旧行动只有“{action.status === 'done' ? '已完成' : '已放弃'}”状态，没有样本窗口和逐次证据，因此不计作已验证实验。</p>
          <button className="button secondary" type="button" disabled={busy} onClick={() => run(
            () => setActionStatus(action.id, 'open'),
            '行动未重新打开，请重试。',
          )}>重新打开并设计实验</button>
        </div>
      ) : !experiment ? configurationForm : (
        <>
          <dl className="experiment-contract">
            <div><dt>假设</dt><dd>{experiment.hypothesis}</dd></div>
            <div><dt>窗口</dt><dd className="mono">{experiment.windowStart} — {experiment.windowEnd}</dd></div>
            <div><dt>成功标准</dt><dd>{experiment.targetCount} 次机会中至少 {experiment.successCriterion} 次按计划执行</dd></div>
            <div><dt>当前证据</dt><dd>{experiment.observedCount}/{experiment.targetCount} 次观察 · {experiment.successfulCount} 次执行</dd></div>
          </dl>
          <progress className="experiment-progress" max={experiment.targetCount} value={experiment.observedCount}>
            {experiment.observedCount}/{experiment.targetCount}
          </progress>

          {experiment.observations.length > 0 && (
            <ol className="experiment-evidence" aria-label="逐次实验证据">
              {experiment.observations.map((observation, index) => (
                <li key={`${observation.day}-${index}`}>
                  <span className="mono">{observation.day}</span>
                  <b className={observation.followed ? 'pass' : 'miss'}>{observation.followed ? '已执行' : '未执行'}</b>
                  <p>{observation.evidenceNote}</p>
                </li>
              ))}
            </ol>
          )}

          {experiment.decision === 'pending' && experiment.observedCount < experiment.targetCount && (
            <form className="experiment-form observation" onSubmit={recordObservation}>
              <label>观察日期
                <input required type="date" min={experiment.windowStart} max={experiment.windowEnd} value={observationDay} onChange={(event) => setObservationDay(event.target.value)} />
              </label>
              <label>动作结果
                <select value={followed} onChange={(event) => setFollowed(event.target.value as 'yes' | 'no')}>
                  <option value="yes">按计划执行</option>
                  <option value="no">未按计划执行</option>
                </select>
              </label>
              <label className="wide">证据说明
                <textarea required maxLength={MAX_EXPERIMENT_OBSERVATION_NOTE_LENGTH} placeholder="写明对应复盘、检查项或可回看的事实；不要只写“感觉不错”" value={observationNote} onChange={(event) => setObservationNote(event.target.value)} />
              </label>
              <button className="button secondary wide" type="submit" disabled={busy}>{busy ? '保存中…' : '保存本次观察'}</button>
            </form>
          )}

          {experiment.decision === 'pending' && experiment.observedCount === experiment.targetCount && (
            <form className="experiment-form decision" onSubmit={closeExperiment}>
              <div className={`experiment-result wide ${experiment.successfulCount >= experiment.successCriterion ? 'pass' : 'miss'}`}>
                <strong>{experiment.successfulCount >= experiment.successCriterion ? '达到预设执行标准' : '未达到预设执行标准'}</strong>
                <span>这是动作执行证据，不是盈亏改善或因果证明。</span>
              </div>
              <label>实验决策
                <select value={decision} onChange={(event) => setDecision(event.target.value as Exclude<ActionExperimentDecision, 'pending'>)}>
                  <option value="adopt">保留动作</option>
                  <option value="revise">修改后重测</option>
                  <option value="discard">放弃动作</option>
                </select>
              </label>
              <label className="wide">结论与限制
                <textarea required maxLength={MAX_EXPERIMENT_DECISION_NOTE_LENGTH} placeholder="引用样本结果，说明保留、修改或放弃的理由与限制" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} />
              </label>
              <button className="button primary wide" type="submit" disabled={busy}>{busy ? '保存中…' : '保存决策并闭环'}</button>
            </form>
          )}

          {experiment.decision !== 'pending' && (
            <div className="experiment-decision">
              <strong>{DECISION_LABEL[experiment.decision]}</strong>
              <p>{experiment.evidenceNote}</p>
              <small>{experiment.successfulCount}/{experiment.targetCount} 次按计划执行；结果仅代表本实验窗口。</small>
              {experiment.decision === 'revise' && !redesigning && (
                <button className="button secondary" type="button" onClick={() => setRedesigning(true)}>
                  按结论重新设计
                </button>
              )}
            </div>
          )}
          {experiment.decision === 'revise' && redesigning && configurationForm}
        </>
      )}
      {feedback && <p className="form-error experiment-feedback" role="alert">{feedback}</p>}
    </article>
  );
}

export default function WorkbenchView({ mode }: { mode: WorkbenchMode }) {
  const store = useStore();
  const {
    session,
    analyticsReady,
    exportSession,
    setActionStatus,
    setActionExperiment,
    recordActionExperimentObservation,
    decideActionExperiment,
  } = store;
  const definition = PAGE[mode];
  const trades = session.trades;
  const stats = useMemo(() => trades.length ? computeAll(trades, 0) : null, [trades]);
  const reviews = Object.values(session.reviews);
  const actions = Object.values(session.actions).sort((a, b) => b.updatedAt - a.updatedAt);
  const reviewed = reviews.filter((review) => review.reviewed).length;
  const openActions = actions.filter((action) => action.status === 'open');

  const symbolRows = useMemo(() => groupTrades(
    trades,
    (trade) => `${displaySymbol(trade.symbol, trade.market)} · ${trade.side === 'LONG' ? '多' : '空'}`,
  ), [trades]);
  const contextRows = useMemo(() => groupTrades(
    trades,
    (trade) => trade.sessionLabel || trade.session || '未标注时段',
  ), [trades]);

  const localCoach = useMemo(() => {
    const messages: string[] = [];
    if (!trades.length) return ['先导入数据；没有样本时规则引擎不作判断。'];
    if (reviewed < trades.length) messages.push(`还有 ${trades.length - reviewed} 笔未完成复盘，先把事实和教训写完。`);
    if (openActions.length) messages.push(`当前有 ${openActions.length} 项待执行行动，下一笔只选一项验证。`);
    if (analyticsReady && stats && stats.maxLossStreak >= 3) messages.push(`样本中最长连亏 ${stats.maxLossStreak} 笔，建议复查连亏期间是否违反既定流程。`);
    if (stats && stats.tradesPerDay > 3) messages.push(`活跃日日均 ${fmtNum(stats.tradesPerDay, 1)} 笔，可检查频率上升是否降低复盘完成率。`);
    if (analyticsReady && stats && stats.mfeRealN === 0) messages.push('当前没有可验证的 MFE/MAE 路径，不对“卖飞”或“扭单”下数值结论。');
    return messages.length ? messages : ['当前未命中预置风险规则；继续累积复盘和行动证据。'];
  }, [analyticsReady, openActions.length, reviewed, stats, trades.length]);

  const renderContent = () => {
    if (mode === 'ritual') {
      return (
        <div className="workbench-two-column">
          <section className="workbench-panel">
            <h2>本次闭环</h2>
            <ChecklistRow done={trades.length > 0} label="1. 数据就绪" detail={trades.length ? `已载入 ${trades.length} 笔已平仓交易` : '请先导入可验证数据'} />
            <ChecklistRow done={trades.length > 0 && reviewed >= trades.length} label="2. 逐笔复盘" detail={`${reviewed}/${trades.length} 笔已完成`} />
            <ChecklistRow done={actions.length > 0 && openActions.length === 0} label="3. 行动收口" detail={actions.length ? `${actions.length - openActions.length}/${actions.length} 项已处理` : '完成复盘后会生成下一步行动'} />
          </section>
          <section className="workbench-panel">
            <h2>待执行</h2>
            {openActions.length ? openActions.slice(0, 6).map((action) => (
              <Link className="workbench-action" to="/experiments" key={action.id}>
                <span>{action.text}</span><b>{action.experiment?.decision === 'revise'
                  ? '重新设计'
                  : action.experiment ? '继续取证' : '设计实验'}</b>
              </Link>
            )) : <p className="workbench-muted">当前没有待执行行动。</p>}
            <Link className="text-link" to="/trades">继续逐笔复盘 →</Link>
          </section>
        </div>
      );
    }

    if (!trades.length) return <EmptyData />;

    if (mode === 'overview') {
      return (
        <>
          <section className="workbench-metrics">
            <Metric label="已平仓交易" value={`${trades.length} 笔`} note={session.persistence === 'vault' ? '端到端加密工作区' : '当前浏览器会话'} />
            <Metric label="复盘覆盖" value={`${reviewed}/${trades.length}`} note={fmtPct(trades.length ? reviewed / trades.length : 0)} />
            <Metric label="待执行行动" value={`${openActions.length} 项`} note={`共 ${actions.length} 项`} />
            <Metric label="净盈亏" value={analyticsReady && stats ? fmtUsd(stats.net, true) : '待可信盈亏'} note={analyticsReady ? '已解锁分析口径' : '不展示未验证指标'} />
          </section>
          <div className="workbench-two-column">
            <section className="workbench-panel"><h2>复盘进度</h2><p className="workbench-big mono">{fmtPct(reviewed / Math.max(1, trades.length))}</p><p className="workbench-muted">已写事实、结果和下一步的交易占比。</p><Link className="button secondary" to="/trades">打开复盘卡</Link></section>
            <section className="workbench-panel"><h2>行动闭环</h2><p className="workbench-big mono">{actions.length - openActions.length}/{actions.length}</p><p className="workbench-muted">已完成或已放弃 / 全部行动。</p><Link className="button secondary" to="/experiments">查看行为实验</Link></section>
          </div>
        </>
      );
    }

    if (mode === 'attribution') return <section className="workbench-panel"><h2>品种 × 方向</h2><GroupTable rows={symbolRows} analyticsReady={analyticsReady} /></section>;
    if (mode === 'context') return <section className="workbench-panel"><h2>交易时段切片</h2><GroupTable rows={contextRows} analyticsReady={analyticsReady} /></section>;

    if (mode === 'r' && !analyticsReady) {
      return (
        <section className="workbench-empty" aria-label="R 指标待解锁">
          <strong>R 指标暂不展示</strong>
          <p>当前导入数据没有通过已实现盈亏可信性检查，因此不用未验证的盈亏推导 R。</p>
          <Link className="button secondary" to="/data">检查数据口径</Link>
        </section>
      );
    }

    if (mode === 'r' && stats) {
      const approx = stats.rEstimatedN ? '≈' : '';
      return (
        <>
          {stats.rEstimatedN > 0 && <div className="workbench-caution">≈ {stats.rEstimatedN}/{stats.n} 笔缺少事前止损，R 使用历史亏损尺寸估算。</div>}
          <section className="workbench-metrics">
            <Metric label="累计 R" value={`${approx}${fmtNum(stats.totalR)}R`} />
            <Metric label="期望 / 笔" value={`${approx}${fmtNum(stats.expectancyR)}R`} />
            <Metric label="最好 / 最差" value={`${approx}${fmtNum(stats.bestR)}R / ${fmtNum(stats.worstR)}R`} />
            <Metric label="估算占比" value={fmtPct(stats.rEstimatedN / Math.max(1, stats.n))} />
          </section>
        </>
      );
    }

    if (mode === 'playbook') {
      const lessons = Object.entries(session.reviews)
        .filter(([, review]) => review.reviewed && review.lesson.trim())
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      return (
        <div className="workbench-two-column">
          <section className="workbench-panel"><h2>已提炼的教训</h2>{lessons.length ? lessons.slice(0, 8).map(([id, review], index) => <div className="workbench-rule" key={id}><b>{String(index + 1).padStart(2, '0')}</b><span>{review.lesson}</span></div>) : <p className="workbench-muted">还没有可收录的教训；先完成至少一张复盘卡。</p>}</section>
          <section className="workbench-panel"><h2>结构化程度</h2><Metric label="复盘完成" value={`${reviewed}/${trades.length}`} /><Metric label="有下一步" value={`${actions.length} 条`} /><Link className="button secondary" to="/trades">编辑复盘卡</Link></section>
        </div>
      );
    }

    if (mode === 'calendar') {
      const grouped = new Map<string, { count: number; reviewed: number; pnl: number }>();
      for (const trade of trades) {
        const key = beijingDay(trade.exitTime);
        const row = grouped.get(key) ?? { count: 0, reviewed: 0, pnl: 0 };
        row.count += 1;
        row.reviewed += session.reviews[String(trade.id)]?.reviewed ? 1 : 0;
        if (analyticsReady) row.pnl += trade.pnl;
        grouped.set(key, row);
      }
      const days = [...grouped.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 21);
      return (
        <section className="workbench-panel"><h2>最近有交易的日期</h2><div className="workbench-calendar">{days.map(([key, row]) => <div key={key}><strong className="mono">{key}</strong><span>{row.count} 笔 · {row.reviewed} 笔已复盘</span><b className="mono">{analyticsReady ? fmtUsd(row.pnl, true) : '结果指标未解锁'}</b></div>)}</div></section>
      );
    }

    if (mode === 'replay') {
      const recent = [...trades].sort((a, b) => b.exitTime - a.exitTime).slice(0, 10);
      return (
        <section className="workbench-panel"><h2>成交事件线</h2><div className="workbench-timeline">{recent.map((trade) => { const review = session.reviews[trade.id]; return <article key={trade.id}><time>{new Date(trade.entryTime).toLocaleString('zh-CN', { hour12: false })}</time><div><strong>{displaySymbol(trade.symbol, trade.market)} · {trade.side === 'LONG' ? '多' : '空'}</strong><span className="mono">{trade.entryPrice} → {trade.exitPrice}</span><p>{review?.saw || '未记录当时看到的信息。'}</p></div></article>; })}</div><div className="workbench-caution">当前只回放真实导入的成交事件；数据中没有 OHLCV，因此不伪造 K 线。</div></section>
      );
    }

    if (mode === 'coach') return <section className="workbench-panel"><div className="workbench-engine-badge">确定性本地规则 · 0 个外部请求</div><h2>本次反馈</h2>{localCoach.map((message, index) => <div className="workbench-coach" key={message}><b>{String(index + 1).padStart(2, '0')}</b><p>{message}</p></div>)}</section>;

    if (mode === 'experiments') {
      return (
        <section className="workbench-panel experiment-lab">
          <div className="experiment-lab-heading">
            <div><h2>单变量行为实验</h2><p>设计 → 逐次取证 → 对照预设标准 → 保留、修改或放弃。</p></div>
            <span>{actions.filter((action) => action.experiment && action.experiment.decision !== 'pending').length}/{actions.length} 已闭环</span>
          </div>
          {actions.length ? actions.map((action) => (
            <ExperimentCard
              key={action.id}
              action={action}
              setActionStatus={setActionStatus}
              setActionExperiment={setActionExperiment}
              recordActionExperimentObservation={recordActionExperimentObservation}
              decideActionExperiment={decideActionExperiment}
            />
          )) : <p className="workbench-muted">完成复盘卡并写下“下一次只改哪一件事”后，这里会出现可设计的实验。</p>}
        </section>
      );
    }

    if (mode === 'reports' && stats) {
      return (
        <>
          <section className="workbench-metrics report-summary">
            <Metric label="样本范围" value={`${dateKey(Math.min(...trades.map((trade) => trade.exitTime)))} — ${dateKey(Math.max(...trades.map((trade) => trade.exitTime)))}`} />
            <Metric label="交易 / 复盘" value={`${trades.length} / ${reviewed}`} />
            <Metric label="行动完成" value={`${actions.length - openActions.length}/${actions.length}`} />
            <Metric label="净盈亏" value={analyticsReady ? fmtUsd(stats.net, true) : '待可信盈亏'} />
          </section>
          <section className="workbench-panel report-actions"><h2>交付</h2><p className="workbench-muted">打印会使用当前可见摘要；.fupan 保留可重新导入的交易存档。</p><div className="button-row"><button className="button primary" type="button" onClick={() => window.print()}>打印 / 导出 PDF</button><button className="button secondary" type="button" onClick={exportSession}>导出 .fupan</button></div></section>
        </>
      );
    }

    if (mode === 'compare') {
      const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
      const pivot = Math.ceil(ordered.length / 2);
      const halves = [ordered.slice(0, pivot), ordered.slice(pivot)];
      return (
        <div className="workbench-two-column compare-grid">{halves.map((rows, index) => { const split = rows.length ? computeAll(rows, 0) : null; const reviewedInSplit = rows.filter((trade) => session.reviews[trade.id]?.reviewed).length; return <section className="workbench-panel" key={index}><p className="eyebrow">{index === 0 ? '前半段' : '后半段'}</p><h2>{rows.length ? `${dateKey(rows[0].exitTime)} — ${dateKey(rows[rows.length - 1].exitTime)}` : '样本不足'}</h2><Metric label="交易" value={`${rows.length} 笔`} /><Metric label="复盘覆盖" value={`${reviewedInSplit}/${rows.length}`} /><Metric label="净盈亏" value={analyticsReady && split ? fmtUsd(split.net, true) : '不展示'} /></section>; })}</div>
      );
    }

    if (mode === 'goals') {
      const reviewProgress = reviewed / Math.max(1, trades.length);
      const actionProgress = actions.length ? (actions.length - openActions.length) / actions.length : 0;
      const goals = [
        { label: '复盘覆盖达到 100%', value: reviewProgress, detail: `${reviewed}/${trades.length} 笔` },
        { label: '每项行动都有明确状态', value: actionProgress, detail: `${actions.length - openActions.length}/${actions.length} 项已收口` },
        { label: '数据源和存储边界可识别', value: session.source !== 'demo' ? 1 : 0, detail: session.source === 'demo' ? '当前为合成演示' : session.persistence === 'vault' ? '已进入加密工作区' : '当前数据在本地会话' },
      ];
      return <section className="workbench-panel"><h2>可控制的进度</h2>{goals.map((goal) => <div className="workbench-goal" key={goal.label}><div><strong>{goal.label}</strong><span className="mono">{goal.detail}</span></div><progress max="1" value={goal.value}>{fmtPct(goal.value)}</progress></div>)}</section>;
    }

    return null;
  };

  return (
    <div className="page-stack workbench-page">
      <header className="workbench-heading">
        <div><p className="eyebrow">{definition.eyebrow}</p><h1>{definition.title}</h1></div>
        <p>{definition.lead}</p>
      </header>
      {renderContent()}
      <aside className="workbench-boundary" aria-label={`${definition.title}能力边界`}>
        <strong>能力边界</strong>
        <ol>{definition.boundary.map((item) => <li key={item}>{item}</li>)}</ol>
      </aside>
    </div>
  );
}
