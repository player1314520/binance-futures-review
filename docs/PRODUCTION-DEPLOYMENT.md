# 邀请制 Beta 生产部署手册：Tokyo Supabase + Vercel

> 当前状态（2026-09-01）：local-demo / not_distributed / NOT_READY。
>
> 本仓库只证明代码、迁移、静态合同与本地测试候选。专用 Tokyo 项目、Edge Function、
> Brevo、R2、GitHub OIDC、Vercel 生产别名与自然计划任务均没有本轮远端回执。没有真实现场回执
> 时，不得写“已上线”“已部署完成”或“生产可用”。

本手册只描述下一次经明确授权后应执行的顺序。目标是最多 10 个个人账号的 Binance
USDⓈ-M 邀请制 Beta，不是正式生产、实时服务或 SLA。Classic/DC 今日速览是冻结的视觉与功能
基线；这次后端建设不得删减导航、图表、指标或改变首页信息架构。

## 0. 外部写入授权与停止条件

以下操作都会改变外部状态，执行前必须得到一次针对当前完整提交 SHA 和目标资源的明确确认：

- 推送私有源仓或更新公开候选仓；
- 新建、暂停、迁移或修改 Supabase 项目；
- 写入 Project Secrets、Auth、SMTP、R2、GitHub 或 Vercel 配置；
- 部署 Edge Functions、应用数据库迁移或切换 Vercel alias；
- 创建真实邀请、调用真实 Binance Key 或运行删除/恢复演练。

一次确认不自动授权后续不同提交、不同 project ref、付费升级或凭据轮换。出现以下任一情况立即
停止：目标 project ref 不一致、计划不再是 Free、出现付费附加项、来源提交漂移、公开候选摘要
不一致、秘密进入日志、现场证据缺失、容量状态 UNKNOWN/STALE，或任何门禁失败。

发布票据必须先固定：

1. 私有源完整提交 SHA；
2. 无历史脱敏公开候选的 manifest SHA-256 与候选提交 SHA；
3. Supabase 组织 ID、专用 Tokyo 项目 ref、Free 计划与零付费附加项；
4. 精确应用 Origin：https://binance-futures-review-web.vercel.app；
5. Vercel 项目 ID、当前 alias 指向、回滚部署 ID；
6. R2 bucket、Brevo sender、GitHub repository/workflow/ref 的非秘密标识；
7. live gate 与独立运营证明的摘要，不记录邮箱、OTP、JWT、API Key 或用户数据。

## 1. 先冻结 Classic/DC 与回滚线

- 正式根路径在候选开发和现场验证期间保持现有 Classic/DC。
- 当前分支可解析的 Classic/DC 本地源基线是
  dba18bc1b26c506a3977ffa15bc1bd8ab7d219b6。切流前仍必须证明对应的 Vercel 部署 ID、
  release.json、构建产物与视觉截图属于同一提交，不能只凭 Git SHA 猜测远端部署。
- 原计划中的 7c90282 只能作为待核实的外部回滚标签；本地 Git 当前没有证明它是可解析提交。
  未取得远端回执前，不得把它写成已验证回滚版本。
- 候选先走受保护的 Preview/Beta 验证。生产 alias 只在全部门禁通过后切换；任一切流或烟测失败，
  立即把 alias 指回票据中已验证的 Classic 部署。数据库只冻结新 generation，不执行破坏性
  schema 回滚。

## 2. 导出并验收无历史公开候选

生产迁移只能从脱敏公开候选执行。私有源根目录的 supabase/migrations 保留旧系统历史，不能直接
链接新项目。导出器会把 supabase/production-vault/migrations 映射为候选中的
supabase/migrations。

在私有源先完成：

    pnpm test:invite-beta
    pnpm typecheck
    pnpm test:logic
    pnpm test:react
    pnpm test:e2e
    pnpm build
    pnpm verify:security
    pnpm verify:sbom

然后用 scripts/export-public-staging.mjs 生成 release-mode 候选，在全新目录离线安装并运行候选
自己的 test、typecheck、build、test:e2e、verify:privacy 与 verify:compliance。候选 manifest
必须绑定当前私有源 SHA，DISTRIBUTION.md 仍必须是 STATUS: not_distributed。通过测试不等于获得
推送、公开或部署权限。

公开前再次扫描当前树和完整候选历史，拒绝真实姓名、私有邮箱、本机路径、账户截图、token、
私钥、环境文件、Binance 标识、用户交易和删除日志。GitHub-bound commit 只使用规定的 noreply
身份。

## 3. 新建专用 Tokyo Free 项目

1. 在已确认的现有 Supabase 组织中新建空白项目，区域选 Tokyo，计划选 Free，不开启付费
   add-on、PITR、计算升级或 overage。
2. 不克隆旧项目的表、Auth 用户、Secrets、Storage、Cron 或设置；不使用 staging、共享项目或
   player1314520's Project 代替。
3. 创建后把 20 位 project ref 写入发布票据。CLI link、Dashboard、Supabase URL 与后续回执必须
   全部等于该 ref；任何漂移都是停止条件。
4. 在应用迁移前确认项目为空。首个 production-vault 基线带有旧表/半安装拒绝守卫，不能绕过、
   注释或改写。

## 4. 按时间顺序应用完整迁移链

从公开候选的 supabase/migrations 按文件名严格顺序执行。完整链是：

1. 20260829000100_production_vault.sql
2. 20260830000100_vault_objects_device_fkey_index.sql
3. 20260830000200_free_plan_admission_controls.sql
4. 20260830000300_status_fairness_and_admission_truth.sql
5. 20260830000400_close_status_lookup_admission_gap.sql
6. 20260831000100_invite_beta_rv2_data_plane.sql
7. 20260831000200_restore_v2_lineage.sql
8. 20260831000300_invite_beta_capacity_observability.sql

前五个文件是旧 E2EE vault 的兼容基线；它们保留旧数据读取、删除回执和 Classic 兼容能力，
不能被当作新 Beta 已完成。第 6 个文件才新增 rv2 个人多租户数据面；第 7 个新增恢复 lineage、
owner recovery 与 tombstone 约束；第 8 个新增容量观测和 300/350/400 MiB 数据库门禁。

执行要求：

- 只允许标准向前迁移，不手工挑表、复制 SQL 片段或伪造 migration history；
- 每个文件完成后读取远端 migration ledger 和对象摘要；
- 运行生产 schema、rv2 data plane、restore-v2 migration 与 capacity contract 测试；
- 确认旧 vault 浏览器写权限已撤销而读/删除兼容路径仍在；
- 确认 rv2 资源只能从已验证会话派生 tenant，不接受请求体 user_id 或 tenant_id；
- 确认 migration 003 的外部容量证据在新环境最初为 UNKNOWN，不能从备份恢复假 0。

不要再以“七张旧表、两个旧函数存在”作为 Beta 完成条件。新 Beta 必须同时验证 rv2、restore-v2、
capacity、五个 Edge Functions、外部 provider 与真实两用户闭环。

## 5. 配置邀请制 Auth 与 Brevo

Supabase Auth 必须与 supabase/config.toml 一致：

- Site URL 和唯一回调均为精确应用 Origin；
- public signup、anonymous、phone 与 manual linking 关闭；
- email OTP 为 6 位、10 分钟有效，refresh token rotation 开启；
- 浏览器请求始终使用 should_create_user: false；
- 不允许通配符 redirect 或无关域名。

使用 Brevo Free 自定义 SMTP：

1. 验证专用发件域名及 SPF/DKIM/DMARC；
2. 关闭打开和点击跟踪，缩短事务日志保留；
3. SMTP 凭据只放 Supabase Auth 的安全配置，不进 Git、Vercel、Actions 或文档；
4. 用两个不同受控邮箱完成邀请、收到数字 OTP、消费 OTP 与新会话验证；
5. 记录 PII-free 的投递/消费摘要；不能把邮箱、OTP 或 JWT 放进回执。

默认测试 mailer、发送成功 HTTP 状态或单一邮箱收件都不算门禁通过。

## 6. 配置 Supabase Project Secrets 与 Vault

所有随机值必须独立生成并通过受控秘密管理器录入。不得把真实值放在命令行历史、数据库普通表、
Vercel、GitHub Variables、R2、浏览器、日志或支持消息中。Supabase 自动管理的 SUPABASE_URL、
SUPABASE_ANON_KEY 与 SUPABASE_SERVICE_ROLE_KEY 只在 Edge 运行时使用；service role 永不进入
VITE 变量或 GitHub Runner。

所有面共用的非秘密绑定：

- APP_ORIGIN=https://binance-futures-review-web.vercel.app

delete-account 需要：

- DELETION_HMAC_SECRET；
- DELETION_R2_ACCOUNT_ID；
- DELETION_R2_API_TOKEN；
- DELETION_R2_PARENT_ACCESS_KEY_ID；
- DELETION_R2_BUCKET。

binance-beta 需要：

- RV_BETA_CREDENTIAL_KEK_V1；
- RV_BETA_SCOPE_HMAC_V1；
- RV_BETA_SYNC_CRON_TOKEN；
- RV_BETA_ARCHIVE_CRON_TOKEN；
- RV_BETA_EDGE_WORKER_SUBJECT。

其中 KEK、scope HMAC 与两个 cron token 必须互不相同。数据库 Vault 另写入：

- rv2_edge_origin，值为精确 https://PROJECT_REF.supabase.co；
- rv2_worker_cron_token，值必须与 RV_BETA_SYNC_CRON_TOKEN 相同；
- rv2_archive_cron_token，值必须与 RV_BETA_ARCHIVE_CRON_TOKEN 相同，且不得与 worker token 相同；
- rv2_restore_v2_recovery_pepper，由离线托管流程提供，不能进入备份。

restore-v2 需要：

- RESTORE_V2_USER_ORIGIN，精确等于应用 Origin；
- RESTORE_V2_MANIFEST_KEY_ID；
- RESTORE_V2_MANIFEST_PUBLIC_KEY_PEM。

beta-operations 需要四把互不相同的 HMAC、备份签名私钥和固定外部配置：

- BETA_OPS_GRANT_HMAC_V1；
- BETA_OPS_RESTORE_TOMBSTONE_HMAC_V1；
- BETA_OPS_RESTORE_CLAIM_HMAC_V1；
- BETA_OPS_RESTORE_LEASE_HMAC_V1；
- BETA_OPS_BACKUP_SIGNING_PRIVATE_KEY_PKCS8_B64；
- BETA_OPS_GITHUB_REPOSITORY、BETA_OPS_GITHUB_REPOSITORY_ID、
  BETA_OPS_GITHUB_OWNER_ID、BETA_OPS_GITHUB_REF；
- BETA_OPS_GITHUB_WORKFLOW_SHA、BETA_OPS_GITHUB_AUDIENCE；
- BETA_OPS_CLOUDFLARE_ACCOUNT_ID、BETA_OPS_CLOUDFLARE_API_TOKEN；
- BETA_OPS_R2_PARENT_ACCESS_KEY_ID、BETA_OPS_R2_BUCKET、BETA_OPS_R2_PREFIX；
- BETA_OPS_ARCHIVE_DOWNLOAD_HOST、BETA_OPS_BACKUP_SIGNING_KEY_ID。

固定仓库必须是私有 player1314520/trading-，ref 必须是 refs/heads/main，workflow SHA 必须是已
审阅的完整 40 位提交。配置完成后只验证存在性、长度、key ID 和摘要，禁止读取或打印秘密本身。

## 7. 按顺序部署五个 Edge Functions

先运行每个函数的静态和安全测试，然后只部署到票据中的 Tokyo project ref。部署顺序固定为：

    supabase functions deploy delete-account --project-ref <TOKYO_PROJECT_REF> --no-verify-jwt
    supabase functions deploy publish-vault-head --project-ref <TOKYO_PROJECT_REF> --no-verify-jwt
    supabase functions deploy binance-beta --project-ref <TOKYO_PROJECT_REF> --no-verify-jwt
    supabase functions deploy restore-v2 --project-ref <TOKYO_PROJECT_REF> --no-verify-jwt
    supabase functions deploy beta-operations --project-ref <TOKYO_PROJECT_REF> --no-verify-jwt

verify_jwt=false 不是免认证。五个函数都在自身边界执行精确 route/method、Origin 或 no-CORS、
JWT/service/OIDC/capability、请求大小和 schema 验证。部署后逐一读取函数版本、源码摘要与配置
摘要，并做负向探测：

- 缺失/错误 JWT、service token、OIDC 或 capability 必须在读取大请求体和业务调用前失败；
- 任意 URL、重定向、非 GET Binance 方法、跨租户 ID 与额外字段必须失败；
- Origin 只用于浏览器隔离，不能描述成服务端身份认证；
- publish-vault-head 只为旧 vault 只读兼容与签名 head 发布，不代表 rv2 同步完成；
- delete-account 必须先完成 R2 deletion journal 的条件追加、HEAD 和两遍 range proof；
- restore-v2 operator route 无 CORS，唯一浏览器例外是精确 owner-recover；
- beta-operations 只接受固定私有 workflow 的 GitHub OIDC，不向 Runner 暴露 service role、
  Binance Secret、Project KEK 或父级长期 R2 写凭据。

当前迁移安装三个 rv2 数据库计划任务：每 10 分钟排入到期同步、每分钟唤醒一个同步页，以及
每 10 分钟用独立 token 唤醒一个归档步骤。安装成功仍不能证明自动归档已经运行；必须在现场观察
`rv2-wake-beta-archive-worker` 的自然 cron 成功、对应 Edge 有界回执，以及后续私有
`beta-archive.yml` 的真实 claim/download/attest/ingest 闭环。

## 8. 配置 R2 与 GitHub OIDC

Cloudflare R2：

- 使用私有 Standard bucket，关闭 r2.dev，不绑定公开 custom domain；
- 设置最长 30 天生命周期；
- delete-account 与 beta-operations 使用各自最小权限凭据，不能共用通用管理 token；
- 上传只保存 age 密文、签名 manifest 与 deletion-journal/v2 对象；
- 真实 LIST/HEAD/GET、Content-Length、rv-sha256 元数据和两遍稳定 root 都必须现场验证；
- R2 account-wide Standard 用量 60% 告警，80% 停止新增邀请和历史回补。

GitHub Actions：

- beta-archive.yml 只在私有仓、固定 main、固定 workflow SHA、GitHub-hosted runner 下运行；
- beta-backup.yml 只用 OIDC 换取最长 10 分钟的任务凭据，禁止长期 R2 写 Secret；
- beta-restore.yml 只允许 workflow_dispatch 和受保护的 beta-restore-operator environment；
- PR、fork 或未审阅 ref 不得获得生产 environment 或 OIDC capability；
- 所有第三方 Actions 固定完整 commit SHA；
- Runner 不持有 Supabase service role、Binance Secret、Project KEK、恢复 pepper 或备份签名私钥；
- Actions 使用达到月度 Free 额度 60% 告警，保护线后停止大型归档和恢复演练，不自动购买额度。

完整 URL、Variable、Secret 与协议清单见 docs/BETA-OPERATIONS.md。该文档描述代码合同，不是现场
成功回执。

## 9. 配置 Vercel 候选

GitHub Pages 只能是 no-data landing，不得承载认证应用、Supabase 配置、导入 UI 或投资者数据。
完整应用使用独立 Vercel 项目和精确应用 Origin。

Vercel Production 构建至少配置：

| 变量 | 要求 |
| --- | --- |
| VITE_RELEASE_CHANNEL | production |
| VITE_BACKEND_MODE | invite-beta |
| VERCEL_GIT_COMMIT_SHA | Vercel 提供的权威完整 SHA |
| VITE_BUILD_SHA | 可选；若存在必须与权威 SHA 完全一致 |
| VITE_SUPABASE_URL | 精确 Tokyo project URL |
| VITE_SUPABASE_PUBLISHABLE_KEY | 仅 publishable browser key |
| VITE_EXPECTED_SUPABASE_PROJECT_REF | 精确 20 位 project ref |
| VITE_APP_ORIGIN | 精确应用 Origin |
| RV_INVITE_BETA_LIVE_RECEIPT | 受保护 runner 输出的 canonical 回执 |
| RV_INVITE_BETA_LIVE_SIGNATURE | 固定仓库公钥对应的 Ed25519 签名 |
| RV_INVITE_BETA_OPERATIONS_ATTESTATION | 独立运营证明 |
| RV_INVITE_BETA_OPERATIONS_SIGNATURE | 独立运营 Ed25519 签名 |

后四项在真实门禁完成前不得伪造、留空降级或由普通 Vite flag 代替。live gate 产生的旧
production-vault 兼容回执仍必须明确写
manualReleaseBlockers: not-evaluated-by-live-gate；未被 live driver 观察的 SMTP、监控、容量、
R2 与自然任务由另一位受保护操作者核查并签发 independent operations signature。新 invite-beta
回执也必须绑定同一 project ref、Origin、源提交、后端合同摘要和六项现场检查。

先构建受保护候选并完成 release.json、CSP、响应头、Supabase CORS 与零 console/page error
检查。没有签名回执时构建失败是正确行为，不能通过删除门禁代码绕过。

## 10. 真实两用户与双 Binance Key 现场门

静态测试、mock、dry-run、手工 SQL 或管理员查看均不能替代本节。使用两个不同受邀用户和两套
各自专用的 Binance USDⓈ-M 只读 Key；禁止复用投资者主 Key。接入前必须从 Binance 官方权限
响应取得明确机器证据，交易、提现、内部转账与通用转账权限必须关闭；权限不明确立即拒绝。

六项 invite-beta live receipt 检查必须全部完成：

1. two-user-isolation：两个 Auth subject 映射到两个稳定 personal tenant；同 UUID、Trade ID、
   connection ID、review ID 的交叉读取/写入统一不可枚举 404，且查询、日志和回执无另一用户内容。
2. sync：两连接都经自然 rv2 enqueue/worker 运行取得真实数据；逐 dataset/partition 验证
   attempted、fetched、committed、trusted，失败不推进 trusted；429、418、时钟偏差与撤销 Key
   fail closed。
3. review：对真实成交读出 rv-cloud-dataset/1，完成 expected-version 与 idempotency-key 写回；
   Ledger 重算不覆盖用户字段，PARTIAL/STALE/UNKNOWN/CONFLICT 继续锁定 KPI 与 AI。
4. disconnect：断开后任务停止、活动凭据版本销毁、历史复盘保留；旧凭据任务不能重放。
5. deletion：分别验证删除业务数据与删除账户；先停同步，再完成 deletion journal 和数据库删除，
   账户 Auth 最后删除；用户 A 被删时用户 B 数据与 Auth 保持完整。
6. recovery：从不超过 24 小时的真实 age/R2 备份恢复到空白隔离 Supabase 项目；先应用三项 rv2
   迁移与 tombstone，完成 owner recovery、原子发布、读模型重建和 Binance RECONNECT_REQUIRED；
   已删除用户不能复活，总恢复时间小于 8 小时。

同步必须覆盖 fills、income、orders、algo_orders、force_orders 与 position/balance snapshot。
最近数据成功不能冒充完整历史；三个月前的数据缺口必须通过真实异步归档或浏览器本地 CSV
补证，仍有 gap 时保持 PARTIAL/UNKNOWN。

## 11. 自然计划任务门

迁移或 workflow_dispatch 成功不算无人值守运行证据。对精确发布提交和精确项目观察至少一次自然
调度，并确认没有更新的失败：

| 调度 | 预期自然计划 | 必须验证 |
| --- | --- | --- |
| rv-production-vault-maintenance | 每 5 分钟 | postgres owner、命令摘要、最近自然成功 |
| rv-pg-cron-run-details-retention | 每日 03:17 UTC | 首次自然成功、7 日清理边界 |
| rv2-enqueue-due-syncs | 每 10 分钟 | 到期连接入队且不越租户 |
| rv2-wake-beta-worker | 每分钟 | 全局/连接租约、单页有界执行、失败不推 trusted |
| rv2-wake-beta-archive-worker | 每 10 分钟 | 独立 token、单步有界执行、CSV_REQUIRED/断路器状态真实 |
| beta-archive.yml | 每小时 17 分 | 私有 OIDC 绑定、真实归档 claim/download/attest/ingest |
| beta-backup.yml | 每日 18:43 UTC | v2 冻结页、age 密文、R2 HEAD、签名与容量观测 |

beta-restore.yml 是月度受控手工演练，不是自然 cron；必须单独记录空项目恢复回执。不要临时改
schedule、插入 cron.job_run_details、手工调用 wrapper 后冒充自然成功。三个数据库 cron 和两个
私有 workflow 都要取得自然回执；没有真实归档任务时的 `idle` 只能证明调度可达，不能证明归档数据闭环。

## 12. 容量、监控与发布切流

监控只记录 PII-free 聚合：

- 同步延迟、队列租约、429/418、认证失败、覆盖 gap、冲突与死信；
- DB 大小、R2 Standard 字节、备份年龄、Actions 分钟、Brevo 投递失败；
- Edge 4xx/5xx、自然 cron/workflow 最近成功与更新失败；
- 两用户 live receipt 与 independent operations signature 的年龄和摘要。

容量策略：

- Supabase DB 300 MiB 告警；
- 350 MiB 停止邀请与历史回补；
- 400 MiB 进入维护只读；
- 任一外部 provider 证据缺失、超过 24 小时或摘要不一致时记 UNKNOWN/STALE，不记 0；
- 任一免费额度达到 60% 先告警并复核；达到既定保护线停止扩张，不自动产生付费。

只有本手册第 0–12 节全部有绑定当前 SHA 的回执时，才可把候选标记为 invite-beta，并按最多 10
个账号逐步开放：内部账号 → 两用户 canary → 受控邀请。切 alias 后立即运行 production deployment
smoke、Classic 1440×1000 与 390×844 同视口视觉门、导航/图表/指标数量门、CSP/CORS、零外部
意外请求和零 console/page error。任何失败立即回滚 Classic alias，保持数据库新 generation
冻结并调查。

## 13. 回执清单

发布票据只收集经过净化的结构化字段：

- source commit、candidate commit、candidate manifest/hash；
- project ref、region、plan、函数版本/hash、迁移版本；
- Auth 配置布尔值和模板摘要；
- 自然 cron/workflow 名称、run ID、时间、状态和无 PII 摘要；
- live receipt、operations attestation 与签名摘要；
- R2 私有性/生命周期、备份对象大小/hash、恢复 RPO/RTO；
- 容量聚合、视觉截图 hash、production smoke 结果；
- Classic rollback deployment ID 与 alias 回指结果。

不得收集或打印邮箱、OTP、JWT、service role、Binance Key/Secret、HMAC、KEK、DEK、age identity、
R2 父凭据、SMTP 密码、删除 capability 或原始交易数据。

## 诚实边界

1. 专用 Tokyo 项目、五个函数、Vercel 生产站与自然任务的当前远端状态均未核验；这些都需要
   执行当日的外部回执。
2. Supabase Edge 没有固定出口 IP，当前 Beta 不能使用 Binance IP 白名单；共享出口风险仍在。
3. Project Secret holder、service role holder 和特权部署管理员理论上可以解密 Binance 凭据；
   交易与复盘数据不是 E2EE，也不是零知识。
4. Supabase Free 可能暂停，小时级同步只是尽力目标，不是实时性或可用性 SLA。
5. 自动同步、异步归档与 CSV 不能证明用户从未漏掉交易；覆盖不足必须继续锁定账户 KPI、
   Ledger PRIMARY、实验结论和 AI 分析。
6. R2 Standard 不是 WORM，R2 的 APAC 位置也不等于 Tokyo 驻留；Brevo 与 GitHub Runner 会
   短暂处理受限数据或邮箱元数据。
7. 本地测试、SQL parser、mock OIDC、dry-run、手工调用或旧 vault 七表/两函数存在，都不能替代
   真实双用户隔离、双只读 Key、删除、自然调度和空项目恢复。
8. 归档 cron 已进入迁移，但本地合同不能证明 Tokyo Vault token、自然触发、Binance 归档配额、
   临时链接、私有 OIDC Runner 或 R2/数据库提交在真实环境可用；取得同一发布提交的现场回执前仍是 NOT_READY。
9. 删除回执只能说明活动数据和本系统控制的备份清理时间，不能声称所有外部提供商副本即时消失。
10. 一旦收费、超过 10 个连接、要求 SLA/PITR/固定 IP/外部 KMS，或容量触及升级阈值，必须另开
    架构与成本审批，不能沿用本 Free Beta 手册直接扩张。
