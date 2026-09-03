export const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FUPAN_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_PORTABLE_BACKUP_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_FILE_LABEL = 'CSV 8 MiB / .fupan 12 MiB / 备份 16 MiB';

function fileLimit(fileName: string): Readonly<{ bytes: number; label: string; kind: string }> {
  if (/\.rvbackup\.json$/i.test(fileName)) {
    return { bytes: MAX_PORTABLE_BACKUP_FILE_BYTES, label: '16 MiB', kind: '完整复盘备份文件' };
  }
  if (/\.fupan$/i.test(fileName)) {
    return { bytes: MAX_FUPAN_FILE_BYTES, label: '12 MiB', kind: '.fupan 存档文件' };
  }
  return { bytes: MAX_IMPORT_FILE_BYTES, label: '8 MiB', kind: 'CSV/文本文件' };
}

export function importFileSizeError(file: Pick<File, 'name' | 'size'>): string {
  const limit = fileLimit(file.name);
  if (file.size <= limit.bytes) return '';
  return `${limit.kind}过大（已超过 ${limit.label}）。最大支持 ${limit.label}；请按互不重叠的时间段拆分。没有成交 ID 的重叠批次会被整批拒绝。`;
}

export function csvLedgerImportErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    AMBIGUOUS_EXECUTION_ORDER: '本批与当前账本在同一毫秒存在多笔成交，但没有可验证的 Binance 十进制成交序号。执行先后会影响穿零配对，已整批拒绝；请改用 Binance 原始成交导出，或一次性导入完整时间段。',
    AMBIGUOUS_NO_ID_OVERLAP: '本批没有可靠成交 ID，且时间范围与当前账本重叠。为避免重复成交，已整批拒绝；请改用含成交 ID 的导出，或只导入互不重叠的时间段。',
    PROVIDER_TRADE_ID_CONFLICT: '相同成交 ID 对应了不同内容。为避免串账，已整批拒绝；请确认文件来自同一个 Binance 合约账户。',
    HISTORICAL_REPLAY_CONFLICT: '新批次会改写已复盘的历史闭环交易。为保护复盘与行动记录，已整批拒绝。',
    LEGACY_LEDGER_REBASE_REQUIRED: '当前是旧版无成交账本存档，只读查看不受影响，但不能静默增量。请先下载完整备份，再清空当前数据并一次性导入完整 CSV 重建账本。',
    BATCH_INCOMPLETE: '本批存在丢弃行或错误行。增量账本要求整批完整，已拒绝写入；请修正文件后重试。',
    RESOURCE_LIMIT: '本批或累计成交账本超过安全资源上限，已拒绝写入。请缩短导出时间范围。',
    ACCOUNT_SCOPE_MISMATCH: '本批不属于当前工作区的逻辑交易账本，已拒绝写入。',
    EMPTY_BATCH: '没有读到可入账的逐笔成交。',
    VAULT_LEDGER_RESTORE_PENDING: '加密云仓的成交账本仍在校验恢复中，请稍候再导入；现有云端快照不会被覆盖。',
    ARCHIVE_LEDGER_INVALID: '存档内的成交账本完整性校验失败，已拒绝恢复。',
    ARCHIVE_LEDGER_MISMATCH: '存档中的闭环交易与逐笔成交账本不一致，已拒绝恢复。',
  };
  return messages[code] ?? '成交账本校验失败，已拒绝整批写入；现有数据没有改变。';
}
