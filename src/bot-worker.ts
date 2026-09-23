import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runApp } from "./bot-app.js";
import { resolveAgentModel, type Config } from "./core/config.js";
import { type AgentModels, type CommandKeywordsConfig } from "./dws-dashboard.js";

const stateDir = join(homedir(), ".oh-my-im");
const dashboardConfigFile = join(stateDir, "dws-dashboard.json");
const lockFile = join(stateDir, "omi-bot.lock");
const botStatusFile = join(stateDir, "omi-bot-status.json");
const defaultWorkDir = process.env.AGENT_WORK_DIR?.trim() || process.cwd();

interface DashboardCredentials {
  clientId?: string;
  clientSecret?: string;
  botAllowedUserIds?: string[];
  botSuperAdminUserIds?: string[];
  targets?: Array<{ senderId?: string }>;
  agent?: "codex" | "pi" | "opencode";
  agentModels?: Partial<AgentModels>;
  agentModel?: string;
  botAllowedUserNames?: Record<string, string>;
  commandKeywords?: CommandKeywordsConfig;
  privateChatEnabled?: boolean;
  responseMode?: "card" | "aiCard" | "text";
  showProcessingDetails?: boolean;
  aiCardTemplateId?: string;
  aiCardContentKey?: string;
  aiCardStreamIntervalMs?: number;
}

async function acquireLock(): Promise<() => Promise<void>> {
  let lock;
  try {
    lock = await open(lockFile, "wx");
  } catch {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    try {
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      throw new Error("一对一机器人已在运行");
    } catch (err) {
      if (err instanceof Error && err.message === "一对一机器人已在运行") throw err;
      await unlink(lockFile).catch(() => undefined);
      lock = await open(lockFile, "wx");
    }
  }
  await lock.writeFile(`${process.pid}\n`);
  return async () => {
    await lock.close();
    await unlink(lockFile).catch(() => undefined);
  };
}

function loadBotConfig(): Config {
  if (!existsSync(dashboardConfigFile)) {
    throw new Error("未找到 .oh-my-im/dws-dashboard.json，请先启动 omi listen 并在管理页配置钉钉应用凭证");
  }
  const credentials = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("请先在管理页填写钉钉应用 Client ID 和 Client Secret");
  }
  const configuredIds = credentials.botAllowedUserIds ?? credentials.targets?.map((target) => target.senderId ?? "") ?? [];
  const configuredNames = credentials.botAllowedUserNames ?? {};
  const allowedUserIds = [...new Set(configuredIds.map((id) => id.trim()).filter(Boolean))];
  if (allowedUserIds.length === 0) {
    // A fresh installation should still start so the management page can be
    // used to configure the first authorized person. All incoming private
    // messages remain denied by runApp until an ID is added.
    console.log("[OmiBot] no private-chat authorization users configured; worker started in deny-all mode");
  } else {
    console.log(`[OmiBot] loaded authorization users=${allowedUserIds.length} ids=[${allowedUserIds.join(",")}] names=${JSON.stringify(configuredNames)}`);
  }
  return {
    dingtalkClientId: clientId,
    dingtalkClientSecret: clientSecret,
    codexCliPath: "codex",
    codexWorkDir: defaultWorkDir,
    agentModels: {
      codex: resolveAgentModel("codex", credentials.agentModels, credentials.agent, credentials.agentModel) || "",
      pi: resolveAgentModel("pi", credentials.agentModels, credentials.agent, credentials.agentModel) || "",
      opencode: resolveAgentModel("opencode", credentials.agentModels, credentials.agent, credentials.agentModel) || "",
    },
    agentModel: credentials.agent === "pi" || credentials.agent === "opencode" || credentials.agent === "codex"
      ? resolveAgentModel(credentials.agent, credentials.agentModels, credentials.agent, credentials.agentModel)
      : undefined,
    codexPermissionMode: "bypass",
    opencodeCliPath: process.env.OPENCODE_CLI_PATH?.trim() || "opencode",
    piCliPath: process.env.PI_CLI_PATH?.trim() || "pi",
    agent: credentials.agent === "pi" || credentials.agent === "opencode" ? credentials.agent : "codex",
    allowedUserIds,
    cliTimeoutMs: 30 * 60 * 1000,
  };
}

function writeBotStatus(enabled: boolean, connected: boolean): void {
  try { writeFileSync(botStatusFile, `${JSON.stringify({ pid: process.pid, enabled, connected, updatedAt: new Date().toISOString() })}\n`, "utf8"); } catch { /* status is diagnostic only */ }
}

function markBotStopped(): void {
  try {
    const current = JSON.parse(readFileSync(botStatusFile, "utf8")) as { pid?: number };
    // An old worker can finish its shutdown after a replacement worker starts;
    // never let that stale process overwrite the replacement's live status.
    if (current.pid !== process.pid) return;
  } catch { return; }
  writeBotStatus(false, false);
}

const releaseLock = await acquireLock();
process.once("exit", () => {
  // 进程真正退出时才写“已停止”，否则会覆盖 runApp 初始化后写入的“已连接”。
  try {
    markBotStopped();
  } catch {
    // status is diagnostic only
  }
  try {
    unlinkSync(lockFile);
  } catch {
    // The lock has already been removed.
  }
});

try {
  const config = loadBotConfig();
  // Publish the configured state immediately. On startup the stream is not
  // connected yet, and a disabled stream must not briefly appear enabled.
  const initiallyEnabled = (() => {
    try {
      return (JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials).privateChatEnabled !== false;
    } catch {
      return true;
    }
  })();
  writeBotStatus(initiallyEnabled, false);
  await runApp(config, {
    singleChatOnly: true,
    getAgent: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.agent === "pi" || current.agent === "opencode" ? current.agent : "codex";
      } catch {
        return config.agent;
      }
    },
    getAgentModel: (agent) => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        const model = resolveAgentModel(agent, current.agentModels, current.agent, current.agentModel);
        console.log(`[OmiBot] live agent model agent=${agent} model=${model || "<cli-default>"}`);
        return model;
      } catch {
        return config.agentModels[agent] || undefined;
      }
    },
    getResponseMode: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.responseMode === "text" ? "text" : current.responseMode === "aiCard" ? "aiCard" : "card";
      } catch {
        return "card";
      }
    },
    getAiCardConfig: () => {
      // Live value so a template ID saved in the console applies to the next message.
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return {
          templateId: typeof current.aiCardTemplateId === "string" ? current.aiCardTemplateId.trim() : "",
          contentKey: typeof current.aiCardContentKey === "string" && current.aiCardContentKey.trim() ? current.aiCardContentKey.trim() : "content",
          streamIntervalMs: Number.isFinite(current.aiCardStreamIntervalMs) ? Number(current.aiCardStreamIntervalMs) : 500,
        };
      } catch {
        return { templateId: "", contentKey: "content", streamIntervalMs: 500 };
      }
    },
    getShowProcessingDetails: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.showProcessingDetails === true;
      } catch {
        return false;
      }
    },
    getCommandKeywords: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.commandKeywords ?? { pause: [], monitorOpen: [], monitorStop: [], switchPi: [], switchCodex: [], switchOpencode: [] };
      } catch {
        return undefined;
      }
    },
    getSuperAdminUserIds: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return [...new Set((current.botSuperAdminUserIds ?? []).map((id) => id.trim()).filter(Boolean))];
      } catch {
        return [];
      }
    },
    onConnectionStatus: (connected) => {
      // The configuration file is the source of truth. Do not preserve the
      // previous status file's enabled=false value when a new worker connects.
      let enabled = true;
      try {
        enabled = (JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials).privateChatEnabled !== false;
      } catch { /* keep the safe default */ }
      writeBotStatus(enabled, connected);
    },
    getShowElapsed: () => {
      try { return (JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as { showElapsed?: unknown }).showElapsed !== false; }
      catch { return true; }
    },
    getCardUpdateIntervalMs: () => {
      try {
        const value = (JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as { cardUpdateIntervalMs?: unknown }).cardUpdateIntervalMs;
        return Number.isFinite(value) ? Number(value) : 3_000;
      } catch { return 3_000; }
    },
    getPrivateChatEnabled: () => {
      try { return (JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials).privateChatEnabled !== false; }
      catch { return true; }
    },
    getAllowedUserIds: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        const ids = current.botAllowedUserIds ?? [];
        const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
        console.log(`[OmiBot] live authorization check file=${dashboardConfigFile} ids=[${normalized.join(",")}] names=${JSON.stringify(current.botAllowedUserNames ?? {})}`);
        return normalized;
      } catch (err) {
        console.error(`[OmiBot] live authorization config read failed file=${dashboardConfigFile}:`, err);
        return config.allowedUserIds;
      }
    },
  });
} catch (err) {
  // 只有初始化失败才在这里收尾；正常情况 runApp 返回后 Stream/定时器仍在运行，
  // markBotStopped 交给 process exit 处理。
  markBotStopped();
  await releaseLock();
  throw err;
}
