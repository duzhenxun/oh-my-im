import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  dingtalkClientId: string;
  dingtalkClientSecret: string;
  codexCliPath: string;
  codexWorkDir: string;
  codexProxy?: string;
  codexPermissionMode?: "bypass";
  allowedUserIds: string[];
  cliTimeoutMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveWorkDir(): string {
  const configured = process.env.CODEX_WORK_DIR?.trim();
  const dir = configured ? resolve(configured) : process.cwd();
  if (!existsSync(dir)) throw new Error(`CODEX_WORK_DIR does not exist: ${dir}`);
  return dir;
}

export function loadConfig(): Config {
  const permissionMode = process.env.CODEX_PERMISSION_MODE?.trim().toLowerCase();
  const timeoutRaw = process.env.OPEN_IM_CLI_TIMEOUT_MS?.trim();
  const timeout = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 30 * 60 * 1000;

  return {
    dingtalkClientId: requireEnv("DINGTALK_CLIENT_ID"),
    dingtalkClientSecret: requireEnv("DINGTALK_CLIENT_SECRET"),
    codexCliPath: process.env.CODEX_CLI_PATH?.trim() || "codex",
    codexWorkDir: resolveWorkDir(),
    codexProxy: process.env.CODEX_PROXY?.trim() || undefined,
    codexPermissionMode: permissionMode === "bypass" ? "bypass" : undefined,
    allowedUserIds: splitCsv(process.env.ALLOWED_USER_IDS),
    cliTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30 * 60 * 1000,
  };
}

