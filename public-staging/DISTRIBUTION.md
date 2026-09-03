# 公开 Web 发布状态

STATUS: not_distributed
TARGET_LANDING_URL: https://player1314520.github.io/binance-futures-review/
TARGET_PRODUCTION_URL: pending-dedicated-origin
SOURCE_URL: https://github.com/player1314520/binance-futures-review

当前文件描述的是“邀请制 + 服务端可读 Binance 云复盘”生产候选；旧端到端加密 vault 仅保留为只读迁移源。
公开源码与无数据入口可以独立发布，
但 `not_distributed` 专指完整应用尚未在独立 origin 绑定专用 Supabase、双用户 live-gate 回执并完成线上验收；
不能把 Pages 入口、源码提交或无后端预览当作完整生产站的验收证据。

## 上线闭环门禁

- 私有源提交必须干净，精确白名单导出必须生成确定性 manifest，并通过当前树与完整 Git 历史隐私扫描。
- GitHub Pages 只部署无脚本、无输入、无存储、无网络请求的产品入口页；不得承载登录、导入或云仓。
- 完整应用只部署到独立 Vercel/custom-domain origin。生产构建必须绑定完整提交、精确 Supabase ref、
  精确应用 origin 与双用户 live-gate 回执，并核对 CSP、响应安全头、无 source map 和 `release.json`。
- 公开候选必须包含精确审阅过的生产迁移链（含 rv2 `001`、restore lineage `002`、capacity `003`）及
  `delete-account`、`publish-vault-head`、`binance-beta`、`restore-v2`、`beta-operations` 的无秘密运行时代码、
  部署手册和对应测试；服务端密钥、私有 runner 凭据、真实环境值和无关旧迁移一律不得带入。
- 公开候选必须在真实 Chromium 中验证生产构建、17 个桌面入口、移动端 390px 布局、指标证据门、
  复盘闭环、完整备份、CSP 零外联以及浏览器原生 PBKDF2/AES-GCM/Ed25519；不能只依赖 jsdom。
- 部署后还要用两名受邀测试用户和两套专用只读 Binance Key 完成跨租户隔离、小时同步、复盘写回、
  权限错误拒绝、断开、业务数据/账户删除、空项目恢复及 tombstone 防复活；旧 vault 的签名篡改、并发冲突
  与响应丢失对账也必须保持通过，
  才能将状态改为 `distributed`。

## 诚实边界

1. `not_distributed` 表示代码候选存在，不表示独立生产站、Supabase 或真实双用户验收已经完成；Pages 入口页也不是生产应用。
2. 候选包含可审计、可重复部署的 Supabase SQL 与 Edge Function 源码，但不包含已创建项目、认证用户、
   服务端密钥或任何真实环境值；这些仍须在隔离项目中部署并完成真实双用户验收。
3. `release.json` 只能绑定已部署前端提交，不能证明用户导入数据完整，也不能证明外部服务持续可用。
4. 产品没有交易执行能力，不提供交易信号或收益保证，不构成投资建议。
