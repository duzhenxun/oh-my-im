import type { AgentType, Config } from "../config.js";
export type { AgentType } from "../config.js";
import { runCodex } from "./codex-agent.js";
import { runPi } from "./pi-agent.js";

export interface AgentResult {
  sessionId?: string;
  text: string;
  toolStats: Record<string, number>;
  durationMs: number;
}

export interface AgentCallbacks {
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, toolStats: Record<string, number>) => void;
  onAbortReady?: (abort: () => void) => void;
  onSteerReady?: (steer: (message: string) => void) => void;
}

export function agentLabel(agent: AgentType): string {
  return agent === "pi" ? "Pi" : "Codex";
}

export function agentSwitchMessage(agent: AgentType): string {
  const label = agentLabel(agent);
  const source = agent === "pi"
    ? "Pi Agent（使用本机 Pi CLI）"
    : "Codex Agent（使用本机 Codex CLI）";
  return [
    `当前已切换到 ${label}。`,
    `当前 Agent：${source}`,
    "使用方法：直接发送问题或任务即可；发送已配置的暂停指令可暂停当前任务，发送 Agent 切换指令可再次切换。",
  ].join("\n");
}

export function runAgent(
  agent: AgentType,
  prompt: string,
  sessionId: string | undefined,
  config: Config,
  callbacks: AgentCallbacks = {},
): Promise<AgentResult> {
  return agent === "pi"
    ? runPi(prompt, sessionId, config, callbacks)
    : runCodex(prompt, sessionId, config, callbacks);
}
