import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { enrichTrades, parseStatement } from '@rv/engine';
import {
  cloudBetaAvailable,
  disconnectCloudBinanceConnection,
  listCloudBinanceConnections,
  recoverCloudRestoredOwner,
  runtimeAvailable,
  safeRuntimeError,
  selectCloudConnection,
} from '../lib/binance-source';
import {
  BINANCE_BETA_CONSENT_VERSION,
  type CloudConnection,
} from '../lib/cloud-beta-connection';
import {
  csvLedgerImportErrorMessage,
  importFileSizeError,
  MAX_IMPORT_FILE_LABEL,
} from '../lib/import-file-limits';
import { importTextResourceError } from '../lib/import-resource-limits';
import TrustBanner from '../components/TrustBanner';
import LegacyMigrationPanel from '../components/LegacyMigrationPanel';
import { useStore } from '../store';

const COVERAGE_FIELDS = Object.freeze([
  { keys: ['trades', 'fills'], label: '逐笔成交' },
  { keys: ['income'], label: '资金费与收入' },
  { keys: ['orders'], label: '普通订单' },
  { keys: ['algoOrders'], label: 'Algo 订单' },
  { keys: ['forceOrders'], label: '强平记录' },
  { keys: ['balances'], label: '余额快照' },
  { keys: ['positions'], label: '仓位快照' },
] as const);
const RESTORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function CoverageGrid() {
  const { session } = useStore();
  const coverage = session.bundle?.coverage as Record<string, string> | undefined;
  const reconciliation = session.bundle?.reconciliation as {
    status?: string;
    checks?: Record<string, { status?: string }>;
  } | undefined;
  return (
    <div className="coverage-stack">
      <div className="coverage-grid">
        {COVERAGE_FIELDS.map(({ keys, label }) => {
          const key = keys[0];
          const value = keys.map((candidate) => coverage?.[candidate]).find(Boolean) ?? 'unknown';
          return (
            <div className="coverage-item" key={key}>
              <span>{label}</span>
              <b className={`state-${value}`}>{value.toUpperCase()}</b>
            </div>
          );
        })}
      </div>
      <div className="reconciliation-line">
        <span>当前窗口对账</span>
        <strong>{reconciliation?.status ?? 'NOT AVAILABLE'}</strong>
      </div>
      {reconciliation?.checks && (
        <div className="check-grid">
          {Object.entries(reconciliation.checks).map(([name, check]) => (
            <span key={name}>{name}<b>{check.status ?? 'UNKNOWN'}</b></span>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportPanel({ cloudBeta }: Readonly<{ cloudBeta: boolean }>) {
  const navigate = useNavigate();
  const {
    cancelRestoreIntent,
    restorePortableBackup,
    restoreSessionArchive,
    setImported,
  } = useStore();
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const operationEpochRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    operationEpochRef.current += 1;
    readerRef.current?.abort();
    readerRef.current = null;
  }, []);

  function beginOperation(): number {
    operationEpochRef.current += 1;
    readerRef.current?.abort();
    readerRef.current = null;
    setError('');
    return operationEpochRef.current;
  }

  function isCurrent(epoch: number): boolean {
    return mountedRef.current && operationEpochRef.current === epoch;
  }

  async function acceptResult(result: ReturnType<typeof parseStatement>, epoch: number) {
    if (!isCurrent(epoch)) return;
    if (result.error !== undefined || !result.fills.length) {
      setError(result.error ?? '没有解析出逐笔成交');
      return;
    }
    const trades = enrichTrades([...result.trades]);
    let committed = false;
    try {
      committed = await setImported(trades, result.meta, {
        contract: result.contract,
        diagnostics: [...result.diagnostics],
      }, result.fills);
    } catch (error) {
      if (isCurrent(epoch)) setError(csvLedgerImportErrorMessage(error));
      return;
    }
    if (!isCurrent(epoch)) return;
    if (committed) navigate('/today');
    else setError('DATA_SAVE_FAILED：数据保存未确认，本次导入没有切换为正式数据');
  }

  function parseCsv() {
    const epoch = beginOperation();
    const resourceError = importTextResourceError(raw, 'csv');
    if (resourceError) {
      setError(resourceError);
      return;
    }
    void acceptResult(parseStatement(raw, null), epoch);
  }

  function readFile(file: File) {
    const epoch = beginOperation();
    const sizeError = importFileSizeError(file);
    if (sizeError) {
      setError(sizeError);
      return;
    }
    const reader = new FileReader();
    readerRef.current = reader;
    reader.onload = async () => {
      if (!isCurrent(epoch)) return;
      readerRef.current = null;
      const text = String(reader.result ?? '');
      const archive = /\.fupan$/i.test(file.name);
      const portable = /\.rvbackup\.json$/i.test(file.name);
      const resourceError = importTextResourceError(text, archive || portable ? 'archive' : 'csv');
      if (resourceError) {
        setError(resourceError);
        return;
      }
      if (portable) {
        const restored = await restorePortableBackup(text);
        if (!isCurrent(epoch)) return;
        if (restored) navigate('/today');
        else setError('PORTABLE_BACKUP_RESTORE_FAILED：备份无效、超出本机资源限制，或恢复过程中已被取消');
        return;
      }
      if (archive) {
        let committed = false;
        try {
          committed = await restoreSessionArchive(text);
        } catch (caught) {
          if (isCurrent(epoch)) setError(csvLedgerImportErrorMessage(caught));
          return;
        }
        if (!isCurrent(epoch)) return;
        if (committed) navigate('/today');
        else setError('存档无效，或加密云仓未确认保存；本次导入没有切换为正式数据');
      } else {
        setRaw(text);
        await acceptResult(parseStatement(text, null), epoch);
      }
    };
    reader.onerror = () => {
      if (!isCurrent(epoch)) return;
      readerRef.current = null;
      setError('FILE_READ_FAILED');
    };
    reader.readAsText(file, 'utf-8');
  }

  return (
    <div className="import-panel">
      <textarea
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        placeholder="把表格内容（含表头）粘贴到这里，或选择 Binance 导出的 CSV"
      />
      <p className="panel-footnote">{cloudBeta
        ? '请在一个工作区只放同一 Binance 合约账户的数据；普通 CSV 通常不含可验证账户 UID，系统无法自动证明两个文件来自同一账户。手工导入仍在浏览器解析，不会自动进入 Beta 的可信同步代次，也不能替代 Binance 覆盖证明；旧端到端加密 vault 只作为显式迁移与回滚源。Binance 完整备份只恢复为离线导入快照，不恢复凭据或实时连接；备份明文本身不会上传。'
        : '请在一个工作区只放同一 Binance 合约账户的数据；普通 CSV 通常不含可验证账户 UID，系统无法自动证明两个文件来自同一账户。后续 CSV 会从逐笔成交全量重放；没有成交 ID 的重叠批次会整批拒绝。导入或 Binance 完整备份在未解锁云仓时恢复到当前浏览器，已解锁时写入端到端加密云仓；其中 Binance 备份只恢复为离线导入快照，不恢复实时连接状态。Demo 完整备份只恢复为合成演示，且不会写入已解锁云仓。备份明文本身不会上传。'}
      </p>
      <div className="button-row">
        <button className="button primary" type="button" onClick={parseCsv} disabled={raw.trim().length < 10}>解析并切换到导入数据</button>
        <button className="button secondary" type="button" onClick={() => fileRef.current?.click()}>选择 CSV / .fupan / 完整备份</button>
      </div>
      <input
        ref={fileRef}
        id="rv2file"
        type="file"
        accept=".csv,.txt,.tsv,.fupan,.rvbackup.json"
        hidden
        onChange={(event) => {
          // Revoke an older asynchronous restore before inspecting this next
          // selection. Oversized, unsupported and even empty selections count.
          cancelRestoreIntent();
          const file = event.target.files?.[0];
          if (file) readFile(file);
        }}
      />
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function DataView() {
  const navigate = useNavigate();
  const {
    session,
    activateDemo,
    loadBinance,
    syncBinance,
    connectBinance,
    clearBrowserData,
    applyLegacyReviewMigration,
  } = useStore();
  const local = runtimeAvailable();
  const cloudBeta = cloudBetaAvailable();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [cloudConsentConfirmed, setCloudConsentConfirmed] = useState(false);
  const [cloudConnections, setCloudConnections] = useState<readonly CloudConnection[]>([]);
  const [cloudConnectionId, setCloudConnectionId] = useState('');
  const [cloudControlStatus, setCloudControlStatus] = useState('');
  const [cloudControlError, setCloudControlError] = useState('');
  const [restoreId, setRestoreId] = useState('');
  const [busy, setBusy] = useState(false);
  const [clearStatus, setClearStatus] = useState('');
  const quality = session.bundle?._meta.quality;
  const reasons = session.access?.reasonCodes ?? (session.errorCode ? [session.errorCode] : []);

  async function refreshCloudConnections(preferredConnectionId = cloudConnectionId) {
    try {
      const listed = await listCloudBinanceConnections();
      const next = listed.connections.find((entry) => entry.connectionId === preferredConnectionId)
        ?? listed.connections[0]
        ?? null;
      setCloudConnections(listed.connections);
      setCloudConnectionId(next?.connectionId ?? '');
      selectCloudConnection(next?.connectionId ?? null);
      setCloudControlError('');
      if (next) void loadBinance();
      return next;
    } catch (error) {
      setCloudConnections([]);
      setCloudConnectionId('');
      selectCloudConnection(null);
      setCloudControlError(safeRuntimeError(error));
      return null;
    }
  }

  useEffect(() => {
    if (!cloudBeta) return undefined;
    let active = true;
    void listCloudBinanceConnections().then((listed) => {
      if (!active) return;
      const next = listed.connections[0] ?? null;
      setCloudConnections(listed.connections);
      setCloudConnectionId(next?.connectionId ?? '');
      selectCloudConnection(next?.connectionId ?? null);
      setCloudControlError('');
    }).catch((error) => {
      if (!active) return;
      setCloudControlError(safeRuntimeError(error));
    });
    return () => { active = false; };
  }, [cloudBeta]);

  async function submitCredentials(event: React.FormEvent) {
    event.preventDefault();
    if (!(cloudBeta ? cloudConsentConfirmed : permissionConfirmed) || !apiKey || !apiSecret) return;
    setBusy(true);
    const key = apiKey;
    const secret = apiSecret;
    setApiKey('');
    setApiSecret('');
    try {
      await connectBinance(key, secret);
      if (cloudBeta) {
        const connected = await refreshCloudConnections();
        setCloudControlStatus(connected
          ? `已重新读取服务器清单；连接 ${connected.connectionId.slice(0, 8)}… 当前状态 ${connected.status}，请以凭据版本与权限证据为准`
          : '凭据请求已结束，但尚未观察到连接；请检查登录状态与错误码');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitOwnerRecovery() {
    if (!RESTORE_ID_PATTERN.test(restoreId)) return;
    const requestedRestoreId = restoreId.toLowerCase();
    setBusy(true);
    setCloudControlStatus('正在用当前登录账号核对恢复身份…');
    setCloudControlError('');
    try {
      const receipt = await recoverCloudRestoredOwner(requestedRestoreId);
      setRestoreId('');
      setCloudControlStatus(receipt.remainingOwnerClaims === 0
        ? '本人认领已记录；请等待恢复管理员重新运行发布步骤，发布后再重新连接 Binance。'
        : `本人认领已记录；仍有 ${receipt.remainingOwnerClaims} 个恢复账号待本人认领。`);
    } catch (error) {
      setCloudControlStatus('');
      setCloudControlError(safeRuntimeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <TrustBanner />
      <header className="page-heading">
        <div><p className="eyebrow">WEB CORE · DATA CONTROL</p><h1>网页端先验证数据，再进入复盘。</h1></div>
        <p>{cloudBeta
          ? 'CSV/.fupan 仍只在浏览器本地解析；个人云仓保存端侧密文。邀请 Beta 的 Binance 凭据、交易与复盘数据会由服务器读取和保存，详见下方风险边界。'
          : 'Binance CSV/.fupan 始终在浏览器本地解析；登录并解锁后，只把规范化复盘快照加密存入云仓，原始文件不会上传。'}
        </p>
      </header>

      <section className="web-core-boundary" aria-label="网页版能力边界">
        <div>
          <p className="eyebrow">PRODUCTION WEB PRODUCT</p>
          <h2>{cloudBeta ? '先本地解析，再明确区分旧 vault 与 Beta 数据面。' : '先本地解析，再由你决定是否加密保存。'}</h2>
        </div>
        <ul>
          <li><b>Demo</b><span>确定性合成交易，零网络即可完整演示</span></li>
          <li><b>Import</b><span>CSV / .fupan 只在浏览器内存解析</span></li>
          <li><b>{cloudBeta ? 'Beta' : 'Vault'}</b><span>{cloudBeta
            ? 'Key/Secret 加密托管；交易与复盘数据服务端可读'
            : '解锁后保存端到端加密复盘快照'}</span></li>
        </ul>
      </section>

      <section className="source-grid" aria-label="数据来源">
        <article className={`source-card ${session.source === 'demo' ? 'active' : ''}`}>
          <div className="source-index">01</div>
          <p className="eyebrow">SYNTHETIC DEMO</p>
          <h2>合成演示</h2>
          <p>确定性 Binance USDⓈ-M 样本。零网络、零账户数据，适合直接 Demo 全流程。</p>
          <button className="button primary" type="button" onClick={() => { activateDemo(); navigate('/today'); }}>进入合成演示</button>
        </article>

        <article className={`source-card ${session.source === 'imported' ? 'active' : ''}`}>
          <div className="source-index">02</div>
          <p className="eyebrow">PUBLIC WEB · LOCAL FILE</p>
          <h2>Binance CSV / 存档</h2>
          <p>原始文件不会上传。未解锁时只在当前会话使用；解锁后保存的是端侧加密快照。指标仅代表导入范围。</p>
          <a className="text-link" href="#import-panel">转到导入区 ↓</a>
        </article>

        <article className={`source-card ${cloudBeta ? (session.cloudWorkspace ? 'active' : '') : (session.persistence === 'vault' ? 'active' : '')}`}>
          <div className="source-index">03</div>
          <p className="eyebrow">{cloudBeta ? 'INVITE BETA · SERVER READABLE' : 'END-TO-END ENCRYPTED'}</p>
          <h2>{cloudBeta ? 'Binance 云复盘数据面' : '个人加密云仓'}</h2>
          <p>{cloudBeta
            ? '服务端接收并加密保存专用只读 Key/Secret，交易、复盘和覆盖数据服务端可读；旧端到端加密 vault 仅作为只读迁移源。'
            : '旧版端到端加密 vault 由登录与恢复文件共同控制；该旧 vault 只保存密文、版本和最小索引，不代表新 Beta 数据面的隐私边界。'}</p>
          <button className="button secondary" type="button" onClick={() => navigate('/account')}>
            {cloudBeta
              ? (session.cloudWorkspace ? '管理 Beta 账户' : '登录 Beta 账户')
              : (session.persistence === 'vault' ? '管理已解锁工作区' : '登录 / 解锁云仓')}
          </button>
        </article>
      </section>

      {local && (
        <section className="panel data-status-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">OPTIONAL LOCAL COMPANION</p><h2>本机只读连接器</h2></div>
            <span>127.0.0.1 ONLY</span>
          </div>
          <p>仅在本机助手环境可用；凭据由 Windows 当前用户 DPAPI 保存，不发送到网页服务端。邀请 Beta 是另行确认的服务端连接方式。</p>
          <div className="button-row">
            <button className="button secondary" type="button" onClick={() => void loadBinance()}>读取本机数据</button>
            {session.runtime?.binance.canSync && <button className="button secondary" type="button" onClick={() => void syncBinance()}>同步最近</button>}
          </div>
        </section>
      )}

      {cloudBeta && (
        <section
          className="panel credential-panel"
          aria-label="邀请制 Beta Binance 连接"
        >
          <div className="section-heading compact">
            <div><p className="eyebrow">INVITE BETA · SERVER READ-ONLY</p><h2>Binance USDⓈ-M 云同步</h2></div>
            <span>最多 10 个邀请账号</span>
          </div>
          <div className="note" role="note">
            <p><b>凭据边界：</b>API Key 与 Secret 会发送到服务器并加密保存；管理员和部署环境理论上能够解密，交易与复盘数据不是端到端加密。</p>
            <p><b>权限边界：</b>必须使用独立只读 Key，不得开启交易、转账或提现权限；系统没有下单、改单、撤单或资金划转接口。</p>
            <p><b>网络边界：</b>当前没有固定出口 IP，不能启用 Binance IP 白名单；小时级同步是尽力目标，不是实时 SLA。</p>
          </div>

          <dl className="runtime-facts">
            <div><dt>同意版本</dt><dd><code>{BINANCE_BETA_CONSENT_VERSION}</code></dd></div>
            <div><dt>当前连接</dt><dd>{cloudConnections.length ? `${cloudConnections.length} 个` : '尚未连接'}</dd></div>
          </dl>

          <div className="import-panel" aria-label="灾备恢复本人认领">
            <label htmlFor="cloud-beta-restore-id">恢复编号</label>
            <input
              id="cloud-beta-restore-id"
              type="text"
              value={restoreId}
              onChange={(event) => setRestoreId(event.target.value.trim())}
              autoComplete="off"
              spellCheck={false}
              placeholder="由恢复管理员提供的 UUID"
            />
            <p className="panel-footnote">仅在灾备恢复时使用。服务器只依据当前已验证登录账号匹配恢复身份；网页不会接收邮箱、用户 ID 或恢复密钥，也不会把恢复编号写入浏览器存储。</p>
            <button
              className="button secondary"
              type="button"
              disabled={busy || !RESTORE_ID_PATTERN.test(restoreId)}
              onClick={() => void submitOwnerRecovery()}
            >本人认领恢复数据</button>
          </div>

          {cloudConnections.length > 0 && (
            <div className="import-panel">
              <label htmlFor="cloud-beta-connection">Beta 连接</label>
              <select
                id="cloud-beta-connection"
                style={{ width: '100%', minWidth: 0 }}
                value={cloudConnectionId}
                onChange={(event) => {
                  const connectionId = event.target.value;
                  setCloudConnectionId(connectionId);
                  selectCloudConnection(connectionId);
                  setCloudControlStatus('正在读取所选连接的已发布数据代次…');
                  void loadBinance();
                }}
              >
                {cloudConnections.map((connection) => (
                  <option key={connection.connectionId} value={connection.connectionId}>
                    {connection.connectionId.slice(0, 8)}… · {connection.status} · v{connection.credentialVersion}
                  </option>
                ))}
              </select>
              <dl className="runtime-facts">
                {(() => {
                  const selected = cloudConnections.find((entry) => entry.connectionId === cloudConnectionId);
                  if (!selected) return null;
                  return (
                    <>
                      <div><dt>状态</dt><dd>{selected.status}</dd></div>
                      <div><dt>最近可信</dt><dd>{selected.lastTrustedAt ? new Date(selected.lastTrustedAt).toLocaleString('zh-CN') : '尚无可信代次'}</dd></div>
                      <div><dt>下次计划</dt><dd>{selected.nextDueAt ? new Date(selected.nextDueAt).toLocaleString('zh-CN') : '等待调度'}</dd></div>
                    </>
                  );
                })()}
              </dl>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !cloudConnectionId}
                  onClick={async () => {
                    setBusy(true);
                    setCloudControlStatus('同步任务提交中…');
                    try {
                      await syncBinance();
                      setCloudControlStatus('同步请求已结束；是否入队及可信状态以下方状态、覆盖与对账门禁为准');
                      await refreshCloudConnections(cloudConnectionId);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >手动同步</button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || !cloudConnectionId}
                  onClick={async () => {
                    const connectionId = cloudConnectionId;
                    setBusy(true);
                    setCloudControlStatus('正在停用任务并销毁活动凭据…');
                    try {
                      await disconnectCloudBinanceConnection(connectionId);
                      selectCloudConnection(null);
                      setCloudControlStatus('已断开 Binance；历史复盘仍按服务端保留策略保存');
                      activateDemo();
                      await refreshCloudConnections('');
                    } catch (error) {
                      setCloudControlError(safeRuntimeError(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >断开并销毁凭据</button>
              </div>
            </div>
          )}

          <form onSubmit={submitCredentials} autoComplete="off">
            <label htmlFor="cloud-beta-api-key">Beta API Key</label>
            <input
              id="cloud-beta-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
            />
            <label htmlFor="cloud-beta-api-secret">Beta API Secret</label>
            <input
              id="cloud-beta-api-secret"
              type="password"
              value={apiSecret}
              onChange={(event) => setApiSecret(event.target.value)}
              autoComplete="off"
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={cloudConsentConfirmed}
                onChange={(event) => setCloudConsentConfirmed(event.target.checked)}
              />
              我已阅读上述风险并同意 {BINANCE_BETA_CONSENT_VERSION}；确认此 Key 仅具读取权限，未开启交易、转账或提现。
            </label>
            <button
              className="button primary"
              type="submit"
              disabled={busy || !cloudConsentConfirmed || apiKey.length < 8 || apiSecret.length < 8}
            >
              {busy
                ? '验证中…'
                : cloudConnections.length > 0
                  ? '验证并轮换服务器凭据'
                  : '验证并加密保存到服务器'}
            </button>
          </form>
          {cloudControlStatus && <p className="clear-status" role="status">{cloudControlStatus}</p>}
          {cloudControlError && (
            <p className="form-error" role="alert">
              {cloudControlError === 'CLOUD_AUTH_REQUIRED'
                ? '请先到账号页完成邀请制登录，再管理 Binance 连接。'
                : `云端连接不可用：${cloudControlError}`}
            </p>
          )}
        </section>
      )}

      {session.source === 'binance' && (
        <section className="panel data-status-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">TRUST LEDGER</p><h2>覆盖与对账</h2></div>
            <span>{quality?.status ?? session.phase}</span>
          </div>
          <CoverageGrid />
          {reasons.length > 0 && <div className="reason-list">{reasons.slice(0, 12).map((reason) => <code key={reason}>{reason}</code>)}</div>}
          {session.runtime && (
            <dl className="runtime-facts">
              <div><dt>Runtime</dt><dd>{session.runtime.phase}</dd></div>
              <div><dt>同步</dt><dd>{session.runtime.sync.state} / {session.runtime.sync.phase}</dd></div>
              <div><dt>净化记录</dt><dd>{session.records.length}</dd></div>
              <div><dt>更新时间</dt><dd>{session.runtime.updatedAt ? new Date(session.runtime.updatedAt).toLocaleString('zh-CN') : '—'}</dd></div>
            </dl>
          )}
        </section>
      )}

      {session.source === 'imported' && session.contract && (
        <section className="panel data-status-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">IMPORT EVIDENCE</p><h2>导入质量</h2></div>
            <span>{session.contract.provenance.coverage.status.toUpperCase()}</span>
          </div>
          <dl className="runtime-facts">
            <div><dt>接受</dt><dd>{session.contract.provenance.coverage.accepted} 笔</dd></div>
            <div><dt>丢弃</dt><dd>{session.contract.provenance.coverage.dropped} 笔</dd></div>
            <div><dt>已实现盈亏</dt><dd>{session.contract.capabilities.values.pnlReported ? '已报告' : '不可验证'}</dd></div>
            <div><dt>手续费</dt><dd>{session.contract.capabilities.values.fees ? '已报告' : '不可观测'}</dd></div>
          </dl>
          {Object.keys(session.contract.diagnostics.countsByCode).length > 0 && (
            <div className="reason-list">
              {Object.entries(session.contract.diagnostics.countsByCode).map(([code, count]) => (
                <code key={code}>{code} × {count}</code>
              ))}
            </div>
          )}
          <p className="panel-footnote">丢弃行不参与指标；本页只说明本次文件，不外推到完整账户。</p>
        </section>
      )}

      {local && session.runtime?.binance.connected !== true && (
        <section className="panel credential-panel">
          <div className="section-heading compact">
            <div><p className="eyebrow">READ-ONLY CREDENTIALS</p><h2>连接 Binance USDⓈ-M</h2></div>
          </div>
          <form onSubmit={submitCredentials} autoComplete="off">
            <label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
            <label>API Secret<input type="password" value={apiSecret} onChange={(event) => setApiSecret(event.target.value)} autoComplete="off" /></label>
            <label className="check-label"><input type="checkbox" checked={permissionConfirmed} onChange={(event) => setPermissionConfirmed(event.target.checked)} />我确认该 Key 不授予交易或提现权限；应用本身也不包含下单接口。</label>
            <button className="button primary" type="submit" disabled={busy || !permissionConfirmed || apiKey.length < 8 || apiSecret.length < 8}>{busy ? '验证中…' : '验证并保存在本机'}</button>
          </form>
        </section>
      )}

      <section id="import-panel" className="panel">
        <div className="section-heading compact">
          <div><p className="eyebrow">MANUAL IMPORT</p><h2>导入成交样本</h2></div>
          <span>最大 {MAX_IMPORT_FILE_LABEL}</span>
        </div>
        <ImportPanel cloudBeta={cloudBeta} />
      </section>

      <LegacyMigrationPanel
        key={`${session.source}:${session.reviewScope ?? 'none'}`}
        context={{
          source: session.source,
          reviewScope: session.reviewScope,
          trades: session.trades,
          reviews: session.reviews,
        }}
        onApply={applyLegacyReviewMigration}
      />

      <section className="browser-privacy-panel" aria-label="本浏览器数据管理">
        <div>
          <p className="eyebrow">BROWSER PRIVACY</p>
          <h2>清除本浏览器演示与离线复盘</h2>
          <p>{cloudBeta
            ? '只清除浏览器本地命名空间并回到 Demo；不会删除 Beta 服务端业务数据或账户，云端删除请到登录/账户页操作。'
            : '只清除浏览器本地命名空间并回到 Demo；不会删除已保存的加密云仓，云端删除请到登录/云仓页操作。'}</p>
        </div>
        <button
          className="button secondary"
          type="button"
          onClick={async () => {
            const removed = await clearBrowserData();
            setClearStatus(removed < 0
              ? '浏览器事务锁不可用，未清除数据；请关闭其他复盘标签页后重试'
              : removed > 0
                ? `已清除 ${removed} 项本浏览器复盘数据，恢复通道已重新就绪`
                : '本浏览器没有可清除的复盘数据，恢复通道已重新就绪');
          }}
        >
          一键清除本浏览器复盘数据
        </button>
        {clearStatus && <p className="clear-status" role="status">{clearStatus}</p>}
      </section>

      <p className="honest-note">{cloudBeta
        ? '邀请制 Beta 会接收 Binance 只读 API Key/Secret 并在服务器加密保存；管理员与部署环境理论上可解密，且当前没有固定出口 IP。任何覆盖缺口都会继续锁住账户 KPI、权益、Ledger、实验与 AI 分析。'
        : '公网产品不接收、不保存、也不发送 Binance API Key；当前仍是 local-demo。端到端加密不能替代本机安全；恢复文件丢失后平台无法解密，导入范围也不能证明完整账户总账一致。'}</p>
    </div>
  );
}
