// SQLite 驱动（node:sqlite 内置模块，无原生依赖）。
//
// 设计目标：让上层（store / history / migrate / runtime）保持与 mysql2 版**几乎一致**的调用形状，
// 因此这里刻意保留 mysql2 的 `query(sql, params) → [rows]` 签名与 `getConnection()` 事务对象，
// 代价是内部要做一点 SQL 方言转写（见 §归一化）。这样迁移的改动面被压到最小，
// 且将来若要切回 MySQL / better-sqlite3，只需替换本文件的驱动实现。
//
// 为什么不用 mysql2：目标是单机本地运行，SQLite 单文件即全部状态（含凭证），
// 复制 .db 文件即完成迁移与备份，不需要外部数据库进程。
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import mysql from "mysql2/promise";

let _db = null;

// 数据库文件位置：默认项目根的 data/fine-apihub.db。
// 显式传 ":memory:" 用于测试。
export function resolveDbPath() {
  const raw = process.env.DB_PATH || join(process.cwd(), "data", "fine-apihub.db");
  return raw;
}

export function getDb() {
  if (_db) return _db;
  const file = resolveDbPath();
  // :memory: 不落盘，无需建目录
  if (file !== ":memory:") {
    const dir = isAbsolute(file) ? dirname(file) : dirname(join(process.cwd(), file));
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(file);
  // WAL：后台刷新循环（60s 一拍）与 API 请求会并发读写同一个库文件，
  // 默认的 rollback journal 会让读阻塞写；WAL 允许读写并行。
  // busy_timeout 兜住偶发的写锁竞争（WAL 下仍可能有短暂写锁）。
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  // 崩溃安全：NORMAL 在 WAL 下不会丢已提交事务，性能远好于 FULL
  db.exec("PRAGMA synchronous = NORMAL");
  _db = db;
  return db;
}

// ---- SQL 方言归一化（MySQL → SQLite）----------------------------------------
// 只覆盖本项目实际用到的语法；新写 SQL 请直接用 SQLite 写法，不要依赖这里。

// mysql2 的 `IN (?)` 传数组 → SQLite 不支持数组绑定，展开成 `IN (?,?,?)`
function expandArrayParams(sql, params) {
  const out = [];
  let i = 0;
  // 逐个参数位替换：遇到数组参数就把对应的那一个 `?` 展开
  const parts = sql.split("?");
  if (parts.length === 1) return { sql, params: [] };
  let rebuilt = parts[0];
  for (let k = 1; k < parts.length; k++) {
    const p = params[i++];
    if (Array.isArray(p)) {
      if (!p.length) {
        // 空数组：`IN ()` 在 SQLite 是语法错误，改成恒假条件保持语义
        rebuilt += "NULL";
      } else {
        rebuilt += p.map(() => "?").join(",");
        out.push(...p);
      }
    } else {
      rebuilt += "?";
      out.push(p);
    }
    rebuilt += parts[k];
  }
  return { sql: rebuilt, params: out };
}

// 本项目用到的 MySQL 专有语法 → SQLite 等价写法
function translate(sql) {
  let s = sql;
  s = s.replace(/\bINSERT\s+IGNORE\b/gi, "INSERT OR IGNORE");
  s = s.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP");

  // `ON DUPLICATE KEY UPDATE col = VALUES(col)` → `ON CONFLICT DO UPDATE SET col = excluded.col`
  // 注意两点：
  //   1. SQLite 的 DO UPDATE 后面**必须**跟 SET（MySQL 的 ON DUPLICATE KEY UPDATE 没有）。
  //   2. 必须只在 ON DUPLICATE 子句之后替换 VALUES(col)，
  //      否则会把 INSERT 的 `VALUES (?, ?, ?)` 也误伤（那里括号内是占位符列表，不是单列名）。
  const m = s.match(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i);
  if (m) {
    const head = s.slice(0, m.index);
    let tail = s.slice(m.index + m[0].length);
    // 该项目的 upsert 都带显式主键 id / (k)，用 `ON CONFLICT DO UPDATE` 即可命中主键约束
    tail = tail.replace(/\bVALUES\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, "excluded.$1");
    s = `${head}ON CONFLICT DO UPDATE SET${tail}`;
  }
  return s;
}

// 把 mysql2 风格结果（大整数可能是 BigInt/字符串）转成本项目期望的 JS 值
function normalizeRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    const v = row[k];
    // node:sqlite 对 INTEGER 可能返回 BigInt（超过 2^53 或配置如此），统一转 Number
    if (typeof v === "bigint") row[k] = Number(v);
  }
  return row;
}

// 极简连接包装：保留 mysql2 的 `getConnection()` → `conn.query/beginTransaction/commit/rollback/release`
// 形状，让 store.js / migrate.js 的事务代码基本不动。
// node:sqlite 是同步 API，这里用 async 只是为了签名兼容。
class SqliteConnection {
  constructor(db) {
    this._db = db;
    this._released = false;
  }

  async query(sql, params = []) {
    return runQuery(this._db, sql, params);
  }

  async beginTransaction() {
    this._db.exec("BEGIN");
  }

  async commit() {
    this._db.exec("COMMIT");
  }

  async rollback() {
    // 没有活动事务时 ROLLBACK 会抛错，静默处理（与 mysql2 的 .catch(() => {}) 调用方习惯一致）
    try { this._db.exec("ROLLBACK"); } catch { /* 无活动事务 */ }
  }

  release() {
    // SQLite 无连接池概念，release 是空操作；保留以兼容调用方
    this._released = true;
  }
}

function runQuery(db, sql, params = []) {
  const normalized = translate(sql);
  const expanded = expandArrayParams(normalized, params);
  const finalSql = expanded.sql;
  const finalParams = expanded.params;

  // SELECT / PRAGMA / WITH → 返回行数组
  if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(finalSql)) {
    const stmt = db.prepare(finalSql);
    const rows = stmt.all(...finalParams).map(normalizeRow);
    return [rows];
  }
  // INSERT / UPDATE / DELETE / CREATE / 事务控制 → 返回结果摘要（对齐 mysql2 的 [result]）
  const stmt = db.prepare(finalSql);
  const info = stmt.run(...finalParams);
  return [{
    changes: Number(info.changes ?? 0),
    lastInsertRowid: Number(info.lastInsertRowid ?? 0),
  }];
}

// 兼容 mysql2 pool 的公开接口：query / getConnection / end
class SqlitePool {
  constructor(db) {
    this._db = db;
  }

  async query(sql, params = []) {
    return runQuery(this._db, sql, params);
  }

  async getConnection() {
    return new SqliteConnection(this._db);
  }

  async end() {
    // 由调用方（migrate 脚本）显式关闭；进程退出时也会自动释放
    if (_db) { _db.close(); _db = null; }
  }
}

export function getPool() {
  if ((process.env.DB_DRIVER || "sqlite").toLowerCase() === "mysql") return new MysqlPool();
  return new SqlitePool(getDb());
}

class MysqlPool {
  constructor() {
    this._pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 });
  }
  query(sql, params = []) { return this._pool.query(sql.replace(/INSERT OR IGNORE/gi, "INSERT IGNORE"), params); }
  getConnection() { return this._pool.getConnection(); }
  end() { return this._pool.end(); }
}

// 建表（幂等）。JSON 文档列保持与 v1 数据形状 1:1，回归风险最低；
// history_points 落成关系行，供经营分析与备份使用。
export async function ensureSchema(pool) {
  if (pool instanceof MysqlPool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS stations (id VARCHAR(191) PRIMARY KEY, pos INT NOT NULL DEFAULT 0, doc JSON NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS meta (k VARCHAR(191) PRIMARY KEY, v JSON NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS history_points (station_id VARCHAR(191) NOT NULL, t BIGINT NOT NULL, remaining DOUBLE NOT NULL, used DOUBLE NOT NULL DEFAULT 0, PRIMARY KEY (station_id,t), INDEX idx_history_t (t))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_points (station_id VARCHAR(191) NOT NULL, date CHAR(10) NOT NULL, cost_usd DOUBLE NOT NULL DEFAULT 0, tokens DOUBLE NOT NULL DEFAULT 0, requests DOUBLE NOT NULL DEFAULT 0, source VARCHAR(64) NOT NULL DEFAULT '', updated_at VARCHAR(32) NOT NULL DEFAULT '', PRIMARY KEY (station_id,date))`);
    return;
  }
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    pos INTEGER NOT NULL DEFAULT 0,
    doc TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // 复合主键 (station_id, t) 天然提供「同站同秒不重复」的幂等性，
  // 等价于 MySQL 版的主键 + INSERT IGNORE 组合
  db.exec(`CREATE TABLE IF NOT EXISTS history_points (
    station_id TEXT NOT NULL,
    t INTEGER NOT NULL,
    remaining REAL NOT NULL,
    used REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, t)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_history_t ON history_points (t)`);
  // 每日用量（花费/tokens/请求）：把上游「按日花费」落库，摆脱上游保留期限制
  //（实测 new-api 约 20 天、Sub2API 约 23~30 天）。每站每天 1 行，幂等 upsert。
  db.exec(`CREATE TABLE IF NOT EXISTS usage_points (
    station_id TEXT NOT NULL,
    date TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    tokens REAL NOT NULL DEFAULT 0,
    requests REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (station_id, date)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_points (date)`);
}

/**
 * 一致性备份：WAL 模式下直接复制 .db 文件可能拿到不完整状态，
 * 必须用 SQLite 官方的 online backup API 生成一致快照。
 * 供「立即备份 / 迁移到另一台机器」使用。
 */
export async function backupTo(destPath) {
  const db = getDb();
  const dir = dirname(isAbsolute(destPath) ? destPath : join(process.cwd(), destPath));
  mkdirSync(dir, { recursive: true });
  await backup(db, destPath);
  return destPath;
}

// 测试用：清空单例，让下次 getDb() 重新打开（便于用 :memory: 或临时文件）
export function _resetForTest() {
  if (_db) { try { _db.close(); } catch { /* 已关闭 */ } }
  _db = null;
}
