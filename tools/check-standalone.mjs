#!/usr/bin/env node
// 构建产物守卫：确保 .next/standalone 里**不含运行时凭证数据**。
//
// 背景（2026-09-17 实测，Next.js 16.2.10）：
//   next.config.mjs 里的 outputFileTracingExcludes 在本项目**拦不住** SQLite 库，两种构建路径都漏：
//     - Turbopack（默认）：无法静态解析 path.join(process.cwd(), ...)，保守地把**整个项目目录**拷进
//       standalone —— data/、spec/、deploy/、*.md 全在内（实测从零构建复现）；
//     - webpack（`next build --webpack`）：精确追踪，结构干净，但仍会把 db/pool.js::resolveDbPath()
//       里字面量拼出的 data/fine-apihub.db 一并带入。
//   而 data/ 存的是站点凭证（accessToken / JWT / 明文密码）、面板密码哈希与会话密钥——
//   这个目录一旦被打进镜像或分发出去就是凭证泄露。
//
// 因此这里做**构建后兜底**：默认「发现即删除 + 大声告警」，让 build 仍可正常使用；
// `--strict` 改为删掉后以非零码退出（用于 CI / 发布前门禁）。Dockerfile 中另有硬断言。
//
// 注意：只处理 .next/standalone 内的**副本**，绝不触碰项目根的 data/（那才是真身）。
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const STANDALONE = join(process.cwd(), ".next", "standalone");
const strict = process.argv.includes("--strict");

const DB_RE = /\.db(?:-wal|-shm)?$/i;
const ENV_RE = /^\.env(?:\.|$)/;
const KEEP_DIRS = new Set([".next", "node_modules"]);

if (!existsSync(STANDALONE)) {
  // 非 standalone 构建（例如只是 next dev / 关掉了 output: standalone）：无事可做
  console.log("[standalone-guard] 未发现 .next/standalone，跳过");
  process.exit(0);
}

const leaks = [];   // 需要删除的敏感路径（相对 standalone）
const cruft = [];   // 顺带发现的非敏感冗余目录（仅提示）

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(STANDALONE, abs).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      // 顶层 node_modules / .next 是产物本体，不下探
      if (rel.split("/").length === 1 && KEEP_DIRS.has(entry.name)) continue;
      if (rel === "data") { leaks.push(rel); continue; }
      if (!rel.includes("/") && !["node_modules", ".next"].includes(entry.name)) cruft.push(rel + "/");
      walk(abs);
      continue;
    }

    if (DB_RE.test(entry.name) || ENV_RE.test(entry.name)) {
      leaks.push(rel);
      continue;
    }
  }
}

try {
  walk(STANDALONE);
} catch (err) {
  console.error(`[standalone-guard] 扫描失败：${err?.message}`);
  process.exit(1);
}

if (!leaks.length) {
  console.log("[standalone-guard] ✅ .next/standalone 未发现数据库 / .env 泄漏");
  process.exit(0);
}

console.log("");
console.log("  ⚠️  【安全】构建产物中发现了运行时数据，即将删除：");
for (const rel of leaks) console.log(`      - .next/standalone/${rel}`);
console.log("  原因：Next 的文件追踪把 data/ 下的凭证库（站点 accessToken / JWT / 明文密码、");
console.log("        面板密码哈希、会话密钥）拷进了 standalone。它**不是**必需文件——");
console.log("        运行时数据库由 DB_PATH 指定（默认 <cwd>/data/fine-apihub.db），运行时才会创建。");
console.log("  请勿把 .next/standalone 直接打包分发或建成镜像（Dockerfile 已自带硬断言兜底）。");

for (const rel of leaks) {
  try { rmSync(join(STANDALONE, rel), { recursive: true, force: true }); }
  catch (err) { console.error(`  ✗ 删除 .next/standalone/${rel} 失败：${err?.message}`); process.exit(1); }
}
console.log(`  ✅ 已从构建产物中删除 ${leaks.length} 项敏感数据`);
console.log("");

if (cruft.length) {
  console.log(`  ℹ️  另：standalone 里还带了非必需目录（不敏感，仅体积）：${cruft.sort().join(", ")}`);
  console.log("");
}

if (strict) process.exit(1);
