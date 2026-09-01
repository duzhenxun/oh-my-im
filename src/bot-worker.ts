import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runApp } from "./bot-app.js";
import type { Config } from "./config.js";
import type { CommandKeywordsConfig } from "./dws-dashboard.js";

const stateDir = join(homedir(), ".oh-my-im");
const dashboardConfigFile = join(stateDir, "dws-dashboard.json");
const lockFile = join(stateDir, "omi-bot.lock");
const defaultWorkDir = process.env.AGENT_WORK_DIR?.trim() || process.cwd();

interface DashboardCredentials {
  clientId?: string;
  clientSecret?: string;
  botAllowedUserIds?: string[];
  botSuperAdminUserIds?: string[];
  targets?: Array<{ senderId?: string }>;
  agent?: "codex" | "pi";
  botAllowedUserNames?: Record<string, string>;
  commandKeywords?: CommandKeywordsConfig;
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
    throw new Error("请先在管理页配置机器人单聊授权人员");
  }
  console.log(`[OmiBot] loaded authorization users=${allowedUserIds.length} ids=[${allowedUserIds.join(",")}] names=${JSON.stringify(configuredNames)}`);
  return {
    dingtalkClientId: clientId,
    dingtalkClientSecret: clientSecret,
    codexCliPath: "codex",
    codexWorkDir: defaultWorkDir,
    codexPermissionMode: "bypass",
    piCliPath: process.env.PI_CLI_PATH?.trim() || "pi",
    agent: credentials.agent === "pi" ? "pi" : "codex",
    allowedUserIds,
    cliTimeoutMs: 30 * 60 * 1000,
  };
}

const releaseLock = await acquireLock();
process.once("exit", () => {
  try {
    unlinkSync(lockFile);
  } catch {
    // The lock has already been removed.
  }
});

try {
  const config = loadBotConfig();
  await runApp(config, {
    singleChatOnly: true,
    getAgent: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.agent === "pi" ? "pi" : "codex";
      } catch {
        return config.agent;
      }
    },
    getCommandKeywords: () => {
      try {
        const current = JSON.parse(readFileSync(dashboardConfigFile, "utf8")) as DashboardCredentials;
        return current.commandKeywords ?? { pause: [], monitorOpen: [], monitorStop: [], switchPi: [], switchCodex: [] };
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
} finally {
  await releaseLock();
}
