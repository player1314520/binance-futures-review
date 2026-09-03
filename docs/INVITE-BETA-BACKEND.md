# Binance USDⓈ-M 邀请制 Beta 后端合同

> 协议状态：`invite-beta-contract/1`
> 生效日期：2026-08-31
> 当前投放状态：`local-demo`，不是已上线 Beta
> 唯一正式 Origin：`https://binance-futures-review-web.vercel.app`

本文是新服务端数据面的实现与验收合同。它不覆盖 Classic/DC 的视觉合同，也不把本地、合成或静态测试描述成
真实 Binance 验收。旧 `production-vault` 保持只读，作为用户显式迁移与回滚源。

## 1. 不可变产品边界

- `/` 继续使用冻结的 Classic/DC“今日速览”旗舰工作台。导航、图表、指标、交易表、暗色层级和信息密度不删减、不改版、不重设计。
- 公开 Classic 回滚锚点固定为 `7c90282`。Vercel 切流失败时 alias 回指该提交；数据库只停止发布新 generation，不执行破坏性逆迁移。
- 视觉门固定为同一内容与数据状态下的 `1440×1000` 和 `390×844` 对比；两种视口都必须无横向溢出、console error 和 page error。
- 无完整证明时发布标记只能是 `local-demo`。全部线上门通过后也只能是 `invite-beta`，不能写“正式生产”或 SLA。
- Beta 最多 10 个受邀账号；每个账号只拥有一个彼此隔离、不可转移的专属 `OWNER` tenant。当前阶段不存在共享 tenant、`ADMIN` 或 `MEMBER` 席位。只支持 Binance USDⓈ-M；不支持公开注册、COIN-M、子账户、下单、改单、撤单、转账、提现、收益预测或投资建议。

## 2. 架构与信任边界

```text
Classic/DC React 壳
  -> Supabase Auth（邀请、OTP、恢复）
  -> binance-beta Edge（精确 Origin/JWT/路由）
  -> rv2 窄 RPC（tenant 从会话派生）
  -> 持久任务/租约
  -> GET-only Binance USDⓈ-M 同步
  -> 不可变来源事件
  -> 逐资产双重记账 Ledger
  -> rv-reconciliation/2
  -> 原子 generation
  -> rv-cloud-dataset/1

私有 GitHub Actions
  -> GitHub OIDC 短期任务权限
  -> 受限历史归档 / 排除凭据的 age 加密备份
```

信任边界：

1. 浏览器只持有当前请求中的 Binance Key/Secret，不写 localStorage、IndexedDB、URL、日志或错误正文。
2. Edge 运行时可以短暂看到明文凭据。每连接生成独立随机 DEK，以 AES-256-GCM 加密凭据；AAD 精确绑定
   `tenant_id/connection_id/provider/credential_version`。DEK 再由版本化项目包装密钥包装。
3. 包装主密钥只允许出现在 Supabase Project Secret/受控运行时，不进入数据库、Vercel、GitHub、R2、Brevo、浏览器或日志。
4. 新数据面的交易、复盘、行动、日志、风控和报告是服务端关系数据，服务端可读；它不是 E2EE 或零知识。
5. 所有租户归属由已验证会话 `auth.uid()` 通过唯一的专属 `OWNER` membership 派生。请求体中的 `user_id`、`tenant_id` 永不可信；`ADMIN`/`MEMBER` 上下文在 Edge 与数据库入口均失败关闭。
6. 未知资源与跨租户资源统一返回不可枚举的 `404`，不得用 `403` 暴露资源是否存在。

## 3. 外部 HTTP 合同

所有响应为 JSON，成功响应带 `requestId`；错误只含稳定 `code`、可公开 `message` 和 `requestId`，不含上游响应、
SQL、凭据、JWT、邮箱、tenant、provider identity 或本机路径。写请求必须带 UUIDv4 `idempotencyKey`。

| 方法与路径 | 请求 | 成功响应 | 关键失败 |
|---|---|---|---|
| `POST /v1/connections` | `{apiKey,apiSecret,consentVersion,idempotencyKey}` | `{connectionId,status,credentialVersion,permissionEvidence}` | `CONSENT_REQUIRED`, `PERMISSION_UNCLEAR`, `READ_ONLY_REQUIRED`, `CAPACITY_REACHED` |
| `GET /v1/connections` | 无 | `rv-binance-connections/1` 列表 | `AUTH_REQUIRED` |
| `GET /v1/connections/{id}/status` | 无 | 状态、覆盖、最近稳定错误码 | `NOT_FOUND` |
| `POST /v1/connections/{id}/rotate` | `{apiKey,apiSecret,consentVersion,idempotencyKey}` | 新版本、状态、权限证据 | `VERSION_CONFLICT`, `PERMISSION_UNCLEAR` |
| `POST /v1/connections/{id}/sync` | `{idempotencyKey}` | `202 {status:"QUEUED",jobId}` | `CONNECTION_INACTIVE`, `CIRCUIT_OPEN` |
| `DELETE /v1/connections/{id}` | `{idempotencyKey}` | `{status:"DISCONNECTED",receiptId}` | `NOT_FOUND` |
| `GET /v1/datasets/current` | 查询参数只能使用合同内分页/筛选字段 | `rv-cloud-dataset/1` | `NO_PUBLISHED_GENERATION` |
| `GET /v1/trades` | 不透明 cursor、受限筛选 | 已核验成交页 | `INVALID_CURSOR` |
| `GET /v1/reviews` | 不透明 cursor、受限筛选 | 复盘页 | `INVALID_CURSOR` |
| `PUT /v1/reviews/{tradeId}` | `{expectedVersion,idempotencyKey,...userFields}` | 新 review version | `VERSION_CONFLICT`, `TRADE_NOT_FOUND` |
| `DELETE /v1/business-data` | `{idempotencyKey,confirmation}` | capability 回执 | `RECENT_AUTH_REQUIRED` |
| `DELETE /v1/account` | `{idempotencyKey,confirmation}` | capability 回执 | `RECENT_AUTH_REQUIRED` |

`permissionEvidence` 只能返回脱敏结论与采集时间，不返回 Binance 响应：

```json
{
  "provider": "binance-usdm",
  "readOnly": true,
  "tradeDisabled": true,
  "withdrawDisabled": true,
  "internalTransferDisabled": true,
  "universalTransferDisabled": true,
  "checkedAt": "2026-08-31T00:00:00.000Z",
  "evidenceVersion": "rv-binance-permission/1",
  "evidenceDigest": "64-lowercase-hex"
}
```

验证先读取 Binance 官方 `GET /sapi/v1/account/apiRestrictions`。`enableReading` 必须明确为
`true`；`enableFutures`、`enableWithdrawals`、`enableInternalTransfer`、
`permitsUniversalTransfer`、`enableSpotAndMarginTrading`、`enablePortfolioMarginTrading`
和 `enableFixApiTrade` 必须全部明确为 `false`，再以一次 USDⓈ-M USER_DATA GET 成功证明读取
范围。任一字段缺失、类型异常、出现未知的交易/转账类真值，或 USDⓈ-M 读取失败时，连接不得
进入 `ACTIVE`，只能返回 `PERMISSION_UNCLEAR` 并转人工复核。所谓
`provider_account_ref_hash` 仅是不可逆的 credential-scope 去重摘要，不能声称它是 Binance UID 或账户身份证明。

## 4. 连接、凭据与状态机

连接状态仅允许：

```text
UNCONFIGURED -> VERIFYING -> ACTIVE
                         -> AUTH_ERROR
                         -> RATE_LIMITED
                         -> DISABLED
                         -> REVOKED
```

- 创建先占用受邀席位并建立 `VERIFYING` 记录，再验证权限；未验证的密文不能成为活动版本。
- 轮换必须先验证新版本，再以单事务切换活动版本并取消所有旧版本未完成任务。
- 断开先停止/取消任务，再销毁所有活动 credential cipher、wrapped DEK、nonce 和认证摘要；历史复盘默认保留。
- AES-GCM nonce 每个加密操作必须随机且在同一 DEK 下唯一；解密时 AAD 必须逐字节重建。错误 KEK、交换 AAD、篡改 nonce/ciphertext/tag 都必须失败。
- Edge 只允许编译期固定的 Binance 官方 HTTPS 主机与 GET/USER_DATA 路径；禁止任意 URL、用户自定义主机、重定向、私网地址和任何 POST/PUT/PATCH/DELETE Binance 方法。

## 5. rv2 多租户数据面

稳定 `tenant_id` 与 Supabase Auth UUID 分离。Beta 仍有多个相互隔离的 tenant，但每个 tenant 在整个生命周期最多一条
membership，且角色只能是 `OWNER`；禁用或删除状态的历史 membership 也占用该 tenant 身份，不能转给另一用户。
核心关系包括：

- invite、tenant、membership、consent、安全审计；
- connection、credential_version；
- sync_job、job_attempt、lease、dead_letter；
- dataset_partition、coverage_interval、gap、watermark；
- immutable_source_event、quarantine_event、provider_conflict；
- ledger_account、ledger_transaction、ledger_posting；
- reconciliation_run、published_generation；
- trade_projection、review、action、journal、risk_guard、report；
- deletion_tombstone、deletion_receipt、backup_manifest。

所有业务表启用并强制 RLS。浏览器只能执行显式授权的窄 RPC；默认撤销 `anon/authenticated` 对表、sequence、
内部函数和 service RPC 的直接访问。service RPC 只允许 Edge service role 或带严格 GitHub OIDC claims 的内部任务调用。

受邀席位上限在数据库事务内执行，不能依赖前端计数。实际门禁分别统计最多 10 条活动专属 `OWNER` membership
（因一 tenant 一 membership，等价于最多 10 个活动个人 tenant）和最多 10 个活动连接；任一上限达到后，新邀请/开通失败关闭。
共享 tenant、成员邀请、管理员委派和成员级删除属于未来模型，当前均为 `NOT_READY`。

旧 vault 在数据库权限层撤销新写入；只允许用户显式在浏览器解密旧快照，向新数据面提交规范化记录。迁移需要同时
核对记录数量、内容摘要、最早/最晚时间与冲突清单。禁止双写、后台静默迁移和新数据反向覆盖旧 vault。

## 6. 同步、租约与覆盖

`pg_cron` 每 10 分钟只排入到期连接，每分钟唤醒一个有界 worker。数据库持有一个全局共享出口租约，且每连接
最多一个租约；不能用进程内锁冒充跨实例锁。领取、续租、提交、失败都必须比较 lease token 与 credential version。

每个 `connection × dataset × symbol/account-wide` 单独保存：

```text
attempted -> fetched -> committed -> trusted
```

不存在全局完成水位。新发现 symbol 必须单独回补；失败、响应丢失、worker 中断、冲突、隔离或对账失败都不能推进
`trusted`。水位和覆盖区间采用半开区间，分页重放必须幂等；同毫秒多笔成交不能靠时间戳单独去重。

必需数据集：fills、income、普通 orders、Algo orders、强平记录、余额快照、仓位/持仓模式快照。不能证明属于
USDⓈ-M 的新型响应进入 quarantine，不能进入指标或 Ledger。

稳定错误行为：

- `429`：遵守合法 `Retry-After`，否则使用有上限抖动退避；不推进 trusted。
- `418`：打开全局断路器，停止新 Binance 请求，等待人工/定时解除条件。
- `-1021`：只允许校时后重试一次；再次失败即终止本次 attempt。
- 认证错误：立即转 `AUTH_ERROR`/停用连接并取消旧 credential version 任务。
- 未知错误：保存稳定 reason code 与有限诊断，不保存上游原文。

## 7. 历史归档与 CSV 补证

异步归档按“申请 -> 轮询 -> 短期链接 -> 解析”执行。Edge 不在一次调用中处理大型归档。私有 GitHub Actions 只能由
schedule 或 workflow_dispatch 触发，不能由 PR 触发生产权限；第三方 Action 固定完整 commit SHA，权限最小化。

GitHub OIDC 令牌最长 10 分钟，并绑定私有仓库、workflow、ref、job ID 和单一任务。Runner 不接触 Binance API
Secret、项目包装密钥或 Supabase service role；只能通过窄 RPC 分批提交规范化数据。下载器必须拒绝非允许主机、
重定向、私网、路径穿越、超限压缩比/文件数/行数/字节数、摘要不符和 CSV 公式注入。

官方异步归档不可用或配额耗尽时切换为 CSV 补证。CSV 默认在浏览器本地解析，只上传规范化行、文件 SHA-256 与覆盖
声明；同一 provider identity 的摘要冲突必须整批失败。常规查询以外的早期历史只能标为“归档/CSV 补证”，不得伪造完整覆盖。

## 8. Ledger、对账与发布

固定数据链：

```text
immutable source event
  -> per-asset double-entry Ledger
  -> rv-reconciliation/2
  -> atomic published generation
  -> read model
```

- 各来源定义自己的唯一键；同一 provider identity 出现不同 canonical digest 时创建 `CONFLICT`，永不覆盖旧事件。
- Ledger 每个资产独立平衡，覆盖手续费、已实现盈亏、资金费、部分成交、单向/双向持仓与穿零翻仓。
- 没有可验证汇率与时点时禁止跨币种汇总，不能把未知资产换算成 0。
- Ledger 晋级只能依次为 `SHADOW -> PARITY_OBSERVING -> PARITY_PASSED -> PRIMARY`。
- 至少连续 7 个真实同步 generation 与现有引擎和 CSV oracle 零差异，才允许单连接 canary 主化；任何差异重置观察窗。
- Ledger 重算只更新派生字段，不得覆盖复盘、行动、日志、守则等用户字段。
- generation 发布以 CAS/事务原子切换；失败时读模型继续指向上一个可信 generation。

## 9. `rv-cloud-dataset/1`

```json
{
  "format": "rv-cloud-dataset/1",
  "generation": 42,
  "asOf": "2026-08-31T00:00:00.000Z",
  "coverage": {
    "fills:BTCUSDT": {
      "state": "PARTIAL",
      "attempted": null,
      "fetched": null,
      "committed": null,
      "trusted": null,
      "gaps": []
    }
  },
  "reconciliation": {
    "format": "rv-reconciliation/2",
    "state": "UNKNOWN",
    "generation": 42
  },
  "capabilities": {
    "recordsBrowsable": "ALLOW",
    "accountKpis": "DENY",
    "equityAnalytics": "DENY",
    "ledger": "DENY",
    "experiments": "DENY",
    "aiAnalysis": "DENY"
  },
  "trades": [],
  "reviews": []
}
```

逐数据集覆盖状态只允许 `VERIFIED/PARTIAL/STALE/UNKNOWN/CONFLICT`。`PARTIAL/STALE/UNKNOWN/CONFLICT` 可以浏览已核验
记录，但必须独立锁住账户 KPI、权益、Ledger、实验判断和 AI 分析。UI 不能用“展示完整可视化”为理由放松数据门禁。

复盘写入采用 expected version + idempotency key。服务端必须保证相同幂等键相同请求返回同一结果；相同键不同正文
失败。并发版本不符返回 `VERSION_CONFLICT`，不进行 last-write-wins。

## 10. 认证、备份、恢复与删除

- Auth 关闭公开注册，只允许后台创建/邀请。Brevo 自定义 SMTP 关闭打开/点击跟踪；邮件日志和模板不得包含交易数据或凭据。
- 每日私有备份从明确的只读视图流式导出，排除 API Key/Secret、credential cipher、DEK、wrapped DEK、Auth Secret、任务短期链接和 provider 原文。
- 备份在离线保管的 age 公钥下加密后上传 R2 私有 Standard 桶，保留对象清单、表行数、时间范围和 SHA-256；生命周期 30 天。
- 每月在隔离 Supabase 项目做真实恢复。目标为 RPO 不超过 24 小时、RTO 不超过 8 小时；恢复后用户必须重新连接 Binance。
- 恢复先应用 deletion tombstone，再导入数据，防止已删除 tenant 从旧备份复活。

三种操作必须分离：

1. 断开 Binance：停任务、销毁活动凭据，保留历史复盘。
2. 删除业务数据：删除新旧数据面业务内容，保留 Auth。
3. 删除账户：停同步、删除业务数据，再删除 Auth。

上述删除只作用于调用者自己的专属 `OWNER` tenant。当前不存在可被连带删除的其他成员；共享 tenant 或成员级擦除未实现，
不得把个人 Beta 的整租户 tombstone 复用于未来共享模型。

删除回执分别写活动数据删除时间和备份预计清理时间，不声称外部提供商副本即时消失。响应丢失时通过不可枚举的
capability status 查询恢复同一幂等结果。

## 11. 容量、监控与免费额度保护

监控不得含邮箱、user/tenant ID、交易 ID、symbol 明细、金额或凭据。仅聚合同步延迟、租约、429/418、认证失败、
覆盖缺口、数据库容量、备份年龄、SMTP 投递失败和 Actions 分钟比例。

- DB 300MB 告警；350MB 停止邀请和历史回补；400MB 进入维护只读。
- R2 预算 60% 告警，80% 停止新增邀请和新增历史回补。
- GitHub Actions 免费分钟 60% 告警；超预算任务转人工且不产生隐性超额费用。
- 任一容量达到 60%、开始收费、超过 10 个连接、需要固定 IP/KMS/SLA/PITR 时，停止扩大 Beta 并启动下一阶段迁移评审。

2026-08-31 复核到的提供商边界如下；它们会变化，每次发布前必须重新读取官方页面，不能只相信本表：

| 提供商 | 当前官方边界 | 本项目处理 |
|---|---|---|
| Binance | `GET /fapi/v1/userTrades` 常规历史已从 6 个月缩短为最近 3 个月 | 更早记录必须走异步归档或 CSV，不能继承全局水位或宣称完整 |
| Supabase Edge Free | worker wall clock 150 秒、每请求 CPU 2 秒；无静态/稳定出口 IP | 有界分页任务；不做常驻 WebSocket；不提供 Binance IP 白名单 |
| Supabase DB Free | 数据库超过 500MB 进入只读；低活动 7 天窗口可能触发项目暂停 | 300/350/400MB 逐级保护；小时同步不作 SLA |
| Supabase Free 备份 | 官方建议 Free 项目自行定期导出并异地保管，平台自动日备属于 Pro 及以上 | 私有 Action 自建排除凭据的 age/R2 日备与月度真实恢复 |
| Brevo Free | 300 封/日，含 transactional email | 最多 10 人邀请，投递失败监控；不购买自动加量 |
| R2 Standard Free | 10 GB-month/月；免费层不适用于 Infrequent Access | 私有 Standard 桶，30 天生命周期，60%/80% 保护 |
| GitHub Free | 私有仓标准 runner 2,000 分钟/月 | 60% 告警，禁止 PR 触发生产任务，超预算停任务而不产生隐性费用 |

官方来源：[Binance 变更记录](https://developers.binance.com/docs/derivatives/change-log)、
[Supabase 数据库容量](https://supabase.com/docs/guides/platform/database-size)、
[Supabase Edge 限制](https://supabase.com/docs/guides/functions/limits)、
[Supabase 无固定出口 IP](https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0)、
[Supabase Free 项目暂停](https://supabase.com/docs/guides/platform/free-project-pausing)、
[Supabase 备份](https://supabase.com/docs/guides/platform/backups)、
[Brevo 方案](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)、
[Cloudflare R2 定价](https://developers.cloudflare.com/r2/pricing/)、
[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。

## 12. 验收与发布门禁

本地门：

- AES-GCM nonce/AAD/错误 KEK/轮换、幂等、RLS、权限不明确、任意 URL/方法拒绝。
- 分页重放、新 symbol、同毫秒成交、中断/丢响应、429/418、时钟偏差、认证撤销、公平租约。
- 恶意归档 URL、私网、重定向、压缩炸弹、路径穿越、公式注入、旧 credential version 重放。
- Ledger 单向/双向、部分成交、穿零、手续费、资金费、普通/Algo 订单、多币种隔离。
- 锁定依赖、SBOM、secret/隐私扫描、完整构建、Classic 同视口视觉回归。

真实线上门：

- 两个不同受邀用户与两套专用只读 Binance Key；验证相同 UUID/Trade ID 的交叉隔离。
- 完成小时同步、复盘写回、断开、业务删除、账户删除与恢复；真实恢复必须应用 tombstone。
- 最近备份不超过 24 小时；空项目恢复、重新绑定、重建读模型小于 8 小时。
- 至少连续 7 个真实 generation 的 Ledger parity 证据，才能让单连接从 SHADOW canary 主化。

发布顺序：内部账号 -> 两用户 canary -> 最多 10 个邀请账号。私有源码、完整本地测试、隐私扫描和公开候选导出
完成后，GitHub push、公开发布和生产部署仍需用户再次明确确认。未获得确认时只准备候选，不执行外部写入。

## 13. 诚实边界

1. Supabase Edge 没有固定出口 IP，本 Beta 不能提供 Binance IP 白名单；共享出口与拥有包装密钥的管理员解密能力是残余风险。
2. 有界 Edge 任务和 Free 项目不能提供常驻 WebSocket、实时同步、SLA 或不暂停保证；小时级同步只是尽力目标。
3. R2 的 APAC 位置不等于 Tokyo 数据驻留；Brevo 和 GitHub Runner 会短暂处理邮箱或受限交易数据。
4. 自动同步、异步归档和 CSV 都不能证明用户没有漏单；覆盖不足时必须显示缺口并锁住强结论。
5. 本地/CI 合成测试不能证明 Binance 权限、地区网络、双用户 RLS、SMTP、备份恢复或删除在真实线上成立。
6. 加密备份不能即时抹除提供商日志或所有历史副本；删除回执只能描述已执行范围与预计清理窗口。
7. 系统不验证税务处理、交易所清算结果、投资适当性或未来收益；它只是复盘工具。
8. 个人 Beta 的一账号一 `OWNER` tenant 约束不能支持团队共享、角色委派或成员级擦除；这些能力仍为 `NOT_READY`，需要新的 lineage、授权和删除验收。
