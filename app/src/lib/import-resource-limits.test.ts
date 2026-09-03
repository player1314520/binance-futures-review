import { describe, expect, it } from 'vitest';
import {
  importTextResourceError,
  MAX_ARCHIVE_TEXT_CHARS,
  MAX_IMPORT_CELL_CHARS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  MAX_IMPORT_TEXT_CHARS,
} from './import-resource-limits';

describe('import text resource preflight', () => {
  it('accepts a bounded quoted Binance CSV', () => {
    expect(importTextResourceError('time,symbol,note\n1,BTCUSDT,"a,b"', 'csv')).toBe('');
  });

  it('rejects oversized text before parsing', () => {
    expect(importTextResourceError('x'.repeat(MAX_IMPORT_TEXT_CHARS + 1), 'csv'))
      .toMatch(/IMPORT_TEXT_TOO_LARGE/);
  });

  it('rejects excessive rows, columns, and cell length', () => {
    expect(importTextResourceError(`h\n${'x\n'.repeat(MAX_IMPORT_ROWS)}`, 'csv'))
      .toMatch(/IMPORT_TOO_MANY_ROWS/);
    expect(importTextResourceError(`${Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, () => 'h').join(',')}\n1`, 'csv'))
      .toMatch(/IMPORT_TOO_MANY_COLUMNS/);
    expect(importTextResourceError(`h\n${'x'.repeat(MAX_IMPORT_CELL_CHARS + 1)}`, 'csv'))
      .toMatch(/IMPORT_CELL_TOO_LARGE/);
  });

  it('does not apply CSV column rules to a bounded archive', () => {
    const archive = JSON.stringify({ text: ','.repeat(MAX_IMPORT_COLUMNS + 1) });
    expect(importTextResourceError(archive, 'archive')).toBe('');
  });

  it('uses a separate 16 MiB archive parsing budget instead of the CSV budget', () => {
    expect(MAX_ARCHIVE_TEXT_CHARS).toBe(16 * 1024 * 1024);
    expect(importTextResourceError('x'.repeat(MAX_IMPORT_TEXT_CHARS + 1), 'archive')).toBe('');
    expect(importTextResourceError('x'.repeat(MAX_ARCHIVE_TEXT_CHARS + 1), 'archive'))
      .toMatch(/IMPORT_ARCHIVE_TOO_LARGE/);
  });
});
