import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_FILE_BYTES } from '../lib/import-file-limits';
import { useStore } from '../store';
import DataView from './DataView';

vi.mock('../store', () => ({ useStore: vi.fn() }));
const binanceMocks = vi.hoisted(() => ({
  runtimeAvailable: vi.fn(() => false),
  cloudBetaAvailable: vi.fn(() => false),
  listCloudBinanceConnections: vi.fn(async () => ({
    format: 'rv-binance-connections/1',
    connections: [],
  })),
  disconnectCloudBinanceConnection: vi.fn(async () => ({
    status: 'DISCONNECTED',
    receiptId: '018f47a2-4bb0-7ee0-8000-abcdefabcdef',
  })),
  recoverCloudRestoredOwner: vi.fn(async () => ({
    format: 'rv-restore-v2-owner-recovery/1',
    restoreId: '77777777-7777-4777-8777-777777777777',
    state: 'CLAIMED',
    claimed: true,
    idempotent: false,
    remainingOwnerClaims: 0,
    inviteClaimDisclosed: false,
    recoveryIdentitySource: 'AUTH_VERIFIED_SERVER_SIDE',
  })),
  selectCloudConnection: vi.fn(),
  safeRuntimeError: vi.fn(() => 'CLOUD_FAILURE'),
}));
vi.mock('../lib/binance-source', () => binanceMocks);

describe('DataView restore intent cancellation', () => {
  const cancelRestoreIntent = vi.fn();
  const restorePortableBackup = vi.fn(async () => false);
  const restoreSessionArchive = vi.fn(async () => false);
  const applyLegacyReviewMigration = vi.fn(async () => null);
  const clearBrowserData = vi.fn(async () => 0);
  const loadBinance = vi.fn(async () => undefined);
  const syncBinance = vi.fn(async () => undefined);
  const connectBinance = vi.fn(async () => undefined);
  const activateDemo = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    binanceMocks.runtimeAvailable.mockReturnValue(false);
    binanceMocks.cloudBetaAvailable.mockReturnValue(false);
    binanceMocks.listCloudBinanceConnections.mockResolvedValue({
      format: 'rv-binance-connections/1',
      connections: [],
    });
    vi.mocked(useStore).mockReturnValue({
      session: {
        source: 'demo', persistence: 'demo', phase: 'DEMO', trades: [], records: [],
        bundle: null, contract: null, runtime: null, access: null, errorCode: null,
        reviewScope: 'demo-v1', reviews: {}, actions: {}, journal: [], guards: [],
      },
      cancelRestoreIntent,
      restorePortableBackup,
      restoreSessionArchive,
      setImported: vi.fn(async () => false),
      activateDemo,
      loadBinance,
      syncBinance,
      connectBinance,
      clearBrowserData,
      applyLegacyReviewMigration,
    } as never);
  });

  it('cancels the prior Store restore before rejecting an oversized selection', () => {
    render(<MemoryRouter><DataView /></MemoryRouter>);
    const input = document.querySelector('#rv2file') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [{ name: 'oversized.csv', size: MAX_IMPORT_FILE_BYTES + 1 }] },
    });

    expect(cancelRestoreIntent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('CSV/文本文件过大');
    expect(restorePortableBackup).not.toHaveBeenCalled();
    expect(restoreSessionArchive).not.toHaveBeenCalled();
  });

  it('also cancels the prior Store restore when the chooser returns no file', () => {
    render(<MemoryRouter><DataView /></MemoryRouter>);
    const input = document.querySelector('#rv2file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });

    expect(cancelRestoreIntent).toHaveBeenCalledTimes(1);
    expect(restorePortableBackup).not.toHaveBeenCalled();
    expect(restoreSessionArchive).not.toHaveBeenCalled();
  });

  it('renders the Classic migration entry immediately after the import surface', () => {
    render(<MemoryRouter><DataView /></MemoryRouter>);

    const importRegion = screen.getByRole('heading', { name: '导入成交样本' }).closest('section');
    const migrationRegion = screen.getByRole('region', { name: 'Classic 复盘迁移' });
    expect(importRegion?.nextElementSibling).toBe(migrationRegion);
    expect(screen.getByRole('button', { name: '选择 Classic 导出 JSON' })).toBeInTheDocument();
  });

  it('states that Binance backups are offline archives and Demo backups stay synthetic', () => {
    render(<MemoryRouter><DataView /></MemoryRouter>);

    expect(screen.getByText(/Binance 备份只恢复为离线导入快照，不恢复实时连接状态/)).toBeInTheDocument();
    expect(screen.getByText(/Demo 完整备份只恢复为合成演示，且不会写入已解锁云仓/)).toBeInTheDocument();
  });

  it('reports an asynchronous clear repair failure instead of claiming there was no data', async () => {
    clearBrowserData.mockResolvedValueOnce(-1);
    render(<MemoryRouter><DataView /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: '一键清除本浏览器复盘数据' }));

    expect(await screen.findByText(/浏览器事务锁不可用.*未清除数据/)).toBeInTheDocument();
    expect(screen.queryByText(/没有可清除/)).not.toBeInTheDocument();
  });

  it('shows the compact invite Beta control plane without changing the Classic data sources', async () => {
    binanceMocks.cloudBetaAvailable.mockReturnValue(true);
    binanceMocks.listCloudBinanceConnections.mockResolvedValueOnce({
      format: 'rv-binance-connections/1',
      connections: [{
        connectionId: '018f47a2-4bb0-7ee0-8000-0123456789ab',
        status: 'ACTIVE',
        credentialVersion: 2,
        lastTrustedAt: '2026-08-31T01:00:00.000Z',
        nextDueAt: '2026-08-31T02:00:00.000Z',
        permissionEvidence: null,
      }],
    } as never);

    render(<MemoryRouter><DataView /></MemoryRouter>);

    const region = await screen.findByRole('region', { name: '邀请制 Beta Binance 连接' });
    const pageHeading = screen.getByRole('heading', { name: '网页端先验证数据，再进入复盘。' })
      .closest('header');
    expect(pageHeading).toHaveTextContent('邀请 Beta 的 Binance 凭据、交易与复盘数据会由服务器读取和保存');
    expect(pageHeading).not.toHaveTextContent('只把规范化复盘快照加密存入云仓');
    expect(region).toHaveTextContent('API Key 与 Secret 会发送到服务器并加密保存');
    expect(region).toHaveTextContent('管理员和部署环境理论上能够解密');
    expect(region).toHaveTextContent('不得开启交易、转账或提现权限');
    expect(region).toHaveTextContent('没有固定出口 IP，不能启用 Binance IP 白名单');
    expect(region).toHaveTextContent('rv-binance-beta-consent/1');
    expect(screen.getByRole('heading', { name: '合成演示' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binance CSV / 存档' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Binance 云复盘数据面' })).toBeInTheDocument();
    expect(screen.getByText(/交易、复盘和覆盖数据服务端可读/)).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /ACTIVE.*v2/ })).toBeInTheDocument();
  });

  it('requires explicit current-version consent before sending cloud credentials', async () => {
    binanceMocks.cloudBetaAvailable.mockReturnValue(true);
    render(<MemoryRouter><DataView /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('Beta API Key'), { target: { value: 'readonly-key-123456' } });
    fireEvent.change(screen.getByLabelText('Beta API Secret'), { target: { value: 'readonly-secret-123456' } });
    const submit = screen.getByRole('button', { name: '验证并加密保存到服务器' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /同意 rv-binance-beta-consent\/1/ }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(connectBinance).toHaveBeenCalledWith(
      'readonly-key-123456',
      'readonly-secret-123456',
    ));
    expect(screen.getByLabelText('Beta API Key')).toHaveValue('');
    expect(screen.getByLabelText('Beta API Secret')).toHaveValue('');
  });

  it('lets a signed-in invite account claim only an exact restore id without persisting it', async () => {
    const restoreId = '77777777-7777-4777-8777-777777777777';
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const sessionSet = vi.spyOn(sessionStorage, 'setItem');
    binanceMocks.cloudBetaAvailable.mockReturnValue(true);
    render(<MemoryRouter><DataView /></MemoryRouter>);

    const input = screen.getByLabelText('恢复编号');
    const submit = screen.getByRole('button', { name: '本人认领恢复数据' });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: 'bad' } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: restoreId } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(binanceMocks.recoverCloudRestoredOwner)
      .toHaveBeenCalledWith(restoreId));
    expect(await screen.findByText(/本人认领已记录/)).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('selects the exact cloud connection before loading its dataset and exposes sync/disconnect', async () => {
    const connectionId = '018f47a2-4bb0-7ee0-8000-0123456789ab';
    binanceMocks.cloudBetaAvailable.mockReturnValue(true);
    binanceMocks.listCloudBinanceConnections.mockResolvedValue({
      format: 'rv-binance-connections/1',
      connections: [{
        connectionId,
        status: 'PARTIAL',
        credentialVersion: 1,
        lastTrustedAt: null,
        nextDueAt: null,
        permissionEvidence: null,
      }],
    } as never);
    render(<MemoryRouter><DataView /></MemoryRouter>);

    const selector = await screen.findByLabelText('Beta 连接');
    fireEvent.change(selector, { target: { value: connectionId } });
    await waitFor(() => expect(binanceMocks.selectCloudConnection).toHaveBeenCalledWith(connectionId));
    expect(loadBinance).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '手动同步' }));
    expect(syncBinance).toHaveBeenCalled();

    const disconnect = screen.getByRole('button', { name: '断开并销毁凭据' });
    await waitFor(() => expect(disconnect).toBeEnabled());
    fireEvent.click(disconnect);
    await waitFor(() => expect(binanceMocks.disconnectCloudBinanceConnection)
      .toHaveBeenCalledWith(connectionId));
    expect(activateDemo).toHaveBeenCalled();
  });
});
