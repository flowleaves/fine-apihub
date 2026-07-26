import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { queryStation } from "./providers.js";

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
