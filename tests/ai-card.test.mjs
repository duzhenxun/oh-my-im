import test from "node:test";
import assert from "node:assert/strict";
import { AiCardSession } from "../dist/dingtalk/ai-card.js";

const log = { debug() {}, info() {}, warn() {}, error() {} };

function fakeClient() {
  const calls = [];
  return {
    calls,
    async createForGroup(p) { calls.push(["createForGroup", p]); },
    async createForSingle(p) { calls.push(["createForSingle", p]); },
    async typeOutRemaining(p) { calls.push(["typeOutRemaining", p]); },
    async stream(p) { calls.push(["stream", p]); },
    async setEndText(p) { calls.push(["setEndText", p]); },
    async updateCardData(p) { calls.push(["updateCardData", p]); },
    async updateTitle(p) { calls.push(["updateTitle", p]); },
  };
}

test("openForSingle reuses the configured outTrackId and passes the title", async () => {
  const client = fakeClient();
  const session = new AiCardSession({ client, templateId: "tpl", contentKey: "content", log, outTrackId: "ot-1" });
  await session.openForSingle({ userId: "u1", title: "【Pi】deepseek 进行中..." });
  const [name, params] = client.calls[0];
  assert.equal(name, "createForSingle");
  assert.equal(params.outTrackId, "ot-1");
  assert.equal(params.title, "【Pi】deepseek 进行中...");
});

test("finish writes end_text before the finalize frame and updates the title last", async () => {
  const client = fakeClient();
  const session = new AiCardSession({ client, templateId: "tpl", contentKey: "content", log, outTrackId: "ot-2" });
  const delivered = await session.finish({ content: "hello", title: "【Pi】完成 总耗时 5s", endText: "deepseek 1条消息,1次工具" });
  assert.equal(delivered, true);
  const names = client.calls.map((call) => call[0]);
  assert.ok(names.indexOf("setEndText") < names.lastIndexOf("stream"), "end_text must be written before finalize");
  assert.equal(names.at(-1), "updateTitle");
  const finalFrame = client.calls.filter((call) => call[0] === "stream").at(-1)[1];
  assert.equal(finalFrame.isFinalize, true);
});

test("finish skips end_text on error frames", async () => {
  const client = fakeClient();
  const session = new AiCardSession({ client, templateId: "tpl", contentKey: "content", log, outTrackId: "ot-3" });
  await session.finish({ content: "paused", title: "【Pi】处理暂停", endText: "ignored", error: true });
  assert.ok(!client.calls.some((call) => call[0] === "setEndText"));
  const frame = client.calls.find((call) => call[0] === "stream")[1];
  assert.equal(frame.isError, true);
  assert.equal(frame.isFinalize, false);
});

test("finish falls back to the instance API when the streaming finalize fails", async () => {
  const client = fakeClient();
  client.stream = async () => { throw new Error("DingTalk AI card API failed: 500"); };
  const session = new AiCardSession({ client, templateId: "tpl", contentKey: "content", log, outTrackId: "ot-4" });
  const delivered = await session.finish({ content: "fallback body", title: "【Pi】完成", endText: "note" });
  assert.equal(delivered, true);
  const fallback = client.calls.find((call) => call[0] === "updateCardData")[1];
  assert.equal(fallback.data.content, "fallback body");
});

test("finish reports failure when both streaming and the instance fallback fail", async () => {
  const client = fakeClient();
  client.stream = async () => { throw new Error("500"); };
  client.updateCardData = async () => { throw new Error("500"); };
  const session = new AiCardSession({ client, templateId: "tpl", contentKey: "content", log, outTrackId: "ot-5" });
  const delivered = await session.finish({ content: "x", title: "t" });
  assert.equal(delivered, false);
  // The title is still updated so the card does not stay in "处理中".
  assert.ok(client.calls.some((call) => call[0] === "updateTitle"));
});
