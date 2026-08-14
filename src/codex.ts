import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";

export interface CodexResult {
  sessionId?: string;
  text: string;
  toolStats: Record<string, number>;
  durationMs: number;
}

export interface CodexCallbacks {
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, toolStats: Record<string, number>) => void;
}

const log = createLogger("Codex");

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
  callbacks: CodexCallbacks = {},
): Promise<CodexResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = buildArgs(prompt, config.codexWorkDir, sessionId, config);
    const env = { ...process.env };
    if (config.codexProxy) {
      env.HTTP_PROXY = config.codexProxy;
      env.HTTPS_PROXY = config.codexProxy;
      env.http_proxy = config.codexProxy;
      env.https_proxy = config.codexProxy;
      env.ALL_PROXY = config.codexProxy;
      env.all_proxy = config.codexProxy;
    }

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
