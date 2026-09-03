import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { WORKBENCH_NAV } from './navigation';
import { selectTodayEvidenceDay } from './views/TodayView';

const SYNTHETIC_CSV = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,0
2026-06-01 10:00:00,BTCUSDT,SELL,68600,0.01,686,0.27,6
2026-06-02 09:00:00,ETHUSDT,SELL,3600,0.2,720,0.29,0
2026-06-02 10:00:00,ETHUSDT,BUY,3550,0.2,710,0.28,10`;

const PARTIAL_CSV = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,0
BAD,BTCUSDT,SELL,68600,0.01,686,0.27,6
2026-06-02 09:00:00,ETHUSDT,SELL,3600,0.2,720,0.29,0
2026-06-02 10:00:00,ETHUSDT,BUY,3550,0.2,710,0.28,10`;

const NO_PNL_CSV = `time,symbol,side,price,qty
2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01
2026-06-01 10:00:00,BTCUSDT,SELL,68600,0.01`;

describe('Binance futures review assistant shell', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = '';
  });

  it('rejects a batch with dropped rows without replacing the current session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('link', { name: '数据中心' }));
    fireEvent.change(screen.getByPlaceholderText(/把表格内容/), {
      target: { value: PARTIAL_CSV },
    });
    await user.click(screen.getByRole('button', { name: '解析并切换到导入数据' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/data');
      expect(screen.getByRole('alert')).toHaveTextContent(/本批存在丢弃行或错误行.*整批完整.*拒绝写入/);
      expect(screen.getAllByText(/合成演示/).length).toBeGreaterThan(0);
    }, { timeout: 5_000 });
  });

  it('does not calculate PnL metrics when the imported source never reported PnL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('link', { name: '数据中心' }));
    fireEvent.change(screen.getByPlaceholderText(/把表格内容/), {
      target: { value: NO_PNL_CSV },
    });
    await user.click(screen.getByRole('button', { name: '解析并切换到导入数据' }));

    await waitFor(() => {
      expect(window.location.hash).toBe('#/today');
      expect(screen.getByText(/没有可靠的已实现盈亏字段/)).toBeInTheDocument();
      expect(screen.getByLabelText('数据状态：CSV 导入，仅浏览净化记录 · 指标锁定')).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(screen.getByRole('region', { name: '今日速览操作台' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '当前不计算分析指标' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '净化成交预览' })).toBeInTheDocument();
    expect(screen.queryByText(/把每一笔合约/)).not.toBeInTheDocument();
    expect(screen.queryByText('利润因子')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '深度洞察' }));
    expect(screen.getByText(/导入文件未提供可验证的已实现盈亏/)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'R 复盘' }));
    expect(screen.getByRole('region', { name: 'R 指标待解锁' })).toBeInTheDocument();
    expect(screen.queryByText('累计 R')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '复盘卡' }));
    expect(screen.queryByRole('button', { name: '盈利' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '亏损' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^[-+]\$\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^[-+]?\d+(?:\.\d+)?R$/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '交易日历' }));
    expect(screen.getByRole('heading', { name: '交易日历' })).toBeInTheDocument();
    expect(screen.getByText(/笔已复盘/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ 胜/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '周报月报' }));
    expect(screen.getByText('胜负指标未解锁')).toBeInTheDocument();
    expect(screen.queryByText(/\d+ 胜 \/ \d+ 负/)).not.toBeInTheDocument();
  });

  it('opens a complete synthetic demo with the 17-entry workbench and zero requests', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    localStorage.setItem('rv2-session', '{"legacy":"must-not-autoload"}');

    render(<App />);

    expect(screen.getAllByText(/合成演示/).length).toBeGreaterThan(0);
    const workbenchBar = screen.getByRole('banner', { name: '应用工作台' });
    expect(within(workbenchBar).getByText('今日速览')).toBeInTheDocument();
    expect(within(workbenchBar).getByText('打开 3 秒，看发生了什么、还欠几笔复盘。')).toBeInTheDocument();
    expect(screen.getByLabelText('数据状态：合成演示，确定性样本 · 只读')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '复盘教练' })).toHaveAttribute('href', '#/coach');
    expect(screen.getByRole('region', { name: '今日速览操作台' })).toBeInTheDocument();
    expect(screen.getByText('RISK & DISCIPLINE · 事实记录')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '样本日交易' })).toBeInTheDocument();
    expect(screen.queryByText(/把每一笔合约/)).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getAllByRole('link')).toHaveLength(17);
    for (const label of [
      '今日速览', '复盘总览', '复盘卡', '归因对标', '市场情境', 'R 复盘',
      '策略手册', '今日仪式', '交易日历', 'K线回放', 'AI 教练', '行为实验室',
      '周报月报', '对比复盘', '成长目标', '深度洞察', '数据中心',
    ]) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByText('还没有交易数据')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('opens every desktop entry as a populated workbench route', async () => {
    const user = userEvent.setup();
    render(<App />);
    const nav = screen.getByRole('navigation', { name: '主导航' });
    const main = screen.getByRole('main');

    for (const item of WORKBENCH_NAV) {
      await user.click(within(nav).getByRole('link', { name: item.label }));
      expect(window.location.hash).toBe(`#${item.to}`);
      expect(within(screen.getByRole('banner', { name: '应用工作台' })).getByText(item.label)).toBeInTheDocument();
      expect(main.textContent?.trim().length).toBeGreaterThan(80);
    }
  }, 30_000);

  it('routes playbook and Beijing calendar to their real workbench surfaces while ritual stays the journal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: '策略手册' }));
    expect(screen.getByRole('heading', { name: '策略手册' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '已提炼的教训' })).toBeInTheDocument();
    expect(screen.queryByLabelText('复盘日志')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '交易日历' }));
    expect(screen.getByRole('heading', { name: '交易日历' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '最近有交易的日期' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '今日仪式' }));
    expect(screen.getByLabelText('复盘日志')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '今日日志' })).toBeInTheDocument();
  });

  it('identifies the Binance Futures workbench and keeps credentials off the public page', async () => {
    const user = userEvent.setup();
    render(<App />);

    const brand = screen.getByRole('link', { name: 'Binance 合约复盘助手首页' });
    expect(within(brand).getByText('BINANCE · FUTURES')).toBeInTheDocument();
    expect(screen.getAllByText(/^WEB BUILD /).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('link', { name: '数据中心' }));

    expect(screen.getByRole('heading', { name: '网页端先验证数据，再进入复盘。' })).toBeInTheDocument();
    const boundary = screen.getByRole('region', { name: '网页版能力边界' });
    expect(within(boundary).getByText(/CSV \/ \.fupan 只在浏览器内存解析/)).toBeInTheDocument();
    expect(within(boundary).getByText(/解锁后保存端到端加密复盘快照/)).toBeInTheDocument();
    expect(screen.getByText(/公网产品不接收、不保存、也不发送 Binance API Key/)).toBeInTheDocument();
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  });

  it('clears saved browser reviews from the privacy control', async () => {
    const user = userEvent.setup();
    localStorage.setItem('rv-review-v1:demo-scope', '{"trade-1":{"saw":"saved"}}');
    render(<App />);

    await user.click(screen.getByRole('link', { name: '数据中心' }));
    await user.click(screen.getByRole('button', { name: '一键清除本浏览器复盘数据' }));

    expect(await screen.findByText('已清除 1 项本浏览器复盘数据，恢复通道已重新就绪')).toBeInTheDocument();
    expect(localStorage.getItem('rv-review-v1:demo-scope')).toBeNull();
  });

  it('imports deterministic CSV only after an explicit action', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: '数据中心' }));
    const textarea = screen.getByPlaceholderText(/把表格内容/);
    fireEvent.change(textarea, { target: { value: SYNTHETIC_CSV } });
    await user.click(screen.getByRole('button', { name: '解析并切换到导入数据' }));

    await waitFor(() => {
      expect(screen.getAllByText(/CSV 导入/).length).toBeGreaterThan(0);
    });
    expect(await screen.findByText(
      /2 笔已平仓/,
      {},
      { timeout: 5_000 },
    )).toBeInTheDocument();
    expect(localStorage.getItem('rv2-session')).toBeNull();
  });

  it('switches back to demo without carrying imported metrics or drafts', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: '数据中心' }));
    fireEvent.change(screen.getByPlaceholderText(/把表格内容/), {
      target: { value: SYNTHETIC_CSV },
    });
    await user.click(screen.getByRole('button', { name: '解析并切换到导入数据' }));
    await user.click(screen.getByRole('link', { name: '数据中心' }));
    await user.click(screen.getByRole('button', { name: '进入合成演示' }));

    expect(screen.getAllByText(/合成演示/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/CSV 导入 · 2 笔/)).not.toBeInTheDocument();
  });

  it('closes the review loop by carrying the lesson into the next-action desk', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: '复盘卡' }));
    await user.type(screen.getByLabelText(/当时看到了什么/), '价格回到计划区域');
    await user.type(screen.getByLabelText(/实际发生了什么/), '按计划进场但过早退出');
    await user.type(screen.getByLabelText(/下一次只改哪一件事/), '下一笔先写失效条件再进场');
    await user.click(screen.getByRole('button', { name: '保存并下一笔' }));
    await user.click(screen.getByRole('link', { name: '今日速览' }));

    const action = screen.getByRole('link', { name: '打开行为实验：下一笔先写失效条件再进场' });
    expect(action).toBeInTheDocument();
    await user.click(action);
    expect(screen.getByRole('heading', { name: '行为实验室' })).toBeInTheDocument();
    expect(screen.getByLabelText('可检验假设')).toHaveValue('若出现执行机会，我将按计划做到“下一笔先写失效条件再进场”');
    expect(screen.getByText(/只检验这一个动作是否按计划执行/)).toBeInTheDocument();
  });

  it('selects the newest evidence day across closed trades and raw records', () => {
    const olderTrade = Date.parse('2026-08-01T00:00:00.000Z');
    const newerRecord = Date.parse('2026-08-15T00:00:00.000Z');
    const todayRecord = Date.parse('2026-08-30T00:00:00.000Z');

    expect(selectTodayEvidenceDay(
      '2026-08-30',
      [{ exitTime: olderTrade }],
      [{ time: newerRecord }],
    )).toBe('2026-08-15');
    expect(selectTodayEvidenceDay(
      '2026-08-30',
      [{ exitTime: olderTrade }],
      [{ time: todayRecord }],
    )).toBe('2026-08-30');
  });

  it('deep-links a Today trade and reopens that exact trade after it is reviewed', async () => {
    const user = userEvent.setup();
    render(<App />);

    const todayQueue = screen.getByRole('region', { name: '样本日交易' });
    const targetLink = within(todayQueue).getAllByRole('link', { name: /^复盘 / })[0];
    const targetLabel = targetLink.getAttribute('aria-label');
    expect(targetLabel).toBeTruthy();
    const editorHeading = targetLabel!
      .replace(/^复盘 /, '')
      .replace(/ (做多|做空)$/u, ' · $1');

    await user.click(targetLink);
    expect(window.location.hash).toMatch(/^#\/trades\?tradeId=[^&]+$/u);
    const tradeId = new URLSearchParams(window.location.hash.split('?')[1]).get('tradeId');
    expect(tradeId).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部' })).toHaveClass('active');
    expect(screen.getByRole('heading', { name: editorHeading })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(tradeId!);

    await user.type(screen.getByLabelText(/当时看到了什么/), '按计划等待信号');
    await user.type(screen.getByLabelText(/实际发生了什么/), '按计划执行并退出');
    await user.type(screen.getByLabelText(/下一次只改哪一件事/), '保持同一条执行标准');
    await user.click(screen.getByRole('button', { name: '保存并下一笔' }));
    await waitFor(() => {
      expect(localStorage.getItem('rv-review-v1:demo-v1')).toContain(`"${tradeId}"`);
    });

    await user.click(screen.getByRole('link', { name: '今日速览' }));
    const reviewedLink = within(
      screen.getByRole('region', { name: '样本日交易' }),
    ).getByRole('link', { name: targetLabel! });
    expect(within(reviewedLink).getByText('已复盘')).toBeInTheDocument();

    await user.click(reviewedLink);
    expect(window.location.hash).toBe(`#/trades?tradeId=${encodeURIComponent(tradeId!)}`);
    expect(screen.getByRole('button', { name: '全部' })).toHaveClass('active');
    expect(screen.getByRole('heading', { name: editorHeading })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(tradeId!);
  });
});
