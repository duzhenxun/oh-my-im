#!/usr/bin/env node
import { mkdir, open, readFile, stat, writeFile, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startDashboard,
  normalizeAgentModel,
  type DashboardConfig,
  type DashboardStatus,
  type ReplyRecord,
  type SystemMonitorStatus,
} from "./dws-dashboard.js";
import {
  getDwsAuthStatus,
  getCurrentDwsUser,
  startDwsDeviceLogin,
  getDwsDeviceLoginOutput,
  logoutDws,
  searchGroups,
  listGroupMembers,
  searchUsers,
  searchBots,
} from "./dws-client.js";

const dataDir = join(homedir(), ".oh-my-im");
const configFile = join(dataDir, "dws-dashboard.json");
const serverFile = join(dataDir, "dws-dashboard-server.json");
const botStatusFile = join(dataDir, "omi-bot-status.json");
const stateFile = join(dataDir, "omi-state.json");
const logFile = join(dataDir, "omi.log");
const workerDir = dirname(fileURLToPath(import.meta.url));
const omiPath = join(workerDir, "omi.js");
const processPaths: Record<string, string> = { "group-worker": join(workerDir, "group-worker.js"), bot: join(workerDir, "bot-worker.js") };
const packageFile = join(new URL(".", import.meta.url).pathname, "..", "package.json");
const repliesDir = join(dataDir, "replies");

const defaultConfig = (): DashboardConfig => ({
  privateChatEnabled: false,
  responseMode: "card",
  cardUpdateIntervalMs: 3_000,
  showElapsed: true,
  showProcessingDetails: false,
  personalHistoryMessageLimit: 10,
  personalHistoryPollIntervalSeconds: 15,
  personalHistoryLookbackMinutes: 10,
  webhookUrl: "",
  targets: [], botAllowedUserIds: [], botAllowedUserNames: {},
  botSuperAdminUserIds: [], botSuperAdminUserNames: {}, robotSenderOpenDingTalkId: "",
  commandKeywords: { pause: [], monitorOpen: [], monitorStop: [], switchPi: [], switchCodex: [] },
  groupPromptSuffix: "", replyFormat: "markdown", robotName: "AI Agent",
  clientId: "", clientSecret: "", agentModels: { codex: "", pi: "" }, agent: "codex",
});

async function loadConfig(): Promise<DashboardConfig> {
  try {
    const value = JSON.parse(await readFile(configFile, "utf8")) as Partial<DashboardConfig> & { groupPromptPrefix?: string };
    const migrated = { ...value };
    if (!migrated.groupPromptSuffix && migrated.groupPromptPrefix) migrated.groupPromptSuffix = migrated.groupPromptPrefix;
    delete migrated.groupPromptPrefix;
    return {
      ...defaultConfig(),
      ...migrated,
      agentModels: { ...defaultConfig().agentModels, ...(migrated.agentModels ?? {}), codex: "" },
      commandKeywords: { ...defaultConfig().commandKeywords, ...(migrated.commandKeywords ?? {}) },
    };
  } catch {
    return defaultConfig();
  }
}

async function saveConfig(config: DashboardConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, configFile);
}

async function loadServerConfig(): Promise<{ port: number; host: string }> {
  try {
    const value = JSON.parse(await readFile(serverFile, "utf8")) as { port?: number; host?: string };
    if (Number.isInteger(value.port) && value.port! > 0 && typeof value.host === "string") return { port: value.port!, host: value.host };
  } catch { /* use defaults */ }
  const config = { port: 12525, host: "127.0.0.1" };
  await mkdir(dataDir, { recursive: true });
  await writeFile(serverFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

function validReplies(value: unknown): ReplyRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ReplyRecord => Boolean(item && typeof item === "object" &&
    typeof (item as ReplyRecord).id === "string" && typeof (item as ReplyRecord).content === "string" &&
    ((item as ReplyRecord).status === "completed" || (item as ReplyRecord).status === "failed")));
}

function todayFileName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

async function loadReplies(): Promise<ReplyRecord[]> {
  // The dashboard only shows today's newest ten records. Reading one bounded
  // file also avoids scanning years of reply history on every refresh.
  try {
    const records = validReplies(JSON.parse(await readFile(join(repliesDir, todayFileName()), "utf8")));
    return records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10);
  } catch {
    return [];
  }
}

function processIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function systemStatus(): Promise<SystemMonitorStatus> {
  let state: { mode?: string; startedAt?: string; workspace?: string; processes?: Array<{ role?: string; pid?: number }> } = {};
  try { state = JSON.parse(await readFile(stateFile, "utf8")) as typeof state; } catch { /* report discovered processes below */ }
  const ps = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  const rows = ps.status === 0 && typeof ps.stdout === "string" ? ps.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  }) : [];
  const roles = new Map<number, string>();
  for (const item of state.processes ?? []) if (item.pid && item.role) roles.set(item.pid, item.role);
  rows.filter((item) => /\/dist\/(dashboard-worker|group-worker|bot-worker)\.js(?:\s|$)/.test(item.command)).forEach((item) => {
    if (!roles.has(item.pid)) roles.set(item.pid, item.command.match(/\/dist\/([^/]+)\.js/)?.[1] || "worker");
  });
  const processes = [...roles.entries()].map(([pid, role]) => {
    const row = rows.find((item) => item.pid === pid);
    return { role, pid, ppid: row?.ppid, running: processIsRunning(pid), command: row?.command };
  });
  return { mode: state.mode || "unknown", startedAt: state.startedAt, workspace: state.workspace, processes, checkedAt: new Date().toISOString() };
}

async function systemLogs(offset?: number): Promise<{ content: string; path: string; size: number; nextOffset: number; reset: boolean }> {
  try {
    const info = await stat(logFile);
    const initialTailBytes = 100_000;
    const requestedOffset = offset === undefined ? Math.max(0, info.size - initialTailBytes) : Math.floor(offset);
    const reset = requestedOffset > info.size;
    const start = reset ? Math.max(0, info.size - initialTailBytes) : Math.max(0, requestedOffset);
    const length = info.size - start;
    const handle = await open(logFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, start);
      let content = buffer.toString("utf8");
      // An initial tail may begin in the middle of a line; incremental reads
      // always start at the exact previous byte offset and must stay intact.
      if (offset === undefined && start > 0) content = content.replace(/^[^\n]*\n/, "");
      return { content, path: logFile, size: info.size, nextOffset: info.size, reset };
    } finally { await handle.close(); }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "ENOENT") return { content: "", path: logFile, size: 0, nextOffset: 0, reset: false };
    throw err;
  }
}

async function controlSystemProcess(role: string, action: "start" | "stop"): Promise<void> {
  if (action === "start") {
    const path = processPaths[role];
    if (!path) throw new Error("未知进程");
    const child = spawn(process.execPath, [path], { cwd: process.cwd(), detached: true, stdio: "ignore" });
    child.unref();
    return;
  }
  const ps = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  const marker = `/dist/${role === "bot" ? "bot-worker" : role}.js`;
  const pids = typeof ps.stdout === "string" ? ps.stdout.split("\n").flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(.+)$/); return match && match[2].includes(marker) ? [Number(match[1])] : []; }) : [];
  for (const pid of pids) if (pid !== process.pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
}

async function restartSystem(): Promise<void> {
  // Delay the detached manager so the HTTP 202 response can reach the browser
  // before this dashboard worker is terminated as part of the restart.
  const child = spawn(process.execPath, [omiPath, "restart"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
  child.unref();
}

async function listAgentModels(agent: "codex" | "pi"): Promise<string[]> {
  const command = agent === "pi" ? "pi" : "codex";
  const result = spawnSync(command, ["--list-models"], { encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) {
    if (agent === "codex") return ["默认模型（不指定）"];
    throw new Error(result.stderr?.trim() || result.error?.message || `${command} 模型列表查询失败`);
  }
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim());
  const models = agent === "pi"
    ? lines.flatMap((line) => {
      const match = line.match(/^(\S+)\s+(\S+)(?:\s|$)/);
      return match && match[1] !== "provider" ? [`${match[1]}/${match[2]}`] : [];
    })
    : lines.filter((line) => line && !/^[-= ]+$/.test(line) && !/^available models/i.test(line));
  return [...new Set(models)];
}

async function botStatus(): Promise<{ enabled: boolean; connected: boolean; updatedAt?: string }> {
  const config = await loadConfig();
  try {
    const value = JSON.parse(await readFile(botStatusFile, "utf8")) as { connected?: boolean; updatedAt?: string };
    return { enabled: config.privateChatEnabled === true, connected: config.privateChatEnabled === true && value.connected !== false, updatedAt: value.updatedAt };
  } catch { return { enabled: config.privateChatEnabled !== false, connected: false }; }
}

async function main(): Promise<void> {
  let version = "unknown";
  try { version = (JSON.parse(await readFile(packageFile, "utf8")) as { version?: string }).version?.trim() || version; }
  catch { /* package metadata is optional in development */ }
  // Do not create a partial config here. The group-worker process owns initialization and
  // migration; this process only reads it and writes complete configurations
  // submitted by the dashboard.
  let config = await loadConfig();
  const serverConfig = await loadServerConfig();
  const runtime: DashboardStatus = { startedAt: new Date().toISOString(), eventConnected: false, activeBatches: 0 };
  // The group-worker process can change targets through "打开ai/关闭ai" commands. Keep
  // the standalone dashboard's in-memory view synchronized with the shared
  // config file, otherwise /api/state would continue showing its old targets.
  const configReloadTimer = setInterval(() => {
    void loadConfig().then((latest) => {
      if (JSON.stringify(latest) !== JSON.stringify(config)) config = latest;
    }).catch(() => undefined);
  }, 1_000);
  configReloadTimer.unref();
  let replies = await loadReplies();
  const replyReloadTimer = setInterval(() => {
    void loadReplies().then((latest) => { replies = latest; }).catch(() => undefined);
  }, 1_000);
  replyReloadTimer.unref();
  startDashboard(serverConfig.port, {
    getConfig: () => config,
    updateConfig: async (next) => {
      const normalized = { ...next, agentModels: { ...next.agentModels, codex: "" } };
      await saveConfig(normalized);
      config = normalized;
    },
    getStatus: () => ({ ...runtime }),
    // Replies are persisted by group-worker/bot. The dashboard remains usable
    // even when those workers are absent or have not been configured yet.
    getReplies: (): ReplyRecord[] => replies,
    searchGroups, listGroupMembers, searchUsers, searchBots,
    getCurrentDwsUser: async () => ({ ...(await getCurrentDwsUser()), auth: await getDwsAuthStatus() }),
    getDwsAuthStatus, startDwsDeviceLogin, getDwsDeviceLoginOutput, logoutDws, getBotStatus: botStatus,
    getSystemStatus: systemStatus, getSystemLogs: systemLogs, restartSystem, controlSystemProcess, listAgentModels,
  }, { host: serverConfig.host, version });
  console.log(`[OmiDashboard] dashboard started at http://${serverConfig.host}:${serverConfig.port}`);
}

main().catch((err) => {
  console.error(`[OmiDashboard] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  // The web process must not take down the manager because an optional status
  // provider (for example dws on a fresh machine) is unavailable.
});
