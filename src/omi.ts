#!/usr/bin/env node
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type OmiMode = "bot" | "listen";

interface ManagedProcess {
  role: "bot" | "listener";
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
const listenerPath = join(here, "dws-listener.js");
const botPath = join(here, "omi-bot.js");

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

function pidFromFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function unmanagedListenerPid(): number | undefined {
  const pid = pidFromFile(join(stateDir, "dws-listener.lock"));
  return pid && isRunning(pid) ? pid : undefined;
}

function readState(): OmiState | undefined {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8")) as OmiState;
    if ((value.mode !== "bot" && value.mode !== "listen") || !Array.isArray(value.processes)) return undefined;
    const processes = value.processes.filter((item): item is ManagedProcess =>
      Boolean(item && (item.role === "bot" || item.role === "listener") && Number.isInteger(item.pid) && item.pid > 0 && isRunning(item.pid)),
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
  if (mode === "listen") processes.push(startProcess("listener", listenerPath, workspace));
  processes.push(startProcess("bot", botPath, workspace));
  writeState({ mode, startedAt: new Date().toISOString(), workspace, processes });
  console.log(`omi started in ${mode === "listen" ? "group listening + one-to-one" : "one-to-one"} mode`);
  console.log(`log: ${logFile}`);
}

async function stop(): Promise<boolean> {
  const current = readState();
  if (!current) {
    console.log("omi is not running");
    return false;
  }
  for (const managed of current.processes) process.kill(managed.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (current.processes.some((process) => isRunning(process.pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const active = current.processes.filter((process) => isRunning(process.pid));
  if (active.length > 0) throw new Error(`omi did not stop within 5 seconds (pid ${active.map((item) => item.pid).join(", ")})`);
  unlinkSync(stateFile);
  console.log("omi stopped");
  return true;
}

function status(): void {
  const current = readState();
  if (!current) {
    const listenerPid = unmanagedListenerPid();
    if (listenerPid) {
      console.log(`omi: 未受管理的群监听正在运行（pid ${listenerPid}）`);
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
  start(noListen ? "bot" : "listen");
} else if (command === "stop") {
  await stop();
} else if (command === "status") {
  status();
} else if (command === "update") {
  const current = readState();
  const mode = current?.mode ?? "listen";
  await stop();
  start(mode, current?.workspace || launchWorkspace);
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}
