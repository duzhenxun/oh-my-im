import test from "node:test";
import assert from "node:assert/strict";
import { DingTalkAiCardClient } from "../dist/dingtalk/dingtalk-ai-card.js";
import { normalizeAgentModel } from "../dist/dws-dashboard.js";

function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("stream retries 5xx with the same guid and eventually succeeds", async () => {
  let streamAttempts = 0;
  const guids = [];
  const restore = installFetch(async (url, init) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    streamAttempts += 1;
    guids.push(JSON.parse(init.body).guid);
    if (streamAttempts < 3) return jsonResponse(500, { code: "unknownError", message: "未知错误" });
    return jsonResponse(200, { success: true });
  });
  try {
    const client = new DingTalkAiCardClient();
    client.setCredentials("k", "s", "robot");
    await client.stream({ outTrackId: "ot", contentKey: "content", content: "hello" });
    assert.equal(streamAttempts, 3);
    assert.equal(new Set(guids).size, 1, "retries must reuse one guid so the server stays idempotent");
  } finally {
    restore();
  }
});

test("stream does not retry 4xx business errors", async () => {
  let attempts = 0;
  const restore = installFetch(async (url) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    attempts += 1;
    return jsonResponse(400, { code: "invalidParam" });
  });
  try {
    const client = new DingTalkAiCardClient();
    client.setCredentials("k", "s", "robot");
    await assert.rejects(() => client.stream({ outTrackId: "ot", contentKey: "content", content: "x" }), /400/);
    assert.equal(attempts, 1);
  } finally {
    restore();
  }
});

test("normalizeAgentModel keeps provider/model shapes without an allow-list", () => {
  assert.equal(normalizeAgentModel("pi", "nexita gpt-5.6-luna"), "nexita/gpt-5.6-luna");
  assert.equal(normalizeAgentModel("pi", "nexita-anthropic/deepseek-v4.1-flash"), "nexita-anthropic/deepseek-v4.1-flash");
  assert.equal(normalizeAgentModel("opencode", "gitlab/duo-chat-gpt-5-1"), "gitlab/duo-chat-gpt-5-1");
  assert.equal(normalizeAgentModel("opencode", "opencode ling-3.0-flash-fin-free"), "opencode/ling-3.0-flash-fin-free");
  assert.equal(normalizeAgentModel("codex", "deepseek-v4.1-flash"), "deepseek-v4.1-flash");
  assert.equal(normalizeAgentModel("pi", "nvidia/nemotron"), "nvidia/nemotron");
});
