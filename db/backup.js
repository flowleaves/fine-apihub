// 一致性备份 CLI：把 SQLite 库**在线**备份到指定文件。
//
// 为什么需要它：WAL 模式下直接 `cp data/fine-apihub.db` 可能拿到不完整状态
// （已提交事务可能还在 -wal 里），必须走 SQLite 官方 online backup API
// —— 即 db/pool.js::backupTo()。备份期间读写可正常进行，不阻塞业务。
//
// 用法：
//   npm run db:backup                      # → data/fine-apihub-backup-<时间戳>.db
//   npm run db:backup -- /path/to/out.db    # 指定目标路径（目录不存在会自动创建）
import { backupTo, resolveDbPath, getDb } from "./pool.js";

if ((process.env.DB_DRIVER || "sqlite").toLowerCase() === "mysql") {
  console.error("当前 DB_DRIVER=mysql：本命令只做 SQLite 在线备份；MySQL 请用 mysqldump。");
  process.exit(1);
}

try { process.loadEnvFile(".env"); } catch {}
try { process.loadEnvFile(".env.local"); } catch {}

// YYYYMMDDHHmmss（UTC；文件名用 UTC 以免机器时区不同导致重名）
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
const dest = process.argv[2] || `data/fine-apihub-backup-${stamp}.db`;

try {
  const out = await backupTo(dest);
  console.log(`备份完成：${out}`);
  console.log(`源库：${resolveDbPath()}`);
} catch (err) {
  console.error(`备份失败：${err?.message}`);
  process.exitCode = 1;
} finally {
  // 关闭本进程打开的库句柄（CLI 短生命周期，不影响其他进程）
  try { getDb().close(); } catch {}
}
