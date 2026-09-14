# 安全审计报告：relay-monitor 二创前代码审查

> 审计对象：`relay-monitor` v2.2.0（当前工作区状态）
> 审计日期：2026-09-14
> 审计目的：**确认是否存在后门 / 隐藏外联 / 数据窃取，并给出「改为自有项目」的必改清单**
> 审计范围：项目自身代码 82 个源文件（依赖漏洞按要求不在范围内）

---

## 一、结论（先看这里）

**未发现任何后门、隐藏外联、凭据外传或数据窃取代码。**

14 项针对性检查全部通过。这个项目的网络行为是**完全可追溯**的：它只访问两类地址 ——
（1）你自己在界面里配置的中转站地址与通知渠道地址；（2）本地演示用的 mock 地址。

它持有你所有中转站凭证，但**没有任何一行代码把这些凭证发往作者或第三方**。

不过，二创前有 **2 项必改（P0）** 和 **3 项建议加固（P1）**，与安全性无关但与「归属」和「暴露面」有关，见第四节。

---

## 二、审计方法

不依赖关键字匹配，而是**逐类穷举 + 交叉验证**：先穷举所有「可能外联/执行/读文件」的代码点，再逐个核对目标是否可追溯、是否与声明功能相符。

| # | 检查项 | 方法 |
|---|---|---|
| 1 | 全部外部 URL | 正则提取全部 `http(s)://`，人工核对每个域名归属 |
| 2 | 全部 IP 地址 | 提取所有 IPv4 字面量 |
| 3 | 全部域名（含注释） | 提取所有 `*.com/net/io/...` 出现频次 |
| 4 | 危险代码执行 | `eval` / `new Function` / `child_process` / 动态 `require` / `vm` / `atob` |
| 5 | 编码混淆 | 长度 ≥80 的 base64/hex 字符串字面量 |
| 6 | 硬编码凭据 | `api_key/secret/token/password = "长串"` |
| 7 | 网络出站调用点 | 穷举 `fetch` / `http.request` / `axios` 调用位置 |
| 8 | **文件系统访问** | 穷举 `readFile` / `readdir` / `homedir` / `AppData` / `.ssh` / `Cookies` |
| 9 | 凭据脱敏 | 核对所有站点响应是否剥离密钥 |
| 10 | **授权覆盖** | 逐个端点检查是否有 `withAuth` 包装 |
| 11 | 认证强度 | 密码哈希 / 会话签名 / 时序攻击防护 / 暴力破解限流 |
| 12 | 定时器与调度 | 穷举 `setInterval` / `setTimeout`，确认无隐藏回调 |
| 13 | Service Worker | 检查是否拦截请求或外传数据 |
| 14 | Git 历史 | 作者一致性、提交内容、被删除文件、分支与标签 |

补充：依赖生命周期钩子（`postinstall` 等）、CI 工作流、Dockerfile、静态资源清单、`.env` 入库情况。

---

## 三、后门排查结果（逐项）

### 3.1 网络外联 —— 全部可追溯 ✅

源码中出现的**每一个**外部域名及归属：

| 域名 | 归属 | 说明 |
|---|---|---|
| `api.telegram.org` | 通知渠道 | Telegram 官方 Bot API，用户自配 token |
| `api.day.app` | 通知渠道 | Bark 官方（可被 `cfg.server` 覆盖） |
| `ntfy.sh` | 通知渠道 | ntfy 官方（可被 `cfg.server` 覆盖） |
| `sctapi.ftqq.com` / `*.push.ft07.com` | 通知渠道 | Server酱官方 |
| `api.resend.com` | 通知渠道 | Resend 官方邮件 API |
| `ghcr.io` | 部署 | **本项目的**容器镜像仓库（CI 推送用） |
| `example.com` / `yourdomain.com` / `your-relay.com` | 占位符 | 测试与界面示例 |
| `gmail.com` | 文档 | SMTP 配置示例 |

**没有任何一个域名属于作者个人或未知第三方。** 通知渠道全部发往**用户在设置页自己填写的**端点 —— 例如 `sendDingTalk` 用的是 `cfg.webhook`，`sendWebhook` 用的是 `cfg.url`，都不是硬编码地址。

IP 扫描：仅出现 `127.0.0.1`（本地回环），且全部在测试文件与本地 mock 配置中。

> 关键验证：`server/demo.js` 的 `MOCK_BASE = http://${HOST}:${PORT}/mock` —— 演示站指向**本地**，不会外联。

### 3.2 代码执行 —— 干净 ✅

`eval` / `new Function` / `child_process` / `execSync` / `spawn` / `vm` / `process.binding` **均未出现**。

命中的 `exec` 全部是合法用途：
- `db.exec("PRAGMA ...")` / `db.exec("BEGIN")` —— SQLite 驱动
- `/^(\d{3}).../.exec(buf)` —— SMTP 响应码正则匹配

### 3.3 文件系统访问 —— 干净 ✅（这项最关键）

后门最典型的手法就是偷读浏览器 Cookie、SSH 密钥、钱包文件。本项目**全部**文件访问点：

| 位置 | 读取内容 | 是否合理 |
|---|---|---|
| `app/api/meta/route.js` | `package.json` | ✅ 用于「关于」页显示版本 |
| `lib/auth.js` | 会话密钥文件（自建） | ✅ 会话签名所需 |
| `db/migrate.js` | v1 迁移数据（需显式配 `V1_DATA_DIR`） | ✅ 一次性迁移 |

**未出现** `homedir` / `USERPROFILE` / `AppData` / `.ssh` / `Cookies` / `Login Data` / `Local State` 中的任何一个。

### 3.4 凭据处理 —— 规范 ✅

- 存在**统一的脱敏函数** `server/stations.js::redact()`，被所有站点相关端点调用
- 它明确剥离 `accessToken` / `apiKey` / `password` / `s2Tokens`，仅返回布尔标记（`hasAccessToken` 等）和令牌过期时间
- **未发现任何把凭据写入日志的语句**（已针对性搜索 `console.*` 中的 token/password/secret）

### 3.5 授权覆盖 —— 24/24 完整 ✅

全部 24 个 API 端点均有 `withAuth` 保护；唯一例外是 `auth/login`，它用 `withRuntime`（登录接口本身不能要求登录，正确）。

### 3.6 认证强度 —— 扎实 ✅

| 项 | 实现 | 评价 |
|---|---|---|
| 密码存储 | `scryptSync(password, salt, 32)` + 随机盐 | ✅ 抗暴力破解 |
| 密码比对 | `timingSafeEqual` | ✅ 防时序攻击 |
| 会话 | HMAC-SHA256 签名，含 `exp` 过期 | ✅ 不可伪造 |
| Cookie | `HttpOnly; SameSite=Lax; Path=/` | ⚠️ 缺 `Secure`，见 P1-2 |
| 登录限流 | 同 IP 失败 10 次锁 5 分钟 | ✅ |

### 3.7 定时器 —— 无隐藏回调 ✅

全部 `setInterval` / `setTimeout` 均可追溯：
- `server/refresh.js` —— 余额轮询、失败快速重试
- `server/report.js` —— 每日日报调度
- `lib/notify.js` / `lib/providers.js` —— 请求超时中断
- `lib/smtp.js` —— SMTP 连接超时

没有发现任何「定时向外部发送数据」的逻辑。

### 3.8 Service Worker —— 干净 ✅

`public/sw.js` 只做静态资源缓存：
- 明确跳过 `/api/` 与 `/mock/`（`url.pathname.startsWith("/api/")` 直接放行）
- 不拦截任何跨域请求
- 无数据上报

### 3.9 Git 历史 —— 干净 ✅

- **单一作者**：`lettimepassby <86416409@qq.com>`，全部 40+ 次提交一致，无异常署名
- 提交信息全部为正常的功能/修复描述
- 被删除的文件只有 v1→v2 重构产物（`public/app.js`、`index.html`、`styles.css`、`server.js`）—— 正常
- 分支：`main` / `v2` / `codex/fix-profit-cost-calculation` —— 正常

### 3.10 其他 ✅

| 项 | 结果 |
|---|---|
| `postinstall` / `preinstall` 等生命周期钩子 | 无 |
| `.env` 是否入库 | 否（仅 `.env.example`，无真实值） |
| CI 工作流 | 标准构建 + 推送镜像，无异常步骤 |
| Dockerfile | 标准 Next standalone 构建，无 curl\|sh 之类的可疑步骤 |
| 静态资源 | 仅图标 + manifest + sw，无二进制异常文件 |
| 可疑标记（TODO/backdoor/临时） | 无 |
| 编码混淆长串 | 无 |

---

## 四、需要处理的问题

### P0 — 二创必改（归属问题）

**P0-1　`git remote` 仍指向原作者仓库**

```
origin  git@github.com:lettimepassby/relay-monitor.git
```

风险：在二创过程中执行 `git push` 会**直接推到原作者仓库**（若有权限）或报错。
建议：
```bash
git remote rename origin upstream        # 保留上游，便于后续合并作者更新
git remote add origin git@github.com:<你的账号>/<你的仓库>.git
git push -u origin main
```
保留 `upstream` 是**推荐做法** —— MIT 协议下你可以自由二创，同时还能选择性吸收作者后续的修复。

**P0-2　CI 会推送到错误的镜像仓库**

`.github/workflows/docker.yml` 用 `ghcr.io/${{ github.repository }}` 推送。换成你自己的仓库后 `github.repository` 会自动变成你的，**这条其实会自愈**。但要确认：
- 若你保留了原仓库名，镜像会推到你的 namespace 下（正常）
- 若不需要 Docker 镜像（你已决定走本地 SQLite），建议**直接删掉这个 workflow**，省得每次 push 都跑一次无用构建

### P1 — 安全加固建议

**P1-1　`/mock/*` 路由无任何授权保护**

`app/mock/**` 下的路由没有 `withAuth` 包装，任何人访问 `/mock/newapi/xxx/api/user/self` 都能拿到响应。

- **实际风险：低** —— 它只返回 `server/demo.js` 里的合成演示数据，**不读数据库、不碰凭证、不访问 store**
- **但仍是多余的攻击面**，且暴露了你部署了此面板

建议二创时二选一：
- 用环境变量门禁：`if (process.env.NODE_ENV === "production" && !process.env.ENABLE_DEMO) return 404`
- 或直接删除 `app/mock/` 与 `server/demo.js` 的播种逻辑

**P1-2　Session Cookie 缺 `Secure` 标记**

`lib/auth.js` 的 `cookieHeader()` 输出 `HttpOnly; SameSite=Lax; Path=/`，没有 `Secure`。

后果：若同时存在 HTTP 访问入口，Cookie 可能在明文连接上被发送。README 已建议「置于 HTTPS 反代之后」，但代码层面加固更稳妥。

建议：加一个环境变量开关，HTTPS 部署时置位 `Secure`（本地 HTTP 调试时不置位）。

**P1-3　`instrumentation.ts` 初始化失败会 `process.exit(1)`**

```js
if (process.env.NODE_ENV === "production") process.exit(1);
```

这是**有意的设计**（数据库不可用时宁可不启动，避免带着空状态运行把凭证覆盖掉）。但二创后如果你改用 SQLite 且库文件路径写错，进程会**直接退出**而非报错后继续 —— 排查时要知道这一点。

---

## 五、二创时发现的代码状态问题（与安全无关，但会影响你）

当前工作区处于**双驱动迁移的中间状态**，有几处不一致：

**① `mysql2` 被移出 `serverExternalPackages`，但 MySQL 模式仍保留**

`next.config.mjs` 现在是：
```js
serverExternalPackages: ["@cap.js/wasm"],   // 原本还有 "mysql2"
```
而 `db/pool.js` 仍保留 `DB_DRIVER=mysql` 分支。

风险：mysql2 含原生/CJS 依赖，被 Next 打包进 bundle 后**在 standalone 产物里可能加载失败**。
建议：若确定只用 SQLite，**彻底删掉 MysqlPool 分支与 mysql2 依赖**；若保留双驱动，把 `"mysql2"` 加回 `serverExternalPackages`。

**② Dockerfile 未同步双驱动**

`Dockerfile` 注释仍写「运行时才初始化 MySQL」，且未设置 `DB_DRIVER`，但 `deploy/docker-compose.yml` 已改为 `DB_DRIVER=sqlite` + 挂载 `./db-data`。两处口径不一致，容器里实际走的是 `DB_DRIVER` 默认值（`sqlite`）。

**③ 双驱动的 SQL 方言方向容易踩坑**

当前约定是「**源码写 MySQL 方言，SQLite 驱动负责翻译**」（`ON DUPLICATE KEY UPDATE` → `ON CONFLICT DO UPDATE SET`）。`MysqlPool.query` 只反向翻译了 `INSERT OR IGNORE` → `INSERT IGNORE`。

隐患：**若将来有人用 SQLite 方言写新代码**（比如直接写 `ON CONFLICT`），MySQL 模式会**静默出错**。建议二创时二选一：要么彻底单驱动，要么在 `MysqlPool` 里补齐反向翻译并加测试。

**④ 项目当前可运行状态**

`npm test` → **44/44 全部通过**，耗时约 7.3 秒。项目功能层面是健康的。

---

## 六、值得保留的安全设计（二创时不要破坏）

审下来这个项目有几处安全实践做得比一般自托管面板好，建议保留：

1. **统一脱敏入口** `server/stations.js::redact()` —— 新增站点字段时，只要在 `redact` 里同步处理，就不会泄露
2. **数据库读取失败即中止启动** —— `db/store.js::load()` 明确注释「绝不带着空状态运行（那会在首次 save() 时覆盖掉现有站点凭证）」。这个保护很关键，别为了「能启动」而放宽
3. **构建产物排除凭证目录** —— `next.config.mjs` 的 `outputFileTracingExcludes` 排除 `data/**` 与 `*.db*`，防止凭证被拷进镜像
4. **`timingSafeEqual` 比对会话签名** —— 别改成 `===`
5. **登录限流** —— 别去掉
6. **通知渠道不引第三方 SDK**，全部原生 `fetch` —— 依赖面小，审计容易
7. **`.gitignore` 锚定根目录的 `/data/`** —— 注释里专门说明「不加斜杠会连 `app/mock/**/api/data/` 一起吞掉」，这个细节别动

---

## 七、审计清单速查

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 外部 URL 是否可追溯 | ✅ 全部为通知渠道官方端点或占位符 |
| 2 | 是否存在未知 IP | ✅ 仅 127.0.0.1 |
| 3 | 危险代码执行 | ✅ 无 |
| 4 | 编码混淆 | ✅ 无 |
| 5 | 硬编码凭据 | ✅ 无（仅测试假值） |
| 6 | 文件系统越权读取 | ✅ 未触碰浏览器/SSH/用户目录 |
| 7 | 凭据外传 | ✅ 无 |
| 8 | 凭据写日志 | ✅ 无 |
| 9 | 凭据脱敏 | ✅ 统一 redact() |
| 10 | 授权覆盖 | ✅ 24/24 |
| 11 | 认证强度 | ✅ scrypt + HMAC + 时序安全比对 + 限流 |
| 12 | 隐藏定时回调 | ✅ 无 |
| 13 | Service Worker 外传 | ✅ 无 |
| 14 | Git 历史异常 | ✅ 无 |
| 15 | 依赖生命周期钩子 | ✅ 无 |
| 16 | 可疑标记/后门注释 | ✅ 无 |

**总计：未发现后门。可安全二创。** 请优先处理 P0-1（改 git remote）。
