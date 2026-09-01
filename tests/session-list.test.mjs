import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexSessions } from "../dist/agents/codex-agent.js";
import { listPiSessions } from "../dist/agents/pi-agent.js";

const config = (cwd) => ({
  dingtalkClientId: "", dingtalkClientSecret: "", codexCliPath: "codex",
  codexWorkDir: cwd, piCliPath: "pi", agent: "pi", allowedUserIds: [], cliTimeoutMs: 1000,
});

test("lists Pi sessions with title and cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omi-pi-sessions-"));
  const file = join(dir, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "session", id: "pi-id", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/pi-work" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Pi session title" }] } }),
  ].join("\n"));
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  try {
    assert.deepEqual(await listPiSessions(config(dir)), [{
      id: "pi-id", title: "Pi session title", summary: undefined, createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z", cwd: "/tmp/pi-work",
    }]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("lists Codex sessions with indexed title and cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "omi-codex-sessions-"));
  const sessions = join(home, "sessions", "2026", "01", "01");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(home, "session_index.jsonl"), JSON.stringify({ id: "codex-id", thread_name: "Codex title", updated_at: "2026-01-02T00:00:00Z" }));
  await writeFile(join(sessions, "rollout.jsonl"), [
    JSON.stringify({
      type: "session_meta", timestamp: "2026-01-01T00:00:00Z",
      payload: { session_id: "codex-id", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/codex-work" },
    }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nignore" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Real Codex question" }] } }),
  ].join("\n"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.deepEqual(await listCodexSessions(config(home)), [{
      id: "codex-id", title: "Codex title", summary: undefined, createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z", cwd: "/tmp/codex-work",
    }]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
