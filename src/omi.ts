#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type OmiMode = "bot" | "listen";

interface ManagedProcess {
  role: "bot" | "group-worker" | "dashboard";
  pid: number;
}

interface OmiState {
  mode: OmiMode;
  startedAt: string;
  workspace?: string;
  processes: ManagedProcess[];
}

interface DashboardServerConfig {
  port?: number;
  host?: string;
}

const args = process.argv.slice(2);
const command = args.find((argument) => !argument.startsWith("-")) ?? "start";
const noListen = args.includes("--no-listen");
const launchWorkspace = process.cwd();
const stateDir = join(homedir(), ".oh-my-im");
const stateFile = join(stateDir, "omi-state.json");
const logFile = join(stateDir, "omi.log");
const here = dirname(fileURLToPath(import.meta.url));
const groupWorkerPath = join(here, "group-worker.js");
const botPath = join(here, "bot-worker.js");
const dashboardPath = join(here, "dashboard-worker.js");
const packageFile = join(here, "..", "package.json");
const packageName = "oh-my-im";
const repositoryUrl = "https://github.com/duzhenxun/oh-my-im";

function localVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: string };
    return packageJson.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

async function checkForUpdate(): Promise<boolean> {
  const current = localVersion();
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return true;
    const latest = (await response.json() as { version?: string }).version?.trim();
    if (!latest || compareVersions(latest, current) <= 0) return true;
    console.log(`发现 ${packageName} 新版本：v${latest}（当前 v${current}）`);
    console.log(`GitHub：${repositoryUrl}`);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(`如需升级，请执行：npm install -g ${packageName}@latest`);
      return true;
    }
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await readline.question("是否立即升级？[y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return true;
    } finally {
      readline.close();
    }
    console.log(`正在升级 ${packageName}...`);
    const result = spawnSync("npm", ["install", "-g", `${packageName}@latest`], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error("升级失败，请稍后手动执行：", `npm install -g ${packageName}@latest`);
      return true;
    }
    console.log(`升级完成，请重新执行：${process.argv.slice(2).join(" ") || "omi"}`);
    return false;
  } catch {
    // Version checking must never prevent the already installed version from starting.
    return true;
  }
}

function printHelp(): void {
  console.log([
    "omi - DingTalk agent manager",
    "",
    "Commands:",
    "  omi            Start group listening and the one-to-one bot (default)",
    "  omi start      Start group listening and the one-to-one bot",
    "  omi listen     Alias for omi start",
    "  omi --no-listen  Start only the one-to-one bot; do not listen to groups",
    "  omi stop       Stop the current omi mode",
    "  omi restart    Stop and start the current omi mode",
    "  omi status     Show mode, process state, dashboard address, and log path",
    "  omi update     Restart the current mode with the current built version",
    "  omi -h         Show this help",
  ].join("\n"));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessInfo { pid: number; ppid: number; command: string; }

function omiProcesses(): ProcessInfo[] {
  try {
    const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout.split("\\n").flatMap((line) => {
      const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }];
    });
  } catch {
    return [];
  }
}

function allOmiProcessIds(): number[] {
  const processes = omiProcesses();
  const ids = new Set<number>();
  // Match only this application's built workers. Do not use a broad
  // "oh-my-im" substring that could terminate an unrelated shell/editor.
  processes.filter((item) => item.command.includes("/dist/omi.js") || item.command.includes("/dist/dashboard-worker.js") || item.command.includes("/dist/group-worker.js") || item.command.includes("/dist/bot-worker.js"))
    .forEach((item) => ids.add(item.pid));
  // Include Agent/DWS descendants spawned by our workers, such as codex/pi and
  // dws child processes, so stop really leaves no worker behind.
  let changed = true;
  while (changed) {
    changed = false;
    processes.forEach((item) => {
      if (ids.has(item.ppid) && !ids.has(item.pid)) { ids.add(item.pid); changed = true; }
    });
  }
  ids.delete(process.pid);
  return [...ids];
}

function pidFromFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function unmanagedListenerPid(): number | undefined {
  const pid = pidFromFile(join(stateDir, "group-worker.lock"));
  return pid && isRunning(pid) ? pid : undefined;
}

function readState(): OmiState | undefined {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8")) as OmiState;
    if ((value.mode !== "bot" && value.mode !== "listen") || !Array.isArray(value.processes)) return undefined;
    const processes = value.processes.filter((item): item is ManagedProcess =>
      Boolean(item && (item.role === "bot" || item.role === "group-worker" || item.role === "dashboard") && Number.isInteger(item.pid) && item.pid > 0 && isRunning(item.pid)),
    );
    if (processes.length === 0) {
      unlinkSync(stateFile);
      return undefined;
    }
    return { ...value, processes };
  } catch {
    return undefined;
  }
}

function writeState(state: OmiState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function dashboardAddress(state: OmiState): string | undefined {
  try {
    const serverConfigFile = join(stateDir, "dws-dashboard-server.json");
    const config = JSON.parse(readFileSync(serverConfigFile, "utf8")) as DashboardServerConfig;
    if (!config.port || !config.host) return undefined;
    const host = config.host === "0.0.0.0" || config.host === "::" ? "<server-address>" : config.host;
    return `http://${host}:${config.port}`;
  } catch {
    return undefined;
  }
}

function startProcess(role: ManagedProcess["role"], path: string, workspace: string): ManagedProcess {
  if (!existsSync(path)) throw new Error("omi is not built. Run npm run build first.");
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [path], {
    cwd: workspace,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error(`Unable to start omi ${role}`);
  return { role, pid: child.pid };
}

function start(mode: OmiMode, workspace = launchWorkspace): void {
  const current = readState();
  if (current) {
    console.log(`omi is already running in ${current.mode} mode`);
    return;
  }
  const existingListener = unmanagedListenerPid();
  if (mode === "listen" && existingListener) {
    throw new Error(`已有未受 omi 管理的群监听进程正在运行（pid ${existingListener}）。请先停止它后再执行 omi listen。`);
  }
  mkdirSync(stateDir, { recursive: true });
  const processes: ManagedProcess[] = [];
  // Keep the management UI independent: missing DWS login or bot credentials
  // must never prevent users from opening the configuration page.
  processes.push(startProcess("dashboard", dashboardPath, workspace));
  if (mode === "listen") {
    processes.push(startProcess("group-worker", groupWorkerPath, workspace));
  }
  processes.push(startProcess("bot", botPath, workspace));
  writeState({ mode, startedAt: new Date().toISOString(), workspace, processes });
  console.log(`omi started in ${mode === "listen" ? "group listening + one-to-one" : "one-to-one"} mode`);
  console.log(`log: ${logFile}`);
}

async function stop(): Promise<boolean> {
  const current = readState();
  const statePids = current?.processes.map((managed) => managed.pid) ?? [];
  const pids = [...new Set([...statePids, ...allOmiProcessIds()])].filter((pid) => pid !== process.pid && isRunning(pid));
  if (pids.length === 0) {
    if (existsSync(stateFile)) unlinkSync(stateFile);
    console.log("omi is not running");
    return false;
  }
  // Stop every omi worker and its descendants, including stale workers left by
  // an older state file. Escalate after five seconds so restart cannot overlap
  // with the previous listener/bot instance.
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
  const deadline = Date.now() + 5_000;
  while (pids.some((pid) => isRunning(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const active = pids.filter((pid) => isRunning(pid));
  for (const pid of active) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const remaining = pids.filter((pid) => isRunning(pid));
  if (remaining.length > 0) throw new Error(`omi did not stop (pid ${remaining.join(", ")})`);
  if (existsSync(stateFile)) unlinkSync(stateFile);
  console.log(`omi stopped (${pids.length} process(es))`);
  return true;
}

function status(): void {
  const current = readState();
  if (!current) {
    const listenerPid = unmanagedListenerPid();
    if (listenerPid) {
      console.log(`omi: 未受管理的 group-worker 正在运行（pid ${listenerPid}）`);
      return;
    }
    console.log("omi: stopped");
    return;
  }
  console.log(`omi: running (${current.mode === "listen" ? "group listening + one-to-one" : "one-to-one"})`);
  console.log(`workspace: ${current.workspace || homedir()}`);
  for (const managed of current.processes) console.log(`${managed.role}: running (pid ${managed.pid})`);
  const address = dashboardAddress(current);
  if (address) console.log(`dashboard: ${address}`);
  console.log(`log: ${logFile}`);
}

if (args.includes("-h") || args.includes("--help") || command === "help") {
  printHelp();
} else if (command === "start" || command === "listen") {
  if (await checkForUpdate()) start(noListen ? "bot" : "listen");
} else if (command === "stop") {
  await stop();
} else if (command === "status") {
  status();
} else if (command === "restart") {
  if (await checkForUpdate()) {
    const current = readState();
    const mode = current?.mode ?? "listen";
    await stop();
    start(mode, current?.workspace || launchWorkspace);
  }
} else if (command === "update") {
  if (await checkForUpdate()) {
    const current = readState();
    const mode = current?.mode ?? "listen";
    await stop();
    start(mode, current?.workspace || launchWorkspace);
  }
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}
