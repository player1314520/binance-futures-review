import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import {
  MAX_FUPAN_FILE_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_PORTABLE_BACKUP_FILE_BYTES,
  csvLedgerImportErrorMessage,
} from '../lib/import-file-limits';

function sizedFile(name: string, size: number) {
  const file = new File([], name, { type: 'text/plain' });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

describe('ImportView file resource limit', () => {
  const readAsText = vi.fn();
  const readers: any[] = [];
  const FileReaderMock = vi.fn(function FileReaderMock(this: any) {
    this.result = '';
    this.onload = null;
    this.onerror = null;
    this.abort = vi.fn();
    this.readAsText = readAsText;
    readers.push(this);
  });

  beforeEach(() => {
    window.location.hash = '#/import';
    readAsText.mockReset();
    FileReaderMock.mockClear();
    readers.length = 0;
    vi.stubGlobal('FileReader', FileReaderMock);
  });

  it('keeps the import limit inside the encrypted-vault source budget', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_FUPAN_FILE_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_PORTABLE_BACKUP_FILE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('maps ledger rejection codes to actionable Chinese without echoing private row values', () => {
    expect(csvLedgerImportErrorMessage(new Error('AMBIGUOUS_NO_ID_OVERLAP'))).toMatch(/没有可靠成交 ID.*整批拒绝/);
    expect(csvLedgerImportErrorMessage(new Error('LEGACY_LEDGER_REBASE_REQUIRED'))).toMatch(/旧版无成交账本.*不能静默增量/);
    expect(csvLedgerImportErrorMessage(new Error('secret-row-value'))).not.toContain('secret-row-value');
  });

  it('offers the complete review backup format at the same guarded file input', () => {
    render(<App />);
    expect(document.querySelector<HTMLInputElement>('#rv2file')?.accept)
      .toContain('.rvbackup.json');
    expect(screen.getByText(/普通 CSV 通常不含可验证账户 UID，系统无法自动证明/)).toBeInTheDocument();
  });

  for (const [extension, limit, label] of [
    ['csv', MAX_IMPORT_FILE_BYTES, '8 MiB'],
    ['fupan', MAX_FUPAN_FILE_BYTES, '12 MiB'],
    ['rvbackup.json', MAX_PORTABLE_BACKUP_FILE_BYTES, '16 MiB'],
  ] as const) {
    it(`reads a .${extension} file exactly at the limit`, () => {
      render(<App />);
      const input = document.querySelector<HTMLInputElement>('#rv2file');
      expect(input).not.toBeNull();

      fireEvent.change(input!, {
        target: { files: [sizedFile(`boundary.${extension}`, limit)] },
      });

      expect(FileReaderMock).toHaveBeenCalledTimes(1);
      expect(readAsText).toHaveBeenCalledWith(expect.objectContaining({ name: `boundary.${extension}` }), 'utf-8');
      expect(screen.queryByText(/文件过大/)).not.toBeInTheDocument();
    });

    it(`rejects a .${extension} file above the limit before FileReader`, () => {
      render(<App />);
      const input = document.querySelector<HTMLInputElement>('#rv2file');
      expect(input).not.toBeNull();

      fireEvent.change(input!, {
        target: { files: [sizedFile(`oversize.${extension}`, limit + 1)] },
      });

      expect(FileReaderMock).not.toHaveBeenCalled();
      expect(readAsText).not.toHaveBeenCalled();
      expect(screen.getByText(new RegExp(`文件过大.*最大支持 ${label}.*互不重叠的时间段`))).toBeInTheDocument();
    });
  }

  it('aborts an in-flight private file read and ignores a late onload after leaving import', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = document.querySelector<HTMLInputElement>('#rv2file');
    expect(input).not.toBeNull();

    fireEvent.change(input!, {
      target: { files: [sizedFile('private.csv', 256)] },
    });
    expect(readers).toHaveLength(1);
    const lateReader = readers[0];

    await user.click(screen.getByRole('button', { name: '进入合成演示' }));
    expect(lateReader.abort).toHaveBeenCalledTimes(1);

    lateReader.result = `Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit\n2026-06-01 09:00:00,BTCUSDT,BUY,68000,0.01,680,0.27,0\n2026-06-01 10:00:00,BTCUSDT,SELL,68600,0.01,686,0.27,6`;
    lateReader.onload?.();

    await waitFor(() => expect(window.location.hash).toBe('#/today'));
    expect(screen.getAllByText(/合成演示/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/CSV 导入/)).not.toBeInTheDocument();
  });
});
