import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPi } from "../dist/agents/pi-agent.js";

test("Pi RPC runner streams text, tools, and captures its session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-my-im-pi-"));
  const fakePi = join(dir, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId: "pi-session" } }));
  }
  if (command.type === "prompt") {
    console.log(JSON.stringify({ type: "response", command: "prompt", success: true }));
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } }));
    console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好，完成" }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
`);
  await chmod(fakePi, 0o755);

  const updates = [];
  const result = await runPi("测试", undefined, {
    dingtalkClientId: "",
    dingtalkClientSecret: "",
    codexCliPath: "codex",
    codexWorkDir: dir,
    piCliPath: fakePi,
    agent: "pi",
    allowedUserIds: [],
    cliTimeoutMs: 5_000,
  }, {
    onText: (text) => updates.push(text),
  });

  assert.equal(result.sessionId, "pi-session");
  assert.equal(result.text, "你好，完成");
  assert.deepEqual(result.toolStats, { read: 1 });
  assert.deepEqual(updates, ["你好"]);
  await rm(dir, { recursive: true, force: true });
});
