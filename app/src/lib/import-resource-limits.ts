export const MAX_IMPORT_TEXT_CHARS = 8 * 1024 * 1024;
export const MAX_ARCHIVE_TEXT_CHARS = 16 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_COLUMNS = 64;
export const MAX_IMPORT_CELL_CHARS = 16_384;

export type ImportTextKind = 'csv' | 'archive';

export function importTextResourceError(text: string, kind: ImportTextKind): string {
  if (kind === 'archive' && text.length > MAX_ARCHIVE_TEXT_CHARS) {
    return 'IMPORT_ARCHIVE_TOO_LARGE：存档文本超过 16 MiB 解析预算';
  }
  if (kind === 'csv' && text.length > MAX_IMPORT_TEXT_CHARS) {
    return 'IMPORT_TEXT_TOO_LARGE：文本超过 8 MB 解析预算';
  }
  if (kind === 'archive') return '';

  let inQuote = false;
  let rows = 1;
  let columns = 1;
  let cellChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuote && text[index + 1] === '"') {
        cellChars += 1;
        index += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (!inQuote && (character === ',' || character === '\t' || character === ';')) {
      columns += 1;
      cellChars = 0;
      if (columns > MAX_IMPORT_COLUMNS) {
        return `IMPORT_TOO_MANY_COLUMNS：单行超过 ${MAX_IMPORT_COLUMNS} 列`;
      }
    } else if (!inQuote && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      rows += 1;
      columns = 1;
      cellChars = 0;
      if (rows > MAX_IMPORT_ROWS) {
        return `IMPORT_TOO_MANY_ROWS：文件超过 ${MAX_IMPORT_ROWS} 行`;
      }
    } else {
      cellChars += 1;
    }
    if (cellChars > MAX_IMPORT_CELL_CHARS) {
      return `IMPORT_CELL_TOO_LARGE：单个字段超过 ${MAX_IMPORT_CELL_CHARS} 字符`;
    }
  }
  if (inQuote) return 'IMPORT_UNCLOSED_QUOTE：CSV 存在未闭合引号';
  return '';
}
