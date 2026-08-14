import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runApp } from "./index.js";
import type { Config } from "./config.js";

const workspace = process.cwd();
const stateDir = join(workspace, ".oh-my-im");
const dashboardConfigFile = join(stateDir, "dws-dashboard.json");
const lockFile = join(workspace, ".oh-my-im-bot.lock");
const defaultWorkDir = "/Users/dds/go/src/git.inke.cn/opd/activitys/inke.activity.service";

interface DashboardCredentials {
  clientId?: string;
  clientSecret?: string;
  botAllowedUserIds?: string[];
  targets?: Array<{ senderId?: string }>;
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
  const allowedUserIds = [...new Set(configuredIds.map((id) => id.trim()).filter(Boolean))];
  if (allowedUserIds.length === 0) {
    throw new Error("请先在管理页配置机器人单聊授权人员");
  }
  return {
    dingtalkClientId: clientId,
    dingtalkClientSecret: clientSecret,
    codexCliPath: "codex",
    codexWorkDir: defaultWorkDir,
    codexPermissionMode: "bypass",
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
  await runApp(loadBotConfig(), { singleChatOnly: true });
} finally {
  await releaseLock();
}
