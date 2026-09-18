# fine · 中转站余额监控 v2

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

监控 **sub2api** 与 **new-api** 类中转站余额的自托管面板。
**v2 技术栈**：Next.js 16 全栈（App Router + Route Handlers）+ Ant Design Pro（antd 6 + pro-components）+ **SQLite 单文件持久化**，浅色 / 深色双主题。

后端逻辑（站点适配、告警引擎、消费预测、日报）与 v1 同源平移——行为与 v1 完全一致；存储从 JSON 文件升级为 **SQLite 单文件数据库**（余额历史落表，供经营分析聚合），无需外部数据库进程，复制 `.db` 文件即可完成迁移与备份。

## 功能

- **总览面板**：总剩余余额、**今日总消耗**、日均消耗（估算）、低余额 / 耗尽、查询异常统计；**总余额趋势图**（全站合计、24 小时～30 天切换）与**今日消耗对比图**（当日实际扣费）；每站余额、今日消耗、**近 48 小时余额迷你走势图**、状态标签、查询延迟
- **经营分析页（v2 新增）**：收支利润趋势（成本 = 上游消耗 × 汇率 + 固定摊销；收入 = 下游 / 转售 Key 消费）、**消耗时段热力图**（星期 × 小时找高峰）、站点成本占比、**余额跑道图**（各站预计可用天数，红黄绿分档）、固定成本 vs 用量成本、累计消耗曲线；7 / 14 / 30 天切换
- **今日消耗与站点一致**：Sub2API 站点直接读取站点用户仪表盘同款接口（`today_actual_cost`，即今日实际扣费），与站点页面显示的数值完全一致；其他类型按余额历史推算并以 ≈ 标注
- **用量统计页**：分站点、分模型、分时段的 Token 消耗——今天 / 近 24 小时 / 近 7 天 / 近 30 天，含消耗趋势图、分模型排行与明细表
- **Sub2API 账号密码模式**：只填邮箱 + 密码，面板自动登录换取令牌；令牌过期自动刷新（支持轮换），刷新失败自动重新登录——**全程无需人工干预**
- **余额预测**：余额历史（30 天）+ 实时速率分层估计（近 3 小时优先）预计耗尽时间；点击站点查看趋势图（历史折线 + 耗尽投影）
- **通知告警**：余额偏低 / 耗尽 / 查询失败（**可配连续失败阈值与失败快速重试**）/ 恢复正常 / 预计即将耗尽（阈值可按天或小时），状态迁移触发、自动去重、可配重复提醒；**每类告警可单独选择推送渠道**（不选 = 所有启用渠道；删除渠道自动清理绑定）；可将单站标记为**不再续费**，低余额仅提醒一次；支持 10 种渠道：Telegram、钉钉（加签）、企业微信、飞书（签名）、Bark、ntfy、Server酱、Resend 邮件、SMTP 邮件（零依赖客户端）、自定义 Webhook，每渠道可单独测试
- **我的站点（下游分析）**：自营 new-api 站点的分时段 / 分模型 / **分用户**用量与消费，**未来 7 天消费预测**（组合模型 + conformal 区间，历史满两周自动启用周末模式识别）
- **分组与渠道口径 + 环比**：读 new-api `/api/data/flow`，按**分组**、**上游渠道**、**用户 × 分组**拆分消费，并与上一等长窗口对比（今天 vs 昨天同一时刻、7 天 vs 前 7 天），跳变一眼可见——换上游渠道、某个分组倍率涨这类原因在只有模型维度的看板里看不出来
- **日志精算（补上看板漏计的 token）**：new-api 看板的 `token_used` 只写 `prompt + completion`，**缓存读 / 缓存写不在里面**，于是 Claude 这类缓存占九成的模型会显示成「token 近零、消费很大」。精算按需翻消费日志明细（`/api/log/`，可选 2 千～2 万条），算出真实 token（含缓存读写）、缓存读写量、**长上下文请求数与消费**（≥20 万 token，含 `matched_tier` 阶梯计价）与平均计价倍率；受影响的行在明细表里标「倍率/缓存计价」，各表另有 `¥/M` 有效单价与环比列
- **利润分析**：下游收入（普通用户消费 × 售价汇率）− 全部监控上游的期内成本（不要求出现在 New API 渠道列表；用量 × 充值汇率，固定成本按天摊销）；用量接口返回空数据但余额确有下降时自动回退历史推算；纯观察或重复汇总节点可关闭"计入利润成本"；支持渠道匹配别名（容器域名 / 内网 IP）；**管理员 / root 转售 Key 可标记计入收入**；缺省汇率会明确标记利润不完整
- **每日日报**：每天定时（默认北京时间，可用 `REPORT_TIME_ZONE` 覆盖）汇总昨日经营——消费环比、收入/成本/利润、Top 模型与用户、上游余额与耗尽预警、未来 7 天预测——推送到通知渠道（邮件全文，IM 截断）；支持预览与立即发送
- **人民币折算**：每站可配充值汇率（站点 $1 折合 ¥ 多少）；金额主显人民币，站点原始余额次要展示；余额告警阈值仍按站点余额判断
- **PWA**：可添加到手机主屏幕独立运行（品牌图标 + 离线壳缓存；静态资源网络优先，API 不缓存）
- **面板登录**：scrypt 哈希 + HMAC 签名会话 Cookie（7 天，登录失败限流，**HTTPS 自动启用 Secure 标记**）；默认 `admin / admin123`，登录后请在「设置」中修改

## 支持的中转站类型

| 类型 | 查询方式 | 需要填写 |
|------|----------|----------|
| **New API（访问令牌）** | `GET /api/user/self`，头 `Authorization` + `New-Api-User` | 站点地址、系统访问令牌、用户 ID |
| **New API（sk 密钥）** | OpenAI 兼容 `/dashboard/billing/subscription` + `/usage` | 站点地址、`sk-` 密钥 |
| **Sub2API（登录令牌）** | `GET /api/v1/auth/me`，`Bearer JWT` | 站点地址、登录 JWT（过期需手动更换） |
| **Sub2API（账号密码）** | 自动 `POST /api/v1/auth/login` / `refresh` / `me` | 站点地址、登录邮箱、密码（开启 2FA 的账号不支持） |
| **固定成本（不访问）** | 不访问任何接口 | 每次付费金额（¥）+ 覆盖天数；日均摊销计入利润成本 |

## 运行

**SQLite 单文件模式（默认，推荐）**：无需安装 MySQL，数据库就是项目目录下的 `data/fine-apihub.db`。

```bash
cp .env.example .env.local        # SQLite 默认；MySQL 模式设置 DB_DRIVER=mysql 和 DB_*
npm install
npm run db:migrate                # 建库；若配置了 V1_DATA_DIR 且库为空，一次性导入 v1 数据
npm run build && npm start        # 打开 http://127.0.0.1:3000，账号 admin / admin123
```

开发模式：`npm run dev`。对外暴露前请务必修改默认密码，并**建议置于 HTTPS 反代之后**（Cookie Secure 标记依赖 HTTPS）。

### Windows 一键启动

双击项目根目录的 **`start.bat`** 即可（自动完成：检查 Node 版本 → 安装依赖 → 初始化数据库 → 首次构建 → 启动并打开浏览器）。

```bat
start.bat                  :: 默认 3000 端口，已有构建产物就跳过重建
start.bat --rebuild        :: 强制重新构建
start.bat --port 3001      :: 换端口
```

> `start.bat` 刻意保持**纯 ASCII**：cmd.exe 按 OEM 代码页（简体中文为 936）解析 .bat，
> 含中文的 UTF-8 批处理会被读坏导致脚本报错。中文说明就本节。

数据库文件位置：
- 默认：`data/fine-apihub.db`（项目根目录）
- 自定义：`DB_PATH=/path/to/your.db`

**备份**：推荐用内置的一致性备份命令（WAL 模式下直接复制 `.db` 可能拿到不完整状态）：

```bash
npm run db:backup                      # → data/fine-apihub-backup-<时间戳>.db
npm run db:backup -- /path/to/out.db   # 指定目标路径
```

若服务已停止（WAL 已 checkpoint），也可直接复制 `data/fine-apihub.db`。

## 从 v1 迁移

v1 的 `data/` 目录（stations.json / history.json / secret.key）可一次性导入：

1. 设环境变量 `V1_DATA_DIR` 指向 v1 的 data 目录
2. 启动（或 `npm run db:migrate`）：**库为空才导入**，幂等、绝不覆盖已有数据；会话密钥一并沿用，已登录设备不掉线
3. 导入完成后可移除 `V1_DATA_DIR` 配置

## Docker 部署（可选）

> ⚠️ 本仓库**没有预构建镜像**：Docker CI 已移除（`spec/SECURITY.md`），因此 compose 里用 `build:` **从源码构建**，需要在仓库内执行。

```bash
cd fine-apihub/deploy
docker compose up -d --build        # 首次构建约几分钟
```

- **fine-apihub**：面板本体，容器内监听 `8787`；SQLite 库挂在 `deploy/db-data/`，升级不丢数据（`git pull` 后重新 `up -d --build`）
- **watchtower**（compose 里默认注释）：自动拉取新镜像并重启面板——**仅在把镜像发布到 GHCR 后才有意义**，启用方法与注意事项见 compose 文件末尾
- 切到外部 MySQL：把 `DB_DRIVER` 改成 `mysql` 并填 `DB_*`（完整变量见 `.env.example`）

## 通知渠道速查

| 渠道 | 需要 |
|------|------|
| Telegram | Bot Token + Chat ID |
| 钉钉 | 群机器人 Webhook（安全设置选「加签」则再填密钥） |
| 企业微信 | 群机器人 Webhook |
| 飞书 | 群机器人 Webhook（可选签名密钥） |
| Bark | Device Key（可自建服务器） |
| ntfy | Topic（可自建服务器 / 访问令牌） |
| Server酱 | SendKey（自动识别 sctp 新版 key） |
| Resend | API Key + 已验证域名的发件人 + 收件人（逗号分隔多个） |
| SMTP | 服务器地址 + 端口（465 SSL / 587 STARTTLS）+ 账号密码 + 发件人 / 收件人 |
| Webhook | 任意 URL，POST JSON `{title, body, event, station, ...}` |

## 目录结构

```
fine-apihub/
├── app/                  Next.js App Router
│   ├── (dashboard)/      面板页面：总览 / 中转站 / 我的站点 / 用量 / 经营分析 / 通知 / 设置
│   ├── api/              26 个 REST 端点（Route Handlers）
│   └── login/            登录页
├── server/               后台常驻逻辑：refresh.js 刷新调度（分档 + 用量采样）/ report.js 日报 / own-helpers
├── lib/                  核心逻辑：providers / alerts / notify / smtp / forecast / auth + runtime 单例
├── db/                   数据持久化层：pool（SQLite/MySQL 双驱动）/ store / history / usage / migrate / backup
├── spec/                 规范文档：架构（含上游接口实测约束）/ API / 数据模型 / 安全 / 预测 / Sub2API Key 用量
├── deploy/               docker-compose.yml（面板 + 可选 watchtower）
├── tools/                check-standalone.mjs 构建产物守卫 / gen-icons.mjs 图标生成
├── data/                 运行时数据（SQLite 库 + WAL）——已 gitignore，含凭证
├── instrumentation.ts    服务启动钩子：初始化 + 定时刷新 + 日报调度
├── start.bat             Windows 一键启动
├── AGENTS.md             Agent 记忆入口（模块边界 / 红线 / 开发约定）
└── public/               PWA manifest / 图标 / service worker
```

## 安全说明

- 面板密码以 **scrypt** 哈希存储；会话为 HMAC-SHA256 签名的 HttpOnly Cookie
- **Cookie Secure 标记**：HTTPS 部署时自动启用（通过 `X-Forwarded-Proto` 或请求协议检测）
- **安全响应头**：全局启用 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy: camera=(), microphone=(), geolocation=()`
- API 路由启用 `Cache-Control: no-store`，防止代理/浏览器缓存敏感数据
- 中转站凭证保存于 SQLite 数据库（`data/fine-apihub.db`）——请妥善保护数据库文件
- API 响应中不回传任何令牌 / 密钥 / 密码原文（统一脱敏处理）
- 登录失败限流：同 IP 失败 10 次锁定 5 分钟
- 构建产物经 `tools/check-standalone.mjs` 与 `Dockerfile` 双重兜底：**凭证目录与数据库文件绝不进入镜像**（Next 的文件追踪本身拦不住，曾实测泄露，见 `spec/SECURITY.md` §3.3）

## 测试

```bash
npm test        # 运行全部 59 项测试
```

## 开源协议

[MIT](LICENSE) © fine
