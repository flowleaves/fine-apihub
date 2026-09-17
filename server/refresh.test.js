// 刷新调度的纯逻辑测试：分档筛选 + 自有站节流（不打任何网络）
import assert from "node:assert/strict";
import test from "node:test";
import { stationsForScope, ensureOwnFresh } from "./refresh.js";

const st = (id, isOwn) => ({ id, isOwn, type: "newapi", baseUrl: "https://x", accessToken: "t" });
const LIST = [st("own1", true), st("other1", false), st("other2", false), st("own2", true)];

test("stationsForScope 按归属分档：others / own / all", () => {
  assert.deepEqual(stationsForScope(LIST, "others").map((s) => s.id), ["other1", "other2"]);
  assert.deepEqual(stationsForScope(LIST, "own").map((s) => s.id), ["own1", "own2"]);
  assert.equal(stationsForScope(LIST, "all").length, 4);
  assert.equal(stationsForScope(LIST).length, 4); // 默认 all
  assert.deepEqual(stationsForScope([], "own"), []);
});

// 造一个不含 isOwn 站的 rt：refreshAll(scope:"own") 为空 → 不产生任何网络请求
function fakeRt(settings = {}) {
  return {
    store: { list: () => [st("other1", false)], settings: { ownRefreshIntervalSec: 3600, ...settings } },
  };
}

test("ensureOwnFresh：第一次触发刷新，随后在节流窗口内不再刷新", async () => {
  const rt = fakeRt();
  const t0 = Date.now();

  const first = await ensureOwnFresh(rt, { now: t0 });
  assert.equal(first.refreshed, true);
  assert.equal(rt._ownRefreshedAt, t0);

  // 立刻再调（模拟页面 30s 轮询）→ 被挡掉，且给出还要等多久
  const second = await ensureOwnFresh(rt, { now: t0 + 30_000 });
  assert.equal(second.refreshed, false);
  assert.equal(second.nextInSec, 3600 - 30);

  // 刚好到期 → 放行
  const third = await ensureOwnFresh(rt, { now: t0 + 3600_000 });
  assert.equal(third.refreshed, true);

  // force（手动刷新）无视节流
  const forced = await ensureOwnFresh(rt, { force: true, now: t0 + 3600_000 + 1000 });
  assert.equal(forced.refreshed, true);
});

test("ensureOwnFresh：ownRefreshIntervalSec=0 表示不节流（每次页面请求都刷）", async () => {
  const rt = fakeRt({ ownRefreshIntervalSec: 0 });
  const a = await ensureOwnFresh(rt, { now: 1000 });
  const b = await ensureOwnFresh(rt, { now: 1001 }); // 1ms 后也应放行
  assert.equal(a.refreshed, true);
  assert.equal(b.refreshed, true);
});

test("ensureOwnFresh：非法/缺失配置回退 1 小时，不会变成「永不刷新」", async () => {
  const rt = fakeRt({ ownRefreshIntervalSec: "abc" });
  const t0 = Date.now();
  // 冷启动：_ownRefreshedAt 为 0（进程内尚无记录）→ 首次必须放行
  const a = await ensureOwnFresh(rt, { now: t0 });
  assert.equal(a.refreshed, true);
  const b = await ensureOwnFresh(rt, { now: t0 + 60_000 });
  assert.equal(b.refreshed, false);
  assert.ok(b.nextInSec > 3000); // 仍是 3600s 档
});

test("ensureOwnFresh：冷启动（无历史记录）首次必刷新，不会因 now-0 被误判", async () => {
  const rt = fakeRt(); // _ownRefreshedAt 未定义
  const r = await ensureOwnFresh(rt, { now: Date.now() });
  assert.equal(r.refreshed, true);
  assert.equal(r.lastAt, null); // 之前确实没有记录
});
