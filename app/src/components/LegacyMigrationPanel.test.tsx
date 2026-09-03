import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LegacyMigrationPanel from './LegacyMigrationPanel';
import type { LegacyReviewMigrationReceipt } from '../lib/legacy-review-migration';

const context = {
  source: 'imported' as const,
  reviewScope: 'import-v2-safe-scope',
  trades: [{ id: 'trade-1', symbol: 'BTCUSDT', entryTime: 1_700_000_000_000 }],
  reviews: {},
};

const receipt: LegacyReviewMigrationReceipt = {
  format: 'rv-classic-review-migration-receipt/1',
  sourceHash: 'a'.repeat(64),
  bindingHash: 'b'.repeat(64),
  selectionHash: 'c'.repeat(64),
  resultHash: 'd'.repeat(64),
  selectedCount: 1,
  insertedCount: 1,
  skippedExistingCount: 0,
};

describe('Classic review migration panel', () => {
  beforeEach(() => localStorage.clear());

  it('detects same-origin Classic data but requires explicit selection and ownership confirmation', async () => {
    const user = userEvent.setup();
    localStorage.setItem('rv-reviews', JSON.stringify({
      'trade-1': {
        saw: '突破失败', did: '追单', learn: '等待收线', grade: 'D', reviewed: true,
      },
    }));
    localStorage.setItem('rv-guards', JSON.stringify({ maxLoss: 300, maxTrades: 3, maxRiskR: 1.5 }));
    const onApply = vi.fn().mockResolvedValue(receipt);
    render(<LegacyMigrationPanel context={context} onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: '检测当前站点旧版数据' }));
    const matched = await screen.findByText('可精确匹配', {}, { timeout: 3_000 });
    expect(matched.parentElement).toHaveTextContent('可精确匹配1');
    const apply = screen.getByRole('button', { name: /迁移已选择的 0 笔复盘/ });
    expect(apply).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /选择 BTCUSDT/ }));
    expect(screen.getByRole('button', { name: /迁移已选择的 1 笔复盘/ })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /我确认该 Classic 导出属于当前账户/ }));
    await user.click(screen.getByRole('button', { name: /迁移已选择的 1 笔复盘/ }));

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ state: 'bound' }), ['trade-1']);
    expect(await screen.findByText(/迁移完成：新增 1 笔/)).toBeInTheDocument();
  });

  it('does not claim cross-origin access when no Classic keys exist', async () => {
    const user = userEvent.setup();
    render(<LegacyMigrationPanel context={context} onApply={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '检测当前站点旧版数据' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/若旧版在其他域名或端口/);
  });

  it('refuses to bind old reviews to synthetic demo trades', async () => {
    const user = userEvent.setup();
    localStorage.setItem('rv-reviews', JSON.stringify({
      'trade-1': { saw: 'x', did: 'y', learn: 'z', grade: 'A', reviewed: true },
    }));
    render(<LegacyMigrationPanel context={{ ...context, source: 'demo' }} onApply={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '检测当前站点旧版数据' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/请先导入或连接当前 Binance 合约数据/);
  });
});
