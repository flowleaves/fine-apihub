// Store 的持久化测试：改用真实的 SQLite 内存库（:memory:）。
//
// 改造前这里用 fakePool 假装数据库，断言「SQL 以某字符串开头」——那种写法
// 既测不出方言错误，也在换驱动时全部失效。现在直接用真库：
//   · 方言转写（ON DUPLICATE / INSERT OR IGNORE / IN 占位符展开）真的被执行
//   · 写透 → 重新 load 的往返（round-trip）真的被验证
import test from "node:test";
import assert from "node:assert/strict";
import { getPool, ensureSchema, _resetForTest } from "./pool.js";
import { Store } from "./store.js";

// 每个用例开一个全新的内存库，避免用例间互相污染
async function freshStore() {
  _resetForTest();
  process.env.DB_PATH = ":memory:";
  const pool = getPool();
  await ensureSchema(pool);
  const store = await new Store(pool).load();
  return { pool, store };
}

test("首次启动创建默认面板账号", async () => {
  const { store } = await freshStore();
  assert.equal(store.auth.username, "admin");
  assert.equal(store.auth.isDefault, true);
});

test("旧站点数据升级时默认保持续费", async () => {
  const { pool, store } = await freshStore();
  // 直接往库里塞一条不含 noRenewal 的旧站点文档，再重新 load 触发迁移逻辑
  await pool.query("INSERT INTO stations (id, pos, doc) VALUES (?, ?, ?)",
    ["old", 0, JSON.stringify({ id: "old", name: "旧站点" })]);
  const reloaded = await new Store(pool).load();
  assert.equal(reloaded.get("old").noRenewal, false);
});

test("重新标记不再续费会重置单次提醒资格", async () => {
  const { store } = await freshStore();
  store.data.stations = [{
    id: "station-1",
    noRenewal: true,
    alertState: { state: "warn", notifiedAt: 10, noRenewalLowNotifiedAt: 20 },
  }];

  await store.update("station-1", { noRenewal: false });
  assert.equal(store.get("station-1").alertState.noRenewalLowNotifiedAt, undefined);
  await store.update("station-1", { noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, true);

  await store.update("station-1", { type: "fixed", noRenewal: true });
  assert.equal(store.get("station-1").noRenewal, false);
});

test("成本渠道匹配别名会清理空值并去重", async () => {
  const { store } = await freshStore();
  const added = await store.add({
    name: "上游",
    type: "newapi",
    baseUrl: "https://public.example.com",
    costAliases: [" internal-host ", "", "internal-host", "10.0.0.8:8080"],
  });
  assert.deepEqual(added.costAliases, ["internal-host", "10.0.0.8:8080"]);

  await store.update(added.id, { costAliases: "alias-a, alias-b\nalias-a" });
  assert.deepEqual(store.get(added.id).costAliases, ["alias-a", "alias-b"]);
});

test("监控上游默认计入利润成本并可显式排除", async () => {
  const { store } = await freshStore();
  const included = await store.add({ name: "负载均衡后的上游", type: "newapi", baseUrl: "https://a.example.com" });
  const excluded = await store.add({
    name: "重复汇总节点", type: "sub2api-password", baseUrl: "https://b.example.com", includeInProfit: false,
  });
  assert.equal(store.get(included.id).includeInProfit, true);
  assert.equal(store.get(excluded.id).includeInProfit, false);

  await store.update(excluded.id, { includeInProfit: true });
  assert.equal(store.get(excluded.id).includeInProfit, true);
});

test("渠道绑定：只接受存在的渠道 id，字段级合并", async () => {
  const { store } = await freshStore();
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  const r1 = await store.updateRules({ channelsFor: { low: ["ch-1", "bogus"], eta: ["ch-2"] } });
  assert.deepEqual(r1.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r1.channelsFor.eta, ["ch-2"]);
  assert.deepEqual(r1.channelsFor.exhaust, []);
  // 只更新载荷里出现的键，其余绑定保持
  const r2 = await store.updateRules({ channelsFor: { exhaust: ["ch-2"] } });
  assert.deepEqual(r2.channelsFor.low, ["ch-1"]);
  assert.deepEqual(r2.channelsFor.exhaust, ["ch-2"]);
});

test("删除渠道时清理告警绑定与日报渠道里的死 id", async () => {
  const { store } = await freshStore();
  store.data.notifications.channels = [
    { id: "ch-1", name: "A", type: "webhook", enabled: true },
    { id: "ch-2", name: "B", type: "webhook", enabled: true },
  ];
  await store.updateRules({ channelsFor: { low: ["ch-1", "ch-2"], error: ["ch-1"] } });
  store.data.settings.dailyReport = { enabled: true, time: "09:00", channelIds: ["ch-1", "ch-2"], lastSent: null };

  await store.removeChannel("ch-1");
  assert.deepEqual(store.rules.channelsFor.low, ["ch-2"]);
  assert.deepEqual(store.rules.channelsFor.error, []);
  assert.deepEqual(store.settings.dailyReport.channelIds, ["ch-2"]);
});

test("加载旧规则时补齐渠道绑定字段且不共享默认对象", async () => {
  const { pool } = await freshStore();
  const a = await new Store(pool).load();
  const b = await new Store(pool).load();
  assert.deepEqual(a.rules.channelsFor, { low: [], exhaust: [], error: [], recover: [], eta: [] });
  a.rules.channelsFor.low.push("x");
  assert.deepEqual(b.rules.channelsFor.low, []);
});

// ---- SQLite 迁移新增：写透与往返一致性 ---------------------------------------

test("站点增删改写透后重新 load 完全一致（round-trip）", async () => {
  const { pool, store } = await freshStore();
  const a = await store.add({ name: "上游A", type: "newapi", baseUrl: "https://a.example.com", cnyPerUsd: 7.2 });
  const b = await store.add({ name: "上游B", type: "sub2api-password", baseUrl: "https://b.example.com" });
  await store.update(a.id, { name: "上游A改名", lowBalanceUsd: 3 });
  await store.remove(b.id);

  const reloaded = await new Store(pool).load();
  assert.equal(reloaded.list().length, 1, "删除的站点不应复活");
  assert.equal(reloaded.get(a.id).name, "上游A改名");
  assert.equal(reloaded.get(a.id).lowBalanceUsd, 3);
  assert.equal(reloaded.get(a.id).cnyPerUsd, 7.2);
  assert.equal(reloaded.get(b.id), undefined);
});

test("stations 表的 pos 保持插入顺序（首页展示顺序依赖它）", async () => {
  const { pool, store } = await freshStore();
  const names = ["第一", "第二", "第三"];
  for (const n of names) {
    await store.add({ name: n, type: "newapi", baseUrl: `https://${n}.example.com` });
  }
  const reloaded = await new Store(pool).load();
  assert.deepEqual(reloaded.list().map((s) => s.name), names);
});

test("upsert 更新同一站点不产生重复行", async () => {
  const { pool, store } = await freshStore();
  const a = await store.add({ name: "站点", type: "newapi", baseUrl: "https://a.example.com" });
  // 连续多次 save()（每次刷新都会触发）不应堆积行
  for (let i = 0; i < 5; i++) {
    await store.update(a.id, { name: `站点${i}` });
  }
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM stations");
  assert.equal(rows[0].n, 1, "ON CONFLICT DO UPDATE 应命中主键，不新增行");
});

test("settings / auth / notifications 三个 meta 都正确持久化", async () => {
  const { pool, store } = await freshStore();
  await store.updateSettings({ refreshIntervalSec: 120, lowBalanceUsd: 8 });
  await store.setPassword("admin", "newpass123");
  const ch = await store.addChannel({ type: "telegram", name: "TG", config: { botToken: "t", chatId: "c" } });

  const reloaded = await new Store(pool).load();
  assert.equal(reloaded.settings.refreshIntervalSec, 120);
  assert.equal(reloaded.settings.lowBalanceUsd, 8);
  assert.equal(reloaded.auth.isDefault, false);
  assert.equal(reloaded.channels.length, 1);
  assert.equal(reloaded.channels[0].id, ch.id);
  assert.equal(reloaded.channels[0].config.botToken, "t");
});

test("空站点列表时清空 stations 表（不残留旧行）", async () => {
  const { pool, store } = await freshStore();
  await store.add({ name: "临时", type: "newapi", baseUrl: "https://t.example.com" });
  await store.remove(store.list()[0].id);
  const [rows] = await pool.query("SELECT id FROM stations");
  assert.equal(rows.length, 0, "全部删除后表应为空");
});
