#!/usr/bin/env node
import { mkdir, open, readFile, stat, writeFile, rename, chmod } from "node:fs/promises";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startDashboard,
  normalizeAgentModel,
  SESSION_MAX_AGE_SECONDS,
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
} from "./dws/dws-client.js";
import { readVersion } from "./core/version.js";

const dataDir = join(homedir(), ".oh-my-im");
const configFile = join(dataDir, "dws-dashboard.json");
const serverFile = join(dataDir, "dws-dashboard-server.json");
const botStatusFile = join(dataDir, "omi-bot-status.json");
const stateFile = join(dataDir, "omi-state.json");
const logFile = join(dataDir, "omi.log");
const workerDir = dirname(fileURLToPath(import.meta.url));
const omiPath = join(workerDir, "omi.js");
const processPaths: Record<string, string> = { "group-worker": join(workerDir, "group-worker.js"), bot: join(workerDir, "bot-worker.js") };
const repliesDir = join(dataDir, "replies");
const passwordFile = join(dataDir, "dashboard-password.json");
const sessionsFile = join(dataDir, "dashboard-sessions.json");
const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = SESSION_MAX_AGE_SECONDS * 1000;
const sessions = new Map<string, number>();
const DEFAULT_PASSWORD = "5552123";

type PasswordRecord = { salt: string; hash: string };
async function passwordHash(password: string, salt = randomBytes(16).toString("hex")): Promise<PasswordRecord> {
  const derived = await scrypt(password, salt, 64) as Buffer;
  return { salt, hash: derived.toString("hex") };
}
async function loadPassword(): Promise<PasswordRecord> {
  try { return JSON.parse(await readFile(passwordFile, "utf8")) as PasswordRecord; }
  catch { const record = await passwordHash(DEFAULT_PASSWORD); await savePassword(record); return record; }
}
async function savePassword(record: PasswordRecord): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${passwordFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, passwordFile);
}
function cookieValue(request: import("node:http").IncomingMessage): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("omi_session="))?.slice("omi_session=".length);
}

// 登录会话持久化到磁盘，重启看板不会把已登录的设备踢下线（有效期 60 天）。
async function loadSessions(): Promise<void> {
  try {
    const stored = JSON.parse(await readFile(sessionsFile, "utf8")) as Record<string, unknown>;
    const now = Date.now();
    Object.entries(stored).forEach(([token, expires]) => {
      if (typeof expires === "number" && expires > now) sessions.set(token, expires);
    });
  } catch { /* first run */ }
}
async function saveSessions(): Promise<void> {
  const now = Date.now();
  for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
  await mkdir(dataDir, { recursive: true });
  const temporary = `${sessionsFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(Object.fromEntries(sessions))}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, sessionsFile);
}

interface AgentModelList {
  models: string[];
  defaultModel?: string;
}

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
  commandKeywords: { pause: [], monitorOpen: [], monitorStop: [], switchPi: [], switchCodex: [], switchOpencode: [] },
  groupPromptSuffix: "", aiCardTemplateId: "", aiCardContentKey: "content", aiCardStreamIntervalMs: 500, robotName: "AI Agent",
  clientId: "", clientSecret: "", agentModels: { codex: "", pi: "", opencode: "" }, agent: "pi",
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
      agentModels: { ...defaultConfig().agentModels, ...(migrated.agentModels ?? {}) },
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

const workerProcessPattern = /\/dist\/(dashboard-worker|group-worker|bot-worker)\.js(?:\s|$)/;

// omi-state.json and the UI use short role names ("bot", "dashboard") while ps
// discovery sees the script file names ("bot-worker.js"). Normalize so both
// sources describe the same role; otherwise one process renders as two cards
// with different labels.
function normalizeProcessRole(role: string): string {
  if (role === "bot-worker") return "bot";
  if (role === "dashboard-worker") return "dashboard";
  return role;
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
  for (const item of state.processes ?? []) if (item.pid && item.role) roles.set(item.pid, normalizeProcessRole(item.role));
  rows.filter((item) => workerProcessPattern.test(item.command)).forEach((item) => {
    if (!roles.has(item.pid)) roles.set(item.pid, normalizeProcessRole(item.command.match(/\/dist\/([^/]+)\.js/)?.[1] || "worker"));
  });
  const all = [...roles.entries()].map(([pid, role]) => {
    const row = rows.find((item) => item.pid === pid);
    // A pid recorded in the state file only counts as running when the live
    // process is still one of our workers; otherwise an unrelated process
    // that reused the pid would resurrect a stopped card.
    const running = Boolean(row && workerProcessPattern.test(row.command) && processIsRunning(pid));
    return { role, pid, ppid: row?.ppid, running, command: row?.command };
  });
  // One card per role: a stopped entry left behind by an earlier stop must be
  // replaced (not duplicated) once the role runs again, and repeated stops of
  // the same role must not accumulate stale cards either.
  const byRole = new Map<string, typeof all>();
  for (const item of all) {
    const list = byRole.get(item.role) ?? [];
    list.push(item);
    byRole.set(item.role, list);
  }
  const processes = [...byRole.values()].flatMap((list) => {
    const running = list.filter((item) => item.running);
    if (running.length > 0) return running;
    return [list.sort((a, b) => b.pid - a.pid)[0]];
  });
  return { mode: state.mode || "unknown", startedAt: state.startedAt, workspace: state.workspace, processes, checkedAt: new Date().toISOString() };
}

async function systemLogs(offset?: number, initialize = false): Promise<{ content: string; path: string; size: number; nextOffset: number; reset: boolean }> {
  try {
    const info = await stat(logFile);
    if (initialize) return { content: "", path: logFile, size: info.size, nextOffset: info.size, reset: false };
    // The monitor only tails new output: an unknown/absent offset re-anchors at
    // the current end instead of dumping history, and so does a rotation reset
    // (offset beyond the truncated file).
    const requestedOffset = offset === undefined ? info.size : Math.max(0, Math.floor(offset));
    if (requestedOffset > info.size) {
      return { content: "", path: logFile, size: info.size, nextOffset: info.size, reset: true };
    }
    const length = info.size - requestedOffset;
    const handle = await open(logFile, "r");
    try {
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, requestedOffset);
      // Incremental reads always start at the exact previous byte offset and
      // must stay intact; never cut a partial first line here.
      return { content: buffer.toString("utf8"), path: logFile, size: info.size, nextOffset: info.size, reset: false };
    } finally { await handle.close(); }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "ENOENT") return { content: "", path: logFile, size: 0, nextOffset: 0, reset: false };
    throw err;
  }
}

function findWorkerPids(role: string): number[] {
  const marker = `/dist/${role === "bot" ? "bot-worker" : role}.js`;
  const ps = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
  return ps.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2].includes(marker) ? [Number(match[1])] : [];
  });
}

// Keep omi-state.json in sync with manual start/stop actions. The 系统进程
// cards are driven by this file: a start must replace the role's (stopped)
// entry with the new pid, otherwise the dashboard shows an extra card next to
// the stale one.
async function replaceStateProcess(role: string, pid: number | undefined): Promise<void> {
  let state: { mode?: string; startedAt?: string; workspace?: string; processes?: Array<{ role?: string; pid?: number }> } = {};
  try { state = JSON.parse(await readFile(stateFile, "utf8")) as typeof state; } catch { /* create a fresh state below */ }
  const existing = (Array.isArray(state.processes) ? state.processes : []).filter(
    (item): item is { role: string; pid: number } => Boolean(item && typeof item.role === "string" && Number.isInteger(item.pid) && (item.pid as number) > 0),
  );
  const processes = existing.filter((item) => normalizeProcessRole(item.role) !== role);
  if (pid !== undefined) processes.push({ role, pid });
  const next = {
    mode: state.mode ?? "unknown",
    startedAt: state.startedAt ?? new Date().toISOString(),
    workspace: state.workspace ?? process.cwd(),
    processes,
  };
  await mkdir(dataDir, { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, stateFile);
}

async function controlSystemProcess(role: string, action: "start" | "stop"): Promise<void> {
  if (action === "start") {
    const path = processPaths[role];
    if (!path) throw new Error("未知进程");
    // Never spawn a second copy of a role that is already running; adopt the
    // live pid into the state file so the dashboard keeps a single card.
    const running = findWorkerPids(role);
    if (running.length > 0) {
      await replaceStateProcess(role, running[0]);
      return;
    }
    const child = spawn(process.execPath, [path], { cwd: process.cwd(), detached: true, stdio: "ignore" });
    child.unref();
    if (!child.pid) throw new Error("进程启动失败");
    await replaceStateProcess(role, child.pid);
    return;
  }
  const pids = findWorkerPids(role).filter((pid) => pid !== process.pid);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
  const deadline = Date.now() + 3_000;
  while (pids.some((pid) => processIsRunning(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of pids.filter((pid) => processIsRunning(pid))) { try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ } }
  // Keep the role's entry (with its now-dead pid) so the card stays visible
  // as 已停止 and a later 启动 replaces it in place instead of adding a card.
  if (pids.length > 0) await replaceStateProcess(role, pids[0]);
}

async function restartSystem(): Promise<void> {
  // Delay the detached manager so the HTTP 202 response can reach the browser
  // before this dashboard worker is terminated as part of the restart.
  const child = spawn(process.execPath, [omiPath, "restart"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
  child.unref();
}

function externalCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.PATH) {
    env.PATH = env.PATH.split(":").filter((entry) => !entry.endsWith("/node_modules/.bin")).join(":");
  }
  return env;
}

async function listCodexModels(): Promise<string[]> {
  // Codex CLI 没有列模型的命令，但会在 config.toml 的 model_catalog_json 里
  // 指定模型目录（含内置目录）；读出其中的 slug 作为可选模型。
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  let catalogPath = join(home, "models.json");
  try {
    const toml = await readFile(join(home, "config.toml"), "utf8");
    const match = toml.match(/^\s*model_catalog_json\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) catalogPath = match[1];
  } catch { /* fall back to the default catalog path */ }
  try {
    const parsed = JSON.parse(await readFile(catalogPath, "utf8")) as { models?: Array<{ slug?: unknown; visibility?: unknown }> };
    const slugs = (parsed.models ?? [])
      .filter((model) => model.visibility !== "hide")
      .map((model) => (typeof model.slug === "string" ? model.slug.trim() : ""))
      .filter(Boolean);
    return [...new Set(slugs)];
  } catch {
    return [];
  }
}

async function listAgentModels(agent: "codex" | "pi" | "opencode"): Promise<AgentModelList> {
  if (agent === "codex") return { models: await listCodexModels() };
  const command = agent === "pi" ? "pi" : "opencode";
  const args = agent === "opencode" ? ["models"] : ["--list-models"];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, env: agent === "opencode" ? externalCliEnv() : process.env });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || `${command} 模型列表查询失败`);
  }
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim());
  const models = agent === "pi"
    ? lines.flatMap((line) => {
      const match = line.match(/^(\S+)\s+(\S+)(?:\s|$)/);
      return match && match[1] !== "provider" ? [`${match[1]}/${match[2]}`] : [];
    })
    : lines.filter((line) => line && !/^[-= ]+$/.test(line) && !/^available models/i.test(line));
  if (agent === "pi") return { models: [...new Set(models)] };
  if (agent !== "opencode") return { models: [...new Set(models)] };

  let defaultModel: string | undefined;
  const configResult = spawnSync(command, ["debug", "config"], {
    encoding: "utf8",
    timeout: 20_000,
    env: externalCliEnv(),
  });
  if (configResult.status === 0) {
    try {
      const resolvedConfig = JSON.parse(String(configResult.stdout || "")) as { model?: unknown };
      if (typeof resolvedConfig.model === "string" && resolvedConfig.model.trim()) defaultModel = resolvedConfig.model.trim();
    } catch { /* model list remains usable if debug output changes */ }
  }
  // 不做白名单过滤，OpenCode CLI 能列出什么就展示什么。
  return { models: [...new Set(defaultModel ? [defaultModel, ...models] : models)], defaultModel };
}

async function botStatus(): Promise<{ enabled: boolean; connected: boolean; updatedAt?: string }> {
  const config = await loadConfig();
  try {
    const value = JSON.parse(await readFile(botStatusFile, "utf8")) as { pid?: number; connected?: boolean; updatedAt?: string };
    // 状态文件可能是上次进程遗留的：进程已经不在时不能报“已连接”。
    const alive = typeof value.pid === "number" && value.pid > 0 && (() => {
      try { process.kill(value.pid as number, 0); return true; } catch { return false; }
    })();
    const enabled = config.privateChatEnabled === true;
    return { enabled, connected: enabled && alive && value.connected !== false, updatedAt: value.updatedAt };
  } catch { return { enabled: config.privateChatEnabled !== false, connected: false }; }
}

async function main(): Promise<void> {
  // Version comes from the single version module. Keep the version of the code
  // that is actually running, and re-read the installed version per request so
  // an in-place upgrade is reflected instead of being cached at startup.
  const runningVersion = readVersion();
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
  const password = await loadPassword();
  await loadSessions();
  // Password-free access only for genuinely local use. A reverse proxy or
  // tunnel (nginx/frp) on this machine also connects from 127.0.0.1, so the
  // socket alone cannot separate local use from proxied external traffic.
  // Require BOTH a loopback peer AND a loopback Host header — visits through
  // a domain keep the domain Host across the proxy hop — and treat any
  // forwarding header as proof that a proxy is involved (never use those
  // headers to prove a request IS local).
  const isLoopbackRequest = (request: import("node:http").IncomingMessage): boolean => {
    const address = request.socket.remoteAddress?.trim() ?? "";
    if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
    if (request.headers["x-forwarded-for"] || request.headers["x-real-ip"] || request.headers["forwarded"]) return false;
    const rawHost = (request.headers.host ?? "").trim().toLowerCase();
    const hostName = rawHost.startsWith("[") ? rawHost.slice(1, rawHost.indexOf("]")) : rawHost.split(":")[0];
    return hostName === "127.0.0.1" || hostName === "localhost" || hostName === "::1";
  };
  const auth = {
    isAuthenticated: (request: import("node:http").IncomingMessage) => { if (isLoopbackRequest(request)) return true; const token = cookieValue(request); const expires = token ? sessions.get(token) : undefined; return Boolean(expires && expires > Date.now()); },
    login: async (candidate: string) => { const derived = await passwordHash(candidate, password.salt); const matches = derived.hash.length === password.hash.length && timingSafeEqual(Buffer.from(derived.hash, "hex"), Buffer.from(password.hash, "hex")); if (!matches) return null; const token = randomBytes(32).toString("base64url"); sessions.set(token, Date.now() + SESSION_TTL_MS); void saveSessions(); return token; },
    logout: (request: import("node:http").IncomingMessage) => { const token = cookieValue(request); if (token) { sessions.delete(token); void saveSessions(); } },
    changePassword: async (request: import("node:http").IncomingMessage, current: string, next: string) => { if (!auth.isAuthenticated(request)) return "未登录"; if (next.length < 8 || next.length > 200) return "新密码长度需为 8-200 位"; const currentHash = await passwordHash(current, password.salt); if (currentHash.hash.length !== password.hash.length || !timingSafeEqual(Buffer.from(currentHash.hash, "hex"), Buffer.from(password.hash, "hex"))) return "当前密码错误"; const record = await passwordHash(next); await savePassword(record); password.salt = record.salt; password.hash = record.hash; sessions.clear(); void saveSessions(); return null; },
  };
  startDashboard(serverConfig.port, {
    getConfig: () => config,
    updateConfig: async (next) => {
      await saveConfig(next);
      config = next;
    },
    getStatus: () => ({ ...runtime }),
    // Replies are persisted by group-worker/bot. The dashboard remains usable
    // even when those workers are absent or have not been configured yet.
    getReplies: (): ReplyRecord[] => replies,
    searchGroups, listGroupMembers, searchUsers, searchBots,
    getCurrentDwsUser: async () => ({ ...(await getCurrentDwsUser()), auth: await getDwsAuthStatus() }),
    getDwsAuthStatus, startDwsDeviceLogin, getDwsDeviceLoginOutput, logoutDws, getBotStatus: botStatus,
    getSystemStatus: systemStatus, getSystemLogs: systemLogs, restartSystem, controlSystemProcess, listAgentModels,
  }, {
    host: serverConfig.host,
    version: () => {
      const installed = readVersion();
      return installed === runningVersion ? installed : `${installed}（运行中的进程仍为 v${runningVersion}，重启后生效）`;
    },
    auth,
  });
  console.log(`[OmiDashboard] dashboard started at http://${serverConfig.host}:${serverConfig.port} (v${runningVersion})`);
}

main().catch((err) => {
  console.error(`[OmiDashboard] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  // The web process must not take down the manager because an optional status
  // provider (for example dws on a fresh machine) is unavailable.
});
