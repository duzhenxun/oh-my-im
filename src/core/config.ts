import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeAgentModel, type AgentModels } from "../dws-dashboard.js";

export type AgentType = "codex" | "pi" | "opencode";

export interface Config {
  dingtalkClientId: string;
  dingtalkClientSecret: string;
  codexCliPath: string;
  opencodeCliPath?: string;
  codexWorkDir: string;
  agentModels: AgentModels;
  codexModel?: string;
  codexProxy?: string;
  codexPermissionMode?: "bypass" | "read-only";
  piCliPath?: string;
  agent: AgentType;
  agentModel?: string;
  allowedUserIds: string[];
  cliTimeoutMs: number;
}

interface LocalBotConfig {
  clientId?: string;
  clientSecret?: string;
  botAllowedUserIds?: string[];
  agent?: AgentType;
  agentModels?: Partial<AgentModels>;
  agentModel?: string;
}

export function resolveAgentModel(
  agent: AgentType,
  agentModels: Partial<AgentModels> | undefined,
  activeAgent: AgentType | undefined,
  legacyModel: string | undefined,
): string | undefined {
  const configured = agentModels?.[agent]?.trim() || (activeAgent === agent ? legacyModel?.trim() : "") || "";
  return normalizeAgentModel(agent, configured) || undefined;
}

function loadLocalBotConfig(): LocalBotConfig {
  const path = join(process.cwd(), ".oh-my-im", "dws-dashboard.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LocalBotConfig;
  } catch {
    throw new Error("未找到 .oh-my-im/dws-dashboard.json，请先启动 omi 并在管理页配置钉钉应用凭证");
  }
}

function resolveWorkDir(): string {
  const dir = resolve(process.cwd());
  if (!existsSync(dir)) throw new Error(`Codex work directory does not exist: ${dir}`);
  return dir;
}

export function loadConfig(): Config {
  const local = loadLocalBotConfig();
  const clientId = local.clientId?.trim();
  const clientSecret = local.clientSecret?.trim();
  if (!clientId || !clientSecret) throw new Error("请先在管理页填写钉钉应用 Client ID 和 Client Secret");
  return {
    dingtalkClientId: clientId,
    dingtalkClientSecret: clientSecret,
    codexCliPath: "codex",
    codexWorkDir: resolveWorkDir(),
    agentModels: {
      codex: resolveAgentModel("codex", local.agentModels, local.agent, local.agentModel) || "",
      pi: resolveAgentModel("pi", local.agentModels, local.agent, local.agentModel) || "",
      opencode: resolveAgentModel("opencode", local.agentModels, local.agent, local.agentModel) || "",
    },
    agentModel: local.agent === "pi" || local.agent === "opencode" || local.agent === "codex"
      ? resolveAgentModel(local.agent, local.agentModels, local.agent, local.agentModel)
      : undefined,
    codexPermissionMode: "bypass",
    opencodeCliPath: process.env.OPENCODE_CLI_PATH?.trim() || "opencode",
    piCliPath: process.env.PI_CLI_PATH?.trim() || "pi",
    agent: local.agent === "pi" || local.agent === "opencode" ? local.agent : "codex",
    allowedUserIds: [...new Set((local.botAllowedUserIds ?? []).map((id) => id.trim()).filter(Boolean))],
    cliTimeoutMs: 30 * 60 * 1000,
  };
}
