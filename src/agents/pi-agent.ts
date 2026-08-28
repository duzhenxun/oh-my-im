import { spawn } from "node:child_process";
import type { AgentCallbacks, AgentResult } from "./index.js";
import type { Config } from "../config.js";
import { createLogger } from "../logger.js";
import { asObject, attachJsonlReader, createAgentEnv, type JsonObject } from "./process-utils.js";

const log = createLogger("Pi");

function extractAssistantText(message: unknown): string | undefined {
  const value = asObject(message);
  if (!value || value.role !== "assistant" || !Array.isArray(value.content)) return undefined;
  const text = value.content.flatMap((part) => {
    const item = asObject(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
  return text || undefined;
}

export function runPi(
  prompt: string,
  sessionId: string | undefined,
  config: Config,
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = ["--mode", "rpc", "--approve"];
    if (sessionId) args.push("--session", sessionId);
    const env = createAgentEnv(config.codexProxy);

    const cliPath = config.piCliPath || "pi";
    log.info(`spawn ${cliPath} ${args.join(" ")}`);
    const child = spawn(cliPath, args, {
      cwd: config.codexWorkDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let completed = false;
    let accumulated = "";
    let authoritativeText = "";
    let nextSessionId = sessionId;
    let stderr = "";
    const toolStats: Record<string, number> = {};
    const seenToolCalls = new Set<string>();

    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      resolve({
        sessionId: nextSessionId,
        text: (authoritativeText || accumulated).trim() || "(无输出)",
        toolStats,
        durationMs: Date.now() - start,
      });
    };
    const fail = (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error(message));
    };
    const timeout = setTimeout(() => {
      log.warn(`timeout after ${config.cliTimeoutMs}ms`);
      fail(`Pi Agent timeout after ${Math.round(config.cliTimeoutMs / 1000)}s`);
    }, config.cliTimeoutMs);
    timeout.unref();

    callbacks.onAbortReady?.(() => {
      if (!completed) {
        child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
        setTimeout(() => child.kill("SIGTERM"), 1000).unref();
      }
    });
    callbacks.onSteerReady?.((message) => {
      if (completed || child.stdin.destroyed || !child.stdin.writable) return false;
      try {
        child.stdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
        return true;
      } catch {
        return false;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        log.debug(`stderr: ${line.slice(0, 1_000)}`);
      }
    });

    attachJsonlReader(child.stdout, (line) => {
      let event: JsonObject;
      try {
        event = JSON.parse(line) as JsonObject;
      } catch {
        log.warn(`ignored non-JSON Pi output: ${line.slice(0, 240)}`);
        return;
      }

      if (event.type === "response" && event.success === false) {
        fail(typeof event.error === "string" ? event.error : "Pi Agent command failed");
        return;
      }
      if (event.type === "response" && event.command === "get_state" && event.success === true) {
        const data = asObject(event.data);
        if (typeof data?.sessionId === "string" && data.sessionId) nextSessionId = data.sessionId;
        child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: prompt })}\n`);
        return;
      }
      if (event.type === "message_update") {
        const update = asObject(event.assistantMessageEvent);
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          accumulated += update.delta;
          callbacks.onText?.(accumulated);
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        const name = typeof event.toolName === "string" ? event.toolName : "tool";
        const callId = typeof event.toolCallId === "string" ? event.toolCallId : `${name}:${seenToolCalls.size}`;
        if (!seenToolCalls.has(callId)) {
          seenToolCalls.add(callId);
          toolStats[name] = (toolStats[name] ?? 0) + 1;
          callbacks.onToolUse?.(name, { ...toolStats });
        }
        return;
      }
      if (event.type === "message_end") {
        const text = extractAssistantText(event.message);
        if (text) authoritativeText = text;
        return;
      }
      if (event.type === "agent_settled") finish();
    });

    child.on("error", (err) => {
      log.error("spawn error", err);
      fail(err.message);
    });
    child.on("close", (code) => {
      if (completed) return;
      if (code && code !== 0) {
        fail(stderr.trim() || `Pi Agent exited with code ${code}`);
        return;
      }
      finish();
    });

    child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  });
}
