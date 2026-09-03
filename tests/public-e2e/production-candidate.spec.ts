import { expect, test, type Download } from '@playwright/test';
import { exportArchive, parseStatement } from '../../frontend/engine.js';

const SYNTHETIC_CSV = `Date(UTC),Symbol,Side,Price,Quantity,Total,Fee,Fee Coin,Realized Profit
2026-06-01 09:15:00,BTCUSDT,BUY,67520,0.018,1215.36,0.61,USDT,0
2026-06-01 11:42:00,BTCUSDT,SELL,68180,0.018,1227.24,0.62,USDT,10.66
2026-06-01 14:10:00,ETHUSDT,BUY,3560,0.42,1495.20,0.75,USDT,0
2026-06-01 17:35:00,ETHUSDT,SELL,3508,0.42,1473.36,0.74,USDT,-22.58
2026-06-02 10:05:00,SOLUSDT,BUY,166.4,7,1164.80,0.58,USDT,0
2026-06-02 12:22:00,SOLUSDT,SELL,171.9,7,1203.30,0.60,USDT,37.90
2026-06-02 18:20:00,BTCUSDT,SELL,69010,0.012,828.12,0.41,USDT,0
2026-06-02 21:05:00,BTCUSDT,BUY,68640,0.012,823.68,0.41,USDT,3.62
2026-06-03 09:30:00,ETHUSDT,SELL,3622,0.35,1267.70,0.63,USDT,0
2026-06-03 11:18:00,ETHUSDT,BUY,3650,0.35,1277.50,0.64,USDT,-10.44`;

const NO_REPORTED_PNL_CSV = `Date(UTC),Symbol,Side,Price,Quantity,Total,Fee,Fee Coin
2026-06-04 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,USDT
2026-06-04 10:00:00,BTCUSDT,SELL,68600,0.01,686,0.27,USDT`;

async function readDownload(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('built candidate enforces headers, metrics evidence gate, demo isolation and zero egress', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const thirdPartyRequests = new Set<string>();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.origin !== 'http://127.0.0.1:4175' && !['data:', 'blob:'].includes(url.protocol)) {
      thirdPartyRequests.add(url.href);
    }
  });

  const documentResponse = await request.get('http://127.0.0.1:4175/');
  expect(documentResponse.ok()).toBe(true);
  expect(documentResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(documentResponse.headers()['x-frame-options']).toBe('DENY');
  expect(documentResponse.headers()['cross-origin-opener-policy']).toBe('same-origin');
  expect(documentResponse.headers()['referrer-policy']).toBe('no-referrer');
  const releaseResponse = await request.get('http://127.0.0.1:4175/release.json');
  expect(await releaseResponse.json()).toMatchObject({
    format: 'rv-web-release/1',
    product: 'Binance Futures Review Web',
    mode: 'local-demo',
    backendProjectRef: null,
  });

  await page.goto('/');
  await expect(page).toHaveTitle('Binance 合约复盘助手');
  await expect(page.getByRole('heading', { name: '今日速览' })).toBeVisible();
  await expect(page.getByRole('region', { name: '今日速览操作台' })).toBeVisible();
  const flagship = page.locator('[data-visual-lineage="classic-dc-v1-final"]');
  await expect(flagship).toBeVisible();
  await expect(page.getByRole('status')).toContainText('确定性样本 · 可完整演示');
  await expect(page.getByText('数据为确定性样本 · 非实盘收益')).toBeVisible();
  await expect(page.getByText(/把每一笔合约/)).toHaveCount(0);
  const demoTradeQueue = page.getByRole('region', { name: '样本日交易' });
  await expect(demoTradeQueue).toBeVisible();
  expect(await demoTradeQueue.locator('.today-trade-row:not(.today-trade-head)').count()).toBeGreaterThanOrEqual(2);
  expect((await demoTradeQueue.boundingBox())?.y).toBeLessThan(900);
  const deepLinkTarget = demoTradeQueue.getByRole('link', { name: /^复盘 / }).nth(1);
  const deepLinkLabel = await deepLinkTarget.getAttribute('aria-label');
  expect(deepLinkLabel).toBeTruthy();
  await deepLinkTarget.click();
  await expect(page).toHaveURL(/#\/trades\?tradeId=[^&]+$/u);
  await expect(page.getByRole('button', { name: '全部' })).toHaveClass(/active/u);
  await expect(page.getByRole('heading', {
    name: deepLinkLabel!.replace(/^复盘 /u, '').replace(/ (做多|做空)$/u, ' · $1'),
  })).toBeVisible();
  await page.getByRole('link', { name: '今日速览', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link')).toHaveCount(17);
  const accountTabs = page.getByRole('group', { name: '今日账户范围' });
  await expect(accountTabs.getByRole('button')).toHaveCount(3);
  await expect(accountTabs.getByRole('button', { name: '全部账户' })).toHaveAttribute('aria-pressed', 'true');
  const allAccountStatus = await page.getByRole('status').textContent();
  await accountTabs.getByRole('button', { name: '训练账户' }).click();
  await expect(flagship).toHaveAttribute('data-account-scope', 'training');
  await expect(accountTabs.getByRole('button', { name: '训练账户' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.getByRole('status').textContent()).not.toBe(allAccountStatus);
  await page.getByRole('link', { name: '开始过卡' }).click();
  await expect(page).toHaveURL(/#\/trades\?account=training$/u);
  await expect(page.getByText(/训练账户 · \d+ 笔已复盘 · 9 笔当前范围/u)).toBeVisible();
  await expect(page.locator('.trade-list-row')).toHaveCount(9);
  await page.getByRole('link', { name: '今日速览', exact: true }).click();
  await expect(flagship).toHaveAttribute('data-account-scope', 'training');
  await page.getByRole('group', { name: '今日账户范围' }).getByRole('button', { name: '全部账户' }).click();
  await expect(flagship).toHaveAttribute('data-account-scope', 'all');
  const visualLineage = await page.evaluate(() => {
    const readBox = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`missing visual-lineage element: ${selector}`);
      const box = element.getBoundingClientRect();
      return { height: box.height, top: box.top, width: box.width };
    };
    const cta = document.querySelector<HTMLElement>('.today-primary-cta');
    const card = document.querySelector<HTMLElement>('.today-command-card');
    if (!cta || !card) throw new Error('missing flagship Today visual targets');
    const ctaStyle = getComputedStyle(cta);
    const cardStyle = getComputedStyle(card);
    const bodyStyle = getComputedStyle(document.body);
    return {
      sidebar: readBox('.sidebar'),
      workspaceBar: readBox('.workspace-bar'),
      commandCard: readBox('.today-command-card'),
      content: readBox('.workspace-content'),
      commandCardRadius: Number.parseFloat(cardStyle.borderRadius),
      ctaBackgroundColor: ctaStyle.backgroundColor,
      ctaBackgroundImage: ctaStyle.backgroundImage,
      bodyBackgroundImage: bodyStyle.backgroundImage,
      bodyBackgroundSize: bodyStyle.backgroundSize,
      numberedNavigation: [...document.querySelectorAll('.primary-nav a')].some((link) => (
        /^\d{2}$/u.test(link.querySelector('span')?.textContent?.trim() ?? '')
      )),
    };
  });
  expect(visualLineage.sidebar.width).toBeGreaterThanOrEqual(218);
  expect(visualLineage.sidebar.width).toBeLessThanOrEqual(226);
  expect(visualLineage.workspaceBar.height).toBeGreaterThanOrEqual(62);
  expect(visualLineage.workspaceBar.height).toBeLessThanOrEqual(66);
  expect(visualLineage.commandCard.top).toBeLessThan(110);
  expect(visualLineage.commandCardRadius).toBeGreaterThanOrEqual(17);
  expect(visualLineage.commandCardRadius).toBeLessThanOrEqual(19);
  expect(visualLineage.content.width).toBeLessThanOrEqual(1181);
  expect(visualLineage.ctaBackgroundImage).toContain('linear-gradient');
  expect(visualLineage.ctaBackgroundColor).not.toBe('rgb(240, 185, 11)');
  expect(visualLineage.bodyBackgroundImage).not.toContain('repeating-linear-gradient');
  expect(visualLineage.bodyBackgroundSize).not.toBe('32px 32px');
  expect(visualLineage.numberedNavigation).toBe(false);
  await page.getByRole('button', { name: '切换浅色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightTheme = await page.evaluate(() => {
    const tradesPanel = document.querySelector<HTMLElement>('.today-trades-panel');
    const processCopy = document.querySelector<HTMLElement>('.today-process');
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    if (!tradesPanel || !processCopy || !sidebar) throw new Error('missing light-theme visual target');
    return {
      panelBackground: getComputedStyle(tradesPanel).backgroundImage,
      processColor: getComputedStyle(processCopy).color,
      sidebarBackground: getComputedStyle(sidebar).backgroundImage,
    };
  });
  expect(lightTheme.panelBackground).not.toContain('rgb(26, 24, 34)');
  expect(lightTheme.sidebarBackground).not.toContain('rgb(35, 32, 26)');
  expect(lightTheme.processColor).toBe('rgb(23, 24, 23)');
  await page.getByRole('button', { name: '切换深色主题' }).click();
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'self'");

  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  await page.locator('#rv2file').setInputFiles({
    name: 'missing-reported-pnl.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(NO_REPORTED_PNL_CSV, 'utf8'),
  });
  await expect(page.getByRole('heading', { name: '当前不计算分析指标' })).toBeVisible();
  await expect(page.getByRole('region', { name: '净化成交预览' })).toBeVisible();
  await page.getByRole('link', { name: '今日速览', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/本地导入范围 · 接受 \d+ · 丢弃 \d+/u);
  await page.getByRole('link', { name: '深度洞察', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分析指标暂未解锁' })).toBeVisible();
  await expect(page.getByText('PNL_NOT_REPORTED', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  await page.getByRole('button', { name: '一键清除本浏览器复盘数据' }).click();
  await expect(page.getByText(/恢复通道已重新就绪/)).toBeVisible();
  await page.locator('#rv2file').setInputFiles({
    name: 'synthetic-binance-futures.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(SYNTHETIC_CSV, 'utf8'),
  });
  await expect(page.getByText(/5 笔已平仓/)).toBeVisible();
  await page.getByRole('link', { name: '深度洞察', exact: true }).click();
  await expect(page.getByRole('heading', { name: '分析指标暂未解锁' })).toHaveCount(0);

  await page.reload();
  await page.getByRole('link', { name: '今日速览', exact: true }).click();
  await expect(page.getByRole('region', { name: '样本日交易' })).toBeVisible();
  await expect(page.getByText(/5 笔已平仓/)).not.toBeVisible();
  expect(pageErrors).toEqual([]);
  expect([...thirdPartyRequests]).toEqual([]);

  let blockedRouteReached = false;
  await page.route('https://blocked.example.test/**', async (route) => {
    blockedRouteReached = true;
    await route.abort();
  });
  await expect(page.evaluate(async () => {
    try {
      await fetch('https://blocked.example.test/probe');
      return false;
    } catch {
      return true;
    }
  })).resolves.toBe(true);
  expect(blockedRouteReached).toBe(false);
});

test('built candidate closes the review loop, restores it, and rejects altered backups', async ({ page }) => {
  test.setTimeout(120_000);
  const externalRequests = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4175' && !['data:', 'blob:'].includes(url.protocol)) {
      externalRequests.add(url.href);
    }
  });

  await page.goto('/');
  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  await page.locator('#rv2file').setInputFiles({
    name: 'closed-loop-binance-futures.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(SYNTHETIC_CSV, 'utf8'),
  });
  await expect(page.getByText(/5 笔已平仓/)).toBeVisible();

  await page.getByRole('link', { name: '复盘卡', exact: true }).click();
  await page.getByLabel('当时看到了什么？').fill('价格回踩结构支撑，成交量缩小。');
  await page.getByLabel('实际发生了什么？').fill('按计划进场，未加仓，目标位退出。');
  await page.getByLabel('下一次只改哪一件事？').fill('进场前先记录失效位再执行。');
  await page.getByRole('button', { name: '保存并下一笔' }).click();
  await expect.poll(() => page.evaluate(() => (
    [...Array.from({ length: localStorage.length }, (_value, index) => localStorage.key(index))]
      .filter((key): key is string => key?.startsWith('rv-review-v1:') === true)
      .map((key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')).length)
      .reduce((sum, count) => sum + count, 0)
  ))).toBe(1);

  await page.getByRole('link', { name: '行为实验室', exact: true }).click();
  const experimentCard = page.getByRole('article', { name: '行为实验：进场前先记录失效位再执行。' });
  await expect(experimentCard).toBeVisible();
  await experimentCard.getByLabel('可检验假设').fill('若出现入场机会，我会先写下失效位再执行。');
  await experimentCard.getByLabel('至少执行次数').fill('1');
  await experimentCard.getByLabel('目标机会数').fill('1');
  const experimentDay = await experimentCard.getByLabel('开始日期').inputValue();
  await experimentCard.getByLabel('结束日期').fill(experimentDay);
  await experimentCard.getByRole('button', { name: '开始实验并持久化' }).click();
  await expect(experimentCard.getByText('0/1 次观察 · 0 次执行')).toBeVisible();
  await experimentCard.getByLabel('观察日期').fill(experimentDay);
  await experimentCard.getByLabel('动作结果').selectOption('yes');
  await experimentCard.getByLabel('证据说明').fill('复盘记录显示，入场前已在检查表写明失效位。');
  await experimentCard.getByRole('button', { name: '保存本次观察' }).click();
  await expect(experimentCard.getByText('达到预设执行标准')).toBeVisible();
  await experimentCard.getByLabel('实验决策').selectOption('adopt');
  await experimentCard.getByLabel('结论与限制').fill('本次 1/1 按计划执行；样本仅证明动作被执行，不证明盈亏改善。');
  await experimentCard.getByRole('button', { name: '保存决策并闭环' }).click();
  await expect(experimentCard.locator('.experiment-decision')).toContainText('保留动作');

  await page.getByRole('link', { name: '今日仪式', exact: true }).click();
  await page.getByLabel('今日状态').fill('冷静');
  await page.getByLabel('复盘日志').fill('闭环恢复验证日志：执行计划一致，下一次仍先确认失效条件。');
  await page.getByRole('button', { name: '保存今日日志' }).click();
  await expect(page.getByRole('status')).toHaveText('今日日志已保存');
  await page.getByLabel('新增风控守则').fill('闭环恢复验证守则：达到当日最大亏损后停止新增交易。');
  await page.getByRole('button', { name: '添加守则' }).click();
  await expect(page.getByText('闭环恢复验证守则：达到当日最大亏损后停止新增交易。')).toBeVisible();

  await page.getByRole('link', { name: '周报月报', exact: true }).click();
  await page.getByLabel('我知道下载后的文件不再受云仓端到端加密保护').check();
  const bindingBackupPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整备份' }).click();
  const bindingBackup = JSON.parse(await readDownload(await bindingBackupPromise));
  const reviewedTradeIds = new Set(Object.keys(bindingBackup.reviews));
  const classicTrade = (bindingBackup.archive.trades as Array<{ id?: unknown; symbol?: unknown }>).find((trade) => (
    typeof trade.id === 'string' && !reviewedTradeIds.has(trade.id)
  ));
  expect(classicTrade).toEqual(expect.objectContaining({ id: expect.any(String), symbol: expect.any(String) }));
  if (!classicTrade || typeof classicTrade.id !== 'string') throw new Error('NO_UNREVIEWED_TRADE_FOR_CLASSIC_MIGRATION');
  const classicExport = JSON.stringify({
    format: 'rv-classic-review-export/1',
    reviews: [{
      tradeId: String(classicTrade.id),
      saw: 'Classic 记录：冲高后量能衰减。',
      did: 'Classic 记录：等待确认后执行。',
      learn: 'Classic 迁移教训：等待收线后再执行。',
      grade: 'B',
      reviewed: true,
    }],
    riskLimits: { maxLoss: 325, maxTrades: 4, maxRiskR: 1.25 },
  });
  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  const migration = page.getByRole('region', { name: 'Classic 复盘迁移' });
  await migration.getByLabel('选择 Classic 复盘导出文件').setInputFiles({
    name: 'classic-reviews.rvlegacy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(classicExport, 'utf8'),
  });
  await expect(migration.getByText('Classic 迁移教训：等待收线后再执行。')).toBeVisible();
  await expect(migration.getByText(/maxLoss 325；maxTrades 4；maxRiskR 1.25/)).toBeVisible();
  await migration.getByRole('checkbox', { name: /^选择 / }).check();
  await migration.getByRole('checkbox', { name: /我确认该 Classic 导出属于当前账户/ }).check();
  await migration.getByRole('button', { name: '迁移已选择的 1 笔复盘' }).click();
  await expect(migration.getByRole('status')).toContainText('迁移完成：新增 1 笔');

  await page.getByRole('link', { name: '周报月报', exact: true }).click();
  await expect(page.getByRole('heading', { name: '周报 / 月报' })).toBeVisible();
  await expect(page.getByText('复盘完成率')).toBeVisible();
  await expect(page.getByText('行动闭环')).toBeVisible();
  await page.getByLabel('我知道下载后的文件不再受云仓端到端加密保护').check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整备份' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^复盘完整备份-\d+\.rvbackup\.json$/);
  const backupText = await readDownload(download);
  const backup = JSON.parse(backupText);
  expect(backup).toMatchObject({
    format: 'rv-portable-backup/1',
    source: 'imported',
    scope: { kind: 'full-workspace' },
  });
  expect(Object.values(backup.reviews)).toEqual(expect.arrayContaining([
    expect.objectContaining({ lesson: '进场前先记录失效位再执行。', reviewed: true }),
    expect.objectContaining({ lesson: 'Classic 迁移教训：等待收线后再执行。', reviewed: true }),
  ]));
  const backedUpAction = Object.values(
    backup.actions as Record<string, { text?: unknown }>,
  ).find((candidate) => (
    candidate.text === '进场前先记录失效位再执行。'
  ));
  expect(backedUpAction).toMatchObject({
    status: 'done',
    experiment: {
      hypothesis: '若出现入场机会，我会先写下失效位再执行。',
      targetCount: 1,
      observedCount: 1,
      successfulCount: 1,
      successCriterion: 1,
      decision: 'adopt',
      evidenceNote: '本次 1/1 按计划执行；样本仅证明动作被执行，不证明盈亏改善。',
      observations: [{
        day: experimentDay,
        followed: true,
        evidenceNote: '复盘记录显示，入场前已在检查表写明失效位。',
      }],
    },
  });
  expect(backup.journal).toContainEqual(expect.objectContaining({
    emotion: '冷静',
    note: '闭环恢复验证日志：执行计划一致，下一次仍先确认失效条件。',
  }));
  expect(backup.guards).toContainEqual(expect.objectContaining({
    text: '闭环恢复验证守则：达到当日最大亏损后停止新增交易。',
    active: true,
  }));
  expect(backupText).not.toMatch(/access[_-]?token|refresh[_-]?token|recoveryCode|signingPrivateKey|person@example\.com/i);

  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  await page.getByRole('button', { name: '一键清除本浏览器复盘数据' }).click();
  await expect(page.getByText(/已清除 \d+ 项本浏览器复盘数据/)).toBeVisible();
  await page.getByRole('link', { name: '策略手册', exact: true }).click();
  await expect(page.getByText('进场前先记录失效位再执行。')).toHaveCount(0);
  await expect(page.getByText('Classic 迁移教训：等待收线后再执行。')).toHaveCount(0);

  await page.getByRole('link', { name: '数据中心', exact: true }).click();
  await page.locator('#rv2file').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/json',
    buffer: Buffer.from(backupText, 'utf8'),
  });
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('banner').getByText('CSV 导入', { exact: true })).toBeVisible();
  await expect(page.getByText(/5 笔已平仓/)).toBeVisible();
  await page.getByRole('link', { name: '复盘卡', exact: true }).click();
  await expect(page.getByText(/2 笔已复盘 · 5 笔当前范围/)).toBeVisible();
  await page.getByRole('link', { name: '策略手册', exact: true }).click();
  await expect(page.getByText('进场前先记录失效位再执行。')).toBeVisible();
  await expect(page.getByText('Classic 迁移教训：等待收线后再执行。')).toBeVisible();
  await page.getByRole('link', { name: '行为实验室', exact: true }).click();
  const restoredExperiment = page.getByRole('article', { name: '行为实验：进场前先记录失效位再执行。' });
  await expect(restoredExperiment.locator('.experiment-decision')).toContainText('保留动作');
  await expect(restoredExperiment).toContainText('复盘记录显示，入场前已在检查表写明失效位。');
  await expect(restoredExperiment).toContainText('本次 1/1 按计划执行；样本仅证明动作被执行，不证明盈亏改善。');
  await page.getByRole('link', { name: '今日仪式', exact: true }).click();
  await expect(page.getByText('闭环恢复验证日志：执行计划一致，下一次仍先确认失效条件。')).toBeVisible();
  await expect(page.getByText('闭环恢复验证守则：达到当日最大亏损后停止新增交易。')).toBeVisible();

  const restoredBrowserState = await page.evaluate(() => Array.from(
    { length: localStorage.length },
    (_value, index) => localStorage.key(index),
  ).filter((key): key is string => key !== null).sort().map((key) => [key, localStorage.getItem(key)]));

  const corruptedBackup = structuredClone(backup);
  const originalScopeDigest = corruptedBackup.archive.rvFillLedger.scopeDigest as string;
  corruptedBackup.archive.rvFillLedger.scopeDigest = `${originalScopeDigest[0] === 'a' ? 'b' : 'a'}${originalScopeDigest.slice(1)}`;
  const rangedBackup = structuredClone(backup);
  rangedBackup.scope = { from: '2026-06-01', to: '2026-06-03' };
  const sourceTamperedBackup = structuredClone(backup);
  sourceTamperedBackup.source = 'demo';
  const rejectedBackups = [
    ['damaged-ledger.rvbackup.json', corruptedBackup],
    ['range-scope.rvbackup.json', rangedBackup],
    ['source-tampered.rvbackup.json', sourceTamperedBackup],
  ] as const;

  for (const [name, rejected] of rejectedBackups) {
    await page.getByRole('link', { name: '数据中心', exact: true }).click();
    await page.locator('#rv2file').setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(rejected), 'utf8'),
    });
    await expect(page.getByRole('alert')).toContainText('PORTABLE_BACKUP_RESTORE_FAILED');
    await expect.poll(() => page.evaluate(() => Array.from(
      { length: localStorage.length },
      (_value, index) => localStorage.key(index),
    ).filter((key): key is string => key !== null).sort().map((key) => [key, localStorage.getItem(key)])))
      .toEqual(restoredBrowserState);
  }

  await page.getByRole('link', { name: '行为实验室', exact: true }).click();
  await expect(page.getByRole('article', { name: '行为实验：进场前先记录失效位再执行。' }))
    .toContainText('本次 1/1 按计划执行；样本仅证明动作被执行，不证明盈亏改善。');
  await page.getByRole('link', { name: '今日仪式', exact: true }).click();
  await expect(page.getByText('闭环恢复验证日志：执行计划一致，下一次仍先确认失效条件。')).toBeVisible();
  await expect(page.getByText('闭环恢复验证守则：达到当日最大亏损后停止新增交易。')).toBeVisible();
  expect([...externalRequests]).toEqual([]);
});

test('built candidate exposes all destinations without horizontal overflow on mobile', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今日速览' })).toBeVisible();
  await expect(page.getByRole('region', { name: '今日速览操作台' })).toBeVisible();
  await expect(page.locator('[data-visual-lineage="classic-dc-v1-final"]')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('确定性样本 · 可完整演示');
  const primaryReviewCta = page.getByRole('link', { name: '开始过卡' });
  await expect(primaryReviewCta).toBeVisible();
  expect((await primaryReviewCta.boundingBox())?.y).toBeLessThan(844);
  await expect.poll(() => page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ innerWidth: 390, scrollWidth: 390 });
  await expect(page.getByRole('navigation', { name: '移动端主导航' }).getByRole('link')).toHaveCount(4);
  await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeHidden();
  const labels = [
    '今日速览', '复盘总览', '复盘卡', '归因对标', '市场情境', 'R 复盘',
    '策略手册', '今日仪式', '交易日历', 'K线回放', 'AI 教练', '行为实验室',
    '周报月报', '对比复盘', '成长目标', '深度洞察', '数据中心',
  ];
  for (const label of labels) {
    await page.getByRole('button', { name: '更多' }).click();
    const allFeatures = page.getByRole('navigation', { name: '移动端全部功能' });
    await expect(allFeatures.getByRole('link')).toHaveCount(17);
    await allFeatures.getByRole('link', { name: label, exact: true }).click();
    await expect(allFeatures).toBeHidden();
    await expect.poll(() => page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))).toEqual({ innerWidth: 390, scrollWidth: 390 });
  }
});

test('real Chromium executes OTP client, PBKDF2/AES-GCM, Ed25519 and recovery backup round-trips', async ({ page }) => {
  test.setTimeout(90_000);
  const imported = parseStatement(SYNTHETIC_CSV, null);
  if (imported.error !== undefined) throw new Error(imported.error);
  const archive = exportArchive(imported.trades, imported.meta);

  await page.goto('http://127.0.0.1:4176/');
  const result = await page.evaluate(async (portableArchive) => {
    const auth = await import('/src/lib/auth-client.ts');
    const cryptoModule = await import('/src/lib/vault-crypto.ts');
    const signing = await import('/src/lib/vault-signing.ts');
    const recovery = await import('/src/lib/recovery-code.ts');
    const backup = await import('/src/lib/portable-backup.ts');

    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const projectRef = 'abcdefghijklmnopqrst';
    const supabaseOrigin = [`https://${projectRef}`, 'supabase', 'co'].join('.');
    const authClient = new auth.SupabaseAuthClient({
      supabaseUrl: supabaseOrigin,
      publishableKey: `sb_publishable_${'a'.repeat(24)}`,
    }, {
      fetchImpl: async (input, init = {}) => {
        const url = String(input);
        requests.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        });
        if (url.endsWith('/auth/v1/otp')) {
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          access_token: 'browser-access-token',
          refresh_token: 'browser-refresh-token',
          expires_in: 3600,
          user: { id: 'browser-user', email: 'person@example.com' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await authClient.sendEmailOtp('person@example.com');
    const session = await authClient.verifyEmailOtp('person@example.com', '123456');

    const recoveryCode = recovery.generateRecoveryCode();
    const keyPair = await signing.generateVaultSigningKeyPair();
    const kit = recovery.createRootRecoveryKit(
      '8b91ef76-3d75-48fc-8336-44e0a5c857e3',
      recoveryCode,
      keyPair.publicKeySpki,
      keyPair.privateKeyPkcs8,
      '2026-08-28T00:00:00.000Z',
    );
    const serializedKit = recovery.serializeRecoveryKit(kit);
    const restoredKit = recovery.parseRecoveryKit(serializedKit);
    const aad = {
      user: '8b91ef76-3d75-48fc-8336-44e0a5c857e3',
      workspace: 'primary',
      kind: 'workspace-snapshot',
      logicalKey: 'binance-usdm/main',
      generation: 1,
      schemaVersion: 1,
    };
    const payload = { trades: [{ id: 'browser-trade', pnl: 12.34, symbol: 'BTCUSDT' }] };
    const envelope = await cryptoModule.encryptVaultPayload(payload, recoveryCode, aad);
    const decrypted = await cryptoModule.decryptVaultPayload(envelope, recoveryCode, aad);

    const portable = backup.createPortableBackup({
      source: 'imported',
      archive: portableArchive,
      reviews: {},
      actions: {},
      journal: [{ day: '2026-08-28', note: '浏览器闭环', emotion: '冷静', updatedAt: 100 }],
      guards: [{ id: 'browser-guard', text: '触及日损上限后停止交易', active: true, createdAt: 100, updatedAt: 100 }],
    }, { kind: 'full-workspace' }, 200);
    const restoredBackup = backup.parsePortableBackup(backup.serializePortableBackup(portable));

    return {
      requests,
      sessionUser: session.userId,
      kdfIterations: envelope.kdf.iterations,
      decrypted,
      recoveryFormat: restoredKit.format,
      signingAlgorithm: restoredKit.format === 'rv-recovery-kit/2' ? restoredKit.signingAlgorithm : null,
      backupGeneration: restoredBackup.generation,
      backupJournal: restoredBackup.journal[0]?.note,
      backupGuard: restoredBackup.guards[0]?.text,
      serializedKit,
    };
  }, archive);

  const testSupabaseOrigin = ['https://abcdefghijklmnopqrst', 'supabase', 'co'].join('.');
  expect(result.requests).toEqual([
    {
      url: `${testSupabaseOrigin}/auth/v1/otp`,
      method: 'POST',
      body: { email: 'person@example.com', create_user: false },
    },
    {
      url: `${testSupabaseOrigin}/auth/v1/verify`,
      method: 'POST',
      body: { email: 'person@example.com', token: '123456', type: 'email' },
    },
  ]);
  expect(result.sessionUser).toBe('browser-user');
  expect(result.kdfIterations).toBe(600_000);
  expect(result.decrypted).toEqual({ trades: [{ id: 'browser-trade', pnl: 12.34, symbol: 'BTCUSDT' }] });
  expect(result.recoveryFormat).toBe('rv-recovery-kit/2');
  expect(result.signingAlgorithm).toBe('ed25519-v1');
  expect(result.backupGeneration).toBe(1);
  expect(result.backupJournal).toBe('浏览器闭环');
  expect(result.backupGuard).toBe('触及日损上限后停止交易');
  expect(result.serializedKit).not.toContain('person@example.com');
});
