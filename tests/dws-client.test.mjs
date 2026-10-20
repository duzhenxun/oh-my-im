import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COLLECTION_ERROR = "下游缺少明确的集合字段，无法判定结果为空";
const COLLECTION = JSON.stringify({
  count: 3,
  messages: [
    { createTime: "2020-01-01 10:00:00", messageId: "m-old", sender: "测试甲", text: "old" },
    { createTime: "2020-01-01 10:45:00", messageId: "m-inside", sender: "测试甲", text: "inside" },
    { createTime: "2020-01-01 11:30:00", messageId: "m-after", sender: "测试甲", text: "after" },
  ],
});

const PARTIAL_MESSAGES = [
  { createTime: "2020-01-01 10:45:00", messageId: "m-inside", sender: "测试甲", text: "inside" },
  { createTime: "2020-01-01 10:50:00", messageId: "m-inside-2", sender: "测试甲", text: "inside-2" },
];

// Mirrors a real `reason: search_messages_incomplete` envelope from dws.
const PARTIAL_ABORT = JSON.stringify({
  error: {
    category: "api",
    cause: "business error: success=false",
    code: 1,
    hint: "请保留 details.partialResult 中已取得的消息，并按 failures 与 nextActions 只重试失败阶段",
    message: "消息搜索未完成：保留 2 条命中和 1 个失败项",
    operation: "im/search_messages",
    origin: "mcp_gateway",
    reason: "search_messages_incomplete",
    retryable: true,
    stage: "read",
    details: {
      count: 2,
      failedCount: 1,
      pagesFetched: 1,
      failures: [{ error: "business error: success=false", messageIds: ["m-inside"], stage: "message-enrichment" }],
      partialResult: { complete: false, count: 2, messages: PARTIAL_MESSAGES },
    },
  },
});

// Same payload, but without the outer `error` wrapper.
const PARTIAL_FLAT = JSON.stringify({
  reason: "search_messages_incomplete",
  retryable: true,
  details: { failures: [{ stage: "message-enrichment" }], partialResult: { messages: PARTIAL_MESSAGES } },
});

// One fake binary for the whole file (dws-client resolves DWS_CLI_PATH at import
// time), driven by control files so each test can pick how dws misbehaves.
const ctl = mkdtempSync(join(tmpdir(), "omi-dws-"));
const fakeDws = join(ctl, "dws");
writeFileSync(fakeDws, [
  "#!/bin/sh",
  `ctl="${ctl}"`,
  "fail=0",
  "n=0; if [ -f \"$ctl/calls\" ]; then n=$(cat \"$ctl/calls\"); fi; echo $((n+1)) > \"$ctl/calls\"",
  "printf '%s\\n' \"$*\" >> \"$ctl/args.log\"",
  "if [ -f \"$ctl/reject-start\" ]; then",
  "  for arg in \"$@\"; do",
  "    if [ \"$arg\" = \"--start\" ]; then fail=1; fi",
  "  done",
  "fi",
  "if [ -f \"$ctl/fail-left\" ]; then",
  "  left=$(cat \"$ctl/fail-left\")",
  "  if [ \"$left\" -gt 0 ]; then echo $((left-1)) > \"$ctl/fail-left\"; fail=1; fi",
  "fi",
  "if [ -f \"$ctl/partial\" ]; then",
  `  printf '%s\\n' '${PARTIAL_ABORT.replace("'", "'\\''")}' >&2`,
  "  exit 1",
  "fi",
  "if [ -f \"$ctl/partial-flat\" ]; then",
  `  printf '%s\\n' '${PARTIAL_FLAT.replace("'", "'\\''")}' >&2`,
  "  exit 1",
  "fi",
  "if [ \"$fail\" = \"1\" ]; then",
  `  printf '%s\\n' '${JSON.stringify({ error: { category: "api", code: 1, message: COLLECTION_ERROR } })}' >&2`,
  "  exit 1",
  "fi",
  `cat <<'JSON'
${COLLECTION}
JSON`,
].join("\n"), "utf8");
chmodSync(fakeDws, 0o755);
process.env.DWS_CLI_PATH = fakeDws;

const { searchRecentGroupMessages, DwsTransientSearchError } = await import("../dist/dws/dws-client.js");
const start = new Date("2020-01-01T10:30:00");
const end = new Date("2020-01-01T11:00:00");
const search = () => searchRecentGroupMessages("测试甲", 10, 10, { start, end });

function setControl(name, value) {
  const path = join(ctl, name);
  if (value === undefined) rmSync(path, { force: true });
  else writeFileSync(path, value, "utf8");
}

function resetControls() {
  for (const name of ["reject-start", "fail-left", "partial", "partial-flat", "calls", "args.log"]) setControl(name, undefined);
}

function callCount() {
  return readFileSync(join(ctl, "calls"), "utf8").trim();
}

function seenArgs() {
  try {
    return readFileSync(join(ctl, "args.log"), "utf8");
  } catch {
    return "";
  }
}

test("a healthy dws answer is passed through unchanged", async () => {
  resetControls();
  const messages = await search();
  assert.deepEqual(messages.map((m) => m.content), ["old", "inside", "after"]);
});

test("a single undecidable answer is retried before anything else happens", async () => {
  resetControls();
  setControl("fail-left", "1");
  const messages = await search();
  assert.deepEqual(messages.map((m) => m.content), ["old", "inside", "after"]);
  assert.equal(callCount(), "2", "one failure plus one retry");
});

test("an aborted enrichment keeps the page dws already fetched", async () => {
  resetControls();
  setControl("partial", "");
  try {
    const messages = await search();
    assert.deepEqual(messages.map((m) => m.content), ["inside", "inside-2"]);
    assert.equal(callCount(), "1", "a partial page is used instead of being retried or dropped");
  } finally {
    resetControls();
  }
});

test("an incomplete search without the error wrapper still keeps its hits", async () => {
  resetControls();
  setControl("partial-flat", "");
  try {
    const messages = await search();
    assert.deepEqual(messages.map((m) => m.content), ["inside", "inside-2"]);
    assert.equal(callCount(), "1");
  } finally {
    resetControls();
  }
});

test("exhausted retries surface as a transient search error", async () => {
  resetControls();
  setControl("fail-left", "99");
  try {
    await assert.rejects(search, (err) => {
      assert.ok(err instanceof DwsTransientSearchError, "callers must be able to defer instead of reporting a failure");
      assert.ok(err.message.includes(`${start.toISOString()}..${end.toISOString()}`));
      return true;
    });
    assert.equal(callCount(), "6", "2 precise attempts plus 4 window attempts");
    assert.equal(readFileSync(join(ctl, "fail-left"), "utf8").trim(), "93");
  } finally {
    resetControls();
  }
});

test("a window dws cannot describe falls back to a --days scan filtered locally", async () => {
  resetControls();
  setControl("reject-start", "");
  try {
    const messages = await search();
    assert.deepEqual(messages.map((m) => m.content), ["inside"]);
    assert.deepEqual(messages.map((m) => m.message_id), ["m-inside"]);
  } finally {
    resetControls();
  }
});

test("the fallback is reused instead of paying for a doomed precise query every tick", async () => {
  resetControls();
  const messages = await search();
  assert.deepEqual(messages.map((m) => m.content), ["inside"]);
  assert.equal(callCount(), "1", "one window scan instead of two precise attempts plus a scan");
  assert.ok(!seenArgs().includes("--start"), "the precise form must not be retried right away");
});
