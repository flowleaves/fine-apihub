// 应用运行时单例：连库→建表→载入 Store/History→会话密钥→启动后台任务。
// Next.js 下用 globalThis 缓存，HMR/多次 import 不会重复初始化。
// 所有 API 路由通过 getRuntime() 取服务实例（等价 v1 server.js 顶部的全局变量）。
import { randomBytes } from "node:crypto";
import { getPool, ensureSchema, resolveDbPath } from "../db/pool.js";
import { Store } from "../db/store.js";
import { History } from "../db/history.js";
import { SessionManager } from "./auth.js";

async function loadSessionSecret(pool) {
  const [rows] = await pool.query("SELECT v FROM meta WHERE k = 'session_secret'");
  if (rows.length) {
    // SQLite 把 JSON 存为 TEXT，标量值读回来是带引号的 JSON 文本（如 "\"abc\""），需 parse 一次
    const v = rows[0].v;
    return typeof v === "string" && v.startsWith('"') ? JSON.parse(v) : v;
  }
  const secret = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO meta (k, v) VALUES ('session_secret', ?)", [JSON.stringify(secret)]);
  return secret;
}

async function init() {
  const pool = getPool();
  await ensureSchema(pool);
  // v1 数据迁移不在此处：db/migrate.js 引用 stations.json 等字面量会被 Next
  // 构建追踪连真实凭证一起拷进 standalone 产物。迁移由部署入口显式执行
  //（Docker CMD 链式 node db/migrate.js，或本地 npm run db:migrate），幂等且库非空即跳过。

  const store = await new Store(pool).load();
  const history = await new History(pool).load();
  const sessions = new SessionManager(null);
  sessions.secret = await loadSessionSecret(pool);

  const rt = { pool, store, history, sessions, startedAt: Date.now() };

  // 清理遗留的演示站：mock 路由已删除，指向 /mock 的站点会永久查询失败
  const staleDemos = store.list().filter((s) => s.demo && String(s.baseUrl || "").includes("/mock"));
  if (staleDemos.length) {
    for (const s of staleDemos) await store.remove(s.id);
    console.log(`  已清理 ${staleDemos.length} 个遗留演示站`);
  }

  // 后台任务：全量刷新 → 定时轮询 + 每日日报
  try {
    const { refreshAll, restartPolling } = await import("../server/refresh.js");
    rt.refreshAll = refreshAll;
    rt.restartPolling = restartPolling;
    refreshAll(rt).catch(() => {});
    restartPolling(rt);
  } catch (err) {
    console.error("  后台刷新模块未就绪:", err?.message);
  }
  try {
    const { startReportScheduler } = await import("../server/report.js");
    startReportScheduler(rt);
  } catch (err) {
    console.error("  日报调度模块未就绪:", err?.message);
  }

  console.log(`\n  FINE-APIHUB v2 已就绪（${(process.env.DB_DRIVER || "sqlite").toLowerCase() === "mysql" ? "MySQL" : `SQLite: ${resolveDbPath()}`}）\n`);
  return rt;
}

export function getRuntime() {
  // 初始化失败不缓存失败态：下次调用重试（例如 MySQL 短暂不可用）
  if (!globalThis.__FA_RT) {
    globalThis.__FA_RT = init().catch((err) => {
      globalThis.__FA_RT = null;
      throw err;
    });
  }
  return globalThis.__FA_RT;
}
