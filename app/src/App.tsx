import React, { useEffect, useState } from 'react';
import {
  HashRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { StoreProvider, useStore } from './store';
import { AuthProvider, useAuth } from './lib/auth-context';
import { WorkspaceProvider } from './lib/workspace-context';
import { runtimeOriginMatches } from './lib/runtime-origin';
import AccountView from './views/AccountView';
import AnalyticsView from './views/AnalyticsView';
import DataView from './views/DataView';
import ReportsView from './views/ReportsView';
import ReviewLoopView from './views/ReviewLoopView';
import TodayView from './views/TodayView';
import TradesView from './views/TradesView';
import WorkbenchView from './views/WorkbenchView';
import { MOBILE_NAV, WORKBENCH_NAV } from './navigation';

const BUILD_SHA = import.meta.env.VITE_BUILD_SHA?.slice(0, 7) || 'local';
const EXPECTED_APP_ORIGIN = import.meta.env.VITE_APP_ORIGIN?.trim() ?? '';

type RouteContext = Readonly<{
  title: string;
  subtitle: string;
  kicker: string;
}>;

export type TodayAccountScope = 'all' | 'main' | 'training';

const TODAY_ACCOUNT_SCOPES: readonly Readonly<{
  id: TodayAccountScope;
  label: string;
  short: string;
}>[] = Object.freeze([
  { id: 'all', label: '全部账户', short: '全' },
  { id: 'main', label: '主账户', short: '主' },
  { id: 'training', label: '训练账户', short: '训' },
]);

const NAV_ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  '/today': 'M4 17h16M6.2 14.5a6 6 0 0 1 11.6 0M12 3v3M4.9 7.4l2.1 2.1M19.1 7.4 17 9.5',
  '/overview': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  '/trades': 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h4',
  '/attribution': 'M5 19V9M10 19V5M15 19v-7M20 19V8M3 19h19',
  '/context': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z',
  '/r': 'M4 18h16M6 15l4-5 3 3 5-7',
  '/playbook': 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM8 4v16',
  '/ritual': 'M5 5h14M5 10h14M5 15h9M5 20h6M3 5h.01M3 10h.01M3 15h.01',
  '/calendar': 'M5 4h14v16H5zM8 2v4M16 2v4M5 9h14',
  '/replay': 'M12 21a9 9 0 1 0-8.2-5.3M3 21v-6h6M10 8l6 4-6 4z',
  '/coach': 'M5 5h14v11H9l-4 4zM9 9h6M9 12h4',
  '/experiments': 'M9 3h6M10 3v5l-5 9a2.6 2.6 0 0 0 2.3 4h9.4A2.6 2.6 0 0 0 19 17l-5-9V3M8 15h8',
  '/reports': 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6',
  '/compare': 'M4 5h7v14H4zM13 5h7v14h-7zM7 9h1M16 9h1M7 13h1M16 13h1',
  '/goals': 'M4 19V9M9 19V5M14 19v-7M19 19V3M3 19h18',
  '/analytics': 'M4 18h16M6 15l3-4 3 2 5-7 2 2',
  '/data': 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zm0 0v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6m-14 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6',
});

function NavIcon({ route }: Readonly<{ route: string }>) {
  return (
    <span className="nav-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={NAV_ICON_PATHS[route] ?? NAV_ICON_PATHS['/overview']} />
      </svg>
    </span>
  );
}

const ROUTE_CONTEXT: Readonly<Record<string, RouteContext>> = Object.freeze({
  '/today': { title: '今日速览', subtitle: '打开 3 秒，看发生了什么、还欠几笔复盘。', kicker: 'TODAY · REVIEW DESK' },
  '/overview': { title: '复盘总览', subtitle: '把结果、执行和复盘进度放在同一张事实表里。', kicker: 'OVERVIEW · VERIFIED DATA' },
  '/trades': { title: '复盘卡', subtitle: '逐笔还原看到什么、发生什么，以及下一次只改什么。', kicker: 'TRADE REVIEW · ONE BY ONE' },
  '/attribution': { title: '归因对标', subtitle: '区分行情、策略与执行，不用单笔盈亏代替原因。', kicker: 'ATTRIBUTION · EVIDENCE FIRST' },
  '/context': { title: '市场情境', subtitle: '按可验证标签观察不同环境下的执行差异。', kicker: 'CONTEXT · MARKET REGIME' },
  '/r': { title: 'R 复盘', subtitle: '仅在风险基准与盈亏证据完整时计算 R 指标。', kicker: 'R REVIEW · GATED METRICS' },
  '/playbook': { title: '策略手册', subtitle: '把重复出现的有效教训沉淀为可执行规则。', kicker: 'PLAYBOOK · REUSABLE RULES' },
  '/ritual': { title: '今日仪式', subtitle: '记录当日状态，完成收盘后的最小复盘动作。', kicker: 'RITUAL · DAILY CLOSE' },
  '/calendar': { title: '交易日历', subtitle: '按北京时间回到真实有交易与复盘记录的日期。', kicker: 'CALENDAR · BEIJING TIME' },
  '/replay': { title: 'K线回放', subtitle: '用本地记录定位交易时刻；缺少行情时明确留空。', kicker: 'REPLAY · LOCAL RECORDS' },
  '/coach': { title: 'AI 教练', subtitle: '基于当前复盘内容整理问题与规则，不代替投资判断。', kicker: 'COACH · REVIEW PROMPTS' },
  '/experiments': { title: '行为实验室', subtitle: '一次只验证一个动作，用下一笔交易形成反馈。', kicker: 'EXPERIMENT · ONE VARIABLE' },
  '/reports': { title: '周报月报', subtitle: '按已核验数据汇总阶段变化和未完成复盘。', kicker: 'REPORTS · TRACEABLE FACTS' },
  '/compare': { title: '对比复盘', subtitle: '在相同口径下比较账户、阶段或策略样本。', kicker: 'COMPARE · SAME CONTRACT' },
  '/goals': { title: '成长目标', subtitle: '把复盘教训转成下一阶段可观察的行为目标。', kicker: 'GOALS · BEHAVIOR FIRST' },
  '/analytics': { title: '深度洞察', subtitle: '分析指标必须在对账和能力门禁通过后才显示。', kicker: 'ANALYTICS · FAIL CLOSED' },
  '/data': { title: '数据中心', subtitle: '先净化、核验和对账，再让数据进入分析链路。', kicker: 'DATA · VERIFY BEFORE USE' },
  '/account': { title: '账户与数据', subtitle: '管理邀请登录、数据保存与 Binance 连接边界。', kicker: 'ACCOUNT · DATA BOUNDARIES' },
});

function dataStateLabel(phase: string, analyticsReady: boolean): string {
  switch (phase) {
    case 'DEMO_READY': return '确定性样本 · 只读';
    case 'IMPORT_READY': return analyticsReady
      ? '本机导入 · 分析就绪'
      : '仅浏览净化记录 · 指标锁定';
    case 'BINANCE_CONNECTING': return '本机连接 · 同步中';
    case 'BINANCE_BROWSE_ONLY': return '仅浏览净化记录 · 指标锁定';
    case 'BINANCE_OBSERVED_READY': return '已观察对账 · 分析就绪';
    case 'BINANCE_EMPTY': return '已连接 · 暂无记录';
    case 'BINANCE_BLOCKED': return '证据不足 · 已阻断';
    default: return '状态待核验';
  }
}

function Shell() {
  const { session, sourceLabel, analyticsReady } = useStore();
  const auth = useAuth();
  const location = useLocation();
  const routeContext = ROUTE_CONTEXT[location.pathname] ?? ROUTE_CONTEXT['/today'];
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (
    localStorage.getItem('rv-theme') === 'light' ? 'light' : 'dark'
  ));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [todayAccountScope, setTodayAccountScope] = useState<TodayAccountScope>('all');
  const todayAccountLabel = TODAY_ACCOUNT_SCOPES.find((scope) => scope.id === todayAccountScope)?.label
    ?? TODAY_ACCOUNT_SCOPES[0].label;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('rv-theme', theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink className="brand-lockup" to="/today" aria-label="Binance 合约复盘助手首页">
          <span className="brand-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17l5-5 4 3 7-8M14 4h5v5" />
            </svg>
          </span>
          <span><strong>复盘工作台</strong><small>BINANCE · FUTURES</small></span>
        </NavLink>
        {location.pathname === '/today' && (
          <div className="workspace-switch" role="group" aria-label="今日账户范围">
            {TODAY_ACCOUNT_SCOPES.map((scope) => (
              <button
                aria-controls="flagship-today"
                aria-label={scope.label}
                aria-pressed={todayAccountScope === scope.id}
                className={todayAccountScope === scope.id ? 'active' : ''}
                key={scope.id}
                onClick={() => setTodayAccountScope(scope.id)}
                type="button"
              >
                {scope.short}
              </button>
            ))}
          </div>
        )}
        <nav className="primary-nav" aria-label="主导航">
          {WORKBENCH_NAV.map((item) => (
            <NavLink
              aria-label={item.label}
              data-group={item.group}
              key={item.to}
              to={item.to}
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              <NavIcon route={item.to} /><strong>{item.label}</strong>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="read-only-mark">REVIEW LOOP · LOCAL FIRST</span>
          <p>CSV/.fupan 在本机解析；仅启用邀请 Beta 时，Key/Secret 才会进入服务器加密保存。<br />只读同步，不提供下单。</p>
          <span className="build-mark">WEB BUILD {BUILD_SHA}</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="workspace-bar" aria-label="应用工作台">
          <div className="mobile-brand">
            <span>↗</span>
            <strong>复盘工作台<small>BINANCE · FUTURES</small></strong>
          </div>
          <div className="route-context">
            <small>{routeContext.kicker}</small>
            <div className="route-title-line">
              {location.pathname === '/today'
                ? <h1 className="route-title">{routeContext.title}</h1>
                : <strong className="route-title">{routeContext.title}</strong>}
              <span className="route-scope">{location.pathname === '/today' ? todayAccountLabel : '当前工作区'}</span>
            </div>
            <p>{routeContext.subtitle}</p>
          </div>
          <div className="bar-actions">
            <div className="source-chip" aria-label={`数据状态：${sourceLabel}，${dataStateLabel(session.phase, analyticsReady)}`}>
              <span className={`status-light ${session.phase.toLowerCase()}`} />
              <div>
                <strong>{sourceLabel}</strong>
                <span className="source-state">{dataStateLabel(session.phase, analyticsReady)}</span>
              </div>
            </div>
            {session.source === 'demo' && <span className="synthetic-chip">合成演示 · 非真实收益</span>}
            <NavLink className="coach-link" to="/coach" aria-label="复盘教练">✦ AI 速评</NavLink>
            <NavLink className="account-link" to="/account">{auth.session ? '账户已登录' : '登录 / 账户'}</NavLink>
            <button
              className="theme-toggle"
              type="button"
              aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☼' : '◐'}
            </button>
          </div>
        </header>

        <main className="workspace-content">
          <Routes>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<TodayView accountScope={todayAccountScope} />} />
            <Route path="/overview" element={<WorkbenchView mode="overview" />} />
            <Route path="/trades" element={<TradesView />} />
            <Route path="/attribution" element={<WorkbenchView mode="attribution" />} />
            <Route path="/context" element={<WorkbenchView mode="context" />} />
            <Route path="/r" element={<WorkbenchView mode="r" />} />
            <Route path="/playbook" element={<WorkbenchView mode="playbook" />} />
            <Route path="/ritual" element={<ReviewLoopView mode="ritual" />} />
            <Route path="/calendar" element={<WorkbenchView mode="calendar" />} />
            <Route path="/replay" element={<WorkbenchView mode="replay" />} />
            <Route path="/coach" element={<WorkbenchView mode="coach" />} />
            <Route path="/experiments" element={<WorkbenchView mode="experiments" />} />
            <Route path="/reports" element={<ReportsView />} />
            <Route path="/compare" element={<WorkbenchView mode="compare" />} />
            <Route path="/goals" element={<WorkbenchView mode="goals" />} />
            <Route path="/analytics" element={<AnalyticsView />} />
            <Route path="/data" element={<DataView />} />
            <Route path="/account" element={<AccountView />} />
            <Route path="/import" element={<Navigate to="/data" replace />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </main>

        {mobileMenuOpen && (
          <nav id="mobile-all-features" className="mobile-more-menu" aria-label="移动端全部功能">
            <div className="mobile-more-head"><strong>全部 17 项功能</strong><button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="关闭全部功能">×</button></div>
            <div className="mobile-more-grid">
              {WORKBENCH_NAV.map((item) => (
                <NavLink aria-label={item.label} key={item.to} to={item.to} onClick={() => setMobileMenuOpen(false)}>
                  <NavIcon route={item.to} /><strong>{item.label}</strong>
                </NavLink>
              ))}
            </div>
          </nav>
        )}
        <nav className="mobile-nav" aria-label="移动端主导航">
          {MOBILE_NAV.map((item) => (
            <NavLink aria-label={item.label} key={item.to} to={item.to} className={({ isActive }) => isActive ? 'active' : ''}>
              <NavIcon route={item.to} /><strong>{item.label}</strong>
            </NavLink>
          ))}
          <button type="button" aria-expanded={mobileMenuOpen} aria-controls="mobile-all-features" onClick={() => setMobileMenuOpen((current) => !current)}>
            <span>••</span><strong>更多</strong>
          </button>
        </nav>
      </div>
    </div>
  );
}

export default function App() {
  if (!runtimeOriginMatches(EXPECTED_APP_ORIGIN, window.location.origin)) {
    return (
      <main className="workspace-content" role="alert">
        <section className="panel account-panel">
          <p className="eyebrow">ORIGIN BINDING FAILED</p>
          <h1>此构建没有运行在核验过的生产地址。</h1>
          <p>为避免把登录或加密工作区连接到错误站点，应用已停止加载。请从正式产品入口重新打开。</p>
        </section>
      </main>
    );
  }
  return (
    <AuthProvider>
      <WorkspaceProvider>
        <StoreProvider>
          <HashRouter><Shell /></HashRouter>
        </StoreProvider>
      </WorkspaceProvider>
    </AuthProvider>
  );
}
