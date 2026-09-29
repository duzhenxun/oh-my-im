import test from "node:test";
import assert from "node:assert/strict";
import { DingTalkAiCardClient } from "../dist/dingtalk/dingtalk-ai-card.js";
import { DingTalkRobotEmotionClient, THINKING_EMOTION } from "../dist/dingtalk/robot-emotion.js";
import { sendRobotSingleText } from "../dist/dingtalk/dingtalk-robot.js";
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

test("typeOutRemaining always pushes the full content as the final frame", async () => {
  const contents = [];
  const restore = installFetch(async (url, init) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    contents.push(JSON.parse(init.body).content);
    return jsonResponse(200, { success: true });
  });
  try {
    const client = new DingTalkAiCardClient();
    client.setCredentials("k", "s", "robot");
    const content = "[OMG] 正在调用工具（已 1 次）…\n\n\n工具：read x1";
    await client.typeOutRemaining({ outTrackId: "ot", contentKey: "content", content, maxDurationMs: 0 });
    assert.equal(contents.at(-1), content, "last streamed frame must be the complete content");
  } finally {
    restore();
  }
});

test("typeOutRemaining re-pushes content whose length is unchanged but tail differs", async () => {
  const contents = [];
  const restore = installFetch(async (url, init) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    contents.push(JSON.parse(init.body).content);
    return jsonResponse(200, { success: true });
  });
  try {
    const client = new DingTalkAiCardClient();
    client.setCredentials("k", "s", "robot");
    const first = "[OMG] 正在调用工具（已 1 次）…";
    const second = "[OMG] 正在调用工具（已 2 次）…";
    assert.equal(first.length, second.length);
    await client.stream({ outTrackId: "ot", contentKey: "content", content: first });
    await client.typeOutRemaining({ outTrackId: "ot", contentKey: "content", content: second, maxDurationMs: 0 });
    assert.equal(contents.at(-1), second, "same-length but different content must still be pushed");
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

test("robot emotion add posts the built-in emoji fields to the reply API", async () => {
  const requests = [];
  const restore = installFetch(async (url, init) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse(200, { success: true });
  });
  try {
    const client = new DingTalkRobotEmotionClient();
    client.setCredentials("appkey", "secret", "robotcode");
    await client.add({ openConversationId: "cid/abc==", openMsgId: "msg/xyz==" }, THINKING_EMOTION);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.dingtalk.com/v1.0/robot/emotion/reply");
    assert.deepEqual(requests[0].body, {
      robotCode: "robotcode",
      openConversationId: "cid/abc==",
      openMsgId: "msg/xyz==",
      emotionType: "1",
      emotionId: "emotion_040",
      emotionName: "思考",
    });
  } finally {
    restore();
  }
});


test("robot emotion surfaces business errors", async () => {
  const restore = installFetch(async (url) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    return jsonResponse(500, { code: "unknownError", message: "未知错误" });
  });
  try {
    const client = new DingTalkRobotEmotionClient();
    client.setCredentials("appkey", "secret", "robotcode");
    await assert.rejects(() => client.add({ openConversationId: "cid", openMsgId: "msg" }, THINKING_EMOTION), /robot emotion API failed/);
  } finally {
    restore();
  }
});

test("sendRobotSingleText posts to the single-chat batchSend API", async () => {
  const requests = [];
  const restore = installFetch(async (url, init) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse(200, { processQueryKey: "pq" });
  });
  try {
    await sendRobotSingleText("user-1", "hello", "robot-code", "client-id", "client-secret");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
    assert.deepEqual(requests[0].body, {
      robotCode: "robot-code",
      userIds: ["user-1"],
      msgKey: "sampleText",
      msgParam: JSON.stringify({ content: "hello" }),
    });
  } finally {
    restore();
  }
});

test("sendRobotSingleText rejects when the userId is not delivered", async () => {
  const restore = installFetch(async (url) => {
    if (String(url).includes("/oauth2/accessToken")) return jsonResponse(200, { accessToken: "tok", expireIn: 7200 });
    return jsonResponse(200, { processQueryKey: "pq", invalidStaffIdList: ["user-1"] });
  });
  try {
    await assert.rejects(() => sendRobotSingleText("user-1", "hello", "robot-code", "client-id", "client-secret"), /未送达/);
  } finally {
    restore();
  }
});
