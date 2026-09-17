import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { queryStation, querySub2ApiKeyUsage, queryDailyCost, chunkRange } from "./providers.js";

function seededHex(seed, length) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("Sub2API admin key usage aggregates key metadata and actual cost", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes("/admin/users?")) return new Response(JSON.stringify({ data: [{ id: 7, username: "alice" }] }), { status: 200 });
    if (u.includes("/admin/users/7/api-keys")) return new Response(JSON.stringify({ data: [{ id: 11, name: "prod" }] }), { status: 200 });
    if (u.includes("/admin/dashboard/api-keys-usage")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { api_key_ids: [11] });
      return new Response(JSON.stringify({ data: { stats: { "11": { total_requests: 3, total_input_tokens: 100, total_output_tokens: 20, total_cache_tokens: 5, total_actual_cost: 1.25, total_cost: 1.5, today_actual_cost: 0.5 } } } }), { status: 200 });
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const out = await querySub2ApiKeyUsage({ type: "sub2api", baseUrl: "https://sub2.example", accessToken: "jwt" }, { startMs: 0, endMs: 1000 });
  assert.deepEqual(out.items[0], { id: 11, name: "prod", userId: 7, username: "alice", requests: 3, inputTokens: 100, outputTokens: 20, cacheTokens: 5, totalTokens: 125, actualCost: 1.25, totalCost: 1.5, todayCost: 0.5 });
  assert.equal(out.summary.actualCost, 1.25);
});

test("Sub2API password login solves a Cap challenge and sends turnstile_token", async (t) => {
  const challengeToken = "local-challenge";
  const challengeSpec = { c: 2, s: 8, d: 1 };
  let origin;
  let loginBody;

  const server = createServer(async (request, response) => {
    if (request.url === "/api/v1/settings/public") {
      return sendJson(response, {
        code: 0,
        data: {
          turnstile_enabled: true,
          captcha_provider: "cap",
          cap_api_endpoint: `${origin}/cap`,
          cap_site_key: "local-site",
        },
      });
    }
    if (request.url === "/cap/local-site/challenge" && request.method === "POST") {
      return sendJson(response, { challenge: challengeSpec, token: challengeToken });
    }
    if (request.url === "/cap/local-site/redeem" && request.method === "POST") {
      const body = await readJson(request);
      assert.equal(body.token, challengeToken);
      assert.equal(body.solutions.length, challengeSpec.c);
      for (let i = 0; i < body.solutions.length; i++) {
        const n = i + 1;
        const salt = seededHex(`${challengeToken}${n}`, challengeSpec.s);
        const target = seededHex(`${challengeToken}${n}d`, challengeSpec.d);
        const hash = createHash("sha256").update(`${salt}${body.solutions[i]}`).digest("hex");
        assert.ok(hash.startsWith(target));
      }
      return sendJson(response, { success: true, token: "local-cap-token", expires: Date.now() + 60000 });
    }
    if (request.url === "/api/v1/auth/login" && request.method === "POST") {
      loginBody = await readJson(request);
      return sendJson(response, {
        code: 0,
        data: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: { email: "user@example.com" },
        },
      });
    }
    if (request.url === "/api/v1/auth/me") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      return sendJson(response, {
        code: 0,
        data: { email: "user@example.com", balance: 12.5, total_recharged: 20 },
      });
    }
    if (request.url === "/api/v1/usage/dashboard/stats") {
      return sendJson(response, {
        code: 0,
        data: { today_actual_cost: 1.25, today_requests: 3, today_tokens: 4000 },
      });
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  const station = {
    type: "sub2api-password",
    baseUrl: origin,
    email: "user@example.com",
    password: "secret123",
  };
  const { result, tokensChanged } = await queryStation(station);

  assert.equal(result.ok, true);
  assert.equal(result.remaining, 12.5);
  assert.equal(result.used, 7.5);
  assert.equal(result.todayUsed, 1.25);
  assert.equal(tokensChanged, true);
  assert.deepEqual(loginBody, {
    email: "user@example.com",
    password: "secret123",
    turnstile_token: "local-cap-token",
  });
  assert.equal(station.s2Tokens.refreshToken, "refresh-token");
});

test("流向数据把用户/分组/模型/渠道口径归一化", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/data/flow");
    assert.equal(request.headers.authorization, "adm");
    assert.equal(request.headers["new-api-user"], "6");
    assert.equal(url.searchParams.get("start_timestamp"), "1000");
    assert.equal(url.searchParams.get("end_timestamp"), "1059"); // 结束值包含式，减到窗内最后一秒
    sendJson(response, {
      success: true,
      data: [
        { username: "a", use_group: "grok", model_name: "grok-4.6", channel_id: 7, channel_name: "sol", token_used: 400, count: 596, quota: 76000000 },
        { username: "b", use_group: "", model_name: "gpt-4o", channel_id: 1, token_used: 100, count: 3, quota: 500000 },
      ],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnFlow } = await import("./providers.js");

  const rows = await queryOwnFlow({ baseUrl: origin, accessToken: "adm", userId: "6" }, 1000000, 1060000);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol",
    tokenName: "", tokens: 400, cost: 152, requests: 596,
  });
  assert.equal(rows[1].channelName, ""); // 没有 channel_name 时留空，由调用方兜底
});

test("日志精算把缓存读写算进真实 token，并按语义避免重复计数", async (t) => {
  // Claude 语义：prompt_tokens 只是未命中缓存的输入，缓存读写额外计费（看板漏计的就是这块）
  const claudeRow = (i) => ({
    id: i, created_at: 1700000000 + i, model_name: "claude-sonnet-4-5", username: "u1",
    prompt_tokens: 1000, completion_tokens: 2000, quota: 500000, channel: 3, channel_name: "Claude-Max", group: "claude",
    other: JSON.stringify({
      usage_semantic: "anthropic", claude: true, cache_tokens: 300000, cache_write_tokens: 20000,
      model_ratio: 5, group_ratio: 1, completion_ratio: 5,
    }),
  });
  // OpenAI 语义：缓存 token 本就含在 prompt_tokens 里，真实 token 不能再加一遍
  const gptRow = {
    id: 99, created_at: 1700000500, model_name: "gpt-4o", username: "u2",
    prompt_tokens: 250000, completion_tokens: 1000, quota: 1000000, channel: 1, channel_name: "luna", group: "default",
    other: JSON.stringify({ cache_tokens: 100000, model_ratio: 2.5, group_ratio: 1, completion_ratio: 4, matched_tier: ">200k" }),
  };
  const pages = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/log/");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("page_size"), "100");
    const p = Number(url.searchParams.get("p"));
    pages.push(p);
    const items = p === 1 ? Array.from({ length: 100 }, (_, i) => claudeRow(i + 1)) : p === 2 ? [gptRow] : [];
    sendJson(response, { success: true, data: { page: p, page_size: 100, total: 101, items } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit({ baseUrl: origin, accessToken: "adm" }, {
    startMs: 1700000000000, endMs: 1700001000000, maxRows: 4000,
  });
  assert.equal(r.scanned, 101);
  assert.equal(r.total, 101);
  assert.equal(r.truncated, false);
  assert.deepEqual(pages.slice(0, 2), [1, 2]);

  const claude = r.byModel.find((m) => m.model === "claude-sonnet-4-5");
  assert.equal(claude.billedTokens, 100 * 3000); // 看板口径
  assert.equal(claude.cacheReadTokens, 100 * 300000);
  assert.equal(claude.cacheWriteTokens, 100 * 20000);
  assert.equal(claude.trueTokens, 100 * (3000 + 300000 + 20000)); // 真实口径
  assert.equal(claude.anthropicPct, 100);
  assert.equal(claude.longRequests, 100); // 输入 321000 ≥ 20 万，属长上下文
  assert.deepEqual(claude.avgModelRatio, 5);

  const gpt = r.byModel.find((m) => m.model === "gpt-4o");
  assert.equal(gpt.billedTokens, 251000);
  assert.equal(gpt.trueTokens, 251000); // 缓存 token 已在 prompt 内，不再叠加
  assert.equal(gpt.cacheReadTokens, 100000);
  assert.equal(gpt.longRequests, 1);
  assert.deepEqual(gpt.tiers, [{ name: ">200k", requests: 1 }]);

  assert.equal(r.totals.requests, 101);
  assert.equal(r.byChannel.map((c) => c.channel).sort().join(","), "Claude-Max,luna");
  assert.equal(r.byGroup.length, 2);
});

test("日志精算按条数上限截断并如实报告覆盖范围", async (t) => {
  const server = createServer((request, response) => {
    const p = Number(new URL(request.url, "http://x").searchParams.get("p"));
    sendJson(response, {
      success: true,
      data: {
        total: 5000,
        items: Array.from({ length: 100 }, (_, i) => ({
          id: p * 1000 + i, created_at: 1700000000 - (p - 1) * 100 - i,
          model_name: "m", username: "u", prompt_tokens: 1, completion_tokens: 1, quota: 500, other: "",
        })),
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "adm" },
    { startMs: 1600000000000, endMs: 1700001000000, maxRows: 300 }
  );
  assert.equal(r.scanned, 300);
  assert.equal(r.truncated, true);
  assert.equal(r.toMs, 1700000000000);
  assert.equal(r.fromMs, (1700000000 - 2 * 100 - 99) * 1000); // 只覆盖最近 3 页
});

// ---------------------------------------------------------------------------
// 按日花费（月历）：new-api 小时行分桶 / Sub2API 日行 / 窗口切片
// ---------------------------------------------------------------------------

test("chunkRange 把超长窗口切成不超过 30 天的片（绕开 new-api 跨度上限）", () => {
  const day = 86400000;
  const start = Date.UTC(2026, 0, 1);
  const chunks = chunkRange(start, start + 40 * day, 30);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0][0], start);
  assert.equal(chunks[0][1], start + 30 * day);
  assert.equal(chunks[1][0], start + 30 * day);
  assert.equal(chunks[1][1], start + 40 * day);
  // 恰好等于上限时不切
  assert.equal(chunkRange(start, start + 30 * day, 30).length, 1);
  // 空窗口兜底为单片
  assert.equal(chunkRange(start, start, 30).length, 1);
});

test("new-api 按日花费：小时行按 tz 分桶成日，并给出今天的小时曲线", async (t) => {
  // 用「当前 UTC 日零点」构造确定性时间戳：今天 2 行、昨天 2 行、前天 1 行
  const nowD = new Date();
  const todayMid = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
  const H = 3600000;
  const row = (ms) => ({ created_at: Math.floor(ms / 1000), quota: 500000, token_used: 100, count: 2 });
  const rows = [
    row(todayMid + 5 * H), row(todayMid + 6 * H),        // 今天 → $2
    row(todayMid - 2 * H), row(todayMid - 3 * H),        // 昨天 → $2
    row(todayMid - 26 * H),                              // 前天 → $1
  ];
  let calls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/data/self");
    assert.equal(request.headers.authorization, "adm");
    assert.equal(request.headers["new-api-user"], "6");
    calls++;
    sendJson(response, { success: true, data: rows });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const r = await queryDailyCost(
    { type: "newapi", baseUrl: origin, accessToken: "adm", userId: "6" },
    { startMs: todayMid - 40 * H, endMs: Date.now(), tz: "UTC" }
  );
  assert.equal(r.available, true);
  assert.equal(calls, 1); // 窗口只有 40 小时，无需切片
  assert.equal(r.days.length, 3);
  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
  const todayLabel = new Date(todayMid).toISOString().slice(0, 10);
  const yestLabel = new Date(todayMid - 86400000).toISOString().slice(0, 10);
  const beforeLabel = new Date(todayMid - 2 * 86400000).toISOString().slice(0, 10);
  assert.equal(byDate[todayLabel].usd, 2);
  assert.equal(byDate[yestLabel].usd, 2);
  assert.equal(byDate[beforeLabel].usd, 1);
  assert.equal(byDate[todayLabel].tokens, 200);
  assert.equal(byDate[todayLabel].requests, 4);
  assert.equal(r.todayUsd, 2);
  assert.equal(r.hours.length, 2); // 只有今天的行进入小时曲线
  assert.equal(r.coverageFrom, beforeLabel);
  assert.match(r.source, /newapi/);
});

test("new-api 超长窗口会被切片，且上游原话（跨度超限）如实抛出", async (t) => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    const url = new URL(request.url, "http://x");
    const start = Number(url.searchParams.get("start_timestamp"));
    const end = Number(url.searchParams.get("end_timestamp"));
    // 复刻实测行为：跨度 > 1 个月时 success:false
    if (end - start > 30 * 86400) {
      return sendJson(response, { success: false, message: "时间跨度不能超过 1 个月" });
    }
    sendJson(response, { success: true, data: [] });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const station = { type: "newapi", baseUrl: origin, accessToken: "adm" };

  // 40 天窗口 → 必须切成 2 片，两片都不触发上游限制
  const r = await queryDailyCost(station, { startMs: Date.now() - 40 * 86400000, endMs: Date.now(), tz: "UTC" });
  assert.equal(calls, 2);
  assert.equal(r.available, true);

  // 若上游报错，错误信息要透出原话，而不是一律归因于「未开启数据看板」
  const bad = createServer((request, response) => {
    sendJson(response, { success: false, message: "时间跨度不能超过 1 个月" });
  });
  await new Promise((resolve) => bad.listen(0, "127.0.0.1", resolve));
  t.after(() => bad.close());
  await assert.rejects(
    () => queryDailyCost({ type: "newapi", baseUrl: `http://127.0.0.1:${bad.address().port}`, accessToken: "adm" },
      { startMs: Date.now() - 86400000, endMs: Date.now(), tz: "UTC" }),
    /时间跨度不能超过 1 个月/
  );
});

test("Sub2API 按日花费：取 snapshot-v2 日行（actual_cost），并单独取今天的小时曲线", async (t) => {
  const todayLabel = new Date().toISOString().slice(0, 10);
  const yestLabel = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/v1/usage/dashboard/snapshot-v2");
    assert.equal(request.headers.authorization, "Bearer jwt");
    const g = url.searchParams.get("granularity");
    seen.push({ g, start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date"), tz: url.searchParams.get("timezone") });
    if (g === "day") {
      return sendJson(response, {
        code: 0,
        data: {
          trend: [
            { date: yestLabel, actual_cost: 2.5, cost: 9.9, total_tokens: 100, requests: 3 },
            { date: todayLabel, actual_cost: 1.5, cost: 9.9, total_tokens: 50, requests: 2 },
          ],
        },
      });
    }
    return sendJson(response, {
      code: 0,
      data: { trend: [{ date: `${todayLabel} 00:00`, actual_cost: 0.5 }, { date: `${todayLabel} 01:00`, actual_cost: 0.4 }] },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const r = await queryDailyCost(
    { type: "sub2api", baseUrl: origin, accessToken: "jwt" },
    { startMs: Date.now() - 86400000, endMs: Date.now(), tz: "UTC" }
  );
  assert.equal(r.available, true);
  assert.equal(r.days.length, 2);
  // 用 actual_cost（与站点面板一致），不是 cost
  assert.equal(r.days.find((d) => d.date === todayLabel).usd, 1.5);
  assert.equal(r.days.find((d) => d.date === yestLabel).usd, 2.5);
  assert.equal(r.todayUsd, 1.5);
  assert.equal(r.hours.length, 2);
  assert.equal(r.hours[1].usd, 0.4);
  const dayCall = seen.find((s) => s.g === "day");
  assert.equal(dayCall.tz, "UTC");
  assert.equal(dayCall.start, r.days[0].date);
});

test("不支持的站点类型如实标注 available:false，不伪造 0 花费", async () => {
  const sk = await queryDailyCost({ type: "newapi-key", baseUrl: "https://x", apiKey: "sk-x" }, { startMs: 0, endMs: 1, tz: "UTC" });
  assert.equal(sk.available, false);
  assert.deepEqual(sk.days, []);
  assert.match(sk.reason, /sk 密钥模式/);

  const fixed = await queryDailyCost({ type: "fixed" }, { startMs: 0, endMs: 1, tz: "UTC" });
  assert.equal(fixed.available, false);
  assert.match(fixed.reason, /固定成本/);
});
