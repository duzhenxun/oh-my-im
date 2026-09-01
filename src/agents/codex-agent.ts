import { spawn } from "node:child_process";
import { open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentCallbacks, AgentResult, AgentSessionInfo } from "./index.js";
import type { Config } from "../config.js";
import { createLogger } from "../logger.js";
import { createAgentEnv } from "./process-utils.js";

const log = createLogger("Codex");

async function findCodexRollouts(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }));
  };
  await visit(root);
  return files;
}

async function readPrefix(path: string, size = 512 * 1024): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function codexMessage(event: Record<string, unknown>, role: "user" | "assistant"): string | undefined {
  if (event.type !== "response_item") return undefined;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload?.type !== "message" || payload.role !== role || !Array.isArray(payload.content)) return undefined;
  const text = payload.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: string; text?: string };
    const expectedType = role === "user" ? "input_text" : "output_text";
    return item.type === expectedType && typeof item.text === "string" ? [item.text] : [];
  }).join("\n").trim();
  if (!text || text.startsWith("# AGENTS.md instructions") || text.startsWith("<permissions instructions>")) return undefined;
  return text.replace(/\s+/g, " ").slice(0, 120);
}

export async function listCodexSessions(_config: Config): Promise<AgentSessionInfo[]> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const names = new Map<string, { title?: string; updatedAt?: string }>();
  try {
    for (const line of (await readFile(join(home, "session_index.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean)) {
      const item = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      if (item.id) names.set(item.id, { title: item.thread_name, updatedAt: item.updated_at });
    }
  } catch {
    // Older Codex versions may not have an index. Rollout metadata is enough.
  }
  const files = await findCodexRollouts(join(home, "sessions"));
  const sessions = await Promise.all(files.map(async (path): Promise<AgentSessionInfo | undefined> => {
    try {
      const events = (await readPrefix(path)).split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const meta = events.find((event) => event.type === "session_meta");
      const payload = meta?.payload as Record<string, unknown> | undefined;
      if (!meta || !payload) return undefined;
      const id = payload.session_id ?? payload.id;
      if (typeof id !== "string") return undefined;
      const indexed = names.get(id);
      const userMessages = events.map((event) => codexMessage(event, "user")).filter((item): item is string => Boolean(item));
      const assistantMessages = events.map((event) => codexMessage(event, "assistant")).filter((item): item is string => Boolean(item));
      const title = indexed?.title?.trim() || userMessages[0];
      const summary = assistantMessages.at(-1);
      return {
        id,
        title,
        summary,
        createdAt: typeof payload.timestamp === "string" ? payload.timestamp : typeof meta.timestamp === "string" ? meta.timestamp : undefined,
        updatedAt: indexed?.updatedAt,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      };
    } catch {
      return undefined;
    }
  }));
  return sessions.filter((item): item is AgentSessionInfo => Boolean(item))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractText(item: Record<string, unknown>): string | undefined {
  const itemType = item.type;
  if (itemType === "agent_message") {
    return typeof item.message === "string"
      ? item.message
      : typeof item.text === "string"
        ? item.text
        : undefined;
  }

  if (itemType === "message") {
    const content = item.content;
    if (!Array.isArray(content)) return undefined;
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as { type?: string; text?: string };
        return p.type === "output_text" && p.text ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return undefined;
}

/* codex exec is a one-turn process; follow-up messages are handled by the local queue. */
function queueCodexMessage(cliPath: string, threadId: string, message: string, config: Config): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["queue", "--thread", threadId, "--message", message];
    const child = spawn(cliPath, args, {
      cwd: config.codexWorkDir,
      env: createAgentEnv(config.codexProxy),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      log.warn(`queue spawn failed: ${error.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      if (code === 0) {
        log.info(`queued message thread=${threadId}`);
        resolve(true);
      } else {
        log.warn(`queue failed thread=${threadId}: ${stderr.trim() || `exit code ${code}`}`);
        resolve(false);
      }
    });
  });
}

function buildArgs(prompt: string, workDir: string, sessionId: string | undefined, config: Config): string[] {
  const common = ["--json", "--skip-git-repo-check"];
  if (config.codexPermissionMode === "bypass") {
    common.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (config.codexPermissionMode === "read-only") {
    common.push("--sandbox", "read-only");
  } else {
    common.push("--full-auto");
  }

  const modelOptions = config.codexModel ? ["--model", config.codexModel] : [];

  return sessionId
    ? ["exec", "resume", ...common, ...modelOptions, sessionId, "-"]
    : ["exec", ...common, ...modelOptions, "--cd", workDir, "-"];
}

export function runCodex(
  prompt: string,
  sessionId: string | undefined,
  config: Config,
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = buildArgs(prompt, config.codexWorkDir, sessionId, config);
    const env = createAgentEnv(config.codexProxy);

    log.info(`spawn ${config.codexCliPath} ${args.join(" ")}`);
    const child = spawn(config.codexCliPath, args, {
      cwd: config.codexWorkDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let completed = false;
    let nextSessionId = sessionId;
    let accumulated = "";
    let stderr = "";
    const toolStats: Record<string, number> = {};
    const timeout = setTimeout(() => {
      if (completed) return;
      completed = true;
      child.kill("SIGTERM");
      log.warn(`timeout after ${config.cliTimeoutMs}ms`);
      reject(new Error(`Codex CLI timeout after ${Math.round(config.cliTimeoutMs / 1000)}s`));
    }, config.cliTimeoutMs);
    timeout.unref();

    callbacks.onAbortReady?.(() => {
      if (!completed) {
        child.kill("SIGTERM");
        // Some child processes do not exit on SIGTERM. Ensure a user pause
        // actually stops the current Codex task.
        setTimeout(() => {
          if (!completed) child.kill("SIGKILL");
        }, 1_000).unref();
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        log.debug(`stderr: ${line.slice(0, 1_000)}`);
      }
    });

    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    };

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const event = parseJsonLine(line);
      if (!event) return;

      const payload = (event.payload as Record<string, unknown> | undefined) ?? event;
      const type = (payload.type as string | undefined) ?? (event.type as string | undefined);

      if (type === "thread.started" || type === "session_meta") {
        const id = payload.thread_id ?? payload.session_id ?? event.thread_id;
        if (typeof id === "string" && id) {
          nextSessionId = id;
          log.debug(`session=${id}`);
        }
        return;
      }

      if (type === "turn.failed" || type === "error") {
        const err = payload.error as { message?: string } | undefined;
        const message = err?.message ?? (typeof payload.message === "string" ? payload.message : "Codex failed");
        log.error(message);
        fail(message);
        return;
      }

      if (event.type === "response_item" || type === "item.started" || type === "item.updated" || type === "item.completed") {
        const item = (payload.item as Record<string, unknown> | undefined) ?? payload;
        const itemType = item.type;
        if (itemType === "function_call" || itemType === "custom_tool_call") {
          const name = typeof item.name === "string" ? item.name : "tool";
          toolStats[name] = (toolStats[name] ?? 0) + 1;
          log.debug(`tool=${name}`);
          callbacks.onToolUse?.(name, { ...toolStats });
          return;
        }

        const text = extractText(item);
        if (text) {
          accumulated += (accumulated ? "\n\n" : "") + text;
          callbacks.onText?.(accumulated);
        }
        return;
      }

      if (type === "task_complete" || type === "turn.completed") {
        const last = payload.last_agent_message;
        if (!accumulated && typeof last === "string") accumulated = last;
        completed = true;
        clearTimeout(timeout);
        log.info(`completed in ${Date.now() - start}ms`);
        resolve({
          sessionId: nextSessionId,
          text: accumulated.trim() || "(无输出)",
          toolStats,
          durationMs: Date.now() - start,
        });
      }
    });

    child.on("error", (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      log.error("spawn error", err);
      reject(err);
    });

    child.on("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (code && code !== 0) {
        log.error(`exit code ${code}`);
        reject(new Error(stderr.trim() || `Codex CLI exited with code ${code}`));
        return;
      }
      log.info(`closed cleanly in ${Date.now() - start}ms`);
      resolve({
        sessionId: nextSessionId,
        text: accumulated.trim() || "(无输出)",
        toolStats,
        durationMs: Date.now() - start,
      });
    });
  });
}
