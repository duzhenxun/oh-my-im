import { spawn } from "node:child_process";
import type { AgentCallbacks, AgentResult, AgentSessionInfo } from "./index.js";
import type { Config } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { asObject, attachJsonlReader, createOpenCodeEnv, type JsonObject } from "./process-utils.js";

const log = createLogger("OpenCode");

function asTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number") return undefined;
  return new Date(value).toISOString();
}

export function listOpenCodeSessions(config: Config): Promise<AgentSessionInfo[]> {
  return new Promise((resolve) => {
    const cliPath = config.opencodeCliPath || "opencode";
    const child = spawn(cliPath, ["session", "list", "--format", "json", "-n", "500"], {
      cwd: config.codexWorkDir,
      env: createOpenCodeEnv(config.codexProxy),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) return resolve([]);
      try {
        const value = JSON.parse(stdout) as Array<Record<string, unknown>>;
        resolve(value.flatMap((item) => {
          const cwd = typeof item.directory === "string" ? item.directory : undefined;
          const id = typeof item.id === "string" ? item.id : undefined;
          if (!id) return [];
          return [{
            id,
            title: typeof item.title === "string" ? item.title : undefined,
            createdAt: asTimestamp(item.created),
            updatedAt: asTimestamp(item.updated),
            cwd,
          }];
        }));
      } catch {
        resolve([]);
      }
    });
  });
}

function textFromEvent(event: JsonObject): string | undefined {
  const part = asObject(event.part);
  const text = part?.text ?? event.text;
  return typeof text === "string" && text ? text : undefined;
}

function eventSessionId(event: JsonObject): string | undefined {
  for (const value of [event.sessionID, event.sessionId, event.session_id, asObject(event.part)?.sessionID]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolFromEvent(event: JsonObject): { name: string; id?: string } | undefined {
  if (event.type !== "tool_use" && event.type !== "tool") return undefined;
  const part = asObject(event.part);
  const name = [part?.tool, event.tool, event.name].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  if (!name) return undefined;
  const id = [part?.callID, part?.callId, event.callID, event.callId].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return { name, id };
}

export function runOpenCode(
  prompt: string,
  sessionId: string | undefined,
  config: Config,
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = ["run", "--format", "json", "--dir", config.codexWorkDir, "--auto"];
    if (config.agentModel) args.push("--model", config.agentModel);
    if (sessionId) args.push("--session", sessionId);
    args.push(prompt);
    const child = spawn(config.opencodeCliPath || "opencode", args, {
      cwd: config.codexWorkDir,
      env: createOpenCodeEnv(config.codexProxy),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let completed = false;
    let latestText = "";
    let stderr = "";
    let nextSessionId = sessionId;
    const toolStats: Record<string, number> = {};
    const seenTools = new Set<string>();
    const timeout = setTimeout(() => finishError(`OpenCode timeout after ${Math.round(config.cliTimeoutMs / 1000)}s`), config.cliTimeoutMs);
    timeout.unref();

    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolve({ sessionId: nextSessionId, text: latestText.trim() || "(无输出)", toolStats, durationMs: Date.now() - start });
    };
    function finishError(message: string): void {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    }

    callbacks.onAbortReady?.(() => {
      if (!completed) {
        child.kill("SIGTERM");
        setTimeout(() => { if (!completed) child.kill("SIGKILL"); }, 1_000).unref();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    attachJsonlReader(child.stdout, (line) => {
      let event: JsonObject;
      try { event = JSON.parse(line) as JsonObject; } catch { return; }
      nextSessionId = eventSessionId(event) || nextSessionId;
      if (event.type === "error") {
        const error = asObject(event.error);
        finishError(typeof error?.message === "string" ? error.message : typeof event.message === "string" ? event.message : "OpenCode failed");
        return;
      }
      const tool = toolFromEvent(event);
      if (tool) {
        const key = tool.id || `${tool.name}:${seenTools.size}`;
        if (!seenTools.has(key)) {
          seenTools.add(key);
          toolStats[tool.name] = (toolStats[tool.name] ?? 0) + 1;
          callbacks.onToolUse?.(tool.name, { ...toolStats });
        }
      }
      if (event.type === "text" || event.type === "message") {
        const text = textFromEvent(event);
        if (text) {
          latestText = text.startsWith(latestText) ? text : latestText.startsWith(text) ? latestText : latestText + text;
          callbacks.onText?.(latestText);
        }
      }
    });
    child.on("error", (error) => finishError(error.message));
    child.on("close", (code) => {
      if (completed) return;
      if (code && code !== 0) return finishError(stderr.trim() || `OpenCode exited with code ${code}`);
      finish();
    });
    log.info(`spawn ${config.opencodeCliPath || "opencode"} ${args.join(" ")}`);
  });
}
